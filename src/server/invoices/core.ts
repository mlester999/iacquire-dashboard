import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { InvoiceInputError } from "@/lib/invoices/errors";
import { MoneyError, type CurrencyCode } from "@/lib/money";
import type { InvoicePaymentStatus, InvoiceStatus } from "@/lib/invoices/state";

// What the invoice services share: the row shapes, the loaders, the history log and the few conversions between the database and the code. No permission checks live
// here: the callers make them. Every query names the workspace; an id from another workspace is simply not found.

/** Postgres bigint comes back as a string from the hosted driver and as a number from the embedded one. The columns are capped at 2^53 - 1, so Number() is exact. */
export function toMinor(v: string | number | bigint | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n)) throw new AppError("internal", "An amount was outside the supported range.");
  return n;
}

/** Turns what the pure rules and the money module throw into the message a person is shown. */
export function asAppError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof InvoiceInputError || e instanceof MoneyError) throw new AppError("invalid_input", e.message);
    throw e;
  }
}

export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface InvoiceRow {
  id: string;
  org_id: string;
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  source_type: "proposal" | null;
  source_id: string | null;
  status: InvoiceStatus;
  payment_status: InvoicePaymentStatus;
  written_off_at: Date | null;
  written_off_by: string | null;
  write_off_reason: string | null;
  number: string | null;
  currency: CurrencyCode;
  tax_inclusive: boolean;
  subtotal_minor: string;
  tax_minor: string;
  total_minor: string;
  paid_minor: string;
  refunded_minor: string;
  balance_minor: string;
  overpaid_minor: string;
  issue_on: string | null;
  due_on: string | null;
  bill_to: Record<string, unknown>;
  bill_from: Record<string, unknown>;
  payment_instructions: string | null;
  notes: string | null;
  terms: string | null;
  content_hash: string | null;
  version: number;
  approved_version: number | null;
  approved_by: string | null;
  approved_at: Date | null;
  closes_deal: boolean;
  public_token_version: number;
  first_viewed_at: Date | null;
  issued_at: Date | null;
  issued_by: string | null;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_via: "manual" | "workflow" | "deal";
  created_at: Date;
  updated_at: Date;
}

/** Every readable column of an invoice (never the link hash), with the bigint columns as text and the dates as plain days. */
export const INVOICE_COLUMNS = `i.id, i.org_id, i.contact_id, i.company_id, i.opportunity_id, i.source_type, i.source_id, i.status, i.payment_status, i.written_off_at, i.written_off_by,
  i.write_off_reason, i.number, i.currency, i.tax_inclusive, i.subtotal_minor::text as subtotal_minor, i.tax_minor::text as tax_minor, i.total_minor::text as total_minor,
  i.paid_minor::text as paid_minor, i.refunded_minor::text as refunded_minor, i.balance_minor::text as balance_minor, i.overpaid_minor::text as overpaid_minor,
  to_char(i.issue_on, 'YYYY-MM-DD') as issue_on, to_char(i.due_on, 'YYYY-MM-DD') as due_on, i.bill_to, i.bill_from, i.payment_instructions, i.notes, i.terms, i.content_hash,
  i.version, i.approved_version, i.approved_by, i.approved_at, i.closes_deal, i.public_token_version, i.first_viewed_at, i.issued_at, i.issued_by, i.voided_at, i.voided_by,
  i.void_reason, i.idempotency_key, i.created_by, i.created_via, i.created_at, i.updated_at`;

export async function loadInvoiceRow(db: Queryable, orgId: string, id: string, lock = false): Promise<InvoiceRow | null> {
  const { rows } = await db.query<InvoiceRow>(`select ${INVOICE_COLUMNS} from customer_invoices i where i.id = $1 and i.org_id = $2${lock ? " for update of i" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

export interface LineRow {
  id: string;
  position: number;
  description: string;
  quantity_milli: number;
  unit_price_minor: string;
  discount_bps: number | null;
  tax_rate_bps: number | null;
  gross_minor: string;
  discount_minor: string;
  net_minor: string;
  tax_minor: string;
  total_minor: string;
  ex_tax_minor: string;
}

export const LINE_COLUMNS = `id, position, description, quantity_milli, unit_price_minor::text as unit_price_minor, discount_bps, tax_rate_bps, gross_minor::text as gross_minor,
  discount_minor::text as discount_minor, net_minor::text as net_minor, tax_minor::text as tax_minor, total_minor::text as total_minor, ex_tax_minor::text as ex_tax_minor`;

export async function loadLines(db: Queryable, orgId: string, invoiceId: string): Promise<LineRow[]> {
  const { rows } = await db.query<LineRow>(`select ${LINE_COLUMNS} from customer_invoice_lines where invoice_id = $1 and org_id = $2 order by position`, [invoiceId, orgId]);
  return rows;
}

export type InvoiceActorKind = "user" | "system" | "provider" | "workflow" | "customer";

/** Adds a line to an invoice's history. The detail holds ids, numbers, amounts and short labels only: never a customer's name or contact details, a card or a key. */
export async function addInvoiceEvent(db: Queryable, orgId: string, invoiceId: string, kind: string, actor: { id: string | null; kind: InvoiceActorKind }, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query("insert into customer_invoice_events (org_id, invoice_id, kind, actor_id, actor_kind, detail) values ($1, $2, $3, $4, $5, $6::jsonb)", [orgId, invoiceId, kind.slice(0, 40), actor.id, actor.kind, JSON.stringify(detail)]);
}

export interface SettingsRow {
  legalName: string | null;
  addressLines: string[];
  taxLabel: string | null;
  taxId: string | null;
  replyToEmail: string | null;
  numberPrefix: string;
  nextNumber: number;
  defaultCurrency: CurrencyCode | null;
  paymentTermsDays: number;
  defaultPaymentInstructions: string | null;
  footerNote: string | null;
  approvalRequiredForCreators: boolean;
  remindersEnabled: boolean;
  reminderOffsetsDays: number[];
  reminderMax: number;
  reminderChannels: Array<"email" | "sms" | "whatsapp">;
  remindersAuthorizedAt: string | null;
  remindersAuthorizedBy: string | null;
  /** Fingerprint of the wording, days, maximum and channels the owner authorized (src/lib/invoices/reminder-text.ts). */
  remindersBodyHash: string | null;
  closeRule: "none" | "task" | "auto_won";
  countManualAsVerified: boolean;
  version: number;
}

export const DEFAULT_SETTINGS: SettingsRow = {
  legalName: null, addressLines: [], taxLabel: null, taxId: null, replyToEmail: null, numberPrefix: "INV-", nextNumber: 1, defaultCurrency: null, paymentTermsDays: 14,
  defaultPaymentInstructions: null, footerNote: null, approvalRequiredForCreators: true, remindersEnabled: false, reminderOffsetsDays: [-3, 0, 3, 10], reminderMax: 4, reminderChannels: ["email"],
  remindersAuthorizedAt: null, remindersAuthorizedBy: null, remindersBodyHash: null, closeRule: "none", countManualAsVerified: false, version: 0,
};

interface SettingsDb {
  legal_name: string | null; address_lines: string[]; tax_label: string | null; tax_id: string | null; reply_to_email: string | null; number_prefix: string; next_number: string;
  default_currency: CurrencyCode | null; payment_terms_days: number; default_payment_instructions: string | null; footer_note: string | null; approval_required_for_creators: boolean;
  reminders_enabled: boolean; reminder_offsets_days: number[]; reminder_max: number; reminder_channels: Array<"email" | "sms" | "whatsapp">; reminders_authorized_at: Date | null;
  reminders_authorized_by: string | null; reminders_body_hash: string | null; close_rule: "none" | "task" | "auto_won"; count_manual_as_verified: boolean; version: number;
}

/** The workspace's invoice settings, or the defaults when it has never saved any (version 0). */
export async function readSettings(db: Queryable, orgId: string): Promise<SettingsRow> {
  const { rows } = await db.query<SettingsDb>(
    `select legal_name, address_lines, tax_label, tax_id, reply_to_email, number_prefix, next_number::text as next_number, default_currency, payment_terms_days, default_payment_instructions,
       footer_note, approval_required_for_creators, reminders_enabled, reminder_offsets_days, reminder_max, reminder_channels, reminders_authorized_at, reminders_authorized_by,
       reminders_body_hash, close_rule, count_manual_as_verified, version
     from customer_invoice_settings where org_id = $1`,
    [orgId],
  );
  const r = rows[0];
  if (!r) return { ...DEFAULT_SETTINGS };
  return {
    legalName: r.legal_name, addressLines: r.address_lines, taxLabel: r.tax_label, taxId: r.tax_id, replyToEmail: r.reply_to_email, numberPrefix: r.number_prefix, nextNumber: toMinor(r.next_number),
    defaultCurrency: r.default_currency, paymentTermsDays: r.payment_terms_days, defaultPaymentInstructions: r.default_payment_instructions, footerNote: r.footer_note,
    approvalRequiredForCreators: r.approval_required_for_creators, remindersEnabled: r.reminders_enabled, reminderOffsetsDays: r.reminder_offsets_days, reminderMax: r.reminder_max,
    reminderChannels: r.reminder_channels, remindersAuthorizedAt: iso(r.reminders_authorized_at), remindersAuthorizedBy: r.reminders_authorized_by, remindersBodyHash: r.reminders_body_hash,
    closeRule: r.close_rule, countManualAsVerified: r.count_manual_as_verified, version: r.version,
  };
}
