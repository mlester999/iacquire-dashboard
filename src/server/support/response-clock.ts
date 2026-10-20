import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { isAwaitingAgency, type TicketPriority } from "@/lib/support/lifecycle";
import { addSupportMinutes, computeSlaState, type SlaState } from "@/lib/support/sla";
import { loadSupportSettings, responseTargetMinutes, scheduleOf, type SupportSettings } from "@/server/support/settings";
import { recordTicketEvent } from "@/server/support/events";
import { agencyHandlers, agencyManagers, dispatchSupportNotice } from "@/server/support/notify";

// The response clock answers one question: "when does the team owe this client a reply?". It runs only while the request is waiting
// on the team (new, open or in progress), starts at creation or at the client's latest message, stops when the team replies, and is
// paused while the request waits on the client. It exists only when the Super Admin turned response targets on and set a target for
// the request's priority. An automatic acknowledgement never stops it: only a person's public reply does.

export interface ClockTicket {
  id: string;
  org_id: string;
  priority: TicketPriority | string;
  status: string;
  first_responded_at: Date | string | null;
}

interface OpsClock { response_due_at: Date | null; response_kind: "first" | "follow_up" | null; response_started_at: Date | null }

async function readClock(db: Queryable, ticketId: string): Promise<OpsClock | undefined> {
  return (await db.query<OpsClock>("select response_due_at, response_kind, response_started_at from support_ticket_ops where ticket_id = $1", [ticketId])).rows[0];
}

/** Stops the clock (the team replied, the request is waiting on the client, or it is finished). */
export async function clearResponseClock(db: Queryable, ticket: Pick<ClockTicket, "id" | "org_id">): Promise<void> {
  await db.query(
    `update support_ticket_ops set response_due_at = null, response_kind = null, response_started_at = null where ticket_id = $1 and response_due_at is not null`,
    [ticket.id],
  );
}

/**
 * Starts the clock if the request is waiting on the team and no clock is running; leaves a running clock alone so a second message
 * from the client does not push the deadline out. Does nothing when targets are off or no target is set for the priority.
 */
export async function ensureResponseClock(db: Queryable, ticket: ClockTicket, opts: { startedAt?: Date; settings?: SupportSettings } = {}): Promise<void> {
  if (!isAwaitingAgency(ticket.status)) return clearResponseClock(db, ticket);
  const settings = opts.settings ?? (await loadSupportSettings(db));
  const kind = ticket.first_responded_at ? "follow_up" : "first";
  const minutes = responseTargetMinutes(settings, kind, ticket.priority);
  if (!minutes) return;
  const current = await readClock(db, ticket.id);
  if (current?.response_due_at) return;
  const started = opts.startedAt ?? new Date();
  const due = addSupportMinutes(started, minutes, scheduleOf(settings));
  await db.query(
    `insert into support_ticket_ops (ticket_id, org_id, response_due_at, response_kind, response_started_at) values ($1, $2, $3, $4, $5)
     on conflict (ticket_id) do update set response_due_at = excluded.response_due_at, response_kind = excluded.response_kind, response_started_at = excluded.response_started_at`,
    [ticket.id, ticket.org_id, due.toISOString(), kind, started.toISOString()],
  );
}

/** After a priority change: re-times a running clock from when it started, using the new priority's target. */
export async function recomputeResponseClock(db: Queryable, ticket: ClockTicket, settings?: SupportSettings): Promise<void> {
  const current = await readClock(db, ticket.id);
  if (!current?.response_due_at || !current.response_kind || !current.response_started_at) return;
  const s = settings ?? (await loadSupportSettings(db));
  const minutes = responseTargetMinutes(s, current.response_kind, ticket.priority);
  if (!minutes) {
    await clearResponseClock(db, ticket);
    return;
  }
  const due = addSupportMinutes(new Date(current.response_started_at), minutes, scheduleOf(s));
  await db.query("update support_ticket_ops set response_due_at = $2 where ticket_id = $1", [ticket.id, due.toISOString()]);
}

export interface SlaView {
  state: SlaState;
  dueAt: string | null;
  kind: "first" | "follow_up" | null;
}

/** The state to show for one request, computed from its stored due time and the current settings. */
export function slaViewFor(
  row: { status: string; response_due_at: Date | string | null; response_kind: "first" | "follow_up" | null; response_started_at: Date | string | null },
  settings: SupportSettings,
  now = new Date(),
): SlaView {
  const state = settings.targetsEnabled || row.response_due_at
    ? computeSlaState({ status: row.status, dueAt: row.response_due_at, startedAt: row.response_started_at, now, approachingPercent: settings.approachingPercent, cfg: scheduleOf(settings) })
    : row.status === "resolved" || row.status === "closed" ? "resolved" : row.status === "waiting_for_client" ? "waiting_on_client" : "none";
  return { state, dueAt: row.response_due_at ? new Date(row.response_due_at).toISOString() : null, kind: row.response_kind };
}

export interface ResponseCheckResult { approaching: number; overdue: number; escalated: number }

/**
 * Scheduled job: raises "response approaching" and "response overdue" notices and, when the Super Admin set an escalation threshold,
 * flags requests that have been overdue that long. Each notice has a key built from the request and its due time, so a run that
 * repeats (or two that overlap) notifies nobody twice, and a request whose due time moves earns a fresh notice.
 */
export async function checkResponseTargets(now = new Date()): Promise<ResponseCheckResult> {
  const out: ResponseCheckResult = { approaching: 0, overdue: 0, escalated: 0 };
  const settings = await loadSupportSettings();
  if (!settings.targetsEnabled) return out;
  const cfg = scheduleOf(settings);
  const due = await withSystem(async (db) =>
    (await db.query<{
      id: string; org_id: string; ref: string; subject: string; priority: string; status: string; assigned_to: string | null; first_responded_at: Date | null;
      response_due_at: Date; response_kind: "first" | "follow_up"; response_started_at: Date | null; escalated_at: Date | null; org_name: string;
    }>(
      `select t.id, t.org_id, t.ref, t.subject, t.priority, t.status, t.assigned_to, t.first_responded_at, o.response_due_at, o.response_kind, o.response_started_at, o.escalated_at, g.name as org_name
       from support_ticket_ops o join support_tickets t on t.id = o.ticket_id join organizations g on g.id = t.org_id
       where o.response_due_at is not null and t.status in ('new', 'open', 'in_progress')
         and o.response_due_at < $1::timestamptz + interval '3 days'
       order by o.response_due_at limit 500`,
      [now.toISOString()],
    )).rows,
  );
  for (const t of due) {
    const state = computeSlaState({ status: t.status, dueAt: t.response_due_at, startedAt: t.response_started_at, now, approachingPercent: settings.approachingPercent, cfg });
    const dueIso = new Date(t.response_due_at).toISOString();
    const what = t.response_kind === "first" ? "first reply" : "reply";
    if (state === "approaching") {
      const claimed = await withSystem(async (db) => {
        const r = await dispatchSupportNotice(db, {
          event: "response_approaching", ticket: t, eventKey: `sla:${t.id}:${dueIso}:approaching`, recipients: await agencyHandlers(db, t),
          title: `${t.ref}: ${what} due soon`, body: `${t.org_name} · ${t.subject}`, severity: "warning",
        });
        const fresh = r.delivered + r.queuedEmail + r.skipped > 0;
        if (fresh) await recordTicketEvent(db, { ticketId: t.id, orgId: t.org_id, kind: "sla_alert", actorKind: "system", to: "approaching", detail: `Response due ${dueIso}` });
        return fresh;
      });
      if (claimed) out.approaching += 1;
    } else if (state === "overdue") {
      const claimed = await withSystem(async (db) => {
        const r = await dispatchSupportNotice(db, {
          event: "response_overdue", ticket: t, eventKey: `sla:${t.id}:${dueIso}:overdue`, recipients: await agencyManagers(db, t),
          title: `${t.ref}: ${what} overdue`, body: `${t.org_name} · ${t.subject}`, severity: "warning",
        });
        const fresh = r.delivered + r.queuedEmail + r.skipped > 0;
        if (fresh) await recordTicketEvent(db, { ticketId: t.id, orgId: t.org_id, kind: "sla_alert", actorKind: "system", to: "overdue", detail: `Response was due ${dueIso}` });
        return fresh;
      });
      if (claimed) out.overdue += 1;
      // Past the escalation threshold: flag it for managers once. This changes nothing about the request's priority.
      if (settings.overdueEscalationMinutes && !t.escalated_at) {
        const lateBy = (now.getTime() - new Date(t.response_due_at).getTime()) / 60_000;
        if (lateBy >= settings.overdueEscalationMinutes) {
          const flagged = await withSystem(async (db) => {
            const res = await db.query(
              `insert into support_ticket_ops (ticket_id, org_id, escalated_at, escalation_reason) values ($1, $2, now(), $3)
               on conflict (ticket_id) do update set escalated_at = now(), escalation_reason = excluded.escalation_reason where support_ticket_ops.escalated_at is null`,
              [t.id, t.org_id, `Reply overdue by more than ${settings.overdueEscalationMinutes} minutes.`],
            );
            if (!res.rowCount) return false;
            const eventId = await recordTicketEvent(db, { ticketId: t.id, orgId: t.org_id, kind: "escalated", actorKind: "system", detail: `Escalated automatically: reply overdue by more than ${settings.overdueEscalationMinutes} minutes.` });
            await dispatchSupportNotice(db, {
              event: "priority_escalated", ticket: t, eventKey: `ev:${eventId}`, recipients: await agencyManagers(db, t),
              title: `${t.ref} was escalated`, body: `${t.org_name} · reply overdue`, severity: "critical",
            });
            return true;
          });
          if (flagged) out.escalated += 1;
        }
      }
    }
  }
  return out;
}
