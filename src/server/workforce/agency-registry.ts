import "server-only";
import { randomUUID } from "node:crypto";
import type { SessionUser } from "@/server/auth/service";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS } from "@/lib/agents";
import { runtimeReadySql } from "@/lib/employee-runtime";

/**
 * Repairs the agency-owned employee registry when an older iAcquire organization exists without
 * its workforce rows. This is deliberately additive and safe to run on every Super Admin visit:
 * existing rows, profile mappings, credentials and settings are never overwritten.
 */
export async function ensureAgencyWorkforceRegistry(admin: SessionUser): Promise<string> {
  if (admin.platformRole !== "agency_super_admin") {
    throw new AppError("forbidden", "Only a Super Admin can initialize the internal workforce registry.");
  }

  return withSystem(async (db) => {
    let { rows: agencies } = await db.query<{ id: string }>(
      "select id from organizations where kind = 'agency' order by created_at limit 1",
    );
    let organizationCreated = false;

    if (!agencies[0]) {
      const slugTaken = await db.query("select 1 from organizations where slug='iacquire'");
      const slug = slugTaken.rows.length ? `iacquire-${randomUUID().slice(0, 8)}` : "iacquire";
      const created = await db.query<{ id: string }>(
        `insert into organizations (name, slug, kind, status, timezone, onboarding_completed_at)
         values ('iAcquire', $1, 'agency', 'active', 'UTC', now())
         on conflict do nothing returning id`,
        [slug],
      );
      agencies = created.rows.length ? created.rows : (await db.query<{ id: string }>(
        "select id from organizations where kind = 'agency' order by created_at limit 1",
      )).rows;
      organizationCreated = created.rows.length > 0;
    }

    const agency = agencies[0];
    if (!agency) {
      throw new AppError("integration_unavailable", "The iAcquire agency workspace could not be prepared.");
    }

    await db.query("insert into company_profiles (org_id) values ($1) on conflict (org_id) do nothing", [agency.id]);
    let identitiesCreated = 0;
    for (const roleKey of AGENT_ROLE_KEYS) {
      const inserted = await db.query(
        `insert into agent_instances (org_id, role_key, display_name)
         values ($1, $2, $3) on conflict (org_id, role_key) do nothing`,
        [agency.id, roleKey, AGENT_BY_KEY[roleKey].shortName],
      );
      identitiesCreated += inserted.rowCount ?? 0;
    }

    if (organizationCreated || identitiesCreated > 0) {
      await recordAudit({
        orgId: agency.id,
        actorUserId: admin.id,
        actorKind: "agency",
        action: "agency.workforce_registry_initialized",
        targetType: "organization",
        targetId: agency.id,
        result: "success",
        metadata: { organizationCreated, identitiesCreated },
      }, db);
    }

    return agency.id;
  });
}

/** Read-only summary used by the dedicated client-workforce list. RLS filters rows to
 * Super Admin access or the agency staff member's explicit client assignments. */
export async function listClientWorkforceSummaries(user: SessionUser) {
  return withUser(user.id, async (db) => {
    if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
    const permission = await db.query<{ allowed: boolean }>(
      "select coalesce(app.user_has_agency_permission($1,'agency.workforce.view'),false) as allowed",
      [user.id],
    );
    if (!permission.rows[0]?.allowed) throw new AppError("forbidden", "Your agency role does not allow client workforce monitoring.");
    const { rows } = await db.query<{
      id: string;
      name: string;
      industry: string | null;
      status: string;
      growth_partner_identities: number;
      growth_partner_mapped: number;
      growth_partner_credentialed: number;
      growth_partner_verified: number;
      growth_partner_issues: number;
      growth_partner_last_success_at: Date | null;
      retained_profiles: number;
      retained_mapped: number;
      retained_credentialed: number;
      retained_verified: number;
      retained_issues: number;
      provisioning_open: number;
      provisioning_failed: number;
      hermes_status: string | null;
      hermes_detail: string | null;
    }>(
      `select o.id, o.name, o.industry, o.status,
              count(a.id) filter (where a.role_key = 'growth_partner')::int as growth_partner_identities,
              count(a.id) filter (where a.role_key = 'growth_partner' and a.hermes_profile is not null)::int as growth_partner_mapped,
              count(a.id) filter (where a.role_key = 'growth_partner' and a.credential_id is not null)::int as growth_partner_credentialed,
              count(a.id) filter (where a.role_key = 'growth_partner' and ${runtimeReadySql("a")})::int as growth_partner_verified,
              count(a.id) filter (where a.role_key = 'growth_partner' and a.status in ('offline','error'))::int as growth_partner_issues,
              max(a.last_health_check_at) filter (where a.role_key = 'growth_partner' and a.last_health_ok is true) as growth_partner_last_success_at,
              count(a.id) filter (where a.role_key <> 'growth_partner')::int as retained_profiles,
              count(a.id) filter (where a.role_key <> 'growth_partner' and a.hermes_profile is not null)::int as retained_mapped,
              count(a.id) filter (where a.role_key <> 'growth_partner' and a.credential_id is not null)::int as retained_credentialed,
              count(a.id) filter (where a.role_key <> 'growth_partner' and ${runtimeReadySql("a")})::int as retained_verified,
              count(a.id) filter (where a.role_key <> 'growth_partner' and a.status in ('offline','error'))::int as retained_issues,
              (select count(*)::int from agent_provisioning_jobs j where j.org_id=o.id and j.status in ('requested','in_progress','awaiting_health_check')) as provisioning_open,
              (select count(*)::int from agent_provisioning_jobs j where j.org_id=o.id and j.status='failed') as provisioning_failed,
              (select s.status from integration_status s where s.org_id=o.id and s.provider='hermes') as hermes_status,
              (select s.detail from integration_status s where s.org_id=o.id and s.provider='hermes') as hermes_detail
       from organizations o
       left join agent_instances a on a.org_id = o.id
       where o.kind = 'client'
       group by o.id, o.name, o.industry, o.status
       order by o.name`,
    );
    return rows;
  });
}
