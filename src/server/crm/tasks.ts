import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyUser } from "@/server/notifications";
import { assertCan, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { assertAssignable } from "@/server/crm/contacts";

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export const TASK_PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

export interface TaskInput {
  title: string;
  description?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
  priority?: TaskPriority;
  assigneeId?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  opportunityId?: string | null;
  appointmentId?: string | null;
}

export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string;
  dueAt: string | null;
  remindAt: string | null;
  overdue: boolean;
  assignee: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  opportunity: { id: string; name: string } | null;
  source: string;
  createdAt: string;
  completedAt: string | null;
  comments: number;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

function parseWhen(v: string | null | undefined, label: string): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new AppError("invalid_input", `${label} isn't a valid date and time.`);
  return new Date(t);
}

async function assertLinks(db: Queryable, orgId: string, input: Pick<TaskInput, "contactId" | "companyId" | "opportunityId" | "appointmentId">) {
  const check = async (sql: string, id: string | null | undefined, what: string) => {
    if (!id) return;
    if (!(await db.query(sql, [id, orgId])).rows.length) throw new AppError("not_found", `${what} not found.`);
  };
  await check("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", input.contactId, "Contact");
  await check("select 1 from crm_companies where id = $1 and org_id = $2 and deleted_at is null", input.companyId, "Company");
  await check("select 1 from crm_opportunities where id = $1 and org_id = $2 and archived_at is null", input.opportunityId, "Deal");
  await check("select 1 from appointment_refs where id = $1 and org_id = $2", input.appointmentId, "Appointment");
}

export async function createTaskInTx(db: Queryable, actor: CrmActor, input: TaskInput, opts: { source?: "user" | "agent" | "system" | "workflow"; causedBy?: { eventId: number; depth: number } | null } = {}): Promise<{ id: string }> {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title || title.length > 200) throw new AppError("invalid_input", "Give the task a title of up to 200 characters.");
  const priority = input.priority ?? "normal";
  if (!TASK_PRIORITIES.includes(priority)) throw new AppError("invalid_input", "Choose a priority.");
  const due = parseWhen(input.dueAt, "The due date");
  const remind = parseWhen(input.remindAt, "The reminder");
  await assertLinks(db, actor.orgId, input);
  if (input.assigneeId) await assertAssignable(db, actor.orgId, input.assigneeId);
  const { rows } = await db.query<{ id: string }>(
    `insert into tasks (org_id, title, description, category, due_at, remind_at, priority, status, assigned_user_id, contact_id, company_id, opportunity_id, appointment_id,
       related_type, related_id, source, created_by)
     values ($1, $2, $3, 'crm', $4, $5, $6, 'open', $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
    [
      actor.orgId, title, input.description?.trim().slice(0, 2000) || null, due, remind, priority, input.assigneeId ?? null, input.contactId ?? null, input.companyId ?? null,
      input.opportunityId ?? null, input.appointmentId ?? null, input.opportunityId ? "opportunity" : input.contactId ? "contact" : null,
      input.opportunityId ?? input.contactId ?? null, opts.source ?? (actor.kind === "agent" ? "agent" : actor.kind === "member" || actor.kind === "agency" ? "user" : "system"),
      actor.kind === "member" || actor.kind === "agency" ? actor.userId : null,
    ],
  );
  const id = rows[0].id;
  await emitEvent(db, actor, { type: "task.created", entityType: "task", entityId: id, contactId: input.contactId ?? null, payload: { opportunityId: input.opportunityId ?? null, assigneeId: input.assigneeId ?? null }, dedupeKey: `task.created:${id}`, causedBy: opts.causedBy });
  if (input.contactId || input.opportunityId || input.companyId) {
    await recordActivity(db, actor, { kind: "task.created", summary: `Task added: ${title.slice(0, 120)}`, contactId: input.contactId ?? null, companyId: input.companyId ?? null, opportunityId: input.opportunityId ?? null, refType: "task", refId: id });
  }
  if (input.assigneeId && input.assigneeId !== actor.userId) {
    await notifyUser(db, input.assigneeId, actor.orgId, { kind: "crm_assigned", severity: "info", title: `New task for you: ${title.slice(0, 120)}`, body: due ? `Due ${due.toISOString().slice(0, 16).replace("T", " ")} UTC` : undefined, link: `/crm/tasks?task=${id}`, dedupeKey: `crm-task:${id}` });
  }
  return { id };
}

export async function createTask(actor: CrmActor, input: TaskInput): Promise<{ id: string }> {
  assertCan(actor, "tasks.manage");
  if (input.contactId) assertCan(actor, "contacts.view");
  return crmWrite(actor, (db) => createTaskInTx(db, actor, input));
}

export async function updateTask(actor: CrmActor, id: string, patch: Partial<TaskInput>): Promise<void> {
  assertCan(actor, "tasks.manage");
  await crmWrite(actor, async (db) => {
    const cur = await db.query<{ title: string; assigned_user_id: string | null; status: TaskStatus }>("select title, assigned_user_id, status from tasks where id = $1 and org_id = $2 and category in ('crm', 'appointment', 'follow_up', 'sales', 'general') for update", [id, actor.orgId]);
    if (!cur.rows[0]) throw new AppError("not_found", "Task not found.");
    await assertLinks(db, actor.orgId, patch);
    if ("assigneeId" in patch && patch.assigneeId && patch.assigneeId !== cur.rows[0].assigned_user_id) await assertAssignable(db, actor.orgId, patch.assigneeId);
    const title = patch.title !== undefined ? patch.title.replace(/\s+/g, " ").trim() : cur.rows[0].title;
    if (!title || title.length > 200) throw new AppError("invalid_input", "Give the task a title of up to 200 characters.");
    if (patch.priority && !TASK_PRIORITIES.includes(patch.priority)) throw new AppError("invalid_input", "Choose a priority.");
    await db.query(
      `update tasks set title = $3,
         description = case when $4::boolean then $5 else description end,
         due_at = case when $6::boolean then $7::timestamptz else due_at end,
         remind_at = case when $8::boolean then $9::timestamptz else remind_at end,
         reminded_at = case when $8::boolean then null else reminded_at end,
         priority = coalesce($10, priority),
         assigned_user_id = case when $11::boolean then $12::uuid else assigned_user_id end,
         contact_id = case when $13::boolean then $14::uuid else contact_id end,
         opportunity_id = case when $15::boolean then $16::uuid else opportunity_id end
       where id = $1 and org_id = $2`,
      [
        id, actor.orgId, title, "description" in patch, patch.description?.trim().slice(0, 2000) || null, "dueAt" in patch, parseWhen(patch.dueAt, "The due date"),
        "remindAt" in patch, parseWhen(patch.remindAt, "The reminder"), patch.priority ?? null, "assigneeId" in patch, patch.assigneeId ?? null,
        "contactId" in patch, patch.contactId ?? null, "opportunityId" in patch, patch.opportunityId ?? null,
      ],
    );
    if ("assigneeId" in patch && patch.assigneeId && patch.assigneeId !== cur.rows[0].assigned_user_id && patch.assigneeId !== actor.userId) {
      await notifyUser(db, patch.assigneeId, actor.orgId, { kind: "crm_assigned", severity: "info", title: `Task assigned to you: ${title.slice(0, 120)}`, link: `/crm/tasks?task=${id}`, dedupeKey: `crm-task:${id}:${patch.assigneeId}` });
    }
  });
}

export async function setTaskStatus(actor: CrmActor, id: string, status: TaskStatus): Promise<{ changed: boolean }> {
  assertCan(actor, "tasks.manage");
  if (!["open", "in_progress", "done", "cancelled"].includes(status)) throw new AppError("invalid_input", "Choose a status.");
  return crmWrite(actor, async (db) => {
    const cur = await db.query<{ status: TaskStatus; title: string; contact_id: string | null; opportunity_id: string | null; company_id: string | null }>("select status, title, contact_id, opportunity_id, company_id from tasks where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    const t = cur.rows[0];
    if (!t) throw new AppError("not_found", "Task not found.");
    if (t.status === status) return { changed: false };
    await db.query(
      `update tasks set status = $3, completed_at = case when $3 = 'done' then now() else null end, completed_by = case when $3 = 'done' then $4::uuid else null end where id = $1 and org_id = $2`,
      [id, actor.orgId, status, actor.userId],
    );
    if (status === "done") {
      await emitEvent(db, actor, { type: "task.completed", entityType: "task", entityId: id, contactId: t.contact_id, dedupeKey: `task.completed:${id}:${Date.now()}` });
    }
    return { changed: true };
  });
}

export async function addTaskComment(actor: CrmActor, taskId: string, body: string): Promise<{ id: string }> {
  assertCan(actor, "tasks.manage");
  const text = body.trim();
  if (!text || text.length > 2000) throw new AppError("invalid_input", "Comments are 1 to 2000 characters.");
  return crmWrite(actor, async (db) => {
    const t = await db.query("select 1 from tasks where id = $1 and org_id = $2", [taskId, actor.orgId]);
    if (!t.rows.length) throw new AppError("not_found", "Task not found.");
    const { rows } = await db.query<{ id: string }>("insert into crm_task_comments (org_id, task_id, body, author_id) values ($1, $2, $3, $4) returning id", [actor.orgId, taskId, text, actor.userId]);
    return { id: rows[0].id };
  });
}

export async function listTaskComments(actor: CrmActor, taskId: string): Promise<Array<{ id: string; body: string; author: string | null; mine: boolean; createdAt: string }>> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; body: string; author: string | null; author_id: string | null; created_at: Date }>(
      `select c.id, c.body, nullif(u.full_name, '') as author, c.author_id, c.created_at from crm_task_comments c join tasks t on t.id = c.task_id left join users u on u.id = c.author_id
       where c.org_id = $1 and c.task_id = $2 and c.deleted_at is null order by c.created_at`,
      [actor.orgId, taskId],
    );
    return rows.map((r) => ({ id: r.id, body: r.body, author: r.author, mine: r.author_id === actor.userId, createdAt: iso(r.created_at)! }));
  });
}

export type TaskView_ = "mine" | "team" | "overdue" | "upcoming" | "completed" | "all";

export async function listTasks(actor: CrmActor, q: { view?: TaskView_; taskId?: string; contactId?: string; opportunityId?: string; companyId?: string; assigneeId?: string; search?: string; limit?: number } = {}): Promise<TaskView[]> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const where = ["t.org_id = $1", "t.category in ('crm', 'appointment', 'follow_up', 'sales', 'general')"];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll("?", `$${params.length}`));
    };
    const view = q.view ?? "mine";
    if (view === "mine") {
      add("t.assigned_user_id = ?", actor.userId);
      where.push("t.status in ('open', 'in_progress')");
    } else if (view === "team") where.push("t.status in ('open', 'in_progress')");
    else if (view === "overdue") where.push("t.status in ('open', 'in_progress') and t.due_at < now()");
    else if (view === "upcoming") where.push("t.status in ('open', 'in_progress') and t.due_at >= now() and t.due_at < now() + interval '7 days'");
    else if (view === "completed") where.push("t.status = 'done'");
    if (q.taskId) add("t.id = ?", q.taskId);
    if (q.contactId) add("t.contact_id = ?", q.contactId);
    if (q.opportunityId) add("t.opportunity_id = ?", q.opportunityId);
    if (q.companyId) add("t.company_id = ?", q.companyId);
    if (q.assigneeId) add("t.assigned_user_id = ?", q.assigneeId);
    if (q.search?.trim()) add("lower(t.title) like ? escape '\\'", `%${q.search.trim().toLowerCase().slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const order = view === "completed" ? "t.completed_at desc" : "t.due_at asc nulls last, case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.created_at";
    const { rows } = await db.query<{
      id: string; title: string; description: string | null; status: TaskStatus; priority: TaskPriority; category: string; due_at: Date | null; remind_at: Date | null; assigned_user_id: string | null; assignee: string | null;
      contact_id: string | null; contact_name: string | null; company_id: string | null; company_name: string | null; opportunity_id: string | null; opp_name: string | null; source: string; created_at: Date; completed_at: Date | null; comments: string;
    }>(
      `select t.id, t.title, t.description, t.status, t.priority, t.category, t.due_at, t.remind_at, t.assigned_user_id, nullif(u.full_name, '') as assignee,
              t.contact_id, c.display_name as contact_name, t.company_id, co.name as company_name, t.opportunity_id, o.name as opp_name, t.source, t.created_at, t.completed_at,
              (select count(*) from crm_task_comments cm where cm.task_id = t.id and cm.deleted_at is null)::text as comments
       from tasks t left join users u on u.id = t.assigned_user_id left join contacts c on c.id = t.contact_id and c.deleted_at is null
       left join crm_companies co on co.id = t.company_id left join crm_opportunities o on o.id = t.opportunity_id
       where ${where.join(" and ")} order by ${order} limit ${Math.min(500, q.limit ?? 200)}`,
      params,
    );
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id, title: r.title, description: r.description, status: r.status, priority: r.priority, category: r.category, dueAt: iso(r.due_at), remindAt: iso(r.remind_at),
      overdue: Boolean(r.due_at && (r.status === "open" || r.status === "in_progress") && new Date(r.due_at).getTime() < now),
      assignee: r.assigned_user_id ? { id: r.assigned_user_id, name: r.assignee ?? "Teammate" } : null,
      contact: r.contact_id && r.contact_name !== null ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null,
      company: r.company_id && r.company_name ? { id: r.company_id, name: r.company_name } : null,
      opportunity: r.opportunity_id && r.opp_name ? { id: r.opportunity_id, name: r.opp_name } : null,
      source: r.source, createdAt: iso(r.created_at)!, completedAt: iso(r.completed_at), comments: Number(r.comments),
    }));
  });
}

/** How many tasks each list view holds, for the view tabs. */
export async function countTaskViews(actor: CrmActor): Promise<Record<"mine" | "team" | "overdue" | "upcoming", number>> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ mine: string; team: string; overdue: string; upcoming: string }>(
      `select count(*) filter (where t.assigned_user_id = $2)::text as mine, count(*)::text as team,
              count(*) filter (where t.due_at < now())::text as overdue,
              count(*) filter (where t.due_at >= now() and t.due_at < now() + interval '7 days')::text as upcoming
       from tasks t where t.org_id = $1 and t.status in ('open', 'in_progress') and t.category in ('crm', 'appointment', 'follow_up', 'sales', 'general')`,
      [actor.orgId, actor.userId],
    );
    const r = rows[0];
    return { mine: Number(r.mine), team: Number(r.team), overdue: Number(r.overdue), upcoming: Number(r.upcoming) };
  });
}

/** Scheduler job: tells each assignee about tasks whose reminder time has come, exactly once. */
export async function sendTaskReminders(limit = 200): Promise<{ sent: number }> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; title: string; assigned_user_id: string; due_at: Date | null }>(
      `update tasks set reminded_at = now() where id in (
         select id from tasks where remind_at <= now() and reminded_at is null and status in ('open', 'in_progress') and assigned_user_id is not null
         order by remind_at limit $1 for update skip locked)
       returning id, org_id, title, assigned_user_id, due_at`,
      [limit],
    );
    for (const t of rows) {
      await notifyUser(db, t.assigned_user_id, t.org_id, { kind: "crm_task_due", severity: "info", title: `Reminder: ${t.title.slice(0, 140)}`, body: t.due_at ? `Due ${new Date(t.due_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : undefined, link: `/crm/tasks?task=${t.id}`, dedupeKey: `crm-task-reminder:${t.id}` });
    }
    return { sent: rows.length };
  });
}
