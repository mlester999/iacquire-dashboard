// The pure rules behind the proposal screens: what a person types becomes what the server stores (and the other way round), the totals on screen are the totals the server
// works out, and the sentences the screens print say only what the record shows. No database and no browser.
import { describe, expect, it } from "vitest";
import { computeDocTotals } from "@/lib/proposals/money";
import { DECISION_METHOD_LABELS } from "@/lib/proposals/ack";
import { describeEvent, type ActivityInput } from "@/lib/proposals/activity";
import { emptyDoc, parseDoc, type DocLine, type ProposalDoc } from "@/lib/proposals/doc";
import {
  bpsToPercent, discountOf, editorIssues, issueFor, liveTotals, lockedReason, parsePrice, parseQty, patchFromState, percentToBps, sameState, stateFromSaved, stateKey,
  type EditorState, type SavedProposal,
} from "@/lib/proposals/editor";
import { dayIn, shortHash, whenIn } from "@/lib/proposals/format";
import { groupTotalsText, LIST_FILTERS, nextStep, parseListFilter, parseWorkspaceTab, statusesFor, validityNote } from "@/lib/proposals/list";
import { formFromSettings, patchFromForm, sameForm, settingsIssues, type SavedSettings } from "@/lib/proposals/settings-form";
import { PROPOSAL_STATUSES } from "@/lib/proposals/state";

const line = (over: Partial<DocLine> = {}): DocLine => ({
  id: "line-aaaa01", catalogItemId: null, name: "Logo design", description: "", unitLabel: "each", quantityMilli: 1000, unitPriceMinor: 40_000, catalogPriceMinor: null, billing: "one_time",
  taxRateId: null, taxName: null, taxBps: 0, discount: null, note: "", ...over,
});
const saved = (over: Partial<SavedProposal> = {}, lines: DocLine[] = [line()]): SavedProposal => ({
  title: "Website proposal", clientName: "Maria Santos", clientCompany: "Santos Dental", clientEmail: "maria@example.test", validUntil: "2026-11-30", requiresSignature: false, currency: "USD",
  internalNotes: null, doc: { v: 1, sections: [{ id: "sec-aaaa01", heading: "Introduction", body: "Thank you." }], lines, terms: "Payment is due in 14 days." }, ...over,
});

describe("percentages and basis points", () => {
  it.each([["10", 1000], ["12.5", 1250], ["0.01", 1], ["100", 10_000], [" 5 ", 500], ["0.5", 50], ["99.99", 9999]])("reads %s", (text, bps) => {
    expect(percentToBps(text)).toBe(bps);
  });
  it.each(["", "0", "0.00", "100.01", "101", "1e2", "5.", ".5", "-5", "1,5", "5%", "ten", "1.234"])("refuses %j", (text) => {
    expect(percentToBps(text)).toBeNull();
  });
  it("writes every rate back the way it was typed (property over all 10,000)", () => {
    for (let bps = 1; bps <= 10_000; bps += 1) expect(percentToBps(bpsToPercent(bps)), String(bps)).toBe(bps);
    expect(bpsToPercent(1250)).toBe("12.5");
    expect(bpsToPercent(1200)).toBe("12");
    expect(bpsToPercent(5)).toBe("0.05");
  });
});

describe("prices and quantities as typed", () => {
  it("reads an amount in the currency's own minor unit", () => {
    expect(parsePrice("1,500.00", "USD")).toEqual({ ok: true, minor: 150_000 });
    expect(parsePrice("1500.5", "USD")).toEqual({ ok: true, minor: 150_050 });
    expect(parsePrice("0", "USD")).toEqual({ ok: true, minor: 0 });
    expect(parsePrice("1500", "JPY")).toEqual({ ok: true, minor: 1500 });
  });
  it.each([["", "USD"], ["abc", "USD"], ["15.123", "USD"], ["1500.5", "JPY"], ["-1", "USD"], ["1e3", "USD"], ["1 500", "USD"], ["99999999999999", "USD"]])("refuses %j in %s with a reason", (text, cur) => {
    const r = parsePrice(text, cur);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message.length).toBeGreaterThan(5);
  });
  it("reads a quantity to the thousandth, and refuses zero and giants", () => {
    expect(parseQty("2.5")).toEqual({ ok: true, milli: 2500 });
    expect(parseQty("0.001")).toEqual({ ok: true, milli: 1 });
    expect(parseQty("999999.999")).toEqual({ ok: true, milli: 999_999_999 });
    for (const bad of ["0", "0.0005", "1000000", "-1", "", "1,5", "2.5.1", "x"]) expect(parseQty(bad).ok, bad).toBe(false);
  });
  it("reads a discount, and says why a bad one is bad", () => {
    expect(discountOf({ discount: "none", discountValue: "" }, "USD")).toEqual({ ok: true, discount: null });
    expect(discountOf({ discount: "percent", discountValue: "10" }, "USD")).toEqual({ ok: true, discount: { kind: "percent", bps: 1000 } });
    expect(discountOf({ discount: "fixed", discountValue: "50.00" }, "USD")).toEqual({ ok: true, discount: { kind: "fixed", minor: 5000 } });
    for (const bad of [{ discount: "percent", discountValue: "0" }, { discount: "percent", discountValue: "101" }, { discount: "fixed", discountValue: "0" }, { discount: "fixed", discountValue: "abc" }] as const) {
      expect(discountOf(bad, "USD").ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("from a saved proposal to the editor and back", () => {
  it("shows prices and quantities the way a person writes them, and sends back the same numbers", () => {
    const lines = [
      line({ id: "line-aaaa01", quantityMilli: 2500, unitPriceMinor: 150_000, discount: { kind: "percent", bps: 1250 }, taxBps: 1200, taxRateId: "11111111-1111-4111-8111-111111111111", taxName: "Sales tax", catalogItemId: "22222222-2222-4222-8222-222222222222", catalogPriceMinor: 150_000 }),
      line({ id: "line-aaaa02", name: "Hosting", unitPriceMinor: 2_550, billing: "monthly", discount: { kind: "fixed", minor: 500 } }),
    ];
    const state = stateFromSaved(saved({}, lines));
    expect(state.lines[0]).toMatchObject({ quantity: "2.5", price: "1500.00", discount: "percent", discountValue: "12.5", taxBps: 1200, catalogPriceMinor: 150_000 });
    expect(state.lines[1]).toMatchObject({ quantity: "1", price: "25.50", discount: "fixed", discountValue: "5.00", billing: "monthly" });
    const built = patchFromState(state);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.patch.doc.lines).toEqual([
      { id: "line-aaaa01", catalogItemId: "22222222-2222-4222-8222-222222222222", name: "Logo design", description: "", unitLabel: "each", quantityMilli: 2500, unitPriceMinor: 150_000, billing: "one_time", taxRateId: "11111111-1111-4111-8111-111111111111", discount: { kind: "percent", bps: 1250 }, note: "" },
      { id: "line-aaaa02", catalogItemId: null, name: "Hosting", description: "", unitLabel: "each", quantityMilli: 1000, unitPriceMinor: 2550, billing: "monthly", taxRateId: null, discount: { kind: "fixed", minor: 500 }, note: "" },
    ]);
    expect(built.patch).toMatchObject({ title: "Website proposal", clientEmail: "maria@example.test", validUntil: "2026-11-30", currency: "USD", internalNotes: null });
    expect(built.patch.doc.sections).toEqual([{ id: "sec-aaaa01", heading: "Introduction", body: "Thank you." }]);
  });

  it("leaves a new line without an id, and turns empty optional fields into nulls", () => {
    const state = stateFromSaved(saved({ clientEmail: null, validUntil: null, internalNotes: "  " }));
    state.lines.push({ ...state.lines[0], key: "new-1", id: undefined });
    const built = patchFromState(state);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect("id" in built.patch.doc.lines[1]).toBe(false);
    expect("id" in built.patch.doc.lines[0]).toBe(true);
    expect(built.patch).toMatchObject({ clientEmail: null, validUntil: null, internalNotes: null });
  });

  it("the edited state is something the server's own document rules accept", () => {
    const state = stateFromSaved(saved({}, [line({ description: "**Bold** work", note: "Two rounds." })]));
    const built = patchFromState(state);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const doc = {
      v: 1,
      sections: built.patch.doc.sections.map((s, i) => ({ id: s.id ?? `sec-new${i}0000`, heading: s.heading, body: s.body })),
      lines: built.patch.doc.lines.map((l) => ({ ...l, id: l.id ?? "line-new0001", catalogPriceMinor: null, taxName: null, taxBps: 0 })),
      terms: built.patch.doc.terms,
    };
    expect(parseDoc(doc).ok).toBe(true);
  });
});

describe("what is wrong with what was typed", () => {
  const base = (): EditorState => stateFromSaved(saved());

  it("finds nothing wrong with a good proposal", () => {
    expect(editorIssues(base())).toEqual([]);
  });

  it("says what is wrong, next to the field it is wrong in", () => {
    const s = base();
    s.title = "   ";
    s.clientEmail = "not an email";
    s.validUntil = "2026-02-30";
    s.currency = "XXX";
    s.lines[0] = { ...s.lines[0], name: "", unitLabel: "", quantity: "0", price: "abc", discount: "percent", discountValue: "150", description: "<b>hi</b>", note: "see [x](http://y.example)" };
    s.sections[0] = { ...s.sections[0], heading: "", body: "<script>1</script>" };
    s.terms = "x".repeat(13_000);
    s.internalNotes = "n".repeat(4001);
    const issues = editorIssues(s);
    const paths = issues.map((i) => i.path).sort();
    for (const p of ["title", "clientEmail", "validUntil", "currency", "internalNotes", "terms", `line:${s.lines[0].key}:name`, `line:${s.lines[0].key}:unitLabel`, `line:${s.lines[0].key}:quantity`, `line:${s.lines[0].key}:price`, `line:${s.lines[0].key}:discountValue`, `line:${s.lines[0].key}:description`, `section:${s.sections[0].key}:heading`, `section:${s.sections[0].key}:body`]) {
      expect(paths, p).toContain(p);
    }
    expect(issueFor(issues, "title")).toBe("Give the proposal a title.");
    expect(issueFor(issues, "nope")).toBeNull();
    for (const i of issues) expect(i.message).not.toMatch(/undefined|NaN|\[object/);
    expect(patchFromState(s).ok).toBe(false);
  });

  it("refuses a fixed discount bigger than the line, the way the server's money rules do", () => {
    const s = base();
    s.lines[0] = { ...s.lines[0], discount: "fixed", discountValue: "999.00" };
    expect(issueFor(editorIssues(s), `line:${s.lines[0].key}:discountValue`)).toMatch(/cannot be more than the line/);
  });

  it("limits sections and lines to the numbers the server allows", () => {
    const s = base();
    s.sections = Array.from({ length: 31 }, (_, i) => ({ key: `s${i}`, id: undefined, heading: `H${i}`, body: "" }));
    s.lines = Array.from({ length: 101 }, (_, i) => ({ ...base().lines[0], key: `l${i}`, id: undefined }));
    const issues = editorIssues(s);
    expect(issueFor(issues, "sections")).toMatch(/at most 30/);
    expect(issueFor(issues, "lines")).toMatch(/at most 100/);
  });
});

describe("has anything changed", () => {
  it("ignores what the server tidies, and sees every real change", () => {
    const a = stateFromSaved(saved());
    const b = stateFromSaved(saved());
    b.title = "  Website   proposal ";
    b.terms = "Payment is due in 14 days.\r\n";
    b.lines[0] = { ...b.lines[0], key: "something-else" };
    expect(sameState(a, b)).toBe(true);
    for (const change of [
      (s: EditorState) => { s.title = "Other"; }, (s: EditorState) => { s.clientEmail = "x@example.test"; }, (s: EditorState) => { s.validUntil = ""; }, (s: EditorState) => { s.requiresSignature = true; },
      (s: EditorState) => { s.lines[0].price = "400.01"; }, (s: EditorState) => { s.lines[0].quantity = "2"; }, (s: EditorState) => { s.lines[0].discount = "percent"; s.lines[0].discountValue = "5"; },
      (s: EditorState) => { s.sections[0].body = "Different."; }, (s: EditorState) => { s.sections.reverse(); s.sections.push({ key: "n", id: undefined, heading: "x", body: "" }); }, (s: EditorState) => { s.internalNotes = "note"; },
    ]) {
      const c = stateFromSaved(saved());
      change(c);
      expect(sameState(a, c), stateKey(c)).toBe(false);
    }
  });
});

describe("the totals on screen are the totals the server works out", () => {
  it("adds up exactly the lines it shows (seeded property test over random lines, discounts and taxes)", () => {
    let seed = 7_2026;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    for (let n = 0; n < 150; n += 1) {
      const lines: DocLine[] = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => {
        const price = Math.floor(rand() * 900_000);
        const gross = price;
        const kind = pick(["none", "percent", "fixed"] as const);
        return line({
          id: `line-${n}-${i}-abc`, quantityMilli: 1 + Math.floor(rand() * 9_000), unitPriceMinor: price, billing: pick(["one_time", "monthly", "yearly"] as const), taxBps: pick([0, 0, 500, 1200, 1250, 2000] as const),
          discount: kind === "none" ? null : kind === "percent" ? { kind, bps: 1 + Math.floor(rand() * 10_000) } : { kind, minor: 1 + Math.floor(rand() * Math.max(1, Math.min(gross, 1000))) },
        });
      });
      let server;
      try {
        server = computeDocTotals(lines);
      } catch {
        continue; // a fixed discount larger than a small line: the editor flags it, and the totals leave it out
      }
      const state = stateFromSaved(saved({}, lines));
      const live = liveTotals(state);
      expect(live.incomplete).toBe(false);
      expect(live.lines).toEqual(server.lines);
      for (const b of ["one_time", "monthly", "yearly"] as const) {
        expect(live.groups[b]).toEqual(server.groups[b]);
        // The identity a customer relies on: the total is the sum of the lines shown.
        const shown = live.lines.filter((_, i) => lines[i].billing === b).reduce((sum, a) => sum + (a?.total ?? 0), 0);
        expect(live.groups[b].total).toBe(shown);
      }
    }
  });

  it("leaves an unfinished line out and says so, and never throws", () => {
    const state = stateFromSaved(saved({}, [line(), line({ id: "line-aaaa02" })]));
    state.lines[1].price = "";
    state.lines[0].quantity = "2";
    const live = liveTotals(state);
    expect(live.incomplete).toBe(true);
    expect(live.lines[1]).toBeNull();
    expect(live.groups.one_time.total).toBe(80_000);
  });
});

describe("why a proposal cannot be edited", () => {
  it("has an honest reason for every status that cannot, and for a person who may not", () => {
    for (const s of PROPOSAL_STATUSES) {
      const editable = ["draft", "pending_approval", "changes_requested", "approved"].includes(s);
      if (editable) {
        expect(lockedReason(s, true), s).toBeNull();
        expect(lockedReason(s, false), s).toMatch(/person who wrote this proposal, or a manager/);
      } else {
        expect(lockedReason(s, true), s).toMatch(/Revise it|Duplicate it/);
      }
    }
    expect(lockedReason("accepted", true)).toMatch(/can't be changed/);
  });
});

describe("the settings form", () => {
  const settings: SavedSettings = { aiDraftsEnabled: false, approvalMode: "ai_and_discounts", approvalOverMinor: 500_000, discountNeedsApproval: true, twoPerson: false, defaultValidityDays: 30, tagOnSendId: null, stageOnSendId: null, dealOnAccept: "none", version: 3 };

  it("shows the saved settings as typed fields and sends the same thing back", () => {
    const f = formFromSettings(settings, "USD");
    expect(f).toMatchObject({ approvalOver: "5000.00", validityDays: "30", tagOnSendId: "", dealOnAccept: "none" });
    expect(patchFromForm(f, "USD")).toEqual({
      aiDraftsEnabled: false, approvalMode: "ai_and_discounts", approvalOverMinor: 500_000, discountNeedsApproval: true, twoPerson: false, defaultValidityDays: 30, tagOnSendId: null, stageOnSendId: null, dealOnAccept: "none",
    });
    expect(sameForm(f, formFromSettings(settings, "USD"))).toBe(true);
    expect(sameForm(f, { ...f, twoPerson: true })).toBe(false);
  });

  it("treats empty as 'no limit' and 'none', and refuses nonsense", () => {
    const empty = formFromSettings({ ...settings, approvalOverMinor: null, defaultValidityDays: null }, "USD");
    expect(empty.approvalOver).toBe("");
    expect(patchFromForm(empty, "USD")).toMatchObject({ approvalOverMinor: null, defaultValidityDays: null });
    expect(settingsIssues(empty, "USD")).toEqual({});
    expect(settingsIssues({ ...empty, approvalOver: "abc" }, "USD").approvalOver).toBeTruthy();
    expect(settingsIssues({ ...empty, approvalOver: "0" }, "USD").approvalOver).toMatch(/above zero/);
    for (const bad of ["0", "366", "1.5", "-3", "abc", "1e2"]) expect(settingsIssues({ ...empty, validityDays: bad }, "USD").validityDays, bad).toBeTruthy();
    for (const good of ["1", "30", "365", ""]) expect(settingsIssues({ ...empty, validityDays: good }, "USD").validityDays, good).toBeUndefined();
  });
});

describe("the list", () => {
  it("reads the filter from the address, and an unknown word is the default", () => {
    expect(parseListFilter(undefined)).toBe("open");
    expect(parseListFilter("waiting")).toBe("waiting");
    expect(parseListFilter(["answered", "all"])).toBe("answered");
    expect(parseListFilter("DROP TABLE")).toBe("open");
    expect(statusesFor("all")).toBeUndefined();
    expect(statusesFor("answered")).toEqual(["accepted", "declined"]);
    // Every status belongs to some group, so nothing can be lost from the list by filtering.
    for (const s of PROPOSAL_STATUSES) expect(LIST_FILTERS.some((f) => (f.statuses as readonly string[]).includes(s)), s).toBe(true);
  });

  it("writes totals in words, group by group, never added together", () => {
    expect(groupTotalsText({ one_time: 168_000, monthly: 9_900, yearly: 0 }, "USD")).toBe("USD 1,680.00 once + USD 99.00 per month");
    expect(groupTotalsText({ one_time: 0, monthly: 0, yearly: 120_000 }, "PHP")).toBe("PHP 1,200.00 per year");
    expect(groupTotalsText({ one_time: 0, monthly: 0, yearly: 0 }, "USD")).toBe("No amount yet");
    expect(groupTotalsText({ one_time: 5, monthly: 0, yearly: 0 }, "XXX")).toBe("Total not available");
  });

  it("says how long is left in the workspace's own calendar", () => {
    expect(validityNote(null, "2026-10-23")).toBeNull();
    expect(validityNote("2026-11-30", "2026-10-23")).toEqual({ text: "Valid until November 30, 2026", tone: "neutral" });
    expect(validityNote("2026-10-25", "2026-10-23")).toMatchObject({ text: "Valid until October 25, 2026 (2 days left)", tone: "warning" });
    expect(validityNote("2026-10-24", "2026-10-23")?.text).toMatch(/\(1 day left\)/);
    expect(validityNote("2026-10-23", "2026-10-23")).toMatchObject({ text: expect.stringMatching(/last day/), tone: "warning" });
    expect(validityNote("2026-10-22", "2026-10-23")).toMatchObject({ text: expect.stringMatching(/passed/), tone: "danger" });
  });

  it("offers a next step only to the people who can take it", () => {
    const all = { canApprove: true, canSend: true, canCreate: true };
    const none = { canApprove: false, canSend: false, canCreate: false };
    expect(nextStep("pending_approval", all)).toBe("Review and decide");
    expect(nextStep("pending_approval", { ...all, canApprove: false })).toBeNull();
    expect(nextStep("approved", all)).toBe("Send it to the customer");
    expect(nextStep("approved", none)).toBeNull();
    expect(nextStep("draft", all)).toMatch(/Finish the draft/);
    expect(nextStep("sent", all)).toBeNull();
    expect(nextStep("accepted", all)).toBeNull();
  });

  it("reads the tab from the address", () => {
    expect(parseWorkspaceTab(undefined)).toBe("edit");
    expect(parseWorkspaceTab("delivery")).toBe("delivery");
    expect(parseWorkspaceTab(["preview"])).toBe("preview");
    expect(parseWorkspaceTab("<script>")).toBe("edit");
  });

  it("writes dates in the workspace's zone and survives a zone it does not know", () => {
    expect(whenIn("2026-10-23T20:00:00Z", "Asia/Manila")).toMatch(/Oct 24, 2026/);
    expect(whenIn("2026-10-23T20:00:00Z", "Not/AZone")).toMatch(/Oct 23, 2026/);
    expect(whenIn(null, "UTC")).toBe("");
    expect(whenIn("not a date", "UTC")).toBe("");
    expect(dayIn("2026-10-23T20:00:00Z", "Pacific/Auckland")).toBe("Oct 24, 2026");
    expect(shortHash("0123456789abcdef0123")).toBe("0123 4567 89ab");
  });
});

describe("the history says only what the record shows", () => {
  const ev = (kind: string, over: Partial<ActivityInput> = {}): ActivityInput => ({ kind, actorKind: "user", actorName: "Alex Rivera", version: 2, detail: {}, ...over });

  it("never calls a page request a reading, a code a signature, or a person's note a verification", () => {
    expect(describeEvent(ev("link_opened", { actorKind: "recipient", actorName: null })).text).toMatch(/can be an email scanner/);
    expect(describeEvent(ev("viewed", { actorKind: "recipient", actorName: null })).text).toMatch(/does not show who, or that it was read/);
    expect(describeEvent(ev("verified", { actorKind: "recipient", actorName: null, detail: { emailMasked: "m***@example.test" } })).text).toMatch(/control of that mailbox, not who they are/);
    expect(describeEvent(ev("accepted", { actorKind: "recipient", actorName: null, detail: { method: "verified_acknowledgement", emailMasked: "m***@example.test" } })).text).toMatch(/not an electronic signature/);
    const recorded = describeEvent(ev("accepted", { detail: { method: "recorded_by_staff" } })).text;
    expect(recorded).toContain("Alex Rivera recorded that the customer accepted");
    expect(recorded).toContain(DECISION_METHOD_LABELS.recorded_by_staff);
    for (const kind of ["link_opened", "viewed", "verified", "code_requested", "accepted", "declined", "changes_requested"]) {
      expect(describeEvent(ev(kind, { actorKind: "recipient", actorName: null, detail: { method: "verified_acknowledgement" } })).text.toLowerCase(), kind).not.toMatch(/\bsigned\b|\bread it\b|has read/);
    }
  });

  it("describes every kind the server records, with no loose ends, even from sparse detail", () => {
    const kinds = ["created", "ai_drafted", "duplicated", "edited", "submitted", "approved", "self_approved", "changes_requested", "rejected", "sent", "link_created", "pdf_failed", "link_opened", "viewed", "code_requested", "verified", "accepted", "declined", "delivered_offline", "withdrawn", "expired", "revised", "integrity_failed", "effect_failed", "effect_skipped"];
    for (const kind of kinds) {
      for (const detail of [{}, { effect: "deal_won", message: "boom", reason: "closed", was: "sent", number: "P-0002", content: true, approvalVoided: true, duplicatedFrom: "x" }]) {
        const d = describeEvent(ev(kind, { detail, version: null }));
        expect(d.text, kind).not.toMatch(/undefined|null|NaN|\[object/);
        expect(d.text.length, kind).toBeGreaterThan(10);
        expect(["neutral", "good", "warning", "bad"]).toContain(d.tone);
      }
    }
  });

  it("names who did a thing, or says plainly that nobody is known", () => {
    expect(describeEvent(ev("sent")).text).toContain("Alex Rivera");
    expect(describeEvent(ev("sent", { actorName: null })).text).toContain("A teammate");
    expect(describeEvent(ev("expired", { actorKind: "system", actorName: null })).text).toMatch(/valid-until date passed/);
    expect(describeEvent(ev("withdrawn", { actorKind: "system", actorName: null, detail: { reason: "privacy_request" } })).text).toMatch(/asked for their data to be erased/);
    expect(describeEvent(ev("effect_failed", { actorKind: "system", actorName: null, detail: { effect: "tag_on_send", message: "No such tag." } })).text).toMatch(/adding the tag when sent[\s\S]*proposal itself was not affected[\s\S]*No such tag\./);
    expect(describeEvent(ev("something_new", { actorKind: "system", actorName: null })).text).toBe("iAcquire: something new (version 2).");
  });

  it("warns when an edit voided an approval", () => {
    expect(describeEvent(ev("edited", { detail: { content: true, approvalVoided: true } }))).toMatchObject({ tone: "warning", text: expect.stringMatching(/earlier approval no longer applies/) });
    expect(describeEvent(ev("edited", { detail: { content: true } })).tone).toBe("neutral");
  });
});

describe("a document the editor starts from", () => {
  it("opens an empty proposal as an empty page", () => {
    const s = stateFromSaved({ ...saved(), doc: emptyDoc() as ProposalDoc });
    expect(s.sections).toEqual([]);
    expect(s.lines).toEqual([]);
    expect(liveTotals(s).groups.one_time.total).toBe(0);
    expect(editorIssues(s)).toEqual([]);
  });
});
