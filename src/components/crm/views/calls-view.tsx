import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listAssignableMembers } from "@/server/crm/contacts";
import { CALL_STATUS_FILTERS, listCalls, listVoiceConnections, type CallFilters, type CallStatusFilter } from "@/server/crm/calls";
import { VAPI_AUTH_LABELS, VAPI_AUTH_MODES } from "@/server/integrations/voice/vapi";
import { CallsWorkspace, type CallsTab } from "@/components/crm/calls/calls-workspace";

type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * CRM → Calls: every call the workspace's voice assistants reported (Vapi, Retell) and every call the team logged, with filters, and
 * the voice provider connections. Everyone who works with customers can see calls (they can include recording links, so read-only
 * viewers can't); logging and annotating needs contact editing. Connections are set up by an agency super admin in a write session.
 */
export async function CallsView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  const tab: CallsTab = str(searchParams.tab) === "connections" ? "connections" : "calls";
  const status = (CALL_STATUS_FILTERS as readonly string[]).includes(str(searchParams.status)) ? (str(searchParams.status) as CallStatusFilter) : "all";
  const provider = ["vapi", "retell", "manual"].includes(str(searchParams.provider)) ? (str(searchParams.provider) as CallFilters["provider"]) : "all";
  const direction = ["inbound", "outbound"].includes(str(searchParams.direction)) ? (str(searchParams.direction) as "inbound" | "outbound") : "all";
  const match = ["matched", "unmatched"].includes(str(searchParams.match)) ? (str(searchParams.match) as "matched" | "unmatched") : "all";
  const days = [1, 7, 30, 90, 365].includes(Number(searchParams.days)) ? Number(searchParams.days) : null;
  const page = Math.max(1, Math.floor(Number(searchParams.page) || 1));
  const [calls, connections, members] = await Promise.all([
    listCalls(actor, { status, provider, direction, match, days, page }),
    listVoiceConnections(actor),
    actor.can("tasks.manage") ? listAssignableMembers(actor) : Promise.resolve([]),
  ]);
  await auditSupportView(actor, tab === "connections" ? "voice-connections" : "calls");
  return (
    <CallsWorkspace
      scope={scope}
      tab={tab}
      filters={{ status, provider: provider ?? "all", direction, match, days }}
      calls={JSON.parse(JSON.stringify(calls))}
      connections={JSON.parse(JSON.stringify(connections))}
      members={members.map((m) => ({ id: m.id, name: m.name }))}
      canLog={actor.can("contacts.edit") && !scope.readOnly}
      canFollowUp={actor.can("tasks.manage") && !scope.readOnly}
      // A connection holds a provider credential: only an agency super admin in a write support session can change one.
      canConnect={actor.kind === "agency" && actor.supportMode === "write"}
      vapiAuthModes={VAPI_AUTH_MODES.map((m) => ({ value: m, label: VAPI_AUTH_LABELS[m] }))}
    />
  );
}
