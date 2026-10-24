"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/ui";
import { previewInvoiceDeliveryAction, sendInvoiceDeliveryAction } from "@/app/actions/invoices";
import { DELIVERY_CHANNELS, DELIVERY_CHANNEL_LABELS, type DeliveryChannel } from "@/lib/invoices/delivery-text";
import type { InvoiceDeliveryView } from "@/lib/invoices/delivery-state";
import { confirmLabelFor, DELIVERY_BADGE_TONE, invoiceOfferFor, outcomeText, type SendOutcome } from "@/lib/invoices/delivery-ui";
import { whenIn } from "@/lib/proposals/format";
import type { InvoiceDeliveryPreview, InvoiceDeliveryUnavailable } from "@/server/invoices/delivery";

// Sending the customer their invoice link, and what became of each message. A person opens the section, picks a channel, reads the exact message and what the send chain says about
// it, and confirms; nothing goes out before that. The words here never go past what the database holds: "queued" is not sent, "sent" means the provider accepted it, and nothing
// says a message was delivered, received or read, because iAcquire cannot know that.

type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "ready"; data: InvoiceDeliveryPreview | InvoiceDeliveryUnavailable };

/** The message is read (and checked against the sending rules) only while the section is open: an invoice page that nobody sends from asks for nothing. */
export function SendInvoiceToCustomer({ invoiceId, deliveries, tz }: { invoiceId: string; deliveries: InvoiceDeliveryView[]; tz: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [channel, setChannel] = React.useState<DeliveryChannel>("email");
  const [confirm, setConfirm] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [rereads, setRereads] = React.useState(0);
  const [outcome, setOutcome] = React.useState<SendOutcome | null>(null);
  const statusRef = React.useRef<HTMLDivElement>(null);
  // The list changes when a message is queued, stopped or sent: the offer is read again, so it never shows a button for a message that is already on its way.
  const listKey = deliveries.map((d) => `${d.id}:${d.state}`).join(",");
  // What was read is kept with the question it answered. An answer to an earlier question (another channel, an older list, before the last attempt to send) is not the answer to
  // this one, so the screen says "reading" until the right one arrives; nothing is set synchronously in the effect.
  const question = `${invoiceId}:${channel}:${listKey}:${rereads}`;
  const [answer, setAnswer] = React.useState<{ question: string; state: PreviewState } | null>(null);
  const preview: PreviewState = answer && answer.question === question ? answer.state : { kind: "loading" };

  React.useEffect(() => {
    if (!open) return;
    let stale = false;
    void (async () => {
      let state: PreviewState;
      try {
        const res = await previewInvoiceDeliveryAction(invoiceId, channel);
        state = res.ok ? { kind: "ready", data: res.data } : { kind: "error", text: res.error };
      } catch {
        state = { kind: "error", text: "That didn't load. Check your connection and try again." };
      }
      // A slower answer for a channel the person has since left is dropped.
      if (!stale) setAnswer({ question, state });
    })();
    return () => {
      stale = true;
    };
  }, [open, invoiceId, channel, question]);

  React.useEffect(() => {
    if (outcome) statusRef.current?.focus();
  }, [outcome]);

  const ready = preview.kind === "ready" && preview.data.available ? preview.data : null;
  const offer = ready ? invoiceOfferFor(ready) : null;

  async function send() {
    if (!ready) return;
    setSending(true);
    let next: SendOutcome;
    try {
      const res = await sendInvoiceDeliveryAction(invoiceId, { channel, linkVersion: ready.linkVersion, wordingHash: ready.wordingHash });
      // A refusal, a message that changed since it was read and a failure are all said here, in the page, where the person is looking and can act on them.
      next = res.ok ? (res.data as SendOutcome) : { status: "refused", text: res.error };
    } catch {
      next = { status: "refused", text: "That didn't go through. Check your connection and try again." };
    }
    setSending(false);
    setConfirm(false);
    setOutcome(next);
    // What the offer said may no longer be true (a refusal, a changed message, a message now on its way): it is read again, and the list is refreshed.
    setRereads((n) => n + 1);
    router.refresh();
  }

  const said = outcome ? outcomeText(outcome, (iso) => whenIn(iso, tz)) : null;

  return (
    <section aria-label="Send it to the customer" className="space-y-4 rounded-2xl border border-line bg-surface p-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">Send it to the customer</h2>
        <p className="mt-1 text-[13px] text-muted">
          iAcquire can send the customer the link to this invoice. It goes through the same checks as every other message to a customer: their consent on that channel, opt-outs, quiet hours and any hold your team put on them. You read the exact message first, and nothing is sent until you confirm.
        </p>
      </div>
      <Button type="button" variant="secondary" aria-expanded={open} aria-controls={`inv-send-${invoiceId}`} onClick={() => setOpen((o) => !o)}>
        <Send className="size-4" aria-hidden />{open ? "Hide the message" : "Write the message"}
      </Button>

      <div id={`inv-send-${invoiceId}`} hidden={!open} className="space-y-4">
        <fieldset className="space-y-1">
          <legend className="text-[13px] font-medium text-ink-2">Send by</legend>
          <div className="flex flex-wrap gap-2">
            {DELIVERY_CHANNELS.map((c) => (
              <label key={c} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3.5 text-[13.5px] sm:min-h-9 ${channel === c ? "border-primary bg-primary-soft text-primary-ink" : "border-line text-ink-2"}`}>
                <input type="radio" name={`invoice-delivery-channel-${invoiceId}`} value={c} checked={channel === c} onChange={() => { setChannel(c); setOutcome(null); }} className="size-5 shrink-0" />
                {DELIVERY_CHANNEL_LABELS[c]}
              </label>
            ))}
          </div>
        </fieldset>

        <div aria-live="polite" aria-busy={open && preview.kind === "loading"} className="space-y-3">
          {open && preview.kind === "loading" && <p className="text-[13px] text-muted">Reading the message and checking it against your sending rules...</p>}
          {preview.kind === "error" && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{preview.text}</p>}
          {preview.kind === "ready" && !preview.data.available && <p role="status" className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">{preview.data.text}</p>}
          {ready && (
            <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
                <dt className="text-muted">Goes to</dt>
                <dd className="min-w-0 break-words text-ink-2">{ready.addressMask ?? `No ${channel === "email" ? "email address" : "phone number"} on the customer's record`}</dd>
                {ready.subject && (<><dt className="text-muted">Subject</dt><dd className="min-w-0 break-words text-ink-2">{ready.subject}</dd></>)}
              </dl>
              <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
                <p className="mb-1 text-[12px] font-medium text-muted">The message the customer will read</p>
                <p className="whitespace-pre-wrap break-words text-[13.5px] text-ink">{ready.body}</p>
              </div>
              <p className="text-[12.5px] text-muted">
                The customer&apos;s own link goes where the words in brackets are. It is added when the message is sent and is not kept in the message, the history or any export.
                {ready.wordingIsDraft ? " This wording is a draft that nobody has approved yet." : ""}
                {ready.usesCredits ? " A text or WhatsApp message uses your prepaid service credits." : ""}
              </p>
              <p role="status" className={`rounded-xl px-3 py-2 text-[13px] ${ready.verdict.kind === "refused" ? "bg-warning-soft text-warning-ink" : "bg-surface-2 text-ink-2"}`}>
                {ready.verdict.text}
                {ready.verdict.waitingUntil ? ` Next window: ${whenIn(ready.verdict.waitingUntil, tz)}.` : ""}
              </p>
              {offer && !offer.canSend && offer.why && ready.verdict.kind !== "refused" && <p role="status" className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">{offer.why}</p>}
              <Button type="button" disabled={!offer?.canSend} onClick={() => setConfirm(true)}><Send className="size-4" aria-hidden />{confirmLabelFor(ready.verdict.kind)}</Button>
            </>
          )}
        </div>
      </div>

      <div ref={statusRef} tabIndex={-1} role={said?.tone === "error" ? "alert" : "status"} className="outline-none">
        {said && <p className={`rounded-xl px-3 py-2 text-[13px] ${said.tone === "error" ? "bg-danger-soft text-danger-ink" : said.tone === "info" ? "bg-surface-2 text-ink-2" : "bg-success-soft text-success-ink"}`}>{said.text}</p>}
      </div>

      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} title={ready ? `${confirmLabelFor(ready.verdict.kind)}?` : "Send this message?"} confirmLabel={ready ? confirmLabelFor(ready.verdict.kind) : "Send"} loading={sending}
        description={ready ? `This hands the message you read to the ${DELIVERY_CHANNEL_LABELS[channel].toLowerCase()} channel${ready.addressMask ? ` for ${ready.addressMask}` : ""}. It is checked again just before it leaves, and it is stopped if the invoice is voided, paid, disputed or written off, or its link is replaced, first.` : undefined}
        onConfirm={send}
      />
    </section>
  );
}

/** The messages that were sent about this invoice, newest first, each in the words the record supports. */
export function InvoiceDeliveryList({ deliveries, tz }: { deliveries: InvoiceDeliveryView[]; tz: string }) {
  return (
    <section aria-label="Messages to the customer" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[15px] font-semibold text-ink">Messages sent from here</h2>
      {deliveries.length === 0 ? (
        <p className="text-[13.5px] text-ink-2">No message has been sent from here. If you gave the customer the link yourself, iAcquire has no record of that.</p>
      ) : (
        <ul className="space-y-3">
          {deliveries.map((d) => (
            <li key={d.id} className="rounded-xl border border-line px-3 py-2.5 text-[13.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={DELIVERY_BADGE_TONE[d.tone]}>{d.label}</Badge>
                <span className="font-medium text-ink">{d.channelLabel}</span>
                <span className="text-[12.5px] text-muted">{whenIn(d.requestedAt, tz)}{d.requestedByName ? ` · ${d.requestedByName}` : ""}{d.linkVersion > 1 ? ` · link ${d.linkVersion}` : ""}</span>
              </div>
              <p className="mt-1 break-words text-ink-2">{d.explain}</p>
              {d.sendAfter && <p className="mt-0.5 text-[12.5px] text-muted">Due {whenIn(d.sendAfter, tz)}.</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
