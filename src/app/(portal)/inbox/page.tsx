import { requireOrgContext } from "@/server/tenancy/context";
import { withSystem, withUser } from "@/server/db";
import { listConversationsPage } from "@/server/messaging/inbox-list";
import { inboxSync, loadInboxThread } from "@/server/messaging/inbox-sync";
import { getChannelHealth } from "@/server/messaging/channel-health";
import { listConversationAiEmployees } from "@/server/messaging/inbox-context";
import { listOpenEscalations } from "@/server/messaging/handoff";
import { memberActor } from "@/server/crm/actor";
import { cannedRepliesForConversation, sendableWhatsappTemplates } from "@/server/crm/message-templates";
import { TRANSPORT_LABELS, type TransportName } from "@/server/messaging/transports/types";
import { InboxWorkspace } from "@/components/inbox/inbox-workspace";
import { LegacyInbox } from "@/app/(portal)/inbox/legacy-inbox";
import { inboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { isInboxSort, isInboxView, type InboxView } from "@/lib/inbox";
import { isChannel, type Channel } from "@/lib/messaging";

export const metadata = { title: "Inbox" };

type Search = { conversation?: string; q?: string; channel?: string; owner?: string; unread?: string; view?: string; sort?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The view a link means. Links from before views existed carried an owner or unread filter instead. */
function viewOf(sp: Search): InboxView {
  if (isInboxView(sp.view)) return sp.view;
  if (sp.unread === "1") return "unread";
  if (sp.owner === "mine" || sp.owner === "ai" || sp.owner === "unassigned") return sp.owner;
  return "all";
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireOrgContext("inbox.view");
  const sp = await searchParams;
  // Which screen this workspace gets, decided on the server after the sign-in and permission check and before a single new-inbox query: the new inbox only
  // when it is switched on for the workspace (the rollout) and not switched off globally (INBOX_DISABLED); otherwise the legacy inbox the workspace already had,
  // so no human reply, takeover or escalation screen ever disappears because of a rollout.
  if (!(await inboxEnabledFor(ctx.org.orgId))) return <LegacyInbox ctx={ctx} searchParams={sp} />;
  const channel = isChannel(sp.channel) ? sp.channel : undefined;
  const view = viewOf(sp);
  const sort = isInboxSort(sp.sort) ? sp.sort : "priority";
  const q = (sp.q ?? "").slice(0, 80);
  const wantsThread = Boolean(sp.conversation && uuid.test(sp.conversation));

  const [page, sync, thread, health, aiEmployees] = await Promise.all([
    listConversationsPage(ctx, { view, sort, q, channel }),
    // The counts for the tabs and the database time live updates continue from.
    inboxSync(ctx, null, { counts: true }),
    // A conversation the person cannot see simply is not found; nothing about it is revealed.
    wantsThread ? loadInboxThread(ctx, sp.conversation!) : Promise.resolve(null),
    getChannelHealth(ctx),
    listConversationAiEmployees(ctx),
  ]);
  // Which provider carries each channel (GoHighLevel or a native one), shown next to the channel. Read as the person (row-level security).
  const channelRows = await withUser(ctx.user.id, (db) => db.query<{ channel: Channel; provider: string }>("select channel, provider from messaging_channels where org_id = $1", [ctx.org.orgId]));
  const channelProviders: Partial<Record<Channel, string>> = Object.fromEntries(channelRows.rows.map((r) => [r.channel, providerLabel(r.provider)]));
  // Canned replies for the composer, filled with this conversation's contact. Only for people who can reply.
  const canned =
    thread && ctx.can("inbox.reply") && ctx.org.kind === "client"
      ? await cannedRepliesForConversation(memberActor(ctx), { channel: thread.conversation.channel, contactId: thread.contact.id }).catch(() => ({ replies: [], values: {} }))
      : { replies: [], values: {} };
  const escalations = ctx.can("escalations.respond") || ctx.can("inbox.view_all") ? await listOpenEscalations(ctx) : [];
  const team = ctx.can("inbox.assign") || ctx.can("inbox.reply")
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
      list={page.items}
      nextCursor={page.nextCursor}
      counts={sync.counts ?? null}
      syncFrom={sync.serverTime}
      detail={thread}
      channelProviders={channelProviders}
      channelHealth={health}
      aiEmployees={aiEmployees}
      aiAssist={ctx.can("inbox.reply")}
      cannedReplies={canned.replies.map((r) => ({ id: r.id, name: r.name, body: r.body, channel: r.channel, folderName: r.folderName }))}
      cannedValues={canned.values}
      cannedCustomValues={"customValues" in canned ? canned.customValues : undefined}
      escalations={escalations.map((e) => ({ ...e, owner_deadline_at: e.owner_deadline_at ? new Date(e.owner_deadline_at).toISOString() : null }))}
      me={{ id: ctx.user.id, isOwner: ctx.role === "owner" }}
      perms={{ reply: ctx.can("inbox.reply"), assign: ctx.can("inbox.assign"), notes: ctx.can("inbox.notes"), resume: ctx.can("inbox.resume_ai"), respond: ctx.can("escalations.respond"), editContacts: ctx.can("contacts.edit"), viewAll: ctx.can("inbox.view_all") }}
      team={team}
      templates={templates}
      timeZone={ctx.org.timezone}
      filters={{ q, channel: channel ?? "", owner: "", unread: false, view, sort }}
    />
  );
}

const providerLabel = (p: string | null) => (p ? (TRANSPORT_LABELS[p as TransportName] ?? p) : null);
