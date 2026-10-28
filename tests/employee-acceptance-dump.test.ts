// Assembles, for a real-model acceptance run, the exact instructions each AI employee receives, from SYNTHETIC data in the in-memory test database. It writes JSON and does nothing else:
// no provider is called here. It runs only when EMPLOYEE_ACCEPTANCE_DUMP names an output folder, so the normal suite skips it.
//
//   EMPLOYEE_ACCEPTANCE_DUMP=<folder> npx vitest run tests/employee-acceptance-dump.test.ts
//   node --env-file-if-exists=... --import tsx scripts/employee-real-model-acceptance.ts --dump <folder> --env-file <file with LLM_* lines>
//
// "control" is how production behaved before the fix: the stored configuration with its tool list, no workspace snapshot. "fixed" is what a run is now given.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { listPipelines } from "@/server/crm/pipelines";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { bookNativeAppointment } from "@/server/calendars/booking";
import { prepareEmployeeEvidence } from "@/server/workforce/employee-evidence";
import { composeRunInstructions } from "@/server/workforce/service";
import { compileAgentConfig, defaultSettings } from "@/server/workforce/compiler";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { agentToolLabel } from "@/lib/agent-tools";
import { capabilitySection, insertEvidenceBlock } from "@/lib/employee-evidence";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

const OUT = process.env.EMPLOYEE_ACCEPTANCE_DUMP;
const MANILA = "Asia/Manila";
const NOW = new Date("2026-10-19T00:00:00Z"); // Monday, 08:00 in Manila

const QUESTIONS: Record<AgentRoleKey, string> = {
  operations_manager: "What operational tasks or issues currently need attention?",
  lead_hunter: "How many researched leads do we currently have, and what is their status?",
  appointment_setter: "What appointments do I have this week?",
  sales_assistant: "How's our sales pipeline looking?",
  crm_manager: "How's our CRM right now?",
  performance_analyst: "What can you tell me about our business performance?",
};

interface Scenario {
  id: string;
  state: string;
  role: AgentRoleKey;
  variant: "control" | "fixed";
  question: string;
  instructions: string;
  expect: Record<string, unknown>;
}

describe.skipIf(!OUT)("real-model acceptance inputs", () => {
  const scenarios: Scenario[] = [];
  let org: Awaited<ReturnType<typeof createOrg>>;
  let ctx: ReturnType<typeof ctxFor>;

  async function build(state: string, role: AgentRoleKey, expectations: Record<string, unknown>) {
    const id = await agentId(org.id, role);
    const tools = (await withSystem((db) => db.query<{ default_tools: string[] }>("select default_tools from agent_roles where key = $1", [role]))).rows[0].default_tools;
    const company = { companyName: "iAcquire", orgKind: "agency" as const, description: "AI-powered client acquisition and business operations for small service businesses.", services: "iAcquireOS, AI employees, native CRM", idealCustomers: "Small and growing service businesses" };
    const compiled = compileAgentConfig({ role, settings: defaultSettings(role), company, version: 3, allowedTools: tools }).instructions;
    // The stored configuration as production has it today: the capability labels listed under "Tools you may use".
    const legacy = compiled.replace(capabilitySection(tools.map(agentToolLabel)), ["## Tools you may use", ...tools.map((t) => `- ${t}`), "Use only these tools, and only when they help answer the request."].join("\n"));
    expect(legacy).toContain("## Tools you may use");
    const composed = await withSystem((db) => composeRunInstructions(db, org.id, id, legacy, null, { kind: "agency", name: "iAcquire" }));
    const evidence = await prepareEmployeeEvidence(ctx, { agentId: id, roleKey: role, now: NOW });
    const base = { state, role, question: QUESTIONS[role], expect: expectations };
    scenarios.push({ ...base, id: `${state}:${role}:control`, variant: "control", instructions: legacy });
    scenarios.push({ ...base, id: `${state}:${role}:fixed`, variant: "fixed", instructions: insertEvidenceBlock(composed.instructions, evidence.block) });
  }

  beforeAll(async () => {
    org = await createOrg({ name: "iAcquire", kind: "agency" });
    const user = await createUser({ platformRole: "agency_super_admin", name: "Mark" });
    await addMember(org.id, user.id, "owner");
    ctx = ctxFor(user, org, "owner");
    ctx.org.kind = "agency";
    ctx.org.timezone = MANILA;
    ctx.user.platformRole = "agency_super_admin";
    const actor = memberActor(ctx);
    await getWorkspace(actor);
    await listPipelines(actor, { ensureDefault: true });
    await withSystem((db) => db.query("update organizations set timezone = $2 where id = $1", [org.id, MANILA]));

    // State 0: nothing has been recorded anywhere yet. Empty native CRM, no calendar, no leads, no targeting rules.
    for (const role of ["performance_analyst", "lead_hunter", "operations_manager"] as const) {
      await build("nothing-recorded", role, { contacts: 0, deals: 0, leads: 0, calendar: "not_configured" });
    }

    // State 1: today's production state. Empty native CRM, no booking calendar, ten researched leads and saved targeting.
    await withSystem(async (db) => {
      await db.query("insert into lead_targeting_profiles (org_id, criteria) values ($1, $2)", [org.id, JSON.stringify({ industries: ["Marketing agencies"], countries: ["US"], minimumCriteria: "Has a working website" })]);
      for (let i = 1; i <= 10; i++) {
        await db.query(
          "insert into leads (org_id, business_name, domain, industry, location, score, review_status, duplicate_status) values ($1, $2, $3, 'Marketing', 'Austin', $4, 'pending', $5)",
          [org.id, `Researched Lead ${i}`, `lead${i}.example.test`, 50 + i, i === 4 ? "possible_duplicate" : "no_match"],
        );
      }
    });
    for (const role of AGENT_ROLE_KEYS) {
      await build("empty-crm-no-calendar", role, {
        contacts: 0, deals: 0, calendar: "not_configured", leads: 10, leadsPending: 10, possibleDuplicates: 1,
      });
    }

    // State 2: the proposed consultation calendar is saved and activated, one appointment is booked this week and one deal exists.
    const calendar = await createCalendar(actor, { name: "Consultations", members: [{ userId: user.id }], isDefault: true });
    await setHostAvailability(actor, user.id, { timezone: MANILA, rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })) });
    const type = await createAppointmentType(actor, calendar.id, { name: "Consultation", durationMinutes: 30, bufferAfterMinutes: 15, minNoticeMinutes: 1440, maxDaysAhead: 30 });
    await bookNativeAppointment(actor, { typeId: type.id, startAt: new Date("2026-10-22T10:00:00+08:00"), contact: { firstName: "Ana", lastName: "Reyes", email: "ana@example.test" }, via: "staff", now: NOW });
    const mia = await createContact(actor, { firstName: "Mia", lastName: "Santos", email: "mia@example.test" });
    await createOpportunity(actor, { name: "Website refresh", contactId: mia.id, value: 1200, currency: "USD" } as never);
    for (const role of ["appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"] as const) {
      await build("calendar-active-with-data", role, { appointmentThisWeek: "Ana Reyes", appointmentWhen: "Thursday", deals: 1, contacts: 2, dealValue: "1,200" });
    }
  }, 120_000);

  it("writes every scenario's instructions", () => {
    fs.mkdirSync(OUT!, { recursive: true });
    fs.writeFileSync(path.join(OUT!, "scenarios.json"), JSON.stringify(scenarios, null, 2));
    expect(scenarios.length).toBe((3 + AGENT_ROLE_KEYS.length + 4) * 2);
  });
});
