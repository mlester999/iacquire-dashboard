// A first set of lead-targeting rules from the client's own questionnaire answers: only their words, only where a rule means what the answer says, never over rules that exist, and the
// Lead Hunter's "lead targeting saved" requirement is met by it. Test database only.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { hasExplicitTargeting } from "@/lib/leads-targeting";
import { planLeadTargeting } from "@/lib/onboarding/lead-targeting-draft";
import { proposeLeadTargeting } from "@/server/onboarding/lead-targeting-draft";
import { loadWorkspaceFacts } from "@/server/workforce/readiness-facts";
import type { Answers } from "@/lib/onboarding/types";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { submitRealOnboarding } from "./support/billing";

const answers = (over: Answers = {}): Answers => ({
  "a.territories": "Austin, Texas",
  "b.services": "Roof repair and inspection",
  "b.ideal_customer": "Austin homeowners with storm damage",
  "b.qualification": "Owns the home and the damage is covered by insurance.",
  ...over,
});

describe("what the answers support", () => {
  it("uses only the client's own words, in the fields that mean what they said", () => {
    const plan = planLeadTargeting(answers())!;
    expect(plan.from).toEqual(["a.territories", "b.services", "b.ideal_customer", "b.qualification"]);
    expect(plan.targeting).toMatchObject({
      regions: ["Austin", "Texas"],
      servicesNeeded: ["Roof repair and inspection"],
      keywords: ["Austin homeowners with storm damage"],
      minimumCriteria: "Owns the home and the damage is covered by insurance.",
    });
    // Nothing is inferred: no industry, country, size, signal or exclusion, and the customer type keeps its default.
    expect(plan.targeting).toMatchObject({ industries: [], countries: [], buyingSignals: [], excluded: [], businessSize: "any", customerType: "b2b" });
    expect(hasExplicitTargeting(plan.targeting)).toBe(true);
  });

  it("splits lines and semicolons before commas, drops duplicates, and leaves out an entry too long to store instead of cutting it", () => {
    const long = "x".repeat(130);
    const plan = planLeadTargeting(answers({ "b.services": `Roof repair\n- Gutter cleaning; roof repair\n${long}`, "a.territories": "Austin; Round Rock\nCedar Park" }))!;
    expect(plan.targeting.servicesNeeded).toEqual(["Roof repair", "Gutter cleaning"]);
    expect(plan.targeting.regions).toEqual(["Austin", "Round Rock", "Cedar Park"]);
    expect(planLeadTargeting(answers({ "b.ideal_customer": long }))!.targeting.keywords).toEqual([]);
  });

  it("drafts nothing when the answers say nothing about who to look for", () => {
    expect(planLeadTargeting({})).toBeNull();
    expect(planLeadTargeting({ "a.territories": "  ", "b.services": 42 as unknown as string })).toBeNull();
    // An answer that names the business but not the customers is not a targeting rule.
    expect(planLeadTargeting({ "a.business_name": "Brightside Roofing", "a.description": "We repair roofs." })).toBeNull();
  });
});

describe("saving it", () => {
  async function workspace() {
    const org = await createOrg({ name: "Targeting Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    return { org, ctx: { orgId: org.id, userId: owner.id } };
  }
  const run = <T>(fn: (db: Parameters<Parameters<typeof withSystem>[0]>[0]) => Promise<T>) => withSystem(fn);

  it("fills an empty profile once, records where it came from, and never replaces the client's own rules", async () => {
    const { org, ctx } = await workspace();
    expect(await run((db) => proposeLeadTargeting(db, ctx, answers()))).toMatchObject({ state: "created", from: ["a.territories", "b.services", "b.ideal_customer", "b.qualification"] });
    const stored = (await run((db) => db.query<{ criteria: { regions: string[] } }>("select criteria from lead_targeting_profiles where org_id = $1", [org.id]))).rows;
    expect(stored[0].criteria.regions).toEqual(["Austin", "Texas"]);
    const audit = await run((db) => db.query<{ metadata: { from: string[] } }>("select metadata from audit_logs where org_id = $1 and action = 'onboarding.lead_targeting_drafted'", [org.id]));
    expect(audit.rows).toHaveLength(1);

    // The client edits the rules; a later submission with different answers leaves their edit alone.
    await run((db) => db.query("update lead_targeting_profiles set criteria = $2::jsonb where org_id = $1", [org.id, JSON.stringify({ industries: ["Insurance brokers"] })]));
    expect(await run((db) => proposeLeadTargeting(db, ctx, answers({ "a.territories": "Dallas" })))).toMatchObject({ state: "kept" });
    const after = (await run((db) => db.query<{ criteria: { industries: string[]; regions?: string[] } }>("select criteria from lead_targeting_profiles where org_id = $1", [org.id]))).rows[0];
    expect(after.criteria).toEqual({ industries: ["Insurance brokers"] });
    expect(Number((await run((db) => db.query<{ n: string }>("select count(*) as n from audit_logs where org_id = $1 and action = 'onboarding.lead_targeting_drafted'", [org.id]))).rows[0].n)).toBe(1);
  });

  it("skips quietly, without a profile, when the answers support none", async () => {
    const { org, ctx } = await workspace();
    expect(await run((db) => proposeLeadTargeting(db, ctx, {}))).toMatchObject({ state: "skipped" });
    expect((await run((db) => db.query("select 1 from lead_targeting_profiles where org_id = $1", [org.id]))).rows).toHaveLength(0);
  });
});

describe("through a real submission", () => {
  it("meets the Lead Hunter's targeting requirement from the client's answers and keeps two clients' rules apart", async () => {
    const a = await submitRealOnboarding({ name: "Targeting Roofing A", clearPayment: true });
    const b = await submitRealOnboarding({ name: "Targeting Roofing B", clearPayment: true });
    for (const c of [a, b]) {
      const facts = await withSystem((db) => loadWorkspaceFacts(db, c.org.id));
      expect(facts.leadTargetingSet).toBe(true);
      const rows = (await withSystem((db) => db.query<{ criteria: { regions: string[]; servicesNeeded: string[] } }>("select criteria from lead_targeting_profiles where org_id = $1", [c.org.id]))).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].criteria.regions).toEqual(["Austin", "Texas"]);
      expect(rows[0].criteria.servicesNeeded).toEqual(["Roof repair and inspection"]);
    }
    // Submitting again changes nothing and adds no second profile or audit entry.
    const { submitOnboarding } = await import("@/server/onboarding/service");
    await submitOnboarding(a.ctx);
    expect(Number((await withSystem((db) => db.query<{ n: string }>("select count(*) as n from audit_logs where org_id = $1 and action = 'onboarding.lead_targeting_drafted'", [a.org.id]))).rows[0].n)).toBe(1);
  }, 120_000);
});
