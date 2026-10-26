import Link from "next/link";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";
import type { AgentInstanceRow } from "@/server/workforce/service";

export interface EmployeeProvisioningState {
  role: AgentRoleKey;
  status: string | null;
  detail: string | null;
}

/** Reads persisted configuration, health, inventory and job evidence. No elapsed-time progress is inferred. */
export function OnboardedBanner({ nativeCrm, crmGuide, agents = [], provisioning = [], paymentCleared }: {
  nativeCrm: boolean;
  crmGuide: boolean;
  agents?: AgentInstanceRow[];
  provisioning?: EmployeeProvisioningState[];
  /** Whether the setup payment is confirmed; employees do not start without it. */
  paymentCleared?: boolean;
}) {
  const jobs = new Map(provisioning.map((job) => [job.role, job]));
  const rows = AGENT_ROLE_KEYS.map((role) => {
    const agent = agents.find((item) => item.role_key === role);
    const job = jobs.get(role);
    if (!agent) return { role, label: "Action required", detail: "This employee has not been created. iAcquire needs to review the workspace.", ready: false };
    const readiness = deriveEmployeeReadiness({
      displayName: agent.display_name, enabled: agent.enabled, status: agent.status,
      configVersion: agent.config_version, lastHealthCheckAt: agent.last_health_check_at?.toISOString() ?? null,
      lastHealthOk: agent.last_health_ok, lastHealthDetail: agent.last_health_detail,
      inventoryContract: agent.tool_inventory_contract, inventoryDigest: agent.tool_inventory_digest,
      inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
      inventoryExpiresAt: agent.tool_inventory_expires_at?.toISOString() ?? null,
      inventoryToolCount: agent.tool_inventory_tool_count, credentialCurrent: agent.credential_ready,
      paymentCleared, extras: agent.readiness_extras,
    });
    if (readiness.chatAvailable) return { role, label: "Ready", detail: "Verified for authorized chat. Connected workflows depend on their own setup.", ready: true };
    if (paymentCleared === false && !job) return { role, label: "Waiting for setup payment", detail: `${PAYMENT_REQUIRED_SENTENCE}.`, ready: false };
    if (job?.status === "failed") return { role, label: "Failed · review needed", detail: "Profile setup failed. iAcquire can review the recorded error and retry safely.", ready: false };
    if (job?.status === "requested") return { role, label: "Provisioning requested", detail: "iAcquire has the setup request. A dedicated profile and runtime verification are still required.", ready: false };
    if (job?.status === "in_progress") return { role, label: "Provisioning", detail: "iAcquire has recorded a setup attempt. Runtime verification has not passed yet.", ready: false };
    if (job?.status === "awaiting_health_check") return { role, label: "Verification required", detail: "The profile is mapped; its connection and tools still need verification.", ready: false };
    if (agent.config_version && !agent.hermes_profile) return { role, label: "Configuration ready", detail: "Business configuration is saved. A dedicated Hermes profile is still needed.", ready: false };
    if (agent.hermes_profile && agent.last_health_ok === false) return { role, label: "Connection required", detail: "The latest connection check did not pass. iAcquire needs to resolve it.", ready: false };
    return { role, label: "Action required", detail: readiness.description, ready: false };
  });
  const ready = rows.filter((row) => row.ready).length;
  return (
    <section role="status" aria-label="Your six AI employees" className="mx-auto mb-6 max-w-6xl overflow-hidden rounded-[26px] border border-line bg-surface p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[.16em] text-primary">Company information saved</p>
          <h2 className="mt-1 text-[23px] font-semibold tracking-tight text-ink">Meet your AI team</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">Your business information is saved. Each employee becomes available when its real connection and permission checks pass. You can view and edit its generated configuration at any time.</p>
        </div>
        <span className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[12px] font-semibold text-ink">{ready}/6 ready</span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const meta = AGENT_BY_KEY[row.role];
          return (
            <div key={row.role} className="rounded-2xl border border-line bg-surface-2/40 p-4">
              <div className="flex items-start justify-between gap-2"><h3 className="text-[14px] font-semibold text-ink">{meta.shortName}</h3><span className={row.ready ? "text-[12px] font-semibold text-success-ink" : "text-[12px] font-semibold text-warning-ink"}>{row.label}</span></div>
              <p className="mt-2 min-h-12 text-[12px] leading-relaxed text-muted">{row.detail}</p>
              <Link href={row.ready ? `/chat/${meta.slug}` : `/employees/${meta.slug}`} className="mt-3 inline-block text-[12px] font-semibold text-primary hover:underline">{row.ready ? "Open chat" : "View employee"} →</Link>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-muted">
        {nativeCrm ? "The iAcquire team applies your industry Blueprint to your CRM." : "The iAcquire team links your CRM."} Booking and external messaging require their own verified connections; they do not delay core employee chat.
        {crmGuide && <> <Link href="/crm/setup" className="font-semibold text-primary underline underline-offset-2">Open your CRM setup guide</Link></>}
      </p>
    </section>
  );
}
