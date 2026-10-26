import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { isCurrency } from "@/lib/money";
import { freeTextProblem } from "@/lib/invoices/guards";
import { offsetsProblem } from "@/lib/invoices/reminders";
import { settingsPatchSchema, type SettingsPatch } from "@/lib/invoices/schemas";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { readSettings, type SettingsRow } from "@/server/invoices/core";
import { withdrawForChangedSetup } from "@/server/invoices/reminders";

export type InvoiceSettings = SettingsRow;

export async function getInvoiceSettings(ctx: OrgContext): Promise<InvoiceSettings> {
  if (!ctx.can("invoices.view")) throw new AppError("forbidden", "Your role can't see invoices.");
  return withUser(ctx.user.id, (db) => readSettings(db, ctx.org.orgId));
}

const clean = (v: string | null | undefined) => v?.replace(/\s+/g, " ").trim() || null;

function checkText(what: string, text: string | null) {
  const problem = freeTextProblem(what, text);
  if (problem) throw new AppError("invalid_input", problem);
}

/**
 * The workspace's invoice settings. Only the owner changes them. Raising the next number is allowed (to continue a sequence from another system); lowering it is not,
 * because a number already given out must never be given out again. Reminders cannot be switched on here: that takes the owner's authorization of the exact wording.
 */
export async function saveInvoiceSettings(ctx: OrgContext, rawPatch: unknown, expectedVersion: number): Promise<InvoiceSettings> {
  if (!ctx.can("invoices.settings")) throw new AppError("forbidden", "Only the business owner can change the invoice settings.");
  const patch: SettingsPatch = settingsPatchSchema.parse(rawPatch);
  return withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const cur = await readSettings(db, ctx.org.orgId);
    if (cur.version !== expectedVersion) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    if (patch.nextNumber !== undefined && patch.nextNumber < cur.nextNumber) throw new AppError("invalid_input", `The next invoice number can be raised but not lowered: ${cur.nextNumber} may already be in use.`);
    const reminderMax = patch.reminderMax ?? cur.reminderMax;
    const offsets = patch.reminderOffsetsDays !== undefined ? [...new Set(patch.reminderOffsetsDays)].sort((a, b) => a - b) : cur.reminderOffsetsDays;
    const offsetProblem = offsetsProblem(offsets, reminderMax);
    if (offsetProblem) throw new AppError("invalid_input", offsetProblem);
    if (patch.defaultCurrency && !isCurrency(patch.defaultCurrency)) throw new AppError("invalid_input", "Choose one of the supported currencies.");
    const next = {
      legalName: patch.legalName !== undefined ? clean(patch.legalName) : cur.legalName,
      addressLines: patch.addressLines !== undefined ? patch.addressLines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean) : cur.addressLines,
      taxLabel: patch.taxLabel !== undefined ? clean(patch.taxLabel) : cur.taxLabel,
      taxId: patch.taxId !== undefined ? clean(patch.taxId) : cur.taxId,
      replyToEmail: patch.replyToEmail !== undefined ? clean(patch.replyToEmail) : cur.replyToEmail,
      numberPrefix: patch.numberPrefix ?? cur.numberPrefix,
      nextNumber: patch.nextNumber ?? cur.nextNumber,
      defaultCurrency: patch.defaultCurrency !== undefined ? (patch.defaultCurrency && isCurrency(patch.defaultCurrency) ? patch.defaultCurrency : null) : cur.defaultCurrency,
      paymentTermsDays: patch.paymentTermsDays ?? cur.paymentTermsDays,
      defaultPaymentInstructions: patch.defaultPaymentInstructions !== undefined ? patch.defaultPaymentInstructions?.trim() || null : cur.defaultPaymentInstructions,
      footerNote: patch.footerNote !== undefined ? patch.footerNote?.trim() || null : cur.footerNote,
      approvalRequiredForCreators: patch.approvalRequiredForCreators ?? cur.approvalRequiredForCreators,
      closeRule: patch.closeRule ?? cur.closeRule,
      countManualAsVerified: patch.countManualAsVerified ?? cur.countManualAsVerified,
      reminderOffsetsDays: offsets,
      reminderMax,
      reminderChannels: patch.reminderChannels !== undefined ? [...new Set(patch.reminderChannels)] : cur.reminderChannels,
    };
    checkText("The business name", next.legalName);
    for (const line of next.addressLines) checkText("The address", line);
    checkText("The tax label", next.taxLabel);
    checkText("The payment instructions", next.defaultPaymentInstructions);
    checkText("The footer note", next.footerNote);
    const saved = await db.query(
      `insert into customer_invoice_settings (org_id, legal_name, address_lines, tax_label, tax_id, reply_to_email, number_prefix, next_number, default_currency, payment_terms_days,
         default_payment_instructions, footer_note, approval_required_for_creators, close_rule, count_manual_as_verified, reminder_offsets_days, reminder_max, version, updated_by, reminder_channels)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 1, $18, $20)
       on conflict (org_id) do update set legal_name = excluded.legal_name, address_lines = excluded.address_lines, tax_label = excluded.tax_label, tax_id = excluded.tax_id,
         reply_to_email = excluded.reply_to_email, number_prefix = excluded.number_prefix, next_number = greatest(customer_invoice_settings.next_number, excluded.next_number),
         default_currency = excluded.default_currency, payment_terms_days = excluded.payment_terms_days, default_payment_instructions = excluded.default_payment_instructions,
         footer_note = excluded.footer_note, approval_required_for_creators = excluded.approval_required_for_creators, close_rule = excluded.close_rule,
         count_manual_as_verified = excluded.count_manual_as_verified, reminder_offsets_days = excluded.reminder_offsets_days, reminder_max = excluded.reminder_max,
         reminder_channels = excluded.reminder_channels, version = customer_invoice_settings.version + 1, updated_by = excluded.updated_by, updated_at = now()
       where customer_invoice_settings.version = $19
       returning version`,
      [
        ctx.org.orgId, next.legalName, next.addressLines, next.taxLabel, next.taxId, next.replyToEmail, next.numberPrefix, next.nextNumber, next.defaultCurrency, next.paymentTermsDays,
        next.defaultPaymentInstructions, next.footerNote, next.approvalRequiredForCreators, next.closeRule, next.countManualAsVerified, next.reminderOffsetsDays, next.reminderMax,
        ctx.user.id, expectedVersion, next.reminderChannels,
      ],
    );
    // Two saves can pass the check above together; only one of them changes the row. The other changed nothing, so it must not say it did (or be audited as if).
    if (!saved.rows[0]) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k as keyof SettingsRow]));
    const after = await readSettings(db, ctx.org.orgId);
    // The owner authorized exact reminder days, channels and a maximum. If those changed, what was scheduled or queued under the old ones is withdrawn now and they authorize again.
    const withdrawn = await withdrawForChangedSetup(db, ctx.org.orgId, cur, after);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoices.settings_saved", targetType: "customer_invoice_settings", targetId: ctx.org.orgId, result: "success", metadata: { changed, remindersWithdrawn: withdrawn } }, db);
    return after;
  });
}
