import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_COPY, InboxListPanel, MORE_VIEWS, PRIMARY_VIEWS, RESTRICTED_EMPTY, type ListPanelProps } from "@/components/inbox/inbox-list-panel";
import { INBOX_VIEWS, INBOX_VIEW_HELP, INBOX_VIEW_LABELS } from "@/lib/inbox";

// What the list panel says, rendered on the server. The interactive behaviour (selection, polling) is covered in the browser QA and by the sync tests.

const props = (over: Partial<ListPanelProps> = {}): ListPanelProps => ({
  items: [], counts: null, view: "all", sort: "priority", q: "", channel: "", selectedId: null, loading: false, loadingMore: false, error: null, hasMore: false,
  perms: { reply: true, assign: true, viewAll: true }, team: [], onChange: vi.fn(), onOpen: vi.fn(), onLoadMore: vi.fn(), onRetry: vi.fn(), onChanged: vi.fn(), ...over,
});
const html = (over: Partial<ListPanelProps> = {}) => renderToStaticMarkup(React.createElement(InboxListPanel, props(over)));
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

describe("an empty list", () => {
  it("tells someone who sees everything to check the channels", () => {
    const out = text(html());
    expect(out).toContain(EMPTY_COPY.all.title);
    expect(html()).toContain("Check channel setup");
  });

  it("tells someone who sees only their own conversations that nothing is assigned to them, and does not send them to the channel setup", () => {
    const markup = html({ perms: { reply: true, assign: false, viewAll: false } });
    const out = text(markup);
    expect(out).toContain(RESTRICTED_EMPTY.title);
    expect(out).toContain("conversations you own or that a manager assigns to you");
    expect(markup).not.toContain("Check channel setup");
    expect(out).not.toContain(EMPTY_COPY.all.title);
    // The other views keep their own wording for everybody.
    expect(text(html({ view: "attention", perms: { reply: true, assign: false, viewAll: false } }))).toContain(EMPTY_COPY.attention.title);
  });

  it("says nothing matches, not that the inbox is empty, when a search or filter is the reason", () => {
    const out = text(html({ q: "zzz" }));
    expect(out).toContain("Nothing matches");
    expect(out).not.toContain(EMPTY_COPY.all.title);
  });
});

describe("the views", () => {
  it("defines every view in the words the interface shows, and offers each one on the tab row or under More", () => {
    for (const v of INBOX_VIEWS) {
      expect(INBOX_VIEW_LABELS[v], v).toBeTruthy();
      expect(INBOX_VIEW_HELP[v], v).toBeTruthy();
      expect(EMPTY_COPY[v].title, v).toBeTruthy();
    }
    expect([...PRIMARY_VIEWS, ...MORE_VIEWS].sort()).toEqual([...INBOX_VIEWS].sort());
    const out = text(html({ counts: Object.fromEntries(INBOX_VIEWS.map((v, i) => [v, i])) as never }));
    for (const v of PRIMARY_VIEWS) expect(out).toContain(INBOX_VIEW_LABELS[v]);
  });
});
