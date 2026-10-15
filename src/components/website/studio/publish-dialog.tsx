"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Textarea } from "@/components/ui/primitives";
import { useStudioApi } from "@/components/website/studio/studio-api";
import type { Issue } from "@/lib/website/lint";
import type { Preflight, PublishOutcome } from "@/server/websites/service";

type Stage = "loading" | "review" | "working" | "done" | "error";

function IssueList({ items, tone }: { items: Issue[]; tone: "danger" | "warning" | "info" }) {
  const styles = { danger: "border-danger/30 bg-danger-soft/50", warning: "border-warning/40 bg-warning-soft/60", info: "border-line bg-surface-2/60" }[tone];
  return (
    <ul className={`space-y-2 rounded-xl border p-3 ${styles}`}>
      {items.map((i, n) => (
        <li key={`${i.code}-${i.where}-${n}`} className="text-[13px] leading-relaxed">
          <p className="font-medium text-ink">{i.message}</p>
          <p className="text-[12px] text-muted">{i.where}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The last stop before a website goes live or is sent for approval. It lists what must be fixed, makes the owner read every
 * claim we cannot verify, and reports the real outcome, including whether the live site was actually confirmed.
 */
export function PublishDialog({ open, onClose, mode, host, onDone, flush, noun = "website" }: { open: boolean; onClose: () => void; mode: "publish" | "approval"; host: string; onDone: () => void; flush?: () => Promise<boolean>; noun?: "website" | "template" }) {
  const isTemplate = noun === "template";
  const api = useStudioApi();
  const [stage, setStage] = React.useState<Stage>("loading");
  const [pf, setPf] = React.useState<Preflight | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [outcome, setOutcome] = React.useState<PublishOutcome | null>(null);
  const [serverIssues, setServerIssues] = React.useState<{ blockers: Issue[]; claims: Issue[] } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      setStage("loading");
      setAck(false);
      setError(null);
      setOutcome(null);
      setServerIssues(null);
      if (flush && !(await flush())) {
        if (live) {
          setError("Your latest changes haven't been saved yet, so we can't check them. Wait for “Saved” and try again.");
          setStage("error");
        }
        return;
      }
      const res = await api.preflight();
      if (!live) return;
      if (res.ok) {
        setPf(res.data);
        setStage("review");
      } else {
        setError(res.error);
        setStage("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [open, flush, api]);

  const go = async () => {
    setStage("working");
    setError(null);
    if (mode === "approval") {
      const res = await api.submitForApproval();
      if (res.ok) {
        setStage("done");
        onDone();
      } else {
        setError(res.error);
        setServerIssues({ blockers: ("blockers" in res && res.blockers) || [], claims: [] });
        setStage("review");
      }
      return;
    }
    const res = await api.publish(ack, note);
    if (res.ok) {
      setOutcome(res.data);
      setStage("done");
      onDone();
    } else {
      setError(res.error);
      setServerIssues({ blockers: ("blockers" in res && res.blockers) || [], claims: ("needsAcknowledgement" in res && res.needsAcknowledgement) || [] });
      setStage("review");
    }
  };

  const blockers = serverIssues?.blockers.length ? serverIssues.blockers : pf?.blockers ?? [];
  const claims = pf?.needsAcknowledgement.length ? pf.needsAcknowledgement : serverIssues?.claims ?? [];
  const canGo = stage === "review" && blockers.length === 0 && (mode === "approval" || claims.length === 0 || ack);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && stage !== "working" && onClose()}
      title={mode === "publish" ? (isTemplate ? "Publish this template" : "Publish your website") : isTemplate ? "Send for review" : "Send for approval"}
      description={mode === "publish" ? (isTemplate ? "This makes the working copy the design clients are offered. Websites already made from it keep their own copy and are never changed." : `This makes your site live at ${host}. Everything you've written is saved as a version you can restore.`) : isTemplate ? "A super admin will be asked to review the template and publish it." : "The business owner will be asked to review the preview and approve it."}
      size="lg"
      footer={
        stage === "done" ? (
          <Button variant="brand" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={stage === "working"}>
              Cancel
            </Button>
            <Button variant="brand" onClick={() => void go()} disabled={!canGo} loading={stage === "working"}>
              {mode === "publish" ? (isTemplate ? "Publish template" : "Publish now") : isTemplate ? "Send for review" : "Send for approval"}
            </Button>
          </>
        )
      }
    >
      {stage === "loading" && (
        <p className="flex items-center gap-2 text-[14px] text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Checking your website…
        </p>
      )}
      {stage === "error" && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft/50 p-4 text-[14px] text-danger-ink">
          {error}
        </p>
      )}
      {(stage === "review" || stage === "working") && pf && (
        <div className="space-y-5">
          {error && (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft/50 p-3 text-[13.5px] text-danger-ink">
              {error}
            </p>
          )}
          {blockers.length > 0 ? (
            <section aria-labelledby="pd-blockers" className="space-y-2">
              <h3 id="pd-blockers" className="flex items-center gap-2 text-[14px] font-semibold text-danger-ink">
                <ShieldAlert className="size-4" aria-hidden /> Fix these first
              </h3>
              <IssueList items={blockers} tone="danger" />
            </section>
          ) : (
            <p className="flex items-center gap-2 rounded-xl border border-success/30 bg-success-soft/50 p-3 text-[13.5px] text-success-ink">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden /> Nothing is blocking this.
            </p>
          )}
          {claims.length > 0 && (
            <section aria-labelledby="pd-claims" className="space-y-2">
              <h3 id="pd-claims" className="flex items-center gap-2 text-[14px] font-semibold text-warning-ink">
                <AlertTriangle className="size-4" aria-hidden /> Claims on your site
              </h3>
              <p className="text-[13px] text-muted">We can&apos;t check these. Anything you publish must be true and something you can prove.</p>
              <IssueList items={claims} tone="warning" />
              {mode === "publish" && (
                <label className="flex cursor-pointer items-start gap-3 text-[13.5px] leading-relaxed">
                  <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--primary)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>I&apos;ve read these claims and I can back up each one with proof if asked.</span>
                </label>
              )}
            </section>
          )}
          {pf.warnings.length > 0 && (
            <section aria-labelledby="pd-notes" className="space-y-2">
              <h3 id="pd-notes" className="flex items-center gap-2 text-[14px] font-semibold">
                <Info className="size-4 text-primary" aria-hidden /> Worth a look
              </h3>
              <IssueList items={pf.warnings} tone="info" />
            </section>
          )}
          {mode === "publish" && (
            <div>
              <label htmlFor="pd-note" className="mb-1.5 block text-[13px] font-medium text-ink-2">
                Note for your version history <span className="font-normal text-muted">(optional)</span>
              </label>
              <Textarea id="pd-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this update?" />
            </div>
          )}
        </div>
      )}
      {stage === "done" && mode === "approval" && (
        <p className="flex items-start gap-2 text-[14px]" role="status">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden /> {isTemplate ? "Sent for review. A super admin can publish it from the template library." : "Sent. The owner has been notified and can review it from the Website page."}
        </p>
      )}
      {stage === "done" && outcome && (
        <div className="space-y-3" role="status">
          <p className="flex items-start gap-2 text-[14px]">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
            {outcome.restoredPrevious ? "That update couldn't be served, so your previous version is still live." : `Published as version ${outcome.number}.`}
          </p>
          <p className="rounded-xl border border-line bg-surface-2/60 p-3 text-[13.5px] leading-relaxed text-ink-2">
            {isTemplate ? outcome.healthDetail : outcome.restoredPrevious
              ? `${outcome.healthDetail} Nothing was lost; your edits are still in the editor.`
              : outcome.health === "healthy"
                ? `Confirmed live at ${outcome.host}.`
                : outcome.health === "unchecked"
                  ? `${outcome.healthDetail} Until then, we haven't confirmed it's reachable at ${outcome.host}.`
                  : `The site was saved, but we couldn't confirm it's being served. ${outcome.healthDetail}`}
          </p>
        </div>
      )}
    </Dialog>
  );
}
