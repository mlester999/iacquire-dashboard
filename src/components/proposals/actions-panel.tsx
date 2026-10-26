"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import {
  decideProposalAction, duplicateProposalAction, recordOfflineDecisionAction, reviseProposalAction, sendProposalAction, submitForApprovalAction, withdrawProposalAction,
} from "@/app/actions/proposals";
import { isLive } from "@/lib/esign/state";
import { whenIn } from "@/lib/proposals/format";
import { blockingFor } from "@/lib/proposals/problems";
import { APPROVAL_REASON_TEXT, approveBlockedReason, isRevisable, STATUS_EXPLAIN } from "@/lib/proposals/state";
import { formatDay } from "@/lib/proposals/validity";
import type { ProposalDetail } from "@/server/proposals/view";
import { AiBadge, StatusBadge } from "@/components/proposals/status";

// What a person can do with a proposal right now. The server decides every one of these again; this only offers what the status and the person's role allow, and says why
// when something is not offered. Nothing here contacts the customer: marking a version as sent freezes it and makes the customer's link. Carrying the link to the customer is a
// separate, confirmed step on the Delivery tab (src/components/proposals/delivery-send.tsx).

export interface ProposalActionsProps {
  detail: ProposalDetail;
  can: { create: boolean; approve: boolean; send: boolean; record: boolean };
  /** The workspace asks for a second person to approve each proposal. */
  twoPerson: boolean;
  /** There are unsaved edits in the editor. */
  dirty: boolean;
  tz: string;
  /** Moves to a tab ("edit", "delivery") for the problems list or the customer's link. */
  onOpenTab: (tab: string) => void;
}

export function ProposalActions({ detail, can, twoPerson, dirty, tz, onOpenTab }: ProposalActionsProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [note, setNote] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | "send" | "withdraw" | "reject" | "revise">(null);
  const [recording, setRecording] = React.useState(false);
  const s = detail.status;
  const blockSubmit = blockingFor(detail.problems, "submit");
  const blockSend = blockingFor(detail.problems, "send");
  const approveBlock = approveBlockedReason({ canApprove: can.approve, isAuthor: detail.viewer.isAuthor, twoPerson });
  const mine = detail.viewer.canEdit;
  const needsApproval = detail.approval.required;
  const draftLike = s === "draft" || s === "changes_requested";

  const duplicate = async () => {
    const r = await run("duplicate", () => duplicateProposalAction(detail.id), "A copy was saved as a draft.");
    if (r) router.push(`/proposals/${(r as { id: string }).id}`);
  };

  const fixFirst = (list: typeof blockSubmit) => list.length > 0 && (
    <p className="text-[13px] text-danger-ink">
      {list[0].message} <button type="button" className="font-medium underline" onClick={() => onOpenTab("edit")}>Open the editor</button>
    </p>
  );
  const saveFirst = dirty && <p className="text-[13px] text-warning-ink">You have unsaved changes. Save them first, so what is approved or sent is what you see.</p>;

  return (
    <section aria-label="Status and actions" className="space-y-4 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s} />
        {detail.origin === "ai" && <AiBadge />}
        <span className="text-[13px] text-muted">Version {detail.version}</span>
      </div>
      <p className="text-[14px] text-ink-2">{STATUS_EXPLAIN[s]}</p>
      {detail.approvedByName && detail.approvedVersion === detail.version && ["approved", "sent", "accepted", "declined", "expired"].includes(s) && (
        <p className="text-[13px] text-muted">Approved by {detail.approvedByName}{detail.approvedAt ? `, ${whenIn(detail.approvedAt, tz)}` : ""}.</p>
      )}
      {detail.decisionNote && (s === "changes_requested" || s === "rejected") && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink"><span className="font-semibold">Reviewer&apos;s note: </span>{detail.decisionNote}</p>}
      {detail.validUntil && ["sent", "approved", "draft", "pending_approval", "changes_requested"].includes(s) && <p className="text-[13px] text-muted">Valid until {formatDay(detail.validUntil)}.</p>}

      {draftLike && !mine && <p className="border-t border-line pt-4 text-[14px] text-muted">Only the person who wrote this proposal, or a manager, can send it on.</p>}
      {draftLike && mine && (
        <div className="space-y-3 border-t border-line pt-4">
          {needsApproval ? (
            <>
              <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-[14px] text-ink-2">
                <p className="font-medium text-ink">A second look is needed before this goes out:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">{detail.approval.reasons.map((r) => <li key={r}>{APPROVAL_REASON_TEXT[r]}</li>)}</ul>
              </div>
              <Button variant="brand" loading={busy("submit")} disabled={dirty || blockSubmit.length > 0 || !can.create} onClick={() => run("submit", () => submitForApprovalAction(detail.id), "Sent for approval.")}>Send for approval</Button>
              {fixFirst(blockSubmit)}
            </>
          ) : can.send ? (
            <>
              <p className="text-[13px] text-muted">Nothing here needs a second look, so you can mark it as sent yourself. It is recorded as approved by you.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="brand" disabled={dirty || blockSend.length > 0} onClick={() => setConfirm("send")}>Mark as sent</Button>
                <Button variant="secondary" loading={busy("submit")} disabled={dirty || blockSubmit.length > 0 || !can.create} onClick={() => run("submit", () => submitForApprovalAction(detail.id), "Sent for approval.")}>Ask for approval first</Button>
              </div>
              {fixFirst(blockSend)}
            </>
          ) : (
            <>
              <Button variant="brand" loading={busy("submit")} disabled={dirty || blockSubmit.length > 0 || !can.create} onClick={() => run("submit", () => submitForApprovalAction(detail.id), "Sent for approval.")}>Send for approval</Button>
              <p className="text-[13px] text-muted">You can write proposals but not send them, so someone who can has to approve this one.</p>
              {fixFirst(blockSubmit)}
            </>
          )}
          {saveFirst}
        </div>
      )}

      {s === "pending_approval" && (
        <div className="space-y-3 border-t border-line pt-4">
          {can.approve ? (
            <>
              <Field label="Note to the writer" htmlFor="pa-note" optional hint="Required when you ask for changes.">
                <Textarea id="pa-note" rows={2} value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} className="text-[16px] sm:text-[14px]" />
              </Field>
              <div className="flex flex-wrap gap-2">
                {!approveBlock && <Button variant="brand" loading={busy("approve")} disabled={blockSubmit.length > 0} onClick={() => run("approve", () => decideProposalAction(detail.id, { decision: "approve", version: detail.version, note: note || null }), "Approved.")}>Approve this version</Button>}
                <Button variant="secondary" loading={busy("changes")} disabled={!note.trim()} onClick={() => run("changes", () => decideProposalAction(detail.id, { decision: "request_changes", version: detail.version, note }), "Changes requested.")}>Request changes</Button>
                <Button variant="outline" onClick={() => setConfirm("reject")}>Reject</Button>
              </div>
              {approveBlock && <p className="text-[13px] text-muted">{approveBlock}</p>}
              {!approveBlock && fixFirst(blockSubmit)}
              <p className="text-[13px] text-muted">Your approval is of version {detail.version} exactly as it is in the Preview tab. If the text changes afterwards, it has to be approved again.</p>
            </>
          ) : <p className="text-[14px] text-muted">{approveBlock ?? "Only the business owner or a manager can approve it."}</p>}
        </div>
      )}

      {s === "approved" && (
        <div className="space-y-3 border-t border-line pt-4">
          {can.send && (mine || can.approve) ? (
            <>
              <Button variant="brand" disabled={dirty || blockSend.length > 0 || detail.approvedVersion !== detail.version} onClick={() => setConfirm("send")}>Mark as sent</Button>
              {fixFirst(blockSend)}
              {saveFirst}
            </>
          ) : <p className="text-[14px] text-muted">Approved. Someone who can send proposals needs to send it.</p>}
        </div>
      )}

      {s === "sent" && (
        <div className="space-y-3 border-t border-line pt-4">
          <p className="text-[14px] text-ink-2">
            The customer&apos;s link, and any message sent with it, are on the <button type="button" className="font-medium text-primary-ink underline" onClick={() => onOpenTab("delivery")}>Delivery tab</button>. Marking a proposal as sent contacts no one: send the link from there, or copy it and give it to the customer yourself.
          </p>
          {detail.requiresSignature && (
            <p className="text-[14px] text-ink-2">
              This proposal needs a signature, which the customer gives at your signing service, not on their proposal page. Ask for it on the <button type="button" className="font-medium text-primary-ink underline" onClick={() => onOpenTab("signature")}>Signature tab</button>. It is accepted only when the signing service reports the signature.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {can.record && <Button variant="secondary" onClick={() => setRecording(true)}>Record the customer&apos;s answer</Button>}
          </div>
          {!can.record && <p className="text-[13px] text-muted">If the customer answers by phone or on paper, the owner or a manager can record it.</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {can.create && (mine || can.send) && isRevisable(s) && s !== "accepted" && <Button variant="outline" size="sm" onClick={() => setConfirm("revise")}>Revise</Button>}
        {can.create && <Button variant="outline" size="sm" loading={busy("duplicate")} onClick={duplicate}>Duplicate</Button>}
        {(mine || can.send) && ["draft", "pending_approval", "changes_requested", "approved", "sent"].includes(s) && <Button variant="ghost" size="sm" onClick={() => setConfirm("withdraw")}>{s === "sent" ? "Withdraw" : "Withdraw this proposal"}</Button>}
      </div>
      {s === "accepted" && <p className="text-[13px] text-muted">An accepted proposal is final. To change what was agreed, duplicate it and start a new proposal.</p>}

      <ConfirmDialog
        open={confirm === "send"} onOpenChange={(o) => !o && setConfirm(null)} title="Mark this version as sent?" confirmLabel="Mark as sent" loading={busy("send")}
        description={<>This freezes version {detail.version} exactly as it is, makes the customer&apos;s link and marks the proposal as sent. It contacts no one. On the Delivery tab you can then send the customer their link by email, text message or WhatsApp after you have read the message, or copy it and give it to them yourself.</>}
        onConfirm={async () => { const ok = await run("send", () => sendProposalAction(detail.id, detail.version), "Marked as sent. The customer's link is on the Delivery tab."); setConfirm(null); if (ok) onOpenTab("delivery"); }}
      />
      <ConfirmDialog
        open={confirm === "reject"} onOpenChange={(o) => !o && setConfirm(null)} title="Reject this proposal?" confirmLabel="Reject" danger loading={busy("reject")}
        description="It will not be sent, and the writer is told. They can duplicate it to start again."
        onConfirm={async () => { await run("reject", () => decideProposalAction(detail.id, { decision: "reject", version: detail.version, note: note || null }), "Rejected."); setConfirm(null); }}
      />
      <ConfirmDialog
        open={confirm === "withdraw"} onOpenChange={(o) => !o && setConfirm(null)} title="Withdraw this proposal?" confirmLabel="Withdraw" danger loading={busy("withdraw")}
        description={s === "sent" ? `The customer's link stops working at once, and they can no longer accept it.${detail.signature.requests.some((r) => isLive(r.status)) ? " A signing request that is out is withdrawn too, and a signature that still arrives for it is not applied." : ""} You can revise it and send a new version later.` : "It will not be sent. You can revise it later."}
        onConfirm={async () => { await run("withdraw", () => withdrawProposalAction(detail.id), "Withdrawn."); setConfirm(null); }}
      />
      <ConfirmDialog
        open={confirm === "revise"} onOpenChange={(o) => !o && setConfirm(null)} title="Start a new version?" confirmLabel="Revise" loading={busy("revise")}
        description={`The new version starts as a draft with the same wording and has to be approved and sent again. The customer's old link is closed and the old version is kept in the history.${detail.signature.requests.some((r) => isLive(r.status)) ? " A signing request that is out for the old version is ended: a signature that still arrives for it is never applied to the new version." : ""}`}
        onConfirm={async () => { await run("revise", () => reviseProposalAction(detail.id), "A new version was started."); setConfirm(null); onOpenTab("edit"); }}
      />
      {recording && <RecordAnswer detail={detail} onClose={() => setRecording(false)} />}
    </section>
  );
}

function RecordAnswer({ detail, onClose }: { detail: ProposalDetail; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [decision, setDecision] = React.useState<"" | "accepted" | "declined">("");
  const [name, setName] = React.useState(detail.clientName);
  const [email, setEmail] = React.useState(detail.clientEmail ?? "");
  const [note, setNote] = React.useState("");
  return (
    <Dialog
      open onOpenChange={(o) => !o && onClose()} title="Record the customer's answer" size="md"
      description="Use this when the customer answered by phone, on paper or in person. It is saved as your word and labelled that way everywhere. It is not an electronic signature, and nothing here is verified by the customer."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={busy("record")} disabled={!decision}
            onClick={async () => { const ok = await run("record", () => recordOfflineDecisionAction(detail.id, { decision: decision || "accepted", decidedName: name, decidedEmail: email || null, note: note || null, version: detail.version }), "Recorded."); if (ok) onClose(); }}
          >Record answer</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What did the customer say?" htmlFor="ra-decision">
          <Select id="ra-decision" value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
            <option value="">Choose…</option>
            <option value="accepted">They accepted</option>
            <option value="declined">They declined</option>
          </Select>
        </Field>
        <Field label="Who said so" htmlFor="ra-name" hint="As your business knows them.">
          <Input id="ra-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>
        <Field label="Their email" htmlFor="ra-email" optional>
          <Input id="ra-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>
        <Field label="Note" htmlFor="ra-note" optional hint="How and when they told you.">
          <Textarea id="ra-note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>
      </div>
    </Dialog>
  );
}
