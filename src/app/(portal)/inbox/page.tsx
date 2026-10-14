import { requireOrgContext } from "@/server/tenancy/context";
import { withSystem, withUser } from "@/server/db";
import { getConversationDetail, listConversations, type ConversationDetail } from "@/server/messaging/inbox";
import { listOpenEscalations } from "@/server/messaging/handoff";
import { InboxWorkspace } from "@/components/inbox/inbox-workspace";
import { isChannel } from "@/lib/messaging";

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
  const templates = (
    await withUser(ctx.user.id, (db) => db.query<{ id: string; name: string }>("select template_id as id, name from whatsapp_templates where org_id = $1 and status = 'approved' order by name", [ctx.org.orgId]))
  ).rows;
  return (
    <InboxWorkspace
      list={list}
      detail={detail}
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
