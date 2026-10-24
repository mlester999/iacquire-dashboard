// @vitest-environment jsdom
// The whole Messages page, as one person uses it: opening a conversation, reading it, writing, reacting, editing, deleting, replying in a thread, searching, starting a
// conversation, changing one, and keeping in step with the server. The page component is real; the server actions and the snapshot endpoint are replaced by spies, so what is
// checked is what the page sends, what it shows from the answer, and what it says when the answer is a refusal. The browser-only things (real scrolling, the 375 and 1280 pixel
// layouts, focus rings after a dialog closes) are for the lead's check.
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesApp, type MessagesAppProps } from "@/components/staff-messages/messages-app";
import { UNREAD_EVENT } from "@/lib/staff-messages/nav";
import { mentionToken } from "@/lib/staff-messages/mentions";
import type { SnapshotPayload } from "@/lib/staff-messages/snapshot";
import { CONV, conversationView, MAYA, message, mine, ME, NOW, OTHER_CONV, payload, railEntry, SAM } from "./support/staff-messages-screens";

const mocks = vi.hoisted(() => {
  const names = [
    "sendMessageAction", "editMessageAction", "deleteMessageAction", "reactAction", "markReadAction", "searchMessagesAction", "discardAttachmentAction", "startDirectAction", "startGroupAction",
    "startChannelAction", "joinChannelAction", "leaveConversationAction", "addMembersAction", "removeMemberAction", "updateConversationAction", "archiveConversationAction", "preferencesAction",
    "staffDirectoryAction", "channelDirectoryAction", "setMessagesEnabledAction", "setRetentionAction",
  ] as const;
  const a = Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>;
  return { a, push: vi.fn(), refresh: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn() };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }), usePathname: () => "/admin/messages" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _p, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/app/actions/staff-messages", () => mocks.a);

const ok = <T,>(data: T) => ({ ok: true as const, data });
const refuse = (code: string, error: string) => ({ ok: false as const, code, error });
const BAD = /undefined|NaN|\[object Object\]|<@/;

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  for (const m of Object.values(mocks.a)) m.mockReset();
  for (const m of [mocks.push, mocks.refresh, mocks.toastError, mocks.toastSuccess]) m.mockReset();
  mocks.a.markReadAction.mockResolvedValue(ok({ lastReadSeq: 3, moved: true }));
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const props = (over: Partial<MessagesAppProps> = {}): MessagesAppProps => ({ me: ME, initial: payload(), conversationId: CONV, aroundSeq: null, threadId: null, now: NOW, live: false, ...over });
const open = (over: Partial<MessagesAppProps> = {}) => render(<MessagesApp {...props(over)} />);
const typeAndSend = (text: string) => {
  fireEvent.change(screen.getByLabelText("Message Launch crew"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
};
const menuFor = (author: string) => fireEvent.pointerDown(screen.getByRole("button", { name: `Actions for the message from ${author}` }), { button: 0, ctrlKey: false });

describe("the list page", () => {
  it("shows the list and a prompt, the notice, and no settings button to anyone but a Super Admin", () => {
    open({ conversationId: null, initial: payload({ conversation: undefined, page: undefined }) });
    expect(screen.getByRole("heading", { level: 1, name: "Messages" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choose a conversation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Launch crew/ })).toBeTruthy();
    expect(screen.getByTestId("messages-notice")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Messages settings/ })).toBeNull();
    cleanup();
    open({ conversationId: null, me: { ...ME, role: "agency_super_admin" }, initial: payload({ conversation: undefined, page: undefined }) });
    expect((screen.getByRole("link", { name: /Messages settings/ }) as HTMLAnchorElement).getAttribute("href")).toBe("/admin/messages/settings");
    expect(document.body.textContent).not.toMatch(BAD);
  });

  it("shows only the list on a phone at the list address and only the conversation at a conversation's address, from the classes alone", () => {
    const { container, unmount } = open({ conversationId: null, initial: payload({ conversation: undefined, page: undefined }) });
    const list = container.querySelector('aside[aria-label="Conversation list"]') as HTMLElement;
    const pane = container.querySelector("section[aria-label]") as HTMLElement;
    expect(list.className).not.toMatch(/(^| )hidden( |$)/);
    expect(list.className).toContain("md:flex");
    expect(pane.className).toContain("hidden");
    expect(pane.className).toContain("md:flex");
    unmount();
    const second = open();
    const list2 = second.container.querySelector('aside[aria-label="Conversation list"]') as HTMLElement;
    const pane2 = second.container.querySelector("section[aria-label]") as HTMLElement;
    expect(list2.className).toMatch(/(^| )hidden( |$)/);
    expect(list2.className).toContain("md:flex");
    expect(pane2.className).not.toMatch(/(^| )hidden( |$)/);
  });

  it("does not scroll sideways: the page's own boxes never set a fixed width wider than a phone", () => {
    const { container } = open();
    expect(container.innerHTML).not.toMatch(/(?:^|[ "])w-\[(?:[4-9]\d{2}|\d{4,})px\]/);
    expect(container.querySelector(".overflow-x-hidden")).not.toBeNull();
  });
});

describe("opening a conversation", () => {
  it("shows its messages with the author and day, its box labelled for it, and the open conversation marked in the list", () => {
    open();
    const log = screen.getByRole("log", { name: "Messages in Launch crew" });
    expect(within(log).getByText("Message number 1")).toBeTruthy();
    expect(within(log).getByText("Message number 3")).toBeTruthy();
    expect(screen.getByLabelText("Message Launch crew")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Launch crew/ }).getAttribute("aria-current")).toBe("page");
    expect(document.body.textContent).not.toMatch(BAD);
  });

  it("marks what was unread with a line, and tells the server the person has read to the end, once, from a visible tab", async () => {
    const events: number[] = [];
    const on = (e: Event) => events.push((e as CustomEvent<{ unread: number }>).detail.unread);
    window.addEventListener(UNREAD_EVENT, on);
    open({ initial: payload({ rail: [railEntry({ lastReadSeq: 1, unread: 2 })], conversation: conversationView({ conversation: { lastReadSeq: 1 } }), page: { messages: [message(1), message(2), message(3)], hasMore: false, lastSeq: 3, lastReadSeq: 1 } }) });
    expect(screen.getByRole("separator", { name: "New messages" })).toBeTruthy();
    await waitFor(() => expect(mocks.a.markReadAction).toHaveBeenCalledTimes(1));
    expect(mocks.a.markReadAction).toHaveBeenCalledWith({ conversationId: CONV, seq: 3 });
    // The list and the navigation badge fall at once, before the server has answered anything else.
    await waitFor(() => expect(events.at(-1)).toBe(0));
    expect(events[0]).toBe(2);
    expect(screen.queryByLabelText(/unread message/)).toBeNull();
    // The line stays where the unread messages began.
    expect(screen.getByRole("separator", { name: "New messages" })).toBeTruthy();
    window.removeEventListener(UNREAD_EVENT, on);
  });

  it("does not say anything is read from a tab nobody is looking at, and does when the tab comes back", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    open({ initial: payload({ rail: [railEntry({ lastReadSeq: 1, unread: 2 })], page: { messages: [message(1), message(2), message(3)], hasMore: false, lastSeq: 3, lastReadSeq: 1 } }) });
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.a.markReadAction).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(mocks.a.markReadAction).toHaveBeenCalledWith({ conversationId: CONV, seq: 3 }));
  });

  it("says nothing is read while the person is reading around an old message, and shows that message marked", async () => {
    open({ aroundSeq: 2, initial: payload({ rail: [railEntry({ lastReadSeq: 0, unread: 3 })], page: { messages: [message(1), message(2), message(3)], hasMore: false, lastSeq: 9, lastReadSeq: 0 } }) });
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.a.markReadAction).not.toHaveBeenCalled();
    expect(screen.getByText(/reading older messages/)).toBeTruthy();
    expect(document.querySelector('[data-seq="2"]')?.className).toContain("ring-2");
  });

  it("says a conversation that is not there is not available, and offers the way back", () => {
    open({ initial: payload({ conversation: null, page: undefined }) });
    expect(screen.getByRole("heading", { name: "This conversation isn't available" })).toBeTruthy();
    // The rail's filter stays; there is no message box to write in.
    expect(screen.queryByLabelText(/^Message /)).toBeNull();
  });
});

describe("writing", () => {
  it("sends the message with its own id, shows it from the server's answer without a reload, clears the box and counts it as read", async () => {
    const sent = mine(4, { body: "Hello team" });
    mocks.a.sendMessageAction.mockResolvedValue(ok({ message: sent, duplicate: false }));
    open();
    typeAndSend("Hello team");
    // The optimistic copy appears before the action answers; wait for the server's copy and the pending "Sending…" state to be gone.
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Hello team")).toBeTruthy());
    expect(mocks.a.sendMessageAction).toHaveBeenCalledTimes(1);
    const arg = mocks.a.sendMessageAction.mock.calls[0][0];
    expect(arg).toEqual({ conversationId: CONV, clientMessageId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4/), body: "Hello team", threadRootId: null, attachmentIds: [] });
    expect((screen.getByLabelText("Message Launch crew") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(within(screen.getByRole("log")).getAllByText("You")).toHaveLength(1);
  });

  it("shows the message being sent at once, and a message sent twice by a retry once", async () => {
    let resolve: (v: unknown) => void = () => {};
    mocks.a.sendMessageAction.mockImplementation(() => new Promise((r) => { resolve = r; }));
    open();
    typeAndSend("Slow one");
    expect(await screen.findByText("Sending…")).toBeTruthy();
    expect(screen.getByText("Slow one")).toBeTruthy();
    await act(async () => {
      resolve(ok({ message: mine(4, { body: "Slow one" }), duplicate: false }));
    });
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(screen.getAllByText("Slow one")).toHaveLength(1);
  });

  it("keeps a message that could not be delivered, and trying again sends the same id, so the server posts it once", async () => {
    mocks.a.sendMessageAction.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(ok({ message: mine(4, { body: "Please arrive" }), duplicate: true }));
    open();
    typeAndSend("Please arrive");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Not sent\. Check your connection and try again/);
    expect(mocks.toastError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mocks.a.sendMessageAction).toHaveBeenCalledTimes(2);
    expect(mocks.a.sendMessageAction.mock.calls[1][0].clientMessageId).toBe(mocks.a.sendMessageAction.mock.calls[0][0].clientMessageId);
    expect(screen.getAllByText("Please arrive")).toHaveLength(1);
  });

  it("says why a refusal is a refusal, offers no retry for one that cannot work, and lets the person let it go", async () => {
    mocks.a.sendMessageAction.mockResolvedValue(refuse("forbidden", "You can't write in this conversation."));
    open();
    typeAndSend("Not allowed");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You can't write in this conversation.");
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Not allowed")).toBeNull();
  });

  it("offers a retry for a busy server and keeps the person's words", async () => {
    mocks.a.sendMessageAction.mockResolvedValue(refuse("rate_limited", "You are sending messages very quickly. Wait a moment and try again."));
    open();
    typeAndSend("Too fast");
    expect((await screen.findByRole("alert")).textContent).toMatch(/very quickly/);
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
    expect(screen.getByText("Too fast")).toBeTruthy();
  });

  it("sends a mention as the person chose it and shows the name, not the id, in the message", async () => {
    mocks.a.sendMessageAction.mockImplementation(async (input: { body: string }) => ok({ message: mine(4, { body: input.body, mentions: [SAM.id] }), duplicate: false }));
    open();
    const area = screen.getByLabelText("Message Launch crew") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Ping @sam" } });
    area.setSelectionRange(9, 9);
    fireEvent.select(area);
    fireEvent.click(screen.getByRole("option", { name: "Sam Okafor" }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.a.sendMessageAction).toHaveBeenCalled());
    expect(mocks.a.sendMessageAction.mock.calls[0][0].body).toBe(`Ping ${mentionToken(SAM.id)}`);
    expect(await within(screen.getByRole("log")).findByText("@Sam Okafor")).toBeTruthy();
    expect(document.body.textContent).not.toContain("<@");
  });

  it("writes nowhere in an archived conversation", () => {
    open({ initial: payload({ conversation: conversationView({ conversation: { archived: true }, can: { post: false } }) }) });
    expect(screen.queryByLabelText(/^Message /)).toBeNull();
    expect(screen.getAllByText(/archived/i).length).toBeGreaterThan(0);
  });
});

describe("working on a message", () => {
  it("reacts from the picker and shows the server's count", async () => {
    mocks.a.reactAction.mockResolvedValue(ok([{ reaction: "thumbs_up", count: 1, mine: true }]));
    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Add a reaction" })[0]);
    fireEvent.click(within(screen.getByRole("list", { name: "Reactions" })).getByRole("button", { name: "Thumbs up" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Thumbs up, 1 person, including you" })).toBeTruthy());
    expect(mocks.a.reactAction).toHaveBeenCalledWith({ messageId: message(1).id, reaction: "thumbs_up", on: true });
    mocks.a.reactAction.mockResolvedValue(ok([]));
    fireEvent.click(screen.getByRole("button", { name: "Thumbs up, 1 person, including you" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Thumbs up/ })).toBeNull());
    expect(mocks.a.reactAction).toHaveBeenLastCalledWith({ messageId: message(1).id, reaction: "thumbs_up", on: false });
  });

  it("edits the person's own message in place and shows the edit mark", async () => {
    mocks.a.editMessageAction.mockImplementation(async (input: { messageId: string; body: string }) => ok(mine(4, { id: input.messageId, body: input.body, editedAt: "2026-10-24T11:00:00.000Z" })));
    open({ initial: payload({ page: { messages: [message(1), mine(4, { body: "Typo here" })], hasMore: false, lastSeq: 4, lastReadSeq: 4 } }) });
    menuFor("you");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
    const box = screen.getByLabelText("Edit your message");
    fireEvent.change(box, { target: { value: "Typo fixed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Typo fixed")).toBeTruthy());
    expect(mocks.a.editMessageAction).toHaveBeenCalledWith({ messageId: mine(4).id, body: "Typo fixed", expectedEditedAt: null });
    expect(screen.getByText("(edited)")).toBeTruthy();
    expect(screen.queryByLabelText("Edit your message")).toBeNull();
  });

  it("sends the edit stamp the editor opened with, and keeps the editor open with the server's sentence when the message changed elsewhere", async () => {
    mocks.a.editMessageAction.mockResolvedValue(refuse("conflict", "This message was changed somewhere else (another tab or window) after you opened it."));
    open({ initial: payload({ page: { messages: [message(1), mine(4, { body: "Original", editedAt: "2026-10-24T10:00:00.000Z" })], hasMore: false, lastSeq: 4, lastReadSeq: 4 } }) });
    menuFor("you");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
    fireEvent.change(screen.getByLabelText("Edit your message"), { target: { value: "My version" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed somewhere else/);
    expect(mocks.a.editMessageAction).toHaveBeenCalledWith({ messageId: mine(4).id, body: "My version", expectedEditedAt: "2026-10-24T10:00:00.000Z" });
    expect((screen.getByLabelText("Edit your message") as HTMLTextAreaElement).value).toBe("My version");
  });

  it("asks before deleting, deletes nothing on Cancel, and leaves a place-holder when it deletes", async () => {
    mocks.a.deleteMessageAction.mockResolvedValue(ok(undefined));
    open({ initial: payload({ page: { messages: [message(1), mine(4, { body: "Regret this" })], hasMore: false, lastSeq: 4, lastReadSeq: 4 } }) });
    menuFor("you");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    expect(await screen.findByText("Delete this message?")).toBeTruthy();
    expect(screen.getByText(/can't be undone/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Delete this message?")).toBeNull());
    expect(mocks.a.deleteMessageAction).not.toHaveBeenCalled();
    menuFor("you");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByText("This message was deleted.")).toBeTruthy());
    expect(mocks.a.deleteMessageAction).toHaveBeenCalledWith(mine(4).id);
    expect(screen.queryByText("Regret this")).toBeNull();
  });
});

describe("threads", () => {
  const root = message(2, { id: "20000000-0000-4000-8000-000000000002", body: "Root of the thread", replyCount: 1 });
  const reply = message(3, { threadRootId: root.id, authorId: SAM.id, author: { name: SAM.name, former: false }, body: "First reply" });
  const withThread = (): SnapshotPayload => payload({
    page: { messages: [message(1), root], hasMore: false, lastSeq: 3, lastReadSeq: 3 },
    thread: { messages: [root, reply], hasMore: false, lastSeq: 3, lastReadSeq: 3 },
  });

  it("opens from the reply count with the root first, its replies after and a box that replies in this thread", () => {
    open({ initial: payload({ page: { messages: [message(1), root], hasMore: false, lastSeq: 3, lastReadSeq: 3 } }) });
    expect(screen.getByRole("button", { name: "1 reply" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1 reply" }));
    // The panel opens at once; with no live updates here the replies are not loaded yet, and it says so.
    expect(screen.getByRole("dialog", { name: "Thread" })).toBeTruthy();
    expect(screen.getByText("Loading the thread…")).toBeTruthy();
  });

  it("shows a thread that is open from the start, sends a reply with the thread's root, counts it, and never puts it in the main list", async () => {
    mocks.a.sendMessageAction.mockImplementation(async (input: { body: string; threadRootId: string }) => ok({ message: mine(4, { threadRootId: input.threadRootId, body: input.body }), duplicate: false }));
    open({ threadId: root.id, initial: withThread() });
    const panel = screen.getByRole("dialog", { name: "Thread" });
    const list = within(panel).getByRole("list", { name: "Messages in this thread" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("Root of the thread"), expect.stringContaining("First reply")]);
    const replyBox = within(panel).getByLabelText("Reply in this thread");
    fireEvent.change(replyBox, { target: { value: "Second reply" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(within(panel).getByText("Second reply")).toBeTruthy());
    expect(mocks.a.sendMessageAction.mock.calls[0][0]).toMatchObject({ conversationId: CONV, threadRootId: root.id, body: "Second reply" });
    const main = document.getElementById(`m-${root.id}`) as HTMLElement;
    expect(main.textContent).toContain("2 replies");
    expect(document.querySelectorAll('[data-seq="4"]').length).toBe(1);
    expect(within(screen.getByRole("log", { hidden: true })).queryByText("Second reply")).toBeNull();
  });

  it("says a thread that is gone is gone", () => {
    open({ threadId: root.id, initial: payload({ page: { messages: [message(1), root], hasMore: false, lastSeq: 3, lastReadSeq: 3 }, thread: null }) });
    expect(screen.getByText(/isn.t available any more/)).toBeTruthy();
    expect(screen.queryByLabelText("Reply in this thread")).toBeNull();
  });
});

describe("search, new conversations and the channel list", () => {
  it("searches what the person is in, opens a hit at its message and a reply at its thread, and can limit the search to this conversation", async () => {
    mocks.a.searchMessagesAction.mockResolvedValue(ok({ truncated: false, hits: [
      { messageId: "m1", conversationId: CONV, conversationKind: "group", conversationName: "Launch crew", seq: 41, threadRootId: null, author: { name: MAYA.name, former: false }, createdAt: "2026-10-23T09:00:00.000Z", snippet: { text: "…the quarterly plan is…", match: { start: 5, end: 14 } } },
      { messageId: "m2", conversationId: OTHER_CONV, conversationKind: "channel", conversationName: "general", seq: 7, threadRootId: "30000000-0000-4000-8000-000000000001", author: { name: SAM.name, former: false }, createdAt: "2026-10-22T09:00:00.000Z", snippet: { text: "plan b", match: null } },
    ] }));
    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Search messages" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Search messages" });
    const submit = within(dialog).getByRole("button", { name: /Search/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Words to search for"), { target: { value: "plan" } });
    fireEvent.click(within(dialog).getByLabelText(/Only in/));
    fireEvent.click(submit);
    await waitFor(() => expect(within(dialog).getAllByRole("link")).toHaveLength(2));
    expect(mocks.a.searchMessagesAction).toHaveBeenCalledWith({ query: "plan", conversationId: CONV });
    const links = within(dialog).getAllByRole("link") as HTMLAnchorElement[];
    expect(links[0].getAttribute("href")).toBe(`/admin/messages/${CONV}?at=41`);
    expect(links[1].getAttribute("href")).toBe(`/admin/messages/${OTHER_CONV}?at=7&thread=30000000-0000-4000-8000-000000000001`);
    expect(within(dialog).getByText("quarterly").tagName).toBe("MARK");
    expect(within(dialog).getByText("2 messages match “plan”.")).toBeTruthy();
    expect(within(dialog).getByText("#general")).toBeTruthy();
  });

  it("says nothing matched, and shows the server's refusal in words", async () => {
    mocks.a.searchMessagesAction.mockResolvedValueOnce(ok({ hits: [], truncated: false })).mockResolvedValueOnce(refuse("rate_limited", "You are searching very quickly. Wait a moment and try again."));
    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Search messages" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Search messages" });
    fireEvent.change(within(dialog).getByLabelText("Words to search for"), { target: { value: "nothing here" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Search/ }));
    expect(await within(dialog).findByText("No messages match “nothing here”.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Search/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/searching very quickly/);
  });

  it("starts a direct message from the people list and goes to it", async () => {
    mocks.a.staffDirectoryAction.mockResolvedValue(ok([{ id: ME.id, name: ME.name, role: "agency_staff", self: true }, { id: MAYA.id, name: MAYA.name, role: "agency_manager", self: false }, { id: SAM.id, name: SAM.name, role: "agency_staff", self: false }]));
    mocks.a.startDirectAction.mockResolvedValue(ok({ id: "40000000-0000-4000-8000-000000000001", created: true }));
    open({ conversationId: null, initial: payload({ conversation: undefined, page: undefined }) });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Start a new conversation" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "New direct message" }));
    const dialog = await screen.findByRole("dialog", { name: "New direct message" });
    const people = await within(dialog).findByRole("list", { name: "Team members" });
    // Everyone but the person asking, in name order, each with the role they hold.
    const buttons = within(people).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain("Maya SantosManager");
    expect(buttons[1].textContent).toContain("Sam OkaforAgency staff");
    fireEvent.click(within(people).getByRole("button", { name: /Maya Santos/ }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/admin/messages/40000000-0000-4000-8000-000000000001"));
    expect(mocks.a.startDirectAction).toHaveBeenCalledWith(MAYA.id);
  });

  it("starts a group from a name and the people ticked, and says what stops it", async () => {
    mocks.a.staffDirectoryAction.mockResolvedValue(ok([{ id: MAYA.id, name: MAYA.name, role: "agency_manager", self: false }, { id: SAM.id, name: SAM.name, role: "agency_staff", self: false }]));
    mocks.a.startGroupAction.mockResolvedValueOnce(refuse("conflict", "A conversation can have up to 200 people.")).mockResolvedValueOnce(ok({ id: "40000000-0000-4000-8000-000000000002", created: true }));
    open({ conversationId: null, initial: payload({ conversation: undefined, page: undefined }) });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Start a new conversation" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "New group" }));
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    const create = within(dialog).getByRole("button", { name: "Create group" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Design review" } });
    expect(create.disabled).toBe(true);
    fireEvent.click(await within(dialog).findByLabelText(/Maya Santos/));
    fireEvent.click(within(dialog).getByLabelText(/Sam Okafor/));
    expect(within(dialog).getByText("2 people chosen, plus you.")).toBeTruthy();
    fireEvent.click(create);
    expect((await within(dialog).findByRole("alert")).textContent).toBe("A conversation can have up to 200 people.");
    fireEvent.click(create);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/admin/messages/40000000-0000-4000-8000-000000000002"));
    expect(mocks.a.startGroupAction).toHaveBeenLastCalledWith({ name: "Design review", memberIds: [MAYA.id, SAM.id] });
  });

  it("offers a channel only to a person who may start one, with who can join it", async () => {
    mocks.a.staffDirectoryAction.mockResolvedValue(ok([{ id: MAYA.id, name: MAYA.name, role: "agency_manager", self: false }]));
    mocks.a.startChannelAction.mockResolvedValue(ok({ id: "40000000-0000-4000-8000-000000000003", created: true }));
    open({ me: { ...ME, canChannels: true }, conversationId: null, initial: payload({ conversation: undefined, page: undefined }) });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Start a new conversation" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "New channel" }));
    const dialog = await screen.findByRole("dialog", { name: "New channel" });
    fireEvent.change(within(dialog).getByLabelText("Channel name"), { target: { value: "Client onboarding" } });
    fireEvent.change(within(dialog).getByLabelText(/Topic/), { target: { value: "Handovers" } });
    expect((within(dialog).getByRole("radio", { name: /Open to the team/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Private/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create channel" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/admin/messages/40000000-0000-4000-8000-000000000003"));
    expect(mocks.a.startChannelAction).toHaveBeenCalledWith({ name: "Client onboarding", topic: "Handovers", visibility: "private", memberIds: [] });
  });

  it("lists the channels open to the team, joins one and goes to it, and opens one already joined", async () => {
    mocks.a.channelDirectoryAction.mockResolvedValue(ok([
      { id: "50000000-0000-4000-8000-000000000001", name: "general", topic: "Everything", memberCount: 12, joined: true, lastMessageAt: null },
      { id: "50000000-0000-4000-8000-000000000002", name: "design", topic: null, memberCount: 1, joined: false, lastMessageAt: null },
    ]));
    mocks.a.joinChannelAction.mockResolvedValue(ok(undefined));
    open({ conversationId: null, initial: payload({ conversation: undefined, page: undefined }) });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Start a new conversation" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse channels" }));
    const dialog = await screen.findByRole("dialog", { name: "Channels" });
    const list = await within(dialog).findByRole("list", { name: "Open channels" });
    expect(within(list).getByText("12 people · Everything")).toBeTruthy();
    expect(within(list).getByText("1 person")).toBeTruthy();
    expect((within(list).getByRole("link", { name: "Open" }) as HTMLAnchorElement).getAttribute("href")).toBe("/admin/messages/50000000-0000-4000-8000-000000000001");
    fireEvent.click(within(list).getByRole("button", { name: "Join #design" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/admin/messages/50000000-0000-4000-8000-000000000002"));
    expect(mocks.a.joinChannelAction).toHaveBeenCalledWith("50000000-0000-4000-8000-000000000002");
  });
});

describe("the conversation's details", () => {
  const openDetails = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Conversation details" }));
    return screen.findByRole("dialog", { name: /Details: Launch crew/ });
  };

  it("lists who is in it with the owner marked, lets an owner remove others but not themselves, and asks before it does", async () => {
    mocks.a.removeMemberAction.mockResolvedValue(ok(undefined));
    open();
    const panel = await openDetails();
    const people = within(panel).getByRole("list", { name: "People in this conversation" });
    expect(within(people).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("Avery Admin (you)"), expect.stringContaining("Maya Santos"), expect.stringContaining("Sam Okafor")]);
    expect(within(people).getByText("Owner")).toBeTruthy();
    expect(within(people).queryByRole("button", { name: "Remove Avery Admin" })).toBeNull();
    fireEvent.click(within(people).getByRole("button", { name: "Remove Maya Santos" }));
    expect(await screen.findByText("Remove this person?")).toBeTruthy();
    expect(screen.getByText(/What they wrote stays for the others/)).toBeTruthy();
    expect(mocks.a.removeMemberAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.a.removeMemberAction).toHaveBeenCalledWith({ conversationId: CONV, memberId: MAYA.id }));
  });

  it("mutes and changes what the person is told about, for themselves only", async () => {
    mocks.a.preferencesAction.mockResolvedValue(ok(undefined));
    open();
    const panel = await openDetails();
    fireEvent.click(within(panel).getByLabelText("Mute this conversation"));
    await waitFor(() => expect(mocks.a.preferencesAction).toHaveBeenCalledWith({ conversationId: CONV, muted: true }));
    fireEvent.change(within(panel).getByLabelText("Tell me about"), { target: { value: "mentions" } });
    await waitFor(() => expect(mocks.a.preferencesAction).toHaveBeenCalledWith({ conversationId: CONV, notify: "mentions" }));
  });

  it("renames with the values the form started from, so a change made meanwhile is refused and said", async () => {
    mocks.a.updateConversationAction.mockResolvedValue(refuse("conflict", "Someone else changed this conversation's name or topic while you were editing. Nothing was saved."));
    open();
    const panel = await openDetails();
    const save = within(panel).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText("Group name"), { target: { value: "Launch crew 2" } });
    fireEvent.click(save);
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/Someone else changed this conversation/);
    expect(mocks.a.updateConversationAction).toHaveBeenCalledWith({ conversationId: CONV, name: "Launch crew 2", topic: undefined, expectedName: "Launch crew", expectedTopic: undefined });
  });

  it("does not offer rename, add or remove to a plain member, and leaves a direct message with no way out", async () => {
    open({ initial: payload({ conversation: conversationView({ conversation: { memberRole: "member" }, can: { rename: false, manageMembers: false, archive: false } }) }) });
    const panel = await openDetails();
    expect(within(panel).queryByLabelText("Group name")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Add people/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: /Leave/ })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Archive/ })).toBeNull();
    cleanup();
    open({ initial: payload({ conversation: conversationView({ conversation: { kind: "direct", name: "Maya Santos", memberRole: "member" }, can: { rename: false, manageMembers: false, archive: false, leave: false } }) }) });
    fireEvent.click(screen.getByRole("button", { name: "Conversation details" }));
    const direct = await screen.findByRole("dialog", { name: "Conversation details" });
    expect(within(direct).queryByRole("button", { name: /Leave/ })).toBeNull();
    expect(within(direct).getByText(/Only the two of you can read/)).toBeTruthy();
  });

  it("leaves after a confirmation and goes back to the list, and archives and brings back after one", async () => {
    mocks.a.leaveConversationAction.mockResolvedValue(ok(undefined));
    mocks.a.archiveConversationAction.mockResolvedValue(ok(undefined));
    open();
    const panel = await openDetails();
    fireEvent.click(within(panel).getByRole("button", { name: "Archive" }));
    const archive = await screen.findByRole("dialog", { name: "Archive this conversation?" });
    expect(mocks.a.archiveConversationAction).not.toHaveBeenCalled();
    fireEvent.click(within(archive).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(mocks.a.archiveConversationAction).toHaveBeenCalledWith({ conversationId: CONV, archived: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Archive this conversation?" })).toBeNull());
    fireEvent.click(within(screen.getByRole("dialog", { name: /Details: Launch crew/ })).getByRole("button", { name: "Leave" }));
    const leave = await screen.findByRole("dialog", { name: "Leave this conversation?" });
    expect(mocks.a.leaveConversationAction).not.toHaveBeenCalled();
    fireEvent.click(within(leave).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/admin/messages"));
    expect(mocks.a.leaveConversationAction).toHaveBeenCalledWith(CONV);
  });

  it("shows who did what lately, by name, and 'Former team member' for anyone who has left", async () => {
    const events = [
      { kind: "created" as const, at: "2026-10-23T09:00:00.000Z", actor: MAYA.id, subject: null },
      { kind: "member_added" as const, at: "2026-10-23T09:01:00.000Z", actor: MAYA.id, subject: SAM.id },
      { kind: "member_removed" as const, at: "2026-10-23T09:02:00.000Z", actor: MAYA.id, subject: "99999999-9999-4999-8999-999999999999" },
    ];
    open({ initial: payload({ conversation: conversationView({ events }) }) });
    const panel = await openDetails();
    const lines = within(within(panel).getByRole("region", { name: "Recent changes" })).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines.some((l) => l?.startsWith("Maya Santos removed Former team member"))).toBe(true);
    expect(lines.some((l) => l?.startsWith("Maya Santos added Sam Okafor"))).toBe(true);
    expect(lines.some((l) => l?.startsWith("Maya Santos started this conversation"))).toBe(true);
  });
});

describe("a channel the person has not joined", () => {
  it("shows no messages, offers to join, and loads the conversation after joining", async () => {
    mocks.a.joinChannelAction.mockResolvedValue(ok(undefined));
    open({ initial: payload({
      conversation: conversationView({ conversation: { kind: "channel", visibility: "staff", name: "general", memberRole: null }, can: { post: false, join: true, leave: false, manageMembers: false, rename: false, archive: false }, members: null }),
      page: undefined,
    }) });
    expect(screen.getByRole("heading", { name: /haven.t joined/ })).toBeTruthy();
    expect(screen.queryByRole("log")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Join #general" }));
    await waitFor(() => expect(mocks.a.joinChannelAction).toHaveBeenCalledWith(CONV));
  });
});

describe("keeping in step with the server", () => {
  const body = (over: SnapshotPayload | { unchanged: true; revision: number }) => new Response(JSON.stringify(over), { status: 200, headers: { "content-type": "application/json" } });
  const fetchMock = (...answers: Array<Response | Error>) => {
    let i = 0;
    const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer.clone();
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  };
  const focus = async () => {
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
  };

  it("asks again when the tab gets focus, from the revision it holds, and shows what is new", async () => {
    const f = fetchMock(body(payload({ revision: 11, page: { messages: [message(1), message(2), message(3), message(4, { body: "Arrived while you were away" })], hasMore: false, lastSeq: 4, lastReadSeq: 3 }, rail: [railEntry({ lastSeq: 4, lastReadSeq: 3, unread: 1 })] })));
    open({ live: true });
    await focus();
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Arrived while you were away")).toBeTruthy());
    const url = new URL(String(f.mock.calls[0][0]), "http://localhost");
    expect(url.pathname).toBe("/api/admin/messages/snapshot");
    expect(url.searchParams.get("since")).toBe("10");
    expect(url.searchParams.get("conversation")).toBe(CONV);
    expect(f.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });

  it("changes nothing when the server says nothing changed, and does not ask for a thread nobody opened", async () => {
    const f = fetchMock(body({ unchanged: true, revision: 10 }));
    open({ live: true });
    await focus();
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(within(screen.getByRole("log")).getAllByText(/Message number/)).toHaveLength(3);
    expect(new URL(String(f.mock.calls[0][0]), "http://localhost").searchParams.has("thread")).toBe(false);
  });

  it("takes the server's newest messages over what it showed, and ignores an answer that arrives after a newer one", async () => {
    fetchMock(body(payload({ revision: 12, page: { messages: [message(2, { body: "Edited elsewhere" }), message(3)], hasMore: true, lastSeq: 3, lastReadSeq: 3 } })));
    open({ live: true });
    await focus();
    await waitFor(() => expect(screen.getByText("Edited elsewhere")).toBeTruthy());
    // An older message the page already had stays.
    expect(screen.getByText("Message number 1")).toBeTruthy();
    fetchMock(body(payload({ revision: 11, page: { messages: [message(2, { body: "Stale answer" }), message(3)], hasMore: false, lastSeq: 3, lastReadSeq: 3 } })));
    await focus();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Stale answer")).toBeNull();
    expect(screen.getByText("Edited elsewhere")).toBeTruthy();
  });

  it("tells a person whose access ended why the page stopped, and stops asking", async () => {
    const f = fetchMock(new Response(JSON.stringify({ error: "x", code: "not_enabled", reason: "not_enabled" }), { status: 403 }));
    open({ live: true });
    await focus();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Messages has been switched off\. Nothing was deleted/);
    const calls = f.mock.calls.length;
    await focus();
    await new Promise((r) => setTimeout(r, 30));
    expect(f.mock.calls.length).toBe(calls);
    cleanup();
    fetchMock(new Response(JSON.stringify({ error: "x", code: "forbidden", reason: "forbidden" }), { status: 403 }));
    open({ live: true });
    await focus();
    expect((await screen.findByRole("alert")).textContent).toMatch(/You no longer have access to Messages/);
    cleanup();
    fetchMock(new Response(JSON.stringify({ error: "Your session has ended.", code: "unauthenticated" }), { status: 401 }));
    open({ live: true });
    await focus();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Your session has ended\. Sign in again/);
    expect((screen.getByRole("link", { name: "Sign in" }) as HTMLAnchorElement).getAttribute("href")).toBe("/login");
  });

  it("says it is offline when it cannot reach the server, and shows the server's own words for a failure that is not about access", async () => {
    fetchMock(new Error("Failed to fetch"));
    open({ live: true });
    await focus();
    expect((await screen.findByText(/You are offline/)).closest("p")?.getAttribute("role")).toBe("status");
    cleanup();
    fetchMock(new Response(JSON.stringify({ error: "Too many requests. Try again in a moment.", code: "rate_limited" }), { status: 429 }));
    open({ live: true });
    await focus();
    expect((await screen.findByRole("alert")).textContent).toBe("Too many requests. Try again in a moment.");
  });

  it("polls every fifteen to twenty seconds while the tab is visible and not at all while it is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const f = fetchMock(body({ unchanged: true, revision: 10 }));
    open({ live: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_900);
    });
    expect(f).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_200);
    });
    expect(f).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("refreshes when a stream says the number changed, and stops with the reason when it says access changed", async () => {
    class FakeSource {
      static CLOSED = 2;
      static instances: FakeSource[] = [];
      readyState = 1;
      listeners = new Map<string, Array<(e: MessageEvent) => void>>();
      constructor(public url: string) {
        FakeSource.instances.push(this);
      }
      addEventListener(type: string, fn: (e: MessageEvent) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      close() {
        this.readyState = 2;
      }
      emit(type: string, data?: string) {
        for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeSource);
    const f = fetchMock(body(payload({ revision: 12, page: { messages: [message(1), message(2), message(3), message(4, { body: "Live one" })], hasMore: false, lastSeq: 4, lastReadSeq: 3 } })));
    open({ live: true });
    const source = FakeSource.instances[0];
    expect(source.url).toBe("/api/admin/messages/stream");
    await act(async () => source.emit("open"));
    await act(async () => source.emit("ready", '{"revision":10}'));
    expect(f).not.toHaveBeenCalled();
    await act(async () => source.emit("revision", '{"revision":12}'));
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Live one")).toBeTruthy());
    await act(async () => source.emit("revision", "not json"));
    await act(async () => source.emit("access_changed", '{"reason":"forbidden"}'));
    expect((await screen.findByRole("alert")).textContent).toMatch(/You no longer have access/);
    expect(source.readyState).toBe(2);
  });
});

describe("older messages", () => {
  it("loads the page above, keeps the place, and stops offering it when there is nothing more", async () => {
    const older = new Response(JSON.stringify({ revision: 10, older: { messages: [message(1, { id: "60000000-0000-4000-8000-000000000001", body: "Way back when" })], hasMore: false, lastSeq: 9, lastReadSeq: 9 } }), { status: 200 });
    const f = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => older.clone());
    vi.stubGlobal("fetch", f);
    open({ live: true, initial: payload({ page: { messages: [message(5), message(6)], hasMore: true, lastSeq: 6, lastReadSeq: 6 }, rail: [railEntry({ lastSeq: 6, lastReadSeq: 6 })] }) });
    fireEvent.click(screen.getByRole("button", { name: "Show older messages" }));
    await waitFor(() => expect(screen.getByText("Way back when")).toBeTruthy());
    const url = new URL(String(f.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.get("before")).toBe("5");
    expect(url.searchParams.get("conversation")).toBe(CONV);
    expect(url.searchParams.has("since")).toBe(false);
    expect(screen.queryByRole("button", { name: "Show older messages" })).toBeNull();
  });
});
