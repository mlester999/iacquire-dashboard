import "server-only";
import type { Queryable } from "@/server/db";
import { compileIssues } from "@/server/crm/workflows/conditions";
import { loadFieldDefinitions } from "@/server/crm/fields";
import { coerceFieldValue } from "@/lib/crm/fields";
import { agentLiveRunsVerified } from "@/server/crm/agent-tools/tasks";
import { n8nStepReadiness } from "@/server/integrations/n8n-actions";
import {
  hasErrors, parseDefinition, validateDefinition, validationContextFrom, type MessageChannel, type UpdateFieldConfig, type ValidationContext, type ValidationIssue, type WorkflowDefinition,
} from "@/lib/crm/workflow/spec";
import type { FieldType } from "@/lib/crm/types";

/**
 * Everything in one workspace a workflow can refer to, with the names the editor shows. The same lists are the validator's context, so the
 * editor's pickers and the publisher agree on what exists: only approved templates, verified n8n automations, active webhooks and
 * assignment rules, people who can be given records, and AI employees included in the workspace.
 */
export interface WorkflowBuilderOptions {
  timezone: string;
  tags: Array<{ id: string; name: string; color: string }>;
  users: Array<{ id: string; name: string; role: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; kind: "open" | "won" | "lost" }> }>;
  fields: Array<{ id: string; key: string; label: string; entity: "contact" | "company" | "opportunity"; type: FieldType; options: Array<{ value: string; label: string }> }>;
  templates: Array<{ id: string; name: string; channel: MessageChannel; purpose: "service" | "marketing"; version: number; contentHash: string }>;
  /** `problem`: why a step starting it can't run right now (n8n calls switched off, no trigger stored…), in client-safe words. */
  n8nMappings: Array<{ id: string; label: string; workflowId: string; problem: string | null }>;
  webhookSubscriptions: Array<{ id: string; name: string; host: string }>;
  assignmentRules: Array<{ id: string; name: string; entity: "contact" | "opportunity" }>;
  /**
   * `ready`: passed its connection check (sending as it needs this). `connected`: has its AI service address and credential. `liveRuns`:
   * live runs are verified for it, so an "Ask AI employee" step can reach it (the check requestAgentTask makes).
   */
  agents: Array<{ roleKey: string; name: string; mode: string; ready: boolean; connected: boolean; liveRuns: boolean }>;
  calendars: Array<{ id: string; name: string }>;
  appointmentTypes: Array<{ id: string; name: string; calendarId: string }>;
  /** Native forms that aren't archived, for the "Form submitted" trigger's filter. */
  forms?: Array<{ id: string; name: string; status: string }>;
  /** The workspace's configuration values ({{custom_values.<key>}} in task titles, notes, notifications and deal names). */
  customValues?: Array<{ key: string; label: string }>;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

export async function loadBuilderOptions(db: Queryable, orgId: string): Promise<WorkflowBuilderOptions> {
  const q = <T>(sql: string) => db.query<T>(sql, [orgId]).then((r) => r.rows);
  const [org] = await q<{ timezone: string }>("select timezone from organizations where id = $1");
  const tags = await q<{ id: string; name: string; color: string }>("select id, name::text as name, color from crm_tags where org_id = $1 order by lower(name::text)");
  // The same rule as assertAssignable: active members who can see contacts.
  const users = await q<{ id: string; name: string; role: string }>(
    `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name, m.role from organization_memberships m join users u on u.id = m.user_id
     where m.org_id = $1 and m.status = 'active' and u.status = 'active'
       and (m.role = 'owner' or coalesce(
             (select o.effect = 'grant' from member_permission_overrides o where o.org_id = m.org_id and o.user_id = m.user_id and o.permission = 'contacts.view'),
             exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'contacts.view')))
     order by lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
  );
  const pipes = await q<{ id: string; name: string }>("select id, name from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null order by is_default desc, lower(name)");
  const stages = await q<{ id: string; name: string; kind: "open" | "won" | "lost"; pipeline_id: string }>(
    "select id, name, kind, pipeline_id from crm_pipeline_stages where org_id = $1 and archived_at is null order by position",
  );
  const fields = await q<{ id: string; key: string; label: string; entity: "contact" | "company" | "opportunity"; type: FieldType; options: unknown }>(
    "select id, key, label, entity, type, options from crm_custom_fields where org_id = $1 and archived_at is null order by entity, position, lower(label)",
  );
  const templates = await q<{ id: string; name: string; channel: MessageChannel; purpose: "service" | "marketing"; version: number; content_hash: string }>(
    `select t.id, t.name, t.channel, t.purpose, v.version, v.content_hash from crm_message_templates t
     join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.approved_version
     where t.org_id = $1 and t.kind = 'template' and t.status = 'approved' and t.archived_at is null order by lower(t.name)`,
  );
  const mappings = await q<{ id: string; workflow_id: string; template_key: string }>("select id, workflow_id, template_key from automation_template_mappings where org_id = $1 and status = 'verified' order by template_key, workflow_id");
  const hooks = await q<{ id: string; name: string; url: string }>("select id, name, url from crm_webhook_subscriptions where org_id = $1 and active order by lower(name)");
  const rules = await q<{ id: string; name: string; entity: "contact" | "opportunity" }>("select id, name, entity from crm_assignment_rules where org_id = $1 and active order by entity, position, lower(name)");
  const n8nProblems = await n8nStepReadiness(db, orgId);
  const agents = await q<{ role_key: string; display_name: string; mode: string; status: string; last_health_ok: boolean | null; hermes_base_url: string | null; hermes_profile: string | null; credential_id: string | null; tool_inventory_contract: string | null; tool_inventory_digest: string | null; tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null; tool_inventory_tool_count: number | null }>(
    `select role_key, display_name, mode, status, last_health_ok, hermes_base_url, hermes_profile, credential_id,
            tool_inventory_contract, tool_inventory_digest, tool_inventory_verified_at, tool_inventory_expires_at, tool_inventory_tool_count
     from agent_instances where org_id = $1 and enabled order by role_key`,
  );
  const calendars = await q<{ id: string; name: string }>("select id, name from crm_calendars where org_id = $1 and archived_at is null order by lower(name)");
  const types = await q<{ id: string; name: string; calendar_id: string }>("select id, name, calendar_id from crm_appointment_types where org_id = $1 and archived_at is null order by lower(name)");
  const forms = await q<{ id: string; name: string; status: string }>("select id, name, status from crm_forms where org_id = $1 and archived_at is null order by lower(name)");
  const customValues = await q<{ key: string; label: string }>("select key, label from crm_custom_values where org_id = $1 order by lower(label), key");
  return {
    timezone: org?.timezone ?? "UTC",
    tags,
    users,
    pipelines: pipes.map((p) => ({ id: p.id, name: p.name, stages: stages.filter((s) => s.pipeline_id === p.id).map((s) => ({ id: s.id, name: s.name, kind: s.kind })) })),
    fields: fields.map((f) => ({
      id: f.id, key: f.key, label: f.label, entity: f.entity, type: f.type,
      options: Array.isArray(f.options) ? f.options.map((o) => (typeof o === "string" ? { value: o, label: o } : { value: String((o as { value?: unknown }).value ?? ""), label: String((o as { label?: unknown }).label ?? (o as { value?: unknown }).value ?? "") })) : [],
    })),
    templates: templates.map((t) => ({ id: t.id, name: t.name, channel: t.channel, purpose: t.purpose, version: t.version, contentHash: t.content_hash })),
    n8nMappings: mappings.map((m) => ({ id: m.id, label: m.template_key === "agency-approved" ? `n8n workflow ${m.workflow_id}` : m.template_key, workflowId: m.workflow_id, problem: n8nProblems.get(m.id) ?? null })),
    webhookSubscriptions: hooks.map((h) => ({ id: h.id, name: h.name, host: hostOf(h.url) })),
    assignmentRules: rules,
    agents: agents.map((a) => ({
      roleKey: a.role_key, name: a.display_name, mode: a.mode, ready: ["online", "busy"].includes(a.status), connected: Boolean(a.hermes_base_url && a.credential_id), liveRuns: agentLiveRunsVerified(a),
    })),
    calendars,
    appointmentTypes: types.map((t) => ({ id: t.id, name: t.name, calendarId: t.calendar_id })),
    forms,
    customValues,
  };
}

export async function loadValidationContext(db: Queryable, orgId: string): Promise<ValidationContext> {
  return validationContextFrom(await loadBuilderOptions(db, orgId));
}

/**
 * Full validation for publishing: the pure validator against the workspace's current records, then a test compile of every condition.
 * Returns the normalized definition when there are no errors.
 */
export async function validateForPublish(db: Queryable, orgId: string, draft: unknown): Promise<{ issues: ValidationIssue[]; definition: WorkflowDefinition | null }> {
  const ctx = await loadValidationContext(db, orgId);
  const issues = validateDefinition(draft, ctx);
  if (hasErrors(issues)) return { issues, definition: null };
  const def = parseDefinition(draft).definition!;
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId])).rows[0]?.timezone ?? "UTC";
  issues.push(...(await compileIssues(db, orgId, tz, def)));
  issues.push(...(await customValueIssues(db, orgId, def)));
  return { issues, definition: hasErrors(issues) ? null : def };
}

/** A value an "update field" step writes to a custom field must be one that field accepts (a number, a date, one of its options…). */
async function customValueIssues(db: Queryable, orgId: string, def: WorkflowDefinition): Promise<ValidationIssue[]> {
  const steps = def.steps.filter((s) => s.kind === "update_field" && (s.config as UpdateFieldConfig).field.startsWith("cf:"));
  if (!steps.length) return [];
  const code = (await db.query<{ c: string | null }>("select default_calling_code as c from crm_workspaces where org_id = $1", [orgId])).rows[0]?.c ?? null;
  const defs = new Map<string, Awaited<ReturnType<typeof loadFieldDefinitions>>[number]>();
  for (const entity of ["contact", "opportunity"] as const) for (const f of await loadFieldDefinitions(db, orgId, entity)) defs.set(f.id, f);
  const out: ValidationIssue[] = [];
  for (const s of steps) {
    const c = s.config as UpdateFieldConfig;
    const f = defs.get(c.field.slice(3));
    if (!f) continue;
    const r = coerceFieldValue(f, c.value, { defaultCallingCode: code });
    if (!r.ok) out.push({ level: "error", code: "invalid_config", message: r.error, stepKey: s.key, path: "config.value" });
  }
  return out;
}
