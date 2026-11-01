import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { channelIsReady, deriveLaunchReadiness, type CalendarFacts, type EmployeeFact, type LaunchFacts, type VerificationFact } from "@/lib/launch-readiness";

// "100% Ready to Launch" must mean every applicable, required setup and verification check passed, and nothing less: not a queued job, not a drafted calendar, not a green badge.

const employee = (role: AgentRoleKey, over: Partial<EmployeeFact> = {}): EmployeeFact => ({
  role, entitled: true, provisioning: "none", provisioningDetail: null, heldForReview: false, configVersion: 3,
  readiness: { state: "ready", chatAvailable: true, workReady: true, description: "Ready for authorized work.", blocking: [] },
  ...over,
});
const calendar = (over: Partial<CalendarFacts> = {}): CalendarFacts => ({
  id: "cal-1", status: "active", hosts: 1, hostsWithHours: 1, hasSuggestedHours: true, types: 2, needsVideoConnection: false, bookingPageOn: false,
  checks: [{ key: "hosts", ok: true, detail: "" }, { key: "hours", ok: true, detail: "" }, { key: "timezone", ok: true, detail: "" }, { key: "types", ok: true, detail: "" }, { key: "connections", ok: true, detail: "" }, { key: "slot", ok: true, detail: "" }],
  ...over,
});
const passed = (role: AgentRoleKey, configVersion = 3): VerificationFact => ({ role, state: "passed", configVersion, detail: null });

/** A client that really is ready: everything below is true, so each test changes one thing and watches what moves. */
function ready(over: Partial<LaunchFacts> = {}): LaunchFacts {
  return {
    submitted: true, paymentCleared: true, canOpenBilling: true,
    profile: { companyName: true, industry: true, description: true, timezone: "Asia/Manila", timezoneAnswered: true },
    knowledge: { approved: 4, pending: 0 },
    crm: { mode: "native", blueprintApplied: true, pipelineReady: true, providerConnected: false },
    appointments: { wanted: true, calendar: calendar(), externalCalendarConnected: false },
    channels: [{ channel: "email", wanted: true, enabled: true, registration: "not_started" }, { channel: "sms", wanted: false, enabled: false, registration: "not_started" }],
    employees: AGENT_ROLE_KEYS.map((role) => employee(role)),
    verification: AGENT_ROLE_KEYS.map((role) => passed(role)),
    ...over,
  };
}
const replaceEmployee = (f: LaunchFacts, role: AgentRoleKey, over: Partial<EmployeeFact>): LaunchFacts => ({ ...f, employees: f.employees.map((e) => (e.role === role ? { ...e, ...over } : e)) });
const itemOf = (r: ReturnType<typeof deriveLaunchReadiness>, key: string) => r.steps.flatMap((s) => s.items).find((i) => i.key === key)!;

describe("the overall state", () => {
  it("is 100% Ready to Launch only when every applicable required check has passed", () => {
    const r = deriveLaunchReadiness(ready());
    expect(r).toMatchObject({ state: "ready_to_launch", label: "100% Ready to Launch", percent: 100, blocking: [] });
    expect(r.passed).toBe(r.total);
    expect(r.steps.map((s) => s.state).every((s) => s === "done")).toBe(true);
  });

  it("keeps the five states apart: not started, questionnaire submitted, provisioning, action required, ready for review", () => {
    expect(deriveLaunchReadiness(ready({ submitted: false })).state).toBe("not_started");
    expect(deriveLaunchReadiness(ready({ paymentCleared: false })).state).toBe("questionnaire_submitted");
    expect(deriveLaunchReadiness(replaceEmployee(ready(), "sales_assistant", { provisioning: "in_progress", readiness: { state: "provisioning", chatAvailable: false, workReady: false, description: "", blocking: [] } })).state).toBe("provisioning");
    expect(deriveLaunchReadiness(ready({ knowledge: { approved: 0, pending: 0 } })).state).toBe("action_required");
    expect(deriveLaunchReadiness(replaceEmployee(ready(), "crm_manager", { heldForReview: true, readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "", blocking: [] } })).state).toBe("ready_for_review");
  });

  it("never reaches 100% without something required behind it: a workspace with no employee records is not ready", () => {
    const noEmployees = deriveLaunchReadiness({
      submitted: true, paymentCleared: true, canOpenBilling: false, profile: { companyName: true, industry: true, description: true, timezone: "UTC", timezoneAnswered: true },
      knowledge: { approved: 1, pending: 0 }, crm: { mode: "native", blueprintApplied: true, pipelineReady: true, providerConnected: false },
      appointments: { wanted: false, calendar: null, externalCalendarConnected: false }, channels: [], employees: [], verification: [],
    });
    // Employees that were never created are things iAcquire has to look at, not things that quietly do not apply.
    expect(noEmployees.state).toBe("action_required");
    // The Appointment Setter is not applicable here (this client does not book appointments); the other five were never created.
    expect(noEmployees.blocking.map((i) => i.key)).toEqual(AGENT_ROLE_KEYS.filter((role) => role !== "appointment_setter").map((role) => `employees.${role}`));
    expect(noEmployees.blocking.every((i) => i.owner === "iacquire" && i.detail.includes("has not been created"))).toBe(true);
    expect(deriveLaunchReadiness(ready()).total).toBeGreaterThan(0);
  });

  it("says who has to move: a failure iAcquire must look at is counted apart from a step the client must do", () => {
    const r = deriveLaunchReadiness(replaceEmployee(ready({ knowledge: { approved: 0, pending: 0 } }), "lead_hunter", { provisioning: "failed", readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "", blocking: [] } }));
    expect(r.state).toBe("action_required");
    expect(r.detail).toContain("1 thing needs you");
    expect(r.detail).toContain("1 needs iAcquire's attention");
    expect(r.blocking.map((i) => [i.key, i.owner])).toEqual([["knowledge.approved", "you"], ["employees.lead_hunter", "iacquire"]]);
  });
});

describe("a queued job, a draft or a badge is not a pass", () => {
  it("shows a queued or running provisioning job as in progress, never as done, and a failed one as failed", () => {
    for (const provisioning of ["requested", "in_progress", "awaiting_health_check"] as const) {
      const r = deriveLaunchReadiness(replaceEmployee(ready(), "performance_analyst", { provisioning, readiness: { state: "provisioning", chatAvailable: false, workReady: false, description: "", blocking: [] } }));
      expect(itemOf(r, "employees.performance_analyst").state, provisioning).toBe("in_progress");
      expect(r.state).toBe("provisioning");
    }
    const failed = deriveLaunchReadiness(replaceEmployee(ready(), "performance_analyst", { provisioning: "failed", readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "", blocking: [] } }));
    expect(itemOf(failed, "employees.performance_analyst")).toMatchObject({ state: "failed", owner: "iacquire" });
  });

  it("does not count an employee that can chat but is missing what its role needs", () => {
    const r = deriveLaunchReadiness(replaceEmployee(ready(), "lead_hunter", { readiness: { state: "pending_setup", chatAvailable: true, workReady: false, description: "", blocking: ["saved lead targeting"] } }));
    expect(itemOf(r, "employees.lead_hunter")).toMatchObject({ state: "action_required", owner: "you" });
    expect(itemOf(r, "employees.lead_hunter").detail).toContain("saved lead targeting");
    expect(r.state).toBe("action_required");
  });

  it("does not count a drafted calendar: it needs a host, approved hours, a real open time and activation", () => {
    const draft = calendar({ status: "draft", hosts: 0, hostsWithHours: 0, checks: null });
    const r = deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: draft, externalCalendarConnected: false } }));
    expect(itemOf(r, "calendar.host")).toMatchObject({ state: "action_required", owner: "you", action: { intent: "assign_host" } });
    expect(itemOf(r, "calendar.hours").state).toBe("in_progress");
    expect(itemOf(r, "calendar.verified").state).toBe("in_progress");
    expect(itemOf(r, "calendar.active").state).toBe("in_progress");
    expect(r.state).toBe("action_required");
  });

  it("walks a calendar from draft to active one real step at a time, never inventing a host or hours", () => {
    const base = { status: "draft" as const, types: 1, checks: null };
    let r = deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ ...base, hosts: 1, hostsWithHours: 0 }), externalCalendarConnected: false } }));
    expect(itemOf(r, "calendar.host").state).toBe("done");
    expect(itemOf(r, "calendar.hours")).toMatchObject({ state: "action_required", action: { intent: "apply_hours" } });
    r = deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ ...base, hosts: 1, hostsWithHours: 0, hasSuggestedHours: false }), externalCalendarConnected: false } }));
    expect(itemOf(r, "calendar.hours").action).toEqual({ label: "Set hours", href: "/crm/availability" });
    r = deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ ...base, hosts: 1, hostsWithHours: 1 }), externalCalendarConnected: false } }));
    expect(itemOf(r, "calendar.hours").state).toBe("done");
    expect(itemOf(r, "calendar.active")).toMatchObject({ state: "action_required", action: { intent: "activate_calendar" } });
    r = deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ ...base, hosts: 1, hostsWithHours: 1, checks: [{ key: "slot", ok: false, detail: "No open time in the next 14 days." }] }), externalCalendarConnected: false } }));
    expect(itemOf(r, "calendar.verified")).toMatchObject({ state: "action_required", detail: "No open time in the next 14 days." });
    r = deriveLaunchReadiness(ready());
    expect(itemOf(r, "calendar.active").state).toBe("done");
  });

  it("fails an active calendar whose real open time can no longer be found", () => {
    const r = deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ checks: [{ key: "slot", ok: false, detail: "The host has no free time." }] }), externalCalendarConnected: false } }));
    expect(itemOf(r, "calendar.verified")).toMatchObject({ state: "failed", detail: "The host has no free time." });
    expect(r.state).toBe("action_required");
  });

  it("asks for a Google or Microsoft connection when a video appointment needs a meeting link", () => {
    const needs = deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ needsVideoConnection: true }), externalCalendarConnected: false } }));
    expect(itemOf(needs, "calendar.connection")).toMatchObject({ state: "action_required", action: { href: "/crm/calendar-connections" } });
    const have = deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ needsVideoConnection: true }), externalCalendarConnected: true } }));
    expect(have.steps.flatMap((s) => s.items).some((i) => i.key === "calendar.connection")).toBe(false);
  });
});

describe("what does not apply never blocks", () => {
  it("marks the calendar and the Appointment Setter not applicable when the business does not book appointments", () => {
    const f = replaceEmployee(ready({ appointments: { wanted: false, calendar: null, externalCalendarConnected: false } }), "appointment_setter", { readiness: { state: "pending_setup", chatAvailable: true, workReady: false, description: "", blocking: ["a calendar with a host"] } });
    const r = deriveLaunchReadiness(f);
    expect(r.steps.find((s) => s.key === "calendar")!.state).toBe("not_applicable");
    expect(itemOf(r, "employees.appointment_setter").state).toBe("not_applicable");
    expect(itemOf(r, "verification.appointment_setter").state).toBe("not_applicable");
    expect(r.state).toBe("ready_to_launch");
  });

  it("asks the question once when the answer is missing", () => {
    const r = deriveLaunchReadiness(ready({ appointments: { wanted: null, calendar: null, externalCalendarConnected: false } }));
    expect(itemOf(r, "calendar.question")).toMatchObject({ state: "action_required", action: { href: "/onboarding" } });
  });

  it("does not wait for a role that is not in the plan", () => {
    const f = { ...ready(), employees: ready().employees.map((e) => (e.role === "sales_assistant" || e.role === "performance_analyst" ? { ...e, entitled: false, readiness: { ...e.readiness, workReady: false, chatAvailable: false, state: "pending_setup" as const } } : e)) };
    const r = deriveLaunchReadiness(f);
    expect(itemOf(r, "employees.sales_assistant")).toMatchObject({ state: "not_applicable", required: false });
    expect(itemOf(r, "verification.performance_analyst").state).toBe("not_applicable");
    expect(r.state).toBe("ready_to_launch");
    expect(r.total).toBe(deriveLaunchReadiness(ready()).total - 4);
  });

  it("lists optional things without letting them block: more knowledge waiting, and a public booking page that stays off", () => {
    const r = deriveLaunchReadiness(ready({ knowledge: { approved: 2, pending: 5 } }));
    expect(itemOf(r, "knowledge.pending")).toMatchObject({ state: "awaiting_review", owner: "iacquire", required: false });
    expect(itemOf(r, "calendar.public")).toMatchObject({ required: false, state: "done" });
    expect(r.state).toBe("ready_to_launch");
  });

  it("treats knowledge held for iAcquire's review as waiting on iAcquire, not as something the client forgot", () => {
    const r = deriveLaunchReadiness(ready({ knowledge: { approved: 0, pending: 3 } }));
    expect(itemOf(r, "knowledge.approved")).toMatchObject({ state: "awaiting_review", owner: "iacquire", required: true });
    expect(r.state).toBe("ready_for_review");
    expect(r.blocking).toEqual([]);
  });

  it("needs no integration when no customer channel was asked for, and one connected channel per channel asked for", () => {
    const none = deriveLaunchReadiness(ready({ channels: [] }));
    expect(none.steps.find((s) => s.key === "integrations")!.state).toBe("not_applicable");
    const sms = deriveLaunchReadiness(ready({ channels: [{ channel: "sms", wanted: true, enabled: true, registration: "pending" }] }));
    expect(itemOf(sms, "integrations.sms")).toMatchObject({ state: "action_required", action: { href: "/inbox/settings" } });
    expect(itemOf(sms, "integrations.sms").detail).toContain("registration is with the carrier");
    const rejected = deriveLaunchReadiness(ready({ channels: [{ channel: "sms", wanted: true, enabled: false, registration: "rejected" }] }));
    expect(itemOf(rejected, "integrations.sms").detail).toContain("registration was rejected");
    expect(deriveLaunchReadiness(ready({ channels: [{ channel: "sms", wanted: true, enabled: true, registration: "approved" }] })).state).toBe("ready_to_launch");
    // These are the only registration values the database allows once a text channel is on (migration 0019).
    expect(channelIsReady({ channel: "sms", enabled: true, registration: "not_required" })).toBe(true);
    expect(channelIsReady({ channel: "sms", enabled: true, registration: "pending" })).toBe(false);
    expect(channelIsReady({ channel: "whatsapp", enabled: true, registration: "not_started" })).toBe(false);
    expect(channelIsReady({ channel: "email", enabled: true, registration: "not_started" })).toBe(true);
    expect(channelIsReady({ channel: "email", enabled: false, registration: "approved" })).toBe(false);
  });

  it("treats a CRM provider other than iAcquire's own as a connection iAcquire verifies, not a pipeline", () => {
    const waiting = deriveLaunchReadiness(ready({ crm: { mode: "ghl", blueprintApplied: false, pipelineReady: false, providerConnected: false } }));
    expect(itemOf(waiting, "crm.provider")).toMatchObject({ state: "in_progress", owner: "iacquire" });
    // Its calendar is the provider's too, so that connection is the other thing iAcquire verifies.
    const linked = { crm: { mode: "ghl" as const, blueprintApplied: false, pipelineReady: false, providerConnected: true }, appointments: { wanted: true, calendar: null, externalCalendarConnected: true } };
    expect(deriveLaunchReadiness(ready(linked)).state).toBe("ready_to_launch");
    expect(itemOf(deriveLaunchReadiness(ready({ ...linked, appointments: { wanted: true, calendar: null, externalCalendarConnected: false } })), "calendar.external")).toMatchObject({ state: "in_progress", owner: "iacquire" });
  });
});

describe("functional verification", () => {
  it("asks for the check until it has run, waits for an employee that is not ready, and passes only what ran on the current configuration", () => {
    let r = deriveLaunchReadiness(ready({ verification: [] }));
    expect(itemOf(r, "verification.operations_manager")).toMatchObject({ state: "action_required", action: { intent: "run_checks" } });
    expect(r.state).toBe("action_required");

    r = deriveLaunchReadiness(replaceEmployee(ready({ verification: [] }), "crm_manager", { readiness: { state: "provisioning", chatAvailable: false, workReady: false, description: "", blocking: [] }, provisioning: "in_progress" }));
    expect(itemOf(r, "verification.crm_manager")).toMatchObject({ state: "in_progress", owner: "system" });

    r = deriveLaunchReadiness(ready({ verification: AGENT_ROLE_KEYS.map((role) => (role === "lead_hunter" ? { role, state: "running" as const } : passed(role))) }));
    expect(itemOf(r, "verification.lead_hunter").state).toBe("in_progress");
    expect(r.state).toBe("provisioning");
  });

  it("turns a pass stale when the employee's configuration has changed since, and a failed check into a failure", () => {
    const stale = deriveLaunchReadiness(ready({ verification: AGENT_ROLE_KEYS.map((role) => passed(role, role === "operations_manager" ? 2 : 3)) }));
    expect(itemOf(stale, "verification.operations_manager")).toMatchObject({ state: "action_required", action: { intent: "run_checks" } });
    expect(itemOf(stale, "verification.operations_manager").detail).toContain("changed since the last check");
    expect(stale.state).toBe("action_required");
    const failed = deriveLaunchReadiness(ready({ verification: AGENT_ROLE_KEYS.map((role) => (role === "appointment_setter" ? { role, state: "failed" as const, configVersion: 3, detail: "No bookable open time was found." } : passed(role))) }));
    expect(itemOf(failed, "verification.appointment_setter")).toMatchObject({ state: "failed", detail: "No bookable open time was found." });
  });
});

describe("the payment gate", () => {
  it("keeps a paid-for state out of reach until the setup payment is confirmed, and says so on each employee", () => {
    const r = deriveLaunchReadiness(ready({ paymentCleared: false, employees: AGENT_ROLE_KEYS.map((role) => employee(role, { readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "", blocking: [] } })) }));
    expect(r.state).toBe("questionnaire_submitted");
    expect(r.detail).toContain("after your setup payment is confirmed");
    expect(itemOf(r, "employees.operations_manager")).toMatchObject({ state: "action_required", action: { href: "/settings/billing" } });
    const noBilling = deriveLaunchReadiness(ready({ paymentCleared: false, canOpenBilling: false, employees: AGENT_ROLE_KEYS.map((role) => employee(role, { readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "", blocking: [] } })) }));
    expect(itemOf(noBilling, "employees.operations_manager").action).toBeUndefined();
  });

  it("does not ask a sample workspace for a payment it never owes", () => {
    expect(deriveLaunchReadiness(ready({ paymentCleared: null })).state).toBe("ready_to_launch");
  });
});

describe("the profile and the percentage", () => {
  it("asks for the company details and a confirmed, real time zone", () => {
    const r = deriveLaunchReadiness(ready({ profile: { companyName: true, industry: false, description: true, timezone: "Mars/Olympus", timezoneAnswered: true } }));
    expect(itemOf(r, "profile.company")).toMatchObject({ state: "action_required", action: { href: "/onboarding" } });
    expect(itemOf(r, "profile.timezone").state).toBe("action_required");
    expect(deriveLaunchReadiness(ready({ profile: { companyName: true, industry: true, description: true, timezone: "Asia/Manila", timezoneAnswered: false } })).steps[0].items[1].state).toBe("action_required");
  });

  it("rounds the percentage down so 99 never shows as 100", () => {
    const r = deriveLaunchReadiness(ready({ knowledge: { approved: 0, pending: 0 } }));
    expect(r.passed).toBe(r.total - 1);
    expect(r.percent).toBe(Math.floor(((r.total - 1) / r.total) * 100));
    expect(r.percent).toBeLessThan(100);
  });
});
