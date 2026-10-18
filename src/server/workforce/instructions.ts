import "server-only";
import { withSystem } from "@/server/db";
import { agentSettingsSchema, type AgentSettings } from "@/lib/agent-settings";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { buildSoul } from "@/server/workforce/provisioning";
import { employeeKnowledgeContext } from "@/server/workforce/knowledge";
import { POLICY_VERSION } from "@/server/workforce/policy";

export interface InstructionLayer {
  key: string;
  label: string;
  body: string;
  managedBy: "iAcquire" | "Your workspace" | "The conversation";
  editable: boolean;
}

export interface EmployeeInstructionOverview {
  role: AgentRoleKey;
  roleName: string;
  soul: string;
  policyVersion: string;
  active: {
    version: number | null;
    summary: string | null;
    appliedAt: Date | null;
    settings: AgentSettings | null;
    compiledInstructions: string | null;
  };
  layers: InstructionLayer[];
  knowledge: {
    companySections: number;
    employeeNotes: number;
    referenceDocuments: number;
    characters: number;
    truncated: boolean;
  };
  memory: {
    scopeLabel: string;
    conversations: number;
    messages: number;
    retentionDays: number | null;
    inspectionSupported: false;
    hermesMemoryEvidence: Array<{ tool: string; label: string; at: Date }>;
  };
  usage: {
    runs: number;
    completed: number;
    failed: number;
    tokens: number;
    toolCalls: number;
    averageLatencyMs: number | null;
    lastRunAt: Date | null;
    costsAvailable: false;
  };
}

/**
 * Read-only view of the instruction hierarchy and the recorded runtime evidence for one employee. It never returns
 * credentials or provider keys and never claims an editable SOUL.md: Hermes owns that file and the verified API has no
 * endpoint to write it, so the portal shows it and layers per-run instructions beneath the protected policy instead.
 */
export async function getEmployeeInstructionOverview(input: {
  orgId: string;
  agentId: string;
  role: AgentRoleKey;
  companyName: string;
}): Promise<EmployeeInstructionOverview> {
  return withSystem(async (db) => {
    const meta = AGENT_BY_KEY[input.role];
    const { rows } = await db.query<{
      compiled_instructions: string | null;
      settings: AgentSettings | null;
      summary: string | null;
      version: number | null;
      applied_at: Date | null;
    }>(
      `select v.compiled_instructions, v.settings, v.summary, v.version, v.applied_at
       from agent_instances a left join agent_config_versions v on v.id = a.active_config_version_id
       where a.id = $1 and a.org_id = $2`,
      [input.agentId, input.orgId],
    );
    const active = rows[0];
    const settings = active?.settings ? agentSettingsSchema.safeParse(active.settings) : null;
    const knowledge = await employeeKnowledgeContext(db, input.orgId, input.agentId);
    const { rows: companyKnowledge } = await db.query<{ n: number }>(
      "select count(*)::int as n from company_knowledge where org_id = $1 and review_status = 'approved' and content <> ''",
      [input.orgId],
    );
    const { rows: notes } = await db.query<{ n: number }>(
      "select count(*)::int as n from employee_knowledge_entries where org_id = $1 and agent_instance_id = $2 and status = 'approved' and content <> ''",
      [input.orgId, input.agentId],
    );
    const { rows: documents } = await db.query<{ n: number }>(
      `select count(*)::int as n from knowledge_documents
       where org_id = $1 and (agent_instance_id is null or agent_instance_id = $2)
         and status = 'ready' and extracted_text is not null and applied_at is not null`,
      [input.orgId, input.agentId],
    );
    const { rows: memory } = await db.query<{
      conversations: number;
      messages: number;
      runs: number;
      completed: number;
      failed: number;
      tokens: number;
      tool_calls: number;
      average_latency_ms: number | null;
      last_run_at: Date | null;
    }>(
      `select
         (select count(*)::int from chat_conversations c where c.org_id = $1 and c.agent_instance_id = $2 and c.deleted_at is null) as conversations,
         (select count(*)::int from chat_messages m where m.org_id = $1 and m.conversation_id in (
            select id from chat_conversations c where c.org_id = $1 and c.agent_instance_id = $2 and c.deleted_at is null)) as messages,
         (select count(*)::int from agent_runs r where r.org_id = $1 and r.agent_instance_id = $2) as runs,
         (select count(*)::int from agent_runs r where r.org_id = $1 and r.agent_instance_id = $2 and r.status = 'completed') as completed,
         (select count(*)::int from agent_runs r where r.org_id = $1 and r.agent_instance_id = $2 and r.status in ('failed','timeout','interrupted')) as failed,
         (select coalesce(sum(r.total_tokens), 0)::int from agent_runs r where r.org_id = $1 and r.agent_instance_id = $2) as tokens,
         (select count(*)::int from tool_executions t join agent_runs r on r.id = t.run_id where r.org_id = $1 and r.agent_instance_id = $2) as tool_calls,
         (select round(avg(extract(epoch from (r.finished_at - r.started_at)) * 1000))::int from agent_runs r
           where r.org_id = $1 and r.agent_instance_id = $2 and r.finished_at is not null) as average_latency_ms,
         (select max(r.started_at) from agent_runs r where r.org_id = $1 and r.agent_instance_id = $2) as last_run_at`,
      [input.orgId, input.agentId],
    );
    const { rows: profile } = await db.query<{ ai_preferences: { chatRetentionDays?: unknown } | null }>(
      "select ai_preferences from company_profiles where org_id = $1",
      [input.orgId],
    );
    const retention = Number(profile[0]?.ai_preferences?.chatRetentionDays);
    const { rows: memoryTools } = await db.query<{ tool_name: string; label: string; finished_at: Date | null }>(
      `select t.tool_name, t.label, t.finished_at
       from tool_executions t join agent_runs r on r.id = t.run_id
       where r.org_id = $1 and r.agent_instance_id = $2 and t.status = 'completed'
         and (t.tool_name ilike '%memory%' or t.tool_name ilike '%session_search%' or t.tool_name ilike '%recall%')
       order by t.started_at desc limit 5`,
      [input.orgId, input.agentId],
    );
    const stats = memory[0] ?? {
      conversations: 0, messages: 0, runs: 0, completed: 0, failed: 0, tokens: 0, tool_calls: 0, average_latency_ms: null, last_run_at: null,
    };
    const settingsView = settings?.success ? settings.data : null;
    const layers: InstructionLayer[] = [
      {
        key: "identity",
        label: "Employee identity and personality",
        body: settingsView
          ? `${settingsView.displayName} · ${settingsView.tone} tone · ${settingsView.replyLength} replies · ${settingsView.language}`
          : `${meta.shortName} · default identity`,
        managedBy: "Your workspace",
        editable: true,
      },
      {
        key: "system",
        label: "Configuration and protected policy",
        body: active?.compiled_instructions
          ? `Applied configuration v${active.version}, followed by the immutable iAcquire policy.`
          : "No configuration has been applied yet.",
        managedBy: "iAcquire",
        editable: false,
      },
      {
        key: "organization",
        label: "Organization knowledge and rules",
        body: `${companyKnowledge[0]?.n ?? 0} approved company knowledge section${companyKnowledge[0]?.n === 1 ? "" : "s"} plus this employee's own notes and reference documents.`,
        managedBy: "Your workspace",
        editable: true,
      },
      {
        key: "task",
        label: "Task-specific request",
        body: "The message you send in a conversation. It is treated as a request, never as a new system instruction.",
        managedBy: "The conversation",
        editable: true,
      },
      {
        key: "memory",
        label: "Conversation memory",
        body: "Each conversation keeps its own history. Long-term memory lives inside the employee's own Hermes profile and is scoped to this workspace and employee.",
        managedBy: "iAcquire",
        editable: false,
      },
    ];
    return {
      role: input.role,
      roleName: meta.shortName,
      soul: buildSoul(input.role, input.companyName),
      policyVersion: POLICY_VERSION,
      active: {
        version: active?.version ?? null,
        summary: active?.summary ?? null,
        appliedAt: active?.applied_at ?? null,
        settings: settingsView,
        compiledInstructions: active?.compiled_instructions ?? null,
      },
      layers,
      knowledge: {
        companySections: companyKnowledge[0]?.n ?? 0,
        employeeNotes: notes[0]?.n ?? 0,
        referenceDocuments: documents[0]?.n ?? 0,
        characters: knowledge.block.length,
        truncated: knowledge.truncated,
      },
      memory: {
        scopeLabel: `iaq:workspace:${input.role}`,
        conversations: stats.conversations,
        messages: stats.messages,
        retentionDays: Number.isFinite(retention) && retention > 0 ? retention : null,
        inspectionSupported: false,
        hermesMemoryEvidence: memoryTools.map((t) => ({ tool: t.tool_name, label: t.label, at: t.finished_at ?? new Date(0) })).filter((t) => t.at.getTime() > 0),
      },
      usage: {
        runs: stats.runs,
        completed: stats.completed,
        failed: stats.failed,
        tokens: stats.tokens,
        toolCalls: stats.tool_calls,
        averageLatencyMs: stats.average_latency_ms,
        lastRunAt: stats.last_run_at,
        costsAvailable: false,
      },
    };
  });
}
