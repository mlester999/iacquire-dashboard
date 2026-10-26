// The stand-in AI provider used for browser QA of AI proposals (scripts/proposals-mock-llm.mjs). It must answer in exactly the shape the real prompt asks for, name only price
// book items it was shown, and write nothing that the product's own checks would remove, so a person trying the AI button in the browser sees a normal, clean draft. If the
// prompt changes, this test says so before QA is confused by it.
import { describe, expect, it } from "vitest";
import { proposalsAnswer } from "../scripts/proposals-mock-llm.mjs";
import { aiSystemPrompt, aiUserPrompt, allowedNumberSet, normalizeAiOutput, plainAmount, screenList, screenText, type PriceBookEntry } from "@/lib/proposals/ai";
import { unsupportedClaims } from "@/server/social/claims";
import { draftProposalWithAi } from "@/server/proposals/ai";
import { createCatalogItem } from "@/server/proposals/catalog";
import { AI_CONFIG, enableAi, proposalOrg } from "./support/proposals";

const book: PriceBookEntry[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Seasonal tune-up", description: "A full check", unitLabel: "visit", unitPriceMinor: 18_900, billing: "one_time" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Emergency call-out", description: "At the door in the hour", unitLabel: "call", unitPriceMinor: 12_000, billing: "one_time" },
  { id: "33333333-3333-4333-8333-333333333333", name: "Maintenance plan", description: "Two visits a year", unitLabel: "month", unitPriceMinor: 4_900, billing: "monthly" },
];
const prompts = (brief: string | null) => ({
  system: aiSystemPrompt({ business: "Harbor Home", knowledge: "", voiceNote: null }),
  user: aiUserPrompt({ currency: "USD", customer: "Name: Elena Alvarez", deal: null, brief, priceBook: book, templateHeadings: [], templateItems: [] }),
});

describe("the proposals stand-in provider", () => {
  it("answers a drafting prompt with items from the price book it was shown, and no price", () => {
    const { system, user } = prompts(null);
    const out = normalizeAiOutput(JSON.parse(proposalsAnswer(system, user) as string));
    expect(out?.items.map((i) => i.catalogItemId)).toEqual([book[0].id, book[1].id]);
    expect(out?.items.every((i) => i.quantity === 1)).toBe(true);
    // Only the five fields the prompt asks for, and on an item only the id, the quantity and the note: nowhere for a price.
    const raw = JSON.parse(proposalsAnswer(system, user) as string);
    expect(Object.keys(raw).sort()).toEqual(["assumptions", "intro", "items", "nextSteps", "scopeSummary"]);
    for (const item of raw.items) expect(Object.keys(item).sort()).toEqual(["catalogItemId", "note", "quantity"]);
    expect(JSON.stringify([raw.intro, raw.scopeSummary, raw.assumptions, raw.nextSteps])).not.toMatch(/\d/);
  });

  it("picks the items the brief names", () => {
    const { system, user } = prompts("We would like the maintenance plan please.");
    const out = normalizeAiOutput(JSON.parse(proposalsAnswer(system, user) as string));
    expect(out?.items.map((i) => i.catalogItemId)).toEqual([book[2].id]);
  });

  it("keeps quiet about anything that is not a proposal prompt", () => {
    expect(proposalsAnswer("You write social media posts.", "Suggest ideas.")).toBeNull();
  });

  it("writes nothing the product's checks would take out", () => {
    const { system, user } = prompts(null);
    const out = normalizeAiOutput(JSON.parse(proposalsAnswer(system, user) as string));
    expect(out).not.toBeNull();
    if (!out) return;
    const checks = { allowed: allowedNumberSet(book.map((b) => plainAmount(b.unitPriceMinor, "USD"))), claims: (t: string) => unsupportedClaims(t, book.map((b) => `${b.name} ${b.description}`).join("\n")) };
    expect(screenText("intro", out.intro, 1200, checks).dropped).toEqual([]);
    expect(screenText("scope", out.scopeSummary, 2000, checks).dropped).toEqual([]);
    expect(screenList("assumption", out.assumptions, checks).dropped).toEqual([]);
    expect(screenList("next step", out.nextSteps, checks).dropped).toEqual([]);
    expect(out.assumptions.length + out.nextSteps.length).toBe(4);
  });

  it("makes a clean AI draft end to end through the real service", async () => {
    const p = await proposalOrg();
    await enableAi(p);
    const tuneup = await createCatalogItem(p.actor("owner"), { name: "Seasonal tune-up", description: "A full check", unitLabel: "visit", unitPriceMinor: 18_900, currency: "USD" });
    // The stand-in sees the same prompts the service builds and answers them.
    const complete = (async (_c: unknown, input: { system: string; user: string }) => ({ ok: true as const, text: proposalsAnswer(input.system, input.user) as string })) as never;
    const out = await draftProposalWithAi(p.actor("sales"), { brief: "A tune-up please." }, { complete, config: async () => AI_CONFIG });
    expect(out.dropped).toEqual([]);
    expect(out.rejectedItems).toBe(0);
    expect(out.proposal.doc.lines.map((l) => l.catalogItemId)).toContain(tuneup.id);
    expect(out.proposal.origin).toBe("ai");
    expect(out.proposal.doc.sections.map((s) => s.heading)).toEqual(["Introduction", "Scope", "Assumptions", "Next steps"]);
  });
});
