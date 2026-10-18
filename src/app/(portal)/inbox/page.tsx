import { requireOrgContext } from "@/server/tenancy/context";
import { withSystem, withUser } from "@/server/db";
import { getConversationDetail, listConversations, withDeliveryDetail, type ConversationDetail } from "@/server/messaging/inbox";
import { listOpenEscalations } from "@/server/messaging/handoff";
import { memberActor } from "@/server/crm/actor";
import { cannedRepliesForConversation, sendableWhatsappTemplates } from "@/server/crm/message-templates";
import { TRANSPORT_LABELS, type TransportName } from "@/server/messaging/transports/types";
import { InboxWorkspace, type InboxDetail } from "@/components/inbox/inbox-workspace";
import { isChannel, type Channel } from "@/lib/messaging";

export const metadata = { title: "Inbox" };

type Search = { conversation?: string; q?: string; channel?: string; owner?: string; unread?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireOrgContext("inbox.view");
  const sp = await searchParams;
  const channel = isChannel(sp.channel) ? sp.channel : undefined;
  const owner = ["ai", "human", "unassigned", "mine"].includes(sp.owner ?? "") ? (sp.owner as "ai" | "human" | "unassigned" | "mine") : undefined;
  const list = await listConversations(ctx, { q: sp.q, channel, owner, unreadOnly: sp.unread === "1" });
  let detail: ConversationDetail | null = null;
  if (sp.conversation && uuid.test(sp.conversation)) {
    // A conversation the person cannot see simply is not found; nothing about it is revealed.
    detail = await getConversationDetail(ctx, sp.conversation).catch(() => null);
  }
  // Which provider carries each channel (GoHighLevel or a native one), shown next to the channel. Read as the person (row-level security).
  const channelRows = await withUser(ctx.user.id, (db) => db.query<{ channel: Channel; provider: string }>("select channel, provider from messaging_channels where org_id = $1", [ctx.org.orgId]));
  const channelProviders: Partial<Record<Channel, string>> = Object.fromEntries(channelRows.rows.map((r) => [r.channel, providerLabel(r.provider)]));
  // Each message with the provider that carried it and its delivery events (src/server/messaging/inbox.ts: the newest 1,000 events of the
  // page, each message's listed oldest first), read as the person.
  const inboxDetail: InboxDetail | null = detail ? { ...detail, messages: await withDeliveryDetail(ctx.user.id, detail.messages) } : null;
  // Canned replies for the composer, filled with this conversation's contact. Only for people who can reply.
  const canned =
    detail && ctx.can("inbox.reply") && ctx.org.kind === "client"
      ? await cannedRepliesForConversation(memberActor(ctx), { channel: detail.conversation.channel, contactId: detail.contact.id }).catch(() => ({ replies: [], values: {} }))
      : { replies: [], values: {} };
  const escalations = ctx.can("escalations.respond") || ctx.can("inbox.view_all") ? await listOpenEscalations(ctx) : [];
  const team = ctx.can("inbox.assign")
    ? (
        await withSystem((db) =>
          db.query<{ id: string; name: string; role: string }>(
            `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name, m.role from organization_memberships m join users u on u.id = m.user_id
             where m.org_id = $1 and m.status = 'active' and exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'inbox.reply') order by u.full_name`,
            [ctx.org.orgId],
          ),
        )
      ).rows
    : [];
  // Only templates of the provider that carries WhatsApp now (Meta's own, or GoHighLevel's): the send path refuses any other.
  const templates = await withUser(ctx.user.id, (db) => sendableWhatsappTemplates(db, ctx.org.orgId));
  return (
    <InboxWorkspace
      list={list}
      detail={inboxDetail}
      channelProviders={channelProviders}
      cannedReplies={canned.replies.map((r) => ({ id: r.id, name: r.name, body: r.body, channel: r.channel, folderName: r.folderName }))}
      cannedValues={canned.values}
      cannedCustomValues={"customValues" in canned ? canned.customValues : undefined}
      escalations={escalations.map((e) => ({ ...e, owner_deadline_at: e.owner_deadline_at ? new Date(e.owner_deadline_at).toISOString() : null }))}
      me={{ id: ctx.user.id, isOwner: ctx.role === "owner" }}
      perms={{ reply: ctx.can("inbox.reply"), assign: ctx.can("inbox.assign"), notes: ctx.can("inbox.notes"), resume: ctx.can("inbox.resume_ai"), respond: ctx.can("escalations.respond"), editContacts: ctx.can("contacts.edit") }}
      team={team}
      templates={templates}
      timeZone={ctx.org.timezone}
      filters={{ q: sp.q ?? "", channel: channel ?? "", owner: owner ?? "", unread: sp.unread === "1" }}
    />
  );
}

const providerLabel = (p: string | null) => (p ? (TRANSPORT_LABELS[p as TransportName] ?? p) : null);
