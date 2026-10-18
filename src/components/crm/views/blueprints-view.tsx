import { assertCan, auditSupportView, crmRead, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { getWorkspace } from "@/server/crm/workspace";
import { getBlueprintChecklist } from "@/server/crm/blueprints/checklist";
import type { ApplicationStatus } from "@/lib/crm/blueprints/types";
import { BlueprintSetupScreen, type BlueprintSetupData } from "@/components/crm/blueprints/setup-screen";

/** How many applications the page lists (newest first). A workspace rarely has more than a handful. */
const APPLICATIONS_SHOWN = 50;

/**
 * Everything the "Blueprints & setup" page shows, read for one workspace: the Blueprints applied to it (the client reads its own
 * applications under row-level security; the agency library itself is never read here), its setup checklist, and its draft calendars.
 */
export async function loadBlueprintSetup(actor: CrmActor): Promise<BlueprintSetupData> {
  assertCan(actor, "crm.view");
  const [workspace, checklist, rows] = await Promise.all([
    getWorkspace(actor),
    getBlueprintChecklist(actor),
    crmRead(actor, async (db) => {
      const apps = await db.query<{ id: string; blueprint_name: string; version: number; status: ApplicationStatus; requested_via: "agency" | "onboarding"; created_at: Date; rolled_back_at: Date | null }>(
        `select id, blueprint_name, version, status, requested_via, created_at, rolled_back_at from crm_blueprint_applications
         where org_id = $1 order by created_at desc limit ${APPLICATIONS_SHOWN}`,
        [actor.orgId],
      );
      const drafts = await db.query<{ id: string; name: string; hosts: number }>(
        `select c.id, c.name, (select count(*)::int from crm_calendar_members m where m.calendar_id = c.id and m.org_id = c.org_id and m.active) as hosts
         from crm_calendars c where c.org_id = $1 and c.status = 'draft' and c.archived_at is null order by lower(c.name)`,
        [actor.orgId],
      );
      return { apps: apps.rows, drafts: drafts.rows };
    }),
  ]);
  return {
    mode: workspace.mode,
    checklist,
    applications: rows.apps.map((a) => ({
      id: a.id,
      name: a.blueprint_name,
      version: a.version,
      status: a.status,
      via: a.requested_via,
      appliedAt: new Date(a.created_at).toISOString(),
      rolledBackAt: a.rolled_back_at ? new Date(a.rolled_back_at).toISOString() : null,
    })),
    draftCalendars: rows.drafts.map((d) => ({ id: d.id, name: d.name, hosts: Number(d.hosts) })),
  };
}

/** CRM Settings → Blueprints & setup (/crm/settings/blueprints, and the agency's view of a client). Anyone who can open the CRM sees it. */
export async function BlueprintsView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const data = await loadBlueprintSetup(actor);
  await auditSupportView(actor, "crm_blueprints");
  return <BlueprintSetupScreen scope={scope} data={data} />;
}
