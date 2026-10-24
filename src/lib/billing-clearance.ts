// Pure rules for iAcquire's own setup payment: when it counts as confirmed, what a person must give to record a payment received outside a provider, what a waiver
// needs, and the words every screen uses. No server or database code, so a component may import it. The database enforces the same rules (migration 0099).
import { MoneyError, parseAmount } from "@/lib/money";
import { paidThroughProblem } from "@/lib/automation-studio/plan";

export type SetupPaymentStatus = "not_invoiced" | "invoiced" | "paid" | "waived" | "refunded";

/** The setup fee is cleared only by a verified payment or an explicit, audited waiver. Never by a status typed in, never by a guess. */
export const isSetupCleared = (status: string | null | undefined): boolean => status === "paid" || status === "waived";

/** The recorded reason for the one data step of migration 0099 (founder decision 1, open). The migration text and this constant are kept in step by a test. */
export const ACTIVATED_BEFORE_GATE_REASON = "Activated before the payment gate";

/** What the client sees on an AI employee while its setup payment is not confirmed. */
export const PAYMENT_REQUIRED_SENTENCE = "Your AI team starts after your setup payment is confirmed";

/** Why the agency cannot activate a client yet. */
export const PAYMENT_UNVERIFIED_MESSAGE = "The setup payment has not been confirmed. Record the payment, or waive the setup fee with a reason, on the client's billing tab.";

export const MAINTENANCE_PAYMENT_NOTE = "Maintenance becomes available once your setup payment is confirmed.";

export const PROVISIONING_PAYMENT_NOTE = "The setup payment is not confirmed, so no AI employee profile is started for this client.";

export const SETUP_STATUS_LABEL: Record<SetupPaymentStatus, string> = {
  not_invoiced: "Not invoiced",
  invoiced: "Invoiced, not confirmed",
  paid: "Paid",
  waived: "Waived",
  refunded: "Refunded",
};

export interface SetupStatusCopy {
  label: string;
  tone: "success" | "warning" | "neutral" | "danger";
  cleared: boolean;
  detail: string;
}

/** One honest line per status. "Paid" is only ever said of a verified payment: no text here says a payment was detected unless a provider confirmed it. */
export function setupStatusCopy(status: string | null | undefined): SetupStatusCopy {
  switch (status) {
    case "paid":
      return { label: "Paid", tone: "success", cleared: true, detail: "A verified payment cleared the setup fee." };
    case "waived":
      return { label: "Waived", tone: "success", cleared: true, detail: "The setup fee was waived by iAcquire, with a recorded reason." };
    case "refunded":
      return { label: "Refunded", tone: "danger", cleared: false, detail: "The setup fee was refunded. Nothing new is provisioned until a payment or a waiver is recorded; what is already running is not paused." };
    case "invoiced":
      return { label: "Invoiced, not confirmed", tone: "warning", cleared: false, detail: "Waiting for a payment to be confirmed." };
    default:
      return { label: "Not confirmed", tone: "warning", cleared: false, detail: "No payment has been confirmed and the fee has not been waived." };
  }
}

// ---------------------------------------------------------------------------
// How a payment is described on the agency screens
// ---------------------------------------------------------------------------

const PAYMENT_STATUS_COPY: Record<string, { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  paid: { label: "Paid", tone: "success" },
  partially_refunded: { label: "Partly refunded", tone: "warning" },
  refunded: { label: "Refunded", tone: "neutral" },
  pending: { label: "Waiting for the client", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  mismatch: { label: "Did not match the checkout", tone: "danger" },
  disputed: { label: "Disputed", tone: "danger" },
};

export function paymentStatusCopy(status: string): { label: string; tone: "success" | "warning" | "neutral" | "danger" } {
  return PAYMENT_STATUS_COPY[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" };
}

/**
 * Where the proof of a payment came from, said plainly: a person who saw the money arrive, or a provider whose signed notice the portal checked. A payment that is not
 * paid yet is never described as confirmed.
 */
export function paymentWayLabel(p: { provider: string; method: string | null; status: string }): string {
  const received = p.status === "paid" || p.status === "refunded" || p.status === "partially_refunded";
  if (p.provider === "manual") return `Recorded by hand${p.method ? `: ${MANUAL_METHOD_LABEL[p.method as ManualPaymentMethod] ?? "other"}` : ""}`;
  if (p.provider === "paymongo") return received ? "PayMongo, confirmed by its signed notice" : "PayMongo checkout";
  if (p.provider === "paypal") return received ? "PayPal, confirmed by its signed notice" : "PayPal checkout";
  return p.provider;
}

// ---------------------------------------------------------------------------
// A payment received outside a provider
// ---------------------------------------------------------------------------

/** Kinds a person may record by hand. Prepaid credit is not one: credit is granted by a provider-verified payment or by an audited adjustment. */
export const MANUAL_PAYMENT_KINDS = ["setup_fee", "maintenance", "custom_project", "domain", "other"] as const;
export type ManualPaymentKind = (typeof MANUAL_PAYMENT_KINDS)[number];
export const MANUAL_KIND_LABEL: Record<ManualPaymentKind, string> = { setup_fee: "Setup fee", maintenance: "Maintenance plan", custom_project: "Custom project", domain: "Domain", other: "Other" };

export const MANUAL_PAYMENT_METHODS = ["bank_transfer", "cash", "check", "card", "paypal", "paymongo", "other"] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];
export const MANUAL_METHOD_LABEL: Record<ManualPaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  cash: "Cash",
  check: "Check",
  card: "Card",
  paypal: "PayPal (seen in the PayPal account)",
  paymongo: "PayMongo (seen in the PayMongo dashboard)",
  other: "Other",
};

/** Whole cents to the text a person types: 149900 -> "1499.00". Integer arithmetic only; never a float. */
export function centsToDollarText(cents: number): string {
  const whole = Math.trunc(Math.abs(cents) / 100);
  return `${cents < 0 ? "-" : ""}${whole}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

/** iAcquire's payments hold micro-dollars (1 USD = 1,000,000); whole cents are 10,000 of them. A payment is always a whole number of cents. */
export const MICROS_PER_CENT = 10_000;

/** A sanity ceiling for one recorded payment (US$100,000.00): a typo, not a policy. */
export const MAX_MANUAL_PAYMENT_CENTS = 10_000_000;
/** A payment date older than this many days is almost certainly a typo. */
export const MAX_PAID_ON_AGE_DAYS = 730;
export const MIN_REASON_CHARS = 10;
export const MAX_REASON_CHARS = 500;
export const MIN_NOTE_CHARS = 5;

const DAY_MS = 86_400_000;

/** A typed dollar amount to whole cents, exactly (src/lib/money, no floating point). The text is length-capped first so a long paste never reaches the pattern. */
function parseAmountText(value: unknown): number {
  const text = String(value ?? "").trim();
  if (text.length > 24) throw new MoneyError("invalid_amount", "Enter the amount in US dollars, such as 1499.00.");
  return parseAmount(text, "USD");
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const validDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
};

/**
 * The bank reference, receipt number or transaction id, trimmed with inner spaces collapsed. Linear: one pass, no backtracking. Returns null when it is not 3 to 120
 * ordinary characters (letters, digits, spaces and . _ - / # : +).
 */
export function normalizeExternalReference(input: string): string | null {
  const text = String(input).trim();
  if (text.length < 3 || text.length > 400) return null;
  let out = "";
  let lastSpace = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const ok = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || ".-_/#:+".includes(ch);
    if (ch === " " || ch === "\t") {
      if (!lastSpace) out += " ";
      lastSpace = true;
      continue;
    }
    if (!ok) return null;
    out += ch;
    lastSpace = false;
  }
  out = out.trim();
  return out.length >= 3 && out.length <= 120 ? out : null;
}

export interface ManualPaymentFields {
  kind: string;
  /** A decimal dollar amount typed by a person, such as "1499.00". Never a floating-point number. */
  amount: string;
  method: string;
  externalReference: string;
  /** The day the money arrived, YYYY-MM-DD. */
  paidOn: string;
  /** What the person checked (the statement line, the dashboard entry). */
  note: string;
  /** For a maintenance payment: the last day the payment covers. */
  paidThroughOn?: string | null;
}

export interface ManualPaymentValue {
  kind: ManualPaymentKind;
  amountCents: number;
  method: ManualPaymentMethod;
  externalReference: string;
  paidOn: string;
  note: string;
  paidThroughOn: string | null;
}

export type ManualPaymentCheck = { ok: true; value: ManualPaymentValue } | { ok: false; field: keyof ManualPaymentFields; error: string };

/**
 * Checks what a Super Admin typed before anything is written. `today` is the date in the workspace's time zone and `now` the clock; a payment may be dated up to a day
 * after `today` (the person recording it may be ahead of the workspace) and not older than two years. A setup fee must equal the agreed fee: anything else is a waiver
 * with a reason, not a payment that clears it.
 */
export function checkManualPayment(raw: ManualPaymentFields, ctx: { today: string; now: Date; agreedSetupFeeCents?: number | null }): ManualPaymentCheck {
  const fail = (field: keyof ManualPaymentFields, error: string): ManualPaymentCheck => ({ ok: false, field, error });
  const kind = MANUAL_PAYMENT_KINDS.find((k) => k === raw.kind);
  if (!kind) return fail("kind", "Choose what the payment was for.");
  let amountCents: number;
  try {
    amountCents = parseAmountText(raw.amount);
  } catch (e) {
    return fail("amount", e instanceof MoneyError ? e.message : "Enter the amount in US dollars, such as 1499.00.");
  }
  if (amountCents <= 0) return fail("amount", "Enter an amount above zero.");
  if (amountCents > MAX_MANUAL_PAYMENT_CENTS) return fail("amount", "That amount is above the most one recorded payment can be (US$100,000.00). Check it for a typo.");
  const method = MANUAL_PAYMENT_METHODS.find((m) => m === raw.method);
  if (!method) return fail("method", "Choose how the money arrived.");
  const externalReference = normalizeExternalReference(raw.externalReference ?? "");
  if (!externalReference) return fail("externalReference", "Enter the bank reference, receipt number or transaction id: 3 to 120 letters, digits or . _ - / # : +.");
  const paidOn = String(raw.paidOn ?? "").trim();
  if (!validDay(paidOn)) return fail("paidOn", "Enter the day the money arrived as a date.");
  if (dayNumber(paidOn) > dayNumber(ctx.today) + 1) return fail("paidOn", "The payment date is in the future.");
  if (dayNumber(paidOn) < dayNumber(ctx.today) - MAX_PAID_ON_AGE_DAYS) return fail("paidOn", "The payment date is more than two years ago. Check it for a typo.");
  const note = String(raw.note ?? "").trim();
  if (note.length < MIN_NOTE_CHARS) return fail("note", "Say what you checked to confirm the money arrived, such as the statement line or the dashboard entry.");
  if (note.length > MAX_REASON_CHARS) return fail("note", `Keep the note under ${MAX_REASON_CHARS} characters.`);
  let paidThroughOn: string | null = null;
  if (kind === "maintenance") {
    const through = String(raw.paidThroughOn ?? "").trim();
    const problem = paidThroughProblem(through, ctx.now);
    if (problem) return fail("paidThroughOn", problem);
    paidThroughOn = through;
  }
  if (kind === "setup_fee" && ctx.agreedSetupFeeCents != null && amountCents !== ctx.agreedSetupFeeCents) {
    return fail("amount", `The setup fee payment must equal the agreed fee of US$${(ctx.agreedSetupFeeCents / 100).toFixed(2)}. For any other arrangement, waive the setup fee and give the reason.`);
  }
  return { ok: true, value: { kind, amountCents, method, externalReference, paidOn, note, paidThroughOn } };
}

/** A waiver needs a person's stated reason; there is no silent waiver. */
export function checkWaiverReason(input: string): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = String(input ?? "").trim().replace(/\s+/g, " ");
  if (reason.length < MIN_REASON_CHARS) return { ok: false, error: `Say why the setup fee is waived (at least ${MIN_REASON_CHARS} characters).` };
  if (reason.length > MAX_REASON_CHARS) return { ok: false, error: `Keep the reason under ${MAX_REASON_CHARS} characters.` };
  return { ok: true, reason };
}

/** A refund needs an amount and the reason it was made. */
export function checkRefundFields(input: { amount: string; reason: string }): { ok: true; amountCents: number; reason: string } | { ok: false; field: "amount" | "reason"; error: string } {
  let amountCents: number;
  try {
    amountCents = parseAmountText(input.amount);
  } catch (e) {
    return { ok: false, field: "amount", error: e instanceof MoneyError ? e.message : "Enter the refund amount in US dollars." };
  }
  if (amountCents <= 0) return { ok: false, field: "amount", error: "Enter a refund amount above zero." };
  const reason = String(input.reason ?? "").trim().replace(/\s+/g, " ");
  if (reason.length < MIN_REASON_CHARS) return { ok: false, field: "reason", error: `Say why the refund was made (at least ${MIN_REASON_CHARS} characters).` };
  if (reason.length > MAX_REASON_CHARS) return { ok: false, field: "reason", error: `Keep the reason under ${MAX_REASON_CHARS} characters.` };
  return { ok: true, amountCents, reason };
}
