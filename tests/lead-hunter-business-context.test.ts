import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createOrg } from "./support/fixtures";
import { loadCompanyContext } from "@/server/workforce/service";
import { compileAgentConfig, defaultSettings } from "@/server/workforce/compiler";
import { parseResearchOutput, researchPrompt } from "@/server/leads/research-contract";
import { targetingSchema } from "@/lib/leads-targeting";

describe("Lead Hunter business context", () => {
  it("uses the approved iAcquire profile only for the internal agency workspace", async () => {
    const agency = await createOrg({ name: "iAcquire", kind: "agency" });
    await withSystem((db) =>
      db.query(
        "update company_profiles set description = '', services = '', ideal_customers = '', operating_area = '' where org_id = $1",
        [agency.id],
      ),
    );
    const context = await withSystem((db) => loadCompanyContext(db, agency.id));
    expect(context.orgKind).toBe("agency");
    expect(context.description).toContain("AI-powered client acquisition");
    expect(context.services).toContain("iAcquireOS");
    expect(context.idealCustomers).toContain("Small and growing service businesses");
    expect(context.operatingArea).toContain("United States");

    // A confirmed value is never overwritten; only the still-empty fields fall back.
    await withSystem((db) => db.query("update company_profiles set description = 'Confirmed internal description.' where org_id = $1", [agency.id]));
    const confirmed = await withSystem((db) => loadCompanyContext(db, agency.id));
    expect(confirmed.description).toBe("Confirmed internal description.");
    expect(confirmed.services).toContain("iAcquireOS");
  });

  it("keeps a client's own facts and never substitutes iAcquire's", async () => {
    const client = await createOrg({ name: "Northwind Roofing", kind: "client" });
    await withSystem((db) =>
      db.query(
        "update company_profiles set description = 'We repair and replace roofs for local homeowners.', services = 'Roof repair and replacement', ideal_customers = 'Homeowners in the Denver metro', operating_area = 'Denver, Colorado' where org_id = $1",
        [client.id],
      ),
    );
    const context = await withSystem((db) => loadCompanyContext(db, client.id));
    expect(context.orgKind).toBe("client");
    expect(context.description).toContain("repair and replace roofs");
    expect(context.services).toContain("Roof repair");
    expect(context.idealCustomers).toContain("Denver metro");
    expect(context.description).not.toContain("iAcquireOS");
    expect(context.idealCustomers).not.toContain("Small and growing service businesses");
  });

  it("leaves a client's missing facts missing so the employee must ask", async () => {
    const client = await createOrg({ name: "Empty Client", kind: "client" });
    await withSystem((db) =>
      db.query(
        "update company_profiles set description = '', services = '', ideal_customers = '', operating_area = '' where org_id = $1",
        [client.id],
      ),
    );
    const context = await withSystem((db) => loadCompanyContext(db, client.id));
    expect(context).toMatchObject({ orgKind: "client", description: "", services: "", idealCustomers: "", operatingArea: "" });
  });

  it("adds internal prospecting defaults to the compiled Lead Hunter instructions only for the agency", async () => {
    const agencyCompany = {
      companyName: "iAcquire",
      orgKind: "agency" as const,
      description: "AI-powered client acquisition and business operations.",
      services: "iAcquireOS",
      idealCustomers: "Small service businesses",
      operatingArea: "United States",
    };
    const agency = compileAgentConfig({
      role: "lead_hunter",
      settings: defaultSettings("lead_hunter"),
      company: agencyCompany,
      version: 1,
      allowedTools: [],
    });
    expect(agency.instructions).toContain("Approved internal prospecting profile");
    expect(agency.instructions).toContain("Real estate agencies and brokerages");
    expect(agency.instructions).toContain("iAcquireOS");

    const client = compileAgentConfig({
      role: "lead_hunter",
      settings: defaultSettings("lead_hunter"),
      company: {
        companyName: "Northwind Roofing",
        orgKind: "client",
        description: "Roof repair",
        services: "Roof replacement",
        idealCustomers: "Homeowners",
        operatingArea: "Denver",
      },
      version: 1,
      allowedTools: [],
    });
    expect(client.instructions).not.toContain("Approved internal prospecting profile");
    expect(client.instructions).not.toContain("iAcquireOS");
  });

  it("puts the tenant's own business context and defaults into the research prompt", () => {
    const agencyPrompt = researchPrompt("Find 20 prospects", targetingSchema.parse({}), "business", {
      companyName: "iAcquire",
      orgKind: "agency",
      description: "AI-powered client acquisition and business operations.",
      services: "iAcquireOS",
      idealCustomers: "Small service businesses",
      operatingArea: "United States",
    });
    expect(agencyPrompt).toContain("Business this research is for:");
    expect(agencyPrompt).toContain("iAcquireOS");
    expect(agencyPrompt).toContain("Real estate agencies and brokerages");
    expect(agencyPrompt).toContain("United States");

    const clientPrompt = researchPrompt("Find 20 prospects", targetingSchema.parse({}), "business", {
      companyName: "Northwind Roofing",
      orgKind: "client",
      description: "We repair roofs for local homeowners.",
      services: "Roof repair and replacement",
      idealCustomers: "Homeowners",
      operatingArea: "Denver",
    });
    expect(clientPrompt).toContain("Northwind Roofing");
    expect(clientPrompt).toContain("We repair roofs");
    expect(clientPrompt).not.toContain("iAcquireOS");
    expect(clientPrompt).not.toContain("Real estate agencies and brokerages");

    const targeted = researchPrompt("Find 20 prospects", targetingSchema.parse({ industries: ["Dentists"], excluded: ["Franchises"] }), "business", {
      companyName: "Northwind Roofing",
      orgKind: "client",
      description: "We repair roofs for local homeowners.",
      services: "Roof repair and replacement",
    });
    expect(targeted).toContain("Dentists");
    expect(targeted).toContain("Franchises");
    expect(targeted).not.toContain("Real estate agencies and brokerages");
  });

  it("tells the employee to ask when a client's business context is missing", () => {
    const prompt = researchPrompt("Find 20 prospects", targetingSchema.parse({}), "business", {
      companyName: "Empty Client",
      orgKind: "client",
      description: "",
      services: "",
    });
    expect(prompt).toContain("has not confirmed its business description");
    expect(prompt).not.toContain("iAcquireOS");
  });

  it("keeps model notes from overriding server-owned CRM, queue and evidence-time facts", () => {
    const output = parseResearchOutput(JSON.stringify({
      leads: [{
        business_name: "Miami Realty Group",
        website: "https://miami-realty.example",
        industry: "Real estate brokerage",
        location: "Miami, Florida",
        evidence: [{
          url: "https://miami-realty.example/about",
          observed_at: "2026-10-21T00:00:00Z",
          summary: "The company describes its Miami brokerage services.",
        }],
        qualification_summary: "The company operates a Miami brokerage with a public website. CRM duplicate check not performed because no CRM tool was available in this session, and the result was not persisted to a review queue.",
        score: { service_fit: 10, market_fit: 10, source_quality: 5 },
      }],
    }));

    expect(output.error).toBeNull();
    expect(output.leads[0].qualification_summary).toBe("The company operates a Miami brokerage with a public website.");
    expect(output.leads[0].evidence[0].observed_at).toBeNull();

    const unsupportedOnly = parseResearchOutput(JSON.stringify({
      leads: [{
        business_name: "Another Realty Group",
        evidence: [],
        qualification_summary: "Duplicate check not performed; no review queue tool was available.",
      }],
    }));
    expect(unsupportedOnly.leads[0].qualification_summary).toBeNull();
  });
});
