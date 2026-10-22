import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listAssignableMembers } from "@/server/crm/contacts";
import { CALL_STATUS_FILTERS, listCalls, listVoiceConnections, type CallFilters, type CallStatusFilter } from "@/server/crm/calls";
import { VAPI_AUTH_LABELS, VAPI_AUTH_MODES } from "@/server/integrations/voice/vapi";
import { CallsWorkspace, type CallsTab } from "@/components/crm/calls/calls-workspace";
import { CASE_GROUPS, getCase, listCases, type CaseGroup } from "@/server/missed-calls/ops";
import { readPolicy } from "@/server/missed-calls/policy";
import { recoveryStats, STAT_PERIODS } from "@/server/missed-calls/analytics";

type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * CRM → Calls: every call the workspace's voice assistants reported (Vapi, Retell) and every call the team logged, with filters, and
 * the voice provider connections. Everyone who works with customers can see calls (they can include recording links, so read-only
 * viewers can't); logging and annotating needs contact editing. Connections are set up by an agency super admin in a write session.
 */
export async function CallsView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  const tab: CallsTab = (["connections", "recovery", "recovery-settings"] as const).find((t) => t === str(searchParams.tab)) ?? "calls";
  const status = (CALL_STATUS_FILTERS as readonly string[]).includes(str(searchParams.status)) ? (str(searchParams.status) as CallStatusFilter) : "all";
  const provider = ["vapi", "retell", "manual"].includes(str(searchParams.provider)) ? (str(searchParams.provider) as CallFilters["provider"]) : "all";
  const direction = ["inbound", "outbound"].includes(str(searchParams.direction)) ? (str(searchParams.direction) as "inbound" | "outbound") : "all";
  const match = ["matched", "unmatched"].includes(str(searchParams.match)) ? (str(searchParams.match) as "matched" | "unmatched") : "all";
  const days = [1, 7, 30, 90, 365].includes(Number(searchParams.days)) ? Number(searchParams.days) : null;
  const page = Math.max(1, Math.floor(Number(searchParams.page) || 1));
  const recoveryTab = tab === "recovery" || tab === "recovery-settings";
  const [calls, connections, members] = await Promise.all([
    recoveryTab ? Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25, counts: { all: 0, completed: 0, missed: 0, failed: 0, live: 0 } }) : listCalls(actor, { status, provider, direction, match, days, page }),
    tab === "connections" ? listVoiceConnections(actor) : Promise.resolve([]),
    actor.can("tasks.manage") || (recoveryTab && actor.can("contacts.edit")) ? listAssignableMembers(actor) : Promise.resolve([]),
  ]);
  // Missed-call recovery: the numbers, the cases, the chosen case and the policy are read only for its own tabs.
  const group = (CASE_GROUPS as readonly string[]).includes(str(searchParams.group)) ? (str(searchParams.group) as CaseGroup) : "needs_you";
  const periodDays = (STAT_PERIODS as readonly number[]).includes(Number(searchParams.days)) ? Number(searchParams.days) : 30;
  const caseId = /^[0-9a-f-]{36}$/i.test(str(searchParams.case)) ? str(searchParams.case) : null;
  const recovery = tab === "recovery"
    ? {
        stats: await recoveryStats(actor, periodDays),
        cases: await listCases(actor, { group, page }),
        group,
        selected: caseId ? await getCase(actor, caseId).catch(() => null) : null,
        ...(await readPolicy(actor)),
      }
    : tab === "recovery-settings"
      ? { ...(await readPolicy(actor)), businessName: actor.orgName }
      : null;
  await auditSupportView(actor, tab === "connections" ? "voice-connections" : recoveryTab ? "missed-call-recovery" : "calls");
  return (
    <CallsWorkspace
      scope={scope}
      tab={tab}
      filters={{ status, provider: provider ?? "all", direction, match, days }}
      calls={JSON.parse(JSON.stringify(calls))}
      connections={JSON.parse(JSON.stringify(connections))}
      recovery={recovery ? JSON.parse(JSON.stringify(recovery)) : null}
      canWorkCases={actor.can("contacts.edit") && !scope.readOnly}
      canConfigureRecovery={actor.can("messaging.configure") && !scope.readOnly}
      members={members.map((m) => ({ id: m.id, name: m.name }))}
      canLog={actor.can("contacts.edit") && !scope.readOnly}
      canFollowUp={actor.can("tasks.manage") && !scope.readOnly}
      // A connection holds a provider credential: only an agency super admin in a write support session can change one.
      canConnect={actor.kind === "agency" && actor.supportMode === "write"}
      vapiAuthModes={VAPI_AUTH_MODES.map((m) => ({ value: m, label: VAPI_AUTH_LABELS[m] }))}
    />
  );
}
