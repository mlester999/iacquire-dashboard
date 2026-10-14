import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import type { ClientAction, CompletionMode, Section, SetupService } from "@/lib/setup";

export interface TemplateTaskView { id: string; key: string; title: string; clientTitle: string | null; description: string; section: Section; completionMode: CompletionMode; service: SetupService | null; required: boolean; requiresEvidence: boolean; requiresClientResponse: boolean; clientAction: ClientAction | null; dependsOn: string[]; sortOrder: number }
export interface TemplateView { id: string; name: string; description: string; isDefault: boolean; tasks: TemplateTaskView[] }

async function requireAdmin(db: Queryable, user: SessionUser) {
  const { rows } = await db.query("select 1 from users where id=$1 and status='active' and platform_role='agency_super_admin' for share", [user.id]);
  if (!rows.length) throw new AppError("forbidden", "Only authorized super admins can edit master setup templates.");
}

export async function listSetupTemplates(admin: SessionUser): Promise<TemplateView[]> {
  return withSystem(async (db) => {
    await requireAdmin(db, admin);
    const templates = await db.query<{ id: string; name: string; description: string; is_default: boolean }>("select id,name,description,is_default from client_setup_templates order by is_default desc,name");
    const tasks = await db.query<{ id: string; template_id: string; key: string; title: string; client_title: string | null; description: string; section: Section; completion_mode: CompletionMode; service: SetupService | null; required: boolean; requires_evidence: boolean; requires_client_response: boolean; client_action: ClientAction | null; depends_on: string[]; sort_order: number }>("select id,template_id,key,title,client_title,description,section,completion_mode,service,required,requires_evidence,requires_client_response,client_action,depends_on,sort_order from client_setup_template_tasks order by sort_order");
    return templates.rows.map((t) => ({ id: t.id, name: t.name, description: t.description, isDefault: t.is_default, tasks: tasks.rows.filter((x) => x.template_id === t.id).map((x) => ({ id: x.id,key: x.key,title: x.title,clientTitle: x.client_title,description: x.description,section: x.section,completionMode: x.completion_mode,service: x.service,required: x.required,requiresEvidence: x.requires_evidence,requiresClientResponse: x.requires_client_response,clientAction: x.client_action,dependsOn: x.depends_on,sortOrder: x.sort_order })) }));
  });
}

export const templateTaskSchema = z.object({
  title: z.string().trim().min(2).max(160), clientTitle: z.string().trim().max(160), description: z.string().trim().max(600),
  required: z.boolean(), requiresEvidence: z.boolean(), requiresClientResponse: z.boolean(),
  dependsOn: z.array(z.string().regex(/^[a-z0-9_]{2,40}$/)).max(25),
  clientAction: z.object({ type: z.enum(["approve","review_and_approve","provide_info","external"]), label: z.string().trim().min(2).max(120), instructions: z.string().trim().min(5).max(1000) }).nullable(),
}).strict();

export async function updateTemplateTask(admin: SessionUser, taskId: string, input: z.input<typeof templateTaskSchema>) {
  const data = templateTaskSchema.parse(input);
  return withSystem(async (db) => {
    await requireAdmin(db, admin);
    const { rows } = await db.query<{ template_id: string; key: string; completion_mode: CompletionMode }>("select template_id,key,completion_mode from client_setup_template_tasks where id=$1", [taskId]);
    const task = rows[0];
    if (!task) throw new AppError("not_found", "Master setup step not found.");
    await db.query("select id from client_setup_templates where id=$1 for update", [task.template_id]);
    if (task.completion_mode === "activation" && !data.required) throw new AppError("invalid_input", "Final review is always required.");
    if (data.requiresClientResponse && !data.clientAction) throw new AppError("invalid_input", "Add client instructions before requiring a response.");
    const all = await db.query<{ key: string; depends_on: string[] }>("select key,depends_on from client_setup_template_tasks where template_id=$1", [task.template_id]);
    const edges = new Map(all.rows.map((r) => [r.key, r.depends_on]));
    const deps = [...new Set(data.dependsOn)];
    if (deps.some((d) => !edges.has(d))) throw new AppError("invalid_input", "Select a step from this template.");
    const seen = new Set<string>();
    const pending = [...deps];
    while (pending.length) {
      const next = pending.pop()!;
      if (next === task.key) throw new AppError("invalid_input", "These prerequisites would create a dependency loop.");
      if (seen.has(next)) continue;
      seen.add(next); pending.push(...(edges.get(next) ?? []));
    }
    await db.query("update client_setup_template_tasks set title=$2,client_title=nullif($3,''),description=$4,required=$5,requires_evidence=$6,requires_client_response=$7,depends_on=$8,client_action=$9 where id=$1",
      [taskId,data.title,data.clientTitle,data.description,data.required,data.requiresEvidence,data.requiresClientResponse,deps,data.clientAction ? JSON.stringify(data.clientAction) : null]);
    await recordAudit({ actorUserId: admin.id,actorKind: "agency",action: "setup.template_task_updated",targetType: "setup_template_task",targetId: taskId,result: "success",metadata: { templateId: task.template_id } }, db);
  });
}

export async function reorderTemplateTasks(admin: SessionUser, templateId: string, orderedIds: string[]) {
  z.array(z.string().uuid()).max(200).parse(orderedIds);
  return withSystem(async (db) => {
    await requireAdmin(db, admin);
    await db.query("select id from client_setup_templates where id=$1 for update", [templateId]);
    const { rows } = await db.query<{ id: string }>("select id from client_setup_template_tasks where template_id=$1 for update", [templateId]);
    const ids = new Set(rows.map((r) => r.id));
    if (!ids.size || ids.size !== orderedIds.length || new Set(orderedIds).size !== ids.size || orderedIds.some((id) => !ids.has(id))) throw new AppError("conflict", "The template changed. Refresh before reordering.");
    for (let i = 0; i < orderedIds.length; i += 1) await db.query("update client_setup_template_tasks set sort_order=$2 where id=$1", [orderedIds[i],(i+1)*10]);
    await recordAudit({ actorUserId: admin.id,actorKind: "agency",action: "setup.template_reordered",targetType: "setup_template",targetId: templateId,result: "success" }, db);
  });
}
