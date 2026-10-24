"use client";

import * as React from "react";
import { AlertTriangle, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { authorizeRemindersAction, saveInvoiceSettingsAction, switchOffRemindersAction } from "@/app/actions/invoices";
import { CURRENCIES, CURRENCY_CODES, type CurrencyCode } from "@/lib/money";
import { CLOSE_RULES, CLOSE_RULE_LABELS, type CloseRule } from "@/lib/invoices/close-rule";
import { describeOffsets, nextNumberChange, offsetsToText, parseOffsetsText } from "@/lib/invoices/screens";
import { REMINDER_CHANNEL_LABELS, REMINDER_CHANNELS, type ReminderChannel } from "@/lib/invoices/reminder-text";
import { formatInstant } from "@/lib/invoices/labels";
import type { InvoiceSettings } from "@/server/invoices/settings";
import type { ReminderOverview } from "@/server/invoices/reminders";

// The owner's invoice settings and the owner's authorization of reminders. Everyone who can see invoices can read them; only the owner changes them. Reminders are off until
// the owner has read the exact messages and authorized them, and they switch themselves off if the days, channels or wording change.

const input16 = "text-[16px] sm:text-[14px]";

const CLOSE_RULE_WORDS: Record<CloseRule, string> = {
  none: "Nothing happens to the deal. The invoice is marked paid and you are told.",
  task: "A task asks the deal's owner whether to mark the deal won.",
  auto_won: "The deal is marked won, but only for an invoice a person marked to close it, paid in full by a payment the payment provider confirmed (or recorded by hand, if you count those below), with no dispute open.",
};

export function InvoiceSettingsPanel({ settings, canEdit }: { settings: InvoiceSettings; canEdit: boolean }) {
  const { run, busy } = useCrmAction();
  const [s, setS] = React.useState({
    legalName: settings.legalName ?? "", address: settings.addressLines.join("\n"), taxLabel: settings.taxLabel ?? "", taxId: settings.taxId ?? "", replyToEmail: settings.replyToEmail ?? "",
    numberPrefix: settings.numberPrefix, nextNumber: null as string | null, defaultCurrency: settings.defaultCurrency ?? "", paymentTermsDays: String(settings.paymentTermsDays),
    defaultPaymentInstructions: settings.defaultPaymentInstructions ?? "", footerNote: settings.footerNote ?? "", approvalRequiredForCreators: settings.approvalRequiredForCreators,
    closeRule: settings.closeRule as CloseRule, countManualAsVerified: settings.countManualAsVerified,
  });
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS((p) => ({ ...p, [k]: v }));
  // The next number is null until the person types in it: the field then shows the counter as the page knows it, and a save leaves it out. What they typed is checked against that counter.
  const next = nextNumberChange(s.nextNumber, settings.nextNumber);
  const terms = Number(s.paymentTermsDays);
  const problem = next.problem ?? (!Number.isInteger(terms) || terms < 0 || terms > 365 ? "Payment terms are a number of days from 0 to 365." : null);

  const save = () =>
    run("save", () => saveInvoiceSettingsAction({
      legalName: s.legalName, addressLines: s.address.split("\n").map((l) => l.trim()).filter(Boolean), taxLabel: s.taxLabel, taxId: s.taxId, replyToEmail: s.replyToEmail, numberPrefix: s.numberPrefix,
      ...(next.send !== undefined ? { nextNumber: next.send } : {}), defaultCurrency: s.defaultCurrency || null, paymentTermsDays: terms, defaultPaymentInstructions: s.defaultPaymentInstructions, footerNote: s.footerNote,
      approvalRequiredForCreators: s.approvalRequiredForCreators, closeRule: s.closeRule, countManualAsVerified: s.countManualAsVerified,
    }, settings.version), "Settings saved.");

  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); if (canEdit && !problem) void save(); }} aria-label="Invoice settings">
      {!canEdit && <p role="note" className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">Only the business owner changes these settings. You can read them.</p>}
      <fieldset disabled={!canEdit} className="space-y-6 disabled:opacity-90">
        <section aria-labelledby="set-doc" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <h2 id="set-doc" className="text-[15px] font-semibold text-ink">What the invoice says about your business</h2>
          <p className="text-[12.5px] text-muted">Printed on every invoice you issue and frozen when it is issued. Type only what is true: nothing here claims a tax registration, and the document is called an Invoice.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name on invoices" htmlFor="set-name" optional hint="Left empty, your workspace name is used."><Input id="set-name" className={input16} maxLength={160} value={s.legalName} onChange={(e) => set("legalName", e.target.value)} /></Field>
            <Field label="Reply-to email" htmlFor="set-email" optional><Input id="set-email" type="email" className={input16} maxLength={200} value={s.replyToEmail} onChange={(e) => set("replyToEmail", e.target.value)} /></Field>
            <Field label="Address" htmlFor="set-address" optional hint="One line per row, up to six."><Textarea id="set-address" rows={3} className={input16} value={s.address} onChange={(e) => set("address", e.target.value)} /></Field>
            <div className="grid gap-4">
              <Field label="Tax label" htmlFor="set-taxlabel" optional hint="For example VAT or GST. Shown beside the tax lines you enter."><Input id="set-taxlabel" className={input16} maxLength={40} value={s.taxLabel} onChange={(e) => set("taxLabel", e.target.value)} /></Field>
              <Field label="Tax number" htmlFor="set-taxid" optional><Input id="set-taxid" className={input16} maxLength={60} value={s.taxId} onChange={(e) => set("taxId", e.target.value)} /></Field>
            </div>
          </div>
        </section>

        <section aria-labelledby="set-num" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <h2 id="set-num" className="text-[15px] font-semibold text-ink">Numbers, currency and terms</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Number prefix" htmlFor="set-prefix" hint="Up to 12 letters, digits or . _ / -"><Input id="set-prefix" className={input16} maxLength={12} value={s.numberPrefix} onChange={(e) => set("numberPrefix", e.target.value)} /></Field>
            <Field label="Next number" htmlFor="set-next" hint="Can be raised, never lowered: a number given out is never reused."><Input id="set-next" inputMode="numeric" className={input16} value={s.nextNumber ?? String(settings.nextNumber)} onChange={(e) => set("nextNumber", e.target.value)} /></Field>
            <Field label="Usual currency" htmlFor="set-currency" optional>
              <Select id="set-currency" className={input16} value={s.defaultCurrency} onChange={(e) => set("defaultCurrency", e.target.value)}>
                <option value="">Use the workspace currency</option>
                {CURRENCY_CODES.map((c: CurrencyCode) => <option key={c} value={c}>{c} · {CURRENCIES[c].name}</option>)}
              </Select>
            </Field>
            <Field label="Payment terms (days)" htmlFor="set-terms" hint="Due this many days after the day an invoice is issued."><Input id="set-terms" inputMode="numeric" className={input16} value={s.paymentTermsDays} onChange={(e) => set("paymentTermsDays", e.target.value)} /></Field>
          </div>
          <Field label="How customers can pay (printed on every invoice)" htmlFor="set-pay" optional hint="Bank details or a wallet number. Never type a card number."><Textarea id="set-pay" rows={3} className={input16} maxLength={1000} value={s.defaultPaymentInstructions} onChange={(e) => set("defaultPaymentInstructions", e.target.value)} /></Field>
          <Field label="Footer note" htmlFor="set-footer" optional><Textarea id="set-footer" rows={2} className={input16} maxLength={600} value={s.footerNote} onChange={(e) => set("footerNote", e.target.value)} /></Field>
          <label className="flex min-h-11 items-start gap-3 text-[13.5px] text-ink-2"><input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={s.approvalRequiredForCreators} onChange={(e) => set("approvalRequiredForCreators", e.target.checked)} /><span>People who write invoices need the owner or a manager to approve them before they are issued. <span className="text-muted">Turn it off only if you trust them to issue their own.</span></span></label>
        </section>

        <section aria-labelledby="set-paid" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <h2 id="set-paid" className="text-[15px] font-semibold text-ink">When an invoice is paid in full</h2>
          <fieldset className="space-y-2">
            <legend className="sr-only">What happens to the linked deal</legend>
            {CLOSE_RULES.map((r) => (
              <label key={r} className="flex min-h-11 items-start gap-3 rounded-xl border border-line px-3 py-2 text-[13.5px] has-[:checked]:border-primary has-[:checked]:bg-primary-soft/40">
                <input type="radio" name="close-rule" className="mt-0.5 size-5 shrink-0" checked={s.closeRule === r} onChange={() => set("closeRule", r)} />
                <span><span className="font-medium text-ink">{CLOSE_RULE_LABELS[r]}</span><span className="block text-[12.5px] text-muted">{CLOSE_RULE_WORDS[r]}</span></span>
              </label>
            ))}
          </fieldset>
          <p className="text-[12.5px] text-muted">A part-payment, a deposit or a refund never changes a deal, and a refund after a deal was marked won only creates a task.</p>
          <label className="flex min-h-11 items-start gap-3 text-[13.5px] text-ink-2"><input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={s.countManualAsVerified} onChange={(e) => set("countManualAsVerified", e.target.checked)} /><span>Count payments I record by hand as verified revenue in the Lead Sources report. <span className="text-muted">Off by default: a payment you record is your word, not the payment provider&apos;s. When off, they are shown on their own line and never added to revenue. Turning it on is your choice and is shown on the report.</span></span></label>
        </section>
      </fieldset>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="brand" loading={busy("save")} disabled={Boolean(problem)}>Save settings</Button>
          {problem && <p role="alert" className="text-[12.5px] text-danger-ink">{problem}</p>}
        </div>
      )}
    </form>
  );
}

const CHANNEL_NOTE: Record<ReminderChannel, string> = {
  email: "Free of service credits.",
  sms: "Each text message uses your prepaid service credits.",
  whatsapp: "Each WhatsApp message uses your prepaid service credits, and can only go to a customer who wrote to you recently.",
};

export function RemindersPanel({ settings, overview, canEdit, canSwitchOff, tz }: { settings: InvoiceSettings; overview: ReminderOverview; canEdit: boolean; canSwitchOff: boolean; tz: string }) {
  const { run, busy } = useCrmAction();
  const [days, setDays] = React.useState(offsetsToText(settings.reminderOffsetsDays));
  const [max, setMax] = React.useState(String(settings.reminderMax));
  const [channels, setChannels] = React.useState<ReminderChannel[]>(settings.reminderChannels);
  const [read, setRead] = React.useState(false);
  const parsed = parseOffsetsText(days);
  const maxN = Number(max);
  const problem = !parsed.ok ? parsed.error : !Number.isInteger(maxN) || maxN < 1 || maxN > 8 ? "The most reminders for one invoice is a number from 1 to 8." : channels.length === 0 ? "Choose at least one channel." : null;
  const changed = parsed.ok && (offsetsToText(parsed.offsets) !== offsetsToText(settings.reminderOffsetsDays) || maxN !== settings.reminderMax || [...channels].sort().join() !== [...settings.reminderChannels].sort().join());
  const toggle = (c: ReminderChannel) => setChannels((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  const saveSetup = () =>
    run("setup", () => saveInvoiceSettingsAction({ reminderOffsetsDays: parsed.ok ? parsed.offsets : [], reminderMax: maxN, reminderChannels: channels }, settings.version), overview.enabled ? "Saved. Reminders are off until you authorize them again." : "Saved.");

  return (
    <section aria-labelledby="rem-title" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="rem-title" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><BellRing className="size-4 text-muted" aria-hidden />Payment reminders</h2>
        <Badge tone={overview.active ? "success" : overview.enabled ? "warning" : "neutral"}>{overview.active ? "On" : overview.enabled ? "On hold" : "Off"}</Badge>
      </div>
      <p className="text-[13.5px] text-ink-2">Reminders ask a customer to pay an invoice that is still owed. They are off until you have read the exact messages below and authorized them. They go only to a customer who has agreed to receive service messages, through the same checks as every other message, and each one is shown on its invoice with what became of it. They stop when the invoice is paid, voided, written off or disputed.</p>
      {overview.active && (
        <p role="status" className="rounded-xl bg-success-soft px-3 py-2 text-[13px] text-success-ink">Authorized by {overview.authorizedByName ?? "the owner"}{overview.authorizedAt ? ` on ${formatInstant(overview.authorizedAt, tz)}` : ""}. The authorization ends{overview.expiresAt ? ` on ${formatInstant(overview.expiresAt, tz)}` : " after 90 days"}, or earlier if the days, channels or wording change.</p>
      )}
      {overview.enabled && !overview.active && overview.problemText && <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{overview.problemText}</p>}
      <p className="text-[12.5px] text-muted">Reminders are planned and sent only while the scheduler runs, so they are checked on a schedule, not live.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Reminder days" htmlFor="rem-days" hint={parsed.ok ? describeOffsets(parsed.offsets) : undefined} error={parsed.ok ? null : parsed.error}>
          <Input id="rem-days" className={input16} value={days} disabled={!canEdit} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <Field label="Most reminders for one invoice" htmlFor="rem-max"><Input id="rem-max" inputMode="numeric" className={input16} value={max} disabled={!canEdit} onChange={(e) => setMax(e.target.value)} /></Field>
      </div>
      <fieldset className="space-y-1" disabled={!canEdit}>
        <legend className="text-[13px] font-medium text-ink-2">Send reminders by</legend>
        {REMINDER_CHANNELS.map((c) => (
          <label key={c} className="flex min-h-11 items-start gap-3 text-[13.5px] text-ink-2"><input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={channels.includes(c)} onChange={() => toggle(c)} /><span><span className="font-medium text-ink">{REMINDER_CHANNEL_LABELS[c]}</span> <span className="text-muted">{CHANNEL_NOTE[c]}</span></span></label>
        ))}
      </fieldset>
      {canEdit && (
        <div className="space-y-2">
          <Button variant="secondary" loading={busy("setup")} disabled={Boolean(problem) || !changed} onClick={saveSetup}>Save reminder days and channels</Button>
          {overview.enabled && changed && !problem && <p className="text-[12.5px] text-warning-ink">Saving different days, a different maximum or different channels switches your authorization off. You will need to authorize again.</p>}
          {problem && <p role="alert" className="text-[12.5px] text-danger-ink">{problem}</p>}
        </div>
      )}

      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="text-[14px] font-semibold text-ink">The messages, as a customer would read them</h3>
        {overview.wordingIsDraft && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink">This wording is proposed. It has not been reviewed by a lawyer or an accountant. It mentions no fees, interest or consequences. Read it as your own, and change nothing here without asking one if you are unsure.</p>}
        <p className="text-[12.5px] text-muted">These are examples on a made-up invoice for {overview.previews.length ? "each reminder day you chose" : "your chosen days"}. The customer&apos;s own link is put where it says so when a message is sent, and is never saved in the message.</p>
        <ul className="space-y-3" aria-label="Reminder messages">
          {overview.previews.map((p) => (
            <li key={p.stepKey} className="rounded-xl border border-line bg-surface-2/50 p-3">
              <p className="text-[12px] font-semibold uppercase tracking-[.08em] text-muted">{p.label}</p>
              <p className="mt-1 text-[12.5px] text-muted">Subject (email): {p.subject}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px] text-ink">{p.body}</p>
            </li>
          ))}
        </ul>
      </div>

      {canEdit && (
        <div className="space-y-3 border-t border-line pt-4">
          <label className="flex min-h-11 items-start gap-3 text-[13.5px] text-ink-2">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={read} onChange={(e) => setRead(e.target.checked)} />
            <span>I have read these messages. I authorize iAcquire to send exactly these reminders, on {parsed.ok ? describeOffsets(parsed.offsets).toLowerCase().replace(/\.$/, "") : "the days above"}, by {channels.map((c) => REMINDER_CHANNEL_LABELS[c].toLowerCase()).join(" and ")}, to customers who have agreed to receive service messages, for up to 90 days. <span className="text-muted">The authorization is recorded with your name and the exact wording.</span></span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="brand" loading={busy("authorize")} disabled={!read || changed || Boolean(problem) || overview.active} onClick={() => run("authorize", () => authorizeRemindersAction({ wordingHash: overview.wordingHash, settingsVersion: settings.version }), "Reminders are on.")}>{overview.enabled && !overview.active ? "Authorize again" : "Authorize reminders"}</Button>
          </div>
          {changed && <p className="text-[12.5px] text-muted">Save your changes to the days or channels first, then authorize what you saved.</p>}
        </div>
      )}
      {canSwitchOff && overview.enabled && <Button variant="outline" loading={busy("off")} onClick={() => run("off", () => switchOffRemindersAction(), "Reminders are off. Scheduled ones were withdrawn.")}>Switch reminders off</Button>}
    </section>
  );
}
