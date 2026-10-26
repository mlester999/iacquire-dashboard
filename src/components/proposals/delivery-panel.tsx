"use client";

import * as React from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { getShareUrlAction, renewShareLinkAction } from "@/app/actions/proposals";
import { DECISION_METHOD_LABELS } from "@/lib/proposals/ack";
import { whenIn } from "@/lib/proposals/format";
import { SEEN_LABELS } from "@/lib/proposals/share";
import type { ProposalDetail } from "@/server/proposals/view";
import { SeenBadge } from "@/components/proposals/status";
import { DeliveryList, SendToCustomer } from "@/components/proposals/delivery-send";

// How a sent proposal reaches the customer, what is known about it, and what the customer answered. The team either sends the customer their link through the consent-gated
// send chain (delivery-send.tsx: a confirmed step, with the exact message shown first) or copies it and gives it over themselves. The three levels of "seen" are shown in their own
// words, because a page request alone can be an email scanner.

/** What stands in the way of, or follows from, a proposal that asks for a signature. The signing itself is on the Signature tab. */
function SigningNote({ detail, onOpenTab }: { detail: ProposalDetail; onOpenTab?: (tab: string) => void }) {
  const sig = detail.signature;
  const tab = onOpenTab ? <button type="button" className="font-medium text-primary-ink underline" onClick={() => onOpenTab("signature")}>Signature tab</button> : <>Signature tab</>;
  let text: React.ReactNode;
  if (detail.signatureState === "recorded_offline") text = "The signing was recorded as done offline by a person. It was not verified by a signing service.";
  else if (detail.signatureState === "completed") text = <>A signing service reported that the customer signed. See the {tab}.</>;
  else if (detail.signatureState === "requested") text = <>A signing request is out. The customer signs at the signing service, not on their proposal page. Follow it on the {tab}.</>;
  else if (detail.signatureState === "failed") text = <>The last signing request ended without a signature. See the {tab}; you can ask again.</>;
  else if (!sig.enabled || !sig.connection) text = "This proposal needs a signature. No signing service is connected, so the customer cannot sign online. Record the signing as done offline when it happens, or turn the requirement off and send a new version.";
  else text = <>This proposal needs a signature. The customer signs at your signing service, not on the proposal page: ask for it on the {tab}.</>;
  return <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[14px] text-ink-2">{text}</p>;
}

export function DeliveryPanel({ detail, canSend, tz, onOpenTab, active = true }: { detail: ProposalDetail; canSend: boolean; tz: string; onOpenTab?: (tab: string) => void; active?: boolean }) {
  const { run, busy } = useCrmAction();
  const [shown, setShown] = React.useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [renew, setRenew] = React.useState(false);
  const share = detail.share;
  const live = detail.status === "sent" && share?.active === true;

  async function reveal() {
    const r = await run("link", () => getShareUrlAction(detail.id));
    if (r && typeof r === "object" && "url" in r) setShown(r as { url: string; expiresAt: string });
  }
  async function copy() {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-6">
      {canSend && live && <SendToCustomer detail={detail} tz={tz} active={active} />}
      {(detail.deliveries.length > 0 || (canSend && live)) && <DeliveryList deliveries={detail.deliveries} tz={tz} />}

      <section aria-label="The customer's link" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">The customer&apos;s link</h2>
        {!share ? (
          <p className="text-[14px] text-ink-2">{detail.status === "approved" ? "The link is made when you send the proposal." : "The customer's link is made when the proposal is sent. Until then nobody outside your team can open it."}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SeenBadge level={share.seen} />
              <span className="text-[14px] text-ink-2">{share.active ? `Works until ${whenIn(share.expiresAt, tz)}` : share.revokedAt ? "This link was closed" : "This link has expired"}</span>
            </div>
            <p className="text-[14px] text-muted">{SEEN_LABELS[share.seen].explain}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[14px]">
              <dt className="text-muted">Version</dt><dd className="text-ink-2">{share.version}</dd>
              <dt className="text-muted">For</dt><dd className="min-w-0 break-words text-ink-2">{share.recipientEmail ?? "No email address on file"}</dd>
              <dt className="text-muted">Link requests</dt><dd className="text-ink-2">{share.openCount}{share.firstOpenedAt ? `, first ${whenIn(share.firstOpenedAt, tz)}` : ""}{share.lastOpenedAt && share.openCount > 1 ? `, latest ${whenIn(share.lastOpenedAt, tz)}` : ""}</dd>
              <dt className="text-muted">Used in a browser</dt><dd className="text-ink-2">{share.viewedCount ? `${share.viewedCount} ${share.viewedCount === 1 ? "time" : "times"}, first ${whenIn(share.firstViewedAt, tz)}` : "Not yet"}</dd>
              <dt className="text-muted">Code entered</dt><dd className="text-ink-2">{share.verifiedAt ? whenIn(share.verifiedAt, tz) : "Not yet"}</dd>
              <dt className="text-muted">PDF downloaded</dt><dd className="text-ink-2">{share.downloadedAt ? whenIn(share.downloadedAt, tz) : "Not yet"}</dd>
            </dl>
            {!share.recipientEmail && live && <p role="status" className="rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink">There is no email address for the customer, so they can open the proposal but cannot accept it online. Record their answer yourself when they give it.</p>}
            {canSend && live && (
              <div className="space-y-3 border-t border-line pt-4">
                {shown ? (
                  <div className="space-y-2">
                    <label htmlFor="dp-link" className="text-[14px] font-medium text-ink-2">Link for the customer</label>
                    <div className="flex flex-wrap gap-2">
                      <Input id="dp-link" readOnly value={shown.url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 text-[16px] sm:text-[14px]" />
                      <Button type="button" variant="secondary" onClick={copy}><Copy className="size-4" aria-hidden />Copy</Button>
                    </div>
                    <p role="status" className="text-[13px] text-muted">{copied ? "Copied." : "Anyone with this link can open the proposal, but only someone who receives the code at the customer's address can answer it. Copying it sends nothing."}</p>
                  </div>
                ) : (
                  <Button type="button" variant="secondary" loading={busy("link")} onClick={reveal}>Show the customer&apos;s link</Button>
                )}
                <div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRenew(true)}>Make a new link</Button>
                  <p className="mt-1 text-[13px] text-muted">For a link sent to the wrong place. The old one stops working at once.</p>
                </div>
              </div>
            )}
            {!canSend && live && <p className="text-[13px] text-muted">Only someone who can send proposals can see the link.</p>}
          </>
        )}
      </section>

      <section aria-label="Answers" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">What the customer answered</h2>
        {detail.decisions.length === 0 ? <p className="text-[14px] text-ink-2">No answer has been recorded.</p> : (
          <ul className="space-y-3">
            {detail.decisions.map((d) => (
              <li key={d.id} className="rounded-xl border border-line px-3 py-2.5 text-[14px]">
                <p className="font-medium text-ink">{d.decision === "accepted" ? "Accepted" : d.decision === "declined" ? "Declined" : "Asked for changes"} <span className="font-normal text-muted">· version {d.version} · {whenIn(d.decidedAt, tz)}</span></p>
                <p className="mt-0.5 text-ink-2">{d.method === "recorded_by_staff" && d.recordedByName ? `Recorded by ${d.recordedByName}; not verified by the client.` : `${DECISION_METHOD_LABELS[d.method]}.`}</p>
                {(d.decidedName || d.decidedEmail) && <p className="mt-0.5 break-words text-muted">{[d.decidedName, d.decidedEmail].filter(Boolean).join(", ")}</p>}
                {d.note && <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{d.note}</p>}
              </li>
            ))}
          </ul>
        )}
        {detail.requiresSignature && <SigningNote detail={detail} onOpenTab={onOpenTab} />}
      </section>

      <ConfirmDialog
        open={renew} onOpenChange={setRenew} title="Make a new link?" confirmLabel="Make a new link" loading={busy("renew")}
        description="The old link stops working at once. The customer needs the new one."
        onConfirm={async () => { const r = await run("renew", () => renewShareLinkAction(detail.id), "A new link was made."); setRenew(false); if (r && typeof r === "object" && "url" in r) setShown(r as { url: string; expiresAt: string }); }}
      />
    </div>
  );
}
