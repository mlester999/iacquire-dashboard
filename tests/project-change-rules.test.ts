import { describe, expect, it } from "vitest";
import {
  CHANGE_ORDER_STATUSES, CHANGE_ORDER_STATUS_EXPLAIN, CHANGE_ORDER_STATUS_LABEL, CHANGE_ORDER_STATUS_LABEL_AGENCY, CHANGE_ORDER_TRANSITIONS, CHANGEABLE_PROJECT_STATUSES, MAX_ADDITIONAL_MINOR,
  amendmentScope, canMoveChangeOrder, canUseRevision, changeQuoteCanonical, describeQuote, displayStatus, formatDay, isFinalChange, isOpenChange, isQuoteExpired, projectTakesChangeOrder,
  revisionsLeft, validateChangeQuote, type ChangeOrderStatus,
} from "@/lib/project-change-orders";
import {
  PREREQUISITE_BLOCKS, PREREQUISITE_KINDS, blockedMessage, blockers, clientPrerequisiteSentence, defaultPrerequisites, evidenceProblem, waiverProblem, type PrerequisiteFact,
} from "@/lib/project-prerequisites";
import {
  CHANGE_CATEGORY_TARGET, CHANGE_CLASSIFICATIONS, CHANGE_TARGETS, allowanceSentence, changeTargetFor, isChangeClassification, projectTakesChangeRequest,
} from "@/lib/support/change";
import { ASSISTANT_REQUEST_TYPES, CATEGORIES_BY_TYPE, CHANGE_CATEGORIES, REQUEST_TYPES, REQUEST_TYPE_LABELS, isCategoryForType } from "@/lib/support/lifecycle";
import { projectReviewSentence } from "@/lib/projects";

// The pure rules of Request a Change, change orders and prerequisites. No database: these are the rules the server enforces and the database repeats.

describe("change order states", () => {
  const finals: ChangeOrderStatus[] = ["declined", "withdrawn", "applied"];

  it("moves only along the table, and no pair outside it is allowed", () => {
    for (const from of CHANGE_ORDER_STATUSES) {
      for (const to of CHANGE_ORDER_STATUSES) {
        expect(canMoveChangeOrder(from, to), `${from} -> ${to}`).toBe(CHANGE_ORDER_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("never goes back to submitted, never leaves a final state, and a state never moves to itself", () => {
    for (const from of CHANGE_ORDER_STATUSES) {
      expect(CHANGE_ORDER_TRANSITIONS[from]).not.toContain("submitted");
      expect(CHANGE_ORDER_TRANSITIONS[from], from).not.toContain(from);
    }
    for (const f of finals) expect(CHANGE_ORDER_TRANSITIONS[f], f).toEqual([]);
  });

  it("is accepted only from a quote, and applied only from review (a revision) or from accepted", () => {
    const into = (to: ChangeOrderStatus) => CHANGE_ORDER_STATUSES.filter((from) => canMoveChangeOrder(from, to)).sort();
    expect(into("accepted")).toEqual(["quoted"]);
    expect(into("applied")).toEqual(["accepted", "under_review"]);
    expect(into("quoted")).toEqual(["under_review"]);
    expect(into("needs_info")).toEqual(["under_review"]);
  });

  it("reaches every state from submitted, and a final state from everything that is not final or accepted", () => {
    const seen = new Set<ChangeOrderStatus>(["submitted"]);
    const queue: ChangeOrderStatus[] = ["submitted"];
    while (queue.length) {
      const s = queue.shift() as ChangeOrderStatus;
      for (const t of CHANGE_ORDER_TRANSITIONS[s]) if (!seen.has(t)) { seen.add(t); queue.push(t); }
    }
    expect([...seen].sort()).toEqual([...CHANGE_ORDER_STATUSES].sort());
    // A quote the client never answered can always be taken back and ended; an accepted change can only be made.
    for (const s of ["submitted", "under_review", "needs_info", "quoted"] as const) {
      expect(CHANGE_ORDER_TRANSITIONS[s].some((t) => finals.includes(t)), s).toBe(true);
    }
    expect(CHANGE_ORDER_TRANSITIONS.accepted).toEqual(["applied"]);
  });

  it("says open for the four states a request can still change in, and final for the three that are over", () => {
    expect(CHANGE_ORDER_STATUSES.filter(isOpenChange).sort()).toEqual(["needs_info", "quoted", "submitted", "under_review"]);
    expect(CHANGE_ORDER_STATUSES.filter(isFinalChange).sort()).toEqual(["applied", "declined", "withdrawn"]);
    expect(isOpenChange("accepted")).toBe(false);
  });

  it("has wording for every state and the expired display, in both voices, and none promises a date or a price", () => {
    for (const s of [...CHANGE_ORDER_STATUSES, "expired"] as const) {
      expect(CHANGE_ORDER_STATUS_LABEL[s].length, s).toBeGreaterThan(3);
      expect(CHANGE_ORDER_STATUS_EXPLAIN[s].length, s).toBeGreaterThan(20);
      expect(CHANGE_ORDER_STATUS_EXPLAIN[s], s).not.toMatch(/\bwill be (done|ready|delivered) (by|on)\b|\bguarantee/i);
    }
    for (const s of CHANGE_ORDER_STATUSES) expect(CHANGE_ORDER_STATUS_LABEL_AGENCY[s].length, s).toBeGreaterThan(2);
  });
});

describe("which projects take a change", () => {
  it("takes one while the project is agreed and live, and says why not otherwise", () => {
    for (const s of CHANGEABLE_PROJECT_STATUSES) expect(projectTakesChangeOrder(s), s).toEqual({ ok: true });
    for (const s of ["submitted", "under_review", "discovery_needed", "quote_preparing", "quote_sent", "awaiting_approval", "on_hold", "completed", "cancelled"]) {
      const r = projectTakesChangeOrder(s);
      expect(r.ok, s).toBe(false);
      expect(r.ok ? "" : r.reason.length, s).toBeGreaterThan(20);
    }
    expect(projectTakesChangeOrder("completed")).toMatchObject({ reason: expect.stringMatching(/Report an issue/) });
  });

  it("lets a person ask about a finished project as a request, but not about one still being scoped or cancelled", () => {
    for (const s of ["approved", "in_development", "testing", "ready_for_review", "on_hold", "completed"]) expect(projectTakesChangeRequest(s), s).toBe(true);
    for (const s of ["submitted", "under_review", "quote_sent", "awaiting_approval", "cancelled"]) expect(projectTakesChangeRequest(s), s).toBe(false);
  });
});

describe("expiry", () => {
  it("is good through the valid-until day and expired from the next, and never expires without a date", () => {
    expect(isQuoteExpired("2026-10-24", "2026-10-24")).toBe(false);
    expect(isQuoteExpired("2026-10-24", "2026-10-25")).toBe(true);
    expect(isQuoteExpired("2026-10-24", "2026-10-23")).toBe(false);
    expect(isQuoteExpired(null, "2099-01-01")).toBe(false);
  });

  it("reads a date-only value as the same calendar day whatever the reader's time zone", () => {
    expect(formatDay("2026-12-31")).toBe("Dec 31, 2026");
    expect(formatDay("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatDay("2026-03-08T00:00:00.000Z")).toBe("Mar 8, 2026");
    for (const bad of [null, undefined, "", "tomorrow", "31/12/2026"]) expect(formatDay(bad), String(bad)).toBe("—");
  });

  it("shows only a quote as expired", () => {
    expect(displayStatus({ status: "quoted", validUntil: "2026-10-01" }, "2026-10-24")).toBe("expired");
    expect(displayStatus({ status: "quoted", validUntil: "2026-10-30" }, "2026-10-24")).toBe("quoted");
    for (const s of CHANGE_ORDER_STATUSES.filter((x) => x !== "quoted")) expect(displayStatus({ status: s, validUntil: "2020-01-01" }, "2026-10-24"), s).toBe(s);
  });
});

describe("the quote the team writes", () => {
  const ok = { additionalMinor: 120000, currency: "USD", weeksMin: 1 as number | null, weeksMax: 2 as number | null, termsText: "Adds a second calendar and the matching confirmation message.", validUntil: "2026-11-30" as string | null };
  const check = (over: Partial<typeof ok & { prerequisiteLabel: string | null }> = {}, today = "2026-10-24", currency = "USD") => validateChangeQuote({ ...ok, ...over }, today, currency);
  // Assembled so that no literal in this file reads as a live key to a scanner.
  const stripeLike = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");

  it("accepts what the team typed and fills in nothing", () => {
    expect(check()).toEqual({ ok: true, value: { additionalMinor: 120000, currency: "USD", weeksMin: 1, weeksMax: 2, termsText: ok.termsText, validUntil: "2026-11-30", prerequisiteLabel: null } });
    const free = check({ additionalMinor: 0, weeksMin: null, weeksMax: null, validUntil: null });
    expect(free).toMatchObject({ ok: true, value: { additionalMinor: 0, weeksMin: null, weeksMax: null, validUntil: null } });
  });

  it("refuses a price that is not a whole non-negative amount inside the cap, and a currency the project was not agreed in", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_ADDITIONAL_MINOR + 1, 2 ** 53]) expect(check({ additionalMinor: bad }).ok, String(bad)).toBe(false);
    expect(check({ additionalMinor: MAX_ADDITIONAL_MINOR }).ok).toBe(true);
    expect(check({ currency: "PHP" })).toMatchObject({ ok: false, error: expect.stringMatching(/quoted in USD/) });
    expect(check({ currency: "BTC" })).toMatchObject({ ok: false });
  });

  it("keeps the weeks whole, in range and in order, and copies a single figure to both ends", () => {
    expect(check({ weeksMin: 0 }).ok).toBe(false);
    expect(check({ weeksMax: 105 }).ok).toBe(false);
    expect(check({ weeksMin: 1.5 }).ok).toBe(false);
    expect(check({ weeksMin: 3, weeksMax: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/earlier than the earliest/) });
    expect(check({ weeksMin: 2, weeksMax: null })).toMatchObject({ ok: true, value: { weeksMin: 2, weeksMax: 2 } });
    expect(check({ weeksMin: null, weeksMax: 4 })).toMatchObject({ ok: true, value: { weeksMin: 4, weeksMax: 4 } });
  });

  it("needs terms of a sentence, within 2,000 characters, with no card number or key in them", () => {
    expect(check({ termsText: "short" }).ok).toBe(false);
    expect(check({ termsText: "x".repeat(2001) }).ok).toBe(false);
    expect(check({ termsText: `Pay with 4242 4242 4242 4242 when you are ready to proceed.` })).toMatchObject({ ok: false, error: expect.stringMatching(/card number/) });
    expect(check({ termsText: `Use the key ${stripeLike} for the connection please.` }).ok).toBe(false);
  });

  it("takes a real date that is not in the past, and a short label for what must be confirmed first", () => {
    expect(check({ validUntil: "2026-10-23" })).toMatchObject({ ok: false, error: expect.stringMatching(/in the past/) });
    expect(check({ validUntil: "2026-10-24" }).ok).toBe(true);
    expect(check({ validUntil: "2026-02-30" }).ok).toBe(false);
    expect(check({ validUntil: "next week" }).ok).toBe(false);
    expect(check({ prerequisiteLabel: "ab" }).ok).toBe(false);
    expect(check({ prerequisiteLabel: "x".repeat(161) }).ok).toBe(false);
    expect(check({ prerequisiteLabel: "  Deposit for this change received  " })).toMatchObject({ ok: true, value: { prerequisiteLabel: "Deposit for this change received" } });
  });

  it("stays linear on very long text (no pattern in it backtracks)", () => {
    const started = Date.now();
    for (const text of [" ".repeat(20_000), "a ".repeat(10_000), "1 ".repeat(10_000), "-".repeat(20_000)]) check({ termsText: text });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("hashes every term: change any one and the text the hash is made of differs", () => {
    const base = { changeId: "11111111-1111-1111-1111-111111111111", version: 1, title: "Second calendar", description: "Add a second calendar for the front desk", additionalMinor: 120000, currency: "USD", weeksMin: 1, weeksMax: 2, termsText: "Adds a second calendar.", validUntil: "2026-11-30" as string | null };
    const canonical = changeQuoteCanonical(base);
    const variants: Array<Partial<typeof base>> = [
      { changeId: "22222222-2222-2222-2222-222222222222" }, { version: 2 }, { title: "Second calendars" }, { description: "Add a third calendar" }, { additionalMinor: 120001 }, { currency: "PHP" },
      { weeksMin: 2 }, { weeksMax: 3 }, { termsText: "Adds a second calendar!" }, { validUntil: "2026-12-01" }, { validUntil: null },
    ];
    for (const v of variants) expect(changeQuoteCanonical({ ...base, ...v }), JSON.stringify(v)).not.toBe(canonical);
    expect(changeQuoteCanonical({ ...base })).toBe(canonical);
    // A different field order or a different type for the same text cannot collide: it is a fixed-position list.
    expect(changeQuoteCanonical({ ...base, title: "a", description: "bc" })).not.toBe(changeQuoteCanonical({ ...base, title: "ab", description: "c" }));
  });

  it("describes a quote with the team's own numbers and says the weeks are an estimate, never a date", () => {
    expect(describeQuote({ additionalCents: 120000, currency: "USD", weeksMin: 2, weeksMax: 3 })).toBe("$1,200.00 and 2 to 3 more weeks (an estimate, not a delivery date)");
    expect(describeQuote({ additionalCents: 0, currency: "USD", weeksMin: null, weeksMax: null })).toBe("No extra charge");
    expect(describeQuote({ additionalCents: 50000, currency: "USD", weeksMin: 1, weeksMax: 1 })).toBe("$500.00 and 1 more week (an estimate, not a delivery date)");
    expect(describeQuote({ additionalCents: null, currency: null, weeksMin: null, weeksMax: null })).toBe("No price yet");
  });

  it("adds what an accepted change brought to the scope from the title and the quoted terms, within the column's limit", () => {
    expect(amendmentScope("  Second calendar ", " Adds one more calendar. ")).toBe("Second calendar\n\nAdds one more calendar.");
    expect(amendmentScope("t".repeat(160), "x".repeat(2000)).length).toBeLessThanOrEqual(4000);
  });
});

describe("revisions", () => {
  it("counts down from the number the agreement includes, and stays a plain count when none was recorded", () => {
    expect(revisionsLeft(3, 1)).toBe(2);
    expect(revisionsLeft(3, 3)).toBe(0);
    expect(revisionsLeft(3, 9)).toBe(0);
    expect(revisionsLeft(null, 4)).toBeNull();
    expect(canUseRevision(2, 1)).toBe(true);
    expect(canUseRevision(2, 2)).toBe(false);
    expect(canUseRevision(0, 0)).toBe(false);
    expect(canUseRevision(null, 50)).toBe(true);
  });
});

describe("prerequisites", () => {
  const item = (over: Partial<PrerequisiteFact> = {}): PrerequisiteFact => ({ id: "p", kind: "agreement", label: "Written agreement confirmed", required: true, blocks: "start", status: "pending", ...over });

  it("asks for the agreement always, and for the payment only when the quote has payment terms", () => {
    expect(defaultPrerequisites("").map((p) => p.kind)).toEqual(["agreement"]);
    expect(defaultPrerequisites("   ").map((p) => p.kind)).toEqual(["agreement"]);
    expect(defaultPrerequisites("50% to begin, 50% on delivery.").map((p) => p.kind)).toEqual(["agreement", "deposit"]);
    for (const p of defaultPrerequisites("50% to begin")) expect(p).toMatchObject({ blocks: "start", required: true });
  });

  it("blocks a phase only with a required item that is still waiting for that phase", () => {
    expect(blockers([item()], "start")).toHaveLength(1);
    expect(blockers([item()], "handover")).toHaveLength(0);
    expect(blockers([item({ status: "satisfied" })], "start")).toHaveLength(0);
    expect(blockers([item({ status: "waived" })], "start")).toHaveLength(0);
    expect(blockers([item({ required: false })], "start")).toHaveLength(0);
    expect(blockers([item({ blocks: "handover" })], "handover")).toHaveLength(1);
  });

  it("binds a change's item only once that change was accepted", () => {
    const change = (changeStatus: string | null) => item({ kind: "change", blocks: "handover", changeStatus });
    for (const s of ["submitted", "under_review", "needs_info", "quoted", "declined", "withdrawn", null]) expect(blockers([change(s)], "handover"), String(s)).toHaveLength(0);
    for (const s of ["accepted", "applied"]) expect(blockers([change(s)], "handover"), s).toHaveLength(1);
  });

  it("names what is waiting, in words, and says nothing when nothing is", () => {
    expect(blockedMessage("start", [])).toBeNull();
    expect(blockedMessage("start", [item()])).toMatch(/Work can't start yet: one thing is still waiting.*Written agreement confirmed/);
    expect(blockedMessage("handover", [item(), item({ id: "q", label: "Logo received" })])).toMatch(/can't be handed over yet: 2 things are still waiting/);
  });

  it("tells a client what is asked and whether it is done, with no person, evidence or payment detail", () => {
    for (const status of ["pending", "satisfied", "waived"] as const) {
      for (const blocks of PREREQUISITE_BLOCKS) {
        const s = clientPrerequisiteSentence({ status, blocks });
        expect(s.length).toBeGreaterThan(10);
        expect(s).not.toMatch(/@|\$|\bpaid\b|card|bank/i);
      }
    }
  });

  it("asks for a few words of evidence or reason and refuses a card number or a key in either", () => {
    expect(evidenceProblem("")).toMatch(/what you checked/i);
    expect(evidenceProblem("ok")).not.toBeNull();
    expect(evidenceProblem("Signed agreement received by email on the 3rd")).toBeNull();
    expect(evidenceProblem("x".repeat(1001))).toMatch(/1,000/);
    expect(evidenceProblem("Paid with 4111 1111 1111 1111 on the 3rd")).toMatch(/card number/);
    expect(waiverProblem("no")).not.toBeNull();
    expect(waiverProblem("The client pays at handover instead")).toBeNull();
    expect(waiverProblem(`api key is ${["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")} ok`)).not.toBeNull();
    expect(evidenceProblem(" ".repeat(20_000))).not.toBeNull();
  });

  it("knows six kinds and two phases", () => {
    expect([...PREREQUISITE_KINDS]).toEqual(["agreement", "deposit", "access", "content", "change", "other"]);
    expect([...PREREQUISITE_BLOCKS]).toEqual(["start", "handover"]);
  });
});

describe("Request a Change vocabulary", () => {
  it("is a fourth request type with six categories of its own, each reading as one target", () => {
    expect([...REQUEST_TYPES]).toEqual(["support", "issue", "feedback", "change"]);
    expect([...CHANGE_CATEGORIES]).toEqual(["change_ai_employee", "change_website", "change_automation", "change_integration", "change_project", "change_other"]);
    expect([...CATEGORIES_BY_TYPE.change]).toEqual([...CHANGE_CATEGORIES]);
    for (const c of CHANGE_CATEGORIES) {
      expect(isCategoryForType("change", c), c).toBe(true);
      expect(changeTargetFor(c), c).toBe(CHANGE_CATEGORY_TARGET[c]);
      for (const other of ["support", "issue", "feedback"] as const) expect(isCategoryForType(other, c), `${other} ${c}`).toBe(false);
    }
    expect(CHANGE_CATEGORIES.map(changeTargetFor).sort()).toEqual([...CHANGE_TARGETS].sort());
    expect(changeTargetFor("general")).toBeNull();
    expect(changeTargetFor("constructor")).toBeNull();
    expect(changeTargetFor("__proto__")).toBeNull();
    expect(REQUEST_TYPE_LABELS.change).toMatchObject({ label: "Change request", plural: "Change requests" });
  });

  it("keeps a change out of the assistant and the help widget, which have no project or target to give it", () => {
    expect([...ASSISTANT_REQUEST_TYPES]).toEqual(["support", "issue", "feedback"]);
  });

  it("classifies a change four ways and refuses anything else", () => {
    expect([...CHANGE_CLASSIFICATIONS]).toEqual(["covered", "managed_allowance", "needs_quote", "out_of_scope"]);
    for (const c of CHANGE_CLASSIFICATIONS) expect(isChangeClassification(c)).toBe(true);
    for (const bad of ["", "free", null, undefined, 3, "COVERED"]) expect(isChangeClassification(bad), String(bad)).toBe(false);
  });

  it("shows the allowance only when a plan gives one, as the plan's own number and without promising a price", () => {
    expect(allowanceSentence(null)).toBeNull();
    expect(allowanceSentence({ total: 0, used: 0, remaining: 0, month: "2026-10" })).toBeNull();
    const text = allowanceSentence({ total: 4, used: 3, remaining: 1, month: "2026-10" }) as string;
    expect(text).toMatch(/includes 4 managed requests a month \(1 left this month\)/);
    expect(text).not.toMatch(/\$|free|unlimited|guarantee/i);
    expect(allowanceSentence({ total: 1, used: 1, remaining: 0, month: "2026-10" })).toMatch(/includes 1 managed request a month and you have used them all this month/);
    expect(allowanceSentence({ total: 6, used: 0, remaining: 6, month: "2026-10" })).toMatch(/includes 6 managed requests/);
  });

  it("writes the review target as an aim only when there is one", () => {
    expect(projectReviewSentence(null)).toBeNull();
    expect(projectReviewSentence(0)).toBeNull();
    expect(projectReviewSentence(1.5)).toBeNull();
    expect(projectReviewSentence(4)).toBe("We aim to look at a new project request within 4 hours. This is a target, not a promise.");
    expect(projectReviewSentence(24)).toMatch(/within 1 day\./);
    expect(projectReviewSentence(72)).toMatch(/within 3 days\./);
    expect(projectReviewSentence(1)).toMatch(/within 1 hour\./);
  });
});
