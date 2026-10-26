import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { sortEscalations, ESCALATION_KINDS, type EscalationEntry, type EscalationKind } from "@/lib/staff-workload/escalations";
import { LABEL_TEXT } from "@/lib/staff-workload/labels";
import { canSeeItem } from "@/lib/staff-workload/visibility";
import { loadWorkloadActor, throttle, type StaffUser } from "@/server/staff-workload/access";
import { itemAccess } from "@/server/staff-workload/view";
import { SUPPORT_OPEN_STATUSES } from "@/server/staff-workload/projection";

// One list of what has been escalated or has run past its time, from the places that already track it: escalated support requests, support responses past their target,
// critical incidents nobody has acknowledged, and people the workload engine rates Overloaded or Critical. It reads those places and changes nothing in them. A support request
// or incident for a client the viewer cannot open is counted and not shown; the workload team permission is needed.

export interface Escalations {
  entries: EscalationEntry[];
  /** Entries that exist but are not shown to this viewer. */
  hidden: number;
  counts: Record<EscalationKind, number>;
  /** Support response targets are switched off, so no support request can be overdue; said on the page instead of showing none as good news. */
  supportTargetsOff: boolean;
}

interface SupportRow {
  id: string;
  org_id: string;
  org_name: string;
  ref: string;
  subject: string;
  assigned_to: string | null;
  escalated_at: Date | null;
  escalation_reason: string | null;
  response_due_at: Date | null;
}

interface IncidentRow {
  id: string;
  org_id: string | null;
  org_name: string | null;
  title: string;
  detected_at: Date;
}

interface AlertRow {
  id: string;
  user_id: string;
  name: string;
  label: "overloaded" | "critical";
  since: Date;
  critical_since: Date | null;
}

const iso = (d: Date) => new Date(d).toISOString();

export async function loadEscalations(user: StaffUser, opts: { now?: Date } = {}): Promise<Escalations> {
  const actor = await loadWorkloadActor(user);
  if (!actor.caps.team) throw new AppError("forbidden", "Seeing the whole team's workload needs the workload team permission.");
  await throttle("staffWorkloadReadByUser", user.id);
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const support = await db.query<SupportRow>(
      `select t.id::text, t.org_id::text, o.name as org_name, t.ref, t.subject, t.assigned_to::text, ops.escalated_at, ops.escalation_reason, ops.response_due_at
         from support_tickets t
         join organizations o on o.id = t.org_id and o.kind = 'client' and o.status not in ('suspended', 'archived')
         join support_ticket_ops ops on ops.ticket_id = t.id and ops.org_id = t.org_id
        where t.status in ('${SUPPORT_OPEN_STATUSES.join("', '")}') and (ops.escalated_at is not null or (ops.response_due_at is not null and ops.response_due_at < $1::timestamptz))
        order by t.id`,
      [now.toISOString()],
    );
    const incidents = await db.query<IncidentRow>(
      `select i.id::text, i.org_id::text, o.name as org_name, i.title, i.detected_at
         from incidents i left join organizations o on o.id = i.org_id
        where i.status = 'open' and i.severity = 'critical'
          and (coalesce(app.user_has_agency_permission($1::uuid, 'agency.security.manage'), false) or (i.org_id is not null and app.user_can_access_org($1::uuid, i.org_id)))
        order by i.id`,
      [actor.userId],
    );
    const alerts = await db.query<AlertRow>(
      `select a.id::text, a.user_id::text, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) as name, a.label, a.since, a.critical_since
         from staff_workload_alerts a join users u on u.id = a.user_id
        where a.resolved_at is null and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
        order by a.id`,
    );
    const targets = (await db.query<{ enabled: boolean }>("select coalesce(bool_or(targets_enabled), false) as enabled from support_settings")).rows[0]?.enabled === true;

    const access = await itemAccess(db, actor.userId, [...support.rows.map((r) => ({ orgId: r.org_id })), ...incidents.rows.filter((r) => r.org_id).map((r) => ({ orgId: r.org_id as string }))]);
    const entries: EscalationEntry[] = [];
    let hidden = 0;
    for (const r of support.rows) {
      if (!canSeeItem(access, { source: "support", orgId: r.org_id, assigneeId: r.assigned_to })) {
        hidden += 1;
        continue;
      }
      if (r.escalated_at) {
        entries.push({ kind: "support_escalated", id: r.id, orgId: r.org_id, orgName: r.org_name, title: `${r.ref}: ${r.subject}`, since: iso(r.escalated_at), critical: true, assigneeId: r.assigned_to, note: r.escalation_reason, link: `/admin/support/${r.id}` });
      } else if (r.response_due_at) {
        entries.push({ kind: "support_overdue", id: r.id, orgId: r.org_id, orgName: r.org_name, title: `${r.ref}: ${r.subject}`, since: iso(r.response_due_at), critical: false, assigneeId: r.assigned_to, note: null, link: `/admin/support/${r.id}` });
      }
    }
    for (const r of incidents.rows) {
      // A platform-wide incident has no client; the permission that listed it is the security one, which is the same gate Health uses.
      if (r.org_id && !access.accessibleOrgs.has(r.org_id)) {
        hidden += 1;
        continue;
      }
      entries.push({ kind: "incident", id: r.id, orgId: r.org_id, orgName: r.org_name, title: r.title, since: iso(r.detected_at), critical: true, assigneeId: null, note: null, link: "/admin/health" });
    }
    for (const a of alerts.rows) {
      entries.push({
        kind: "workload", id: a.id, orgId: null, orgName: null, title: `${a.name} is ${LABEL_TEXT[a.label]}`, since: iso(a.critical_since ?? a.since), critical: a.label === "critical", assigneeId: a.user_id, note: null,
        link: `/admin/workload/people/${a.user_id}`,
      });
    }
    const counts = Object.fromEntries(ESCALATION_KINDS.map((k) => [k, entries.filter((e) => e.kind === k).length])) as Record<EscalationKind, number>;
    return { entries: sortEscalations(entries), hidden, counts, supportTargetsOff: !targets };
  });
}
