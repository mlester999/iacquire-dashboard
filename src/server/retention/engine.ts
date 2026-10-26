import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";
import { getConsent } from "@/server/messaging/contacts";
import { queueOutreach } from "@/server/messaging/outreach";
import { cancelRetention } from "@/server/retention/cancel";
import { queueFeedbackLinkStep } from "@/server/reputation/program-link";
import { DAILY_ENROLLMENT_CAP, DEFAULT_PROGRAMS, hasFeedbackLink, REENGAGEMENT_COOLDOWN_DAYS, renderStep, STALE_STEP_DAYS, STOP_REASONS, stepDueAt, type ProgramKind, type ProgramPurpose, type ProgramStep, type ProgramTrigger } from "@/lib/retention";
import { contactAddress } from "@/server/messaging/contacts";
import type { Channel } from "@/lib/messaging";

export interface ProgramRow {
  id: string;
  org_id: string;
  kind: ProgramKind;
  name: string;
  trigger: ProgramTrigger;
  purpose: ProgramPurpose;
  steps: ProgramStep[];
  business_hours_only: boolean;
  inactive_days: number | null;
  enabled: boolean;
  content_hash: string;
  approved_hash: string | null;
  approval_id: string | null;
  approved_at: Date | null;
}

/** What the owner approves is exactly this: who gets it, under what purpose, when, and the words. Any change to it withdraws the approval. */
export function programHash(p: { kind: string; trigger: string; purpose: string; steps: ProgramStep[]; businessHoursOnly: boolean; inactiveDays: number | null }): string {
  const canonical = JSON.stringify([p.kind, p.trigger, p.purpose, p.businessHoursOnly, p.inactiveDays, p.steps.map((s) => [s.key, s.delayDays, s.body.trim()])]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Makes sure the workspace has the five standard programs, all switched off. Safe to call repeatedly; existing programs are never touched. */
export async function ensureDefaultPrograms(db: Queryable, orgId: string): Promise<void> {
  for (const d of DEFAULT_PROGRAMS) {
    await db.query(
      `insert into retention_programs (org_id, kind, name, description, trigger, purpose, steps, business_hours_only, inactive_days, content_hash)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) on conflict (org_id, kind) do nothing`,
      [orgId, d.kind, d.name, d.description, d.trigger, d.purpose, JSON.stringify(d.steps), d.businessHoursOnly, d.inactiveDays, programHash({ ...d, businessHoursOnly: d.businessHoursOnly, inactiveDays: d.inactiveDays })],
    );
  }
}

/** A program sends only while it is switched on, approved in exactly its current wording, and the owner's authorization has not lapsed. */
const ACTIVE_PROGRAMS = `
  select p.*, a.expires_at as approval_expires_at from retention_programs p join organizations o on o.id = p.org_id
  left join approval_requests a on a.id = p.approval_id and a.org_id = p.org_id and a.status = 'approved'
  where p.enabled and p.approved_hash = p.content_hash and o.status = 'active' and a.id is not null and (a.expires_at is null or a.expires_at > $1)`;

interface ActiveProgram extends ProgramRow {
  approval_expires_at: Date | null;
}

async function createEnrollment(db: Queryable, p: ProgramRow, contactId: string, triggerRef: string, base: Date): Promise<boolean> {
  const e = await db.query<{ id: string }>(
    "insert into retention_enrollments (org_id, program_id, contact_id, trigger_ref, started_at) values ($1, $2, $3, $4, now()) on conflict (program_id, contact_id, trigger_ref) do nothing returning id",
    [p.org_id, p.id, contactId, triggerRef],
  );
  if (!e.rows[0]) return false;
  for (const s of p.steps) {
    await db.query("insert into retention_steps (org_id, enrollment_id, step_key, due_at) values ($1, $2, $3, $4) on conflict do nothing", [p.org_id, e.rows[0].id, s.key, stepDueAt(base, s.delayDays).toISOString()]);
  }
  return true;
}

/**
 * Enrols customers into the programs that are on. Only people who became eligible AFTER the program was approved are enrolled, so
 * switching a program on never messages the existing customer base. Each cause (a customer-since moment, an attended appointment)
 * enrols a person at most once, and promotional re-engagement is rationed to a few people a day.
 */
export async function enrollEligible(now = new Date()): Promise<{ enrolled: number }> {
  return withSystem(async (db) => {
    const programs = (await db.query<ActiveProgram>(ACTIVE_PROGRAMS, [now.toISOString()])).rows;
    let enrolled = 0;
    for (const p of programs) {
      const since = p.approved_at ? new Date(p.approved_at) : now;
      if (p.trigger === "customer_created") {
        const rows = await db.query<{ id: string; customer_since: Date }>(
          `select id, customer_since from contacts where org_id = $1 and deleted_at is null and not retention_paused and lifecycle_stage in ('customer', 'retention') and customer_since >= $2 order by customer_since limit 50`,
          [p.org_id, since.toISOString()],
        );
        for (const c of rows.rows) if (await createEnrollment(db, p, c.id, "customer", new Date(c.customer_since))) enrolled += 1;
      } else if (p.trigger === "appointment_showed") {
        const rows = await db.query<{ id: string; contact_id: string; end_at: Date }>(
          `select a.id, a.contact_id, a.end_at from appointment_refs a join contacts c on c.id = a.contact_id and c.org_id = a.org_id
           where a.org_id = $1 and a.status = 'showed' and coalesce(a.last_event_at, a.remote_updated_at, a.synced_at) >= $2 and a.end_at > $3::timestamptz - interval '30 days'
             and c.deleted_at is null and not c.retention_paused order by a.start_at limit 50`,
          [p.org_id, since.toISOString(), now.toISOString()],
        );
        for (const a of rows.rows) if (await createEnrollment(db, p, a.contact_id, a.id, new Date(a.end_at))) enrolled += 1;
      } else if (p.trigger === "inactive" && p.inactive_days) {
        const today = await db.query<{ n: string }>("select count(*)::text as n from retention_enrollments where program_id = $1 and started_at > $2::timestamptz - interval '1 day'", [p.id, now.toISOString()]);
        let room = DAILY_ENROLLMENT_CAP - Number(today.rows[0].n);
        if (room <= 0) continue;
        const rows = await db.query<{ id: string }>(
          `select c.id from contacts c
           where c.org_id = $1 and c.deleted_at is null and not c.retention_paused and c.lifecycle_stage in ('customer', 'retention')
             and c.customer_since < $2::timestamptz - make_interval(days => $3)
             and greatest(c.customer_since, coalesce((select max(v.last_message_at) from conversations v where v.org_id = c.org_id and v.contact_id = c.id), c.customer_since)) < $2::timestamptz - make_interval(days => $3)
             and not exists (select 1 from retention_enrollments e where e.program_id = $4 and e.contact_id = c.id and e.started_at > $2::timestamptz - make_interval(days => $5))
           order by c.customer_since limit 40`,
          [p.org_id, now.toISOString(), p.inactive_days, p.id, REENGAGEMENT_COOLDOWN_DAYS],
        );
        for (const c of rows.rows) {
          if (room <= 0) break;
          // Promotional: only someone who has explicitly agreed, on a channel we can actually reach them on.
          let consented = false;
          for (const channel of ["sms", "whatsapp", "email"] as Channel[]) {
            if ((await contactAddress(db, p.org_id, c.id, channel)) && (await getConsent(db, p.org_id, c.id, channel, "marketing")) === "granted") consented = true;
          }
          if (!consented) continue;
          if (await createEnrollment(db, p, c.id, `inactive:${now.toISOString().slice(0, 7)}`, now)) {
            enrolled += 1;
            room -= 1;
          }
        }
      }
    }
    return { enrolled };
  });
}

interface Claimed {
  id: string;
  org_id: string;
  enrollment_id: string;
  step_key: string;
  due_at: Date;
}

const closeIfFinished = async (db: Queryable, enrollmentId: string) => {
  await db.query(
    `update retention_enrollments e set status = 'completed', closed_at = now() where e.id = $1 and e.status = 'active'
       and not exists (select 1 from retention_steps s where s.enrollment_id = e.id and s.status in ('scheduled', 'queued'))`,
    [enrollmentId],
  );
};

/**
 * Prepares the messages that have come due, through the same rule chain as every other customer message. A step is skipped, not sent
 * late, if it is more than a week overdue; cancelled if the customer is no longer in the audience; blocked if the program is no longer
 * approved. A reason that means "never contact this person this way" (opt-out, no consent, a person taking over, an exhausted
 * balance) cancels the rest of that customer's program instead of retrying.
 */
export async function prepareDueSteps(opts: { now?: Date; limit?: number } = {}): Promise<{ queued: number; blocked: number; skipped: number; reconciled: number }> {
  const now = opts.now ?? new Date();
  const out = { queued: 0, blocked: 0, skipped: 0, reconciled: 0 };

  out.reconciled = await withSystem(async (db) => {
    await db.query("update retention_steps set status = 'scheduled' where status = 'queued' and message_id is null and updated_at < $1::timestamptz - interval '10 minutes'", [now.toISOString()]);
    const done = await db.query<{ enrollment_id: string; org_id: string; reason: string | null; contact_id: string }>(
      `update retention_steps s set status = case when m.status in ('sent', 'delivered', 'read') then 'sent' else 'blocked' end,
         reason = case when m.status in ('sent', 'delivered', 'read') then null else coalesce(m.blocked_reason, 'The message could not be sent.') end
       from conversation_messages m where m.id = s.message_id and s.status = 'queued' and m.status in ('sent', 'delivered', 'read', 'failed', 'blocked')
       returning s.enrollment_id, s.org_id, s.reason, (select e.contact_id from retention_enrollments e where e.id = s.enrollment_id) as contact_id`,
    );
    for (const r of done.rows) {
      await closeIfFinished(db, r.enrollment_id);
      // A message stopped at the moment of sending for a "never this way" reason (an opt-out, a pause, a person taking over) ends the customer's whole program.
      if (r.reason && STOP_REASONS.has(r.reason)) await cancelRetention(db, r.org_id, r.contact_id, r.reason);
    }
    return done.rowCount;
  });

  const claimed = await withSystem(async (db) =>
    (await db.query<Claimed>(
      `update retention_steps set status = 'queued' where id in (
         select s.id from retention_steps s join retention_enrollments e on e.id = s.enrollment_id and e.org_id = s.org_id
         where s.status = 'scheduled' and s.due_at <= $1 and e.status = 'active' order by s.due_at limit $2 for update of s skip locked)
       returning id, org_id, enrollment_id, step_key, due_at`,
      [now.toISOString(), Math.min(100, opts.limit ?? 25)],
    )).rows,
  );

  for (const s of claimed) {
    await withSystem(async (db) => {
      const ctx = (await db.query<{
        program_id: string; kind: ProgramKind; purpose: ProgramPurpose; steps: ProgramStep[]; trigger: ProgramTrigger; enabled: boolean; content_hash: string; approved_hash: string | null; approval_id: string | null;
        business_hours_only: boolean; approval_live: boolean | null; contact_id: string; contact_name: string; deleted_at: Date | null; paused: boolean; stage: string; trigger_ref: string; org_name: string;
        org_timezone: string | null; agent_id: string | null; appt_status: string | null;
      }>(
        `select p.id as program_id, p.kind, p.purpose, p.steps, p.trigger, p.enabled, p.content_hash, p.approved_hash, p.approval_id, p.business_hours_only,
           (select a.status = 'approved' and (a.expires_at is null or a.expires_at > $2) from approval_requests a where a.id = p.approval_id) as approval_live,
           c.id as contact_id, c.display_name as contact_name, c.deleted_at, c.retention_paused as paused, c.lifecycle_stage as stage, e.trigger_ref, o.name as org_name, o.timezone as org_timezone,
           (select g.id from agent_instances g where g.org_id = p.org_id and g.role_key = 'crm_manager') as agent_id,
           (select r.status from appointment_refs r where p.trigger = 'appointment_showed' and r.id::text = e.trigger_ref and r.org_id = p.org_id) as appt_status
         from retention_enrollments e join retention_programs p on p.id = e.program_id and p.org_id = e.org_id
         join contacts c on c.id = e.contact_id and c.org_id = e.org_id join organizations o on o.id = e.org_id where e.id = $1`,
        [s.enrollment_id, now.toISOString()],
      )).rows[0];
      const finish = async (status: "skipped" | "blocked" | "cancelled" | "queued", reason: string | null, messageId: string | null = null) => {
        await db.query("update retention_steps set status = $2, reason = $3, message_id = $4 where id = $1", [s.id, status, reason, messageId]);
        if (status !== "queued") await closeIfFinished(db, s.enrollment_id);
      };
      const stopAll = async (reason: string) => {
        await cancelRetention(db, s.org_id, ctx.contact_id, reason);
        await db.query("update retention_steps set status = 'blocked', reason = $2 where id = $1 and status in ('queued')", [s.id, reason]);
      };
      if (!ctx) return finish("cancelled", "enrollment_missing");
      if (!ctx.enabled) {
        out.skipped += 1;
        return finish("cancelled", "program_off");
      }
      if (ctx.approved_hash !== ctx.content_hash || !ctx.approval_live) {
        await notifyOrgRoles(db, s.org_id, ["owner"], { kind: "retention_attention", severity: "warning", title: "A customer program needs your approval", body: "It stopped sending because its wording changed or your authorization lapsed.", link: "/retention", dedupeKey: `retention-auth:${s.org_id}:${ctx.kind}:${now.toISOString().slice(0, 10)}` });
        out.blocked += 1;
        return finish("blocked", "authorization_needed");
      }
      if (ctx.deleted_at || ctx.paused) {
        out.skipped += 1;
        await cancelRetention(db, s.org_id, ctx.contact_id, ctx.paused ? "contact_excluded" : "contact_removed");
        return;
      }
      if (ctx.trigger === "customer_created" && !["customer", "retention"].includes(ctx.stage)) {
        out.skipped += 1;
        await cancelRetention(db, s.org_id, ctx.contact_id, "no_longer_customer");
        return;
      }
      if (ctx.trigger === "appointment_showed" && ctx.appt_status !== "showed") {
        out.skipped += 1;
        return finish("cancelled", "appointment_changed");
      }
      if (now.getTime() - new Date(s.due_at).getTime() > STALE_STEP_DAYS * 86_400_000) {
        out.skipped += 1;
        return finish("skipped", "too_late");
      }
      const step = ctx.steps.find((x) => x.key === s.step_key);
      if (!step) return finish("cancelled", "step_removed");

      // A step with {feedback_link} carries the customer's own private link: it goes by a channel they agreed to service messages on, once per cool-down, and the request behind
      // the link is created with the message (src/server/reputation/program-link.ts). Every other step is the plain message it always was.
      const res = hasFeedbackLink(step.body)
        ? await queueFeedbackLinkStep(db, {
            orgId: s.org_id, orgName: ctx.org_name, orgTimezone: ctx.org_timezone || "UTC", contactId: ctx.contact_id, contactName: ctx.contact_name, agentId: ctx.agent_id, programKind: ctx.kind,
            purpose: ctx.purpose, body: step.body, businessHoursOnly: ctx.business_hours_only, approvalId: ctx.approval_id, stepId: s.id,
            triggerRef: ctx.trigger === "appointment_showed" ? ctx.trigger_ref : null, now,
          })
        : await queueOutreach(db, {
            orgId: s.org_id, contactId: ctx.contact_id, agentId: ctx.agent_id, scope: "retention", purpose: ctx.purpose, subject: ctx.org_name, approvalId: ctx.approval_id, now,
            body: renderStep(step.body, { name: ctx.contact_name, business: ctx.org_name }), dedupeKey: `retention:${s.id}`, disclose: true, businessHoursOnly: ctx.business_hours_only,
          });
      if (res.status === "blocked") {
        out.blocked += 1;
        await finish("blocked", res.reason ?? "blocked");
        if (res.reason && STOP_REASONS.has(res.reason)) await stopAll(res.reason);
        return;
      }
      out.queued += 1;
      await finish("queued", null, res.messageId ?? null);
    });
  }
  return out;
}
