"use client";

import * as React from "react";
import Link from "next/link";
import { FileSignature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { actAsSimulatedSignerAction, requestSignatureAction, voidSignatureRequestAction } from "@/app/actions/proposals";
import { CONNECTION_STATUS_LABELS, eventSentence, SOURCE_LABELS, type EventSourceName } from "@/lib/esign/activity";
import { isLive, type RequestStatus } from "@/lib/esign/state";
import { whenIn } from "@/lib/proposals/format";
import type { ProposalDetail } from "@/server/proposals/view";
import type { RequestView } from "@/server/esign/requests";

// Asking the customer to sign, and following what the signing service says. The signing happens at the business's own signing service (PandaDoc), which emails the signer; this
// page only asks it to, and shows what it reports back. "Signed" here is always the signing service's word, said as such, and a simulated service is labelled everywhere.

type Tone = NonNullable<React.ComponentProps<typeof Badge>["tone"]>;

const STATUS_TONE: Record<RequestStatus, Tone> = {
  queued: "neutral", sending: "neutral", sent: "primary", viewed: "primary", completed: "success", declined: "danger", expired: "warning", voided: "outline", failed: "danger", unknown: "warning", superseded: "outline",
};

function ConnectionLine({ detail }: { detail: ProposalDetail }) {
  const c = detail.signature.connection;
  if (!c) {
    return (
      <p className="text-[14px] text-ink-2">
        No signing service is connected.{" "}
        {detail.signature.canConnect
          ? <>Connect one in the <Link href="/proposals/settings" className="font-medium text-primary-ink underline">proposal settings</Link>.</>
          : "The business owner or a manager can connect one in the proposal settings."}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium text-ink">{c.providerLabel}{c.label ? `, ${c.label}` : ""}</span>
        <Badge tone={c.status === "connected" ? "success" : c.status === "error" || c.status === "needs_attention" ? "warning" : "outline"}>{CONNECTION_STATUS_LABELS[c.status] ?? c.status}</Badge>
        {c.mode === "sandbox" && <Badge tone="outline">Sandbox</Badge>}
        {c.mode === "simulated" && <Badge tone="violet">Simulated</Badge>}
      </div>
      {c.statusDetail && c.status !== "connected" && <p className="text-[14px] text-warning-ink">{c.statusDetail}</p>}
      {c.notice && <p role="status" className="rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink-2">{c.notice}</p>}
    </div>
  );
}

function AskForm({ detail }: { detail: ProposalDetail }) {
  const { run, busy } = useCrmAction();
  const sig = detail.signature;
  const [name, setName] = React.useState(sig.defaultSigner.name);
  const [email, setEmail] = React.useState(sig.defaultSigner.email);
  const label = sig.connection?.providerLabel ?? "the signing service";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await run("ask", () => requestSignatureAction(detail.id, { signerName: name, signerEmail: email }), (r) => (r.created ? "Asked. It is sent to the signing service shortly." : "A signing request is already out for this version."));
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Ask the customer to sign">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Who should sign" htmlFor="sg-name">
          <Input id="sg-name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>
        <Field label="Their email address" htmlFor="sg-email" hint={`${label} sends the document here.`}>
          <Input id="sg-email" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>
      </div>
      <Button type="submit" variant="brand" loading={busy("ask")} disabled={!name.trim() || !email.trim()}>
        <FileSignature className="size-4" aria-hidden />Ask for a signature
      </Button>
      <p className="text-[13px] leading-relaxed text-muted">
        {label} emails the signer a link to sign version {detail.version} of the proposal. iAcquire does not send that email. Signing there is how the proposal is accepted: it is marked accepted only when {label} reports the signature.
      </p>
    </form>
  );
}

function RequestItem({ r, tz, simulated }: { r: RequestView; tz: string; simulated: boolean }) {
  const { run, busy } = useCrmAction();
  const [confirm, setConfirm] = React.useState(false);
  const live = isLive(r.status);
  const sim = async (action: string, ok: string) => { await run(`sim-${action}`, () => actAsSimulatedSignerAction(r.id, action), ok); };
  return (
    <li className="space-y-2 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[r.status]}>{r.statusLabel}</Badge>
        <span className="text-[14px] text-muted">Version {r.proposalVersion}{r.current ? "" : " (an older version)"}</span>
        {r.mode === "simulated" && <Badge tone="violet">Simulated</Badge>}
      </div>
      <p className="text-[14px] text-ink-2">{r.explain}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[14px]">
        <dt className="text-muted">Asked to sign</dt><dd className="min-w-0 break-words text-ink-2">{r.signerName}, {r.signerEmail}</dd>
        <dt className="text-muted">Asked</dt><dd className="text-ink-2">{whenIn(r.createdAt, tz)}</dd>
        {r.sentAt && <><dt className="text-muted">Sent by {r.providerLabel}</dt><dd className="text-ink-2">{whenIn(r.sentAt, tz)}</dd></>}
        {r.completedAt && <><dt className="text-muted">{r.providerLabel} reports signed</dt><dd className="text-ink-2">{whenIn(r.completedAt, tz)}</dd></>}
      </dl>
      {r.status === "completed" && (
        r.applied
          ? <p role="status" className="rounded-xl bg-success-soft px-3 py-2 text-[14px] text-success-ink">The signature was applied: the proposal is accepted.</p>
          : r.notAppliedText && <p role="status" className="rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink">{r.notAppliedText}</p>
      )}
      {r.status === "completed" && (
        <p className="text-[14px] text-ink-2">
          {r.signedFileId
            ? <>Signed copy stored. <a href={`/api/files/${r.signedFileId}`} download className="font-medium text-primary-ink underline">Download{" "}<span className="sr-only">the signed copy</span></a>
                {r.certificateFileId && <> · <a href={`/api/files/${r.certificateFileId}`} download className="font-medium text-primary-ink underline">Download{" "}<span className="sr-only">the completion certificate</span></a></>}</>
            : r.copyGaveUp ? `The signature is recorded, but iAcquire could not fetch the signed copy. Download it from ${r.providerLabel}.`
              : `The signature is recorded. The signed copy has not been fetched from ${r.providerLabel} yet; this is tried again automatically.`}
        </p>
      )}
      {r.status === "failed" && r.lastError && <p className="text-[14px] text-danger-ink">{r.lastError}</p>}
      {r.status === "voided" || r.status === "superseded" ? (r.voidReason && <p className="text-[14px] text-muted">{r.voidReason}</p>) : null}
      {r.cancelNote && <p className="text-[14px] text-muted">{r.cancelNote}</p>}
      {r.canVoid && live && <div><Button variant="outline" size="sm" onClick={() => setConfirm(true)}>Withdraw this request</Button></div>}
      {simulated && r.mode === "simulated" && live && (
        <div className="space-y-2 rounded-xl border border-dashed border-line px-3 py-2.5">
          <p className="text-[13px] font-medium text-ink-2">Simulated signing service (testing only)</p>
          <p className="text-[13px] text-muted">Nothing real is sent. These play the signer at the stand-in service; what comes back goes through the same signed notice a real service uses.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={busy("sim-send_now")} onClick={() => sim("send_now", "Handed over.")}>Hand it over now</Button>
            <Button variant="secondary" size="sm" loading={busy("sim-view")} onClick={() => sim("view", "The signer opened it.")}>Signer opens it</Button>
            <Button variant="secondary" size="sm" loading={busy("sim-sign")} onClick={() => sim("sign", "The signer signed (simulated).")}>Signer signs</Button>
            <Button variant="secondary" size="sm" loading={busy("sim-decline")} onClick={() => sim("decline", "The signer declined.")}>Signer declines</Button>
            <Button variant="secondary" size="sm" loading={busy("sim-expire")} onClick={() => sim("expire", "The request ran out.")}>Request runs out</Button>
          </div>
        </div>
      )}
      {r.events.length > 0 && (
        <details className="rounded-xl bg-surface-2 px-3 py-2 text-[14px]">
          <summary className="min-h-11 cursor-pointer font-medium text-ink sm:min-h-8">History ({r.events.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {r.events.map((e) => (
              <li key={e.id} className="text-ink-2">
                <span className="text-muted">{whenIn(e.at, tz)} · {SOURCE_LABELS[e.source as EventSourceName] ?? e.source}: </span>{eventSentence(e.kind, e.detail)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} title="Withdraw this signing request?" confirmLabel="Withdraw" danger loading={busy("void")}
        description={<>The signer is no longer asked, and a signature that still arrives for it is <strong>not</strong> applied to the proposal. The proposal stays sent, and you can ask again. {r.provider === "pandadoc" ? `iAcquire cannot withdraw the document at ${r.providerLabel}: withdraw it there too.` : ""}</>}
        onConfirm={async () => { await run("void", () => voidSignatureRequestAction(r.id), "Withdrawn."); setConfirm(false); }}
      />
    </li>
  );
}

export function SignaturePanel({ detail, tz }: { detail: ProposalDetail; tz: string }) {
  const sig = detail.signature;
  const asks = detail.requiresSignature;
  return (
    <div className="space-y-6">
      <section aria-label="Signing service" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">Signing service</h2>
        {sig.enabled ? <ConnectionLine detail={detail} /> : <p className="text-[14px] text-ink-2">{sig.blocked}</p>}
      </section>

      {/* Until signing is switched on there is nothing to ask for, and the section above has already said so. */}
      {sig.enabled && (
        <section aria-label="Ask the customer to sign" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-semibold text-ink">Ask the customer to sign</h2>
          {!asks ? (
            <p className="text-[14px] text-ink-2">This proposal doesn&apos;t ask for a signature. To ask for one, turn it on in the editor and send a new version.</p>
          ) : sig.canRequest ? (
            <AskForm detail={detail} />
          ) : (
            <p role="status" className="text-[14px] text-ink-2">{sig.blocked ?? "Only someone who can send proposals can ask for a signature."}</p>
          )}
          {asks && !sig.canRequest && sig.blocked && detail.status === "sent" && (
            <p className="text-[13px] text-muted">If the customer signs on paper or in person, the owner or a manager can record it as their own word under &ldquo;Record the customer&apos;s answer&rdquo; above. That is not verified by anyone.</p>
          )}
        </section>
      )}

      <section aria-label="Signing requests" className="space-y-3">
        <h2 className="text-[15px] font-semibold text-ink">Requests</h2>
        {sig.requests.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-muted">No signing request has been made for this proposal.</p>
        ) : (
          <ul className="space-y-3">{sig.requests.map((r) => <RequestItem key={r.id} r={r} tz={tz} simulated={sig.simulated} />)}</ul>
        )}
      </section>
    </div>
  );
}
