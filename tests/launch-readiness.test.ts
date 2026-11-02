import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { actionKind, channelIsReady, connectionSteps, deriveLaunchReadiness, employeeStages, fingerprintOf, LAUNCH_INTENTS, STALL_MINUTES, summarizeWeeklyHours, type CalendarFacts, type ChannelFact, type CrmBlueprintFact, type EmployeeFact, type HostConnectionFact, type LaunchFacts, type VerificationFact } from "@/lib/launch-readiness";

// "100% Ready to Launch" must mean every applicable, required setup and verification check passed, and nothing less: not a queued job, not a drafted calendar, not a green badge.

const employee = (role: AgentRoleKey, over: Partial<EmployeeFact> = {}): EmployeeFact => ({
  role, entitled: true, provisioning: "none", provisioningDetail: null, attempts: 0, maxAttempts: 3, nextRetryAt: null, healthFailed: false, healthDetail: null, heldForReview: false, configVersion: 3,
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
    crm: { mode: "native", blueprint: "verified", pipelineReady: true, records: { state: "in_place", tags: 3, contactFields: 2, forms: 1 }, providerConnected: false },
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
      knowledge: { approved: 1, pending: 0 }, crm: { mode: "native", blueprint: "verified", pipelineReady: true, providerConnected: false },
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

  it("shows an attempt that is being retried by itself as in progress, with no one to act, and still not as done", () => {
    const r = deriveLaunchReadiness(replaceEmployee(ready(), "performance_analyst", { provisioning: "retrying", readiness: { state: "pending_setup", chatAvailable: false, workReady: false, description: "", blocking: [] } }));
    expect(itemOf(r, "employees.performance_analyst")).toMatchObject({ state: "in_progress", owner: "system" });
    expect(itemOf(r, "employees.performance_analyst").detail).toContain("tried again automatically");
    expect(r.blocking.map((i) => i.key)).not.toContain("employees.performance_analyst");
    expect(r.state).toBe("provisioning");
    expect(r.percent).toBeLessThan(100);
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
    // The provider is not named: the connections screen offers each one.
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

  it("titles the employees step from what the plan includes, the way the review words it", () => {
    expect(deriveLaunchReadiness(ready()).steps.find((s) => s.key === "employees")?.title).toBe("Your six AI employees");
    const drop = (...gone: string[]) => deriveLaunchReadiness({ ...ready(), employees: ready().employees.map((e) => (gone.includes(e.role) ? { ...e, entitled: false } : e)) }).steps.find((s) => s.key === "employees")?.title;
    expect(drop("sales_assistant")).toBe("Your five AI employees");
    expect(drop("sales_assistant", "performance_analyst")).toBe("Your four AI employees");
    expect(drop(...AGENT_ROLE_KEYS.slice(1))).toBe("Your one AI employee");
    expect(drop(...AGENT_ROLE_KEYS)).toBe("Your AI employees");
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

  it("treats a failed check for an older configuration as not yet checked, never as this configuration's failure", () => {
    const r = deriveLaunchReadiness(ready({ verification: AGENT_ROLE_KEYS.map((role) => (role === "crm_manager" ? { role, state: "failed" as const, configVersion: 2, detail: "It did not pass." } : passed(role))) }));
    expect(itemOf(r, "verification.crm_manager")).toMatchObject({ state: "action_required", detail: expect.stringContaining("configuration changed"), action: { intent: "run_checks" } });
    // Failed on the current configuration it is still a failure, with the reason.
    const current = deriveLaunchReadiness(ready({ verification: AGENT_ROLE_KEYS.map((role) => (role === "crm_manager" ? { role, state: "failed" as const, configVersion: 3, detail: "It did not pass." } : passed(role))) }));
    expect(itemOf(current, "verification.crm_manager")).toMatchObject({ state: "failed", detail: "It did not pass." });
  });

  it("needs no integration when no customer channel was asked for, and one connected channel per channel asked for", () => {
    const none = deriveLaunchReadiness(ready({ channels: [] }));
    expect(none.steps.find((s) => s.key === "integrations")!.state).toBe("not_applicable");
    const sms = deriveLaunchReadiness(ready({ channels: [{ channel: "sms", wanted: true, enabled: true, registration: "pending" }] }));
    expect(itemOf(sms, "integrations.sms")).toMatchObject({ state: "in_progress", owner: "iacquire" });
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
    const waiting = deriveLaunchReadiness(ready({ crm: { mode: "ghl", blueprint: "none", pipelineReady: false, providerConnected: false } }));
    expect(itemOf(waiting, "crm.provider")).toMatchObject({ state: "in_progress", owner: "iacquire" });
    // Its calendar is the provider's too, so that connection is the other thing iAcquire verifies.
    const linked = { crm: { mode: "ghl" as const, blueprint: "none" as const, pipelineReady: false, providerConnected: true }, appointments: { wanted: true, calendar: null, externalCalendarConnected: true } };
    expect(deriveLaunchReadiness(ready(linked)).state).toBe("ready_to_launch");
    expect(itemOf(deriveLaunchReadiness(ready({ ...linked, appointments: { wanted: true, calendar: null, externalCalendarConnected: false } })), "calendar.external")).toMatchObject({ state: "in_progress", owner: "iacquire" });
  });
});

describe("functional verification", () => {
  it("asks for the check until it has run, waits for an employee that is not ready, and passes only what ran on the current configuration", () => {
    let r = deriveLaunchReadiness(ready({ verification: [] }));
    expect(itemOf(r, "verification.operations_manager")).toMatchObject({ state: "action_required", detail: expect.stringContaining("Not checked yet"), action: { intent: "run_checks" } });
    // An employee that was never checked has no older configuration to blame: only a check that ran on another version says "changed".
    expect(itemOf(r, "verification.operations_manager").detail).not.toContain("configuration changed");
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

const notReadyEmployee = { state: "pending_setup" as const, chatAvailable: false, workReady: false, description: "", blocking: [] as string[] };
const channelFact = (over: Partial<ChannelFact> = {}): ChannelFact => ({ channel: "sms", wanted: true, enabled: false, registration: "not_started", ...over });
const withChannels = (...channels: ChannelFact[]) => deriveLaunchReadiness(ready({ channels }));

describe("customer channels: who moves next, and what is only a hint", () => {
  it("sends the client to the real messaging screen, never to the old dead address", () => {
    const rejected = withChannels(channelFact({ registration: "rejected" }));
    expect(itemOf(rejected, "integrations.sms").action).toEqual({ label: "See channel status", href: "/settings/messaging" });
    const everyHref = [withChannels(channelFact({ registration: "rejected" }), channelFact({ channel: "whatsapp", registration: "rejected" }), channelFact({ channel: "email", statedSender: null }))]
      .flatMap((r) => r.steps.flatMap((s) => s.items)).flatMap((i) => (i.action?.href ? [i.action.href] : []));
    expect(everyHref.length).toBeGreaterThan(0);
    expect(everyHref.some((h) => h.includes("/inbox/settings"))).toBe(false);
  });

  it("makes a channel with no provider credential iAcquire's step, in progress, with no button for the client", () => {
    for (const channel of ["sms", "whatsapp", "email"] as const) {
      const r = withChannels(channelFact({ channel, statedSender: "the-client@sender.example", credentialStored: false }));
      const i = itemOf(r, `integrations.${channel}`);
      expect(i, channel).toMatchObject({ state: "in_progress", owner: "iacquire", required: true });
      expect(i.action, channel).toBeUndefined();
      expect(i.detail).toContain("iAcquire connects, tests and switches on");
      // Nothing for the client to do, so the workspace is provisioning, not "action required".
      expect(r.state, channel).toBe("provisioning");
      expect(r.blocking.map((b) => b.key)).not.toContain(`integrations.${channel}`);
    }
    // Once the credential is stored the step is iAcquire's test, still not a pass.
    const stored = itemOf(withChannels(channelFact({ credentialStored: true })), "integrations.sms");
    expect(stored).toMatchObject({ state: "in_progress", owner: "iacquire" });
    // A stored credential is not a test: nothing says iAcquire has connected the channel or is testing it until a test result exists.
    expect(stored.detail).toContain("saved the credentials");
    expect(stored.detail).toContain("still has to test it and switch it on");
    expect(stored.detail).not.toMatch(/has connected|is testing/);
  });

  it("shows a registration that is with the carrier or Meta as in progress and iAcquire's, never as the client's to do", () => {
    const sms = itemOf(withChannels(channelFact({ registration: "pending", credentialStored: true })), "integrations.sms");
    expect(sms).toMatchObject({ state: "in_progress", owner: "iacquire" });
    expect(sms.detail).toContain("registration is with the carrier");
    expect(itemOf(withChannels(channelFact({ channel: "whatsapp", registration: "pending" })), "integrations.whatsapp").detail).toContain("registration is with Meta");
  });

  it("keeps the paperwork the client's own: a rejected registration and a missing address or number", () => {
    expect(itemOf(withChannels(channelFact({ registration: "rejected" })), "integrations.sms")).toMatchObject({ state: "action_required", owner: "you" });
    const email = itemOf(withChannels(channelFact({ channel: "email", statedSender: null })), "integrations.email");
    expect(email).toMatchObject({ state: "action_required", owner: "you", action: { label: "Add your sender", href: "/onboarding" } });
    expect(itemOf(withChannels(channelFact({ channel: "whatsapp", statedSender: null })), "integrations.whatsapp")).toMatchObject({ state: "action_required", owner: "you" });
    // A text number may be left blank in the questionnaire (iAcquire helps get one), so that alone is not a client step.
    expect(itemOf(withChannels(channelFact({ channel: "sms", statedSender: null })), "integrations.sms")).toMatchObject({ state: "in_progress", owner: "iacquire" });
  });

  it("shows the sender the client gave, and never counts it as connected", () => {
    const r = withChannels(channelFact({ channel: "email", statedSender: "hello@brightside.example", credentialStored: false }));
    const i = itemOf(r, "integrations.email");
    expect(i.detail).toContain("hello@brightside.example");
    expect(i.detail).toContain("iAcquire still verifies it");
    expect(i.state).not.toBe("done");
    expect(r.state).not.toBe("ready_to_launch");
    // Only an enabled channel with an approved registration is connected, whatever the client wrote.
    expect(channelIsReady({ channel: "sms", enabled: false, registration: "approved" })).toBe(false);
  });

  it("explains the client's own part for a channel they asked for, as guidance and never as a state", () => {
    expect(connectionSteps("email").join(" ")).toMatch(/DNS records/);
    expect(connectionSteps("sms").join(" ")).toMatch(/carrier/);
    expect(connectionSteps("sms").join(" ")).toMatch(/fees/);
    expect(connectionSteps("whatsapp").join(" ")).toMatch(/Meta/);
    const r = withChannels(channelFact({ channel: "email", statedSender: "hello@brightside.example" }));
    expect(itemOf(r, "integrations.email").guidance).toEqual(connectionSteps("email"));
    // A connected channel needs no explaining, and a channel the client did not ask for is not listed at all.
    expect(itemOf(withChannels(channelFact({ channel: "email", enabled: true })), "integrations.email").guidance).toBeUndefined();
    const notWanted = withChannels(channelFact({ channel: "email", enabled: true }), channelFact({ channel: "sms", wanted: false }));
    expect(notWanted.steps.flatMap((s) => s.items).some((i) => i.key === "integrations.sms")).toBe(false);
  });
});

describe("the CRM setup is done only when its evidence is verified", () => {
  const withCrm = (blueprint: CrmBlueprintFact, over: Partial<LaunchFacts["crm"]> = {}) => deriveLaunchReadiness(ready({ crm: { mode: "native", blueprint, pipelineReady: true, providerConnected: false, ...over } }));

  it("is done for a verified setup and for nothing less", () => {
    expect(itemOf(withCrm("verified"), "crm.blueprint")).toMatchObject({ state: "done", owner: "iacquire" });
    expect(withCrm("verified").state).toBe("ready_to_launch");
    for (const blueprint of ["partial", "failed", "missing_records", "waiting_for_a_person"] as const) {
      const r = withCrm(blueprint);
      expect(itemOf(r, "crm.blueprint"), blueprint).toMatchObject({ state: "action_required", owner: "iacquire", required: true });
      expect(r.state, blueprint).toBe("action_required");
      expect(r.blocking.map((b) => b.key), blueprint).toContain("crm.blueprint");
      expect(r.percent, blueprint).toBeLessThan(100);
    }
  });

  it("says a person at iAcquire has to apply the starter when the automation is waiting for one, and asks nothing of the client", () => {
    const i = itemOf(withCrm("waiting_for_a_person"), "crm.blueprint");
    expect(i.detail).toContain("A person at iAcquire has to apply your industry starter");
    expect(i.action).toBeUndefined();
    expect(i.owner).toBe("iacquire");
  });

  it("reads 'being set up' before anything has run, whether or not the automatic setup is switched on", () => {
    for (const automaticSetup of [true, false]) {
      const r = withCrm("none", { automaticSetup, pipelineReady: false });
      expect(itemOf(r, "crm.blueprint")).toMatchObject({ state: "in_progress", owner: "iacquire" });
      expect(itemOf(r, "crm.blueprint").detail).toContain("being set up");
      expect(itemOf(r, "crm.pipeline")).toMatchObject({ state: "in_progress", owner: "iacquire" });
      expect(r.state).toBe("provisioning");
    }
  });

  it("uses the client-safe summary of the evidence for a setup that failed, was partial or lost records, and never an invented one", () => {
    expect(itemOf(withCrm("failed", { blueprintSummary: "Applying your Blueprint didn't finish. iAcquire will review it and try again." }), "crm.blueprint").detail).toBe("Applying your Blueprint didn't finish. iAcquire will review it and try again.");
    expect(itemOf(withCrm("partial"), "crm.blueprint").detail).toContain("partly applied");
    expect(itemOf(withCrm("missing_records", { blueprintSummary: "Some items your Blueprint created are no longer in the CRM. iAcquire will review this with you." }), "crm.blueprint").detail).toContain("no longer in the CRM");
  });

  it("never says missing records do not hold up launch while the Industry CRM setup line, which they come with, does", () => {
    // The server reports missing records only together with an unverified setup (a failed manifest makes the blueprint "missing_records").
    const r = withCrm("missing_records", { records: { state: "missing", tags: 0, contactFields: 0, forms: 0 } });
    expect(r.blocking.map((b) => b.key)).toContain("crm.blueprint");
    const detail = itemOf(r, "crm.records").detail;
    expect(detail).not.toContain("does not hold up launch");
    expect(detail).toContain("Industry CRM setup line above is what holds launch up");
  });

  it("does not call a pipeline done unless it has at least two stages, one of them open (the server reads that into pipelineReady)", () => {
    const r = withCrm("verified", { pipelineReady: false });
    expect(itemOf(r, "crm.pipeline")).toMatchObject({ state: "action_required", owner: "iacquire" });
    expect(itemOf(r, "crm.pipeline").detail).toContain("at least two stages");
    expect(r.state).toBe("action_required");
    expect(itemOf(withCrm("verified"), "crm.pipeline").state).toBe("done");
  });

  it("lists tags, contact fields and forms as an optional line that never blocks launch", () => {
    const missing = withCrm("verified", { records: { state: "missing", tags: 0, contactFields: 0, forms: 0 } });
    expect(itemOf(missing, "crm.records")).toMatchObject({ required: false, state: "action_required", owner: "iacquire" });
    expect(missing.blocking.map((b) => b.key)).not.toContain("crm.records");
    expect(missing.state).toBe("ready_to_launch");
    expect(itemOf(missing, "crm.records").detail).toContain("This does not hold up launch.");
    expect(itemOf(withCrm("verified", { records: { state: "in_place", tags: 3, contactFields: 2, forms: 1 } }), "crm.records")).toMatchObject({ state: "done", required: false });
    expect(itemOf(withCrm("verified", { records: { state: "in_place", tags: 3, contactFields: 2, forms: 1 } }), "crm.records").detail).toContain("3 tags");
    expect(itemOf(withCrm("none", { records: { state: "pending", tags: 0, contactFields: 0, forms: 0 }, pipelineReady: false }), "crm.records").state).toBe("in_progress");
  });
});

describe("an employee whose check failed, and one whose setup is being retried", () => {
  it("shows a failing connection check as action required and iAcquire's, never as being verified, and turns the workspace to action required", () => {
    const f = replaceEmployee(ready(), "sales_assistant", { provisioning: "awaiting_health_check", healthFailed: true, healthDetail: "gateway refused the key", readiness: notReadyEmployee });
    const r = deriveLaunchReadiness(f);
    const i = itemOf(r, "employees.sales_assistant");
    expect(i).toMatchObject({ state: "action_required", owner: "iacquire", required: true });
    expect(i.detail).not.toContain("being verified");
    expect(r.state).toBe("action_required");
    expect(r.blocking.map((b) => b.key)).toContain("employees.sales_assistant");
    // The same failure on an employee whose job already succeeded.
    expect(itemOf(deriveLaunchReadiness(replaceEmployee(ready(), "sales_assistant", { provisioning: "succeeded", healthFailed: true, readiness: notReadyEmployee })), "employees.sales_assistant")).toMatchObject({ state: "action_required", owner: "iacquire" });
  });

  it("keeps an employee that is only waiting for its first check in progress, and a job still running ahead of an old failed check", () => {
    const waiting = deriveLaunchReadiness(replaceEmployee(ready(), "sales_assistant", { provisioning: "awaiting_health_check", healthFailed: false, readiness: notReadyEmployee }));
    expect(itemOf(waiting, "employees.sales_assistant")).toMatchObject({ state: "in_progress", owner: "system" });
    expect(itemOf(waiting, "employees.sales_assistant").detail).toContain("being verified");
    expect(waiting.state).toBe("provisioning");
    // A new profile being built replaces whatever the old one's check said.
    const rebuilding = deriveLaunchReadiness(replaceEmployee(ready(), "sales_assistant", { provisioning: "in_progress", healthFailed: true, readiness: notReadyEmployee }));
    expect(itemOf(rebuilding, "employees.sales_assistant").state).toBe("in_progress");
  });

  it("never shows the raw failure note or the check's own words to the client", () => {
    const f = replaceEmployee(replaceEmployee(ready(), "sales_assistant", { provisioning: "failed", attempts: 3, provisioningDetail: "ssh root@10.0.0.7 timed out", readiness: notReadyEmployee }),
      "crm_manager", { provisioning: "awaiting_health_check", healthFailed: true, healthDetail: "Bearer abc123 rejected by 10.0.0.7", readiness: notReadyEmployee });
    const text = JSON.stringify(deriveLaunchReadiness(f).steps);
    expect(text).not.toContain("10.0.0.7");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("ssh root");
  });

  it("reads 'Attempt n of 3' while a failed attempt is being retried by itself, and does not ask anyone to act", () => {
    const at = (attempts: number) => deriveLaunchReadiness(replaceEmployee(ready(), "lead_hunter", { provisioning: "retrying", attempts, nextRetryAt: "2026-10-26T06:05:00.000Z", readiness: notReadyEmployee }));
    expect(itemOf(at(1), "employees.lead_hunter").detail).toContain("Attempt 2 of 3");
    expect(itemOf(at(2), "employees.lead_hunter").detail).toContain("Attempt 3 of 3");
    expect(itemOf(at(1), "employees.lead_hunter")).toMatchObject({ state: "in_progress", owner: "system" });
    expect(at(1).blocking.map((b) => b.key)).not.toContain("employees.lead_hunter");
  });

  it("calls a profile that used all its attempts failed, owned by iAcquire, and says iAcquire can review and retry it", () => {
    const r = deriveLaunchReadiness(replaceEmployee(ready(), "lead_hunter", { provisioning: "failed", attempts: 3, readiness: notReadyEmployee }));
    const i = itemOf(r, "employees.lead_hunter");
    expect(i).toMatchObject({ state: "failed", owner: "iacquire" });
    expect(i.detail).toContain("3 of 3 attempts used");
    expect(i.detail).toContain("iAcquire can review it and retry");
    expect(r.state).toBe("action_required");
  });
});

describe("a calendar sign-in that comes back to Setup", () => {
  const needing = (videoProviders: Array<"google" | "microsoft"> | undefined) => deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ needsVideoConnection: true, videoProviders }), externalCalendarConnected: false } }));

  it("starts the one provider the appointment types need and returns to Setup", () => {
    expect(itemOf(needing(["google"]), "calendar.connection").action).toEqual({ label: "Connect Google", href: "/api/crm/calendar-oauth/google/start?return=/setup" });
    expect(itemOf(needing(["microsoft"]), "calendar.connection").action).toEqual({ label: "Connect Microsoft", href: "/api/crm/calendar-oauth/microsoft/start?return=/setup" });
  });

  it("offers the connections screen when both providers or none are named", () => {
    expect(itemOf(needing(["google", "microsoft"]), "calendar.connection").action?.href).toBe("/crm/calendar-connections");
    expect(itemOf(needing(undefined), "calendar.connection").action?.href).toBe("/crm/calendar-connections");
  });
});

// ---------------------------------------------------------------------------
// The calendar and host steps, and the questionnaire's host, busy-calendar and own-link answers (B3-P3b)
// ---------------------------------------------------------------------------

const draftWith = (over: Partial<CalendarFacts> = {}) => calendar({ status: "draft", hosts: 0, hostsWithHours: 0, checks: null, ...over });
const withCalendar = (cal: CalendarFacts, extra: Partial<LaunchFacts["appointments"]> = {}, top: Partial<LaunchFacts> = {}) => deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: cal, externalCalendarConnected: false, ...extra }, ...top }));
type CheckKey = "hosts" | "hours" | "timezone" | "types" | "connections" | "slot";
const failing = (...keys: CheckKey[]) =>
  (["hosts", "hours", "timezone", "types", "connections", "slot"] as const).map((key) => ({ key, ok: !keys.includes(key), detail: keys.includes(key) ? `The ${key} check failed.` : "" }));
const person = (userId: string, name: string, over: Partial<HostConnectionFact> = {}): HostConnectionFact => ({ userId, name, viewer: false, meet: { google: false, microsoft: false }, busy: { google: false, microsoft: false }, ...over });
const people = [{ id: "u-1", name: "Dana Reyes" }, { id: "u-2", name: "Marcus Hale" }];
const suggestedHours = { zone: "Asia/Manila", summary: "Mon to Fri, 9:00 AM to 5:00 PM (Asia/Manila time)", digest: "b".repeat(64) };

describe("choosing the host", () => {
  it("offers a select of the people who may host beside 'Make me the host', and picks nobody", () => {
    const r = withCalendar(draftWith({ hostChoices: people, ownerName: "Dana Reyes" }));
    const host = itemOf(r, "calendar.host");
    expect(host).toMatchObject({ state: "action_required", owner: "you", action: { label: "Make me the host", intent: "assign_host" }, hostChoices: people });
    // The button the select drives carries no person: the panel adds the one the client picked, so no default host exists anywhere in the facts.
    expect(host.action?.params).toBeUndefined();
  });

  it("gives a person who may not set up calendars no button and no list, and says who to ask", () => {
    const r = withCalendar(draftWith({ canManage: false, ownerName: "Dana Reyes", hostChoices: people }));
    const host = itemOf(r, "calendar.host");
    expect(host.action).toBeUndefined();
    expect(host.hostChoices).toBeUndefined();
    expect(host.detail).toContain("Ask Dana Reyes");
    const noName = itemOf(withCalendar(draftWith({ canManage: false, ownerName: null })), "calendar.host");
    expect(noName.detail).toContain("Ask a workspace owner");
    // Hours and activation say the same, with no intent button to be refused.
    const hours = withCalendar(calendar({ status: "draft", hosts: 1, hostsWithHours: 0, checks: null, canManage: false, ownerName: "Dana Reyes", suggestedHours }));
    expect(itemOf(hours, "calendar.hours").action).toBeUndefined();
    expect(itemOf(hours, "calendar.hours").detail).toContain("Ask Dana Reyes");
    const activate = withCalendar(calendar({ status: "draft", hosts: 1, hostsWithHours: 1, checks: [], canManage: false, ownerName: "Dana Reyes" }));
    expect(itemOf(activate, "calendar.active").action).toBeUndefined();
    expect(itemOf(activate, "calendar.active").detail).toContain("Ask Dana Reyes");
  });

  it("holds every calendar button until the questionnaire is submitted and the setup payment is confirmed", () => {
    for (const top of [{ paymentCleared: false }, { submitted: false }] as Array<Partial<LaunchFacts>>) {
      const r = withCalendar(draftWith({ hostChoices: people }), {}, top);
      const host = itemOf(r, "calendar.host");
      expect(host.action, JSON.stringify(top)).toBeUndefined();
      expect(host.hostChoices).toBeUndefined();
      expect(host.detail).toMatch(/opens once you have submitted|opens once your setup payment is confirmed/);
      const hours = withCalendar(calendar({ status: "draft", hosts: 1, hostsWithHours: 0, checks: null, hasSuggestedHours: true }), {}, top);
      expect(itemOf(hours, "calendar.hours").action).toBeUndefined();
    }
  });

  it("follows the client's own answer: 'I take them myself' asks for confirmation, and never assigns anyone", () => {
    const host = itemOf(withCalendar(draftWith({ hostChoices: people }), { hostChoice: "owner" }), "calendar.host");
    expect(host).toMatchObject({ state: "action_required", action: { intent: "assign_host" } });
    expect(host.detail).toContain("take these appointments yourself");
  });

  it("follows 'a team member does': invite them, then wait for their acceptance by name, and say who still needs hours", () => {
    const notInvited = itemOf(withCalendar(draftWith({ hostChoices: people }), { hostChoice: "team", teamHosts: [{ name: "Marcus Hale", state: "not_invited" }] }), "calendar.host");
    expect(notInvited).toMatchObject({ state: "action_required", action: { href: "/settings/team" } });
    expect(notInvited.detail).toContain("Invite Marcus Hale");

    const waiting = itemOf(withCalendar(draftWith({ hostChoices: people }), { hostChoice: "team", teamHosts: [{ name: "Marcus Hale", state: "invited" }, { name: "Priya Shah", state: "invited" }] }), "calendar.host");
    expect(waiting.state).toBe("in_progress");
    expect(waiting.detail).toContain("Waiting for Marcus Hale, Priya Shah");
    // Waiting for an invitation does not block by itself: nothing is needed from the client until someone accepts.
    const r = withCalendar(draftWith(), { hostChoice: "team", teamHosts: [{ name: "Marcus Hale", state: "invited" }] });
    expect(r.blocking.map((i) => i.key)).not.toContain("calendar.host");

    const none = itemOf(withCalendar(draftWith(), { hostChoice: "team", teamHosts: [] }), "calendar.host");
    expect(none.detail).toContain("no one is marked as taking them");

    const done = itemOf(withCalendar(calendar({ hosts: 1 }), { hostChoice: "team", teamHosts: [{ name: "Marcus Hale", state: "invited" }] }), "calendar.host");
    expect(done).toMatchObject({ state: "done" });
    expect(done.detail).toContain("Still waiting for Marcus Hale");
  });

  it("names who still needs hours and carries the digest of exactly what was shown", () => {
    const r = withCalendar(calendar({ status: "draft", hosts: 2, hostsWithHours: 0, checks: null, hostsNeedingHours: people, suggestedHours }));
    const hours = itemOf(r, "calendar.hours");
    expect(hours).toMatchObject({ state: "action_required", action: { label: "Approve these hours", intent: "apply_hours", params: { hoursDigest: "b".repeat(64) } } });
    expect(hours.detail).toContain("Dana Reyes, Marcus Hale have no weekly hours yet");
    expect(hours.detail).toContain("Mon to Fri, 9:00 AM to 5:00 PM (Asia/Manila time)");
    expect(hours.detail).toContain("Nothing is saved until you approve");
    // A host who has hours is not named again.
    const one = itemOf(withCalendar(calendar({ status: "draft", hosts: 2, hostsWithHours: 1, checks: null, hostsNeedingHours: [people[1]], suggestedHours })), "calendar.hours");
    expect(one.detail).toContain("Marcus Hale has no weekly hours yet");
    expect(one.detail).not.toContain("Dana Reyes");
  });
});

describe("summarizeWeeklyHours", () => {
  it("reads the weekly hours the client approves, Monday first, joining days that share hours", () => {
    const day = (weekday: number, startMinute: number, endMinute: number) => ({ weekday, startMinute, endMinute });
    expect(summarizeWeeklyHours([1, 2, 3, 4, 5].map((d) => day(d, 540, 1020)))).toBe("Mon to Fri, 9:00 AM to 5:00 PM");
    expect(summarizeWeeklyHours([day(0, 600, 840), day(6, 600, 840), day(1, 540, 720), day(1, 780, 1020)])).toBe("Mon, 9:00 AM to 12:00 PM and 1:00 PM to 5:00 PM; Sat to Sun, 10:00 AM to 2:00 PM");
    expect(summarizeWeeklyHours([day(2, 540, 1020), day(4, 540, 1020)])).toBe("Tue, 9:00 AM to 5:00 PM; Thu, 9:00 AM to 5:00 PM");
    expect(summarizeWeeklyHours([day(3, 720, 1440)])).toBe("Wed, 12:00 PM to midnight");
    expect(summarizeWeeklyHours([])).toBe("");
  });
});

describe("an active calendar is held to every check", () => {
  it("adds one required item for each failing check, never a quiet Done", () => {
    const r = withCalendar(calendar({ checks: failing("timezone", "connections", "hours") }));
    expect(itemOf(r, "calendar.check.timezone")).toMatchObject({ state: "action_required", required: true, detail: "The timezone check failed.", action: { href: "/crm/availability" } });
    expect(itemOf(r, "calendar.check.connections")).toMatchObject({ state: "action_required", required: true, action: { href: "/crm/calendar-connections" } });
    // The counts say every host has hours, but the live check disagrees: the check wins and is named.
    expect(itemOf(r, "calendar.check.hours")).toMatchObject({ state: "action_required", required: true });
    expect(r.blocking.map((i) => i.key)).toEqual(expect.arrayContaining(["calendar.check.timezone", "calendar.check.connections", "calendar.check.hours"]));
    expect(r.state).toBe("action_required");
    expect(r.steps.find((s) => s.key === "calendar")!.state).toBe("action_required");
    // A passing check adds nothing.
    expect(deriveLaunchReadiness(ready()).steps.flatMap((s) => s.items).some((i) => i.key.startsWith("calendar.check."))).toBe(false);
  });

  it("does not say the same thing twice when the item for that subject already says it", () => {
    const r = withCalendar(calendar({ hosts: 0, hostsWithHours: 0, types: 0, checks: failing("hosts", "hours", "types", "slot") }));
    const keys = r.steps.flatMap((s) => s.items).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["calendar.host", "calendar.hours", "calendar.types"]));
    expect(keys.filter((k) => k.startsWith("calendar.check."))).toEqual([]);
    // A connection problem that has its own line (the meeting-tool connection) is not repeated as a generic one.
    const connection = withCalendar(calendar({ needsVideoConnection: true, videoProviders: ["google"], hostConnections: [person("u-1", "Dana Reyes", { viewer: true })], oauthAvailable: { google: true, microsoft: true }, checks: failing("connections") }));
    expect(itemOf(connection, "calendar.connection").state).toBe("action_required");
    expect(connection.steps.flatMap((s) => s.items).some((i) => i.key === "calendar.check.connections")).toBe(false);
  });

  it("shows an active calendar whose only host paused new bookings as failing, not Done", () => {
    const paused = failing("slot").map((c) => (c.key === "slot" ? { ...c, detail: "No time would be offered to a customer in the next 14 days. Every host has paused new bookings." } : c));
    const r = withCalendar(calendar({ checks: paused }));
    expect(itemOf(r, "calendar.verified")).toMatchObject({ state: "failed", required: true });
    expect(itemOf(r, "calendar.verified").detail).toContain("paused new bookings");
    expect(r.steps.find((s) => s.key === "calendar")!.state).toBe("action_required");
    expect(r.state).toBe("action_required");
    expect(r.state).not.toBe("ready_to_launch");
  });

  it("makes every appointment type's open time a required line once a time exists for at least one", () => {
    const some = withCalendar(calendar({ typesWithoutTimes: ["Full-day survey", "Roof inspection"] }));
    expect(itemOf(some, "calendar.type_times")).toMatchObject({ state: "action_required", required: true, action: { href: "/crm/calendars/cal-1" } });
    expect(itemOf(some, "calendar.type_times").detail).toContain("Full-day survey, Roof inspection");
    expect(some.state).toBe("action_required");
    expect(deriveLaunchReadiness(ready()).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.type_times")).toBe(false);
    // When no time at all is found, the line that says so already covers every type.
    const none = withCalendar(calendar({ typesWithoutTimes: ["Full-day survey"], checks: failing("slot") }));
    expect(none.steps.flatMap((s) => s.items).some((i) => i.key === "calendar.type_times")).toBe(false);
  });

  it("fails the public page line, and holds up launch, while the page is on and the calendar fails a check", () => {
    const on = withCalendar(calendar({ bookingPageOn: true, checks: failing("hours") }));
    expect(itemOf(on, "calendar.public")).toMatchObject({ state: "failed", required: true });
    expect(itemOf(on, "calendar.public").detail).toContain("The hours check failed.");
    expect(on.blocking.map((i) => i.key)).toContain("calendar.public");
    // The page off, or every check passing, leaves it an optional line.
    expect(itemOf(withCalendar(calendar({ bookingPageOn: false, checks: failing("hours") })), "calendar.public")).toMatchObject({ state: "done", required: false });
    expect(itemOf(withCalendar(calendar({ bookingPageOn: true })), "calendar.public")).toMatchObject({ state: "done", required: false });
  });
});

describe("a person who may not set up calendars gets no button and a name to ask on every calendar failure", () => {
  const viewer = { canManage: false, ownerName: "Dana Reyes" } as const;

  it("shows the failing active-calendar checks, including the connections check, without a link and with the name to ask", () => {
    const r = withCalendar(calendar({ ...viewer, checks: failing("timezone", "connections", "hours", "types") }));
    for (const key of ["timezone", "connections", "hours", "types"]) {
      const line = itemOf(r, `calendar.check.${key}`);
      expect(line.action, key).toBeUndefined();
      expect(line.detail, key).toContain("Ask Dana Reyes");
    }
    // The same failures for a manager keep their links and add no name to ask.
    const manager = withCalendar(calendar({ checks: failing("connections") }));
    expect(itemOf(manager, "calendar.check.connections")).toMatchObject({ action: { href: "/crm/calendar-connections" } });
    expect(itemOf(manager, "calendar.check.connections").detail).not.toContain("Ask");
  });

  it("does the same for the draft calendar's open-time check and for a public page that is on while a check fails", () => {
    const draft = withCalendar(calendar({ ...viewer, status: "draft", hosts: 1, hostsWithHours: 1, types: 1, checks: failing("timezone") }));
    expect(itemOf(draft, "calendar.verified").action).toBeUndefined();
    expect(itemOf(draft, "calendar.verified").detail).toContain("Ask Dana Reyes");
    const connections = withCalendar(calendar({ ...viewer, status: "draft", hosts: 1, hostsWithHours: 1, types: 1, checks: failing("connections") }));
    expect(itemOf(connections, "calendar.verified").action).toBeUndefined();
    const on = withCalendar(calendar({ ...viewer, bookingPageOn: true, checks: failing("hours") }));
    expect(itemOf(on, "calendar.public")).toMatchObject({ state: "failed", required: true });
    expect(itemOf(on, "calendar.public").action).toBeUndefined();
    expect(itemOf(on, "calendar.public").detail).toContain("Ask Dana Reyes");
    // A manager still gets the link in all three places.
    const manager = withCalendar(calendar({ status: "draft", hosts: 1, hostsWithHours: 1, types: 1, checks: failing("timezone") }));
    expect(itemOf(manager, "calendar.verified").action?.href).toBe("/crm/availability");
    expect(itemOf(withCalendar(calendar({ bookingPageOn: true, checks: failing("hours") })), "calendar.public").action?.href).toBe("/crm/calendars/cal-1");
  });
});

describe("what each host has connected", () => {
  const needing = (hosts: HostConnectionFact[], over: Partial<CalendarFacts> = {}) => withCalendar(calendar({ needsVideoConnection: true, videoProviders: ["google"], hostConnections: hosts, oauthAvailable: { google: true, microsoft: true }, ...over }));

  it("is satisfied only by that host's own account that can add events: another person's account does not count", () => {
    const dana = person("u-1", "Dana Reyes", { viewer: true });
    const marcus = person("u-2", "Marcus Hale", { meet: { google: true, microsoft: false } });
    const r = needing([dana, marcus]);
    expect(itemOf(r, "calendar.connection")).toMatchObject({ state: "action_required", owner: "you", action: { label: "Connect Google", href: "/api/crm/calendar-oauth/google/start?return=/setup" } });
    expect(itemOf(r, "calendar.connection").detail).toContain("Dana Reyes has not connected");
    expect(itemOf(r, "calendar.connection").detail).not.toContain("Marcus Hale");
    // Everyone connected: nothing is asked.
    expect(needing([{ ...dana, meet: { google: true, microsoft: false } }, marcus]).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.connection")).toBe(false);
  });

  it("tells a person who is not the missing host to ask them, because only a person can connect their own account", () => {
    const r = needing([person("u-1", "Dana Reyes"), person("u-2", "Marcus Hale", { viewer: true, meet: { google: true, microsoft: false } })]);
    const i = itemOf(r, "calendar.connection");
    expect(i.action).toBeUndefined();
    expect(i.detail).toContain("Dana Reyes has not connected");
    expect(i.detail).toContain("connects their own account");
  });

  it("says plainly when Google sign-in is not switched on, and gives no button that goes nowhere", () => {
    const r = needing([person("u-1", "Dana Reyes", { viewer: true })], { oauthAvailable: { google: false, microsoft: true } });
    expect(itemOf(r, "calendar.connection")).toMatchObject({ state: "action_required", owner: "iacquire" });
    expect(itemOf(r, "calendar.connection").action).toBeUndefined();
    expect(itemOf(r, "calendar.connection").detail).toContain("Google sign-in is not switched on");
  });

  it("waits for a host before asking anyone to connect, and keeps the older facts working", () => {
    expect(itemOf(needing([]), "calendar.connection")).toMatchObject({ state: "in_progress" });
    // Facts that cannot say per host fall back to 'is anything connected', exactly as before.
    const legacy = withCalendar(calendar({ needsVideoConnection: true, videoProviders: ["google"] }), { externalCalendarConnected: true });
    expect(legacy.steps.flatMap((s) => s.items).some((i) => i.key === "calendar.connection")).toBe(false);
  });

  it("requires the busy calendar only when the client said google or microsoft, and 'none' is not required", () => {
    const hosts = [person("u-1", "Dana Reyes", { viewer: true })];
    const oauth = { google: true, microsoft: true };
    const google = withCalendar(calendar({ busyProvider: "google", hostConnections: hosts, oauthAvailable: oauth }));
    expect(itemOf(google, "calendar.busy")).toMatchObject({ state: "action_required", required: true, owner: "you", action: { label: "Connect Google", href: "/api/crm/calendar-oauth/google/start?return=/setup" } });
    expect(itemOf(google, "calendar.busy").detail).toContain("Google Calendar");
    const microsoft = withCalendar(calendar({ busyProvider: "microsoft", hostConnections: hosts, oauthAvailable: oauth }));
    expect(itemOf(microsoft, "calendar.busy").action?.href).toBe("/api/crm/calendar-oauth/microsoft/start?return=/setup");
    // A host whose calendar is being read for busy times satisfies it.
    const read = withCalendar(calendar({ busyProvider: "google", hostConnections: [person("u-1", "Dana Reyes", { busy: { google: true, microsoft: false } })] }));
    expect(itemOf(read, "calendar.busy")).toMatchObject({ state: "done", required: true });
    // None: shown as not applicable, never counted. Not said: no line at all.
    const none = withCalendar(calendar({ busyProvider: "none", hostConnections: hosts }));
    expect(itemOf(none, "calendar.busy")).toMatchObject({ state: "not_applicable", required: false });
    expect(none.state).toBe("ready_to_launch");
    expect(withCalendar(calendar({ busyProvider: null, hostConnections: hosts })).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.busy")).toBe(false);
    // A provider that is not set up is iAcquire's to fix, and the busy line never offers a dead button.
    const dead = withCalendar(calendar({ busyProvider: "google", hostConnections: hosts, oauthAvailable: { google: false, microsoft: true } }));
    expect(itemOf(dead, "calendar.busy")).toMatchObject({ owner: "iacquire" });
    expect(itemOf(dead, "calendar.busy").action).toBeUndefined();
  });

  it("requires a way to join when a video appointment has no meeting tool and no words, and not otherwise", () => {
    const r = withCalendar(calendar({ typesWithoutJoinInfo: ["Video estimate"] }));
    expect(itemOf(r, "calendar.own_link")).toMatchObject({ state: "action_required", required: true, action: { href: "/crm/calendars/cal-1" } });
    expect(itemOf(r, "calendar.own_link").detail).toContain("Video estimate is a video appointment");
    expect(r.state).toBe("action_required");
    expect(withCalendar(calendar({ typesWithoutJoinInfo: [] })).steps.flatMap((s) => s.items).some((i) => i.key === "calendar.own_link")).toBe(false);
  });
});

describe("the Appointment Setter's check waits for the calendar", () => {
  it("is in progress, and never a button, while the booking calendar is a draft", () => {
    const r = withCalendar(draftWith());
    expect(itemOf(r, "verification.appointment_setter")).toMatchObject({ state: "in_progress", owner: "you", detail: expect.stringContaining("calendar is active") });
    expect(itemOf(r, "verification.appointment_setter").action).toBeUndefined();
    // Once the calendar is active it is judged like the others.
    expect(itemOf(deriveLaunchReadiness(ready()), "verification.appointment_setter").state).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Time: an item in progress for too long is somebody's to look at
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-26T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const provisioningReadiness = { state: "provisioning" as const, chatAvailable: false, workReady: false, description: "", blocking: [] };
const provisioningLead = (over: Partial<EmployeeFact>) => replaceEmployee(ready(), "lead_hunter", { provisioning: "in_progress", readiness: provisioningReadiness, ...over });

describe("a stuck item stops reading as 'nothing is needed from you'", () => {
  it("keeps a young in-progress profile in progress and flips an old one to action required for iAcquire, using the clock the caller passed", () => {
    const young = deriveLaunchReadiness(provisioningLead({ startedAt: ago(STALL_MINUTES.provisioning - 1) }), NOW);
    expect(itemOf(young, "employees.lead_hunter")).toMatchObject({ state: "in_progress", owner: "system" });
    expect(itemOf(young, "employees.lead_hunter").stalled).toBeUndefined();
    expect(young.state).toBe("provisioning");

    const old = deriveLaunchReadiness(provisioningLead({ startedAt: ago(STALL_MINUTES.provisioning + 1) }), NOW);
    expect(itemOf(old, "employees.lead_hunter")).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true, stalledSince: ago(STALL_MINUTES.provisioning + 1) });
    expect(old.state).toBe("action_required");
    expect(old.blocking.map((i) => i.key)).toEqual(["employees.lead_hunter"]);
    expect(old.detail).toContain("1 needs iAcquire's attention");
    expect(old.percent).toBeLessThan(100);
    // Nothing is said about how long without a clock: the pure read of the facts says only what they say.
    expect(itemOf(deriveLaunchReadiness(provisioningLead({ startedAt: ago(500) })), "employees.lead_hunter")).toMatchObject({ state: "in_progress" });
  });

  it("says 'iAcquire has been alerted' only when an alert was really recorded", () => {
    const notTold = deriveLaunchReadiness(provisioningLead({ startedAt: ago(45) }), NOW);
    expect(itemOf(notTold, "employees.lead_hunter").detail).not.toContain("has been alerted");
    expect(itemOf(notTold, "employees.lead_hunter").detail).toContain("waiting on iAcquire");
    expect(itemOf(notTold, "employees.lead_hunter").detail).toContain("about 45 minutes");
    const told = deriveLaunchReadiness(provisioningLead({ startedAt: ago(45), stallAlerted: true }), NOW);
    expect(itemOf(told, "employees.lead_hunter").detail).toContain("iAcquire has been alerted.");
    // A worker that stopped reporting is named; a live one is not.
    expect(itemOf(deriveLaunchReadiness(provisioningLead({ startedAt: ago(45), leaseExpired: true }), NOW), "employees.lead_hunter").detail).toContain("Nothing is working on it right now");
    expect(itemOf(notTold, "employees.lead_hunter").detail).not.toContain("Nothing is working on it");
  });

  it("uses the threshold the server read for provisioning, and keeps the fixed ones for the others", () => {
    const f = provisioningLead({ startedAt: ago(100) });
    expect(itemOf(deriveLaunchReadiness(f, NOW, { provisioning: 120 }), "employees.lead_hunter").state).toBe("in_progress");
    expect(itemOf(deriveLaunchReadiness(f, NOW, { provisioning: 90 }), "employees.lead_hunter").state).toBe("action_required");
    expect(STALL_MINUTES).toEqual({ provisioning: 30, verification: 15, crm: 60 });
  });

  it("stalls only a job somebody is on: a profile that was never started or was cancelled is not stalled, whatever its age", () => {
    for (const provisioning of ["none", "cancelled"] as const) {
      const r = deriveLaunchReadiness(provisioningLead({ provisioning, startedAt: ago(5000) }), NOW);
      expect(itemOf(r, "employees.lead_hunter"), provisioning).toMatchObject({ state: "in_progress" });
    }
    for (const provisioning of ["requested", "awaiting_health_check", "retrying"] as const) {
      const r = deriveLaunchReadiness(provisioningLead({ provisioning, startedAt: ago(300) }), NOW);
      expect(itemOf(r, "employees.lead_hunter"), provisioning).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });
    }
    // A finished employee never stalls, however old its job.
    expect(deriveLaunchReadiness(replaceEmployee(ready(), "lead_hunter", { provisioning: "succeeded", startedAt: ago(9000) }), NOW).state).toBe("ready_to_launch");
  });

  it("stalls a final check that runs too long, and only that check", () => {
    const verification = (since: string, over: Record<string, unknown> = {}): VerificationFact[] => AGENT_ROLE_KEYS.map((role) => (role === "crm_manager" ? ({ role, state: "running", since, ...over } as VerificationFact) : passed(role)));
    const young = deriveLaunchReadiness(ready({ verification: verification(ago(STALL_MINUTES.verification - 1)) }), NOW);
    expect(itemOf(young, "verification.crm_manager")).toMatchObject({ state: "in_progress", owner: "system" });
    const old = deriveLaunchReadiness(ready({ verification: verification(ago(STALL_MINUTES.verification + 1), { leaseExpired: true }) }), NOW);
    expect(itemOf(old, "verification.crm_manager")).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });
    expect(itemOf(old, "verification.crm_manager").detail).toContain("Nothing is running it right now");
    expect(itemOf(old, "verification.crm_manager").detail).not.toContain("has been alerted");
    expect(old.blocking.map((i) => i.key)).toEqual(["verification.crm_manager"]);
    expect(itemOf(deriveLaunchReadiness(ready({ verification: verification(ago(60), { alerted: true }) }), NOW), "verification.crm_manager").detail).toContain("iAcquire has been alerted.");
    // A running check without a start time is never called stalled.
    const noStart: VerificationFact[] = AGENT_ROLE_KEYS.map((role) => (role === "crm_manager" ? { role, state: "running" } : passed(role)));
    expect(itemOf(deriveLaunchReadiness(ready({ verification: noStart }), NOW), "verification.crm_manager").state).toBe("in_progress");
  });

  it("stalls an industry CRM setup that nobody has started, but never one that already ran", () => {
    const crm = (over: Partial<LaunchFacts["crm"]>) => ready({ crm: { mode: "native", blueprint: "none", pipelineReady: true, providerConnected: false, ...over } });
    expect(itemOf(deriveLaunchReadiness(crm({ waitingSince: ago(STALL_MINUTES.crm - 1) }), NOW), "crm.blueprint")).toMatchObject({ state: "in_progress" });
    const old = deriveLaunchReadiness(crm({ waitingSince: ago(STALL_MINUTES.crm + 1), waitingAlerted: true }), NOW);
    expect(itemOf(old, "crm.blueprint")).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });
    expect(itemOf(old, "crm.blueprint").detail).toContain("iAcquire has been alerted.");
    expect(itemOf(deriveLaunchReadiness(crm({ blueprint: "verified", waitingSince: ago(900) }), NOW), "crm.blueprint")).toMatchObject({ state: "done" });
    expect(itemOf(deriveLaunchReadiness(crm({ blueprint: "failed", waitingSince: ago(900) }), NOW), "crm.blueprint").stalled).toBeUndefined();
  });

  it("does not call the industry CRM setup late while the client has not submitted or the setup fee is not cleared: iAcquire is not what is being waited for", () => {
    const crm = (over: Partial<LaunchFacts> = {}) => ready({ crm: { mode: "native", blueprint: "none", pipelineReady: true, providerConnected: false, waitingSince: ago(STALL_MINUTES.crm + 120) }, ...over });
    // The control: submitted and cleared, the same old wait is stalled.
    expect(itemOf(deriveLaunchReadiness(crm(), NOW), "crm.blueprint")).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });
    // Not cleared (unpaid or refunded) or not submitted: the same wait is not late, and nothing says "waiting on iAcquire".
    for (const over of [{ paymentCleared: false }, { submitted: false }] as Array<Partial<LaunchFacts>>) {
      const item = itemOf(deriveLaunchReadiness(crm(over), NOW), "crm.blueprint");
      expect(item.stalled, JSON.stringify(over)).toBeUndefined();
      expect(item.state, JSON.stringify(over)).toBe("in_progress");
    }
    // A sample workspace has no setup fee to wait for (null: not asked): that alone does not hold the wait back.
    expect(itemOf(deriveLaunchReadiness(crm({ paymentCleared: null }), NOW), "crm.blueprint").stalled).toBe(true);
  });

  it("maps a check held for approval to waiting for review, which is ready for review and not provisioning", () => {
    const held = ready({ verification: AGENT_ROLE_KEYS.map((role) => (role === "sales_assistant" ? { role, state: "awaiting_review" as const } : passed(role))) });
    const r = deriveLaunchReadiness(held, NOW);
    expect(itemOf(r, "verification.sales_assistant")).toMatchObject({ state: "awaiting_review", owner: "iacquire", required: true });
    expect(r.state).toBe("ready_for_review");
    expect(r.percent).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Edits nobody approved
// ---------------------------------------------------------------------------

describe("answer edits that nobody approved block 100%", () => {
  it("adds a required item for the client, and leaves 100% impossible until it clears", () => {
    const clean = deriveLaunchReadiness(ready());
    expect(clean.state).toBe("ready_to_launch");
    expect(clean.steps.flatMap((s) => s.items).some((i) => i.key === "profile.pending_changes")).toBe(false);

    const pending = deriveLaunchReadiness(ready({ pendingAnswerChanges: true }));
    expect(itemOf(pending, "profile.pending_changes")).toMatchObject({ state: "action_required", required: true, owner: "you", action: { href: "/onboarding" } });
    expect(itemOf(pending, "profile.pending_changes").detail).toContain("Your AI team still runs on the previous setup");
    expect(pending.state).toBe("action_required");
    expect(pending.percent).toBeLessThan(100);
    expect(pending.total).toBe(clean.total + 1);
    expect(pending.blocking.map((i) => i.key)).toEqual(["profile.pending_changes"]);
    expect(pending.steps.find((s) => s.key === "profile")!.state).toBe("action_required");
    expect(deriveLaunchReadiness(ready({ pendingAnswerChanges: false })).state).toBe("ready_to_launch");
  });
});

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

describe("the fingerprint says 'something changed', and only that", () => {
  it("is the same for the same facts and for different wording, and different when who has to move or what is done changes", () => {
    const base = fingerprintOf(deriveLaunchReadiness(ready()));
    expect(fingerprintOf(deriveLaunchReadiness(ready()))).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{14}$/);
    // More approved sections changes the words of the knowledge line, not what is done.
    expect(fingerprintOf(deriveLaunchReadiness(ready({ knowledge: { approved: 9, pending: 0 } })))).toBe(base);
    // An optional line (the public booking page being on) is not a required check.
    expect(fingerprintOf(deriveLaunchReadiness(ready({ appointments: { wanted: true, calendar: calendar({ bookingPageOn: true }), externalCalendarConnected: false } })))).toBe(base);
    // A different item state, a different owner and a different overall state are each a different fingerprint.
    const seen = new Set([
      base,
      fingerprintOf(deriveLaunchReadiness(ready({ knowledge: { approved: 0, pending: 0 } }))),
      fingerprintOf(deriveLaunchReadiness(ready({ knowledge: { approved: 0, pending: 2 } }))),
      fingerprintOf(deriveLaunchReadiness(ready({ pendingAnswerChanges: true }))),
      fingerprintOf(deriveLaunchReadiness(ready({ paymentCleared: false }))),
      fingerprintOf(deriveLaunchReadiness(replaceEmployee(ready(), "lead_hunter", { provisioning: "failed", readiness: provisioningReadiness }))),
      fingerprintOf(deriveLaunchReadiness(provisioningLead({ startedAt: ago(5) }), NOW)),
      fingerprintOf(deriveLaunchReadiness(provisioningLead({ startedAt: ago(500) }), NOW)),
    ]);
    expect(seen.size).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Round B: intents, informational items, the capacity hold, the employees' path and the customer-facing switches
// ---------------------------------------------------------------------------

const everyItem = (r: ReturnType<typeof deriveLaunchReadiness>) => r.steps.flatMap((s) => s.items);
const NOT_READY = { state: "provisioning" as const, chatAvailable: false, workReady: false, description: "", blocking: [] as string[] };
const STEP = (connection: string, inventory: string, requirements = "upcoming", last = "upcoming") => [
  { key: "configuration", state: "done" as const }, { key: "connection", state: connection as "done" }, { key: "inventory", state: inventory as "done" }, { key: "requirements", state: requirements as "done" }, { key: "ready", state: last as "done" },
];

describe("the intents a button can run", () => {
  it("lists every step, and every intent an item can offer is one of them", () => {
    expect([...LAUNCH_INTENTS].sort()).toEqual(["activate_calendar", "apply_hours", "apply_pipeline_stages", "assign_host", "confirm_region_defaults", "retry_crm_setup", "run_checks", "send_team_invitations", "sync_employees"]);
    const offering = ready({
      team: { listed: 2, members: 0, pending: 0, toInviteNames: ["Ana", "Ben"], canManage: true },
      crm: { ...ready().crm, region: { state: "offer", currency: "PHP", callingCode: "63", country: "the Philippines" }, pipelineDraft: { state: "offer", stages: ["Enquiry", "Quote"], makesDefault: true } },
    });
    const intents = everyItem(deriveLaunchReadiness(offering)).flatMap((i) => (i.action?.intent ? [i.action.intent] : []));
    expect(intents.sort()).toEqual(["apply_pipeline_stages", "confirm_region_defaults", "send_team_invitations"]);
    for (const intent of intents) expect(LAUNCH_INTENTS).toContain(intent);
  });

  it("tells a step that runs here from a link to another screen", () => {
    expect(actionKind({ intent: "run_checks" })).toBe("internal");
    expect(actionKind({})).toBe("external");
    expect(actionKind({ intent: "run_checks", kind: "external" })).toBe("external");
  });
});

describe("the team the client listed", () => {
  const listed = (over: Partial<NonNullable<LaunchFacts["team"]>> = {}) => ready({ team: { listed: 2, members: 0, pending: 0, toInviteNames: ["Ana Cruz", "Ben Lee"], canManage: true, ...over } });

  it("shows nothing when nobody was listed, and never counts towards the percentage when somebody was", () => {
    const none = deriveLaunchReadiness(ready());
    expect(everyItem(none).some((i) => i.key === "knowledge.team")).toBe(false);
    expect(everyItem(deriveLaunchReadiness(ready({ team: { listed: 0, members: 0, pending: 0, toInviteNames: [] } }))).some((i) => i.key === "knowledge.team")).toBe(false);
    const open = deriveLaunchReadiness(listed());
    const item = itemOf(open, "knowledge.team");
    expect(item).toMatchObject({ state: "action_required", required: false, owner: "you", action: { label: "Send 2 invitations", intent: "send_team_invitations" } });
    expect(item.detail).toContain("Ana Cruz");
    expect(item.detail).toContain("pressing this emails");
    expect(item.detail).toContain("and only then");
    expect([open.state, open.percent, open.passed, open.total]).toEqual([none.state, none.percent, none.passed, none.total]);
    expect(open.blocking).toEqual([]);
  });

  it("offers a button only to a person who may invite, and words the single case in the singular", () => {
    expect(itemOf(deriveLaunchReadiness(listed({ canManage: false })), "knowledge.team").action).toBeUndefined();
    expect(itemOf(deriveLaunchReadiness(listed({ canManage: false })), "knowledge.team").detail).toContain("Only an owner or admin");
    expect(itemOf(deriveLaunchReadiness(listed({ toInviteNames: ["Ana Cruz"], listed: 1 })), "knowledge.team").action?.label).toBe("Send 1 invitation");
  });

  it("names each address and role the button emails, and counts only the people this viewer may invite", () => {
    const people = [
      { name: "Ana Cruz", email: "ana@client.example", role: "sales_rep" as const },
      { name: "Ben Lee", email: "ben@client.example", role: "admin" as const },
    ];
    const all = itemOf(deriveLaunchReadiness(listed({ invitable: people })), "knowledge.team");
    expect(all.action?.label).toBe("Send 2 invitations");
    expect(all.detail).toContain("Ana Cruz, ana@client.example, as Sales Representative");
    expect(all.detail).toContain("Ben Lee, ben@client.example, as Manager");
    // Someone whose listed role the viewer cannot grant is not counted and not emailed: the count is what the button sends.
    const some = itemOf(deriveLaunchReadiness(listed({ invitable: [people[0]] })), "knowledge.team");
    expect(some.action?.label).toBe("Send 1 invitation");
    expect(some.detail).toContain("ana@client.example");
    expect(some.detail).not.toContain("ben@client.example");
    expect(some.detail).toContain("1 more person is listed with access you cannot give");
    // Nobody the viewer may invite: no button at all, and no address shown.
    const none = itemOf(deriveLaunchReadiness(listed({ invitable: [] })), "knowledge.team");
    expect(none.action).toBeUndefined();
    expect(none.detail).toContain("an owner has to send these invitations");
    // A read with no viewer (no addresses): names only, as before.
    expect(itemOf(deriveLaunchReadiness(listed()), "knowledge.team").detail).not.toContain("@");
  });

  it("reads waiting while invitations are open, and done once everyone joined", () => {
    expect(itemOf(deriveLaunchReadiness(listed({ toInviteNames: [], pending: 2 })), "knowledge.team")).toMatchObject({ state: "in_progress", required: false });
    const joined = itemOf(deriveLaunchReadiness(listed({ toInviteNames: [], members: 2 })), "knowledge.team");
    expect(joined).toMatchObject({ state: "done", required: false });
    expect(joined.action).toBeUndefined();
  });

  it("never lets an optional in-progress item turn a ready client into provisioning", () => {
    expect(deriveLaunchReadiness(listed({ toInviteNames: [], pending: 2 })).state).toBe("ready_to_launch");
  });
});

describe("a person to take over customer conversations", () => {
  it("is not applicable until a customer channel is wanted, and then reads the staff profiles", () => {
    const noChannel = ready({ channels: [{ channel: "email", wanted: false, enabled: false, registration: "not_started" }], handoff: { ownerHasNotifyChannel: false, eligibleStaff: 0 } });
    expect(itemOf(deriveLaunchReadiness(noChannel), "knowledge.handoff")).toMatchObject({ state: "not_applicable", required: false });
    const covered = itemOf(deriveLaunchReadiness(ready({ handoff: { ownerHasNotifyChannel: true, eligibleStaff: 2 } })), "knowledge.handoff");
    expect(covered).toMatchObject({ state: "done", required: false });
    expect(covered.detail).toContain("2 people are set up");
    const nobody = deriveLaunchReadiness(ready({ handoff: { ownerHasNotifyChannel: false, eligibleStaff: 0 } }));
    expect(itemOf(nobody, "knowledge.handoff")).toMatchObject({ state: "action_required", required: false, action: { href: "/settings/escalations" } });
    // Informational: the same percentage and the same state as a client with someone set up.
    const fine = deriveLaunchReadiness(ready({ handoff: { ownerHasNotifyChannel: true, eligibleStaff: 1 } }));
    expect([nobody.state, nobody.percent, nobody.total]).toEqual([fine.state, fine.percent, fine.total]);
    expect(nobody.blocking).toEqual([]);
  });

  it("says nothing when the facts did not read it", () => {
    expect(everyItem(deriveLaunchReadiness(ready())).some((i) => i.key === "knowledge.handoff")).toBe(false);
  });
});

describe("currency, phone country and the client's own pipeline stages", () => {
  const region = { state: "offer" as const, currency: "PHP", callingCode: "63", country: "the Philippines" };
  const draft = { state: "offer" as const, stages: ["Enquiry", "Site visit", "Quote"], makesDefault: true };

  it("offers each one as an optional step the client confirms, with the exact values in the words", () => {
    const r = deriveLaunchReadiness(ready({ crm: { ...ready().crm, region, pipelineDraft: draft } }));
    expect(itemOf(r, "crm.region")).toMatchObject({ state: "action_required", required: false, owner: "you", action: { label: "Use PHP and +63", intent: "confirm_region_defaults" } });
    expect(itemOf(r, "crm.region").detail).toContain("Nothing changes until you confirm");
    expect(itemOf(r, "crm.stages")).toMatchObject({ state: "action_required", required: false, owner: "you", action: { intent: "apply_pipeline_stages" } });
    expect(itemOf(r, "crm.stages").detail).toContain("Enquiry, Site visit, Quote");
    expect(itemOf(r, "crm.stages").detail).toContain("never edited or deleted");
    expect(r.state).toBe("ready_to_launch");
    expect(r.percent).toBe(100);
  });

  it("reads done once it is in place, and offers no button to a person who may not", () => {
    const r = deriveLaunchReadiness(ready({ crm: { ...ready().crm, region: { ...region, state: "matches" }, pipelineDraft: { state: "applied", stages: [] } } }));
    expect(itemOf(r, "crm.region")).toMatchObject({ state: "done", required: false });
    expect(itemOf(r, "crm.stages")).toMatchObject({ state: "done", required: false });
    expect(itemOf(r, "crm.region").action).toBeUndefined();
    const limited = deriveLaunchReadiness(ready({ crm: { ...ready().crm, region: { ...region, canConfirm: false }, pipelineDraft: { ...draft, canApply: false } } }));
    expect(itemOf(limited, "crm.region").action).toBeUndefined();
    expect(itemOf(limited, "crm.stages").action).toBeUndefined();
  });

  it("is left out of a CRM another system keeps", () => {
    const r = deriveLaunchReadiness(ready({ crm: { mode: "ghl", blueprint: "none", pipelineReady: false, providerConnected: true, region, pipelineDraft: draft } }));
    expect(everyItem(r).some((i) => i.key === "crm.region" || i.key === "crm.stages")).toBe(false);
  });
});

describe("asking the automatic CRM setup to run again", () => {
  const failed = (over: Partial<LaunchFacts["crm"]> = {}) => ready({ crm: { ...ready().crm, blueprint: "failed", pipelineReady: false, records: { state: "pending", tags: 0, contactFields: 0, forms: 0 }, ...over } });

  it("is offered on a failed setup only to a person who may ask, and the item stays iAcquire's", () => {
    expect(itemOf(deriveLaunchReadiness(failed({ canRetry: true })), "crm.blueprint")).toMatchObject({ state: "action_required", owner: "iacquire", action: { label: "Try the setup again", intent: "retry_crm_setup" } });
    expect(itemOf(deriveLaunchReadiness(failed()), "crm.blueprint").action).toBeUndefined();
  });

  it("is offered on a setup that has waited too long, and not on one that is still young or waiting for a person", () => {
    const waiting = (since: string, over: Partial<LaunchFacts["crm"]> = {}) => ready({ crm: { ...ready().crm, blueprint: "none", pipelineReady: false, records: { state: "pending", tags: 0, contactFields: 0, forms: 0 }, waitingSince: since, canRetry: true, ...over } });
    const now = new Date("2026-10-26T12:00:00Z");
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
    const old = itemOf(deriveLaunchReadiness(waiting(minutesAgo(STALL_MINUTES.crm + 5)), now), "crm.blueprint");
    expect(old).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true, action: { intent: "retry_crm_setup" } });
    const young = itemOf(deriveLaunchReadiness(waiting(minutesAgo(5)), now), "crm.blueprint");
    expect(young).toMatchObject({ state: "in_progress" });
    expect(young.action).toBeUndefined();
    expect(itemOf(deriveLaunchReadiness(failed({ blueprint: "waiting_for_a_person", canRetry: true })), "crm.blueprint").action).toBeUndefined();
  });
});

describe("waiting for room on the client runtime", () => {
  const held = (over: Partial<EmployeeFact> = {}) => replaceEmployee(ready(), "lead_hunter", {
    provisioning: "requested", configVersion: null, readiness: NOT_READY, capacityHeld: true, startedAt: "2026-10-26T11:50:00.000Z", ...over,
  });
  const now = new Date("2026-10-26T12:00:00Z");

  it("says Waiting for capacity, is iAcquire's, and is neither failed nor ready", () => {
    const r = deriveLaunchReadiness(held(), now);
    const i = itemOf(r, "employees.lead_hunter");
    expect(i).toMatchObject({ state: "in_progress", owner: "iacquire", required: true });
    expect(i.detail).toContain("Waiting for capacity (iAcquire)");
    expect(i.detail).toContain("Nothing has failed");
    expect(r.state).toBe("provisioning");
    expect(r.percent).toBeLessThan(100);
    expect(r.blocking).toEqual([]);
    expect(itemOf(r, "employees.lead_hunter").state).not.toBe("done");
  });

  it("is still a hold when the worker answered no room (a failed attempt), never a failure", () => {
    const r = deriveLaunchReadiness(held({ provisioning: "failed", provisioningDetail: "capacity_exceeded", attempts: 3 }), now);
    expect(itemOf(r, "employees.lead_hunter")).toMatchObject({ state: "in_progress", owner: "iacquire" });
    expect(itemOf(r, "employees.lead_hunter").detail).toContain("Waiting for capacity");
  });

  it("does not hide a long hold: after the threshold it is iAcquire's to look at, in words about room", () => {
    const r = deriveLaunchReadiness(held({ startedAt: new Date(now.getTime() - (STALL_MINUTES.provisioning + 10) * 60_000).toISOString() }), now);
    const i = itemOf(r, "employees.lead_hunter");
    expect(i).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });
    expect(i.detail).toContain("Waiting for room");
    expect(r.state).toBe("action_required");
  });

  it("is only a hold while the facts say so: a queued job without the flag is the ordinary queue", () => {
    const i = itemOf(deriveLaunchReadiness(held({ capacityHeld: false }), now), "employees.lead_hunter");
    expect(i.detail).not.toContain("capacity");
    expect(i.owner).toBe("system");
  });
});

describe("each employee's path", () => {
  const stagesOf = (e: EmployeeFact, f: LaunchFacts = ready()) => itemOf(deriveLaunchReadiness(replaceEmployee(f, e.role, e)), `employees.${e.role}`).stages;
  const states = (e: EmployeeFact) => stagesOf(e)?.map((s) => `${s.key}:${s.state}`);
  const base = employee("lead_hunter");

  it("shows a ready employee as done at every stage, with text labels", () => {
    const s = stagesOf({ ...base, provisioning: "succeeded" })!;
    expect(s.map((x) => x.key)).toEqual(["queued", "profile", "verified", "tools", "ready"]);
    expect(s.every((x) => x.state === "done")).toBe(true);
    expect(s.map((x) => x.label)).toEqual(["Queued", "Profile created", "Connection verified", "Tools verified", "Ready for work"]);
  });

  it("does not call a queued job a created profile", () => {
    const queued = states({ ...base, provisioning: "requested", configVersion: null, readiness: NOT_READY, readinessSteps: STEP("upcoming", "upcoming") });
    expect(queued).toEqual(["queued:done", "profile:pending", "verified:pending", "tools:pending", "ready:pending"]);
    const creating = states({ ...base, provisioning: "in_progress", configVersion: null, readiness: NOT_READY, readinessSteps: STEP("upcoming", "upcoming") });
    expect(creating).toEqual(["queued:done", "profile:in_progress", "verified:pending", "tools:pending", "ready:pending"]);
  });

  it("moves one stage at a time as the stored facts arrive", () => {
    const profile = states({ ...base, provisioning: "awaiting_health_check", configVersion: null, readiness: NOT_READY, readinessSteps: STEP("current", "upcoming") });
    expect(profile).toEqual(["queued:done", "profile:done", "verified:in_progress", "tools:pending", "ready:pending"]);
    const verified = states({ ...base, provisioning: "succeeded", readiness: NOT_READY, readinessSteps: STEP("done", "current") });
    expect(verified).toEqual(["queued:done", "profile:done", "verified:done", "tools:in_progress", "ready:pending"]);
    const waitingOnRole = states({ ...base, provisioning: "succeeded", readiness: { state: "ready", chatAvailable: true, workReady: false, description: "", blocking: ["Approved knowledge"] }, readinessSteps: STEP("done", "done", "current") });
    expect(waitingOnRole).toEqual(["queued:done", "profile:done", "verified:done", "tools:done", "ready:action_required"]);
  });

  it("marks the stage that failed, and nothing after it as reached", () => {
    expect(states({ ...base, provisioning: "failed", attempts: 3, configVersion: null, readiness: NOT_READY, readinessSteps: STEP("upcoming", "upcoming") })).toEqual(["queued:done", "profile:failed", "verified:pending", "tools:pending", "ready:pending"]);
    expect(states({ ...base, provisioning: "awaiting_health_check", healthFailed: true, configVersion: null, readiness: NOT_READY, readinessSteps: STEP("blocked", "upcoming") })).toEqual(["queued:done", "profile:done", "verified:failed", "tools:pending", "ready:pending"]);
  });

  it("reads a capacity hold as a queued job whose profile has not begun", () => {
    expect(states({ ...base, provisioning: "requested", configVersion: null, readiness: NOT_READY, capacityHeld: true })).toEqual(["queued:done", "profile:pending", "verified:pending", "tools:pending", "ready:pending"]);
  });

  it("has no path for an employee that is not part of the plan, or an Appointment Setter for a business that books nothing", () => {
    expect(stagesOf({ ...base, entitled: false })).toBeUndefined();
    const noBooking = ready({ appointments: { wanted: false, calendar: null, externalCalendarConnected: false } });
    expect(itemOf(deriveLaunchReadiness(noBooking), "employees.appointment_setter").stages).toBeUndefined();
    expect(itemOf(deriveLaunchReadiness(noBooking), "employees.lead_hunter").stages).toBeDefined();
  });

  it("is kept on an employee that stalled", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const f = replaceEmployee(ready(), "lead_hunter", { provisioning: "in_progress", configVersion: null, readiness: NOT_READY, startedAt: new Date(now.getTime() - 120 * 60_000).toISOString() });
    const i = itemOf(deriveLaunchReadiness(f, now), "employees.lead_hunter");
    expect(i.stalled).toBe(true);
    expect(i.stages?.map((s) => s.key)).toEqual(["queued", "profile", "verified", "tools", "ready"]);
  });

  it("never shows a later stage done before an earlier one, for any combination of facts", () => {
    const provisioning = ["none", "requested", "in_progress", "awaiting_health_check", "succeeded", "failed", "retrying", "cancelled"] as const;
    const stepStates = ["done", "current", "upcoming", "blocked"] as const;
    const order = ["queued", "profile", "verified", "tools", "ready"];
    let checked = 0;
    for (const p of provisioning) for (const conn of stepStates) for (const inv of stepStates) for (const workReady of [false, true]) for (const chat of [false, true]) for (const healthFailed of [false, true]) for (const capacityHeld of [false, true]) {
      const e = employee("crm_manager", { provisioning: p, healthFailed, capacityHeld, readinessSteps: STEP(conn, inv), readiness: { state: "ready", chatAvailable: chat, workReady, description: "", blocking: [] } });
      const stages = employeeStages({ appointments: { wanted: true, calendar: null, externalCalendarConnected: false } }, e)!;
      expect(stages.map((s) => s.key)).toEqual(order);
      const firstOpen = stages.findIndex((s) => s.state !== "done");
      // Everything after the first stage that is not done has not been reached.
      for (const [i, s] of stages.entries()) if (firstOpen !== -1 && i > firstOpen) expect(s.state, JSON.stringify({ p, conn, inv, workReady, chat })).toBe("pending");
      // A created profile needs more than a queued job: "profile" is done only for a job that reached its health check or finished, or for later evidence.
      if (p === "requested" || p === "in_progress" || p === "retrying" || p === "failed" || p === "none") {
        const later = conn === "done" || inv === "done" || chat || workReady;
        if (!later) expect(stages[1].state).not.toBe("done");
      }
      checked += 1;
    }
    expect(checked).toBe(provisioning.length * 4 * 4 * 2 * 2 * 2 * 2);
  });
});

describe("the customer-facing switches", () => {
  const controls = [
    { key: "booking_page", label: "Public booking page", on: false, wanted: true, href: "/crm/calendars/cal-1" },
    { key: "auto_reply", label: "AI replies to customers", on: false, wanted: true, href: "/settings/messaging" },
    { key: "channel.email", label: "Email", on: true, wanted: true, href: "/settings/messaging" },
    { key: "website", label: "Public website", on: false, wanted: false, href: "/website" },
  ];

  it("lists them as they are without saying who turned one on, every row not required", () => {
    const r = deriveLaunchReadiness(ready({ launchControls: controls }));
    expect(r.controls).toHaveLength(4);
    expect(r.controls!.every((c) => c.required === false)).toBe(true);
    const detail = (key: string) => r.controls!.find((c) => c.key === key)!.detail;
    expect(detail("booking_page")).toBe("Off. You asked for this. Nothing in this setup turns it on: it stays off until a person switches it on.");
    expect(detail("website")).toBe("Off. Nothing in this setup turns it on: it stays off until a person switches it on.");
    expect(detail("channel.email")).toBe("On.");
    // Nothing records who flipped a switch, so no row claims it was the client (or promises the client a switch they do not have).
    expect(r.controls!.some((c) => /you switched|switch it on yourself|until you turn it on/i.test(c.detail))).toBe(false);
    // A channel is switched on by iAcquire once it is verified: the same ownership the integrations step states.
    const channels = deriveLaunchReadiness(ready({ launchControls: [{ key: "channel.sms", label: "SMS", on: false, wanted: true, href: "/settings/messaging" }] }));
    expect(channels.controls![0].detail).toBe("Off. You asked for this. iAcquire switches a channel on once it is set up and verified; nothing in this setup turns it on.");
    expect(r.controls!.map((c) => c.href)).toEqual(["/crm/calendars/cal-1", "/settings/messaging", "/settings/messaging", "/website"]);
  });

  it("never moves the state, the percentage, the checks counted or the fingerprint, and omits the list when the facts have none", () => {
    const plain = deriveLaunchReadiness(ready());
    const withControls = deriveLaunchReadiness(ready({ launchControls: controls }));
    expect(plain.controls).toBeUndefined();
    expect([withControls.state, withControls.percent, withControls.passed, withControls.total]).toEqual([plain.state, plain.percent, plain.passed, plain.total]);
    expect(fingerprintOf(withControls)).toBe(fingerprintOf(plain));
    // Not even with every switch on, and not for a client that is far from ready.
    const allOn = deriveLaunchReadiness(ready({ launchControls: controls.map((c) => ({ ...c, on: true })) }));
    expect(allOn.percent).toBe(plain.percent);
    const early = ready({ knowledge: { approved: 0, pending: 0 } });
    expect(deriveLaunchReadiness({ ...early, launchControls: controls }).percent).toBe(deriveLaunchReadiness(early).percent);
  });
});

describe("a booking summary that is informational", () => {
  it("states the saved rules in words and never changes the percentage", () => {
    const plain = deriveLaunchReadiness(ready());
    const r = deriveLaunchReadiness(ready({ bookingSettings: { lateCancelHours: 24, aiBookingEnabled: false, remindersEnabled: false } }));
    const i = itemOf(r, "calendar.booking_settings");
    expect(i).toMatchObject({ state: "done", required: false });
    expect(i.detail).toContain("only proposes a booking, and a person confirms it");
    expect(i.detail).toContain("less than 24 hours");
    expect(i.detail).toContain("Reminders to customers are off");
    expect([r.state, r.percent, r.total]).toEqual([plain.state, plain.percent, plain.total]);
    const loose = itemOf(deriveLaunchReadiness(ready({ bookingSettings: { lateCancelHours: null, aiBookingEnabled: true, remindersEnabled: true } })), "calendar.booking_settings");
    expect(loose.detail).toContain("may book on its own, because you turned that on");
    expect(loose.detail).toContain("No late-cancellation rule");
    expect(loose.detail).toContain("Reminders to customers are on");
  });
});

describe("a check that had nothing to read", () => {
  it("says Nothing to check yet, and is still a pass that counts towards 100%", () => {
    const f = ready({ verification: AGENT_ROLE_KEYS.map((role) => (role === "crm_manager" ? { ...passed(role), nothingToCheck: true } : passed(role))) });
    const r = deriveLaunchReadiness(f);
    const i = itemOf(r, "verification.crm_manager");
    expect(i).toMatchObject({ state: "done", required: true });
    expect(i.detail).toContain("Nothing to check yet");
    expect(r.state).toBe("ready_to_launch");
    expect(r.percent).toBe(100);
    expect(itemOf(r, "verification.sales_assistant").detail).not.toContain("Nothing to check yet");
  });

  it("keeps what the check itself recorded after the plain words", () => {
    const f = ready({ verification: AGENT_ROLE_KEYS.map((role) => (role === "crm_manager" ? { role, state: "passed" as const, configVersion: 3, detail: "CRM quality review. Checked 0 contacts and 0 companies. Nothing to review yet.", nothingToCheck: true } : passed(role))) });
    expect(itemOf(deriveLaunchReadiness(f), "verification.crm_manager").detail).toBe("Nothing to check yet. CRM quality review. Checked 0 contacts and 0 companies. Nothing to review yet.");
  });

  it("does not turn a failed check or a stale one into a pass", () => {
    const stale = deriveLaunchReadiness(ready({ verification: AGENT_ROLE_KEYS.map((role) => (role === "crm_manager" ? { ...passed(role, 2), nothingToCheck: true } : passed(role))) }));
    expect(itemOf(stale, "verification.crm_manager").state).toBe("action_required");
    expect(itemOf(stale, "verification.crm_manager").detail).not.toContain("Nothing to check yet");
  });
});

describe("the fingerprint and the new data", () => {
  it("ignores the employees' paths, the switches and the optional lines, and moves for a required one", () => {
    const base = fingerprintOf(deriveLaunchReadiness(ready()));
    const extras = ready({
      launchControls: [{ key: "booking_page", label: "x", on: true, wanted: true, href: "/x" }],
      team: { listed: 1, members: 0, pending: 0, toInviteNames: ["Ana"], canManage: true },
      handoff: { ownerHasNotifyChannel: false, eligibleStaff: 0 },
      bookingSettings: { lateCancelHours: 12, aiBookingEnabled: true, remindersEnabled: true },
      crm: { ...ready().crm, region: { state: "offer", currency: "USD", callingCode: "1", country: "the United States" }, pipelineDraft: { state: "offer", stages: ["A", "B", "C"] } },
    });
    expect(fingerprintOf(deriveLaunchReadiness(extras))).toBe(base);
    // A real hold (a queued job that waits for room) is a required item that is in progress and iAcquire's, so it does move the fingerprint; its paths and wording alone do not.
    const heldJob = (over: Partial<EmployeeFact> = {}) => replaceEmployee(ready(), "lead_hunter", { provisioning: "requested", configVersion: null, readiness: NOT_READY, capacityHeld: true, startedAt: "2026-10-26T11:50:00.000Z", ...over });
    const held = fingerprintOf(deriveLaunchReadiness(heldJob()));
    expect(held).not.toBe(base);
    expect(fingerprintOf(deriveLaunchReadiness(heldJob({ readinessSteps: STEP("done", "done"), startedAt: "2026-10-26T09:00:00.000Z", provisioningDetail: "another sentence" })))).toBe(held);
    expect(fingerprintOf(deriveLaunchReadiness(ready({ knowledge: { approved: 0, pending: 0 } })))).not.toBe(base);
  });
});

describe("employees that do not run what the client approved", () => {
  const behind = (roles: AgentRoleKey[], over: Partial<LaunchFacts> = {}) => ready({ employeesBehind: roles.map((role) => ({ role, reason: "Your approved answers have changed and this employee has not been updated." })), ...over });

  it("adds a required line that names the employees, blocks 100%, and offers the update as a step", () => {
    const r = deriveLaunchReadiness(behind(["lead_hunter", "crm_manager"]));
    expect(itemOf(r, "employees.in_sync")).toMatchObject({
      state: "action_required", required: true, owner: "you", label: "AI employees match your setup",
      action: { label: "Update my employees", intent: "sync_employees" },
    });
    expect(itemOf(r, "employees.in_sync").detail).toContain("Lead Hunter, CRM Manager have not been updated to what you approved");
    expect(r.state).toBe("action_required");
    expect(r.percent).toBeLessThan(100);
    expect(r.blocking.map((i) => i.key)).toEqual(["employees.in_sync"]);
    expect(r.steps.find((s) => s.key === "employees")!.state).toBe("action_required");
    // One employee is said in the singular.
    expect(itemOf(deriveLaunchReadiness(behind(["lead_hunter"])), "employees.in_sync").detail).toContain("Lead Hunter has not been updated");
  });

  it("is absent while every employee is in step, so a ready client's total does not move", () => {
    const base = deriveLaunchReadiness(ready());
    expect(base.steps.flatMap((s) => s.items).map((i) => i.key)).not.toContain("employees.in_sync");
    expect(deriveLaunchReadiness(ready({ employeesBehind: [] })).total).toBe(base.total);
    const r = deriveLaunchReadiness(behind(["lead_hunter"]));
    expect(r.total).toBe(base.total + 1);
  });

  it("waits behind the client's own unapproved edits, the setup payment and the person's permission, and offers no step for them", () => {
    const pending = itemOf(deriveLaunchReadiness(behind(["lead_hunter"], { pendingAnswerChanges: true })), "employees.in_sync");
    expect(pending.action).toEqual({ label: "Review and approve your changes", href: "/onboarding" });
    expect(pending.detail).toContain("Approve your changes in company setup first");
    const unpaid = itemOf(deriveLaunchReadiness(behind(["lead_hunter"], { paymentCleared: false })), "employees.in_sync");
    expect(unpaid.action).toBeUndefined();
    expect(unpaid.detail).toContain("setup payment");
    const viewer = itemOf(deriveLaunchReadiness(behind(["lead_hunter"], { canSyncEmployees: false })), "employees.in_sync");
    expect(viewer.action).toBeUndefined();
    expect(viewer.detail).toContain("Only an owner or admin can update them.");
  });

  it("says nothing about an employee that is not in the plan, and moves the fingerprint only with the employees that are behind", () => {
    const noSales = ready({ employees: AGENT_ROLE_KEYS.map((role) => employee(role, role === "sales_assistant" ? { entitled: false } : {})), employeesBehind: [{ role: "sales_assistant", reason: "x" }] });
    expect(deriveLaunchReadiness(noSales).steps.flatMap((s) => s.items).map((i) => i.key)).not.toContain("employees.in_sync");
    const a = fingerprintOf(deriveLaunchReadiness(ready()));
    const b = fingerprintOf(deriveLaunchReadiness(behind(["lead_hunter"])));
    expect(b).not.toBe(a);
    // The reason's wording is for the person; it never moves the fingerprint.
    expect(fingerprintOf(deriveLaunchReadiness(ready({ employeesBehind: [{ role: "lead_hunter", reason: "another sentence" }] })))).toBe(b);
  });

  it("lists the update as a step the server action accepts", () => {
    expect(LAUNCH_INTENTS).toContain("sync_employees");
    expect(actionKind({ intent: "sync_employees" })).toBe("internal");
  });
});

describe("a check that read other setup than the client has now", () => {
  const D1 = "a".repeat(64);
  const D2 = "b".repeat(64);
  const withDigests = (check: string | null | undefined, now: string | null | undefined, role: AgentRoleKey = "appointment_setter") => ready({
    employees: AGENT_ROLE_KEYS.map((r) => employee(r, r === role ? { inputsDigest: now } : {})),
    verification: AGENT_ROLE_KEYS.map((r): VerificationFact => (r === role ? { ...passed(r), inputsDigest: check } as VerificationFact : passed(r))),
  });

  it("is stale even though the configuration version is the same, and asks for the check again", () => {
    const r = deriveLaunchReadiness(withDigests(D1, D2));
    expect(itemOf(r, "verification.appointment_setter")).toMatchObject({ state: "action_required", owner: "you", action: { intent: "run_checks" } });
    expect(itemOf(r, "verification.appointment_setter").detail).toContain("appointment types or host hours changed");
    expect(r.state).toBe("action_required");
    expect(r.blocking.map((i) => i.key)).toEqual(["verification.appointment_setter"]);
    // The same applies to a check that failed: a result for other setup says nothing about this one.
    const failed = ready({
      employees: AGENT_ROLE_KEYS.map((role) => employee(role, role === "lead_hunter" ? { inputsDigest: D2 } : {})),
      verification: AGENT_ROLE_KEYS.map((role): VerificationFact => (role === "lead_hunter" ? { role, state: "failed", configVersion: 3, detail: "No leads.", inputsDigest: D1 } : passed(role))),
    });
    expect(itemOf(deriveLaunchReadiness(failed), "verification.lead_hunter")).toMatchObject({ state: "action_required", detail: expect.stringContaining("lead targeting changed") });
  });

  it("is current when the digests match, and when a check was recorded without a digest (an old job) or the role reads nothing", () => {
    expect(deriveLaunchReadiness(withDigests(D1, D1))).toMatchObject({ state: "ready_to_launch", percent: 100 });
    expect(deriveLaunchReadiness(withDigests(null, D2))).toMatchObject({ state: "ready_to_launch", percent: 100 });
    expect(deriveLaunchReadiness(withDigests(undefined, D2))).toMatchObject({ state: "ready_to_launch", percent: 100 });
    expect(deriveLaunchReadiness(withDigests(D1, null, "operations_manager"))).toMatchObject({ state: "ready_to_launch", percent: 100 });
  });

  it("names every input of the role, and leaves a running check as it was", () => {
    const sales = deriveLaunchReadiness(withDigests(D1, D2, "sales_assistant"));
    expect(itemOf(sales, "verification.sales_assistant").detail).toContain("pipeline stages changed");
    const running = ready({
      employees: AGENT_ROLE_KEYS.map((role) => employee(role, { inputsDigest: D2 })),
      verification: AGENT_ROLE_KEYS.map((role): VerificationFact => (role === "appointment_setter" ? { role, state: "running" } : passed(role))),
    });
    expect(itemOf(deriveLaunchReadiness(running), "verification.appointment_setter").state).toBe("in_progress");
  });
});

describe("a calendar that stopped being valid after it was activated", () => {
  const drift = (checks: Array<{ key: string; detail: string }>, over: Partial<CalendarFacts> = {}) => ready({ appointments: { wanted: true, calendar: calendar({ checks: null, drift: { checks }, ...over }), externalCalendarConnected: false } });

  it("shows one required line per failing check when the live checks could not be read, in the check's own words, and holds up 100%", () => {
    const r = deriveLaunchReadiness(drift([{ key: "hours", detail: "Dana has no weekly hours." }, { key: "connections", detail: "Dana's Google account needs a new sign-in." }]));
    expect(itemOf(r, "calendar.drift.hours")).toMatchObject({ state: "action_required", required: true, owner: "you", action: { href: "/crm/availability" } });
    expect(itemOf(r, "calendar.drift.hours").detail).toContain("passed its checks when it was activated, and no longer does: Dana has no weekly hours.");
    expect(itemOf(r, "calendar.drift.connections")).toMatchObject({ state: "action_required", required: true, action: { href: "/crm/calendar-connections" } });
    expect(r.state).toBe("action_required");
    expect(r.blocking.map((i) => i.key)).toEqual(["calendar.drift.hours", "calendar.drift.connections"]);
  });

  it("is iAcquire's when the sign-in a connection needs is not switched on here, and asks a person without the calendar permission to ask the owner", () => {
    const r = deriveLaunchReadiness(drift([{ key: "connections", detail: "Dana's Google account needs a new sign-in." }], { oauthAvailable: { google: false, microsoft: false } }));
    expect(itemOf(r, "calendar.drift.connections")).toMatchObject({ owner: "iacquire", state: "action_required" });
    expect(itemOf(r, "calendar.drift.connections").action).toBeUndefined();
    const viewer = deriveLaunchReadiness(drift([{ key: "types", detail: "There is nothing to book yet." }], { canManage: false, ownerName: "Dana Brightside" }));
    expect(itemOf(viewer, "calendar.drift.types").action).toBeUndefined();
    expect(itemOf(viewer, "calendar.drift.types").detail).toContain("Ask Dana Brightside.");
  });

  it("never speaks over a live read: with the checks read, a stored record adds no line, and a calendar that is not active is judged by its own steps", () => {
    const live = ready({ appointments: { wanted: true, calendar: calendar({ drift: { checks: [{ key: "hours", detail: "Old news." }] } }), externalCalendarConnected: false } });
    expect(deriveLaunchReadiness(live).steps.flatMap((s) => s.items).map((i) => i.key).filter((k) => k.startsWith("calendar.drift"))).toEqual([]);
    expect(deriveLaunchReadiness(live)).toMatchObject({ state: "ready_to_launch", percent: 100 });
    const draft = ready({ appointments: { wanted: true, calendar: calendar({ status: "draft", checks: null, drift: { checks: [{ key: "hours", detail: "Old." }] } }), externalCalendarConnected: false } });
    expect(deriveLaunchReadiness(draft).steps.flatMap((s) => s.items).map((i) => i.key).filter((k) => k.startsWith("calendar.drift"))).toEqual([]);
  });

  it("keeps a check this judge does not know as a line, and caps the lines", () => {
    const r = deriveLaunchReadiness(drift(Array.from({ length: 9 }, (_, i) => ({ key: i === 0 ? "something_new" : `k${i}`, detail: "A thing changed." }))));
    const lines = r.steps.flatMap((s) => s.items).filter((i) => i.key.startsWith("calendar.drift."));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatchObject({ key: "calendar.drift.something_new", label: "Calendar check changed after activation" });
  });
});
