import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import type { SessionUser } from "@/server/auth/service";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { HermesGatewayView } from "@/server/integrations/hermes/gateways";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";

export const HERMES_SETUP_STEPS = [
  "Gateway",
  "Secure Authentication",
  "Gateway Test",
  "Agency Workforce",
  "Client Provisioning",
  "Final Health",
] as const;

export const hermesSetupDraftConfigSchema = z.object({
  label: z.string().max(120),
  environment: z.enum(["development", "staging", "production"]),
  baseUrl: z.string().max(500),
  gatewayType: z.enum(["multiplexed_profiles", "single_profile"]),
  reportedGatewayId: z.string().max(120),
  declaredVersion: z.string().max(80),
}).strict();

const saveDraftSchema = z.object({
  gatewayId: z.string().uuid().nullable(),
  expectedDraftRevision: z.number().int().min(0),
  expectedGatewayRevision: z.number().int().positive().nullable(),
  config: hermesSetupDraftConfigSchema,
}).strict();

const saveProgressSchema = z.object({
  gatewayId: z.string().uuid().nullable(),
  stepIndex: z.number().int().min(0).max(HERMES_SETUP_STEPS.length - 1),
}).strict();

export type HermesSetupDraftConfig = z.infer<typeof hermesSetupDraftConfigSchema>;
export type HermesSetupStepStatus = "not_started" | "in_progress" | "saved" | "configured" | "credentials_saved" | "verification_pending" | "verified" | "needs_attention" | "failed" | "blocked";

export interface HermesSetupStepView {
  index: number;
  label: (typeof HERMES_SETUP_STEPS)[number];
  status: HermesSetupStepStatus;
  complete: boolean;
  detail: string;
}

export interface HermesSetupSummary {
  gatewayId: string | null;
  gatewayRevision: number | null;
  draft: null | {
    config: HermesSetupDraftConfig;
    revision: number;
    baseGatewayRevision: number | null;
    updatedAt: string;
    modifiedBy: string | null;
    stale: boolean;
  };
  navigationStep: number;
  resumeIndex: number;
  completedCount: number;
  steps: HermesSetupStepView[];
  lastSavedAt: string | null;
  lastVerifiedAt: string | null;
  lastChangedBy: string | null;
  credentialsRotatedAt: string | null;
}

type DraftRow = {
  gateway_id: string | null;
  revision: number;
  base_gateway_revision: number | null;
  draft_config: HermesSetupDraftConfig;
  updated_at: Date | string;
  modified_by_name: string | null;
};
type ProgressRow = { gateway_id: string | null; step_index: number };
type AgencyProfileCheckRow = {
  role_key: AgentRoleKey;
  profile_id: string | null;
  gateway_id: string | null;
  status: string;
  identity_verified: boolean;
  api_contract_verified: boolean;
  tool_permissions_status: string;
  detail: string;
  checked_at: Date | string;
  verified_at: Date | string | null;
};

const asDate = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
const isFresh = (value: string | null) => Boolean(value && Date.now() - new Date(value).getTime() <= 24 * 60 * 60 * 1000);
const gatewayHasLocalAuthExemption = (gateway: HermesGatewayView | null) => Boolean(gateway?.baseUrl.startsWith("http://localhost") || gateway?.baseUrl.startsWith("http://127.0.0.1") || gateway?.baseUrl.startsWith("http://[::1]"));

async function requireSuperAdmin(db: Queryable, user: SessionUser) {
  const { rows } = await db.query<{ platform_role: string; status: string }>("select platform_role,status from users where id=$1", [user.id]);
  if (rows[0]?.status !== "active" || rows[0]?.platform_role !== "agency_super_admin") {
    throw new AppError("forbidden", "Only an active agency super admin can change Hermes setup.");
  }
}

async function agencyId(db: Queryable, lock = false) {
  const { rows } = await db.query<{ id: string }>(`select id from organizations where kind='agency' order by created_at limit 1${lock ? " for update" : ""}`);
  if (!rows[0]) throw new AppError("not_found", "The agency workspace is not available.");
  return rows[0].id;
}

/** Store only allowlisted, non-secret fields. Vault values never enter this schema or history. */
export async function saveHermesSetupDraft(user: SessionUser, raw: unknown) {
  const input = saveDraftSchema.parse(raw);
  return withSystem(async (db) => {
    await requireSuperAdmin(db, user);
    // A shared organization-row lock also serializes first-time draft creation, where no draft
    // row exists yet to lock, and races with the canonical gateway save that consumes the draft.
    const orgId = await agencyId(db, true);

    if (input.gatewayId) {
      const gateway = (await db.query<{ revision: number }>("select revision from hermes_gateways where id=$1 for update", [input.gatewayId])).rows[0];
      if (!gateway) throw new AppError("not_found", "Hermes gateway not found.");
      if (input.expectedGatewayRevision !== gateway.revision) {
        throw new AppError("conflict", "Gateway settings changed in another session. Reload the saved configuration before continuing.");
      }
    } else if (input.expectedGatewayRevision !== null) {
      throw new AppError("invalid_input", "A new gateway draft cannot have an existing gateway revision.");
    }

    const existing = (await db.query<{ revision: number }>(
      "select revision from hermes_gateway_setup_drafts where organization_id=$1 and gateway_id is not distinct from $2::uuid for update",
      [orgId, input.gatewayId],
    )).rows[0];
    const actualRevision = existing?.revision ?? 0;
    if (actualRevision !== input.expectedDraftRevision) {
      throw new AppError("conflict", "This setup draft changed in another session. Reload it before saving more changes.");
    }
    const nextRevision = actualRevision + 1;
    if (existing) {
      await db.query(
        `update hermes_gateway_setup_drafts set revision=$3,base_gateway_revision=$4,draft_config=$5,
           modified_by=$6,updated_at=now() where organization_id=$1 and gateway_id is not distinct from $2::uuid`,
        [orgId, input.gatewayId, nextRevision, input.expectedGatewayRevision, JSON.stringify(input.config), user.id],
      );
    } else {
      await db.query(
        `insert into hermes_gateway_setup_drafts(organization_id,gateway_id,revision,base_gateway_revision,draft_config,modified_by)
         values($1,$2,$3,$4,$5,$6)`,
        [orgId, input.gatewayId, nextRevision, input.expectedGatewayRevision, JSON.stringify(input.config), user.id],
      );
    }
    await db.query(
      `insert into hermes_gateway_setup_draft_history(organization_id,gateway_id,revision,draft_config,changed_by)
       values($1,$2,$3,$4,$5)`,
      [orgId, input.gatewayId, nextRevision, JSON.stringify(input.config), user.id],
    );
    await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: "hermes.setup_draft_saved", targetType: "hermes_gateway", targetId: input.gatewayId ?? undefined, result: "success", metadata: { revision: nextRevision } }, db);
    const saved = (await db.query<{ updated_at: Date | string }>(
      "select updated_at from hermes_gateway_setup_drafts where organization_id=$1 and gateway_id is not distinct from $2::uuid",
      [orgId, input.gatewayId],
    )).rows[0];
    return { revision: nextRevision, updatedAt: asDate(saved?.updated_at) };
  });
}

/** Wizard navigation is private to the signed-in administrator and gateway. */
export async function saveHermesSetupProgress(user: SessionUser, raw: unknown) {
  const input = saveProgressSchema.parse(raw);
  return withSystem(async (db) => {
    await requireSuperAdmin(db, user);
    const orgId = await agencyId(db);
    if (input.gatewayId) {
      const found = await db.query("select 1 from hermes_gateways where id=$1", [input.gatewayId]);
      if (!found.rowCount) throw new AppError("not_found", "Hermes gateway not found.");
    }
    if (input.gatewayId) {
      await db.query(
        `insert into hermes_gateway_setup_progress(organization_id,user_id,gateway_id,step_index)
         values($1,$2,$3,$4)
         on conflict (organization_id,user_id,gateway_id) where gateway_id is not null
         do update set step_index=excluded.step_index,updated_at=now()`,
        [orgId, user.id, input.gatewayId, input.stepIndex],
      );
    } else {
      await db.query(
        `insert into hermes_gateway_setup_progress(organization_id,user_id,gateway_id,step_index)
         values($1,$2,null,$3)
         on conflict (organization_id,user_id) where gateway_id is null
         do update set step_index=excluded.step_index,updated_at=now()`,
        [orgId, user.id, input.stepIndex],
      );
    }
    return { stepIndex: input.stepIndex };
  });
}

function summary(gateway: HermesGatewayView | null, draftRow: DraftRow | undefined, navigationStep: number, checkRows: AgencyProfileCheckRow[] = []): HermesSetupSummary {
  const draft = draftRow ? {
    config: draftRow.draft_config,
    revision: Number(draftRow.revision),
    baseGatewayRevision: draftRow.base_gateway_revision === null ? null : Number(draftRow.base_gateway_revision),
    updatedAt: asDate(draftRow.updated_at)!,
    modifiedBy: draftRow.modified_by_name,
    stale: gateway ? draftRow.base_gateway_revision !== gateway.revision : draftRow.base_gateway_revision !== null,
  } : null;
  const hasGateway = Boolean(gateway);
  const localAuthExempt = gatewayHasLocalAuthExemption(gateway);
  const accessSaved = Boolean(gateway?.hasAccessCredential || localAuthExempt);
  const caps = gateway?.capabilities ?? {};
  const profiles = AGENT_ROLE_KEYS.map((roleKey) => {
    const row = checkRows.find((check) => check.role_key === roleKey);
    const expected = AGENCY_HERMES_PROFILE_IDS[roleKey];
    const mappedHere = row?.profile_id === expected && row.gateway_id === gateway?.id;
    const fresh = Boolean(row?.status === "verified" && row.identity_verified && row.api_contract_verified && isFresh(asDate(row.verified_at)));
    return {
      roleKey,
      label: AGENT_BY_KEY[roleKey].shortName,
      profile: row?.profile_id ?? expected,
      status: fresh && mappedHere ? "verified" : row?.profile_id && row.profile_id !== expected ? "identity_mismatch" : mappedHere ? row?.status ?? "not_configured" : "setup_required",
      detail: row?.detail ?? "Map this existing iAcquire identity and run its read-only profile check.",
      toolPermissionsStatus: row?.tool_permissions_status ?? "not_checked",
      checkedAt: asDate(row?.checked_at ?? null),
    };
  });
  const verifiedProfiles = profiles.filter((profile) => profile.status === "verified").length;
  const profileSetVerified = profiles.length === AGENT_ROLE_KEYS.length && verifiedProfiles === AGENT_ROLE_KEYS.length;
  const gatewayAccessVerified = caps.gatewayHealthVerified === true;
  const healthFresh = isFresh(gateway?.lastHealthCheckAt ?? null);
  const gatewayLiveVerified = Boolean(gateway && gateway.status === "connected" && healthFresh && gatewayAccessVerified);
  const provisioningVerified = gateway?.profileCreationStatus === "restricted_service_verified";
  const mapped = gateway?.mappedProfileCount ?? 0;
  const draftCurrent = Boolean(draft && !draft.stale);
  const currentDraft = draftCurrent ? draft : null;
  const steps: HermesSetupStepView[] = [
    {
      index: 0, label: HERMES_SETUP_STEPS[0],
      status: hasGateway ? "configured" : currentDraft && currentDraft.config.baseUrl.trim() ? "in_progress" : "not_started",
      complete: hasGateway,
      detail: hasGateway ? `${gateway!.label} · ${gateway!.host || "gateway URL saved"}` : currentDraft && currentDraft.config.baseUrl.trim() ? "Non-secret gateway settings are saved as a resumable draft." : "Save the gateway label, environment and approved HTTPS URL.",
    },
    {
      index: 1, label: HERMES_SETUP_STEPS[1],
      status: gateway?.hasAccessCredential ? "credentials_saved" : localAuthExempt ? "configured" : hasGateway ? "needs_attention" : "blocked",
      complete: accessSaved,
      detail: gateway?.hasAccessCredential ? "Cloudflare Access credentials are saved in secure storage." : localAuthExempt ? "Loopback development does not use Cloudflare Access." : hasGateway ? "Cloudflare Access credentials are missing or revoked." : "Save the gateway before adding Cloudflare Access credentials.",
    },
    {
      index: 2, label: HERMES_SETUP_STEPS[2],
      status: gatewayLiveVerified ? "verified" : gateway?.lastHealthCheckAt ? "needs_attention" : accessSaved ? "verification_pending" : "blocked",
      complete: gatewayLiveVerified,
      detail: gatewayLiveVerified ? "The Cloudflare-authenticated Hermes gateway health check passed within the last 24 hours. Profile checks are tracked separately." : gateway?.lastHealthCheckAt && gateway.lastError ? gateway.lastError : gateway?.lastHealthCheckAt ? "The gateway health check is older than 24 hours; test the gateway again." : "Run the live gateway health check after the endpoint and credentials are saved.",
    },
    {
      index: 3, label: HERMES_SETUP_STEPS[3],
      status: profileSetVerified ? "verified" : mapped >= 6 ? "needs_attention" : mapped > 0 ? "in_progress" : hasGateway ? "not_started" : "blocked",
      complete: profileSetVerified,
      detail: profileSetVerified ? "All six existing agency profile identities passed read-only authentication and identity checks." : `${mapped} of 6 existing employee profiles are mapped to this gateway; ${verifiedProfiles} passed the profile-specific check. Gateway health is reported separately. No profiles were created by setup.`,
    },
    {
      index: 4, label: HERMES_SETUP_STEPS[4],
      status: provisioningVerified ? "verified" : "blocked",
      complete: provisioningVerified,
      detail: provisioningVerified ? "The restricted client profile provisioning service passed its capability and isolation checks." : "Blocked: no restricted provisioning service is verified. Client profile creation remains operator controlled.",
    },
    {
      index: 5, label: HERMES_SETUP_STEPS[5],
      status: gateway?.status === "connected" && healthFresh && gatewayAccessVerified && profileSetVerified ? "verified" : !gateway ? "not_started" : gateway.lastHealthCheckAt ? "needs_attention" : "verification_pending",
      complete: Boolean(gateway?.status === "connected" && healthFresh && gatewayAccessVerified && profileSetVerified),
      detail: gateway?.status === "connected" && healthFresh && gatewayAccessVerified && profileSetVerified ? "A fresh gateway health check and all six profile-specific identity checks passed." : !gateway ? "Not started: save gateway settings and run a live test first." : "Final health needs a fresh gateway test and six independently verified agency profiles.",
    },
  ];
  const firstIncomplete = steps.find((step) => !step.complete)?.index ?? steps.length - 1;
  const lastSavedAt = [gateway?.updatedAt ?? null, draft?.updatedAt ?? null].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  return {
    gatewayId: gateway?.id ?? null,
    gatewayRevision: gateway?.revision ?? null,
    draft,
    navigationStep: Math.max(0, Math.min(steps.length - 1, navigationStep)),
    resumeIndex: firstIncomplete,
    completedCount: steps.filter((step) => step.complete).length,
    steps,
    lastSavedAt,
    lastVerifiedAt: gateway?.lastSuccessAt ?? null,
    lastChangedBy: gateway?.lastChangedBy ?? draft?.modifiedBy ?? null,
    credentialsRotatedAt: gateway?.credentialRotatedAt ?? null,
  };
}

/** Called only after manager authorization. Returns one summary per gateway plus a new-gateway draft. */
export async function listHermesSetupSummaries(db: Queryable, userId: string, gateways: HermesGatewayView[]) {
  const agency = (await db.query<{ id: string }>("select id from organizations where kind='agency' order by created_at limit 1")).rows[0];
  const summaries: Record<string, HermesSetupSummary> = { new: summary(null, undefined, 0) };
  if (!agency) return summaries;
  const [draftRows, progressRows, profileRows] = await Promise.all([
    db.query<DraftRow>(
      `select d.gateway_id,d.revision,d.base_gateway_revision,d.draft_config,d.updated_at,u.full_name as modified_by_name
       from hermes_gateway_setup_drafts d left join users u on u.id=d.modified_by where d.organization_id=$1`,
      [agency.id],
    ),
    db.query<ProgressRow>("select gateway_id,step_index from hermes_gateway_setup_progress where organization_id=$1 and user_id=$2", [agency.id, userId]),
    db.query<AgencyProfileCheckRow>(
      `select a.role_key,a.hermes_profile as profile_id,a.hermes_gateway_id as gateway_id,
              coalesce(pc.status,'not_configured') as status,coalesce(pc.identity_verified,false) as identity_verified,
              coalesce(pc.api_contract_verified,false) as api_contract_verified,
              coalesce(pc.tool_permissions_status,'not_checked') as tool_permissions_status,
              coalesce(pc.detail,'Map this existing iAcquire identity and run its read-only profile check.') as detail,
              coalesce(pc.checked_at,a.updated_at) as checked_at,pc.verified_at
       from agent_instances a left join agency_hermes_profile_checks pc on pc.agent_instance_id=a.id and pc.org_id=a.org_id
       where a.org_id=$1`,
      [agency.id],
    ),
  ]);
  const draftMap = new Map(draftRows.rows.map((row) => [row.gateway_id ?? "new", row]));
  const progressMap = new Map(progressRows.rows.map((row) => [row.gateway_id ?? "new", Number(row.step_index)]));
  summaries.new = summary(null, draftMap.get("new"), progressMap.get("new") ?? 0, profileRows.rows);
  for (const gateway of gateways) summaries[gateway.id] = summary(gateway, draftMap.get(gateway.id), progressMap.get(gateway.id) ?? 0, profileRows.rows);
  return summaries;
}
