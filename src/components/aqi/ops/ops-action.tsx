"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, OctagonAlert, ShieldAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { isSafeOpsHref } from "@/lib/aqi/ops/links";
import { cn } from "@/lib/utils";
import type { OpsActionPreviewCard, OpsActionResultCard, OpsCard } from "@/lib/aqi/ops/types";

const RISK_TONE = { low: "success", medium: "warning", high: "danger", critical: "danger" } as const;
const RISK_LABEL = { low: "Low impact", medium: "Medium impact", high: "High impact", critical: "Critical impact" } as const;

const STATUS_COPY: Record<OpsActionPreviewCard["status"], string> = {
  proposed: "Waiting for your confirmation. Nothing has changed.",
  executing: "Running now. The result is confirmed by reading the system back.",
  succeeded: "Done and verified.",
  verification_failed: "The action ran, but the expected end state was not confirmed. Check the system before relying on it.",
  failed: "Not completed. Nothing was reported as changed.",
  cancelled: "Cancelled. Nothing changed.",
  expired: "Expired. Ask AQi to prepare it again so you review the current state.",
};

export function ActionPreview({ card, onOutcome }: { card: OpsActionPreviewCard; onOutcome: (actionId: string, cards: OpsCard[]) => void }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [phrase, setPhrase] = React.useState("");
  const [reason, setReason] = React.useState("");
  const proposed = card.status === "proposed";
  const needsReason = card.approval !== "confirm";
  const needsPhrase = card.approval === "typed_confirmation";
  const reasonOk = !needsReason || reason.trim().length >= 8;
  const phraseOk = !needsPhrase || phrase.trim().toLowerCase().replace(/\s+/g, " ") === (card.confirmPhrase ?? "").trim().toLowerCase().replace(/\s+/g, " ");

  async function submit(op: "confirm" | "cancel") {
    setBusy(op);
    setError(null);
    try {
      const res = await fetch(`/api/aqi/ops/actions/${card.actionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(op === "confirm" ? { op, reason: reason.trim() || undefined, phrase: phrase.trim() || undefined } : { op }),
      });
      const body = (await res.json().catch(() => null)) as { cards?: OpsCard[]; error?: string } | null;
      if (!res.ok || !body?.cards) {
        setError(body?.error ?? "That could not be completed. Nothing was reported as changed.");
        return;
      }
      setOpen(false);
      onOutcome(card.actionId, body.cards);
    } catch {
      setError("The request could not be sent. Check your connection; nothing was reported as changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-line-strong bg-surface-2/60 p-4" data-testid="ops-action-preview">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={RISK_TONE[card.risk]} icon={card.risk === "low" ? <CheckCircle2 className="size-3.5" aria-hidden /> : <ShieldAlert className="size-3.5" aria-hidden />}>{RISK_LABEL[card.risk]}</StatusPill>
        <StatusPill tone="neutral" dot={false}>{card.approval === "typed_confirmation" ? "Typed confirmation" : card.approval === "confirm_with_reason" ? "Reason required" : "Confirmation required"}</StatusPill>
      </div>
      <p className="mt-3 text-[14px] font-semibold leading-snug text-ink">{card.headline}</p>
      <p className="mt-1 text-[12px] text-muted">Target: <span className="font-medium text-ink-2">{card.target}</span></p>
      <p className="mt-3 text-[12px] font-medium uppercase tracking-wide text-muted">Exactly what will happen</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-ink-2">
        {card.effects.map((effect) => <li key={effect}>{effect}</li>)}
      </ul>
      <p className="mt-3 text-[13px] text-muted"><span className="font-medium text-ink-2">Undo:</span> {card.reversible}</p>
      <p className={cn("mt-3 text-[13px]", card.status === "succeeded" ? "text-success-ink" : card.status === "failed" || card.status === "verification_failed" ? "text-danger-ink" : "text-muted")} role={card.status === "proposed" ? undefined : "status"}>
        {STATUS_COPY[card.status]}{proposed ? <> Expires <time dateTime={card.expiresAt} suppressHydrationWarning>{new Date(card.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>.</> : null}
      </p>
      {proposed && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {needsReason ? (
            <Button size="sm" variant={card.risk === "high" || card.risk === "critical" ? "danger" : "primary"} onClick={() => setOpen(true)} disabled={busy !== null}>Review and confirm</Button>
          ) : (
            <Button size="sm" onClick={() => void submit("confirm")} loading={busy === "confirm"} disabled={busy !== null}>Confirm and run</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void submit("cancel")} loading={busy === "cancel"} disabled={busy !== null}>Cancel proposal</Button>
        </div>
      )}
      {error && !open && <p className="mt-2 flex items-start gap-1.5 text-[13px] text-danger-ink" role="alert"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />{error}</p>}
      <Dialog
        open={open}
        onOpenChange={(next) => { if (busy === null) setOpen(next); }}
        title={card.risk === "high" || card.risk === "critical" ? "Confirm a high-impact action" : "Confirm this action"}
        description={card.headline}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>Not now</Button>
            <Button variant={card.risk === "high" || card.risk === "critical" ? "danger" : "primary"} onClick={() => void submit("confirm")} loading={busy === "confirm"} disabled={!reasonOk || !phraseOk || busy !== null}>Confirm and run</Button>
          </>
        }
      >
        <div className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-ink-2">{card.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>
          <Field label="Why are you doing this?" htmlFor={`reason-${card.actionId}`} hint="Recorded in the audit log with your name. At least 8 characters.">
            <Textarea id={`reason-${card.actionId}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
          </Field>
          {needsPhrase && (
            <Field label={<>Type <strong>{card.confirmPhrase}</strong> to confirm</>} htmlFor={`phrase-${card.actionId}`}>
              <Input id={`phrase-${card.actionId}`} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          {error && <p className="flex items-start gap-1.5 text-[13px] text-danger-ink" role="alert"><OctagonAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />{error}</p>}
        </div>
      </Dialog>
    </div>
  );
}

export function ActionResult({ card }: { card: OpsActionResultCard }) {
  const ok = card.status === "succeeded";
  return (
    <div className={cn("rounded-xl border p-4", ok ? "border-success/30 bg-success-soft/60" : "border-danger/30 bg-danger-soft/60")} role="status" data-testid="ops-action-result">
      <p className={cn("flex items-start gap-2 text-[14px] font-semibold leading-snug", ok ? "text-success-ink" : "text-danger-ink")}>
        {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
        {card.headline}
      </p>
      {card.observed.length > 0 && (
        <>
          <p className="mt-3 text-[12px] font-medium uppercase tracking-wide text-muted">What the system shows now</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[14px] text-ink-2">{card.observed.map((line) => <li key={line}>{line}</li>)}</ul>
        </>
      )}
      {card.link && isSafeOpsHref(card.link.href) && <Link href={card.link.href} className="mt-3 inline-flex text-[14px] font-medium text-primary-ink underline-offset-2 hover:underline">{card.link.label}</Link>}
    </div>
  );
}
