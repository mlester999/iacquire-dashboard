import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AI_GROWTH_PARTNER_CAPABILITY_INFO } from "@/lib/ai-growth-partner";
import { faqs } from "@/lib/demo/showroom/content";
import { OVERSIGHT_FOOTER } from "@/lib/demo/showroom/capabilities";
import { INFLUENCER_PLATFORM_ADAPTERS, INFLUENCER_RESEARCH_AVAILABLE } from "@/lib/leads-targeting";
import { RESEARCH_SOURCE_KEYS } from "@/lib/lead-research-sources";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("public capability claims", () => {
  it("offers influencer platforms only when a research adapter exists", () => {
    const leadUi = read("src/components/leads/leads-workspace.tsx");

    expect(INFLUENCER_RESEARCH_AVAILABLE).toBe(INFLUENCER_PLATFORM_ADAPTERS.length > 0);
    expect(INFLUENCER_RESEARCH_AVAILABLE).toBe(false);
    expect(INFLUENCER_PLATFORM_ADAPTERS).toEqual([]);
    expect(leadUi).toContain("INFLUENCER_PLATFORM_ADAPTERS.map");
    expect(leadUi).toContain("disabled: !INFLUENCER_RESEARCH_AVAILABLE");
    expect(leadUi).toContain("Influencer partners (not available yet)");
    expect(leadUi).toContain("disabled={!canEdit || !INFLUENCER_RESEARCH_AVAILABLE}");
    expect(leadUi).toContain("Influencer research requires an approved platform adapter.");
    expect(RESEARCH_SOURCE_KEYS).toEqual(["openstreetmap", "company_website", "fsa_directory"]);
    expect(RESEARCH_SOURCE_KEYS.some((source) => /instagram|tiktok|youtube|linkedin|social|influencer/i.test(source))).toBe(false);
  });

  it("qualifies claims about connected channels and approval rules", () => {
    const summary = read("src/components/demo/showroom/views/summary.tsx");
    const inbox = read("src/components/demo/showroom/views/inbox.tsx");
    const landing = read("src/components/demo/landing-sections.tsx");
    const leadUi = read("src/components/leads/leads-workspace.tsx");
    const approvalFaq = faqs("US$1,499", "US$299").find((faq) => /message my customers/i.test(faq.q))?.a ?? "";

    expect(summary).toContain("The channels you connect land in one inbox, connected to one CRM");
    expect(inbox).toContain("from the channels you connect arrive in one inbox");
    expect(landing).toContain("Illustrative only. No prospect is researched or saved here; customer-facing actions follow your approval rules.");
    expect(leadUi).toContain("Growth Partner Settings");
    expect(leadUi).not.toContain("AI Growth Partner settings");
    for (const copy of [approvalFaq, OVERSIGHT_FOOTER, AI_GROWTH_PARTNER_CAPABILITY_INFO.sales_outreach.description, inbox]) {
      expect(copy).toMatch(/approval rules/i);
      expect(copy).not.toMatch(/anything that reaches a customer waits for the required approval/i);
    }
  });
});
