// The ideas offered on the Automation Studio home screen: each is a plain request for the builder, so what matters is that they are well formed, that
// the readiness text tells the truth about the workspace, and that search finds them.
import { describe, expect, it } from "vitest";
import { STARTERS, STARTER_CATEGORIES, searchStarters, starterReadiness } from "@/lib/automation-studio/starters";
import type { EditorOptions } from "@/components/crm/workflows/types";

const NEEDS = ["template", "review_template", "employee", "pipeline", "calendar", "slack", "http"];
const options = (over: Partial<EditorOptions> = {}) => ({ templates: [], employees: [], pipelines: [], calendars: [], ...over }) as unknown as EditorOptions;

describe("the starters", () => {
  it("are unique, in known categories, and short enough to send", () => {
    expect(new Set(STARTERS.map((s) => s.id)).size).toBe(STARTERS.length);
    for (const s of STARTERS) {
      expect(STARTER_CATEGORIES as readonly string[], s.id).toContain(s.category);
      expect(s.prompt.length, s.id).toBeGreaterThan(20);
      expect(s.prompt.length, s.id).toBeLessThanOrEqual(4000);
      for (const n of s.needs) expect(NEEDS, s.id).toContain(n);
    }
    for (const c of STARTER_CATEGORIES) expect(STARTERS.some((s) => s.category === c), c).toBe(true);
  });

  it("never put message text in the request: messages come from approved templates", () => {
    for (const s of STARTERS) expect(s.prompt, s.id).not.toMatch(/\bsay\b.*["“]/i);
    // Whatever sends a message says it uses an approved one, and needs one to exist.
    for (const s of STARTERS.filter((x) => /\bsend\b/i.test(x.prompt))) {
      expect(s.prompt, s.id).toMatch(/approved/i);
      expect(s.needs.some((n) => n === "template" || n === "review_template"), s.id).toBe(true);
    }
  });
});

describe("readiness", () => {
  const withTemplate = STARTERS.find((s) => s.needs.includes("template") && s.needs.length === 1)!;
  const needsCalendar = STARTERS.find((s) => s.needs.length === 1 && s.needs[0] === "calendar")!;

  it("says a Slack or HTTP idea needs a connection, and is ready once the workspace has one", () => {
    const slack = STARTERS.find((s) => s.needs.includes("slack"))!;
    const http = STARTERS.find((s) => s.needs.includes("http"))!;
    expect(starterReadiness(slack, options())).toEqual({ ready: false, missing: ["a Slack connection"] });
    expect(starterReadiness(http, options())).toEqual({ ready: false, missing: ["an HTTP connection"] });
    // The wrong kind of connection doesn't count.
    expect(starterReadiness(slack, options({ connections: [{ id: "c", kind: "http" }] as never })).ready).toBe(false);
    expect(starterReadiness(slack, options({ connections: [{ id: "c", kind: "slack_webhook" }] as never })).ready).toBe(true);
    expect(starterReadiness(http, options({ connections: [{ id: "c", kind: "http" }] as never })).ready).toBe(true);
  });

  it("is ready when the starter needs nothing, and says exactly what is missing otherwise", () => {
    expect(starterReadiness({ needs: [] }, options())).toEqual({ ready: true, missing: [] });
    expect(starterReadiness(withTemplate, options())).toEqual({ ready: false, missing: ["an approved message template"] });
    expect(starterReadiness(needsCalendar, options())).toEqual({ ready: false, missing: ["a calendar"] });
    expect(starterReadiness({ needs: ["template", "calendar", "pipeline", "employee"] }, options()).missing).toHaveLength(4);
  });

  it("is ready once the workspace has the thing", () => {
    expect(starterReadiness(withTemplate, options({ templates: [{ id: "t" }] as never })).ready).toBe(true);
    expect(starterReadiness(needsCalendar, options({ calendars: [{ id: "c" }] as never })).ready).toBe(true);
    expect(starterReadiness({ needs: ["employee"] }, options({ employees: [{ roleKey: "crm_manager" }] as never })).ready).toBe(true);
    expect(starterReadiness({ needs: ["pipeline"] }, options({ pipelines: [{ id: "p" }] as never })).ready).toBe(true);
  });

  it("wants a review request template specifically, not any template", () => {
    const review = STARTERS.find((s) => s.needs.includes("review_template"))!;
    expect(starterReadiness(review, options({ templates: [{ id: "t", purpose: "marketing", name: "Promo" }] as never })).ready).toBe(false);
  });
});

describe("searching", () => {
  it("returns everything for an empty search and keeps the catalogue's order", () => {
    expect(searchStarters("", null).map((s) => s.id)).toEqual(STARTERS.map((s) => s.id));
    expect(searchStarters("   ", null)).toHaveLength(STARTERS.length);
  });

  it("matches title, description, category and the request itself, in any case", () => {
    expect(searchStarters("REVIEW", null).some((s) => s.id === "review-request")).toBe(true);
    expect(searchStarters("monday", null).map((s) => s.id)).toContain("weekly-review");
    expect(searchStarters("webhook", null).map((s) => s.id)).toContain("webhook-lead");
    expect(searchStarters("zzzz-nothing", null)).toEqual([]);
  });

  it("filters by category, alone and with a search", () => {
    const leads = searchStarters("", "Leads");
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((s) => s.category === "Leads")).toBe(true);
    expect(searchStarters("review", "Leads").every((s) => s.category === "Leads")).toBe(true);
  });
});
