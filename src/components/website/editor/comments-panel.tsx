"use client";

import * as React from "react";
import { MessageSquare, Check, RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
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
          <button type="button" disabled={!here} onClick={() => onJump(c.nodeId!)} className="mt-1.5 inline-flex max-w-full items-center gap-1 truncate rounded-md bg-primary-soft px-1.5 py-0.5 text-[12px] font-medium text-primary-ink disabled:bg-surface-3 disabled:text-muted">
            <MessageSquare className="size-3 shrink-0" aria-hidden /> <span className="truncate">{here ? `On: ${describeNode(doc, c.nodeId)}` : "On something that has since been removed"}</span>
          </button>
        )}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-t border-line pt-2.5 text-[12px] text-muted">
          <span className="flex min-w-0 items-center gap-2">
            <AvatarTile name={c.authorName ?? "Someone"} size="sm" />
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-ink">{c.authorName ?? "Someone"}</span>
              <span className="block">{relativeTime(c.createdAt)}</span>
            </span>
            <StatusPill size="sm" tone={c.authorKind === "agency" ? "primary" : "neutral"}>{c.authorKind === "agency" ? "iAcquire" : "Your team"}</StatusPill>
          </span>
          <button type="button" onClick={() => void resolve(c)} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 font-medium text-primary-ink hover:bg-primary-soft">{c.resolvedAt ? <><RotateCcw className="size-3" aria-hidden /> Reopen</> : <><Check className="size-3" aria-hidden /> Resolve</>}</button>
        </div>
      </li>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <AreaControl aria-label="Write a comment" rows={3} value={text} maxLength={2000} placeholder="Leave a note for the team" onChange={(e) => setText(e.target.value)} />
        {selection && (
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} className="size-3.5 accent-[var(--primary)]" />
            <span className="truncate">Attach to: {describeNode(doc, selection)}</span>
          </label>
        )}
        <Button size="sm" variant="soft" loading={busy} disabled={!text.trim()} onClick={() => void post()}>Add comment</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {error && <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-[12px] text-danger-ink">{error}</p>}
        {!list && !error && <p className="flex items-center justify-center gap-2 rounded-xl bg-surface-2 py-6 text-[12px] text-muted" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading comments…</p>}
        {list && list.length === 0 && <EmptyState compact icon={<MessageSquare className="size-5" />} title="No comments yet" description="Notes from iAcquire and your team appear here." />}
        {open.length > 0 && <ul className="space-y-2" aria-label="Open comments">{open.map(row)}</ul>}
        {done.length > 0 && (
          <details className="pt-2">
            <summary className="flex cursor-pointer items-center gap-2 text-[12px] font-medium text-muted">Resolved <InfoChip>{done.length}</InfoChip></summary>
            <ul className="mt-2 space-y-2">{done.map(row)}</ul>
          </details>
        )}
      </div>
    </div>
  );
}
