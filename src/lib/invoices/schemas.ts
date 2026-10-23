import { z } from "zod";
import { CURRENCY_CODES } from "@/lib/money";
import { isDay } from "@/lib/invoices/state";
import { NUMBER_PREFIX_RE } from "@/lib/invoices/number";
import { CLOSE_RULES } from "@/lib/invoices/close-rule";
import { MAX_LINES } from "@/lib/invoices/lines";

// The shapes the invoice services and the server actions accept. Money and quantities travel as the text a person typed, and are parsed with src/lib/money in
// one place (lines.ts); nothing here is a number a browser computed. Pure.

const uuid = z.string().uuid({ error: "That item was not found." });
const day = z.string().refine(isDay, { error: "Choose a real date." });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const lineSchema = z.object({
  description: z.string().max(400, { error: "A line's description can't be longer than 300 characters." }),
  quantity: z.string().max(20),
  unitPrice: z.string().max(30),
  discountPercent: z.string().max(10).nullish(),
  discountAmount: z.string().max(30).nullish(),
  taxPercent: z.string().max(10).nullish(),
});

/** The customer's details as typed on this invoice. Anything left empty is filled from the contact when the invoice is issued. */
export const billToSchema = z.object({
  name: z.string().max(160).nullish(),
  company: z.string().max(160).nullish(),
  email: z.string().max(200).refine((v) => v === "" || EMAIL.test(v), { error: "That email address does not look right." }).nullish(),
  phone: z.string().max(40).nullish(),
  addressLines: z.array(z.string().max(120)).max(6).optional(),
  taxId: z.string().max(60).nullish(),
});
export type BillToInput = z.infer<typeof billToSchema>;

export const draftInputSchema = z.object({
  contactId: uuid.nullish(),
  companyId: uuid.nullish(),
  opportunityId: uuid.nullish(),
  currency: z.enum(CURRENCY_CODES as [string, ...string[]], { error: "Choose one of the supported currencies." }).optional(),
  taxInclusive: z.boolean().optional(),
  lines: z.array(lineSchema).max(MAX_LINES, { error: `An invoice can have at most ${MAX_LINES} lines.` }).optional(),
  dueOn: day.nullish(),
  billTo: billToSchema.optional(),
  paymentInstructions: z.string().max(1000, { error: "The payment instructions can't be longer than 1,000 characters." }).nullish(),
  notes: z.string().max(2000, { error: "The notes can't be longer than 2,000 characters." }).nullish(),
  terms: z.string().max(2000, { error: "The terms can't be longer than 2,000 characters." }).nullish(),
  closesDeal: z.boolean().optional(),
  /** A repeated request with the same key makes one invoice (a double click, a redelivered event). */
  idempotencyKey: z.string().min(8).max(120).nullish(),
});
export type DraftInput = z.infer<typeof draftInputSchema>;

export const draftPatchSchema = draftInputSchema.omit({ idempotencyKey: true }).partial();
export type DraftPatch = z.infer<typeof draftPatchSchema>;

export const PAYMENT_METHODS = ["bank_transfer", "cash", "check", "card_terminal", "e_wallet", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  cash: "Cash",
  check: "Check",
  card_terminal: "Card, on your own terminal",
  e_wallet: "E-wallet (GCash, Maya and similar)",
  other: "Something else",
};

export const manualPaymentSchema = z.object({
  amount: z.string().max(30),
  receivedOn: day,
  method: z.enum(PAYMENT_METHODS, { error: "Choose how the payment was made." }),
  /** What the person saw that proves it: a transfer reference, a receipt number, who handed over the cash. Kept with the payment. */
  evidence: z.string().min(3, { error: "Say how you know it was paid (a transfer reference, a receipt number)." }).max(600),
  allowOverpayment: z.boolean().optional(),
  /** Confirms recording it although an online checkout for this invoice is open. */
  overrideOpenAttempt: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(120).nullish(),
});
export type ManualPaymentInput = z.infer<typeof manualPaymentSchema>;

export const refundSchema = z.object({
  amount: z.string().max(30),
  reason: z.string().min(3, { error: "Say why the money was handed back." }).max(400),
  idempotencyKey: z.string().min(8).max(120).nullish(),
});
export type RefundInput = z.infer<typeof refundSchema>;

export const reasonSchema = z.object({ reason: z.string().min(5, { error: "Give a reason of at least a few words." }).max(400) });

export const settingsPatchSchema = z.object({
  legalName: z.string().max(160).nullish(),
  addressLines: z.array(z.string().max(120)).max(6).optional(),
  taxLabel: z.string().max(40).nullish(),
  taxId: z.string().max(60).nullish(),
  replyToEmail: z.string().max(200).refine((v) => v === "" || EMAIL.test(v), { error: "That email address does not look right." }).nullish(),
  numberPrefix: z.string().refine((v) => NUMBER_PREFIX_RE.test(v), { error: "The number prefix can use letters, digits and . _ / - only, up to 12 characters." }).optional(),
  /** The next number to give out. It can be raised (to continue a sequence from another system), never lowered. */
  nextNumber: z.number().int().min(1).max(999_999_999_999).optional(),
  defaultCurrency: z.enum(CURRENCY_CODES as [string, ...string[]]).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  defaultPaymentInstructions: z.string().max(1000).nullish(),
  footerNote: z.string().max(600).nullish(),
  approvalRequiredForCreators: z.boolean().optional(),
  closeRule: z.enum(CLOSE_RULES).optional(),
  countManualAsVerified: z.boolean().optional(),
  reminderOffsetsDays: z.array(z.number().int()).max(8).optional(),
  reminderMax: z.number().int().min(1).max(8).optional(),
  /** Email unless the owner also allows text messages (which use service credits) or WhatsApp. Changing it withdraws the owner's authorization of the reminders. */
  reminderChannels: z.array(z.enum(["email", "sms", "whatsapp"])).min(1, { error: "Choose at least one channel for reminders." }).max(3).optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
