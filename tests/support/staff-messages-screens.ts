// Fixtures for the Messages screens tests: made-up people, conversations and messages in the exact shapes the server sends, so a screen is drawn from the same data it gets in
// the browser. No database, no network.
import type { ConversationView, MemberView } from "@/server/staff-messages/conversations";
import type { MessageView } from "@/server/staff-messages/messages";
import type { SnapshotPayload } from "@/lib/staff-messages/snapshot";
import type { RailEntry } from "@/lib/staff-messages/view";

export const ME = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Avery Admin", role: "agency_staff" as const, canChannels: false, canModerate: false, timeZone: "UTC" };
export const MAYA = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Maya Santos" };
export const SAM = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Sam Okafor" };
export const CONV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const OTHER_CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

let counter = 0;
export const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

export const message = (seq: number, over: Partial<MessageView> = {}): MessageView => ({
  id: `10000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  conversationId: CONV,
  seq,
  threadRootId: null,
  authorId: MAYA.id,
  author: { name: MAYA.name, former: false },
  body: `Message number ${seq}`,
  mentions: [],
  createdAt: new Date(Date.UTC(2026, 9, 24, 9, seq)).toISOString(),
  editedAt: null,
  deleted: false,
  replyCount: 0,
  reactions: [],
  attachments: [],
  mine: false,
  ...over,
});

export const mine = (seq: number, over: Partial<MessageView> = {}): MessageView => message(seq, { authorId: ME.id, author: { name: ME.name, former: false }, mine: true, ...over });

export const railEntry = (over: Partial<RailEntry> = {}): RailEntry => ({
  id: CONV, kind: "group", visibility: "private", name: "Launch crew", topic: null, archived: false, lastSeq: 3, lastReadSeq: 3, unread: 0, muted: false, notify: "all", lastMessageAt: new Date(NOW - 5 * 60_000).toISOString(), memberCount: 3, peer: null, ...over,
});

export const members = (): MemberView[] => [
  { userId: ME.id, name: ME.name, former: false, role: "owner", joinedAt: new Date(NOW - 86_400_000).toISOString() },
  { userId: MAYA.id, name: MAYA.name, former: false, role: "member", joinedAt: new Date(NOW - 86_400_000).toISOString() },
  { userId: SAM.id, name: SAM.name, former: false, role: "member", joinedAt: new Date(NOW - 86_400_000).toISOString() },
];

export const conversationView = (over: { conversation?: Partial<ConversationView["conversation"]>; can?: Partial<ConversationView["can"]>; members?: MemberView[] | null; events?: ConversationView["events"] } = {}): ConversationView => ({
  conversation: {
    id: CONV, kind: "group", visibility: "private", archived: false, name: "Launch crew", topic: null, lastSeq: 3, lastReadSeq: 3, muted: false, notify: "all", lastMessageAt: null, memberRole: "owner", createdBy: ME.id, ...over.conversation,
  },
  members: over.members === undefined ? members() : over.members,
  memberCount: 3,
  peer: null,
  can: { post: true, join: false, leave: true, manageMembers: true, rename: true, archive: true, ...over.can },
  events: over.events ?? [],
});

export const payload = (over: Partial<SnapshotPayload> = {}): SnapshotPayload => ({
  revision: 10,
  unread: 0,
  rail: [railEntry()],
  conversation: conversationView(),
  page: { messages: [message(1), message(2), message(3)], hasMore: false, lastSeq: 3, lastReadSeq: 3 },
  ...over,
});

export const pdfFile = (name = "Plan.pdf") => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], name, { type: "application/pdf" });
