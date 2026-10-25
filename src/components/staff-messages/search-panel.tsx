"use client";

import * as React from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/utils";
import { searchMessagesAction } from "@/app/actions/staff-messages";
import type { SearchResult } from "@/server/staff-messages/search";
import { SEARCH_MAX_CHARS, SEARCH_MAX_RESULTS, SEARCH_MIN_CHARS } from "@/lib/staff-messages/limits";
import { searchHitHref, searchHitTitle } from "@/lib/staff-messages/view";
import { useAction } from "@/components/staff-messages/use-action";

// Search across the conversations the person is in (the server limits it to those, as plain text, newest first). A result opens its conversation at that message, and a
// reply opens its thread. The words typed are never run as a pattern anywhere.

export function SearchPanel({ open, onOpenChange, conversationId, conversationName, timeZone }: { open: boolean; onOpenChange: (open: boolean) => void; conversationId: string | null; conversationName: string | null; timeZone: string }) {
  const { run, busy } = useAction();
  const [query, setQuery] = React.useState("");
  const [scoped, setScoped] = React.useState(false);
  const [result, setResult] = React.useState<{ asked: string; value: SearchResult } | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const asked = query.trim();
    const res = await run("search", () => searchMessagesAction({ query: asked, conversationId: scoped ? conversationId : null }), { quiet: true });
    if (res.ok) setResult({ asked, value: res.data });
    else {
      setResult(null);
      setProblem(res.error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Search messages" size="lg" description="Looks through the conversations you are in. Nobody else's messages are searched.">
      <form onSubmit={submit} className="space-y-3" role="search">
        <div className="flex gap-2">
          <Input aria-label="Words to search for" placeholder="Search messages" value={query} maxLength={SEARCH_MAX_CHARS} onChange={(e) => setQuery(e.target.value)} autoComplete="off" autoFocus />
          <Button type="submit" loading={busy("search")} disabled={query.trim().length < SEARCH_MIN_CHARS}>
            <Search className="size-4" aria-hidden /> Search
          </Button>
        </div>
        {conversationId && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[14px] text-ink-2">
            <input type="checkbox" className="size-5 accent-[var(--color-primary,#305ecb)]" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
            Only in {conversationName ? `“${conversationName}”` : "this conversation"}
          </label>
        )}
      </form>
      <div className="mt-4" aria-live="polite">
        {problem && <p role="alert" className="text-[14px] text-danger-ink">{problem}</p>}
        {result && (
          <>
            <p role="status" className="mb-2 text-[14px] text-muted">
              {result.value.hits.length === 0
                ? `No messages match “${result.asked}”.`
                : `${result.value.hits.length} ${result.value.hits.length === 1 ? "message matches" : "messages match"} “${result.asked}”${result.value.truncated ? `. Showing the newest ${SEARCH_MAX_RESULTS}; use more specific words to narrow it down` : ""}.`}
            </p>
            <ul className="space-y-1">
              {result.value.hits.map((hit) => (
                <li key={hit.messageId}>
                  <Link
                    href={searchHitHref(hit)}
                    prefetch={false}
                    onClick={() => onOpenChange(false)}
                    className="block min-h-14 rounded-xl border border-line bg-surface px-3 py-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-muted">
                      <span className="font-medium text-ink-2">{searchHitTitle(hit)}</span>
                      <span>{hit.author.name}</span>
                      <time dateTime={hit.createdAt}>{formatDateTime(hit.createdAt, timeZone)}</time>
                      {hit.threadRootId && <span>in a thread</span>}
                    </span>
                    <span className="mt-1 block break-words text-[14px] text-ink [overflow-wrap:anywhere]">
                      {hit.snippet.match ? (
                        <>
                          {hit.snippet.text.slice(0, hit.snippet.match.start)}
                          <mark className="rounded bg-warning-soft px-0.5 text-warning-ink">{hit.snippet.text.slice(hit.snippet.match.start, hit.snippet.match.end)}</mark>
                          {hit.snippet.text.slice(hit.snippet.match.end)}
                        </>
                      ) : (
                        hit.snippet.text
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
