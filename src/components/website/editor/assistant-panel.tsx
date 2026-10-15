"use client";

import * as React from "react";
import { AlertTriangle, Check, Info, Sparkles, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useStudioApi } from "@/components/website/studio/studio-api";
import type { SiteContent } from "@/lib/website/doc";
import { applyOps, knownWords, outline, type ApplyResult, type Plan } from "@/lib/website/assistant/ops";
import { SUGGESTIONS, planWithRules } from "@/lib/website/assistant/planner";
import { MAX_REQUEST, makeBrief } from "@/lib/website/assistant/brief";
import { diffDocs } from "@/lib/website/editor/diff";
import { cn } from "@/lib/utils";
import { AreaControl } from "./controls";
import { ScaledPreview } from "./panel-add";

type Stage = "idle" | "thinking" | "proposal" | "applying" | "applied";
interface Proposal { plan: Plan; request: string; note: string | null }

/**
 * Describe a change in your own words and see exactly what would happen before anything does. The assistant can only make the same safe
 * edits the editor offers (colours, fonts, spacing, adding or moving sections, wording you ask for), never writes code, and never makes up
 * testimonials, awards, numbers or guarantees. Applying is one undoable step, and a restore point is saved first. Manual editing is
 * always available and never depends on the assistant.
 */
export function AssistantPanel({
  doc, pageId, pageSlug, selection, commit, undo, checkpoint, ai, readOnly,
}: {
  doc: SiteContent;
  pageId: string;
  pageSlug: string;
  selection: string | null;
  commit: (doc: SiteContent) => void;
  undo: () => void;
  /** Saves the work so far as a restore point. Resolves false (and tells the person why) when it couldn't. */
  checkpoint: (note: string) => Promise<boolean>;
  /** An AI provider is connected for this workspace. */
  ai: boolean;
  readOnly: boolean;
}) {
  const api = useStudioApi();
  const [request, setRequest] = React.useState("");
  const [useAi, setUseAi] = React.useState(true);
  const [stage, setStage] = React.useState<Stage>("idle");
  const [proposal, setProposal] = React.useState<Proposal | null>(null);
  const [confirmRemoval, setConfirmRemoval] = React.useState(false);
  const [preview, setPreview] = React.useState(false);
  const [done, setDone] = React.useState<string[]>([]);
  // The newest document, readable after an await without capturing a stale one.
  const latest = React.useRef(doc);
  React.useLayoutEffect(() => {
    latest.current = doc;
  }, [doc]);

  const aiOn = ai && useAi && Boolean(api.suggestEdit);
  const dry: ApplyResult | null = React.useMemo(
    () => (proposal ? applyOps(doc, proposal.plan.ops, { pageId, known: knownWords(doc, proposal.request) }) : null),
    [proposal, doc, pageId],
  );
  const diff = React.useMemo(() => (dry && dry.applied.length ? diffDocs(doc, dry.doc) : null), [dry, doc]);
  const hasRemoval = Boolean(proposal?.plan.destructive);

  const suggest = async () => {
    const text = request.trim();
    if (text.length < 3) return;
    setStage("thinking");
    setProposal(null);
    setPreview(false);
    setConfirmRemoval(false);
    setDone([]);
    let plan: Plan | null = null;
    let note: string | null = null;
    if (aiOn) {
      const res = await api.suggestEdit!(text, makeBrief(doc, pageId, selection));
      if (res.ok && res.data) plan = res.data;
      else note = res.ok ? "The AI assistant didn't have a suggestion, so I used the built-in assistant instead." : `${res.error} I used the built-in assistant instead.`;
    }
    if (!plan) plan = planWithRules(doc, text, { pageId, selection });
    setProposal({ plan, request: text, note });
    setStage("proposal");
  };

  const apply = async () => {
    if (!proposal || readOnly) return;
    setStage("applying");
    // A restore point first, so anything the assistant does can be wound back from Version history as well as with Undo.
    const saved = await checkpoint(`Before assistant: ${proposal.plan.summary.replace(/\.$/, "").slice(0, 90) || "an edit"}`);
    if (!saved) return setStage("proposal");
    const result = applyOps(latest.current, proposal.plan.ops, { pageId, known: knownWords(latest.current, proposal.request) });
    if (result.applied.length === 0) {
      toast.error("Nothing could be applied. The page may have changed since the suggestion.");
      return setStage("proposal");
    }
    commit(result.doc);
    setDone(result.applied);
    setProposal(null);
    setRequest("");
    setStage("applied");
    toast.success(`Applied ${result.applied.length} change${result.applied.length === 1 ? "" : "s"}. Undo brings it back.`);
  };

  const discard = () => {
    setProposal(null);
    setStage("idle");
    setPreview(false);
  };
  const sections = React.useMemo(() => outline(doc, pageId).length, [doc, pageId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <p className="flex items-start gap-2 text-[12px] leading-relaxed text-muted">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          <span>Say what you&apos;d like to change. You&apos;ll see exactly what would happen before anything does.</span>
        </p>
        <AreaControl
          aria-label="What would you like to change?" rows={3} value={request} maxLength={MAX_REQUEST} disabled={readOnly || stage === "thinking" || stage === "applying"}
          placeholder={selection ? "e.g. Make this section two columns" : "e.g. Make it feel more luxurious, with a deep green and gold palette"}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void suggest(); } }}
        />
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="soft" loading={stage === "thinking"} disabled={readOnly || request.trim().length < 3 || stage === "applying"} onClick={() => void suggest()}>
            <Sparkles className="size-3.5" aria-hidden /> Suggest changes
          </Button>
          <span className="text-[11px] text-muted" aria-hidden>{request.length}/{MAX_REQUEST}</span>
        </div>
        {ai ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-2 p-2 text-[11.5px] leading-relaxed text-ink-2">
            <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="mt-0.5 size-3.5 accent-[var(--primary)]" />
            <span>
              <strong className="font-medium text-ink">Use AI for open-ended requests.</strong> Only a short outline of this page (headings, section names, brand colours) is sent to the AI provider your agency connected. Never phone numbers, emails or customer details.
            </span>
          </label>
        ) : (
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Built-in assistant. It handles everyday requests without sending anything anywhere. Editing by hand always works.</p>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {stage === "thinking" && <p className="text-[12.5px] text-muted" role="status">Working out what to change…</p>}

        {proposal && (
          <section aria-label="Suggested changes" className="space-y-3 rounded-xl border border-line bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <span className={cn("rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide", proposal.plan.source === "ai" ? "bg-primary-soft text-primary-ink" : "bg-surface-3 text-ink-2")}>
                {proposal.plan.source === "ai" ? "AI suggestion" : "Built-in assistant"}
              </span>
              <span className="text-[11px] text-muted">Nothing has changed yet</span>
            </div>
            {proposal.note && <p className="rounded-lg bg-warning-soft p-2 text-[12px] leading-relaxed text-warning-ink">{proposal.note}</p>}

            {proposal.plan.summary && dry && dry.applied.length > 0 && <p className="text-[13px] font-medium leading-snug">{proposal.plan.summary}</p>}

            {dry && dry.applied.length > 0 && (
              <>
                <ul className="space-y-1.5" aria-label="What would change">
                  {dry.applied.map((line, i) => (
                    <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug"><Check className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-hidden /><span>{line}</span></li>
                  ))}
                </ul>
                {diff && diff.summary.length > 0 && (
                  <details className="rounded-lg border border-line text-[12px]">
                    <summary className="cursor-pointer px-2.5 py-1.5 font-medium text-ink-2">In detail · {diff.changes.length} item{diff.changes.length === 1 ? "" : "s"}</summary>
                    <ul className="space-y-1 border-t border-line p-2.5 text-muted">{diff.summary.slice(0, 12).map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </details>
                )}
                <div>
                  <button type="button" onClick={() => setPreview((v) => !v)} aria-expanded={preview} className="text-[12px] font-medium text-primary-ink hover:underline">{preview ? "Hide preview" : "Preview this page with the changes"}</button>
                  {preview && (
                    <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-line" tabIndex={0} aria-label="Preview of the page with the suggested changes">
                      <ScaledPreview content={dry.doc} scope="assistant-pv" maxHeight={8000} pageSlug={pageSlug} />
                    </div>
                  )}
                </div>
              </>
            )}

            {dry && dry.applied.length === 0 && !proposal.plan.clarification && (
              <p className="text-[12.5px] leading-relaxed text-ink-2">{proposal.plan.ops.length === 0 ? "There was nothing I could change for that." : "None of those changes could be made on this page."}</p>
            )}
            {proposal.plan.clarification && <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-ink-2"><Info className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden /> {proposal.plan.clarification}</p>}

            {dry && dry.rejected.length > 0 && (
              <div className="rounded-lg bg-surface-2 p-2.5 text-[12px] leading-relaxed text-ink-2">
                <p className="font-medium">Left out</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">{dry.rejected.map((r, i) => <li key={i}>{r.reason}</li>)}</ul>
              </div>
            )}
            {proposal.plan.notes.length > 0 && (
              <ul className="space-y-1.5" aria-label="Things to know">
                {proposal.plan.notes.map((n, i) => <li key={i} className="flex items-start gap-1.5 text-[12px] leading-relaxed text-ink-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden /> <span>{n}</span></li>)}
              </ul>
            )}

            {hasRemoval && dry && dry.applied.length > 0 && (
              <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-danger-soft p-2.5 text-[12px] leading-relaxed text-danger-ink">
                <input type="checkbox" checked={confirmRemoval} onChange={(e) => setConfirmRemoval(e.target.checked)} className="mt-0.5 size-3.5 accent-[var(--danger)]" />
                <span>Yes, remove it. A restore point is saved first and Undo brings it back.</span>
              </label>
            )}

            <div className="flex flex-wrap gap-2">
              {dry && dry.applied.length > 0 && (
                <Button size="sm" variant="brand" loading={stage === "applying"} disabled={readOnly || (hasRemoval && !confirmRemoval)} onClick={() => void apply()}>Apply changes</Button>
              )}
              <Button size="sm" variant="ghost" disabled={stage === "applying"} onClick={discard}><X className="size-3.5" aria-hidden /> {dry && dry.applied.length > 0 ? "Discard" : "Close"}</Button>
            </div>
          </section>
        )}

        {stage === "applied" && done.length > 0 && (
          <section aria-label="Changes applied" className="space-y-2 rounded-xl border border-success/30 bg-success-soft p-3">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-success-ink"><Check className="size-4" aria-hidden /> Applied {done.length} change{done.length === 1 ? "" : "s"}</p>
            <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-2">{done.slice(0, 8).map((l, i) => <li key={i}>{l}</li>)}</ul>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => { undo(); setStage("idle"); setDone([]); }}><Undo2 className="size-3.5" aria-hidden /> Undo these changes</Button>
              <Button size="sm" variant="ghost" onClick={() => { setStage("idle"); setDone([]); }}>Done</Button>
            </div>
          </section>
        )}

        {(stage === "idle" || stage === "applied") && !proposal && (
          <div>
            <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted">Try asking</p>
            <ul className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.filter((s) => !s.includes("select a section") || selection).slice(0, 8).map((s) => (
                <li key={s}><button type="button" disabled={readOnly} onClick={() => setRequest(s)} className="rounded-full border border-line bg-surface px-2.5 py-1 text-left text-[12px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-50">{s}</button></li>
              ))}
            </ul>
            <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
              {sections} section{sections === 1 ? "" : "s"} on this page. I never write testimonials, reviews, awards, prices or guarantees for you: those need your real details, so I add clearly marked placeholders that stop publishing until you replace them.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
