"use client";

import * as React from "react";
import { MessageSquare, Check, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useStudioApi } from "@/components/website/studio/studio-api";
import type { SiteContent } from "@/lib/website/doc";
import { describeNode, findNode } from "@/lib/website/ops";
import { relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { CommentView } from "@/server/websites/review";
import { AreaControl } from "./controls";
import { useResetOnOpen } from "./hooks";

/**
 * Notes between the client's team and the agency, about the whole page or about one element. A comment on an element is a link back to it:
 * choosing it takes you to the page and selects the element.
 */
export function CommentsPanel({ doc, selection, pageSlug, onJump, active }: { doc: SiteContent; selection: string | null; pageSlug: string; onJump: (nodeId: string) => void; active: boolean }) {
  const api = useStudioApi();
  const [list, setList] = React.useState<CommentView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");
  const [attach, setAttach] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  // Load the first time the tab is shown.
  useResetOnOpen(active && !loaded, () => setLoaded(true));
  React.useEffect(() => {
    if (!loaded) return;
    let live = true;
    void api.listComments?.().then((r) => {
      if (!live) return;
      if (r.ok) setList(r.data);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [loaded, api]);

  const refresh = async () => {
    const r = await api.listComments?.();
    if (r?.ok) setList(r.data);
  };
  const post = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const res = await api.addComment?.(text, attach && selection ? selection : null, pageSlug);
    setBusy(false);
    if (!res?.ok) return void toast.error(res?.error ?? "That comment couldn't be saved.");
    setText("");
    await refresh();
  };
  const resolve = async (c: CommentView) => {
    const res = await api.resolveComment?.(c.id, !c.resolvedAt);
    if (!res?.ok) return void toast.error(res?.error ?? "That didn't work.");
    await refresh();
  };
  const open = (list ?? []).filter((c) => !c.resolvedAt);
  const done = (list ?? []).filter((c) => c.resolvedAt);
  const row = (c: CommentView) => {
    const here = c.nodeId ? findNode(doc, c.nodeId) : null;
    return (
      <li key={c.id} className={cn("rounded-xl border border-line bg-surface p-3", c.resolvedAt && "border-dashed bg-surface-2")}>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{c.body}</p>
        {c.nodeId && (
          <button type="button" disabled={!here} onClick={() => onJump(c.nodeId!)} className="mt-1.5 inline-flex max-w-full items-center gap-1 truncate rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] font-medium text-primary-ink disabled:bg-surface-3 disabled:text-muted">
            <MessageSquare className="size-3 shrink-0" aria-hidden /> <span className="truncate">{here ? `On: ${describeNode(doc, c.nodeId)}` : "On something that has since been removed"}</span>
          </button>
        )}
        <p className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 text-[11px] text-muted">
          <span>{c.authorName ?? "Someone"} · {c.authorKind === "agency" ? "iAcquire" : "Your team"} · {relativeTime(c.createdAt)}</span>
          <button type="button" onClick={() => void resolve(c)} className="inline-flex items-center gap-1 font-medium text-primary-ink hover:underline">{c.resolvedAt ? <><RotateCcw className="size-3" aria-hidden /> Reopen</> : <><Check className="size-3" aria-hidden /> Resolve</>}</button>
        </p>
      </li>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <AreaControl aria-label="Write a comment" rows={3} value={text} maxLength={2000} placeholder="Leave a note for the team" onChange={(e) => setText(e.target.value)} />
        {selection && (
          <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-ink-2">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} className="size-3.5 accent-[var(--primary)]" />
            <span className="truncate">Attach to: {describeNode(doc, selection)}</span>
          </label>
        )}
        <Button size="sm" variant="soft" loading={busy} disabled={!text.trim()} onClick={() => void post()}>Add comment</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {error && <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-[12px] text-danger-ink">{error}</p>}
        {!list && !error && <p className="text-[12px] text-muted" role="status">Loading comments…</p>}
        {list && list.length === 0 && <p className="py-6 text-center text-[12.5px] leading-relaxed text-muted">No comments yet. Notes from iAcquire and your team appear here.</p>}
        {open.length > 0 && <ul className="space-y-2" aria-label="Open comments">{open.map(row)}</ul>}
        {done.length > 0 && (
          <details className="pt-2">
            <summary className="cursor-pointer text-[12px] font-medium text-muted">Resolved · {done.length}</summary>
            <ul className="mt-2 space-y-2">{done.map(row)}</ul>
          </details>
        )}
      </div>
    </div>
  );
}
