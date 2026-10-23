// The pure rules behind invoice reminders and what an invoice announces to the CRM: the fixed wording, the fingerprint the owner's authorization is bound to, the decision to
// send or not, the plan of rows for one invoice, and the announcements. No database; the services are tested against embedded Postgres in the other invoices-reminder files.
import { describe, expect, it } from "vitest";
import { reminderSchedule, stepKeyFor } from "@/lib/invoices/reminders";
import {
  INVOICE_LINK_PLACEHOLDER, MAX_REMINDER_LENGTH, REMINDER_AUTHORIZATION_DAYS, REMINDER_TEMPLATES, REMINDER_WORDING_VERSION, dayWords, linkPlaceholderCount, normalizeSetup, phaseOfStepKey,
  previewReminderBody, reminderTextProblem, renderReminder,
} from "@/lib/invoices/reminder-text";
import { reminderAuthorizationHash } from "@/lib/invoices/reminder-hash";
import {
  AUTHORIZATION_PROBLEM_TEXT, LATE_GRACE_HOURS, authorizationProblem, decideReminder, invoiceStopReason, planReminders, reminderReasonText, type AuthorizationProblem, type DecisionFacts,
  type ExistingReminder, type InvoiceFacts, type ReminderRowStatus,
} from "@/lib/invoices/reminder-rules";
import { INVOICE_EVENT_TYPES, PAYLOAD_KEYS, activityFor, dedupeKeyFor, payloadFor, startsAutomations, type AnnounceFacts } from "@/lib/invoices/crm-events";
import { decideCloseRule, type CloseRuleFacts } from "@/lib/invoices/close-rule";
import { BLOCK_REASON_LABELS } from "@/lib/messaging";
import { CURRENCY_CODES, type CurrencyCode } from "@/lib/money";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const NOW = new Date("2026-11-06T09:30:00Z");

describe("the reminder wording", () => {
  const facts = { firstName: "Maria", business: "Atlas Plumbing", number: "INV-0004", totalMinor: 150_000, currency: "PHP" as CurrencyCode, dueOn: "2026-11-06" };

  it("is fixed text with the customer's link as a placeholder and nothing else typed by anyone", () => {
    const before = renderReminder({ ...facts, phase: "before_due" });
    const onDay = renderReminder({ ...facts, phase: "on_due" });
    const after = renderReminder({ ...facts, phase: "after_due" });
    expect(before.body).toBe("Hi Maria, this is a reminder from Atlas Plumbing that invoice INV-0004 for PHP 1,500.00 is due on 6 Nov 2026. You can view it and pay it here: {{invoice.link}}");
    expect(onDay.body).toBe("Hi Maria, invoice INV-0004 from Atlas Plumbing for PHP 1,500.00 is due today. You can view it and pay it here: {{invoice.link}}");
    expect(after.body).toContain("was due on 6 Nov 2026 and is not paid in full yet");
    expect(after.body).toContain("If you have already paid, thank you, and please ignore this message.");
    expect(before.subject).toBe("Reminder: invoice INV-0004 from Atlas Plumbing");
    for (const r of [before, onDay, after]) expect(reminderTextProblem(r.body)).toBeNull();
  });

  it("says nothing about fees, interest, collections, legal action or consequences, and invents nothing", () => {
    for (const t of Object.values(REMINDER_TEMPLATES)) expect(t).not.toMatch(/\b(fee|fees|interest|penalt|collection|legal|lawyer|court|suspend|cancel|final notice|urgent|immediately)\b/i);
  });

  it("greets by first name when there is one, and plainly when there is not", () => {
    expect(renderReminder({ ...facts, phase: "on_due", firstName: null }).body.startsWith("Hello, invoice INV-0004")).toBe(true);
    expect(renderReminder({ ...facts, phase: "on_due", firstName: "   " }).body.startsWith("Hello, ")).toBe(true);
  });

  it("states the invoice total in its own currency's exponent and a calendar date that reads the same everywhere", () => {
    expect(renderReminder({ ...facts, phase: "on_due", currency: "JPY", totalMinor: 15_000 }).body).toContain("JPY 15,000");
    expect(renderReminder({ ...facts, phase: "on_due", currency: "USD", totalMinor: 100 }).body).toContain("USD 1.00");
    expect(dayWords("2026-01-05")).toBe("5 Jan 2026");
    expect(dayWords("2026-12-31")).toBe("31 Dec 2026");
    expect(dayWords("garbage")).toBe("garbage");
  });

  it("can never carry a second placeholder, a web address or a brace, whatever the name, the business or the number holds (property)", () => {
    const r = rng(7);
    const nasty = ["{{invoice.link}}", "Bob {{invoice.link}} Smith", "http://evil.example/x", "https://www.example.com", "{business}", "}{", "Line\nbreak\r\nhere", "   ", "", "A".repeat(500), "{{review.link}}", "www.example.com"];
    for (let i = 0; i < 600; i += 1) {
      const phase = pick(r, ["before_due", "on_due", "after_due"] as const);
      const currency = pick(r, CURRENCY_CODES);
      const out = renderReminder({ phase, firstName: pick(r, nasty), business: pick(r, nasty), number: pick(r, nasty), totalMinor: 1 + Math.floor(r() * 900_000_000), currency, dueOn: "2026-11-06" });
      const problem = reminderTextProblem(out.body);
      // A business or number that is itself a web address is the business's own text: the guard refuses it rather than let a link ride in the reminder.
      if (/https?:\/\/|www\./i.test(out.body)) {
        expect(problem, out.body).not.toBeNull();
        continue;
      }
      expect(linkPlaceholderCount(out.body), out.body).toBe(1);
      expect(problem, out.body).toBeNull();
      expect(out.body.endsWith(INVOICE_LINK_PLACEHOLDER)).toBe(true);
      expect(out.body).not.toMatch(/[\r\n]/);
      expect(out.body.length).toBeLessThanOrEqual(MAX_REMINDER_LENGTH);
      // With a real link of about 90 characters the message stays short enough for a text message of a few segments.
      expect(out.body.replace(INVOICE_LINK_PLACEHOLDER, `https://app.example.com/pay/${"x".repeat(43)}`).length).toBeLessThanOrEqual(MAX_REMINDER_LENGTH + 80);
      expect(out.subject.length).toBeLessThanOrEqual(200);
    }
  });

  it("refuses a body that holds no link, two links, or an address of its own", () => {
    expect(reminderTextProblem("Please pay.")).toMatch(/exactly once/);
    expect(reminderTextProblem(`${INVOICE_LINK_PLACEHOLDER} and ${INVOICE_LINK_PLACEHOLDER}`)).toMatch(/exactly once/);
    expect(reminderTextProblem(`Pay at https://example.com/pay/abc ${INVOICE_LINK_PLACEHOLDER}`)).toMatch(/web address/);
    expect(reminderTextProblem(`${"x".repeat(MAX_REMINDER_LENGTH)} ${INVOICE_LINK_PLACEHOLDER}`)).toMatch(/too long/);
  });

  it("shows a person the link as words, not as a placeholder", () => {
    const body = previewReminderBody(renderReminder({ ...facts, phase: "on_due" }).body);
    expect(body).toContain("[the customer's own link to the invoice]");
    expect(body).not.toContain("{{");
  });

  it("maps a step key to its phase", () => {
    expect(phaseOfStepKey("before_due:-3")).toBe("before_due");
    expect(phaseOfStepKey("on_due:0")).toBe("on_due");
    expect(phaseOfStepKey("after_due:10")).toBe("after_due");
    expect(phaseOfStepKey("whenever:1")).toBeNull();
    for (const o of [-30, -3, -1, 0, 1, 3, 10, 60]) expect(phaseOfStepKey(stepKeyFor(o))).toBe(o < 0 ? "before_due" : o === 0 ? "on_due" : "after_due");
  });
});

describe("the fingerprint of what the owner authorizes", () => {
  const base = { offsetsDays: [-3, 0, 3, 10], max: 4, channels: ["email"] as const };

  it("is a sha256 that does not depend on the order or repetition of days and channels", () => {
    const h = reminderAuthorizationHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(reminderAuthorizationHash({ offsetsDays: [10, 3, 0, -3, 3], max: 4, channels: ["email", "email"] })).toBe(h);
    expect(reminderAuthorizationHash({ offsetsDays: [10, 3, 0, -3], max: 4, channels: ["email"] })).toBe(h);
  });

  it("changes with any day, the maximum, or any channel (so the authorization stops covering what would be sent)", () => {
    const h = reminderAuthorizationHash(base);
    const different = [
      { ...base, offsetsDays: [-3, 0, 3] }, { ...base, offsetsDays: [-3, 0, 3, 11] }, { ...base, offsetsDays: [-2, 0, 3, 10] }, { ...base, max: 3 }, { ...base, channels: ["email", "sms"] as const },
      { ...base, channels: ["sms"] as const }, { ...base, channels: ["email", "whatsapp"] as const },
    ];
    const seen = new Set([h]);
    for (const d of different) {
      const x = reminderAuthorizationHash(d);
      expect(x).not.toBe(h);
      seen.add(x);
    }
    expect(seen.size).toBe(different.length + 1);
  });

  it("is bound to the version of the wording, and the wording is a version that says it is a draft", () => {
    expect(REMINDER_WORDING_VERSION).toMatch(/^draft-\d{4}-\d{2}-\d{2}$/);
    expect(normalizeSetup({ offsetsDays: [3, -3, 3], max: 2, channels: ["whatsapp", "email"] })).toEqual({ offsetsDays: [-3, 3], max: 2, channels: ["email", "whatsapp"] });
  });
});

describe("whether the owner's authorization still holds", () => {
  const ok = { enabled: true, authorizedAt: new Date("2026-10-01T00:00:00Z"), storedHash: "a".repeat(64), currentHash: "a".repeat(64), authorizerIsOwner: true, now: new Date("2026-10-20T00:00:00Z") };

  it("holds only when switched on, authorized, unchanged, recent and by someone who is still an owner", () => {
    expect(authorizationProblem(ok)).toBeNull();
    expect(authorizationProblem({ ...ok, enabled: false })).toBe("reminders_off");
    expect(authorizationProblem({ ...ok, authorizedAt: null })).toBe("never_authorized");
    expect(authorizationProblem({ ...ok, storedHash: null })).toBe("never_authorized");
    expect(authorizationProblem({ ...ok, currentHash: "b".repeat(64) })).toBe("wording_changed");
    expect(authorizationProblem({ ...ok, authorizerIsOwner: false })).toBe("authorizer_gone");
  });

  it("lapses after exactly the standing-authorization period", () => {
    const at = ok.authorizedAt.getTime();
    expect(authorizationProblem({ ...ok, now: new Date(at + REMINDER_AUTHORIZATION_DAYS * 86_400_000) })).toBeNull();
    expect(authorizationProblem({ ...ok, now: new Date(at + REMINDER_AUTHORIZATION_DAYS * 86_400_000 + 1) })).toBe("expired");
  });

  it("explains every way it can fail in a plain sentence", () => {
    const all: AuthorizationProblem[] = ["reminders_off", "never_authorized", "wording_changed", "expired", "authorizer_gone"];
    for (const p of all) expect(AUTHORIZATION_PROBLEM_TEXT[p].length).toBeGreaterThan(20);
  });
});

describe("deciding whether a reminder goes", () => {
  const owing: InvoiceFacts = { status: "issued", paymentStatus: "unpaid", writtenOff: false, balanceMinor: 150_000, dueOn: "2026-11-06", hasCustomer: true };
  const base: DecisionFacts = {
    now: NOW, dueAt: new Date("2026-11-06T09:00:00Z"), invoice: owing, invoicingEnabled: true, remindersEnabled: true, stepStillPlanned: true, customerHeld: false, authorization: null, workspaceRunnable: true,
    alreadyQueued: 0, max: 4,
  };

  it("sends when everything holds", () => {
    expect(decideReminder(base)).toEqual({ action: "send" });
  });

  it("stops for everything that makes a reminder wrong, with the reason", () => {
    const stop = (over: Partial<DecisionFacts>) => decideReminder({ ...base, ...over });
    expect(stop({ invoice: { ...owing, paymentStatus: "paid" } })).toEqual({ action: "cancel", reason: "paid" });
    expect(stop({ invoice: { ...owing, status: "void" } })).toEqual({ action: "cancel", reason: "invoice_voided" });
    expect(stop({ invoice: { ...owing, status: "draft" } })).toEqual({ action: "cancel", reason: "invoice_not_issued" });
    expect(stop({ invoice: { ...owing, writtenOff: true } })).toEqual({ action: "cancel", reason: "written_off" });
    expect(stop({ invoice: { ...owing, balanceMinor: 0 } })).toEqual({ action: "cancel", reason: "nothing_owed" });
    expect(stop({ invoice: { ...owing, hasCustomer: false } })).toEqual({ action: "cancel", reason: "no_customer" });
    expect(stop({ invoice: { ...owing, dueOn: null } })).toEqual({ action: "cancel", reason: "no_due_date" });
    expect(stop({ invoice: { ...owing, paymentStatus: "disputed" } })).toEqual({ action: "skip", reason: "disputed" });
    expect(stop({ invoicingEnabled: false })).toEqual({ action: "cancel", reason: "invoicing_off" });
    expect(stop({ remindersEnabled: false })).toEqual({ action: "cancel", reason: "reminders_off" });
    expect(stop({ stepStillPlanned: false })).toEqual({ action: "cancel", reason: "schedule_changed" });
    expect(stop({ customerHeld: true })).toEqual({ action: "skip", reason: "held_by_person" });
  });

  it("never sends late: a reminder more than a day past its time is skipped, and exactly a day is still on time", () => {
    const due = base.dueAt.getTime();
    expect(decideReminder({ ...base, now: new Date(due + LATE_GRACE_HOURS * 3_600_000) })).toEqual({ action: "send" });
    expect(decideReminder({ ...base, now: new Date(due + LATE_GRACE_HOURS * 3_600_000 + 1) })).toEqual({ action: "skip", reason: "too_late" });
  });

  it("stops at the cap per invoice", () => {
    expect(decideReminder({ ...base, alreadyQueued: 3, max: 4 })).toEqual({ action: "send" });
    expect(decideReminder({ ...base, alreadyQueued: 4, max: 4 })).toEqual({ action: "skip", reason: "cap_reached" });
    expect(decideReminder({ ...base, alreadyQueued: 9, max: 4 })).toEqual({ action: "skip", reason: "cap_reached" });
  });

  it("holds a reminder back, without losing it, while authorization has lapsed or the workspace is paused", () => {
    expect(decideReminder({ ...base, authorization: "wording_changed" })).toEqual({ action: "wait", reason: "authorization_needed" });
    expect(decideReminder({ ...base, workspaceRunnable: false })).toEqual({ action: "wait", reason: "automation_paused" });
    // But what makes the reminder pointless wins over waiting: a paid invoice is cancelled even while the workspace is paused.
    expect(decideReminder({ ...base, workspaceRunnable: false, invoice: { ...owing, paymentStatus: "paid" } })).toEqual({ action: "cancel", reason: "paid" });
    expect(decideReminder({ ...base, authorization: "expired", now: new Date(base.dueAt.getTime() + 3 * 86_400_000) })).toEqual({ action: "skip", reason: "too_late" });
  });

  it("sends if and only if every condition holds (property over 6000 random combinations)", () => {
    const r = rng(2026);
    let sent = 0;
    for (let i = 0; i < 6000; i += 1) {
      const f: DecisionFacts = {
        now: new Date(NOW.getTime() + Math.floor((r() - 0.3) * 3 * 86_400_000)),
        dueAt: base.dueAt,
        invoice: {
          status: pick(r, ["draft", "pending_approval", "issued", "issued", "issued", "void"] as const),
          paymentStatus: pick(r, ["unpaid", "unpaid", "partially_paid", "paid", "disputed"] as const),
          writtenOff: r() < 0.1, balanceMinor: pick(r, [0, 1, 150_000]), dueOn: r() < 0.05 ? null : "2026-11-06", hasCustomer: r() > 0.1,
        },
        invoicingEnabled: r() > 0.1, remindersEnabled: r() > 0.1, stepStillPlanned: r() > 0.1, customerHeld: r() < 0.1, authorization: r() < 0.2 ? "expired" : null, workspaceRunnable: r() > 0.15,
        alreadyQueued: Math.floor(r() * 6), max: 1 + Math.floor(r() * 5),
      };
      const d = decideReminder(f);
      const allGood = f.invoicingEnabled && f.remindersEnabled && f.stepStillPlanned && !f.customerHeld && f.authorization === null && f.workspaceRunnable && f.alreadyQueued < f.max
        && invoiceStopReason(f.invoice) === null && f.now.getTime() - f.dueAt.getTime() <= LATE_GRACE_HOURS * 3_600_000;
      expect(d.action === "send", JSON.stringify(f)).toBe(allGood);
      if (d.action === "send") sent += 1;
      // A reminder for money that is not owed is never sent, whatever else is true.
      if (f.invoice.status !== "issued" || f.invoice.paymentStatus === "paid" || f.invoice.writtenOff || f.invoice.balanceMinor === 0) expect(d.action).not.toBe("send");
    }
    expect(sent).toBeGreaterThan(50);
  });

  it("has a plain sentence for every reason it can give, and for every reason the send chain can give", () => {
    for (const code of ["invoicing_off", "invoice_not_issued", "invoice_voided", "paid", "written_off", "disputed", "nothing_owed", "reminders_off", "schedule_changed", "no_customer", "held_by_person", "no_due_date", "too_late", "cap_reached", "already_past", "authorization_needed", "automation_paused", "invoice_changed", "invoice_link_unavailable", "no_channel_allowed"]) {
      expect(reminderReasonText(code).length, code).toBeGreaterThan(10);
    }
    // Every reason the send chain gives has words; where this product has better words for a reminder, they win.
    for (const code of Object.keys(BLOCK_REASON_LABELS)) expect(reminderReasonText(code).length, code).toBeGreaterThan(10);
    expect(reminderReasonText("no_consent")).toBe(BLOCK_REASON_LABELS.no_consent);
    expect(reminderReasonText("credits")).toBe(BLOCK_REASON_LABELS.credits);
    expect(reminderReasonText(null)).toBe("");
    expect(reminderReasonText("something_new")).toBe("It could not be sent.");
  });
});

describe("planning the reminder rows of one invoice", () => {
  const owing: InvoiceFacts = { status: "issued", paymentStatus: "unpaid", writtenOff: false, balanceMinor: 150_000, dueOn: "2026-11-06", hasCustomer: true };
  const input = { remindersEnabled: true, offsetsDays: [-3, 0, 3, 10], max: 4, tz: "UTC", now: new Date("2026-10-23T12:00:00Z"), invoice: owing, existing: [] as ExistingReminder[] };

  it("plans a row for each day at 9:00 in the workspace's time zone, and stores a day already past as skipped", () => {
    const ops = planReminders(input);
    expect(ops.map((o) => (o.op === "insert" ? [o.stepKey, o.status, o.dueAt.toISOString()] : null))).toEqual([
      ["before_due:-3", "scheduled", "2026-11-03T09:00:00.000Z"], ["on_due:0", "scheduled", "2026-11-06T09:00:00.000Z"], ["after_due:3", "scheduled", "2026-11-09T09:00:00.000Z"], ["after_due:10", "scheduled", "2026-11-16T09:00:00.000Z"],
    ]);
    const late = planReminders({ ...input, now: new Date("2026-11-07T00:00:00Z") });
    expect(late.map((o) => (o.op === "insert" ? [o.stepKey, o.status, o.reason] : null))).toEqual([
      ["before_due:-3", "skipped", "already_past"], ["on_due:0", "skipped", "already_past"], ["after_due:3", "scheduled", null], ["after_due:10", "scheduled", null],
    ]);
    // A time zone moves the instant, not the day.
    const manila = planReminders({ ...input, tz: "Asia/Manila" });
    expect(manila[0].op === "insert" && manila[0].dueAt.toISOString()).toBe("2026-11-03T01:00:00.000Z");
  });

  it("plans nothing while reminders are off, and cancels what was scheduled", () => {
    const existing: ExistingReminder[] = [{ stepKey: "on_due:0", status: "scheduled" }, { stepKey: "after_due:3", status: "queued" }];
    expect(planReminders({ ...input, remindersEnabled: false })).toEqual([]);
    expect(planReminders({ ...input, remindersEnabled: false, existing })).toEqual([{ op: "cancel", stepKey: "on_due:0", reason: "reminders_off" }]);
  });

  it("cancels what was scheduled for an invoice that can no longer be reminded about, and touches nothing that already has an outcome", () => {
    const existing: ExistingReminder[] = [{ stepKey: "on_due:0", status: "scheduled" }, { stepKey: "after_due:3", status: "queued" }, { stepKey: "before_due:-3", status: "blocked" }, { stepKey: "after_due:10", status: "skipped" }];
    for (const [invoice, reason] of [
      [{ ...owing, paymentStatus: "paid" as const }, "paid"], [{ ...owing, status: "void" as const }, "invoice_voided"], [{ ...owing, writtenOff: true }, "written_off"], [{ ...owing, paymentStatus: "disputed" as const }, "disputed"],
    ] as const) {
      expect(planReminders({ ...input, invoice, existing }), reason).toEqual([{ op: "cancel", stepKey: "on_due:0", reason }]);
    }
  });

  it("cancels a scheduled day that is no longer planned, adds the new ones, and is stable when applied twice (property)", () => {
    const r = rng(11);
    const SETS = [[-3, 0, 3, 10], [0], [-7, -1, 5], [3, 10, 20], [-3, 0, 3, 10], []];
    for (let i = 0; i < 300; i += 1) {
      const first = pick(r, SETS);
      const second = pick(r, SETS);
      const max = 1 + Math.floor(r() * 5);
      const now = new Date(NOW.getTime() + Math.floor(r() * 25 * 86_400_000));
      const rows = new Map<string, { status: ReminderRowStatus; reason: string | null }>();
      const apply = (offsets: number[]) => {
        const ops = planReminders({ ...input, offsetsDays: offsets, max, now, existing: [...rows].map(([stepKey, v]) => ({ stepKey, status: v.status, reason: v.reason })) });
        for (const o of ops) {
          if (o.op === "insert") {
            expect(rows.has(o.stepKey), "no duplicate row").toBe(false);
            rows.set(o.stepKey, { status: o.status, reason: o.reason });
          } else if (o.op === "reopen") {
            expect(rows.get(o.stepKey)).toMatchObject({ status: "cancelled", reason: "schedule_changed" });
            expect(o.dueAt.getTime(), "a reopened reminder is at most a day behind").toBeGreaterThan(now.getTime() - LATE_GRACE_HOURS * 3_600_000);
            rows.set(o.stepKey, { status: "scheduled", reason: null });
          } else {
            expect(rows.get(o.stepKey)?.status).toBe("scheduled");
            rows.set(o.stepKey, { status: "cancelled", reason: o.reason });
          }
        }
        return ops;
      };
      apply(first);
      apply(second);
      // Going back to the first choice brings back the days both choices share, and applying a plan twice changes nothing.
      apply(first);
      const snapshot = JSON.stringify([...rows]);
      expect(apply(first), "applying the same plan again changes nothing").toEqual([]);
      expect(JSON.stringify([...rows])).toBe(snapshot);
      // Every scheduled row is a planned day and is in the future; nothing is ever scheduled in the past.
      const planned = new Set(reminderSchedule({ dueOn: "2026-11-06", offsets: first, max, tz: "UTC", now }).map((s) => s.stepKey));
      for (const [key, v] of rows) if (v.status === "scheduled") expect(planned.has(key), key).toBe(true);
    }
  });

  it("reopens a reminder that was cancelled only by switching reminders off or changing the days, never one a payment or a void cancelled", () => {
    const existing: ExistingReminder[] = [
      { stepKey: "before_due:-3", status: "cancelled", reason: "reminders_off" }, { stepKey: "on_due:0", status: "cancelled", reason: "schedule_changed" },
      { stepKey: "after_due:3", status: "cancelled", reason: "paid" }, { stepKey: "after_due:10", status: "cancelled", reason: "invoice_voided" },
    ];
    expect(planReminders({ ...input, existing }).map((o) => [o.op, o.stepKey])).toEqual([["reopen", "before_due:-3"], ["reopen", "on_due:0"]]);
    // One that is behind but within the day it may be held back is brought back (it goes that late and no later); one further behind is not: nothing is sent late.
    expect(planReminders({ ...input, existing, now: new Date("2026-11-04T02:00:00Z") }).map((o) => [o.op, o.stepKey])).toEqual([["reopen", "before_due:-3"], ["reopen", "on_due:0"]]);
    expect(planReminders({ ...input, existing, now: new Date("2026-11-05T00:00:00Z") }).map((o) => [o.op, o.stepKey])).toEqual([["reopen", "on_due:0"]]);
  });
});

describe("what an invoice announces to the CRM", () => {
  const base: AnnounceFacts = { invoiceId: "11111111-1111-4111-8111-111111111111", number: "INV-0004", currency: "PHP", totalMinor: 150_000, opportunityId: "22222222-2222-4222-8222-222222222222", dueOn: "2026-11-06", balanceMinor: 100_000 };
  const full: AnnounceFacts = { ...base, paymentId: "33333333-3333-4333-8333-333333333333", refundId: "44444444-4444-4444-8444-444444444444", attemptId: "55555555-5555-4555-8555-555555555555", providerEventId: "evt_abc123", amountMinor: 50_000, verification: "provider_confirmed", livemode: true, daysOverdue: 4 };

  it("announces the eight things the audit lists, and no others", () => {
    expect([...INVOICE_EVENT_TYPES]).toEqual(["invoice.created", "invoice.issued", "invoice.paid", "invoice.overdue", "invoice.voided", "payment.verified", "payment.failed", "payment.refunded"]);
  });

  it("carries ids, numbers, currencies and decimal amounts only: keys stay inside the allowed list and no value is a person's or a provider's detail", () => {
    for (const type of INVOICE_EVENT_TYPES) {
      const p = payloadFor(type, full);
      for (const k of Object.keys(p)) expect(PAYLOAD_KEYS as readonly string[], `${type}.${k}`).toContain(k);
      const text = JSON.stringify(p);
      expect(text).not.toMatch(/@|https?:|\+\d{6,}|\b\d{13,19}\b|evt_abc123|secret|token/i);
      expect(p.invoiceId).toBe(base.invoiceId);
      expect(p.opportunityId).toBe(base.opportunityId);
      expect(p.total).toBe("1500.00");
    }
    expect(payloadFor("payment.verified", full)).toMatchObject({ paymentId: full.paymentId, amount: "500.00", verification: "provider_confirmed", livemode: true });
    expect(payloadFor("invoice.overdue", full)).toMatchObject({ dueOn: "2026-11-06", balance: "1000.00", daysOverdue: 4 });
    expect(payloadFor("payment.refunded", full)).toMatchObject({ refundId: full.refundId, amount: "500.00" });
    expect(payloadFor("invoice.paid", { ...full, currency: "JPY", totalMinor: 15_000 })).toMatchObject({ total: "15000", currency: "JPY" });
  });

  it("makes each announcement once: one key per invoice, per due date, per payment and per refund", () => {
    expect(dedupeKeyFor("invoice.created", full)).toBe(`invoice.created:${base.invoiceId}`);
    expect(dedupeKeyFor("invoice.overdue", full)).toBe(`invoice.overdue:${base.invoiceId}:2026-11-06`);
    expect(dedupeKeyFor("invoice.overdue", { ...full, dueOn: "2026-12-01" })).not.toBe(dedupeKeyFor("invoice.overdue", full));
    expect(dedupeKeyFor("payment.verified", full)).toBe(`payment.verified:${full.paymentId}`);
    expect(dedupeKeyFor("payment.failed", full)).toBe(`payment.failed:${full.paymentId}`);
    expect(dedupeKeyFor("payment.failed", { ...full, paymentId: null })).toBe(`payment.failed:${full.attemptId}:evt_abc123`);
    expect(dedupeKeyFor("payment.failed", { ...full, paymentId: null, providerEventId: "evt_other" })).not.toBe(dedupeKeyFor("payment.failed", { ...full, paymentId: null }));
    expect(dedupeKeyFor("payment.refunded", full)).toBe(`payment.refunded:${full.refundId}`);
    const keys = INVOICE_EVENT_TYPES.map((t) => dedupeKeyFor(t, full));
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(300);
  });

  it("starts nothing for money that moved in a provider's test mode, and everything otherwise", () => {
    for (const type of INVOICE_EVENT_TYPES) {
      expect(startsAutomations(type, { ...full, livemode: false }), type).toBe(false);
      expect(startsAutomations(type, { ...full, livemode: true }), type).toBe(true);
      expect(startsAutomations(type, { ...full, livemode: undefined }), type).toBe(true);
    }
  });

  it("leaves a short, honest line on the timeline, and says plainly when money was a test or recorded by hand", () => {
    expect(activityFor("invoice.issued", full).summary).toBe("Invoice INV-0004 issued for PHP 1,500.00, due 6 Nov 2026");
    expect(activityFor("invoice.paid", { ...full, verification: "manual" }).summary).toBe("Invoice INV-0004 paid in full (recorded by hand)");
    expect(activityFor("invoice.paid", { ...full, livemode: false }).summary).toContain("test mode: no real money moved");
    expect(activityFor("payment.verified", full).summary).toBe("Payment of PHP 500.00 for invoice INV-0004 confirmed by the payment provider");
    expect(activityFor("payment.recorded", full).summary).toContain("recorded by hand (not confirmed by a provider)");
    expect(activityFor("payment.failed", full).summary).toContain("still owed");
    expect(activityFor("invoice.created", { ...base, totalMinor: 0 }).summary).toBe("Invoice draft started");
    for (const type of [...INVOICE_EVENT_TYPES, "payment.recorded" as const]) {
      const a = activityFor(type, full);
      expect(a.kind).toBe(type);
      expect(a.summary.length).toBeLessThanOrEqual(300);
      expect(a.kind).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe("a test payment never closes a deal", () => {
  const facts: CloseRuleFacts = { rule: "auto_won", closesDeal: true, invoiceStatus: "issued", paymentStatus: "paid", hasDispute: false, dealStatus: "open", allProviderConfirmed: true, countManualAsVerified: false, alreadyApplied: false };

  it("decides nothing for any rule when a counted payment was made in a provider's test mode", () => {
    expect(decideCloseRule(facts)).toEqual({ action: "won" });
    expect(decideCloseRule({ ...facts, rule: "task" })).toEqual({ action: "task" });
    for (const rule of ["task", "auto_won"] as const) expect(decideCloseRule({ ...facts, rule, hasTestPayment: true })).toEqual({ action: "none", reason: "test_payment" });
    expect(decideCloseRule({ ...facts, rule: "none", hasTestPayment: true })).toEqual({ action: "none", reason: "rule_none" });
  });
});
