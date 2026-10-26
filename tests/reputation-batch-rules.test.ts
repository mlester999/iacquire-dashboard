// The pure rules behind review request batches: who a batch may be for (a completed service in a window, and nothing about how anyone felt), the states it moves through, what the
// scheduler does with each kind of refusal, how a batch's approval is bound to what the owner saw, and what the form can send. No database.
import { describe, expect, it } from "vitest";
import {
  BATCH_SOURCES, CRITERIA_KEYS, MAX_FILTER_IDS, MAX_WINDOW_DAYS, criteriaProblem, criteriaSchema, dayIn, describeCriteria, formatDay, normalizeCriteria, parseCriteria,
} from "@/lib/reputation/ask-criteria";
import {
  BATCH_STATUSES, BATCH_TRANSITIONS, DEFAULT_RATE_PER_MINUTE, ITEM_REASONS, ITEM_REASON_LABELS, MAX_RATE_PER_MINUTE, PREVIEW_REASONS, canTransition, classifyRefusal, durationWords,
  isEditableStatus, isFinalStatus, isLiveStatus, minutesAtPace, readBatchCounts, reasonLabel, type BatchStatus,
} from "@/lib/reputation/batches";
import { RATE_CHOICES, criteriaFromDraft, draftFromBatch, draftProblem, emptyDraft, inputFromDraft } from "@/lib/reputation/batch-form";
import { batchApprovalHash, bindingChanges, readBinding, type BatchBinding } from "@/server/reputation/batch-binding";

const ID_A = "0b5f9c1e-7a52-4a0e-9a1d-2f4f2f6f1a11";
const ID_B = "7c1d3a90-2d44-4c26-8f55-0a6b9b0d2e22";
const ID_C = "d3e0a2f4-91c7-4b5a-a2f6-6d58e3c01b33";
const good = { source: "appointments_showed", from: "2026-10-01", to: "2026-10-31" };

/** The same small seeded generator the other property tests here use, so a failure can be repeated. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("criteria: a completed service in a window, and nothing about how anyone felt", () => {
  it("accepts each service with its window, and only the narrowing that belongs to it", () => {
    for (const source of BATCH_SOURCES) expect(parseCriteria({ ...good, source }), source).toMatchObject({ ok: true });
    expect(parseCriteria({ ...good, calendarIds: [ID_A], appointmentTypeIds: [ID_B] })).toMatchObject({ ok: true });
    expect(parseCriteria({ ...good, source: "deals_won", pipelineId: ID_A })).toMatchObject({ ok: true });
    expect(parseCriteria({ ...good, source: "deals_won", calendarIds: [ID_A] })).toMatchObject({ ok: false, message: "Calendars and appointment types only narrow appointments." });
    expect(parseCriteria({ ...good, source: "customers_since", appointmentTypeIds: [ID_A] })).toMatchObject({ ok: false });
    expect(parseCriteria({ ...good, pipelineId: ID_A })).toMatchObject({ ok: false, message: "A pipeline only narrows deals." });
  });

  it("is a strict object with exactly six keys, none of which is about feelings", () => {
    expect(Object.keys(criteriaSchema.shape).sort()).toEqual([...CRITERIA_KEYS].sort());
    for (const k of CRITERIA_KEYS) expect(k, k).not.toMatch(/customer_feedback|human_escalations|follow_up_status|low_score|escalat|rating|nps|sentiment|complain|lead_?score|priority|unhappy|satisf|feedback|score|tag|status/i);
  });

  it("refuses every key it does not list, by name, and says why", () => {
    const forbidden = [
      "rating", "minRating", "maxRating", "stars", "nps", "npsScore", "nps_score", "score", "leadScore", "lead_score", "sentiment", "feedback", "feedbackStatus", "followUpStatus",
      "follow_up_status", "lowScore", "low_score", "escalated", "escalation", "complaint", "complained", "unhappy", "satisfied", "satisfaction", "comment", "tag", "tags", "status",
      "excludeLow", "onlyHappy", "happyOnly", "smartListId", "filter", "contactIds", "lifecycleStage",
    ];
    for (const key of forbidden) {
      const r = parseCriteria({ ...good, [key]: 5 });
      expect(r.ok, key).toBe(false);
      if (!r.ok) expect(r.message, key).toContain("never depends on how someone felt");
    }
    expect(parseCriteria({ ...good, rating: 5 })).toMatchObject({ ok: false, message: expect.stringContaining("“rating”") });
  });

  it("property: any object with at least one key outside the six is refused, and a key is never silently dropped", () => {
    const rand = prng(20261023);
    const pool = [...CRITERIA_KEYS, "a", "rating", "x1", "min", "max", "q", "tag", "mood", "feedback", "who"];
    for (let i = 0; i < 400; i += 1) {
      const o: Record<string, unknown> = { ...good };
      const extras = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < extras; j += 1) o[pool[Math.floor(rand() * pool.length)]] = rand() < 0.5 ? 1 : "x";
      const outside = Object.keys(o).some((k) => !(CRITERIA_KEYS as readonly string[]).includes(k));
      const r = parseCriteria(o);
      if (outside) expect(r.ok, JSON.stringify(o)).toBe(false);
    }
  });

  it("refuses a missing or impossible window, a reversed one, one longer than a year, and bad ids", () => {
    expect(parseCriteria({ source: "appointments_showed" })).toMatchObject({ ok: false });
    expect(parseCriteria({ ...good, from: "2026-02-30" })).toMatchObject({ ok: false, message: "The first date isn't a real date." });
    expect(parseCriteria({ ...good, from: "10/01/2026" })).toMatchObject({ ok: false });
    expect(parseCriteria({ ...good, from: "2026-10-31", to: "2026-10-01" })).toMatchObject({ ok: false, message: "The last day can't be before the first day." });
    expect(parseCriteria({ ...good, from: "2026-01-01", to: "2027-01-02" })).toMatchObject({ ok: false, message: expect.stringContaining(`${MAX_WINDOW_DAYS} days`) }); // 367 days counting both ends
    expect(parseCriteria({ ...good, from: "2026-01-01", to: "2027-01-01" })).toMatchObject({ ok: true }); // 366 days counting both ends: the longest allowed
    expect(parseCriteria({ ...good, source: "bogus" })).toMatchObject({ ok: false });
    expect(parseCriteria({ ...good, calendarIds: ["nope"] })).toMatchObject({ ok: false });
    expect(parseCriteria({ ...good, calendarIds: [] })).toMatchObject({ ok: false });
    expect(parseCriteria({ ...good, calendarIds: Array.from({ length: MAX_FILTER_IDS + 1 }, (_, i) => `0b5f9c1e-7a52-4a0e-9a1d-2f4f2f6f1a${String(i).padStart(2, "0")}`) })).toMatchObject({ ok: false });
    expect(parseCriteria(null)).toMatchObject({ ok: false });
    expect(parseCriteria("appointments_showed")).toMatchObject({ ok: false });
    expect(parseCriteria([good])).toMatchObject({ ok: false });
  });

  it("normalizes: ids lower case, sorted, without duplicates; the same choice is the same criteria", () => {
    const a = parseCriteria({ ...good, calendarIds: [ID_B.toUpperCase(), ID_A, ID_B], appointmentTypeIds: [ID_C] });
    const b = parseCriteria({ ...good, appointmentTypeIds: [ID_C], calendarIds: [ID_A, ID_B] });
    expect(a).toMatchObject({ ok: true });
    expect(a.ok && b.ok && JSON.stringify(a.criteria) === JSON.stringify(b.criteria)).toBe(true);
    expect(a.ok && a.criteria.calendarIds).toEqual([ID_A, ID_B].sort());
    const parsed = criteriaSchema.parse({ ...good, calendarIds: [ID_B, ID_A] });
    expect(normalizeCriteria(normalizeCriteria(parsed))).toEqual(normalizeCriteria(parsed));
  });

  it("a service that has not happened yet cannot be asked about", () => {
    const c = parseCriteria({ ...good, from: "2026-10-01", to: "2026-10-23" });
    expect(c.ok && criteriaProblem(c.criteria, "2026-10-23")).toBeNull();
    expect(c.ok && criteriaProblem(c.criteria, "2026-10-22")).toContain("last day is in the future");
    const d = parseCriteria({ ...good, from: "2026-10-24", to: "2026-10-25" });
    expect(d.ok && criteriaProblem(d.criteria, "2026-10-23")).toContain("first day is in the future");
  });

  it("reads today in the workspace's own time zone", () => {
    const at = new Date("2026-10-23T23:30:00Z");
    expect(dayIn("UTC", at)).toBe("2026-10-23");
    expect(dayIn("Pacific/Auckland", at)).toBe("2026-10-24"); // already tomorrow there
    expect(dayIn("America/Los_Angeles", at)).toBe("2026-10-23");
    expect(dayIn("Not/AZone", at)).toBe("2026-10-23");
  });

  it("describes the choice as a sentence a person can check, with the names of what it was narrowed to", () => {
    const c = criteriaSchema.parse({ ...good, calendarIds: [ID_A], appointmentTypeIds: [ID_B] });
    expect(describeCriteria(c, { calendars: new Map([[ID_A, "Front desk"]]), appointmentTypes: new Map([[ID_B, "Cleaning"]]) })).toBe("Appointments marked attended from 1 Oct 2026 to 31 Oct 2026, on Front desk, for Cleaning.");
    expect(describeCriteria(criteriaSchema.parse({ ...good, source: "deals_won", pipelineId: ID_A }), { pipelines: new Map([[ID_A, "Sales"]]) })).toBe("Deals marked won from 1 Oct 2026 to 31 Oct 2026, in Sales.");
    expect(describeCriteria(criteriaSchema.parse({ ...good, source: "customers_since" }))).toBe("Customers who became customers from 1 Oct 2026 to 31 Oct 2026.");
    expect(describeCriteria(criteriaSchema.parse({ ...good, calendarIds: [ID_A, ID_B] }))).toContain("on a calendar and a calendar");
    expect(formatDay("2026-01-05")).toBe("5 Jan 2026");
    expect(formatDay("garbage")).toBe("garbage");
  });
});

describe("the states a batch moves through", () => {
  it("has no way out of finished, cancelled or stopped, and only goes where the table says", () => {
    for (const s of ["completed", "cancelled", "stopped"] as const) {
      expect(BATCH_TRANSITIONS[s], s).toEqual([]);
      expect(isFinalStatus(s)).toBe(true);
      for (const to of BATCH_STATUSES) expect(canTransition(s, to), `${s} -> ${to}`).toBe(false);
    }
    for (const from of BATCH_STATUSES) for (const to of BATCH_TRANSITIONS[from]) expect((BATCH_STATUSES as readonly string[]).includes(to), `${from} -> ${to}`).toBe(true);
  });

  it("can only be approved from a draft or while waiting for the owner, and only sending can finish", () => {
    const into = (target: BatchStatus) => BATCH_STATUSES.filter((from) => canTransition(from, target)).sort();
    expect(into("approved")).toEqual(["awaiting_approval", "draft"]);
    expect(into("completed")).toEqual(["sending"]);
    expect(into("sending")).toEqual(["approved", "paused"]);
    expect(into("awaiting_approval")).toEqual(["draft"]);
    expect(into("draft")).toEqual(["awaiting_approval"]);
    // Nothing reaches sending without passing through approved.
    const seen = new Set<BatchStatus>(["draft"]);
    const withoutApproved = (from: BatchStatus, to: BatchStatus) => to !== "approved" && canTransition(from, to);
    for (let i = 0; i < BATCH_STATUSES.length; i += 1) for (const f of [...seen]) for (const t of BATCH_STATUSES) if (withoutApproved(f, t)) seen.add(t);
    expect(seen.has("sending")).toBe(false);
    expect(seen.has("completed")).toBe(false);
  });

  it("every state can be reached from a draft, and only drafts and waiting batches can be edited", () => {
    const seen = new Set<BatchStatus>(["draft"]);
    for (let i = 0; i < BATCH_STATUSES.length; i += 1) for (const f of [...seen]) for (const t of BATCH_TRANSITIONS[f]) seen.add(t);
    expect([...seen].sort()).toEqual([...BATCH_STATUSES].sort());
    expect(BATCH_STATUSES.filter(isEditableStatus)).toEqual(["draft", "awaiting_approval"]);
    expect(BATCH_STATUSES.filter(isLiveStatus)).toEqual(["approved", "sending"]);
  });

  it("property: a random walk along the allowed moves never leaves a final state", () => {
    const rand = prng(7);
    for (let n = 0; n < 200; n += 1) {
      let s: BatchStatus = "draft";
      let ended = false;
      for (let step = 0; step < 12; step += 1) {
        const options: readonly BatchStatus[] = BATCH_TRANSITIONS[s];
        if (!options.length) {
          ended = true;
          break;
        }
        s = options[Math.floor(rand() * options.length)];
      }
      if (ended) expect(isFinalStatus(s)).toBe(true);
    }
  });
});

describe("why a customer is left out, in words", () => {
  it("has a plain sentence for every reason the code can store, and for a refusal it has no code for", () => {
    for (const r of ITEM_REASONS) expect(reasonLabel(r), r).toBe(ITEM_REASON_LABELS[r]);
    for (const r of PREVIEW_REASONS) expect(ITEM_REASONS as readonly string[]).toContain(r);
    expect(reasonLabel("blocked:quiet_hours")).toBe("Not sent (quiet hours)");
    expect(reasonLabel(null)).toBe("");
    expect(reasonLabel("something_else")).toBe("something else");
  });

  it("states the preview's reasons in the order the send path checks them", () => {
    expect([...PREVIEW_REASONS]).toEqual(["no_address", "suppressed", "consent_withdrawn", "no_consent", "recently_requested", "held_by_person"]);
  });
});

describe("what the scheduler does with a refusal from the send path", () => {
  const SEND_PATH_REASONS = [
    "contact_unreachable", "suppressed", "no_consent", "provider_switching", "provider_owned", "channel_not_ready", "whatsapp_window_closed", "template_mismatch", "retention_limit",
    "retention_too_soon", "rate_not_published", "credits", "budget", "quiet_hours", "outside_business_hours", "human_owner", "needs_approval",
  ];
  const PREPARE_REASONS = ["not_found", "contact_archived", "recently_requested", "held_by_person", "missing_values", "surveys_not_enabled", "no_review_link", "marketing_template", "incentive_wording", "no_destinations", "template_changed"];

  it("leaves only the customer out when their own address, consent, opt-out, cool-down or hold decided it", () => {
    expect(classifyRefusal("suppressed")).toEqual({ action: "leave_out", reason: "suppressed" });
    expect(classifyRefusal("no_consent")).toEqual({ action: "leave_out", reason: "no_consent" });
    expect(classifyRefusal("contact_unreachable")).toEqual({ action: "leave_out", reason: "no_address" });
    expect(classifyRefusal("contact_archived")).toEqual({ action: "leave_out", reason: "archived" });
    expect(classifyRefusal("not_found")).toEqual({ action: "leave_out", reason: "deleted" });
    expect(classifyRefusal("recently_requested")).toEqual({ action: "leave_out", reason: "recently_requested" });
    expect(classifyRefusal("held_by_person")).toEqual({ action: "leave_out", reason: "held_by_person" });
    expect(classifyRefusal("retention_limit")).toEqual({ action: "leave_out", reason: "frequency_limit" });
    expect(classifyRefusal("missing_values")).toEqual({ action: "leave_out", reason: "missing_values" });
  });

  it("pauses the whole batch when something outside the customer needs a person, without leaving anyone out for it", () => {
    for (const [reason, code] of [["credits", "credits"], ["budget", "budget"], ["rate_not_published", "price"], ["channel_not_ready", "channel"], ["provider_owned", "provider"], ["no_destinations", "no_links"], ["surveys_not_enabled", "surveys_not_enabled"]] as const) {
      expect(classifyRefusal(reason), reason).toEqual({ action: "pause", code });
    }
  });

  it("stops the batch for good when the approved wording cannot be sent", () => {
    for (const reason of ["template_changed", "whatsapp_window_closed", "template_mismatch"]) expect(classifyRefusal(reason), reason).toEqual({ action: "stop", code: "template_changed" });
    for (const reason of ["no_review_link", "marketing_template", "incentive_wording"]) expect(classifyRefusal(reason), reason).toEqual({ action: "stop", code: "wording" });
  });

  it("records anything else as that one customer not sent, and carries on", () => {
    expect(classifyRefusal("human_owner")).toEqual({ action: "fail", reason: "blocked:human_owner" });
    expect(classifyRefusal("x".repeat(300))).toMatchObject({ action: "fail" });
    const c = classifyRefusal("x".repeat(300));
    expect(c.action === "fail" && c.reason.length).toBe(120);
  });

  it("property: no refusal a single customer causes ever pauses or stops the batch, and no refusal about the batch ever leaves a customer out", () => {
    const personal = ["suppressed", "no_consent", "contact_unreachable", "contact_archived", "not_found", "recently_requested", "held_by_person", "retention_limit", "missing_values"];
    const shared = ["credits", "budget", "rate_not_published", "channel_not_ready", "provider_owned", "no_destinations", "surveys_not_enabled", "template_changed", "whatsapp_window_closed", "template_mismatch", "no_review_link", "marketing_template", "incentive_wording"];
    for (const r of personal) expect(classifyRefusal(r).action, r).toBe("leave_out");
    for (const r of shared) expect(classifyRefusal(r).action, r).not.toBe("leave_out");
    // Every reason either path can produce is classified without throwing.
    for (const r of [...SEND_PATH_REASONS, ...PREPARE_REASONS]) expect(["leave_out", "pause", "stop", "fail"]).toContain(classifyRefusal(r).action);
  });
});

describe("counts as stored on the batch", () => {
  it("reads whatever the row holds, and keeps a notice only when it is one of ours", () => {
    expect(readBatchCounts(null)).toMatchObject({ total: 0, pending: 0, queued: 0, excluded: 0, failed: 0, reasons: {}, notice: null, waitUntil: null });
    expect(readBatchCounts("junk")).toMatchObject({ total: 0 });
    expect(readBatchCounts([1, 2])).toMatchObject({ total: 0 });
    const c = readBatchCounts({
      total: 10, pending: 3.9, queued: -2, excluded: "x", failed: 1, reasons: { suppressed: 2, bad: -1, [`${"x".repeat(200)}`]: 3, no_consent: "4" },
      notice: { code: "credits", detail: "d".repeat(500), at: "2026-10-23T00:00:00Z" }, waitUntil: "2026-10-23T01:00:00Z",
    });
    expect(c).toMatchObject({ total: 10, pending: 3, queued: 0, excluded: 0, failed: 1, reasons: { suppressed: 2 }, waitUntil: "2026-10-23T01:00:00Z" });
    expect(c.notice).toMatchObject({ code: "credits", at: "2026-10-23T00:00:00Z" });
    expect(c.notice?.detail.length).toBe(400);
    expect(readBatchCounts({ notice: { code: "invented", detail: "x" } }).notice).toBeNull();
    expect(readBatchCounts({ waitUntil: "not a date" }).waitUntil).toBeNull();
  });

  it("says how long a batch takes at its pace", () => {
    expect(minutesAtPace(0, 10)).toBe(0);
    expect(minutesAtPace(1, 10)).toBe(1);
    expect(minutesAtPace(10, 10)).toBe(1);
    expect(minutesAtPace(11, 10)).toBe(2);
    expect(minutesAtPace(1000, 60)).toBe(17);
    expect(minutesAtPace(5, 0)).toBe(5);
    expect(durationWords(1)).toBe("about a minute");
    expect(durationWords(17)).toBe("about 17 minutes");
    expect(durationWords(180)).toBe("about 3 hours");
  });
});

describe("what an approval is bound to", () => {
  const binding = (over: Partial<BatchBinding> = {}): BatchBinding => ({
    kind: "review", scale: "csat5", channel: "sms", templateId: ID_A, templateVersion: 2, templateContentHash: "a".repeat(64), whatsappTemplateId: null,
    criteria: criteriaSchema.parse({ ...good, calendarIds: [ID_B, ID_C] }), ratePerMinute: 10, businessValues: { "business.name": "Bright Smiles" }, ...over,
  });

  it("is a stable sha256 of the wording, the people, the channel, the pace and the business values", () => {
    const h = batchApprovalHash(binding());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(batchApprovalHash(binding())).toBe(h);
    // The order and spelling of ids and keys do not matter; the content does.
    expect(batchApprovalHash(binding({ criteria: criteriaSchema.parse({ calendarIds: [ID_C.toUpperCase(), ID_B, ID_B], to: good.to, from: good.from, source: good.source }) }))).toBe(h);
    expect(batchApprovalHash(binding({ businessValues: { "business.name": "Bright Smiles" } }))).toBe(h);
  });

  it("changes when anything the owner approved changes", () => {
    const h = batchApprovalHash(binding());
    const changed: Array<[string, Partial<BatchBinding>]> = [
      ["template", { templateId: ID_B }], ["version", { templateVersion: 3 }], ["wording", { templateContentHash: "b".repeat(64) }], ["channel", { channel: "email" }],
      ["kind", { kind: "survey" }], ["pace", { ratePerMinute: 11 }], ["business value", { businessValues: { "business.name": "Bright Smiles Dental" } }],
      ["window start", { criteria: criteriaSchema.parse({ ...good, from: "2026-10-02", calendarIds: [ID_B, ID_C] }) }],
      ["window end", { criteria: criteriaSchema.parse({ ...good, to: "2026-10-30", calendarIds: [ID_B, ID_C] }) }],
      ["calendar", { criteria: criteriaSchema.parse({ ...good, calendarIds: [ID_B] }) }],
      ["service", { criteria: criteriaSchema.parse({ source: "customers_since", from: good.from, to: good.to }) }],
      ["whatsapp template", { whatsappTemplateId: "tmpl_1" }],
      ["a business value that was filled in", { businessValues: { "business.name": "Bright Smiles", "business.phone": "+639170000000" } }],
    ];
    for (const [what, over] of changed) expect(batchApprovalHash(binding(over)), what).not.toBe(h);
  });

  it("looks at the survey's scale only for a survey", () => {
    expect(batchApprovalHash(binding({ kind: "review", scale: "nps10" }))).toBe(batchApprovalHash(binding({ kind: "review", scale: "csat5" })));
    expect(batchApprovalHash(binding({ kind: "survey", scale: "nps10" }))).not.toBe(batchApprovalHash(binding({ kind: "survey", scale: "csat5" })));
  });

  it("names what changed, in words, and reads a stored binding back safely", () => {
    const before = binding();
    expect(bindingChanges(before, binding({ templateContentHash: "b".repeat(64) }))).toEqual(["the message"]);
    expect(bindingChanges(before, binding({ channel: "email" }))).toContain("the channel");
    expect(bindingChanges(before, binding({ ratePerMinute: 30 }))).toEqual(["the sending pace"]);
    expect(bindingChanges(before, binding({ criteria: criteriaSchema.parse({ ...good, to: "2026-10-30", calendarIds: [ID_B, ID_C] }) }))).toEqual(["who it is for"]);
    expect(bindingChanges(before, binding({ kind: "survey" }))).toEqual(["what the message asks for"]);
    expect(bindingChanges(before, binding({ businessValues: { "business.name": "Other" } }))).toHaveLength(1);
    expect(bindingChanges(null, before)).toEqual(["what the batch sends"]);
    expect(bindingChanges(before, before)).toEqual(["what the batch sends"]);
    const stored = JSON.parse(JSON.stringify(before));
    expect(readBinding(stored)).toMatchObject({ kind: "review", channel: "sms", templateVersion: 2, ratePerMinute: 10 });
    expect(readBinding({ ...stored, criteria: { ...stored.criteria, rating: 5 } })?.criteria).toBeUndefined(); // a stored binding with a feeling-shaped key is not trusted
    expect(readBinding(null)).toBeNull();
    expect(readBinding("x")).toBeNull();
    expect(readBinding({ businessValues: { a: 1, b: "x", c: null } })?.businessValues).toEqual({ b: "x", c: null });
  });
});

describe("the form", () => {
  const draft = () => ({ ...emptyDraft("2026-10-23"), name: "  October visits ", templateId: ID_A });

  it("starts with the last 30 days up to today, the standard pace, and nothing narrowed", () => {
    const d = emptyDraft("2026-10-23");
    expect(d).toMatchObject({ source: "appointments_showed", from: "2026-09-24", to: "2026-10-23", rate: DEFAULT_RATE_PER_MINUTE, kind: "review", calendarIds: [], appointmentTypeIds: [], pipelineId: "" });
    expect(emptyDraft("2026-03-01").from).toBe("2026-01-31");
  });

  it("sends only the keys criteria may have, and only the narrowing that belongs to the chosen service", () => {
    const base = { ...draft(), calendarIds: [ID_A], appointmentTypeIds: [ID_B], pipelineId: ID_C };
    expect(Object.keys(criteriaFromDraft({ ...base, source: "appointments_showed" })).sort()).toEqual(["appointmentTypeIds", "calendarIds", "from", "source", "to"]);
    expect(Object.keys(criteriaFromDraft({ ...base, source: "deals_won" })).sort()).toEqual(["from", "pipelineId", "source", "to"]);
    expect(Object.keys(criteriaFromDraft({ ...base, source: "customers_since" })).sort()).toEqual(["from", "source", "to"]);
    expect(Object.keys(criteriaFromDraft({ ...draft(), source: "deals_won" })).sort()).toEqual(["from", "source", "to"]);
    for (const source of BATCH_SOURCES) expect(parseCriteria(criteriaFromDraft({ ...base, source })), source).toMatchObject({ ok: true });
  });

  it("property: whatever the form holds, the criteria it sends are accepted or refused only for the window, never for an unknown key", () => {
    const rand = prng(99);
    for (let i = 0; i < 200; i += 1) {
      const d = {
        ...draft(), source: BATCH_SOURCES[Math.floor(rand() * BATCH_SOURCES.length)], calendarIds: rand() < 0.5 ? [ID_A] : [], appointmentTypeIds: rand() < 0.5 ? [ID_B] : [], pipelineId: rand() < 0.5 ? ID_C : "",
      };
      for (const k of Object.keys(criteriaFromDraft(d))) expect((CRITERIA_KEYS as readonly string[]).includes(k), k).toBe(true);
      expect(parseCriteria(criteriaFromDraft(d)).ok).toBe(true);
    }
  });

  it("asks for the scale only for a survey, trims the name, and says what is missing in the order it appears", () => {
    expect(inputFromDraft(draft())).toEqual({ name: "October visits", templateId: ID_A, kind: "review", criteria: { source: "appointments_showed", from: "2026-09-24", to: "2026-10-23" }, ratePerMinute: 10 });
    expect(inputFromDraft({ ...draft(), kind: "survey", scale: "nps10" })).toMatchObject({ kind: "survey", scale: "nps10" });
    expect(draftProblem(draft())).toBeNull();
    expect(draftProblem({ ...draft(), name: " " })).toBe("Give the batch a name.");
    expect(draftProblem({ ...draft(), templateId: "" })).toBe("Choose a message template.");
    expect(draftProblem({ ...draft(), from: "" })).toBe("Choose the first and last day.");
    expect(draftProblem({ ...draft(), from: "2026-10-30", to: "2026-10-01" })).toBe("The last day can't be before the first day.");
  });

  it("fills itself from a batch, and offers every pace the service accepts at the top", () => {
    const view = { name: "Copy", template: { id: ID_A }, kind: "survey" as const, scale: "nps10" as const, criteria: criteriaSchema.parse({ ...good, calendarIds: [ID_B] }), ratePerMinute: 20 };
    expect(draftFromBatch(view, "2026-10-23")).toMatchObject({ name: "Copy", templateId: ID_A, kind: "survey", scale: "nps10", source: "appointments_showed", from: good.from, to: good.to, calendarIds: [ID_B], rate: 20 });
    expect(draftFromBatch({ ...view, template: null, criteria: null }, "2026-10-23")).toMatchObject({ templateId: "", source: "appointments_showed" });
    expect(Math.max(...RATE_CHOICES)).toBe(MAX_RATE_PER_MINUTE);
  });
});
