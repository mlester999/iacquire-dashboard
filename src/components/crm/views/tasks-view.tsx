import { countTaskViews, listTasks, type TaskView_ } from "@/server/crm/tasks";
import { listAssignableMembers } from "@/server/crm/contacts";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { TasksWorkspace } from "@/components/crm/tasks-workspace";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f-]{36}$/i;
const VIEWS: TaskView_[] = ["mine", "team", "overdue", "upcoming", "completed"];

export async function TasksView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams: SP }) {
  const viewRaw = one(searchParams.view) as TaskView_ | undefined;
  // Agency support sessions have no "my tasks" in a client's workspace.
  const view: TaskView_ = viewRaw && VIEWS.includes(viewRaw) ? viewRaw : actor.userId && !scope.agency ? "mine" : "team";
  const layout = one(searchParams.layout) === "board" ? "board" : "list";
  const assigneeRaw = one(searchParams.assignee);
  const assignee = assigneeRaw && UUID.test(assigneeRaw) && view !== "mine" ? assigneeRaw : null;
  const q = one(searchParams.q)?.slice(0, 80) ?? "";
  const taskId = one(searchParams.task);
  const [tasks, counts, members, recentDone, linked] = await Promise.all([
    listTasks(actor, { view, assigneeId: assignee ?? undefined, search: q, limit: 300 }),
    countTaskViews(actor),
    listAssignableMembers(actor),
    // The board shows recently finished work in its Done column.
    layout === "board" && (view === "mine" || view === "team")
      ? listTasks(actor, { view: "completed", assigneeId: view === "mine" ? actor.userId ?? undefined : assignee ?? undefined, search: q, limit: 30 })
      : Promise.resolve([]),
    taskId && UUID.test(taskId) ? listTasks(actor, { view: "all", taskId, limit: 1 }) : Promise.resolve([]),
  ]);
  await auditSupportView(actor, "tasks");
  return (
    <TasksWorkspace
      scope={scope}
      tasks={[...tasks, ...recentDone.filter((t) => !tasks.some((x) => x.id === t.id))]}
      counts={counts}
      members={members}
      state={{ view, layout, assignee, q }}
      openTask={linked[0] ?? null}
    />
  );
}
