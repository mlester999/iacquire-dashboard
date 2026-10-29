// A controlled client onboarding, checked for what it must NOT claim: the new client's knowledge is its own and is reported as partial, its six employees are Pending Setup with their CRM and
// calendar requirements honestly unmet, and what an employee is later told about the workspace carries nothing from another client. Test database only; no Hermes writes.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { blockingUnmet } from "@/lib/employee-requirements";
import { summarizeKnowledge } from "@/lib/knowledge-sections";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { prepareEmployeeEvidence } from "@/server/workforce/employee-evidence";
import { loadWorkspaceFacts, readinessExtrasFor } from "@/server/workforce/readiness-facts";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

async function onboard(name: string, description: string, service: string, customer: string) {
  const org = await createOrg({ name });
  await clearSetupPayment(org.id);
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, org, "owner");
  const answers = {
    "a.business_name": name,
    "a.industry": "home_services",
    "a.business_model": "local",
    "a.description": description,
    "a.timezone": "America/Chicago",
    "a.contact_email": owner.email,
    "a.territories": "Austin, Texas",
    "a.target_customers": customer,
    "b.goals": ["more_leads", "more_appointments"],
    "b.services": service,
    "b.ideal_customer": customer,
    "b.appointments": true,
    "b.website_need": "have",
    "d.pricing_policy": "never",
    "f.review": true,
  };
  const saved = await saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])), currentQuestionId: "f.review" });
  expect(saved.rejected).toEqual({});
  await submitOnboarding(ctx);
  const { rows: agents } = await withSystem((db) => db.query<{ id: string; role_key: AgentRoleKey; status: string; hermes_profile: string | null }>(
    "select id, role_key, status, hermes_profile from agent_instances where org_id = $1 order by role_key", [org.id],
  ));
  return { org, owner, ctx, agents };
}

describe("a controlled client onboarding never claims more than it has", () => {
  it("keeps each client's knowledge its own and partial, leaves its employees Pending Setup, and reports unmet requirements", async () => {
    const roofing = await onboard("Brightside Roofing", "We repair residential roofs after storm damage.", "Roof repair and inspection", "Austin homeowners");
    const plumbing = await onboard("Harbor Plumbing", "We repair plumbing systems for local homes.", "Pipe repair and drain cleaning", "Austin property owners");

    for (const [client, other] of [[roofing, plumbing], [plumbing, roofing]] as const) {
      // Six isolated employee records, none connected to a runtime yet.
      expect(client.agents.map((a) => a.role_key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
      expect(client.agents.every((a) => a.status !== "online" && a.hermes_profile === null)).toBe(true);

      // Company knowledge belongs to this client alone, and onboarding on its own never completes it.
      const { rows } = await withSystem((db) => db.query<{ section: string; content: string; review_status: string }>(
        "select section, content, review_status from company_knowledge where org_id = $1", [client.org.id],
      ));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.content).join(" ")).not.toContain(other.org.name);
      const summary = summarizeKnowledge(rows.map((r) => ({ section: r.section, filled: r.content.trim() !== "", review_status: r.review_status })));
      expect(summary.supplied).toBeLessThan(summary.total);

      // The facts the checklist and the employees are given agree with what is stored.
      const facts = await withSystem((db) => loadWorkspaceFacts(db, client.org.id));
      expect(facts.knowledge).toEqual(summary);

      // Requirements are judged from real records: a calendar nobody has activated is not a calendar that takes bookings.
      const extras = await readinessExtrasFor(client.org.id, client.agents);
      const unmet = (role: AgentRoleKey) => blockingUnmet(extras.get(client.agents.find((a) => a.role_key === role)!.id)?.requirements).map((r) => r.key);
      expect(unmet("appointment_setter")).toContain("calendar");
      expect(facts.calendarReady).toBe(false);
      expect(facts.customerChannelReady).toBe(false);
    }
  }, 120_000);

  it("an employee of a new client is told its own workspace's state only, with honest counts and nothing from another client", async () => {
    const roofing = await onboard("Skyline Roofing", "We repair residential roofs after storm damage.", "Roof repair and inspection", "Austin homeowners");
    const plumbing = await onboard("Anchor Plumbing", "We repair plumbing systems for local homes.", "Pipe repair and drain cleaning", "Austin property owners");
    const setter = roofing.agents.find((a) => a.role_key === "appointment_setter")!;
    const prepared = await prepareEmployeeEvidence(roofing.ctx, { agentId: setter.id, roleKey: "appointment_setter" });
    const byId = Object.fromEntries(prepared.evidence.sections.map((s) => [s.id, s]));

    expect(prepared.evidence.workspace).toEqual({ name: "Skyline Roofing", kind: "client" });
    expect(byId.calendar.state).toBe("not_configured");
    expect(byId.knowledge.state).toBe("ready");
    const facts = await withSystem((db) => loadWorkspaceFacts(db, roofing.org.id));
    expect(byId.knowledge.facts).toMatchObject({ sectionsSupplied: facts.knowledge!.supplied, sectionsAsked: 9 });
    expect(byId.knowledge.facts.complete).toBe(false);
    expect(prepared.block).not.toContain(plumbing.org.name);
    expect(prepared.block).not.toMatch(/Harbor|Anchor Plumbing|plumbing systems/);

    // Another client's employee id, or the wrong role, reads nothing for this client's person.
    const foreign = await prepareEmployeeEvidence(roofing.ctx, { agentId: plumbing.agents.find((a) => a.role_key === "appointment_setter")!.id, roleKey: "appointment_setter" });
    expect(foreign.evidence.sections.every((s) => s.state === "unavailable")).toBe(true);
    expect(foreign.block).not.toMatch(/Anchor Plumbing|plumbing systems/);
  }, 120_000);
});
