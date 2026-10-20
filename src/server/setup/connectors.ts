import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { verifyGhlConnection } from "@/server/integrations/ghl";
import { runHealthCheck } from "@/server/workforce/service";
import {
  actualDataModel,
  blueprintEvidence,
  calendarEvidence,
  channelEvidence,
  crmOwners,
  loadBlueprintState,
  manifestEvidence,
  workflowEvidence,
  type SetupChannel,
} from "@/server/setup/native-evidence";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { CHECK_KEYS, CHECK_LABEL, type CheckKey, type CheckStatus } from "@/lib/setup";

/**
 * Typed seam for the future automated provisioning engine.
 *
 * Each connector answers one question: "can we prove this integration is working right now?".
 * A connector that is not implemented says so (`implemented: false`) and is never treated as
 * passing: those checks stay "unverified" until an agency member records an evidenced attestation,
 * which is always shown as an attestation and never as a machine-verified connection.
 */
export type ConnectorStatus = "verified" | "failed" | "unverified";

export interface ConnectorResult {
  status: ConnectorStatus;
  /** Technical detail for agency staff only. */
  detail: string;
}

export interface ConnectorContext {
  orgId: string;
  actorUserId: string | null;
  /** live = contact the external system now; otherwise rely on the most recent recorded check. */
  live: boolean;
  /** Checks that apply to this client, and the status each currently holds (updated as a run proceeds). */
  applicable: CheckKey[];
  /** The applicable checks behind required steps. The final system check aggregates these (optional steps never hold it back). */
  required?: CheckKey[];
  stored: Partial<Record<CheckKey, CheckStatus>>;
  /** The labels of the checks that apply to this workspace (its registry's, so a GoHighLevel check reads as one). */
  labels?: Partial<Record<CheckKey, string>>;
}

export interface SetupConnector {
  key: CheckKey;
  label: string;
  implemented: boolean;
  /** Why the portal cannot verify this yet (agency-facing). */
  unavailableReason?: string;
  evaluate(ctx: ConnectorContext): Promise<ConnectorResult>;
}

const FRESH_MS = 24 * 60 * 60 * 1000;
const isFresh = (d: Date | string | null) => Boolean(d) && Date.now() - new Date(d as string | Date).getTime() < FRESH_MS;

const unimplemented = (key: CheckKey, reason: string): SetupConnector => ({
  key,
  label: CHECK_LABEL[key],
  implemented: false,
  unavailableReason: reason,
  evaluate: async () => ({ status: "unverified", detail: reason }),
});

const onboarding: SetupConnector = {
  key: "onboarding",
  label: CHECK_LABEL.onboarding,
  implemented: true,
  async evaluate({ orgId }) {
    const { rows } = await withSystem((db) =>
      db.query<{ done: Date | null; resp: Date | null }>(
        "select o.onboarding_completed_at as done, r.completed_at as resp from organizations o left join onboarding_responses r on r.org_id = o.id where o.id = $1",
        [orgId],
      ),
    );
    const r = rows[0];
    if (r?.done && r.resp) return { status: "verified", detail: `Onboarding submitted ${new Date(r.done).toISOString().slice(0, 10)}.` };
    return { status: "unverified", detail: "The client has not submitted the company onboarding questions yet." };
  },
};

const ghlLocation: SetupConnector = {
  key: "ghl_location",
  label: CHECK_LABEL.ghl_location,
  implemented: true,
  async evaluate({ orgId, actorUserId, live }) {
    const { rows } = await withSystem((db) =>
      db.query<{ status: string; verified_at: Date | null; has_credential: boolean; detail: string | null }>(
        `select m.status, m.verified_at, (m.credential_id is not null) as has_credential,
                (select s.detail from integration_status s where s.org_id = m.org_id and s.provider = 'ghl') as detail
         from ghl_location_mappings m where m.org_id = $1`,
        [orgId],
      ),
    );
    const m = rows[0];
    if (!m) return { status: "unverified", detail: "No GoHighLevel location is assigned to this client yet." };
    if (!m.has_credential) return { status: "unverified", detail: "A location is assigned but no access credential has been added." };
    if (live) {
      const res = await verifyGhlConnection(orgId, actorUserId, { skipSetupSync: true });
      return { status: res.ok ? "verified" : "failed", detail: res.detail };
    }
    if (m.status === "connected" && isFresh(m.verified_at)) return { status: "verified", detail: m.detail ?? "Read access verified." };
    if (m.status === "error") return { status: "failed", detail: m.detail ?? "The last GoHighLevel verification failed." };
    return { status: "unverified", detail: m.verified_at ? "The connection was last verified more than 24 hours ago." : "The connection has not been verified yet." };
  },
};

const hermesEmployees: SetupConnector = {
  key: "hermes_employees",
  label: CHECK_LABEL.hermes_employees,
  implemented: true,
  async evaluate({ orgId, actorUserId, live }) {
    type Row = { id: string; role_key: string; status: string; last_health_ok: boolean | null; last_health_check_at: Date | null; has_credential: boolean };
    const load = () =>
      withSystem((db) =>
        db.query<Row>(
          `select id, role_key, status, last_health_ok, last_health_check_at, (credential_id is not null) as has_credential
           from agent_instances where org_id = $1 and enabled order by role_key`,
          [orgId],
        ),
      ).then((r) => r.rows);
    let agents = await load();
    if (!agents.length) return { status: "unverified", detail: "No AI employees are enabled for this client." };
    if (live) {
      // A live refresh is a workforce write; runHealthCheck enforces agency.workforce.manage plus the
      // assigned-client scope. Setup staff without that permission keep the stored result (the rejected
      // promises are settled here and are never reported as a fresh verification).
      await Promise.allSettled(
        agents.filter((a) => a.has_credential).map((a) => runHealthCheck(a.id, { userId: actorUserId, kind: actorUserId ? "agency" : "system" }, { skipSetupSync: true })),
      );
      agents = await load();
    }
    const name = (a: Row) => (isAgentRoleKey(a.role_key) ? AGENT_BY_KEY[a.role_key].shortName : a.role_key);
    const failing = agents.filter((a) => a.status === "error" || a.status === "offline");
    const notReady = agents.filter((a) => a.status === "setup_required" || a.status === "provisioning");
    const stale = agents.filter((a) => (a.status === "online" || a.status === "busy") && !isFresh(a.last_health_check_at));
    const healthy = agents.length - failing.length - notReady.length - stale.length;
    if (failing.length) return { status: "failed", detail: `${failing.length} of ${agents.length} AI employees failing: ${failing.map((a) => `${name(a)} (${a.status})`).join(", ")}.` };
    if (notReady.length || stale.length) {
      return { status: "unverified", detail: `${healthy} of ${agents.length} AI employees passed a recent live health check. Waiting on: ${[...notReady, ...stale].map(name).join(", ")}.` };
    }
    return { status: "verified", detail: `${agents.length} of ${agents.length} AI employees passed a live health check.` };
  },
};

/**
 * Aggregates the other applicable checks behind required steps: the system is only "tested" when every one of them is verified by
 * provider checks and none is failing. Agency evidence cannot replace a connection test. Checks of optional steps (the SMS and WhatsApp
 * senders, or a step the agency made optional) still run and complete their own steps, but never hold the final check back.
 */
const finalHealth: SetupConnector = {
  key: "final_health",
  label: CHECK_LABEL.final_health,
  implemented: true,
  async evaluate({ applicable, required, stored, labels }) {
    const others = (required ?? applicable).filter((k) => k !== "final_health");
    const label = (k: CheckKey) => labels?.[k] ?? CHECK_LABEL[k];
    const failed = others.filter((k) => stored[k] === "failed");
    const missing = others.filter((k) => stored[k] !== "verified" && stored[k] !== "failed");
    if (failed.length) return { status: "failed", detail: `${failed.length} check${failed.length === 1 ? " is" : "s are"} failing: ${failed.map(label).join(", ")}.` };
    if (missing.length) return { status: "unverified", detail: `Still to verify: ${missing.map(label).join(", ")}.` };
    return {
      status: "verified",
      detail: `All ${others.length} applicable provider checks passed.`,
    };
  },
};

const workflowInventory:SetupConnector={
  key:"workflows",label:CHECK_LABEL.workflows,implemented:true,
  async evaluate({orgId}) {
    const {rows,native}=await withSystem(async(db)=>({
      rows:(await db.query<{status:string;last_verified_at:Date|null;connection_status:string;last_error:string|null}>(
        "select m.status,m.last_verified_at,m.last_error,c.status as connection_status from automation_template_mappings m join integration_connections c on c.id=m.global_connection_id where m.org_id=$1",[orgId],
      )).rows,
      native:(await crmOwners(db,orgId)).capabilities.workflows==="native" ? await workflowEvidence(db,orgId) : null,
    }));
    // A native workflow workspace with no agency n8n mappings is judged by its own workflows: active on an approved version and proven by a
    // completed run. As soon as n8n mappings exist, the n8n rule below applies (it can't prove end-to-end wiring, so it never verifies).
    if(!rows.length&&native)return {status:native.status,detail:native.detail};
    if(!rows.length)return {status:"unverified",detail:"No approved agency workflow instances are mapped to this client. Record dedicated workflow mappings and run client verification."};
    const failed=rows.some(r=>r.status==="needs_attention" || ["error","disconnected","needs_attention"].includes(r.connection_status));
    if(failed)return {status:"failed",detail:"An approved workflow or its agency connection needs attention. Re-run verification; no workflow is activated by this check."};
    if(rows.some(r=>r.status!=="verified" || !isFresh(r.last_verified_at) || r.connection_status!=="connected"))return {status:"unverified",detail:"Mapped workflow inventory needs a fresh client-scoped read-only verification."};
    // Inventory and API access cannot prove tenant-specific workflow wiring or end-to-end behavior.
    return {status:"unverified",detail:`${rows.length} approved workflow instance(s) have verified API visibility. End-to-end configuration and authenticated appointment-event delivery still require approved verification; inactive workflows remain inactive.`};
  },
};

// ---------------------------------------------------------------------------
// Native CRM workspaces: evidence read from the workspace's own rows (src/server/setup/native-evidence.ts). Reads only, never a provider
// call, so a live run and a recorded pass give the same answer.
// ---------------------------------------------------------------------------

const crmSnapshot: SetupConnector = {
  key: "crm_snapshot",
  label: CHECK_LABEL.crm_snapshot,
  implemented: true,
  async evaluate({ orgId }) {
    const r = await withSystem(async (db) => blueprintEvidence(await loadBlueprintState(db, orgId)));
    return { status: r.status, detail: r.detail };
  },
};

const crmAssets: SetupConnector = {
  key: "crm_assets",
  label: CHECK_LABEL.crm_assets,
  implemented: true,
  async evaluate({ orgId }) {
    const r = await withSystem(async (db) => manifestEvidence(await loadBlueprintState(db, orgId), await actualDataModel(db, orgId)));
    return { status: r.status, detail: r.detail };
  },
};

const nativeCalendar: SetupConnector = {
  key: "calendar",
  label: CHECK_LABEL.calendar,
  implemented: true,
  async evaluate({ orgId }) {
    const r = await withSystem((db) => calendarEvidence(db, orgId));
    return { status: r.status, detail: r.detail };
  },
};

const sender = (key: "email_domain" | "sms_sender" | "whatsapp_sender", channel: SetupChannel): SetupConnector => ({
  key,
  label: CHECK_LABEL[key],
  implemented: true,
  async evaluate({ orgId }) {
    const r = (await withSystem((db) => channelEvidence(db, orgId)))[channel];
    return { status: r.status, detail: r.detail };
  },
});

/**
 * The default registry: every check for a workspace on iAcquire CRM. A workspace whose capability is owned by GoHighLevel uses the
 * GoHighLevel version of that check instead (GHL_CONNECTORS, chosen by connectorsFor), which is exactly what every client had before
 * native CRM existed.
 */
export const CONNECTORS: Record<CheckKey, SetupConnector> = {
  onboarding,
  ghl_location: ghlLocation,
  hermes_employees: hermesEmployees,
  final_health: finalHealth,
  crm_snapshot: crmSnapshot,
  crm_assets: crmAssets,
  workflows: workflowInventory,
  website_live: unimplemented("website_live", "Website publishing and domain connection are not verified automatically yet."),
  email_domain: sender("email_domain", "email"),
  sms_sender: sender("sms_sender", "sms"),
  whatsapp_sender: sender("whatsapp_sender", "whatsapp"),
  calendar: nativeCalendar,
};

/** The checks for capabilities GoHighLevel owns: the portal can't inspect a snapshot, the location's assets, its calendar or its senders. */
export const GHL_CONNECTORS: Partial<Record<CheckKey, SetupConnector>> = {
  crm_snapshot: { ...unimplemented("crm_snapshot", "The portal cannot inspect which snapshot is installed in the GoHighLevel location yet."), label: "CRM snapshot (GoHighLevel)" },
  crm_assets: unimplemented("crm_assets", "The Integrations Manager can discover permitted CRM metadata. Exact expected snapshot assets and tenant-specific configuration have not been verified yet."),
  calendar: { ...unimplemented("calendar", "Google authorization and live availability are not verified by the portal yet."), label: "Google Calendar (GoHighLevel)" },
  email_domain: { ...unimplemented("email_domain", "Email domain (DNS/SPF/DKIM) verification is not connected yet."), label: "Business email domain" },
  sms_sender: unimplemented("sms_sender", "SMS senders on GoHighLevel are verified in GoHighLevel; the portal can't test them."),
  whatsapp_sender: unimplemented("whatsapp_sender", "WhatsApp senders on GoHighLevel are verified in GoHighLevel; the portal can't test them."),
};

/**
 * The connectors that apply to one workspace, chosen by who owns each capability: the CRM Blueprint and asset checks follow the pipelines
 * owner, the calendar check the calendars owner, the sender checks the conversations owner. Read inside the caller's transaction. The
 * objects are the registry's own, so a test that replaces a connector's evaluate sees it here too.
 */
export async function connectorsFor(db: Queryable, orgId: string): Promise<Record<CheckKey, SetupConnector>> {
  const { capabilities } = await crmOwners(db, orgId);
  const out: Record<CheckKey, SetupConnector> = { ...CONNECTORS };
  const ghl = (key: CheckKey) => {
    const c = GHL_CONNECTORS[key];
    if (c) out[key] = c;
  };
  if (capabilities.pipelines === "ghl") ["crm_snapshot", "crm_assets"].forEach((k) => ghl(k as CheckKey));
  if (capabilities.calendars === "ghl") ghl("calendar");
  if (capabilities.conversations === "ghl") ["email_domain", "sms_sender", "whatsapp_sender"].forEach((k) => ghl(k as CheckKey));
  return out;
}

/** Every check's label in one workspace's registry ("CRM snapshot (GoHighLevel)" where GoHighLevel owns the pipelines). */
export function connectorLabels(registry: Record<CheckKey, SetupConnector>): Record<CheckKey, string> {
  return Object.fromEntries(CHECK_KEYS.map((k) => [k, registry[k]?.label ?? CHECK_LABEL[k]])) as Record<CheckKey, string>;
}

/** Order matters: aggregate checks run last so they see this run's results. */
export const CHECK_RUN_ORDER: CheckKey[] = [...CHECK_KEYS.filter((k) => k !== "final_health"), "final_health"];

/** What the agency sees about a check's connector, from the registry that applies to the workspace (the native one by default). */
export function connectorSummary(key: CheckKey, registry: Record<CheckKey, SetupConnector> = CONNECTORS) {
  const c = registry[key];
  return { implemented: c.implemented, note: c.unavailableReason ?? null, label: c.label };
}
