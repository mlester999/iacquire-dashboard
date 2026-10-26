import { notFound } from "next/navigation";
import { after } from "next/server";
import { requireWorkforceContext } from "@/server/workforce/workspace-access";
import { getAgentByRole, listConfigVersions, refreshAgentHealthIfStale } from "@/server/workforce/service";
import { getConversation, listConversations } from "@/server/chat/service";
import { isChannelActive } from "@/server/chat/hub";
import { ChatWorkspace, type ChatMessage } from "@/components/chat/chat-workspace";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_BY_SLUG } from "@/lib/agents";
import { preferredChatTimeZone } from "@/lib/chat-timezone";
import { internalAcknowledgementIsCurrent, internalIdentityIsCurrent } from "@/lib/workforce-readiness";
import { withSystem } from "@/server/db";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: AGENT_BY_SLUG[slug]?.name ?? "Chat" };
}

export default async function ChatPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ c?: string; q?: string }> }) {
  const [{ slug }, { c, q }] = await Promise.all([params, searchParams]);
  const meta = AGENT_BY_SLUG[slug];
  if (!meta) notFound();
  const ctx = await requireWorkforceContext("agents.use");
  const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, meta.key);
  if (!agent) notFound();
  const internalVerification = ctx.org.kind === "agency"
    ? await withSystem(async (db) => {
        const { rows } = await db.query<{
          profile_check_status: string | null; profile_check_profile_id: string | null; profile_check_gateway_id: string | null;
          identity_verified: boolean | null; api_contract_verified: boolean | null; tool_permissions_status: string | null; checked_at: Date | null;
          acknowledged_at: Date | null; acknowledged_profile: string | null; acknowledged_policy_id: string | null; internal_policy_id: string | null;
          acknowledged_config_version_id: string | null; acknowledged_inventory_digest: string | null; agent_policy_override_id: string | null;
        }>(
          `select c.status as profile_check_status,c.profile_id as profile_check_profile_id,c.gateway_id as profile_check_gateway_id,
                  c.identity_verified,c.api_contract_verified,c.tool_permissions_status,c.checked_at,
                  ack.acknowledged_at,ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,
                  ack_policy.id as internal_policy_id,
                  ack_history.policy_snapshot->>'activeConfigVersionId' as acknowledged_config_version_id,
                  ack_history.policy_snapshot->>'inventoryDigest' as acknowledged_inventory_digest,
                  agent_policy.id as agent_policy_override_id
             from agent_instances a
             left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
             left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
             left join hermes_tool_policies ack_policy on ack_policy.id=ack.policy_id and ack_policy.scope_kind='internal_agency' and ack_policy.name='Full Hermes Capabilities'
             left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
             left join lateral (
               select h.policy_snapshot from hermes_tool_policy_history h
               where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
               order by h.occurred_at desc,h.id desc limit 1
             ) ack_history on true
            where a.id=$1 and a.org_id=$2`,
          [agent.id, ctx.org.orgId],
        );
        const row = rows[0];
        const identityEvidence = {
          expectedProfile: AGENCY_HERMES_PROFILE_IDS[meta.key],
          savedProfile: agent.hermes_profile,
          savedGatewayId: agent.hermes_gateway_id,
          checkedProfile: row?.profile_check_profile_id ?? null,
          checkedGatewayId: row?.profile_check_gateway_id ?? null,
          checkStatus: row?.profile_check_status ?? null,
          identityVerified: row?.identity_verified ?? null,
          apiContractVerified: row?.api_contract_verified ?? null,
          toolPermissionsStatus: row?.tool_permissions_status ?? null,
          checkedAt: row?.checked_at ?? null,
          configAppliedAt: agent.config_applied_at,
        };
        return {
          identityCurrent: internalIdentityIsCurrent(identityEvidence),
          acknowledgementCurrent: internalAcknowledgementIsCurrent({
            ...identityEvidence,
            acknowledgedAt: row?.acknowledged_at ?? null,
            acknowledgedProfile: row?.acknowledged_profile ?? null,
            acknowledgedPolicyId: row?.acknowledged_policy_id ?? null,
            expectedPolicyId: row?.internal_policy_id ?? null,
            activeConfigVersionId: agent.active_config_version_id,
            acknowledgedConfigVersionId: row?.acknowledged_config_version_id ?? null,
            inventoryDigest: agent.tool_inventory_digest,
            acknowledgedInventoryDigest: row?.acknowledged_inventory_digest ?? null,
            credentialReady: agent.credential_ready,
            hasAgentPolicyOverride: Boolean(row?.agent_policy_override_id),
          }),
        };
      })
    : { identityCurrent: null, acknowledgementCurrent: null };
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
      configVersion={agent.config_version}
      lastHealthCheckAt={agent.last_health_check_at?.toISOString() ?? null}
      lastHealthOk={agent.last_health_ok}
      inventoryContract={agent.tool_inventory_contract}
      inventoryDigest={agent.tool_inventory_digest}
      inventoryVerifiedAt={agent.tool_inventory_verified_at?.toISOString() ?? null}
      inventoryExpiresAt={agent.tool_inventory_expires_at?.toISOString() ?? null}
      inventoryToolCount={agent.tool_inventory_tool_count}
      isAgencyEmployee={ctx.org.kind === "agency"}
      identityCurrent={internalVerification.identityCurrent}
      acknowledgementCurrent={internalVerification.acknowledgementCurrent}
      credentialReady={agent.credential_ready}
      taskExecuting={agent.active_run}
      readinessExtras={agent.readiness_extras}
      canConfigure={ctx.can("agents.configure")}
      configured={Boolean(applied)}
      hasPendingReview={versions.some((v) => v.status === "pending_agency_review")}
      initialConversations={conversations.map((r) => ({ id: r.id, title: r.title, lastMessageAt: new Date(r.last_message_at ?? r.created_at).toISOString() }))}
      initialConversation={convo ? { id: convo.conversation.id, title: convo.conversation.title, messages, hasMore: convo.hasMore } : null}
      activeRunId={activeRunId}
      preferredTimeZone={preferredChatTimeZone(ctx.user.timezone, ctx.user.preferences)}
      orgKind={ctx.org.kind}
      nowIso={new Date().toISOString()}
      initialInput={typeof q === "string" ? q.slice(0, 2000) : undefined}
    />
  );
}
