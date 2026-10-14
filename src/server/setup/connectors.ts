import "server-only";
import { withSystem } from "@/server/db";
import { verifyGhlConnection } from "@/server/integrations/ghl";
import { runHealthCheck } from "@/server/workforce/service";
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
  stored: Partial<Record<CheckKey, CheckStatus>>;
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
 * Aggregates the other applicable checks: the system is only "tested" when every one of them is
 * verified by provider checks and none is failing. Agency evidence cannot replace a connection test.
 */
const finalHealth: SetupConnector = {
  key: "final_health",
  label: CHECK_LABEL.final_health,
  implemented: true,
  async evaluate({ applicable, stored }) {
    const others = applicable.filter((k) => k !== "final_health");
    const failed = others.filter((k) => stored[k] === "failed");
    const missing = others.filter((k) => stored[k] !== "verified" && stored[k] !== "failed");
    if (failed.length) return { status: "failed", detail: `${failed.length} check${failed.length === 1 ? " is" : "s are"} failing: ${failed.map((k) => CHECK_LABEL[k]).join(", ")}.` };
    if (missing.length) return { status: "unverified", detail: `Still to verify: ${missing.map((k) => CHECK_LABEL[k]).join(", ")}.` };
    return {
      status: "verified",
      detail: `All ${others.length} applicable provider checks passed.`,
    };
  },
};

const workflowInventory:SetupConnector={
  key:"workflows",label:CHECK_LABEL.workflows,implemented:true,
  async evaluate({orgId}) {
    const {rows}=await withSystem(db=>db.query<{status:string;last_verified_at:Date|null;connection_status:string;last_error:string|null}>(
      "select m.status,m.last_verified_at,m.last_error,c.status as connection_status from automation_template_mappings m join integration_connections c on c.id=m.global_connection_id where m.org_id=$1",[orgId],
    ));
    if(!rows.length)return {status:"unverified",detail:"No approved agency workflow instances are mapped to this client. Record dedicated workflow mappings and run client verification."};
    const failed=rows.some(r=>r.status==="needs_attention" || ["error","disconnected","needs_attention"].includes(r.connection_status));
    if(failed)return {status:"failed",detail:"An approved workflow or its agency connection needs attention. Re-run verification; no workflow is activated by this check."};
    if(rows.some(r=>r.status!=="verified" || !isFresh(r.last_verified_at) || r.connection_status!=="connected"))return {status:"unverified",detail:"Mapped workflow inventory needs a fresh client-scoped read-only verification."};
    // Inventory and API access cannot prove tenant-specific workflow wiring or end-to-end behavior.
    return {status:"unverified",detail:`${rows.length} approved workflow instance(s) have verified API visibility. End-to-end configuration and authenticated appointment-event delivery still require approved verification; inactive workflows remain inactive.`};
  },
};

export const CONNECTORS: Record<CheckKey, SetupConnector> = {
  onboarding,
  ghl_location: ghlLocation,
  hermes_employees: hermesEmployees,
  final_health: finalHealth,
  crm_snapshot: unimplemented("crm_snapshot", "The portal cannot inspect which snapshot is installed in the GoHighLevel location yet."),
  crm_assets: unimplemented("crm_assets", "The Integrations Manager can discover permitted CRM metadata. Exact expected snapshot assets and tenant-specific configuration have not been verified yet."),
  workflows: workflowInventory,
  website_live: unimplemented("website_live", "Website publishing and domain connection are not verified automatically yet."),
  email_domain: unimplemented("email_domain", "Email domain (DNS/SPF/DKIM) verification is not connected yet."),
  calendar: unimplemented("calendar", "Google authorization and live availability are not verified by the portal yet."),
};

/** Order matters: aggregate checks run last so they see this run's results. */
export const CHECK_RUN_ORDER: CheckKey[] = [...CHECK_KEYS.filter((k) => k !== "final_health"), "final_health"];

export function connectorSummary(key: CheckKey) {
  const c = CONNECTORS[key];
  return { implemented: c.implemented, note: c.unavailableReason ?? null };
}
