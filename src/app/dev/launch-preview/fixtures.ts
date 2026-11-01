import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { deriveLaunchReadiness, type CalendarFacts, type EmployeeFact, type LaunchFacts, type LaunchReadiness, type VerificationFact } from "@/lib/launch-readiness";

// Clearly labelled sample facts for Bright Homes Roofing, a company that does not exist. They go through the real judge (src/lib/launch-readiness.ts), so what the preview shows is what the
// product would say for these facts, and nothing here reads or changes any data.

export type LaunchPreviewView = "unpaid" | "working" | "action" | "review" | "ready";
export const LAUNCH_PREVIEW_VIEWS: readonly LaunchPreviewView[] = ["unpaid", "working", "action", "review", "ready"];

const employee = (role: AgentRoleKey, over: Partial<EmployeeFact> = {}): EmployeeFact => ({
  role, entitled: true, provisioning: "succeeded", provisioningDetail: null, attempts: 1, maxAttempts: 3, nextRetryAt: null, healthFailed: false, healthDetail: null, heldForReview: false, configVersion: 3,
  readiness: { state: "ready", chatAvailable: true, workReady: true, description: "Ready for authorized work.", blocking: [] },
  ...over,
});
const notReady = (state: EmployeeFact["readiness"]["state"], description: string, blocking: string[] = []): EmployeeFact["readiness"] => ({ state, chatAvailable: false, workReady: false, description, blocking });
const checks = (ok: boolean): CalendarFacts["checks"] => (["hosts", "hours", "timezone", "types", "connections", "slot"] as const).map((key) => ({ key, ok, detail: ok ? "Passed." : "Not yet." }));
const calendar = (over: Partial<CalendarFacts> = {}): CalendarFacts => ({ id: "preview", status: "active", hosts: 1, hostsWithHours: 1, hasSuggestedHours: true, types: 2, needsVideoConnection: false, checks: checks(true), bookingPageOn: false, ...over });
const passed = (role: AgentRoleKey): VerificationFact => ({ role, state: "passed", configVersion: 3, detail: "A read-only check on your real records completed. Nothing was changed or sent." });

function base(): LaunchFacts {
  return {
    submitted: true, paymentCleared: true, canOpenBilling: true,
    profile: { companyName: true, industry: true, description: true, timezone: "America/Chicago", timezoneAnswered: true },
    knowledge: { approved: 5, pending: 0 },
    crm: { mode: "native", blueprint: "verified", pipelineReady: true, records: { state: "in_place", tags: 12, contactFields: 8, forms: 2 }, providerConnected: false },
    appointments: { wanted: true, calendar: calendar(), externalCalendarConnected: false },
    channels: [{ channel: "email", wanted: true, enabled: true, registration: "not_required", statedSender: "hello@brighthomes.example", credentialStored: true }, { channel: "sms", wanted: false, enabled: false, registration: "not_started" }, { channel: "whatsapp", wanted: false, enabled: false, registration: "not_started" }],
    employees: AGENT_ROLE_KEYS.map((role) => employee(role)),
    verification: AGENT_ROLE_KEYS.map(passed),
  };
}

export function launchPreview(view: LaunchPreviewView): LaunchReadiness {
  const f = base();
  switch (view) {
    case "unpaid":
      return deriveLaunchReadiness({
        ...f, paymentCleared: false, knowledge: { approved: 0, pending: 0 }, crm: { ...f.crm, blueprint: "none", pipelineReady: false, records: { state: "pending", tags: 0, contactFields: 0, forms: 0 } },
        appointments: { wanted: true, calendar: calendar({ status: "draft", hosts: 0, hostsWithHours: 0, checks: null }), externalCalendarConnected: false },
        employees: AGENT_ROLE_KEYS.map((role) => employee(role, { provisioning: "none", configVersion: null, readiness: notReady("pending_setup", "Waiting for your setup payment.") })),
        verification: [],
      });
    case "working":
      return deriveLaunchReadiness({
        ...f,
        employees: AGENT_ROLE_KEYS.map((role, i) => employee(role, i < 2 ? {} : { provisioning: i < 4 ? "in_progress" : "requested", attempts: 0, configVersion: null, readiness: notReady("provisioning", "Its dedicated profile is being created.") })),
        verification: AGENT_ROLE_KEYS.slice(0, 2).map(passed),
      });
    case "action":
      return deriveLaunchReadiness({
        ...f, knowledge: { approved: 5, pending: 2 },
        crm: { ...f.crm, blueprint: "waiting_for_a_person", pipelineReady: false, records: { state: "pending", tags: 0, contactFields: 0, forms: 0 } },
        channels: [{ channel: "email", wanted: true, enabled: true, registration: "not_required", statedSender: "hello@brighthomes.example", credentialStored: true }, { channel: "sms", wanted: true, enabled: false, registration: "pending", statedSender: "+1 512 555 0100", credentialStored: true }, { channel: "whatsapp", wanted: false, enabled: false, registration: "not_started" }],
        appointments: { wanted: true, calendar: calendar({ status: "draft", hosts: 0, hostsWithHours: 0, checks: null }), externalCalendarConnected: false },
        employees: AGENT_ROLE_KEYS.map((role) => (role === "appointment_setter"
          ? employee(role, { readiness: { state: "ready", chatAvailable: true, workReady: false, description: "Waiting for a calendar that takes bookings.", blocking: ["A calendar that takes bookings"] } })
          : role === "lead_hunter" ? employee(role, { provisioning: "failed", attempts: 3, configVersion: null, readiness: notReady("pending_setup", "Setting up its profile failed.") })
          : role === "sales_assistant" ? employee(role, { provisioning: "awaiting_health_check", healthFailed: true, healthDetail: "The Hermes gateway did not answer.", configVersion: null, readiness: notReady("pending_setup", "Its connection check did not pass.") }) : employee(role))),
        verification: AGENT_ROLE_KEYS.filter((r) => r !== "appointment_setter" && r !== "lead_hunter").slice(0, 2).map(passed),
      });
    case "review":
      return deriveLaunchReadiness({
        ...f, employees: AGENT_ROLE_KEYS.map((role) => (role === "crm_manager" ? employee(role, { heldForReview: true, configVersion: null, readiness: notReady("pending_setup", "A configuration change is under review.") }) : employee(role))),
        verification: AGENT_ROLE_KEYS.filter((r) => r !== "crm_manager").map(passed),
      });
    case "ready":
      return deriveLaunchReadiness(f);
  }
}
