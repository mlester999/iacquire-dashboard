import { notFound } from "next/navigation";
import { after } from "next/server";
import { requireOrgContext } from "@/server/tenancy/context";
import { getAgentByRole, listConfigVersions, refreshAgentHealthIfStale } from "@/server/workforce/service";
import { getConversation, listConversations } from "@/server/chat/service";
import { isChannelActive } from "@/server/chat/hub";
import { ChatWorkspace, type ChatMessage } from "@/components/chat/chat-workspace";
import { AGENT_BY_SLUG } from "@/lib/agents";
import type { ReplyLength } from "@/lib/agent-settings";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: AGENT_BY_SLUG[slug]?.name ?? "Chat" };
}

export default async function ChatPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ c?: string; q?: string }> }) {
  const [{ slug }, { c, q }] = await Promise.all([params, searchParams]);
  const meta = AGENT_BY_SLUG[slug];
  if (!meta) notFound();
  const ctx = await requireOrgContext("agents.use");
  const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, meta.key);
  if (!agent) notFound();
  // Refresh a stale connection check after the page has been sent, so opening the conversation
  // warms the employee instead of making the first message pay six provider round trips. The send
  // path keeps its own freshness check; this only makes it cheaper.
  if (agent.enabled) {
    after(() => refreshAgentHealthIfStale(agent.id, ctx.user.id));
  }

  const [conversations, requestedConvo, versions] = await Promise.all([
    listConversations(ctx, agent.id),
    c && /^[0-9a-f-]{36}$/i.test(c) ? getConversation(ctx, c) : Promise.resolve(null),
    ctx.can("agents.configure") ? listConfigVersions(ctx.user.id, agent.id) : Promise.resolve([]),
  ]);
  // A conversation id in the URL is honoured only for the employee that owns it. Without this check a link such as
  // /chat/lead-hunter?c=<a Sales Assistant conversation> would show that history under the wrong employee.
  const convo = requestedConvo && requestedConvo.conversation.agent_instance_id === agent.id ? requestedConvo : null;
  const applied = versions.find((v) => v.status === "applied");
  const messages: ChatMessage[] = (convo?.messages ?? []).map((m) => ({ ...m, created_at: new Date(m.created_at).toISOString() }));
  const streamingMsg = messages.find((m) => m.status === "streaming" && m.run_id);
  const activeRunId = streamingMsg?.run_id && isChannelActive(streamingMsg.run_id) ? streamingMsg.run_id : null;

  return (
    <ChatWorkspace
      key={`${meta.key}:${activeRunId ?? ""}`}
      meta={meta}
      agentName={agent.display_name}
      status={agent.enabled ? agent.status : "disabled"}
      statusDetail={agent.last_health_detail}
      replyLength={(applied?.settings?.replyLength as ReplyLength) ?? "concise"}
      canConfigure={ctx.can("agents.configure")}
      configured={Boolean(applied)}
      hasPendingReview={versions.some((v) => v.status === "pending_agency_review")}
      initialConversations={conversations.map((r) => ({ id: r.id, title: r.title, lastMessageAt: new Date(r.last_message_at ?? r.created_at).toISOString() }))}
      initialConversation={convo ? { id: convo.conversation.id, title: convo.conversation.title, messages, hasMore: convo.hasMore } : null}
      activeRunId={activeRunId}
      timeZone={ctx.org.timezone}
      orgKind={ctx.org.kind}
      nowIso={new Date().toISOString()}
      initialInput={typeof q === "string" ? q.slice(0, 2000) : undefined}
    />
  );
}
