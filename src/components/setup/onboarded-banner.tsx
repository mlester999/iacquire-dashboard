import Link from "next/link";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { ITEM_STATE_LABEL, type LaunchItem, type LaunchReadiness } from "@/lib/launch-readiness";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";
import type { AgentInstanceRow } from "@/server/workforce/service";
import type { GrowthPartnerControlState } from "@/server/ai-growth-partner/service";

export interface EmployeeProvisioningState {
  role: AgentRoleKey;
  status: string | null;
  detail: string | null;
}

type Row = { role: AgentRoleKey; label: string; detail: string; ready: boolean };

/** One retained role profile as the launch judge reads it: the same status the launch panel below shows for that profile. */
function judgedRow(role: AgentRoleKey, item: LaunchItem | undefined): Row {
  if (!item) return { role, label: "Action required", detail: "This previous role record has not been created. iAcquire needs to review the workspace.", ready: false };
  return { role, label: ITEM_STATE_LABEL[item.state], detail: item.detail, ready: item.state === "done" };
}

/**
 * Reads persisted configuration, health, inventory and job evidence. No elapsed-time progress is inferred. When the launch judge's reading is given, every number and word comes from
 * it: there is one answer to "how ready is this client", and a count of profiles that merely answer in chat is not it. Without it (the read failed) the profiles are listed
 * from their own records and nothing is counted.
 */
export function OnboardedBanner({ nativeCrm, crmGuide, agents = [], provisioning = [], paymentCleared, readiness = null, growthPartner = null }: {
  nativeCrm: boolean;
  crmGuide: boolean;
  agents?: AgentInstanceRow[];
  provisioning?: EmployeeProvisioningState[];
  /** Whether the setup payment is confirmed; profile work does not start without it. */
  paymentCleared?: boolean;
  /** The launch judge's reading of this workspace. */
  readiness?: LaunchReadiness | null;
  /** Present for the unified product model; legacy profile records are shown only for older workspaces. */
  growthPartner?: GrowthPartnerControlState | null;
}) {
  const jobs = new Map(provisioning.map((job) => [job.role, job]));
  const judged = new Map((readiness?.steps.find((s) => s.key === "employees")?.items ?? []).map((i) => [i.key, i]));
  const rows: Row[] = AGENT_ROLE_KEYS.map((role) => {
    if (readiness) return judgedRow(role, judged.get(`employees.${role}`));
    const agent = agents.find((item) => item.role_key === role);
    const job = jobs.get(role);
    if (!agent) return { role, label: "Action required", detail: "This previous role record has not been created. iAcquire needs to review the workspace.", ready: false };
    const employee = deriveEmployeeReadiness({
      displayName: agent.display_name, enabled: agent.enabled, status: agent.status,
      configVersion: agent.config_version, lastHealthCheckAt: agent.last_health_check_at?.toISOString() ?? null,
      lastHealthOk: agent.last_health_ok, lastHealthDetail: agent.last_health_detail,
      inventoryContract: agent.tool_inventory_contract, inventoryDigest: agent.tool_inventory_digest,
      inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
      inventoryExpiresAt: agent.tool_inventory_expires_at?.toISOString() ?? null,
      inventoryToolCount: agent.tool_inventory_tool_count, credentialCurrent: agent.credential_ready,
      paymentCleared, extras: agent.readiness_extras,
    });
    // These are retained settings only; current chat and work belong to the permanent Growth Partner conversation.
    if (employee.chatAvailable) return { role, label: "Saved checks passed", detail: "The previous record passed its saved connection checks. New work uses the permanent Growth Partner conversation.", ready: true };
    if (paymentCleared === false && !job) return { role, label: "Waiting for setup payment", detail: `${PAYMENT_REQUIRED_SENTENCE}.`, ready: false };
    if (job?.status === "failed") return { role, label: "Failed · review needed", detail: "Profile setup failed. iAcquire can review the recorded error and retry safely.", ready: false };
    if (job?.status === "requested") return { role, label: "Previous setup request", detail: "A setup request for this retained role is recorded. The Growth Partner migration has its own runtime and verification path.", ready: false };
    if (job?.status === "in_progress") return { role, label: "Previous setup in progress", detail: "A setup attempt for this retained role is recorded. Growth Partner readiness is checked separately.", ready: false };
    if (job?.status === "awaiting_health_check") return { role, label: "Saved verification needed", detail: "The previous profile is mapped; its recorded connection and tools still need review.", ready: false };
    if (agent.config_version && !agent.hermes_profile) return { role, label: "Saved configuration", detail: "Business settings are preserved. The Growth Partner uses its own dedicated runtime profile.", ready: false };
    if (agent.hermes_profile && agent.last_health_ok === false) return { role, label: "Connection required", detail: "The latest connection check did not pass. iAcquire needs to resolve it.", ready: false };
    return { role, label: "Action required", detail: employee.description, ready: false };
  });
  if (growthPartner) {
    return (
      <section role="status" aria-label="AI Growth Partner setup" className="mx-auto mb-6 max-w-6xl overflow-hidden rounded-[26px] border border-line bg-surface p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[.16em] text-primary">Company information saved</p>
            <h2 className="mt-1 text-[23px] font-semibold tracking-tight text-ink">Your AI Growth Partner is being prepared</h2>
            <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">Your answers have been organized into one Business Brain. Suggested or missing details remain unconfirmed. iAcquire checks the dedicated runtime and its permitted tools before the partner is ready.</p>
          </div>
          {growthPartner.currentVersion !== null && <span className="rounded-full border border-success/20 bg-success-soft px-3 py-1.5 text-[12px] font-semibold text-success-ink">Business Brain v{growthPartner.currentVersion} active</span>}
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-line bg-surface-2/40 p-4"><p className="text-[12px] font-medium uppercase tracking-wide text-muted">Business Brain</p><p className="mt-1 text-[14px] font-semibold text-ink">{growthPartner.currentVersion ? `Active version ${growthPartner.currentVersion}` : growthPartner.draftVersion ? `Draft version ${growthPartner.draftVersion}` : "Preparation needed"}</p></div>
          <div className="rounded-2xl border border-line bg-surface-2/40 p-4"><p className="text-[12px] font-medium uppercase tracking-wide text-muted">Dedicated runtime</p><p className="mt-1 text-[14px] font-semibold text-ink">{growthPartner.runtimeAgentInstanceId ? "Linked · connection verification required" : "Not linked yet"}</p></div>
          <div className="rounded-2xl border border-line bg-surface-2/40 p-4"><p className="text-[12px] font-medium uppercase tracking-wide text-muted">Permanent conversation</p><p className="mt-1 text-[14px] font-semibold text-ink">{growthPartner.conversationId ? "Ready in Partner Control Center" : "Opens after the runtime passes its checks"}</p></div>
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-muted">{nativeCrm ? "The iAcquire team applies your industry Blueprint to your CRM." : "The iAcquire team links your CRM."} Calendar availability and customer messaging each require their own verified connections and approvals.
          {crmGuide && <> <Link href="/crm/setup" className="font-semibold text-primary underline underline-offset-2">Open your CRM setup guide</Link></>}
        </p>
        <Link href="/growth-partner" className="mt-4 inline-flex min-h-10 items-center rounded-xl bg-primary px-4 text-[13px] font-semibold text-white">Open AI Growth Partner</Link>
      </section>
    );
  }
  return (
    <section role="status" aria-label="Previous role profiles" className="mx-auto mb-6 max-w-6xl overflow-hidden rounded-[26px] border border-line bg-surface p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[.16em] text-primary">Company information saved</p>
          <h2 className="mt-1 text-[23px] font-semibold tracking-tight text-ink">Previous role profiles preserved</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">Your existing profiles, histories and schedules stay as-is. Moving this workspace to one AI Growth Partner requires its own runtime and permission checks plus your approval; saving business information alone does not change or retire a profile.</p>
        </div>
        {readiness && (
          <span data-testid="banner-launch" className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[12px] font-semibold text-ink">
            {readiness.label}: {readiness.passed} of {readiness.total} checks passed
          </span>
        )}
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const meta = AGENT_BY_KEY[row.role];
          return (
            <div key={row.role} data-employee={row.role} className="rounded-2xl border border-line bg-surface-2/40 p-4">
              <div className="flex items-start justify-between gap-2"><h3 className="text-[14px] font-semibold text-ink">{meta.shortName}</h3><span className={row.ready ? "text-[12px] font-semibold text-success-ink" : "text-[12px] font-semibold text-warning-ink"}>{row.label}</span></div>
              <p className="mt-2 min-h-12 text-[12px] leading-relaxed text-muted">{row.detail}</p>
              <Link href={`/employees/${meta.slug}`} className="mt-3 inline-block text-[12px] font-semibold text-primary hover:underline">Review previous profile →</Link>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-muted">
        {nativeCrm ? "The iAcquire team applies your industry Blueprint to your CRM." : "The iAcquire team links your CRM."} Booking and external messaging require their own verified connections; they do not delay available AI chat.
        {crmGuide && <> <Link href="/crm/setup" className="font-semibold text-primary underline underline-offset-2">Open your CRM setup guide</Link></>}
      </p>
    </section>
  );
}
