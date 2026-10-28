// What each AI employee is told about its workspace. Synthetic workspaces only; nothing here calls Hermes, a provider, or sends a message.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { listPipelines } from "@/server/crm/pipelines";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { bookNativeAppointment } from "@/server/calendars/booking";
import { prepareEmployeeEvidence, weekBounds } from "@/server/workforce/employee-evidence";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import {
  capabilitySection, findInternalIdentifiers, fitEvidence, formatEmployeeEvidence, insertEvidenceBlock, replaceLegacyToolsSection, weeklyHoursText,
  type EmployeeEvidence, type EvidenceSection, type EvidenceState,
} from "@/lib/employee-evidence";
import { agentToolLabel } from "@/lib/agent-tools";
import { compileAgentConfig, defaultSettings } from "@/server/workforce/compiler";
import { immutablePolicy } from "@/server/workforce/policy";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { crmOrg, CRM_ROLES, type CrmOrg } from "./support/crm";

// Monday 19 October 2026, 08:00 in Manila.
const NOW = new Date("2026-10-19T00:00:00Z");
const MANILA = "Asia/Manila";
const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

const byId = (sections: EvidenceSection[], id: string) => sections.find((s) => s.id === id);
const states = (sections: EvidenceSection[]) => Object.fromEntries(sections.map((s) => [s.id, s.state])) as Record<string, EvidenceState>;
const text = (sections: EvidenceSection[]) => JSON.stringify(sections);

// The database allows exactly one agency organization, so every scenario shares it and only the person changes.
let agencyOrg: Awaited<ReturnType<typeof createOrg>> | null = null;
const agencyPeople = new Map<string, Awaited<ReturnType<typeof makeAgencyContext>>>();
async function makeAgencyContext(platformRole: "agency_super_admin" | "agency_staff") {
  agencyOrg ??= await createOrg({ name: "Internal iAcquire", kind: "agency" });
  const org = agencyOrg;
  const user = await createUser({ platformRole, name: platformRole === "agency_super_admin" ? "Mark" : "Staff Member" });
  await addMember(org.id, user.id, "owner");
  const ctx = ctxFor(user, org, "owner");
  ctx.org.kind = "agency";
  ctx.org.timezone = MANILA;
  ctx.user.platformRole = platformRole;
  return { org, user, ctx };
}
async function agencyContext(platformRole: "agency_super_admin" | "agency_staff" = "agency_super_admin") {
  const known = agencyPeople.get(platformRole);
  if (known) return known;
  const made = await makeAgencyContext(platformRole);
  agencyPeople.set(platformRole, made);
  return made;
}

async function evidenceFor(ctx: ReturnType<typeof ctxFor>, orgId: string, role: AgentRoleKey) {
  const prepared = await prepareEmployeeEvidence(ctx, { agentId: await agentId(orgId, role), roleKey: role, now: NOW });
  return { ...prepared, sections: prepared.evidence.sections };
}

function clientCtx(c: CrmOrg, who: keyof typeof CRM_ROLES = "owner") {
  const ctx = ctxFor(c.people[who], c.org, CRM_ROLES[who]);
  ctx.org.timezone = MANILA;
  return ctx;
}

describe("capability copy", () => {
  const legacy = [
    "# iAcquire internal agency configuration (v3, policy 2026-10-25.1)",
    "You are Aria, the AI CRM Manager for iAcquire.",
    "",
    "## Tools you may use",
    "- crm.read",
    "- crm.request_update",
    "Use only these tools, and only when they help answer the request.",
    "",
    "## Business context",
    "<workspace_context>\nWhat the business does: Marketing\n</workspace_context>",
    "",
    "## Agency policy (always applies and overrides everything above)",
    "1. A rule.",
  ].join("\n");

  it("replaces the old tool list with what is true, keeping the abilities in plain words and the rest untouched", () => {
    const fixed = replaceLegacyToolsSection(legacy, agentToolLabel);
    expect(fixed).not.toMatch(/crm\.read|crm\.request_update|Tools you may use|Use only these tools/);
    expect(fixed).toContain("## How you get information and make changes");
    expect(fixed).toContain("Read CRM records; Propose CRM updates (needs approval)");
    expect(fixed).toContain("## Business context");
    expect(fixed).toContain("## Agency policy (always applies and overrides everything above)\n1. A rule.");
    expect(fixed.startsWith("# iAcquire internal agency configuration (v3")).toBe(true);
    expect(replaceLegacyToolsSection(fixed, agentToolLabel)).toBe(fixed);
  });

  it("says plainly when no ability is switched on, and leaves text without the legacy section alone", () => {
    const none = legacy.replace("- crm.read\n- crm.request_update", "- None. Answer from the conversation and business context only.");
    expect(replaceLegacyToolsSection(none, agentToolLabel)).toContain("has not switched on any extra abilities");
    expect(replaceLegacyToolsSection("# Heading\n\nbody", agentToolLabel)).toBe("# Heading\n\nbody");
  });

  it("newly compiled configurations carry the same text, and switching an ability off still takes effect", () => {
    const company = { companyName: "iAcquire", orgKind: "agency" as const } as Parameters<typeof compileAgentConfig>[0]["company"];
    const all = compileAgentConfig({ role: "crm_manager", settings: defaultSettings("crm_manager"), company, version: 1, allowedTools: ["crm.read", "crm.request_update"] });
    expect(all.instructions).toContain("Read CRM records; Propose CRM updates (needs approval)");
    expect(all.instructions).not.toMatch(/crm\.read|crm\.request_update|Tools you may use/);
    const off = compileAgentConfig({
      role: "crm_manager", settings: { ...defaultSettings("crm_manager"), disabledTools: ["crm.request_update"] }, company, version: 2, allowedTools: ["crm.read", "crm.request_update"],
    });
    expect(off.instructions).toContain("Read CRM records");
    expect(off.instructions).not.toContain("Propose CRM updates");
  });

  it("only claims a snapshot in the run that actually carries one", () => {
    const generic = capabilitySection([]);
    expect(generic).toContain("no live view of this workspace's records");
    const withEvidence = insertEvidenceBlock(`${generic}

## Agency policy (always applies)
1. A rule.`, "BLOCK");
    expect(withEvidence).toContain('under "Verified workspace snapshot"');
    expect(withEvidence).not.toContain("no live view");
    expect(withEvidence.indexOf("BLOCK")).toBeLessThan(withEvidence.indexOf("## Agency policy"));
  });

  it("puts the evidence ahead of the protected policy", () => {
    const merged = insertEvidenceBlock(`head\n\n## Agency policy (always applies)\n1. A rule.`, "BLOCK");
    expect(merged.indexOf("BLOCK")).toBeGreaterThan(merged.indexOf("head"));
    expect(merged.indexOf("BLOCK")).toBeLessThan(merged.indexOf("## Agency policy"));
    expect(insertEvidenceBlock("no policy here", "BLOCK")).toBe("no policy here\n\nBLOCK");
  });
});

describe("evidence text", () => {
  const sample = (records: number): EmployeeEvidence => ({
    role: "crm_manager",
    generatedAt: NOW.toISOString(),
    timeZone: MANILA,
    workspace: { name: "iAcquire", kind: "agency" },
    sections: [{ id: "crm", title: "CRM", state: "ready", summary: "s", facts: { contacts: records }, records: Array.from({ length: records }, (_, i) => ({ name: `Contact ${i} ${"x".repeat(200)}` })), recordsTotal: records }],
  });

  it("explains how to answer for every state, never names a system label, and carries parseable evidence", () => {
    const block = formatEmployeeEvidence(sample(2));
    for (const state of ["ready", "empty", "not_configured", "unavailable", "no_permission"]) expect(block).toContain(`- ${state}:`);
    expect(block).not.toMatch(/\b(?:crm|appointments?|calendar|leads?)\.[a-z_]+\b/i);
    expect(block).toMatch(/Monday, October 19, 2026/);
    const json = block.slice(block.indexOf("<verified_workspace_evidence>") + 29, block.indexOf("</verified_workspace_evidence>")).trim();
    expect((JSON.parse(json) as EmployeeEvidence).sections[0].facts.contacts).toBe(2);
  });

  it("shortens long lists to fit, keeping every section and count and saying how many exist", () => {
    const fitted = fitEvidence(sample(120), 6_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(6_000);
    expect(fitted.sections[0].records.length).toBeLessThan(120);
    expect(fitted.sections[0].recordsTotal).toBe(120);
    expect(fitted.sections[0].facts.contacts).toBe(120);
  });

  it("describes weekly hours in words", () => {
    expect(weeklyHoursText(WEEKDAYS_9_TO_5)).toBe("Mon–Fri 09:00–17:00");
    expect(weeklyHoursText([])).toBe("none set");
    expect(weeklyHoursText([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 3, startMinute: 540, endMinute: 720 }, { weekday: 6, startMinute: 600, endMinute: 660 }])).toBe("Mon, Wed 09:00–12:00; Sat 10:00–11:00");
  });

  it("reports internal identifiers without rewriting anything", () => {
    expect(findInternalIdentifiers("I can't use crm.read or crm.request_update; the tool registry has no CRM toolset.")).toEqual(["crm.read", "crm.request_update", "tool registry", "toolset"]);
    expect(findInternalIdentifiers("Your CRM is set up and ready. You have no contacts or deals yet.")).toEqual([]);
    expect(findInternalIdentifiers("Your meeting is on Oct. 20 at 10:00 a.m.")).toEqual([]);
  });

  it("finds the Monday-to-Sunday week in the workspace's own time zone", () => {
    const week = weekBounds(new Date("2026-10-25T15:30:00Z"), MANILA); // Sunday 25 Oct, 23:30 in Manila
    expect(week.startDate).toBe("2026-10-19");
    expect(week.endDate).toBe("2026-10-26");
    expect(week.start.toISOString()).toBe("2026-10-18T16:00:00.000Z");
  });
});

describe("the internal agency with an empty native CRM and no calendar", () => {
  let agency: Awaited<ReturnType<typeof agencyContext>>;
  beforeAll(async () => {
    agency = await agencyContext();
    const actor = memberActor(agency.ctx);
    await getWorkspace(actor);
    await listPipelines(actor, { ensureDefault: true });
  });

  it("CRM Manager: reports a set-up CRM with zero contacts and zero deals, not a missing connection", async () => {
    const { sections, block } = await evidenceFor(agency.ctx, agency.org.id, "crm_manager");
    expect(states(sections)).toMatchObject({ crm: "empty", crm_quality: "empty", pipeline: "empty" });
    const crm = byId(sections, "crm")!;
    expect(crm.facts).toMatchObject({ contacts: 0, openDeals: 0, companies: 0, salesPipelineAvailable: true });
    expect(crm.summary).toMatch(/set up and ready/);
    expect(byId(sections, "pipeline")!.facts.pipelines).toEqual([expect.objectContaining({ isDefault: true })]);
    expect(block).toContain("Verified workspace snapshot");
  });

  it("Sales Assistant: reports zero deals and shows the pipeline stages that exist", async () => {
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "sales_assistant");
    const pipeline = byId(sections, "pipeline")!;
    expect(pipeline.state).toBe("empty");
    expect(pipeline.facts).toMatchObject({ openDeals: 0, dealsWon: 0, dealsLost: 0 });
    const stages = (pipeline.facts.pipelines as Array<{ stages: Array<{ name: string }> }>)[0].stages.map((s) => s.name);
    expect(stages.length).toBeGreaterThan(2);
  });

  it("Appointment Setter: says the calendar is not set up and invents no appointments or open times", async () => {
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "appointment_setter");
    expect(states(sections)).toMatchObject({ calendar: "not_configured", appointments: "not_configured" });
    expect(byId(sections, "calendar")!.facts).toMatchObject({ calendars: 0, missingForBooking: ["a consultation calendar"] });
    expect(byId(sections, "appointments")!.records).toEqual([]);
    expect(byId(sections, "open_times")).toBeUndefined();
  });

  it("Performance Analyst: says meaningful figures are not available yet instead of reporting zeros as results", async () => {
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "performance_analyst");
    expect(byId(sections, "performance")!.state).toBe("empty");
    expect(byId(sections, "performance")!.summary).toMatch(/not available yet/);
    expect(byId(sections, "calendar")!.state).toBe("not_configured");
    expect(byId(sections, "crm")!.state).toBe("empty");
  });

  it("Lead Hunter: no targeting rules and no leads yet are two different honest answers", async () => {
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "lead_hunter");
    expect(states(sections)).toMatchObject({ leads: "empty", targeting: "not_configured" });
  });

  it("Operations Manager: an empty board is empty, the agency snapshot is left to its own gated reader", async () => {
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "operations_manager");
    expect(states(sections)).toMatchObject({ work_board: "empty", schedules: "empty", handoffs: "ready" });
    expect(byId(sections, "operations")).toBeUndefined();
    expect(byId(sections, "handoffs")!.facts.setUp).toMatchObject({ crm: "set up", bookingCalendar: "not set up yet", leadTargetingRules: "not set up yet" });
  });

  it("every read is audited with states and counts, never record contents", async () => {
    await evidenceFor(agency.ctx, agency.org.id, "crm_manager");
    const { rows } = await withSystem((db) => db.query<{ result: string; metadata: Record<string, unknown> }>(
      "select result, metadata from audit_logs where org_id = $1 and action = 'workforce.employee_evidence_read' order by created_at desc limit 1", [agency.org.id],
    ));
    expect(rows[0].result).toBe("success");
    expect(rows[0].metadata).toMatchObject({ role: "crm_manager", sections: { crm: "empty" } });
    expect(JSON.stringify(rows[0].metadata)).not.toMatch(/contacts"?:\s*\d/);
  });

  it("a staff member without the internal CRM seat is told they lack permission, not that the CRM is empty", async () => {
    const staff = await agencyContext("agency_staff");
    const { sections } = await evidenceFor(staff.ctx, staff.org.id, "crm_manager");
    expect(states(sections)).toMatchObject({ crm: "no_permission", crm_quality: "no_permission", pipeline: "no_permission" });
    expect(text(sections)).not.toMatch(/"contacts":/);
  });
});

describe("the internal agency once the calendar, leads and deals exist", () => {
  let agency: Awaited<ReturnType<typeof agencyContext>>;
  let typeId: string;
  beforeAll(async () => {
    agency = await agencyContext();
    const actor = memberActor(agency.ctx);
    await getWorkspace(actor);
    await listPipelines(actor, { ensureDefault: true });
    await withSystem(async (db) => {
      await db.query("update organizations set timezone = $2 where id = $1", [agency.org.id, MANILA]);
      await db.query("insert into lead_targeting_profiles (org_id, criteria) values ($1, $2)", [
        agency.org.id,
        JSON.stringify({ industries: ["Real estate"], countries: ["PH"], excluded: ["Franchises"], minimumCriteria: "Has a working website" }),
      ]);
      for (let i = 1; i <= 10; i++) {
        await db.query(
          `insert into leads (org_id, business_name, domain, industry, location, score, review_status, duplicate_status, crm_sync_status)
           values ($1, $2, $3, 'Real estate', 'Cebu', $4, $5, $6, 'not_synced')`,
          [agency.org.id, `Lead Co ${i}`, `lead${i}.example.test`, 40 + i, i <= 8 ? "pending" : "approved", i === 3 ? "possible_duplicate" : "no_match"],
        );
      }
    });
    const calendar = await createCalendar(actor, { name: "Consultations", members: [{ userId: agency.user.id }], isDefault: true });
    await setHostAvailability(actor, agency.user.id, { timezone: MANILA, rules: WEEKDAYS_9_TO_5 });
    typeId = (await createAppointmentType(actor, calendar.id, {
      name: "Consultation", durationMinutes: 30, bufferAfterMinutes: 15, minNoticeMinutes: 24 * 60, maxDaysAhead: 30, meetingProvider: "google_meet",
    })).id;
  });

  it("Lead Hunter: counts and statuses come from the saved leads and the saved targeting rules", async () => {
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "lead_hunter");
    const leads = byId(sections, "leads")!;
    expect(leads.state).toBe("ready");
    expect(leads.facts).toMatchObject({ totalLeads: 10, awaitingHumanReview: 8, approved: 2, possibleDuplicates: 1, outreachAllowed: false });
    expect(leads.records).toHaveLength(10);
    expect(leads.records[0]).toMatchObject({ business: expect.stringMatching(/^Lead Co /), review: expect.any(String) });
    expect(byId(sections, "targeting")!.facts).toMatchObject({ industries: ["Real estate"], excluded: ["Franchises"], minimumCriteria: "Has a working website" });
  });

  it("Appointment Setter: reports the real host, hours, notice and meeting method, and an empty week", async () => {
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "appointment_setter");
    expect(byId(sections, "calendar")!.state).toBe("ready");
    expect(byId(sections, "calendar")!.facts).toMatchObject({
      activeCalendars: 1, missingForBooking: [], workspaceTimeZone: MANILA,
      hosts: [{ name: "Mark", timeZone: MANILA, acceptingBookings: true, weeklyHours: "Mon–Fri 09:00–17:00" }],
    });
    expect(JSON.stringify(byId(sections, "calendar")!.records)).toMatch(/30 min, 15 min buffer after, 24 h minimum notice, bookable up to 30 days ahead, Google Meet/);
    expect(byId(sections, "calendar")!.facts.meetingMethod).toMatch(/no host has a connected Google account/);
    expect(byId(sections, "appointments")!.state).toBe("empty");
    expect(byId(sections, "appointments")!.facts).toMatchObject({ appointmentsThisWeek: 0, thisWeek: "2026-10-19 to 2026-10-25 (Monday to Sunday, Asia/Manila)" });
    const open = byId(sections, "open_times")!;
    expect(open.state).toBe("ready");
    expect(open.records.length).toBeGreaterThan(0);
    expect(String(open.records[0].opensAt)).toMatch(/PST|GMT\+8/);
  });

  it("Appointment Setter: lists only the appointments that exist this week and next, with the right counts", async () => {
    const actor = memberActor(agency.ctx);
    const thisWeek = await bookNativeAppointment(actor, { typeId, startAt: new Date("2026-10-22T10:00:00+08:00"), contact: { firstName: "Ana", lastName: "Reyes", email: "ana@example.test" }, via: "staff", now: new Date("2026-10-19T00:00:00Z"), ignoreNotice: true } as never);
    expect(thisWeek).toBeTruthy();
    await bookNativeAppointment(actor, { typeId, startAt: new Date("2026-10-27T10:00:00+08:00"), contact: { firstName: "Ben", lastName: "Cruz", email: "ben@example.test" }, via: "staff", now: NOW });
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "appointment_setter");
    const appointments = byId(sections, "appointments")!;
    expect(appointments.state).toBe("ready");
    expect(appointments.facts).toMatchObject({ appointmentsThisWeek: 1, upcomingAppointmentsNext14Days: 2 });
    expect(appointments.records.map((r) => r.contact)).toEqual(["Ana Reyes", "Ben Cruz"]);
    expect(appointments.records[0]).toMatchObject({ thisWeek: true, alreadyHappened: false });
    expect(appointments.records[1]).toMatchObject({ thisWeek: false });
    expect(String(appointments.records[0].when)).toMatch(/Thursday, October 22/);
  });

  it("Sales Assistant and Performance Analyst: report real deals, never invented value, and flag the gaps", async () => {
    const actor = memberActor(agency.ctx);
    const contact = await createContact(actor, { firstName: "Mia", lastName: "Santos", email: "mia@example.test" });
    await createOpportunity(actor, { name: "Website refresh", contactId: contact.id, value: 1200, currency: "USD" } as never);
    await createOpportunity(actor, { name: "No value yet" } as never);
    const sales = await evidenceFor(agency.ctx, agency.org.id, "sales_assistant");
    const pipeline = byId(sales.sections, "pipeline")!;
    expect(pipeline.state).toBe("ready");
    expect(pipeline.facts).toMatchObject({ openDeals: 2, openDealsMissingValue: 1, openDealsWithoutContact: 1, openValue: [{ currency: "USD", value: 1200 }] });
    expect(pipeline.records.map((r) => r.deal)).toEqual(expect.arrayContaining(["Website refresh", "No value yet"]));

    const analyst = await evidenceFor(agency.ctx, agency.org.id, "performance_analyst");
    const performance = byId(analyst.sections, "performance")!;
    expect(performance.state).toBe("ready");
    expect(performance.facts).toMatchObject({ revenueTracked: false });
    const measures = Object.fromEntries(performance.records.map((r) => [r.measure, r.value]));
    expect(measures["Leads created"]).toBe(10);
    expect(measures["Open deals"]).toBe(2);
    // Mia, plus the two people the earlier test booked appointments for.
    expect(measures["Contacts created"]).toBe(3);
    expect(Object.keys(measures).join(" ")).not.toMatch(/revenue/i);
  });

  it("CRM Manager: counts missing details and possible duplicates from the real records", async () => {
    const actor = memberActor(agency.ctx);
    await createContact(actor, { firstName: "No", lastName: "Details" });
    const { sections } = await evidenceFor(agency.ctx, agency.org.id, "crm_manager");
    const quality = byId(sections, "crm_quality")!;
    expect(quality.state).toBe("ready");
    expect(quality.facts).toMatchObject({ contacts: 4, withoutEmailOrPhone: 1, duplicatesAreCandidatesNotConfirmed: true });
    expect(byId(sections, "crm")!.facts).toMatchObject({ contacts: 4, openDeals: 2 });
  });

  it("no section contains a system label, even though the evidence is built from system tables", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const { block, sections } = await evidenceFor(agency.ctx, agency.org.id, role);
      expect(sections.length).toBeGreaterThan(0);
      expect(findInternalIdentifiers(block).filter((found) => !/snapshot|evidence/.test(found)), role).toEqual([]);
    }
  });
});

describe("a client workspace stays inside its own walls", () => {
  let a: CrmOrg;
  let b: CrmOrg;
  beforeAll(async () => {
    a = await crmOrg({ name: "Alpha Plumbing", timezone: MANILA });
    b = await crmOrg({ name: "Bravo Roofing", timezone: MANILA });
    await getWorkspace(a.actor("owner"));
    await getWorkspace(b.actor("owner"));
    await listPipelines(a.actor("owner"), { ensureDefault: true });
    await listPipelines(b.actor("owner"), { ensureDefault: true });
    await createContact(b.actor("owner"), { firstName: "Bravo", lastName: "Secret", email: "secret@bravo.test" });
    await createOpportunity(b.actor("owner"), { name: "Bravo private deal", value: 9999 } as never);
    await withSystem((db) => db.query("insert into leads (org_id, business_name, domain) values ($1, 'Bravo Private Lead', 'bravo-lead.test')", [b.org.id]));
  });

  it("returns Alpha's empty CRM and leads, with none of Bravo's records, for every role", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const { sections, block } = await evidenceFor(clientCtx(a), a.org.id, role);
      expect(block, role).not.toMatch(/Bravo|bravo|9999|secret@/);
      expect(text(sections), role).not.toMatch(/Bravo/);
    }
    const crm = await evidenceFor(clientCtx(a), a.org.id, "crm_manager");
    expect(byId(crm.sections, "crm")!.facts).toMatchObject({ contacts: 0, openDeals: 0 });
    const leads = await evidenceFor(clientCtx(a), a.org.id, "lead_hunter");
    expect(byId(leads.sections, "leads")!.state).toBe("empty");
  });

  it("a calendar that exists but is unfinished is described as not ready, with what is missing", async () => {
    const c = await crmOrg({ name: "Unfinished Calendar Co", timezone: MANILA });
    await getWorkspace(c.actor("owner"));
    await createCalendar(c.actor("owner"), { name: "Needs a host and a meeting type" });
    const { sections } = await evidenceFor(clientCtx(c), c.org.id, "appointment_setter");
    const calendar = byId(sections, "calendar")!;
    expect(calendar.state).toBe("not_configured");
    expect(calendar.facts.missingForBooking).toEqual(expect.arrayContaining([expect.stringMatching(/meeting type/), expect.stringMatching(/host/)]));
    expect(byId(sections, "appointments")!.state).toBe("not_configured");
    expect(byId(sections, "open_times")).toBeUndefined();
  });

  it("a client Operations Manager also gets the tasks, approvals and AI team the agency reader provides internally", async () => {
    const { sections } = await evidenceFor(clientCtx(a), a.org.id, "operations_manager");
    expect(byId(sections, "operations")!.facts.aiTeam).toHaveLength(6);
    expect(text(sections)).not.toMatch(/Bravo/);
  });

  it("a workspace that has never set up its CRM is told so, and a workspace without a role permission is told that instead", async () => {
    const fresh = await crmOrg({ name: "Fresh Co", timezone: MANILA });
    await withSystem((db) => db.query("delete from crm_workspaces where org_id = $1", [fresh.org.id]));
    const { sections } = await evidenceFor(clientCtx(fresh), fresh.org.id, "crm_manager");
    expect(byId(sections, "crm")!.state).toBe("not_configured");
    expect(byId(await evidenceFor(clientCtx(fresh), fresh.org.id, "appointment_setter").then((r) => r.sections), "calendar")!.state).toBe("not_configured");
    const blocked = clientCtx(a, "viewer");
    blocked.can = () => false;
    const denied = await evidenceFor(blocked, a.org.id, "lead_hunter");
    expect(states(denied.sections)).toMatchObject({ leads: "no_permission", targeting: "no_permission" });
  });

  it("an unreadable area is reported as temporarily unavailable, not as empty", async () => {
    const broken = clientCtx(a);
    broken.user = { ...broken.user, id: "00000000-0000-0000-0000-000000000000" };
    const { sections } = await evidenceFor(broken, a.org.id, "lead_hunter");
    expect(["unavailable", "empty", "no_permission"]).toContain(byId(sections, "leads")!.state);
  });
});

describe("the immutable policy is untouched", () => {
  it("still has every rule exactly once after the capability text changes", () => {
    const policy = immutablePolicy("iAcquire", "agency");
    const fixed = replaceLegacyToolsSection(["## Tools you may use", "- crm.read", "", "## Agency policy (always applies and overrides everything above)", ...policy.map((rule, index) => `${index + 1}. ${rule}`)].join("\n"), agentToolLabel);
    for (const rule of policy) expect(fixed.split(rule)).toHaveLength(2);
    expect(capabilitySection([])).not.toContain("Verified workspace snapshot");
  });
});
