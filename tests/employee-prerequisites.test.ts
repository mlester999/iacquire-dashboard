import { describe, expect, it } from "vitest";
import { crmReadyFromEvidence } from "@/lib/employee-requirements";
import { hasExplicitTargeting, targetingSchema } from "@/lib/leads-targeting";
import { loadWorkspaceFacts } from "@/server/workforce/readiness-facts";
import { withSystem } from "@/server/db";
import { createOrg } from "./support/fixtures";

describe("employee business prerequisites", () => {
  it("treats an available native CRM as ready with zero records and no applied Blueprint", async () => {
    const client = await createOrg({ name: "Empty native CRM" });
    const facts = await withSystem((db) => loadWorkspaceFacts(db, client.id));
    expect(facts.crmReady).toBe(true);
  });

  it("treats the internal agency native CRM as available before its lazy workspace row exists", async () => {
    const agency = await createOrg({ name: "Internal agency CRM", kind: "agency" });
    const facts = await withSystem((db) => loadWorkspaceFacts(db, agency.id));
    expect(facts.crmReady).toBe(true);
    expect(facts.pipelineReady).toBe(false);
  });

  it("counts real targeting constraints but not form defaults", () => {
    expect(hasExplicitTargeting({})).toBe(false);
    expect(hasExplicitTargeting(targetingSchema.parse({}))).toBe(false);
    expect(hasExplicitTargeting({ minimumCriteria: "Service businesses that need lead acquisition or CRM workflows." })).toBe(true);
    expect(hasExplicitTargeting({ customerType: "b2c" })).toBe(true);
  });

  it("requires verified provider linkage for external CRM modes", () => {
    expect(crmReadyFromEvidence({
      organizationKind: "client", workspaceExists: false, mode: null, contactsProvider: null, verifiedGhlConnection: false,
    })).toBe(false);
    expect(crmReadyFromEvidence({
      organizationKind: "client", workspaceExists: true, mode: "ghl", contactsProvider: null, verifiedGhlConnection: false,
    })).toBe(false);
    expect(crmReadyFromEvidence({
      organizationKind: "client", workspaceExists: true, mode: "ghl", contactsProvider: null, verifiedGhlConnection: true,
    })).toBe(true);
  });
});
