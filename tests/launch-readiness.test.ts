import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { channelIsReady, connectionSteps, deriveLaunchReadiness, type CalendarFacts, type ChannelFact, type CrmBlueprintFact, type EmployeeFact, type LaunchFacts, type VerificationFact } from "@/lib/launch-readiness";

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
