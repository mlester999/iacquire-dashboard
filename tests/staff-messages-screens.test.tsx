// @vitest-environment jsdom
// The Messages screens as a person meets them, piece by piece: the notice, the honest empty states, the list of conversations, one message, the message box, and the
// conversation with its days, its unread marker and its messages being sent. What is drawn, what is offered, what is sent to the server, in the components themselves with the
// server actions replaced by spies. The server's rules are in the other staff-messages tests; the browser-only things (layout at 375 and 1280 pixels, focus rings, light and
// dark, scrolling) are for the lead's check.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NoticeBanner } from "@/components/staff-messages/notice-banner";
import { MessagesUnavailable } from "@/components/staff-messages/unavailable";
import { Rail } from "@/components/staff-messages/rail";
import { MessageRow, type MessageRowProps } from "@/components/staff-messages/message-row";
import { Composer } from "@/components/staff-messages/composer";
import { ConversationPane, type PaneActions } from "@/components/staff-messages/conversation-pane";
import { STAFF_MESSAGES_NOTICE_LINES, STAFF_MESSAGES_NOTICE_STATUS, STAFF_MESSAGES_NOTICE_VERSION } from "@/lib/staff-messages/notice";
import { MAX_BODY_CHARS } from "@/lib/staff-messages/limits";
import { mentionToken } from "@/lib/staff-messages/mentions";
import type { PendingMessage } from "@/lib/staff-messages/composer";
import { CONV, conversationView, MAYA, members, message, mine, ME, NOW, nextId, pdfFile, railEntry, SAM } from "./support/staff-messages-screens";

const mocks = vi.hoisted(() => ({ discard: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }), usePathname: () => "/admin/messages" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _p, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/app/actions/staff-messages", () => ({ discardAttachmentAction: mocks.discard }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  mocks.discard.mockReset().mockResolvedValue({ ok: true, data: undefined });
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  vi.unstubAllGlobals();
});
afterEach(cleanup);

const BAD = /undefined|NaN|\[object Object\]|<@/;
/** The pointer of a mouse and keyboard (Enter sends) or of a touch screen (Enter starts a line). */
const pointer = (fine: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: fine && query.includes("pointer: fine"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
};

describe("the notice", () => {
  it("is labelled a draft for counsel, says what the product does and does not claim, and starts closed", () => {
    render(<NoticeBanner />);
    const box = screen.getByTestId("messages-notice") as HTMLDetailsElement;
    expect(box.open).toBe(false);
    expect(within(box).getByText("Draft")).toBeTruthy();
    expect(within(box).getByText(STAFF_MESSAGES_NOTICE_STATUS)).toBeTruthy();
    for (const line of STAFF_MESSAGES_NOTICE_LINES) expect(within(box).getByText(line)).toBeTruthy();
    expect(within(box).getByText(new RegExp(STAFF_MESSAGES_NOTICE_VERSION))).toBeTruthy();
    expect(box.textContent).toMatch(/not by encryption/);
    expect(box.textContent).not.toMatch(/legal(ly)? (binding|compliant)|consent/i);
  });
});

describe("when there is nothing to show", () => {
  it("says it is switched off, and gives a Super Admin the way to the switch and nobody else", () => {
    const { rerender } = render(<MessagesUnavailable reason="off" superAdmin={false} />);
    expect(screen.getByRole("heading", { name: "Messages is not switched on" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /settings/i })).toBeNull();
    rerender(<MessagesUnavailable reason="off" superAdmin />);
    expect((screen.getByRole("link", { name: "Open Messages settings" }) as HTMLAnchorElement).getAttribute("href")).toBe("/admin/messages/settings");
    expect(screen.getByText(/Nothing has been deleted/)).toBeTruthy();
  });

  it("says a person may not use it, and that there is no agency workspace, in plain words", () => {
    const { rerender } = render(<MessagesUnavailable reason="denied" superAdmin={false} />);
    expect(screen.getByRole("heading", { name: "You can't use Messages" })).toBeTruthy();
    expect(screen.getByText(/ask a Super Admin/i)).toBeTruthy();
    rerender(<MessagesUnavailable reason="no_agency" superAdmin />);
    expect(screen.getByRole("heading", { name: /nowhere to keep messages/ })).toBeTruthy();
  });
});

describe("the list of conversations", () => {
  const entries = [
    railEntry({ id: "d1", kind: "direct", name: "Maya Santos", peer: { id: MAYA.id, name: "Maya Santos", former: false }, unread: 2, lastSeq: 5, lastReadSeq: 3 }),
    railEntry({ id: "g1", name: "Launch crew", muted: true, unread: 120, lastSeq: 130, lastReadSeq: 10 }),
    railEntry({ id: "c1", kind: "channel", visibility: "staff", name: "general", lastMessageAt: null }),
    railEntry({ id: "c2", kind: "channel", visibility: "private", name: "finance", archived: true }),
    railEntry({ id: "d2", kind: "direct", name: "Former team member", peer: { id: SAM.id, name: "Former team member", former: true } }),
  ];
  const props = { entries, activeId: "g1", now: NOW, canChannels: false, onNew: vi.fn(), onBrowse: vi.fn(), onSearch: vi.fn() };

  it("groups conversations under their own headings, links each to its address, marks the open one and names a channel with a #", () => {
    render(<Rail {...props} />);
    for (const name of ["Direct messages", "Groups", "Channels", "Archived"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    const links = within(screen.getByRole("navigation", { name: "Conversations" })).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/admin/messages/d1", "/admin/messages/d2", "/admin/messages/g1", "/admin/messages/c1", "/admin/messages/c2"]);
    expect(screen.getByRole("link", { name: /#general/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /#finance/ })).toBeTruthy();
    const open = screen.getByRole("link", { name: /Launch crew/ });
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Maya Santos/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText(/Former team member · /)).toBeTruthy();
    expect(screen.getByText("No messages yet")).toBeTruthy();
  });

  it("shows what is unread as a number a screen reader can say, 99+ past 99, and says when a conversation is muted", () => {
    render(<Rail {...props} />);
    expect(screen.getByLabelText("2 unread messages")).toBeTruthy();
    const many = screen.getByLabelText("More than 99 unread messages, muted");
    expect(many.textContent).toBe("99+");
    expect(screen.getAllByLabelText("Muted").length).toBe(1);
    expect(document.body.textContent).not.toMatch(BAD);
  });

  it("filters to what is unread (counting conversations that are not muted or archived) and by what is typed", () => {
    render(<Rail {...props} />);
    const unread = screen.getByRole("button", { name: /Unread/ });
    expect(unread.textContent).toBe("Unread (1)");
    fireEvent.click(unread);
    expect(unread.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("link", { name: /#general/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Maya Santos/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Filter conversations"), { target: { value: "#gen" } });
    expect(screen.getAllByRole("link")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Filter conversations"), { target: { value: "zzz" } });
    expect(screen.getByRole("status").textContent).toBe("No conversation matches that.");
  });

  it("says plainly when there is nothing yet, and when nothing is unread", () => {
    const { rerender } = render(<Rail {...props} entries={[]} />);
    expect(screen.getByRole("status").textContent).toMatch(/No conversations yet/);
    rerender(<Rail {...props} entries={[railEntry({ id: "x", unread: 0 })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Unread/ }));
    expect(screen.getByRole("status").textContent).toBe("Nothing unread.");
  });

  it("offers a new channel only to a person who may start one, and always search and browse", () => {
    const onNew = vi.fn();
    const onBrowse = vi.fn();
    const onSearch = vi.fn();
    render(<Rail {...props} onNew={onNew} onBrowse={onBrowse} onSearch={onSearch} />);
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Start a new conversation" }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("menuitem", { name: "New direct message" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "New group" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "New channel" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse channels" }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it("offers a new channel to a person who may start one", () => {
    const onNew = vi.fn();
    render(<Rail {...props} canChannels onNew={onNew} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Start a new conversation" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "New channel" }));
    expect(onNew).toHaveBeenCalledWith("channel");
  });

  it("keeps a very long list and a very long filter cheap", () => {
    const many = Array.from({ length: 500 }, (_, i) => railEntry({ id: `g${i}`, name: `Group ${i}`, unread: i % 3 }));
    render(<Rail {...props} entries={many} activeId={null} />);
    fireEvent.change(screen.getByLabelText("Filter conversations"), { target: { value: "x".repeat(20_000) } });
    expect(screen.getByRole("status").textContent).toBe("No conversation matches that.");
  });
});

describe("one message", () => {
  const names = new Map(members().map((m) => [m.userId, m.name]));
  const base = (over: Partial<MessageRowProps> = {}): MessageRowProps => ({
    message: message(1), header: true, names, selfId: ME.id, timeZone: "UTC", allow: { canReact: true, canReply: true, canEdit: false, canDelete: false }, editing: false,
    onOpenThread: vi.fn(), onStartEdit: vi.fn(), onCancelEdit: vi.fn(), onSaveEdit: vi.fn().mockResolvedValue({ ok: true }), onDelete: vi.fn(), onReact: vi.fn(), ...over,
  });
  const row = (props: MessageRowProps) => render(<ul><MessageRow {...props} /></ul>);

  it("shows who wrote it and when at the first of a run, and only the text after that", () => {
    const { rerender } = row(base());
    expect(screen.getByText("Maya Santos")).toBeTruthy();
    expect(screen.getByText("9:01 AM")).toBeTruthy();
    expect(screen.getByText("Message number 1")).toBeTruthy();
    rerender(<ul><MessageRow {...base({ header: false })} /></ul>);
    expect(screen.queryByText("Maya Santos")).toBeNull();
    expect(screen.getByText("Message number 1")).toBeTruthy();
  });

  it("calls the person's own message 'You', and a colleague who left a former team member", () => {
    const { rerender } = row(base({ message: mine(2) }));
    expect(screen.getByText("You")).toBeTruthy();
    rerender(<ul><MessageRow {...base({ message: message(3, { authorId: null, author: { name: "Former team member", former: true } }) })} /></ul>);
    expect(screen.getAllByText(/Former team member/).length).toBeGreaterThan(0);
  });

  it("draws the text as text, never as markup, keeps line breaks, and names a mention (the person's own in a stronger colour)", () => {
    const body = `<img src=x onerror=alert(1)> and <b>bold</b>\nsecond line ${mentionToken(SAM.id)} and ${mentionToken(ME.id)} and ${mentionToken("99999999-9999-4999-8999-999999999999")}`;
    row(base({ message: message(4, { body, mentions: [SAM.id, ME.id] }) }));
    const p = screen.getByText(/second line/).closest("p") as HTMLElement;
    expect(p.querySelector("img")).toBeNull();
    expect(p.querySelector("b")).toBeNull();
    expect(p.textContent).toContain("<img src=x onerror=alert(1)> and <b>bold</b>");
    expect(p.className).toContain("whitespace-pre-wrap");
    const tags = within(p).getAllByText(/^@/);
    expect(tags.map((t) => t.textContent)).toEqual(["@Sam Okafor", "@Avery Admin", "@someone"]);
    expect(tags[1].className).toContain("warning");
    expect(document.body.textContent).not.toContain("<@");
  });

  it("shows a deleted message as a place-holder with no text, no files and no buttons", () => {
    row(base({ message: message(5, { deleted: true, body: "", reactions: [], replyCount: 4 }), allow: { canReact: true, canReply: true, canEdit: true, canDelete: true } }));
    expect(screen.getByText("This message was deleted.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("marks an edit and gives each file as a download link by id, with its name and size", () => {
    row(base({ message: message(6, { editedAt: "2026-10-24T09:30:00.000Z", attachments: [{ id: "f1", filename: "Plan v2.pdf", mimeType: "application/pdf", sizeBytes: 1_572_864 }] }) }));
    expect(screen.getByText("(edited)")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Plan v2\.pdf, 1\.5 MB/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/admin/messages/files/f1");
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.target).toBe("");
  });

  it("shows reactions as buttons that say who they are for and whether you are one of them, and toggles one", () => {
    const onReact = vi.fn();
    row(base({ message: message(7, { reactions: [{ reaction: "heart", count: 2, mine: false }, { reaction: "tada", count: 1, mine: true }] }), onReact }));
    const heart = screen.getByRole("button", { name: "Heart, 2 people" });
    const tada = screen.getByRole("button", { name: "Celebrate, 1 person, including you" });
    expect(heart.getAttribute("aria-pressed")).toBe("false");
    expect(tada.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(heart);
    expect(onReact).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 7 }), "heart", true);
    fireEvent.click(tada);
    expect(onReact).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 7 }), "tada", false);
  });

  it("offers the twelve reactions in a picker when allowed, and none when not", () => {
    const onReact = vi.fn();
    const { rerender } = row(base({ onReact }));
    fireEvent.click(screen.getByRole("button", { name: "Add a reaction" }));
    const list = screen.getByRole("list", { name: "Reactions" });
    expect(within(list).getAllByRole("button")).toHaveLength(12);
    fireEvent.click(within(list).getByRole("button", { name: "Thumbs up" }));
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }), "thumbs_up", true);
    rerender(<ul><MessageRow {...base({ allow: { canReact: false, canReply: false, canEdit: false, canDelete: false } })} /></ul>);
    expect(screen.queryByRole("button", { name: "Add a reaction" })).toBeNull();
  });

  it("shows the reply count as a button that opens the thread, and not inside a thread", () => {
    const onOpenThread = vi.fn();
    const { rerender } = row(base({ message: message(8, { replyCount: 3 }), onOpenThread }));
    fireEvent.click(screen.getByRole("button", { name: "3 replies" }));
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ seq: 8 }));
    rerender(<ul><MessageRow {...base({ message: message(8, { replyCount: 1 }), onOpenThread })} /></ul>);
    expect(screen.getByRole("button", { name: "1 reply" })).toBeTruthy();
    rerender(<ul><MessageRow {...base({ message: message(8, { replyCount: 3 }), onOpenThread, inThread: true })} /></ul>);
    expect(screen.queryByRole("button", { name: /repl/ })).toBeNull();
  });

  it("offers a menu of what the person may do, and only that", () => {
    const props = base({ message: mine(9), allow: { canReact: true, canReply: true, canEdit: true, canDelete: true } });
    const { rerender } = row(props);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for the message from you" }), { button: 0, ctrlKey: false });
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Reply in thread", "Edit message", "Delete message"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
    expect(props.onStartEdit).toHaveBeenCalledWith(expect.objectContaining({ seq: 9 }));
    rerender(<ul><MessageRow {...base({ allow: { canReact: true, canReply: false, canEdit: false, canDelete: false } })} /></ul>);
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });

  it("edits in place: starts from the text with the names back, saves what the person wrote with the mention as the server stores it, and says why it did not save", async () => {
    const stored = `Thanks ${mentionToken(SAM.id)}, see you there`;
    const onSaveEdit = vi.fn().mockResolvedValue({ ok: true });
    row(base({ message: mine(10, { body: stored, mentions: [SAM.id] }), editing: true, onSaveEdit }));
    const box = screen.getByLabelText("Edit your message") as HTMLTextAreaElement;
    expect(box.value).toBe("Thanks @Sam Okafor, see you there");
    fireEvent.change(box, { target: { value: "Thanks @Sam Okafor, see you at 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaveEdit).toHaveBeenCalledWith(expect.objectContaining({ seq: 10 }), `Thanks ${mentionToken(SAM.id)}, see you at 3`));
  });

  it("keeps the editor open and says so when the server refuses the edit, and refuses an empty one before asking", async () => {
    const onSaveEdit = vi.fn().mockResolvedValue({ ok: false, error: "This message was changed somewhere else.", code: "conflict" });
    row(base({ message: mine(11), editing: true, onSaveEdit }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed somewhere else/);
    fireEvent.change(screen.getByLabelText("Edit your message"), { target: { value: "   " } });
    onSaveEdit.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Write something before you send.");
    expect(onSaveEdit).not.toHaveBeenCalled();
  });

  it("closes the editor with Escape", () => {
    const onCancelEdit = vi.fn();
    row(base({ message: mine(12), editing: true, onCancelEdit }));
    fireEvent.keyDown(screen.getByLabelText("Edit your message"), { key: "Escape" });
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
  });
});

describe("the message box", () => {
  const sent = () => vi.fn<(m: PendingMessage) => void>();
  const box = (over: Partial<React.ComponentProps<typeof Composer>> = {}) => {
    const onSend = sent();
    render(<Composer conversationId={CONV} threadRootId={null} label="Message Launch crew" placeholder="Message Launch crew" members={[{ id: MAYA.id, name: MAYA.name }, { id: SAM.id, name: SAM.name }, { id: ME.id, name: ME.name }]} selfId={ME.id} blocked={null} onSend={onSend} {...over} />);
    return { onSend, area: screen.getByLabelText("Message Launch crew") as HTMLTextAreaElement };
  };

  it("has a labelled field with text large enough for a phone, a send button and an attach button, each at least 44 pixels where it can be tapped", () => {
    const { area } = box();
    expect(area.className).toContain("text-[16px]");
    expect(area.className).toContain("min-h-11");
    expect(screen.getByRole("button", { name: "Send message" }).className).toMatch(/h-11/);
    expect(screen.getByRole("button", { name: "Attach a file" }).className).toMatch(/h-11/);
    // The field has exactly one label, so a screen reader says "Message Launch crew" once.
    expect(screen.getAllByLabelText("Message Launch crew")).toHaveLength(1);
  });

  it("sends the text, tidied, with a fresh id each time, and clears the box", () => {
    const { onSend, area } = box();
    fireEvent.change(area, { target: { value: "  Hello team  \n\n\n\n\nsecond line  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    const first = onSend.mock.calls[0][0];
    expect(first).toMatchObject({ conversationId: CONV, threadRootId: null, body: "Hello team\n\n\nsecond line", attachments: [], status: "sending", error: null, errorCode: null });
    expect(first.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(area.value).toBe("");
    fireEvent.change(area, { target: { value: "Again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend.mock.calls[1][0].clientId).not.toBe(first.clientId);
  });

  it("refuses to send nothing, and says so where a screen reader will hear it", () => {
    const { onSend, area } = box();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Write something before you send.");
    expect(area.getAttribute("aria-invalid")).toBe("true");
    expect(area.getAttribute("aria-describedby")).toBe(alert.id);
    fireEvent.change(area, { target: { value: "x" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends with Enter on a mouse and keyboard, starts a line with Shift+Enter, and on a touch screen Enter only starts a line", () => {
    pointer(true);
    const fine = box();
    fireEvent.change(fine.area, { target: { value: "Via Enter" } });
    fireEvent.keyDown(fine.area, { key: "Enter", shiftKey: true });
    expect(fine.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(fine.area, { key: "Enter" });
    expect(fine.onSend).toHaveBeenCalledTimes(1);
    cleanup();
    pointer(false);
    const touch = box();
    fireEvent.change(touch.area, { target: { value: "Via the button" } });
    fireEvent.keyDown(touch.area, { key: "Enter" });
    expect(touch.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(touch.area, { key: "Enter", ctrlKey: true });
    expect(touch.onSend).toHaveBeenCalledTimes(1);
  });

  it("offers the people in the conversation after an @ (never the person writing), and turns the chosen name into the id the server stores", () => {
    pointer(true);
    const { onSend, area } = box();
    fireEvent.change(area, { target: { value: "Thanks @ma", selectionStart: 10 } });
    area.setSelectionRange(10, 10);
    fireEvent.select(area);
    const list = screen.getByRole("listbox", { name: "People you can mention" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Maya Santos"]);
    expect(area.getAttribute("aria-controls")).toBe(list.id);
    fireEvent.keyDown(area, { key: "Enter" });
    expect(area.value).toBe("Thanks @Maya Santos ");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(area, { target: { value: "Thanks @Maya Santos for this" } });
    fireEvent.keyDown(area, { key: "Enter" });
    expect(onSend.mock.calls[0][0].body).toBe(`Thanks ${mentionToken(MAYA.id)} for this`);
  });

  it("lists everyone but the writer for a bare @, moves with the arrow keys, and Escape closes the list", () => {
    const { area } = box();
    fireEvent.change(area, { target: { value: "@" } });
    area.setSelectionRange(1, 1);
    fireEvent.select(area);
    const options = () => screen.getAllByRole("option");
    expect(options().map((o) => o.textContent)).toEqual(["Maya Santos", "Sam Okafor"]);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(area, { key: "ArrowDown" });
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(area, { key: "ArrowDown" });
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(area, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("counts characters near the limit and will not send past it", () => {
    const { onSend, area } = box();
    fireEvent.change(area, { target: { value: "x".repeat(MAX_BODY_CHARS - 10) } });
    expect(screen.getByText("10 characters left")).toBeTruthy();
    fireEvent.change(area, { target: { value: "x".repeat(MAX_BODY_CHARS + 5) } });
    expect(screen.getByText("5 characters too many")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("takes a 20,000 character paste without trouble", () => {
    const { area } = box();
    const started = performance.now();
    fireEvent.change(area, { target: { value: `${"@ ".repeat(10_000)}` } });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(screen.getByText(/characters too many/)).toBeTruthy();
  });

  it("keeps a chosen file with the message, tells the person to add words when there are none, and sends the file's id", async () => {
    const upload = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "att-1", filename: "Plan.pdf", mimeType: "application/pdf", sizeBytes: 6 }), { status: 200 }));
    vi.stubGlobal("fetch", upload);
    const { onSend, area } = box();
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [pdfFile()] } });
    expect(await screen.findByText("Plan.pdf, 6 B")).toBeTruthy();
    const [url, init] = upload.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/messages/upload");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("conversationId")).toBe(CONV);
    expect((form.get("file") as File).name).toBe("Plan.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.getByRole("alert").textContent).toBe("Write a few words to send with your files.");
    fireEvent.change(area, { target: { value: "The plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend.mock.calls[0][0].attachments).toEqual([{ id: "att-1", filename: "Plan.pdf", mimeType: "application/pdf", sizeBytes: 6 }]);
    expect(screen.queryByText("Plan.pdf, 6 B")).toBeNull();
  });

  it("takes a file back when the person removes it, and tells the server so the stored copy goes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "att-2", filename: "Plan.pdf", mimeType: "application/pdf", sizeBytes: 6 }), { status: 200 })));
    box();
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: [pdfFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Remove Plan.pdf" }));
    expect(screen.queryByText("Plan.pdf, 6 B")).toBeNull();
    expect(mocks.discard).toHaveBeenCalledWith("att-2");
  });

  it("refuses a file of the wrong type or size before uploading anything, and shows the server's refusal when it gives one", async () => {
    const upload = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: "That file does not look like a PDF.", code: "invalid_input" }), { status: 400 }));
    vi.stubGlobal("fetch", upload);
    box();
    const input = screen.getByLabelText("Choose files to attach");
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], "tool.exe")] } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/tool\.exe: Choose a/);
    expect(upload).not.toHaveBeenCalled();
    // An empty file is refused before the request; the next file is sent and its server refusal is shown.
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(0)], "empty.pdf"), pdfFile("fine.pdf")] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/fine\.pdf: That file does not look like a PDF/));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("allows five files to a message and says so after that", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: `att-${++n}`, filename: `f${n}.pdf`, mimeType: "application/pdf", sizeBytes: 6 }), { status: 200 })));
    box();
    fireEvent.change(screen.getByLabelText("Choose files to attach"), { target: { files: Array.from({ length: 6 }, (_, i) => pdfFile(`f${i}.pdf`)) } });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(5));
    expect(screen.getByRole("alert").textContent).toBe("You can attach up to 5 files to a message.");
    expect((screen.getByRole("button", { name: "Attach a file" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows why nothing can be written instead of a box", () => {
    render(<Composer conversationId={CONV} threadRootId={null} label="x" placeholder="x" members={[]} selfId={ME.id} blocked="This conversation is archived. Bring it back from its details to write in it." onSend={vi.fn()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/archived/);
  });
});

describe("the open conversation", () => {
  const actions = (over: Partial<PaneActions> = {}): PaneActions => ({
    onOpenThread: vi.fn(), onStartEdit: vi.fn(), onCancelEdit: vi.fn(), onSaveEdit: vi.fn().mockResolvedValue({ ok: true }), onDelete: vi.fn(), onReact: vi.fn(), onSend: vi.fn(), onRetry: vi.fn(), onDiscardPending: vi.fn(),
    onLoadOlder: vi.fn(), onOpenDetails: vi.fn(), onSearch: vi.fn(), onJoin: vi.fn(), onJumpToLatest: vi.fn(), onAtBottomChange: vi.fn(), ...over,
  });
  const names = new Map(members().map((m) => [m.userId, m.name]));
  const pane = (over: Partial<React.ComponentProps<typeof ConversationPane>> = {}) =>
    render(
      <ConversationPane
        view={conversationView()}
        messages={[message(1), message(2), message(3, { createdAt: new Date(Date.UTC(2026, 9, 23, 17, 0)).toISOString() })].sort((a, b) => a.seq - b.seq)}
        hasMore={false}
        loadingOlder={false}
        pending={[]}
        names={names}
        mentionable={members().map((m) => ({ id: m.userId, name: m.name }))}
        me={{ id: ME.id, canChannels: false, canModerate: false, timeZone: "UTC" }}
        now={NOW}
        markerAfterSeq={null}
        highlightSeq={null}
        readingAround={false}
        editingId={null}
        busyJoin={false}
        actions={actions()}
        {...over}
      />,
    );

  it("names the conversation, says who is in it, and has a way back on a phone, a search and a details button", () => {
    const a = actions();
    pane({ actions: a });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Launch crew3 people");
    expect((screen.getByRole("link", { name: "Back to conversations" }) as HTMLAnchorElement).getAttribute("href")).toBe("/admin/messages");
    fireEvent.click(screen.getByRole("button", { name: "Conversation details" }));
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    expect(a.onOpenDetails).toHaveBeenCalledTimes(1);
    expect(a.onSearch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("log", { name: "Messages in Launch crew" }).getAttribute("tabindex")).toBe("0");
  });

  it("puts a heading before each day, in the person's own words for it, and an author line on the first of each run", () => {
    pane({ messages: [message(1, { createdAt: new Date(Date.UTC(2026, 9, 23, 17, 0)).toISOString() }), message(2), message(3)] });
    expect(screen.getAllByRole("separator").map((s) => s.getAttribute("aria-label"))).toEqual(["Yesterday", "Today"]);
    // Two messages by one person in a row share an author line.
    expect(screen.getAllByText("Maya Santos")).toHaveLength(2);
  });

  it("marks where the unread messages begin", () => {
    pane({ markerAfterSeq: 1 });
    const marker = screen.getByRole("separator", { name: "New messages" });
    const items = Array.from(marker.parentElement?.children ?? []);
    expect(items[items.indexOf(marker) + 1].textContent).toContain("Message number 2");
  });

  it("offers older messages when there are some, and says when there are none yet", () => {
    const a = actions();
    const { rerender } = pane({ hasMore: true, actions: a });
    fireEvent.click(screen.getByRole("button", { name: "Show older messages" }));
    expect(a.onLoadOlder).toHaveBeenCalledTimes(1);
    rerender(<ConversationPane view={conversationView()} messages={[]} hasMore={false} loadingOlder={false} pending={[]} names={names} mentionable={[]} me={{ id: ME.id, canChannels: false, canModerate: false, timeZone: "UTC" }} now={NOW} markerAfterSeq={null} highlightSeq={null} readingAround={false} editingId={null} busyJoin={false} actions={a} />);
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show older messages" })).toBeNull();
  });

  it("shows a message being sent and one that failed, with the ways to try again or let it go, and says why when trying again cannot help", () => {
    const a = actions();
    const base: PendingMessage = { clientId: nextId(), conversationId: CONV, body: `Hi ${mentionToken(MAYA.id)}`, threadRootId: null, attachments: [], status: "sending", error: null, errorCode: null, createdAt: new Date(NOW).toISOString() };
    const { rerender } = pane({ pending: [base], actions: a });
    expect(screen.getByText("Hi @Maya Santos")).toBeTruthy();
    expect(screen.getByText("Sending…")).toBeTruthy();
    const failed = { ...base, status: "failed" as const };
    rerender(<ConversationPane view={conversationView()} messages={[message(1)]} hasMore={false} loadingOlder={false} pending={[failed]} names={names} mentionable={[]} me={{ id: ME.id, canChannels: false, canModerate: false, timeZone: "UTC" }} now={NOW} markerAfterSeq={null} highlightSeq={null} readingAround={false} editingId={null} busyJoin={false} actions={a} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Not sent\. Check your connection/);
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(a.onRetry).toHaveBeenCalledWith(base.clientId);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(a.onDiscardPending).toHaveBeenCalledWith(base.clientId);
    const refused = { ...failed, error: "You can't write in this conversation.", errorCode: "forbidden" };
    rerender(<ConversationPane view={conversationView()} messages={[message(1)]} hasMore={false} loadingOlder={false} pending={[refused]} names={names} mentionable={[]} me={{ id: ME.id, canChannels: false, canModerate: false, timeZone: "UTC" }} now={NOW} markerAfterSeq={null} highlightSeq={null} readingAround={false} editingId={null} busyJoin={false} actions={a} />);
    expect(screen.getByRole("alert").textContent).toContain("You can't write in this conversation.");
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
  });

  it("says a conversation that is not there is not available, in words that fit all the reasons, with the way back", () => {
    pane({ view: null });
    expect(screen.getByRole("heading", { name: "This conversation isn't available" })).toBeTruthy();
    expect(screen.getByText(/left it, been removed from it, or the link may be wrong/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("link", { name: /Back to/ }).length).toBeGreaterThan(0);
  });

  it("offers to join an open channel the person has only found, without showing any of its messages", () => {
    const a = actions();
    pane({
      view: conversationView({ conversation: { kind: "channel", visibility: "staff", name: "general", memberRole: null }, can: { post: false, join: true, leave: false, manageMembers: false, rename: false, archive: false }, members: null }),
      messages: [], actions: a,
    });
    expect(screen.getByRole("heading", { name: /haven.t joined/ })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Join #general" }));
    expect(a.onJoin).toHaveBeenCalledTimes(1);
  });

  it("says an archived conversation is archived and does not offer a box to write in", () => {
    pane({ view: conversationView({ conversation: { archived: true }, can: { post: false } }) });
    expect(screen.getAllByText(/archived/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says when the person is reading older messages and gives the way back to the newest", () => {
    const a = actions();
    pane({ readingAround: true, highlightSeq: 2, actions: a });
    expect(screen.getByText(/reading older messages/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Jump to the newest" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/admin/messages/${CONV}`);
    expect(document.querySelector('[data-seq="2"]')?.className).toContain("ring-2");
  });

  it("offers a thread and a menu only for messages the person may reply to, and uses the same rules as the server for delete", () => {
    pane({ view: conversationView({ conversation: { kind: "channel", visibility: "staff", name: "general", memberRole: "member" } }), me: { id: ME.id, canChannels: false, canModerate: true, timeZone: "UTC" }, messages: [message(1), mine(2)] });
    expect(screen.getAllByRole("button", { name: /^Actions for/ })).toHaveLength(2);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for the message from Maya Santos" }), { button: 0, ctrlKey: false });
    // A moderator in a channel they belong to may delete a colleague's message, but not edit it.
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["Reply in thread", "Delete message"]);
  });

  it("shows no raw ids, tokens or placeholders anywhere", () => {
    pane({ messages: [message(1, { body: `Hello ${mentionToken(SAM.id)}`, mentions: [SAM.id] })] });
    expect(document.body.textContent).not.toMatch(BAD);
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
  });
});
