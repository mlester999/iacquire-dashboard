"use client";

import * as React from "react";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { requestInsights } from "@/components/inbox/assist-client";
import { relativeTime } from "@/lib/utils";
import type { ConversationInsights } from "@/server/messaging/inbox-ai";

const CONFIDENCE_TONE = { low: "warning", medium: "neutral", high: "success" } as const;

/**
 * "Catch me up": a summary, suggested next steps and, if the model thinks so, why a person should look. It is advice written by an AI from
 * this conversation, labelled as such, with how sure it was and whether the conversation has moved since. It changes nothing.
 */
export function AiAssistPanel({ conversationId, newestInboundId, canUse }: { conversationId: string; newestInboundId: string | null; canUse: boolean }) {
  const [state, setState] = React.useState<{ kind: "idle" } | { kind: "loading" } | { kind: "ready"; data: ConversationInsights } | { kind: "error"; reason: string }>({ kind: "idle" });
  const abort = React.useRef<AbortController | null>(null);

  // The panel is keyed by the conversation, so another conversation is a new panel: one customer's summary is never carried onto the next.
  React.useEffect(() => () => abort.current?.abort(), []);

  async function ask() {
    abort.current?.abort();
    abort.current = new AbortController();
    setState({ kind: "loading" });
    const r = await requestInsights(conversationId, abort.current.signal);
    if (abort.current.signal.aborted) return;
    setState(r.ok ? { kind: "ready", data: r.data } : { kind: "error", reason: r.reason });
  }

  const stale = state.kind === "ready" && state.data.basedOnMessageId !== newestInboundId;
  return (
    <section aria-label="AI summary" className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold"><Sparkles className="size-4 text-violet-ink" aria-hidden />Catch me up</h2>
        {canUse && (
          <Button size="sm" variant="secondary" onClick={ask} disabled={state.kind === "loading"} aria-busy={state.kind === "loading" || undefined}>
            {state.kind === "loading" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {state.kind === "ready" ? "Refresh" : "Summarize"}
          </Button>
        )}
      </div>
      {!canUse && <p className="mt-2 text-[12.5px] text-muted">Your role can&apos;t use AI help on conversations.</p>}
      {canUse && state.kind === "idle" && <p className="mt-2 text-[12.5px] text-muted">A short summary and suggested next steps, written by AI from this conversation. It changes nothing and sends nothing.</p>}
      <div role="status" aria-live="polite">
        {state.kind === "loading" && <p className="mt-2 text-[12.5px] text-muted">Reading the conversation…</p>}
        {state.kind === "error" && <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-danger-ink"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />{state.reason}</p>}
      </div>
      {state.kind === "ready" && (
        <div className="mt-3 space-y-3 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="violet">AI-written · not verified</Badge>
            <Badge tone={CONFIDENCE_TONE[state.data.confidence]}>{state.data.confidence} confidence</Badge>
            <span className="text-faint" suppressHydrationWarning>{relativeTime(state.data.generatedAt)}</span>
          </div>
          {stale && <p className="rounded-lg bg-warning-soft p-2 text-warning-ink">The customer has written since this was made. Refresh it.</p>}
          <p className="whitespace-pre-wrap leading-relaxed text-ink-2">{state.data.summary}</p>
          {state.data.nextSteps.length > 0 && (
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted">Suggested next steps</h3>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-ink-2">{state.data.nextSteps.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {state.data.reviewReason && (
            <div className="rounded-lg border border-warning/30 bg-warning-soft/50 p-2.5">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-warning-ink">Why a person may want to look</h3>
              <p className="mt-0.5 text-ink-2">{state.data.reviewReason}</p>
              <p className="mt-1 text-[12px] text-muted">This is the AI&apos;s opinion, not a fact about the customer.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
