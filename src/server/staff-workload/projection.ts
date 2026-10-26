import "server-only";
import type { Queryable } from "@/server/db";
import { PROJECT_WEIGHT_STATUSES } from "@/lib/staff-workload/rules";
import { PROJECT_WAITING_ON_CLIENT, type HealthFacts } from "@/lib/staff-workload/health";
import type { CalendarMilestone } from "@/lib/staff-workload/calendar";
import { WORK_SOURCES, type DueKind, type WorkItem, type WorkSource } from "@/lib/staff-workload/sources";

// The work items, read from the four places work is recorded: support requests, setup steps, custom projects and maintenance requests. A computed view, not a table of its
// own: every row is read live, so a closed request leaves the load the moment it closes. Only work for a client workspace that is not suspended or archived is read. Unified
// Inbox conversations, client CRM tasks and AI work jobs are not here on purpose: they are the client's, or nobody's.
//
// This file reads for the whole agency. It knows nothing about who is asking: the services that call it decide what each viewer may see.

/** Open statuses of the other three places (a project's are PROJECT_WEIGHT_STATUSES). */
export const SUPPORT_OPEN_STATUSES = ["new", "open", "in_progress", "waiting_for_client"] as const;
export const MAINTENANCE_OPEN_STATUSES = ["open", "in_progress", "waiting_for_client"] as const;

/** Most items the unassigned lane lists for one kind of work; the total is returned beside them. */
export const UNASSIGNED_LIMIT = 200;

export type Selection =
  /** Items held by anyone (ids omitted) or by the people listed. */
  | { kind: "assigned"; userIds?: readonly string[] }
  /** Items nobody holds, oldest first. */
  | { kind: "unassigned"; limit?: number }
  /** One item, held or not. */
  | { kind: "one"; id: string };

interface Row {
  item_id: string;
  org_id: string;
  org_name: string;
  assignee_id: string | null;
  ref: string | null;
  title: string;
  status: string;
  priority: string | null;
  hint: string | null;
  due_at: Date | string | null;
  due_on: string | null;
  due_kind: DueKind | null;
  escalated: boolean;
  blocked: boolean;
  waiting: boolean;
  optional: boolean;
  open_review_tasks: number;
  created_at: Date | string;
  last_activity_at: Date | string | null;
  total: number;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** A client workspace that is still being served: not suspended and not archived. */
const LIVE_CLIENT = "o.kind = 'client' and o.status not in ('suspended', 'archived')";

/**
 * Every maintenance request is mirrored by a support request (its status follows the maintenance record), and the Support queue is where people are given it. While that
 * support request is open it is the one item that counts, with its priority, its response target and its escalation, so the same work is never counted twice. A maintenance
 * request whose support request is closed (or that has none) counts as itself.
 */
export const MIRRORED_TICKET_OPEN = `not exists (select 1 from support_tickets st where st.id = %T% and st.status in ('${SUPPORT_OPEN_STATUSES.join("', '")}'))`;

const COLUMNS = `item_id, org_id, org_name, assignee_id, ref, title, status, priority, hint, due_at, due_on, due_kind, escalated, blocked, waiting, optional, open_review_tasks, created_at, last_activity_at`;

function whereFor(selection: Selection, column: string, idColumn: string): { sql: string; params: unknown[] } {
  if (selection.kind === "one") return { sql: `${idColumn} = $1::uuid`, params: [selection.id] };
  if (selection.kind === "unassigned") return { sql: `${column} is null`, params: [] };
  const ids = selection.userIds;
  return ids ? { sql: `${column} = any($1::uuid[])`, params: [[...ids]] } : { sql: `${column} is not null`, params: [] };
}

function sqlFor(source: WorkSource, selection: Selection): { sql: string; params: unknown[] } {
  const tail = selection.kind === "unassigned" ? ` order by created_at, item_id limit ${Math.max(1, Math.min(UNASSIGNED_LIMIT, selection.limit ?? UNASSIGNED_LIMIT))}` : "";
  const wrap = (inner: string) => `select ${COLUMNS}, (count(*) over ())::int as total from (${inner}) x${tail}`;
  switch (source) {
    case "support": {
      const w = whereFor(selection, "t.assigned_to", "t.id");
      return {
        params: w.params,
        sql: wrap(`select t.id::text as item_id, t.org_id::text as org_id, o.name as org_name, t.assigned_to::text as assignee_id, t.ref, t.subject as title, t.status, t.priority,
            t.category as hint, ops.response_due_at as due_at, null::text as due_on, case when ops.response_due_at is not null then 'response' end as due_kind,
            (ops.escalated_at is not null) as escalated, false as blocked, (t.status = 'waiting_for_client') as waiting, false as optional, 0 as open_review_tasks,
            t.created_at, t.last_message_at as last_activity_at
          from support_tickets t
          join organizations o on o.id = t.org_id and ${LIVE_CLIENT}
          left join support_ticket_ops ops on ops.ticket_id = t.id and ops.org_id = t.org_id
          where t.status in ('${SUPPORT_OPEN_STATUSES.join("', '")}') and ${w.sql}`),
      };
    }
    case "setup_task": {
      const w = whereFor(selection, "k.assigned_to", "k.id");
      // Setup steps nobody holds are many (every checklist has them); the lane lists only the ones the agency does, and not the ones the client has to provide.
      const lane = selection.kind === "unassigned" ? " and k.section = 'agency'" : "";
      return {
        params: w.params,
        sql: wrap(`select k.id::text as item_id, k.org_id::text as org_id, o.name as org_name, k.assigned_to::text as assignee_id, null::text as ref, k.title, k.status, null::text as priority,
            k.service as hint, null::timestamptz as due_at, k.estimated_completion_at::text as due_on, case when k.estimated_completion_at is not null then 'estimate' end as due_kind,
            false as escalated, (k.status = 'blocked') as blocked, (k.status = 'waiting_for_client') as waiting, (not k.required) as optional, 0 as open_review_tasks,
            k.created_at, k.updated_at as last_activity_at
          from client_setup_tasks k
          join client_setup_instances i on i.id = k.instance_id and i.org_id = k.org_id and i.state <> 'activated'
          join organizations o on o.id = k.org_id and ${LIVE_CLIENT}
          where k.hidden = false and k.service_excluded = false and k.status <> 'completed' and ${w.sql}${lane}`),
      };
    }
    case "project": {
      const w = whereFor(selection, "r.assigned_to", "r.id");
      return {
        params: [...w.params, [...PROJECT_WEIGHT_STATUSES], [...PROJECT_WAITING_ON_CLIENT]],
        sql: wrap(`select r.id::text as item_id, r.org_id::text as org_id, o.name as org_name, r.assigned_to::text as assignee_id, r.ref, r.title, r.status, null::text as priority,
            null::text as hint, rt.due_at, cp.expected_completion_on::text as due_on,
            case when rt.due_at is not null then 'review_task' when cp.expected_completion_on is not null then 'expected_completion' end as due_kind,
            false as escalated, false as blocked, (r.status = any($${w.params.length + 2}::text[])) as waiting, false as optional, rt.open_n as open_review_tasks,
            r.created_at, r.last_activity_at
          from client_project_requests r
          join organizations o on o.id = r.org_id and ${LIVE_CLIENT}
          left join client_projects cp on cp.request_id = r.id and cp.org_id = r.org_id
          left join lateral (select min(t.due_at) as due_at, count(*)::int as open_n from project_review_tasks t where t.request_id = r.id and t.org_id = r.org_id and t.status = 'open') rt on true
          where r.status = any($${w.params.length + 1}::text[]) and ${w.sql}`),
      };
    }
    case "maintenance": {
      const w = whereFor(selection, "m.assigned_to", "m.id");
      return {
        params: w.params,
        sql: wrap(`select m.id::text as item_id, m.org_id::text as org_id, o.name as org_name, m.assigned_to::text as assignee_id, m.ref, m.title, m.status, null::text as priority,
            m.kind as hint, null::timestamptz as due_at, null::text as due_on, null::text as due_kind, false as escalated, false as blocked, (m.status = 'waiting_for_client') as waiting,
            false as optional, 0 as open_review_tasks, m.created_at, m.updated_at as last_activity_at
          from maintenance_requests m
          join organizations o on o.id = m.org_id and ${LIVE_CLIENT}
          where m.status in ('${MAINTENANCE_OPEN_STATUSES.join("', '")}') and ${w.sql}
            and ${MIRRORED_TICKET_OPEN.replace("%T%", "m.ticket_id")}`),
      };
    }
  }
}

const toItem = (source: WorkSource, r: Row): WorkItem => ({
  source,
  itemId: r.item_id,
  orgId: r.org_id,
  orgName: r.org_name,
  assigneeId: r.assignee_id,
  ref: r.ref,
  title: r.title,
  status: r.status,
  priority: r.priority,
  hint: r.hint,
  dueAt: iso(r.due_at),
  dueOn: r.due_on,
  dueKind: r.due_kind,
  escalated: r.escalated,
  blocked: r.blocked,
  waitingOnClient: r.waiting,
  optional: r.optional,
  openReviewTasks: Number(r.open_review_tasks),
  createdAt: iso(r.created_at) as string,
  lastActivityAt: iso(r.last_activity_at),
});

export interface Projection {
  items: WorkItem[];
  /** For the unassigned lane: how many exist of each kind (the list is capped). */
  totals: Record<WorkSource, number>;
}

/** The items a selection names, from all four places (or the ones given). Dates come back as moments (ISO) and days (YYYY-MM-DD). */
export async function loadWorkItems(db: Queryable, selection: Selection, sources: readonly WorkSource[] = WORK_SOURCES): Promise<Projection> {
  const items: WorkItem[] = [];
  const totals = { support: 0, setup_task: 0, project: 0, maintenance: 0 } as Record<WorkSource, number>;
  for (const source of sources) {
    const q = sqlFor(source, selection);
    const { rows } = await db.query<Row>(q.sql, q.params);
    totals[source] = rows[0]?.total ?? 0;
    for (const r of rows) items.push(toItem(source, r));
  }
  return { items, totals };
}

/** One item by id, whether or not anyone holds it. Null when it does not exist, is closed, or belongs to a client workspace that is suspended or archived. */
export async function loadWorkItem(db: Queryable, source: WorkSource, id: string): Promise<WorkItem | null> {
  return (await loadWorkItems(db, { kind: "one", id }, [source])).items[0] ?? null;
}

/** Milestones of the open projects, for the calendar. Their assignee is the project's. */
export async function loadMilestones(db: Queryable): Promise<CalendarMilestone[]> {
  const { rows } = await db.query<{ id: string; request_id: string; org_id: string; assignee_id: string | null; title: string; due_on: string | null; status: string }>(
    `select m.id::text, m.request_id::text, m.org_id::text, r.assigned_to::text as assignee_id, m.title, m.due_on::text, m.status
       from project_milestones m
       join client_project_requests r on r.id = m.request_id and r.org_id = m.org_id
       join organizations o on o.id = r.org_id and ${LIVE_CLIENT}
      where r.status = any($1::text[]) and m.status <> 'completed' and m.due_on is not null
      order by m.due_on, m.id`,
    [[...PROJECT_WEIGHT_STATUSES]],
  );
  return rows.map((r) => ({ id: r.id, requestId: r.request_id, orgId: r.org_id, assigneeId: r.assignee_id, title: r.title, dueOn: r.due_on, status: r.status }));
}

export interface ProjectHealthRow {
  requestId: string;
  orgId: string;
  orgName: string;
  ref: string;
  title: string;
  assigneeId: string | null;
  facts: HealthFacts;
}

/** What the health rule needs for every open project (or the ones given): one query for the projects, one for their milestones, one for their review tasks. */
export async function loadHealthFacts(db: Queryable, requestIds?: readonly string[]): Promise<ProjectHealthRow[]> {
  const filter = requestIds ? " and r.id = any($2::uuid[])" : "";
  const params: unknown[] = requestIds ? [[...PROJECT_WEIGHT_STATUSES], [...requestIds]] : [[...PROJECT_WEIGHT_STATUSES]];
  const projects = await db.query<{ id: string; org_id: string; org_name: string; ref: string; title: string; assigned_to: string | null; status: string; expected: string | null; last_activity_at: Date | string | null }>(
    `select r.id::text, r.org_id::text, o.name as org_name, r.ref, r.title, r.assigned_to::text, r.status, cp.expected_completion_on::text as expected, r.last_activity_at
       from client_project_requests r
       join organizations o on o.id = r.org_id and ${LIVE_CLIENT}
       left join client_projects cp on cp.request_id = r.id and cp.org_id = r.org_id
      where r.status = any($1::text[])${filter} order by r.created_at, r.id`,
    params,
  );
  if (!projects.rows.length) return [];
  const ids = projects.rows.map((p) => p.id);
  const milestones = await db.query<{ request_id: string; status: string; due_on: string | null }>(
    "select m.request_id::text, m.status, m.due_on::text from project_milestones m where m.request_id = any($1::uuid[])", [ids],
  );
  const tasks = await db.query<{ request_id: string; due_at: Date | string | null }>(
    "select t.request_id::text, t.due_at from project_review_tasks t where t.request_id = any($1::uuid[]) and t.status = 'open'", [ids],
  );
  return projects.rows.map((p) => ({
    requestId: p.id,
    orgId: p.org_id,
    orgName: p.org_name,
    ref: p.ref,
    title: p.title,
    assigneeId: p.assigned_to,
    facts: {
      status: p.status,
      expectedCompletionOn: p.expected,
      milestones: milestones.rows.filter((m) => m.request_id === p.id).map((m) => ({ status: m.status, dueOn: m.due_on })),
      openReviewTaskDueAts: tasks.rows.filter((t) => t.request_id === p.id).map((t) => iso(t.due_at)),
      lastActivityAt: iso(p.last_activity_at),
    },
  }));
}
