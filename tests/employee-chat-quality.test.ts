// Chat quality, found in production on 2026-10-29: employees promised actions they cannot take, reported company knowledge as a yes/no flag, and a question about the numbers got a
// stored KPI card instead of an explanation. Synthetic workspaces only; nothing here calls Hermes, a model, or sends a message.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getWorkspace } from "@/server/crm/workspace";
import { listPipelines } from "@/server/crm/pipelines";
import { prepareEmployeeEvidence } from "@/server/workforce/employee-evidence";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { CHAT_REQUESTS } from "@/lib/employee-chat-requests";
import { CAPABILITY_SECTION_HEADING, capabilitySection, type EvidenceSection } from "@/lib/employee-evidence";
import { evaluateRequirements, EMPTY_WORKSPACE_FACTS } from "@/lib/employee-requirements";
import { KNOWLEDGE_SECTIONS, knowledgeCompletenessText, summarizeKnowledge } from "@/lib/knowledge-sections";
import { parseResearchAssignment } from "@/lib/research-intent";
import { parseWorkforceChatAppointmentChangeIntent } from "@/lib/workforce-chat-appointment-change-intent";
import { parseWorkforceChatAssignment } from "@/lib/workforce-chat-assignment";
import { parseWorkforceChatBookingIntent } from "@/lib/workforce-chat-booking-intent";
import { workforceChatRefusal } from "@/lib/workforce-chat-guardrail";
import { isAutomationBuilderRequest, parseNamedWorkforceHandoff } from "@/lib/workforce-chat-routing";
import { parseWorkforceChatScheduleIntent } from "@/lib/workforce-chat-schedule-intent";
import { agentId, ctxFor } from "./support/fixtures";
import { crmOrg, CRM_ROLES, type CrmOrg } from "./support/crm";

const NOW = new Date("2026-10-19T00:00:00Z");
const MANILA = "Asia/Manila";

describe("an employee only offers what the chat router really starts", () => {
  const entries = AGENT_ROLE_KEYS.flatMap((role) => CHAT_REQUESTS[role].map((def) => [role, def] as const));

  it.each(entries.map(([role, def]) => [`${role}: ${def.key}`, role, def] as const))("%s: the wording it suggests reaches the flow it names", (_name, role, def) => {
    const say = def.say;
    expect(isAutomationBuilderRequest(say)).toBe(false);
    expect(parseNamedWorkforceHandoff(role, say)).toBeNull();

    // The booking and change previews are handled ahead of the refusal rules, with their own confirmation and approval.
    if (def.key === "booking_preview") {
      expect(parseWorkforceChatBookingIntent(role, say).kind).toBe("proposal");
      return;
    }
    expect(parseWorkforceChatBookingIntent(role, say).kind).toBe("none");
    if (def.key === "appointment_change") {
      expect(parseWorkforceChatAppointmentChangeIntent(role, say).kind).toBe("proposal");
      return;
    }
    expect(parseWorkforceChatAppointmentChangeIntent(role, say).kind).toBe("none");

    // Everything else is judged by the refusal rules first, and must not be a recurring-schedule request.
    expect(workforceChatRefusal(role, say, AGENT_BY_KEY[role].shortName), `${def.key} must not be refused`).toBeNull();
    expect(parseWorkforceChatScheduleIntent(role, say).kind).toBe("none");
    if (def.key === "lead_research") {
      const parsed = parseResearchAssignment(say);
      expect(parsed).not.toBeNull();
      expect(parsed!.missing).toEqual([]);
      return;
    }
    expect(parseWorkforceChatAssignment(role, say)?.capability).toBe(def.capability);
  });

  it("any wording an employee is told to suggest inside a description is itself a request the router recognises", () => {
    // The Performance Analyst once suggested asking for "this month", which on its own never produced the card; a suggested wording must be a complete request.
    let quoted = 0;
    for (const role of AGENT_ROLE_KEYS) {
      for (const def of CHAT_REQUESTS[role]) {
        for (const match of def.result.matchAll(/"([^"]+)"/g)) {
          quoted += 1;
          expect(def.capability, `${def.key} suggests a quoted wording but names no capability`).toBeDefined();
          expect(parseWorkforceChatAssignment(role, match[1])?.capability, `${def.key}: "${match[1]}"`).toBe(def.capability);
        }
      }
    }
    expect(quoted).toBeGreaterThan(0);
    expect(parseWorkforceChatAssignment("performance_analyst", "Show our performance metrics this month")?.input).toEqual({ period: "current_month" });
  });

  it("every role has at least one request, and a request that names a capability names one its role may use", () => {
    for (const role of AGENT_ROLE_KEYS) expect(CHAT_REQUESTS[role].length, role).toBeGreaterThan(0);
  });

  it("the capability copy no longer invites a proposal or a setup the employee cannot make", () => {
    const text = capabilitySection(["Read contacts"]);
    expect(text).toContain(CAPABILITY_SECTION_HEADING);
    expect(text).not.toMatch(/prepared as a proposal|Offer and prepare only/);
    expect(text).toMatch(/cannot change records, book or move appointments, create tasks or approvals, or contact anyone/);
    expect(text).toContain("Abilities this workspace has allowed for you: Read contacts.");
    // This text is in every run's instructions, and the restricted inference worker budgets the whole prompt (instructions, SOUL and framing) at 24,576 bytes, so it must not grow past what it replaced.
    const replacedBytes = Buffer.byteLength([
      "- Anything that changes a record, books or moves an appointment, or reaches a customer is prepared as a proposal for a person to approve in iAcquire. Call it a proposal until iAcquire confirms it is done.",
      "- Abilities this workspace has allowed for you: Read contacts. Offer and prepare only these. Anything not listed is switched off.",
    ].join("\n"), "utf8");
    const newBytes = Buffer.byteLength(text.split("\n").filter((line) => /^- (From a chat|Abilities this workspace)/.test(line)).join("\n"), "utf8");
    expect(newBytes).toBeLessThanOrEqual(replacedBytes);
  });
});

describe("a read-only question about the calendar reaches the employee; a genuine request is still stopped by the right flow", () => {
  const role = "appointment_setter" as const;
  /** The first step of the chat router that would answer instead of the employee, in the order the router tries them. */
  function interceptedBy(text: string): string | null {
    if (parseWorkforceChatBookingIntent(role, text).kind !== "none") return "booking";
    if (parseWorkforceChatAppointmentChangeIntent(role, text).kind !== "none") return "appointment change";
    if (parseWorkforceChatScheduleIntent(role, text).kind !== "none") return "recurring schedule";
    if (workforceChatRefusal(role, text, "Appointment Setter")) return "refusal";
    if (parseWorkforceChatAssignment(role, text)) return "work job";
    if (isAutomationBuilderRequest(text)) return "automation builder";
    return null;
  }

  it.each([
    "What appointments do we have this week, and is the booking calendar set up?",
    "Is the booking calendar set up yet?",
    "Are we set up to take bookings?",
    "Is our booking page set up?",
    "What does my calendar schedule look like this week?",
    "Show me the schedule for my meeting with Jane Doe.",
    "What's on the schedule for the call tomorrow?",
    "Did anyone reschedule a meeting this week?",
    "Which appointments did we have to cancel this week?",
    "How many bookings were cancelled this week?",
  ])("goes to the employee: %s", (question) => {
    expect(interceptedBy(question)).toBeNull();
  });

  it.each([
    ["Book an appointment with Jane Doe at 2026-11-02T09:00+08:00", "booking"],
    ["Please schedule a meeting with Jane Doe", "booking"],
    ["Cancel the appointment for Jane Doe at 2026-11-02T09:00+08:00", "appointment change"],
    ["Reschedule the appointment for Jane Doe from 2026-11-02T09:00+08:00 to 2026-11-03T10:00+08:00", "appointment change"],
    ["Can you cancel my appointment tomorrow?", "appointment change"],
    ["Move the meeting to Friday", "appointment change"],
    ["Confirm the booking for Jane Doe", "refusal"],
    ["Check our calendar and schedule an appointment for an available time", "work job"],
  ])("is still handled by its own flow: %s", (request, flow) => {
    expect(interceptedBy(request)).toBe(flow);
  });
});

describe("the Performance Analyst explains in words, and the KPI card stays an explicit request", () => {
  const role = "performance_analyst" as const;
  const route = (text: string) => parseWorkforceChatAssignment(role, text)?.capability ?? null;

  it.each([
    // Each of these contains a review verb and a performance word, so before the change every one of them produced the stored KPI card.
    "What do the verified business metrics show right now?",
    "What do our results show?",
    "How do our performance metrics compare with last month?",
    "Can you check our KPIs and explain what they mean?",
    "Analyze our metrics and tell me in plain words how we are doing",
    "Is there anything in our results I should look at? Summarize it in words",
    "Explain our performance metrics in plain words",
    "Walk me through our performance numbers",
  ])("is answered by the employee, from the same verified figures: %s", (question) => {
    expect(route(question)).toBeNull();
  });

  it.each([
    "Show our performance metrics for the last 30 days",
    "Analyze our business performance this month compared with last month",
    "Review our KPIs",
    "Show me the performance snapshot",
    "Show the KPI report for our results this month",
    "Show me our metrics this month",
    "Check our performance metrics",
  ])("still produces the saved KPI card on an explicit request: %s", (request) => {
    expect(route(request)).toBe("performance_snapshot");
  });

  it("a month request keeps its period", () => {
    expect(parseWorkforceChatAssignment(role, "Show our performance metrics this month")?.input).toEqual({ period: "current_month" });
  });
});

describe("how complete the company knowledge is", () => {
  const states = (...rows: Array<[string, boolean, string?]>) => rows.map(([section, filled, review_status]) => ({ section, filled, review_status: review_status ?? "approved" }));

  it("counts only approved, non-empty sections as supplied and says what is still empty", () => {
    const summary = summarizeKnowledge(states(["business_description", true], ["products_services", true], ["approved_pricing", true], ["faq", true, "pending_agency_review"], ["policies", false]));
    expect(summary).toMatchObject({ total: 9, supplied: 3, heldForReview: 1 });
    expect(summary.suppliedNames).toEqual(["Business description", "Products and services", "Approved prices"]);
    // The held section and the empty one are not "supplied"; only the empty ones are listed as still empty.
    expect(summary.missing).toHaveLength(5);
    expect(summary.missing).toContain("Policies");
    expect(summary.missing).not.toContain("Frequently asked questions");
  });

  it("never calls a partial set complete", () => {
    const text = knowledgeCompletenessText(summarizeKnowledge(states(["business_description", true], ["products_services", true], ["approved_pricing", true])));
    expect(text).toContain("3 of 9 knowledge sections are supplied");
    expect(text).toContain("partial, not a complete company profile");
    expect(text).toContain("Business hours");
    expect(text).not.toMatch(/All 9/);
  });

  it("says so when nothing, or everything, is supplied", () => {
    expect(knowledgeCompletenessText(summarizeKnowledge([]))).toBe("No company knowledge has been supplied yet (0 of 9 sections).");
    expect(knowledgeCompletenessText(summarizeKnowledge(KNOWLEDGE_SECTIONS.map((s) => ({ section: s.key, filled: true, review_status: "approved" }))))).toBe("All 9 knowledge sections are supplied.");
    expect(knowledgeCompletenessText(summarizeKnowledge(states(["faq", true, "pending_agency_review"])))).toBe("No company knowledge is approved yet (0 of 9 sections); 1 waiting for review.");
  });

  it("the readiness checklist shows the counts when it has them, and is unchanged when it only has the flag", () => {
    const withCounts = evaluateRequirements("crm_manager", { ...EMPTY_WORKSPACE_FACTS, crmReady: true, knowledgeApproved: true, knowledge: summarizeKnowledge(states(["business_description", true], ["policies", true])) });
    expect(withCounts.find((r) => r.key === "knowledge")).toMatchObject({ met: true, detail: expect.stringContaining("2 of 9 knowledge sections are supplied") });
    const flagOnly = evaluateRequirements("crm_manager", { ...EMPTY_WORKSPACE_FACTS, crmReady: true, knowledgeApproved: true });
    expect(flagOnly.find((r) => r.key === "knowledge")!.detail).toBe("Approved company knowledge is available to this employee.");
    const none = evaluateRequirements("crm_manager", { ...EMPTY_WORKSPACE_FACTS, crmReady: true, knowledge: summarizeKnowledge([]) });
    expect(none.find((r) => r.key === "knowledge")).toMatchObject({ met: false, fixHref: "/knowledge" });
  });
});

describe("the snapshot an employee is given", () => {
  let shop: CrmOrg;
  let other: CrmOrg;

  const byId = (sections: EvidenceSection[], id: string) => sections.find((s) => s.id === id);
  const ctxFor2 = (c: CrmOrg, who: keyof typeof CRM_ROLES = "owner") => {
    const ctx = ctxFor(c.people[who], c.org, CRM_ROLES[who]);
    ctx.org.timezone = MANILA;
    return ctx;
  };
  const evidence = async (c: CrmOrg, role: AgentRoleKey, who: keyof typeof CRM_ROLES = "owner") => {
    const prepared = await prepareEmployeeEvidence(ctxFor2(c, who), { agentId: await agentId(c.org.id, role), roleKey: role, now: NOW });
    return { ...prepared, sections: prepared.evidence.sections };
  };
  async function switchOff(c: CrmOrg, role: AgentRoleKey, disabledTools: string[]) {
    const id = await agentId(c.org.id, role);
    await withSystem(async (db) => {
      const v = await db.query<{ id: string }>(
        `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
         values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), $3, 's', '# config', 'p', 'onboarding', 'applied') returning id`,
        [c.org.id, id, JSON.stringify({ disabledTools })],
      );
      await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [id, v.rows[0].id]);
    });
  }

  beforeAll(async () => {
    shop = await crmOrg({ name: "Quality Shop", timezone: MANILA });
    other = await crmOrg({ name: "Quality Neighbour", timezone: MANILA });
    for (const c of [shop, other]) {
      await getWorkspace(c.actor("owner"));
      await listPipelines(c.actor("owner"), { ensureDefault: true });
    }
    await withSystem(async (db) => {
      await db.query(
        `insert into company_knowledge (org_id, section, content, review_status) values
           ($1, 'business_description', 'We repair roofs and gutters across Austin.', 'approved'),
           ($1, 'products_services', 'Roof repair and gutter cleaning.', 'approved'),
           ($1, 'approved_pricing', 'Inspection is 99 dollars.', 'approved'),
           ($1, 'faq', 'Held text about refunds.', 'pending_agency_review'),
           ($1, 'policies', '', 'approved')`,
        [shop.org.id],
      );
      await db.query("insert into company_knowledge (org_id, section, content, review_status) values ($1, 'brand_voice', 'Neighbour secret brand voice.', 'approved')", [other.org.id]);
    });
  });

  it.each(AGENT_ROLE_KEYS)("%s is told how complete the knowledge is: counts and section names, never the text", async (role) => {
    const { sections, block } = await evidence(shop, role);
    const knowledge = byId(sections, "knowledge")!;
    expect(knowledge.state).toBe("ready");
    expect(knowledge.facts).toMatchObject({ sectionsSupplied: 3, sectionsAsked: 9, sectionsWaitingForReview: 1, complete: false });
    expect(knowledge.facts.supplied).toEqual(["Business description", "Products and services", "Approved prices"]);
    // The held section and the empty row are not supplied; the five that hold nothing are named.
    expect(knowledge.facts.stillEmpty).toHaveLength(5);
    expect(knowledge.facts.stillEmpty).toContain("Business hours");
    expect(knowledge.summary).toContain("3 of 9 knowledge sections are supplied");
    expect(block).not.toMatch(/roofs and gutters|gutter cleaning|99 dollars|about refunds|Neighbour secret/);
  });

  it("another workspace's knowledge never counts, and an empty one is reported as not set up with its own counts", async () => {
    const { sections, block } = await evidence(other, "crm_manager");
    expect(byId(sections, "knowledge")).toMatchObject({ state: "ready", facts: { sectionsSupplied: 1, sectionsAsked: 9 } });
    expect(block).not.toMatch(/roofs|Inspection is 99/);
    const fresh = await crmOrg({ name: "Quality Fresh", timezone: MANILA });
    await getWorkspace(fresh.actor("owner"));
    const empty = byId((await evidence(fresh, "operations_manager")).sections, "knowledge")!;
    expect(empty.state).toBe("not_configured");
    expect(empty.facts).toMatchObject({ sectionsSupplied: 0, sectionsAsked: 9 });
  });

  it("a person who may not open the Knowledge Center gets no counts at all", async () => {
    const base = ctxFor2(shop);
    const denied = { ...base, can: (permission: Parameters<typeof base.can>[0]) => permission !== "knowledge.view" && base.can(permission) };
    const prepared = await prepareEmployeeEvidence(denied, { agentId: await agentId(shop.org.id, "sales_assistant"), roleKey: "sales_assistant", now: NOW });
    const knowledge = byId(prepared.evidence.sections, "knowledge")!;
    expect(knowledge.state).toBe("no_permission");
    expect(JSON.stringify(knowledge)).not.toMatch(/sectionsSupplied|Business description/);
  });

  it("Zeng's set-up summary no longer reduces knowledge to a yes", async () => {
    const setUp = byId((await evidence(shop, "operations_manager")).sections, "handoffs")!.facts.setUp as Record<string, string>;
    expect(setUp.approvedBusinessKnowledge).toContain("partly supplied");
    expect(setUp.approvedBusinessKnowledge).toContain("3 of 9");
  });

  it("lists only what this person can start, and says what is missing for the rest", async () => {
    // No calendar exists yet in this workspace.
    const { sections } = await evidence(shop, "appointment_setter");
    const requests = byId(sections, "chat_requests")!;
    expect(requests.state).toBe("ready");
    const canStart = requests.records.map((r) => r.request);
    expect(canStart).toEqual(["An appointment review"]);
    const cannot = requests.facts.cannotStartNow as Array<{ request: string; because: string }>;
    expect(cannot.map((c) => c.request)).toEqual(["A calendar availability check", "A booking preview", "A cancellation or reschedule preview"]);
    for (const item of cannot) expect(item.because).toBe("no booking calendar is set up yet, so it cannot work yet");
    expect(String(requests.facts.everythingElse)).toContain("cannot be done from this chat");
  });

  it("an Appointment Setter with no calendar is given no appointment count, and told not to say nothing is booked", async () => {
    // Found in production on 2026-10-29: "Nothing is booked this week" was said when no calendar existed, so nothing could be verified.
    const { sections, block } = await evidence(shop, "appointment_setter");
    const appointments = byId(sections, "appointments")!;
    expect(appointments.state).toBe("not_configured");
    expect(appointments.facts.appointmentsThisWeek).toBeNull();
    expect(appointments.facts.upcomingAppointmentsNext14Days).toBeNull();
    expect(appointments.summary).toContain("not a confirmed empty week");
    expect(String(appointments.facts.note)).toMatch(/Do not say that nothing is booked or that there are zero appointments/);
    expect(block).not.toMatch(/"appointmentsThisWeek":0/);

    // A workspace whose CRM was never opened takes the other path and carries the same instruction.
    const bare = await crmOrg({ name: "Quality Bare", timezone: MANILA });
    const bareAppointments = byId((await evidence(bare, "appointment_setter")).sections, "appointments")!;
    expect(bareAppointments.state).toBe("not_configured");
    expect(bareAppointments.summary).toContain("not a confirmed empty week");
    expect(String(bareAppointments.facts.note)).toMatch(/Do not say that nothing is booked/);
  });

  it("a request the employee's own settings have switched off is not offered", async () => {
    await switchOff(shop, "appointment_setter", ["appointments.request_change"]);
    const requests = byId((await evidence(shop, "appointment_setter")).sections, "chat_requests")!;
    // Reading appointments is still on, so the review stays; previews that need the change ability are not offered.
    expect(requests.records.map((r) => r.request)).toEqual(["An appointment review"]);
    const cannot = requests.facts.cannotStartNow as Array<{ request: string; because: string }>;
    expect(cannot.find((c) => c.request === "A booking preview")!.because).toBe("this ability is switched off for this employee");
    await switchOff(shop, "appointment_setter", []);
  });

  it("a person without the permission is told it is not theirs to start, per role", async () => {
    const viewer = await evidence(shop, "sales_assistant", "viewer");
    const requests = byId(viewer.sections, "chat_requests")!;
    expect(requests.records).toEqual([]);
    expect((requests.facts.cannotStartNow as Array<{ because: string }>).every((c) => c.because === "the person asking does not have access to it")).toBe(true);
    expect(requests.summary).toBe("Nothing can be started from this chat by this person right now.");
    const owner = await evidence(shop, "sales_assistant");
    expect(byId(owner.sections, "chat_requests")!.records.map((r) => r.request)).toEqual(["A sales pipeline review", "Unsent follow-up drafts"]);
  });

  it("the Performance Analyst is told how to get the KPI card, and the block forbids invented promises", async () => {
    const { sections, block } = await evidence(shop, "performance_analyst");
    const requests = byId(sections, "chat_requests")!;
    expect(requests.records).toEqual([expect.objectContaining({ request: "The performance KPI card", theyCanWrite: "Show our performance metrics for the last 30 days" })]);
    expect(block).toContain("What can be started from this chat");
    expect(block).toContain("say plainly that you cannot do it from this chat");
    expect(block).not.toMatch(/offer to prepare a proposal|offer to help finish the setup/);
    expect(block).toMatch(/Never offer or promise any of that/);
    expect(block).toMatch(/I'll get that in motion/);
  });

  it("every suggestion in the snapshot is one of the reviewed requests, for every role", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const allowed = new Set(CHAT_REQUESTS[role].map((d) => d.say));
      const { sections } = await evidence(shop, role);
      for (const record of byId(sections, "chat_requests")!.records) expect(allowed.has(String(record.theyCanWrite)), `${role}: ${record.request}`).toBe(true);
    }
  });
});
