import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import type { CrmActor } from "@/server/crm/actor";
import { assertAssignable, normalizeContactInput, updateContact } from "@/server/crm/contacts";
import { applyContactTags, removeContactTags } from "@/server/crm/tags";
import { createTaskInTx } from "@/server/crm/tasks";
import { createOpportunityInTx, moveOpportunityInTx } from "@/server/crm/opportunities";
import { assertNativeOwner } from "@/server/crm/workspace";
import { bookingIsNative, nativeAvailability } from "@/server/calendars/agent-booking";
import { requestBooking } from "@/server/appointments/booking";
import { createApproval } from "@/server/approvals/service";
import { maskCustomerLinks } from "@/server/messaging/redact";
import type { AgentToolName, ToolInput } from "@/server/crm/agent-tools/catalog";

/**
 * What each CRM tool does. Every query names the organization from the agent actor (which came from the token row), so an id from
 * another workspace is simply "not found". Writes go through the same in-transaction CRM services people use, so events, timeline
 * entries, duplicate rules and provider ownership apply unchanged; the actor is the AI employee, so the timeline says who did it.
 */

export interface ToolContext {
  actor: CrmActor;
  agent: { id: string; roleKey: string; displayName: string };
  runId: string | null;
  /** Set when a person approved this call and it is now being carried out. */
  approvalId: string | null;
  /** Stable for one logical call; where a retry must never repeat a change, it is part of the idempotency key. */
  callKey: string;
  now: Date;
}

/** What a write would do, worked out against the workspace's current records before it runs or is sent for approval. */
export interface WritePlan {
  /** Lower-case verb phrase: "update Maria Santos's details". */
  summary: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  expectedEffect: string;
  /** Why this call always needs a person, whatever the employee's mode. Null for an ordinary change. */
  highImpact: string | null;
  contactId: string | null;
  opportunityId: string | null;
}

export type ToolOutcome = "done" | "draft" | "pending_approval" | "unavailable";

export interface ToolOutput {
  outcome: ToolOutcome;
  result: Record<string, unknown>;
  /** One line for the activity log. */
  summary: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  approvalId?: string | null;
}

interface Handler<N extends AgentToolName> {
  /** Runs inside the caller's transaction (true), or opens its own through a CRM service (false). */
  inTx: boolean;
  plan?: (db: Queryable, ctx: ToolContext, input: ToolInput<N>) => Promise<WritePlan>;
  run: (ctx: ToolContext, input: ToolInput<N>, db: Queryable | null) => Promise<ToolOutput>;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const quote = (s: string, max = 60) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const need = (db: Queryable | null): Queryable => {
  if (!db) throw new Error("This tool runs inside a transaction.");
  return db;
};

async function contactLabel(db: Queryable, orgId: string, contactId: string): Promise<string> {
  const { rows } = await db.query<{ display_name: string; email: string | null; phone: string | null }>(
    "select display_name, email::text as email, phone from contacts where id = $1 and org_id = $2 and deleted_at is null",
    [contactId, orgId],
  );
  const c = rows[0];
  if (!c) throw new AppError("not_found", "Contact not found.");
  return c.display_name || c.email || c.phone || "a contact";
}

async function contactsLabelled(db: Queryable, orgId: string, ids: string[]): Promise<Array<{ id: string; label: string }>> {
  const unique = [...new Set(ids)];
  const { rows } = await db.query<{ id: string; label: string }>(
    "select id, coalesce(nullif(display_name, ''), email::text, phone, 'a contact') as label from contacts where org_id = $1 and id = any($2::uuid[]) and deleted_at is null",
    [orgId, unique],
  );
  if (rows.length !== unique.length) throw new AppError("not_found", unique.length === 1 ? "Contact not found." : "One or more of those contacts weren't found.");
  return unique.map((id) => rows.find((r) => r.id === id) as { id: string; label: string });
}

async function tagsByName(db: Queryable, orgId: string, names: string[]): Promise<Array<{ id: string; name: string }>> {
  const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()))];
  const { rows } = await db.query<{ id: string; name: string }>("select id, name::text as name from crm_tags where org_id = $1 and lower(name::text) = any($2::text[])", [orgId, wanted]);
  const missing = wanted.filter((w) => !rows.some((r) => r.name.toLowerCase() === w));
  if (missing.length) throw new AppError("not_found", `No tag named ${quote(missing[0], 50)} exists in this workspace. A person can create it in Tags & Segments.`);
  return rows;
}

const CONTACT_FIELD_LABELS: Record<string, string> = {
  firstName: "first name", lastName: "last name", leadStatus: "lead status", leadScore: "lead score", preferredLanguage: "language", preferredChannel: "preferred channel",
  timezone: "time zone", city: "city", region: "region", country: "country", postalCode: "postal code", source: "source",
};

function describeChanges(changes: Record<string, unknown>): string {
  return Object.entries(changes)
    .map(([k, v]) => `${CONTACT_FIELD_LABELS[k] ?? k} → ${v === null || v === "" ? "(cleared)" : String(v).replace(/_/g, " ").slice(0, 80)}`)
    .join("; ");
}

function contactPatch(changes: ToolInput<"update_contact">["changes"]) {
  const patch: Record<string, unknown> = { ...changes };
  if (typeof patch.country === "string") patch.country = patch.country.toUpperCase();
  return patch as Parameters<typeof updateContact>[2];
}

async function stageInfo(db: Queryable, orgId: string, stageId: string) {
  const { rows } = await db.query<{ id: string; kind: "open" | "won" | "lost"; name: string; pipeline_id: string }>(
    "select s.id, s.kind, s.name, s.pipeline_id from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id and p.archived_at is null where s.id = $1 and s.org_id = $2 and s.archived_at is null",
    [stageId, orgId],
  );
  if (!rows[0]) throw new AppError("not_found", "Stage not found.");
  return rows[0];
}

/** The conversation, only when this employee handles it and the customer still exists. Anything else is "not found". */
async function permittedConversation(db: Queryable, ctx: ToolContext, conversationId: string) {
  const { rows } = await db.query<{ id: string; contact_id: string; channel: string; owner_kind: string; contact_name: string }>(
    `select c.id, c.contact_id, c.channel, c.owner_kind, coalesce(nullif(k.display_name, ''), 'a customer') as contact_name
     from conversations c join contacts k on k.id = c.contact_id and k.org_id = c.org_id
     where c.id = $1 and c.org_id = $2 and c.ai_agent_id = $3 and k.deleted_at is null`,
    [conversationId, ctx.actor.orgId, ctx.agent.id],
  );
  if (!rows[0]) throw new AppError("not_found", "Conversation not found, or it isn't one this AI employee handles.");
  return rows[0];
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export const HANDLERS: { [N in AgentToolName]: Handler<N> } = {
  find_contacts: {
    inTx: true,
    async run(ctx, input, db) {
      const q = need(db);
      const term = input.query.trim().toLowerCase();
      const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const { rows } = await q.query<{ id: string; name: string; email: string | null; phone: string | null; lead_status: string; last_activity_at: Date | null }>(
        `select c.id, c.display_name as name, c.email::text as email, c.phone, c.lead_status, c.last_activity_at from contacts c
         where c.org_id = $1 and c.deleted_at is null and c.archived_at is null and c.search_text like $2 escape '\\'
         order by c.last_activity_at desc nulls last, c.created_at desc limit $3`,
        [ctx.actor.orgId, like, input.limit ?? 10],
      );
      return {
        outcome: "done",
        summary: `Searched contacts (${plural(rows.length, "match", "matches")})`,
        result: { contacts: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, leadStatus: r.lead_status, lastActivityAt: iso(r.last_activity_at) })) },
      };
    },
  },

  get_contact: {
    inTx: true,
    async run(ctx, input, db) {
      const q = need(db);
      const orgId = ctx.actor.orgId;
      const { rows } = await q.query<{
        id: string; display_name: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; lead_status: string; lead_score: number | null;
        source: string | null; timezone: string | null; preferred_language: string | null; preferred_channel: string | null; city: string | null; region: string | null; country: string | null;
        created_at: Date; last_activity_at: Date | null; owner_name: string | null;
      }>(
        `select c.id, c.display_name, c.first_name, c.last_name, c.email::text as email, c.phone, c.lead_status, c.lead_score, c.source, c.timezone, c.preferred_language,
                c.preferred_channel, c.city, c.region, c.country, c.created_at, c.last_activity_at, nullif(u.full_name, '') as owner_name
         from contacts c left join users u on u.id = c.assigned_user_id where c.id = $1 and c.org_id = $2 and c.deleted_at is null`,
        [input.contactId, orgId],
      );
      const c = rows[0];
      if (!c) throw new AppError("not_found", "Contact not found.");
      const [tags, deals, tasks, appts] = [
        await q.query<{ name: string }>("select t.name::text as name from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id where ct.org_id = $1 and ct.contact_id = $2 order by t.name limit 30", [orgId, c.id]),
        ctx.actor.can("sales.view")
          ? await q.query<{ id: string; name: string; status: string; stage_name: string | null; value: string | null; currency: string | null }>(
            "select id, name, status, stage_name, monetary_value::text as value, currency from crm_opportunities where org_id = $1 and contact_id = $2 and provider = 'native' and archived_at is null order by updated_at desc limit 10",
            [orgId, c.id],
          )
          : null,
        await q.query<{ id: string; title: string; due_at: Date | null; status: string }>(
          "select id, title, due_at, status from tasks where org_id = $1 and contact_id = $2 and status in ('open', 'in_progress') order by due_at nulls last, created_at limit 10",
          [orgId, c.id],
        ),
        await q.query<{ id: string; title: string; start_at: Date; status: string }>(
          "select id, title, start_at, status from appointment_refs where org_id = $1 and contact_id = $2 and start_at > now() and status not in ('cancelled', 'invalid') order by start_at limit 5",
          [orgId, c.id],
        ),
      ];
      return {
        outcome: "done",
        summary: `Read ${c.display_name || "a contact"}`,
        targetType: "contact", targetId: c.id, targetLabel: c.display_name,
        result: {
          contact: {
            id: c.id, name: c.display_name, firstName: c.first_name, lastName: c.last_name, email: c.email, phone: c.phone, leadStatus: c.lead_status, leadScore: c.lead_score,
            source: c.source, timezone: c.timezone, preferredLanguage: c.preferred_language, preferredChannel: c.preferred_channel, city: c.city, region: c.region, country: c.country,
            owner: c.owner_name, createdAt: iso(c.created_at), lastActivityAt: iso(c.last_activity_at), tags: tags.rows.map((t) => t.name),
          },
          openDeals: deals ? deals.rows.map((d) => ({ id: d.id, name: d.name, status: d.status, stage: d.stage_name, value: d.value === null ? null : Number(d.value), currency: d.currency })) : undefined,
          openTasks: tasks.rows.map((t) => ({ id: t.id, title: t.title, dueAt: iso(t.due_at), status: t.status })),
          upcomingAppointments: ctx.actor.can("appointments.view") ? appts.rows.map((a) => ({ id: a.id, title: a.title, startAt: iso(a.start_at), status: a.status })) : undefined,
        },
      };
    },
  },

  update_contact: {
    inTx: false,
    async plan(db, ctx, input) {
      // A change that can't be made here (contacts managed in GoHighLevel) is refused now, never sent to a person for approval.
      await assertNativeOwner(db, ctx.actor.orgId, "contacts");
      const label = await contactLabel(db, ctx.actor.orgId, input.contactId);
      // Refuse an invalid value now, so a person is never asked to approve something that cannot be applied.
      normalizeContactInput({ ...contactPatch(input.changes), email: null, phone: null }, null);
      const what = Object.keys(input.changes).map((k) => CONTACT_FIELD_LABELS[k] ?? k).join(", ");
      return {
        summary: `update ${label}'s ${what}`, targetType: "contact", targetId: input.contactId, targetLabel: label,
        expectedEffect: `${label}: ${describeChanges(input.changes)}.`, highImpact: null, contactId: input.contactId, opportunityId: null,
      };
    },
    async run(ctx, input) {
      const r = await updateContact(ctx.actor, input.contactId, contactPatch(input.changes));
      return {
        outcome: "done",
        summary: r.changed.length ? `Updated ${r.changed.map((k) => CONTACT_FIELD_LABELS[k] ?? k).join(", ")}` : "Nothing needed changing",
        targetType: "contact", targetId: input.contactId,
        result: { contactId: input.contactId, changed: r.changed, version: r.version },
      };
    },
  },

  apply_tag: {
    inTx: true,
    async plan(db, ctx, input) {
      await assertNativeOwner(db, ctx.actor.orgId, "contacts");
      const contacts = await contactsLabelled(db, ctx.actor.orgId, input.contactIds);
      const tags = await tagsByName(db, ctx.actor.orgId, input.tags);
      const who = contacts.length === 1 ? contacts[0].label : plural(contacts.length, "contact");
      const names = tags.map((t) => quote(t.name, 40)).join(", ");
      return {
        summary: `add ${tags.length === 1 ? "the tag" : "the tags"} ${names} to ${who}`, targetType: "contact", targetId: contacts.length === 1 ? contacts[0].id : `${contacts.length} contacts`,
        targetLabel: who, expectedEffect: `${names} ${tags.length === 1 ? "is" : "are"} added to ${who}. Workflows that start on a tag may run.`,
        highImpact: contacts.length > 1 ? "It changes more than one contact at once." : null, contactId: contacts.length === 1 ? contacts[0].id : null, opportunityId: null,
      };
    },
    async run(ctx, input, db) {
      const q = need(db);
      await assertNativeOwner(q, ctx.actor.orgId, "contacts");
      const contacts = await contactsLabelled(q, ctx.actor.orgId, input.contactIds);
      const tags = await tagsByName(q, ctx.actor.orgId, input.tags);
      const added = await applyContactTags(q, ctx.actor, contacts.map((c) => c.id), tags.map((t) => t.id), "agent");
      return {
        outcome: "done", summary: `Added ${plural(added, "tag")}`, targetType: "contact", targetId: contacts.length === 1 ? contacts[0].id : `${contacts.length} contacts`,
        targetLabel: contacts.length === 1 ? contacts[0].label : plural(contacts.length, "contact"), result: { added, contacts: contacts.length, tags: tags.map((t) => t.name) },
      };
    },
  },

  remove_tag: {
    inTx: true,
    async plan(db, ctx, input) {
      await assertNativeOwner(db, ctx.actor.orgId, "contacts");
      const contacts = await contactsLabelled(db, ctx.actor.orgId, input.contactIds);
      const tags = await tagsByName(db, ctx.actor.orgId, input.tags);
      const who = contacts.length === 1 ? contacts[0].label : plural(contacts.length, "contact");
      const names = tags.map((t) => quote(t.name, 40)).join(", ");
      return {
        summary: `remove ${tags.length === 1 ? "the tag" : "the tags"} ${names} from ${who}`, targetType: "contact", targetId: contacts.length === 1 ? contacts[0].id : `${contacts.length} contacts`,
        targetLabel: who, expectedEffect: `${names} ${tags.length === 1 ? "is" : "are"} removed from ${who}.`,
        highImpact: contacts.length > 1 ? "It changes more than one contact at once." : null, contactId: contacts.length === 1 ? contacts[0].id : null, opportunityId: null,
      };
    },
    async run(ctx, input, db) {
      const q = need(db);
      await assertNativeOwner(q, ctx.actor.orgId, "contacts");
      const contacts = await contactsLabelled(q, ctx.actor.orgId, input.contactIds);
      const tags = await tagsByName(q, ctx.actor.orgId, input.tags);
      const removed = await removeContactTags(q, ctx.actor, contacts.map((c) => c.id), tags.map((t) => t.id));
      return {
        outcome: "done", summary: `Removed ${plural(removed, "tag")}`, targetType: "contact", targetId: contacts.length === 1 ? contacts[0].id : `${contacts.length} contacts`,
        targetLabel: contacts.length === 1 ? contacts[0].label : plural(contacts.length, "contact"), result: { removed, contacts: contacts.length, tags: tags.map((t) => t.name) },
      };
    },
  },

  create_task: {
    inTx: true,
    async plan(db, ctx, input) {
      const orgId = ctx.actor.orgId;
      const label = input.contactId ? await contactLabel(db, orgId, input.contactId) : null;
      if (input.opportunityId) {
        const o = await db.query("select 1 from crm_opportunities where id = $1 and org_id = $2 and archived_at is null", [input.opportunityId, orgId]);
        if (!o.rows[0]) throw new AppError("not_found", "Deal not found.");
      }
      const assignee = input.assigneeId ? await assertAssignable(db, orgId, input.assigneeId) : null;
      return {
        summary: `create the task ${quote(input.title)}${label ? ` for ${label}` : ""}`, targetType: "task", targetId: input.contactId ?? input.opportunityId ?? "new", targetLabel: input.title.slice(0, 200),
        expectedEffect: `A task ${quote(input.title)} is added${assignee ? ` and assigned to ${assignee.name}` : ""}${input.dueAt ? `, due ${input.dueAt.slice(0, 16).replace("T", " ")}` : ""}.`,
        highImpact: null, contactId: input.contactId ?? null, opportunityId: input.opportunityId ?? null,
      };
    },
    async run(ctx, input, db) {
      const q = need(db);
      const r = await createTaskInTx(q, ctx.actor, {
        title: input.title, description: input.description ?? null, dueAt: input.dueAt ?? null, priority: input.priority, contactId: input.contactId ?? null,
        opportunityId: input.opportunityId ?? null, assigneeId: input.assigneeId ?? null,
      }, { source: "agent" });
      return { outcome: "done", summary: `Created the task ${quote(input.title)}`, targetType: "task", targetId: r.id, targetLabel: input.title.slice(0, 200), result: { taskId: r.id } };
    },
  },

  create_opportunity: {
    inTx: true,
    async plan(db, ctx, input) {
      const orgId = ctx.actor.orgId;
      await assertNativeOwner(db, orgId, "opportunities");
      const label = input.contactId ? await contactLabel(db, orgId, input.contactId) : null;
      if (input.stageId) {
        const s = await stageInfo(db, orgId, input.stageId);
        if (s.kind !== "open") throw new AppError("invalid_input", "New deals start in an open stage.");
        if (input.pipelineId && s.pipeline_id !== input.pipelineId) throw new AppError("invalid_input", "That stage isn't in this pipeline.");
      } else if (input.pipelineId) {
        const p = await db.query("select 1 from crm_pipelines where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [input.pipelineId, orgId]);
        if (!p.rows[0]) throw new AppError("not_found", "Pipeline not found.");
      }
      const value = input.value !== undefined ? ` worth ${input.value.toLocaleString("en-US")} ${(input.currency ?? "").toUpperCase()}`.trimEnd() : "";
      return {
        summary: `create the deal ${quote(input.name)}${label ? ` for ${label}` : ""}`, targetType: "crm_opportunity", targetId: input.contactId ?? "new", targetLabel: input.name.slice(0, 200),
        expectedEffect: `A deal ${quote(input.name)}${value} is added to the pipeline. Workflows that start on a new deal may run.`,
        highImpact: null, contactId: input.contactId ?? null, opportunityId: null,
      };
    },
    async run(ctx, input, db) {
      const q = need(db);
      const r = await createOpportunityInTx(q, ctx.actor, {
        name: input.name, contactId: input.contactId ?? null, pipelineId: input.pipelineId ?? null, stageId: input.stageId ?? null, value: input.value ?? null,
        currency: input.currency ? input.currency.toUpperCase() : null, expectedCloseDate: input.expectedCloseDate ?? null, description: input.description ?? null,
      }, { via: "agent", idempotencyKey: `agent-tool:${ctx.approvalId ?? ctx.callKey}`.slice(0, 200) });
      return {
        outcome: "done", summary: r.created ? `Created the deal ${quote(input.name)}` : `The deal ${quote(input.name)} already existed`, targetType: "crm_opportunity", targetId: r.id,
        targetLabel: input.name.slice(0, 200), result: { opportunityId: r.id, created: r.created },
      };
    },
  },

  move_opportunity_stage: {
    inTx: true,
    async plan(db, ctx, input) {
      const orgId = ctx.actor.orgId;
      await assertNativeOwner(db, orgId, "opportunities");
      const { rows } = await db.query<{ id: string; name: string; status: string; stage_ref: string; contact_id: string | null; stage_name: string | null }>(
        "select id, name, status, stage_ref, contact_id, stage_name from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null",
        [input.opportunityId, orgId],
      );
      const o = rows[0];
      if (!o) throw new AppError("not_found", "Deal not found.");
      if (o.status !== "open") throw new AppError("forbidden", "This deal is closed. Only a person can reopen it.");
      const s = await stageInfo(db, orgId, input.stageId);
      if (s.kind === "lost" && !input.lostReason) throw new AppError("invalid_input", "Say why the deal was lost (lostReason).");
      return {
        summary: `move ${quote(o.name)} to ${s.name}`, targetType: "crm_opportunity", targetId: o.id, targetLabel: o.name,
        expectedEffect: s.kind === "open" ? `${quote(o.name)} moves from ${o.stage_name ?? "its stage"} to ${s.name}.` : `${quote(o.name)} is closed as ${s.kind}${s.kind === "lost" ? ` (${input.lostReason})` : ""}. Reopening it later needs a manager.`,
        highImpact: s.kind === "open" ? null : `It marks the deal as ${s.kind}.`, contactId: o.contact_id, opportunityId: o.id,
      };
    },
    async run(ctx, input, db) {
      const q = need(db);
      const r = await moveOpportunityInTx(q, ctx.actor, input.opportunityId, { stageId: input.stageId, lostReason: input.lostReason ?? null });
      return {
        outcome: "done", summary: r.changed ? `Moved the deal (${r.status})` : "The deal was already in that stage", targetType: "crm_opportunity", targetId: input.opportunityId,
        result: { opportunityId: input.opportunityId, changed: r.changed, status: r.status, stageId: r.stageId },
      };
    },
  },

  check_availability: {
    inTx: false,
    async run(ctx, input) {
      const orgId = ctx.actor.orgId;
      if (!(await withSystem((db) => bookingIsNative(db, orgId)))) {
        return { outcome: "unavailable", summary: "Availability not available", result: { available: false, detail: "This workspace's appointments aren't on iAcquire calendars, so availability can't be checked here." } };
      }
      const from = input.from ? new Date(input.from) : ctx.now;
      const start = from.getTime() < ctx.now.getTime() ? ctx.now : from;
      const res = await nativeAvailability(orgId, { calendarId: input.appointmentTypeId ?? null, from: start, to: new Date(start.getTime() + (input.days ?? 7) * 86_400_000), limit: input.limit ?? 20, now: ctx.now });
      if (!res.ok) return { outcome: "unavailable", summary: "No availability", result: { available: false, detail: res.detail } };
      return {
        outcome: "done", summary: `Checked availability (${plural(res.slots.length, "free time")})`,
        result: { available: res.slots.length > 0, appointmentTypeId: res.calendarId, timeZone: res.timeZone, slotMinutes: res.slotMinutes, checkedAt: res.checkedAt, slots: res.slots },
      };
    },
  },

  request_appointment: {
    inTx: false,
    async run(ctx, input) {
      const orgId = ctx.actor.orgId;
      const native = await withSystem(async (db) => {
        await contactLabel(db, orgId, input.contactId);
        return bookingIsNative(db, orgId);
      });
      if (!native) throw new AppError("conflict", "AI booking requests work only with iAcquire calendars in this workspace.");
      const res = await requestBooking({
        orgId, contactId: input.contactId, calendarId: input.appointmentTypeId ?? null, startAt: new Date(input.startAt), title: input.title || undefined,
        actor: { kind: "ai", agentId: ctx.agent.id }, now: ctx.now,
      });
      const base = { targetType: "appointment_booking", targetId: "bookingId" in res && res.bookingId ? res.bookingId : input.contactId };
      switch (res.status) {
        case "booked":
          return { ...base, outcome: "done", summary: "Booked the appointment", result: { status: "booked", bookingId: res.bookingId, appointmentId: res.appointmentId || null } };
        case "awaiting_approval":
          return { ...base, outcome: "pending_approval", approvalId: res.approvalId, summary: "Asked a person to confirm the appointment", result: { status: "awaiting_approval", bookingId: res.bookingId, approvalId: res.approvalId } };
        case "needs_manual":
          return { ...base, outcome: "unavailable", summary: "The booking needs a person", result: { status: "needs_manual", bookingId: res.bookingId, detail: res.reason } };
        case "unavailable":
          return { ...base, outcome: "unavailable", summary: "That time can't be booked", result: { status: "unavailable", reason: res.reason, detail: res.detail } };
        default:
          return { ...base, outcome: "unavailable", summary: "The booking failed", result: { status: "failed", detail: res.reason } };
      }
    },
  },

  get_conversation_history: {
    inTx: true,
    async run(ctx, input, db) {
      const q = need(db);
      let conversationId = input.conversationId ?? null;
      if (!conversationId) {
        await contactLabel(q, ctx.actor.orgId, input.contactId as string);
        const latest = await q.query<{ id: string }>(
          "select id from conversations where org_id = $1 and contact_id = $2 and ai_agent_id = $3 order by last_message_at desc nulls last, created_at desc limit 1",
          [ctx.actor.orgId, input.contactId, ctx.agent.id],
        );
        if (!latest.rows[0]) return { outcome: "done", summary: "No conversation found", result: { conversation: null, messages: [], detail: "This AI employee doesn't handle a conversation with that contact." } };
        conversationId = latest.rows[0].id;
      }
      const conv = await permittedConversation(q, ctx, conversationId);
      const { rows } = await q.query<{ id: string; direction: string; author_kind: string; body: string; status: string; created_at: Date }>(
        `select id, direction, author_kind, body, status, created_at from conversation_messages
         where org_id = $1 and conversation_id = $2 and direction in ('inbound', 'outbound') and status not in ('draft', 'blocked')
         order by created_at desc limit $3`,
        [ctx.actor.orgId, conv.id, input.limit ?? 20],
      );
      return {
        outcome: "done", summary: `Read ${plural(rows.length, "message")}`, targetType: "conversation", targetId: conv.id, targetLabel: conv.contact_name,
        result: {
          conversation: { id: conv.id, contactId: conv.contact_id, channel: conv.channel, handledBy: conv.owner_kind === "ai" ? "ai" : "person" },
          messages: rows.reverse().map((m) => ({
            id: m.id, at: iso(m.created_at), from: m.direction === "inbound" ? "customer" : m.author_kind === "ai" ? "ai" : "team", status: m.direction === "outbound" ? m.status : undefined,
            text: maskCustomerLinks(m.body).slice(0, 1000),
          })),
        },
      };
    },
  },

  prepare_message: {
    inTx: true,
    async run(ctx, input, db) {
      const q = need(db);
      const conv = await permittedConversation(q, ctx, input.conversationId);
      if (conv.owner_kind !== "ai") throw new AppError("conflict", "A person has taken over this conversation, so the AI employee can't draft in it.");
      const key = `agent-draft:${ctx.callKey}`.slice(0, 200);
      const ins = await q.query<{ id: string }>(
        `insert into conversation_messages (org_id, conversation_id, direction, author_kind, agent_id, body, status, status_detail, blocked_reason, scope, dedupe_key)
         values ($1, $2, 'outbound', 'ai', $3, $4, 'draft', 'Prepared by an AI employee. Not sent.', 'needs_approval', 'reply', $5)
         on conflict (org_id, dedupe_key) do nothing returning id`,
        [ctx.actor.orgId, conv.id, ctx.agent.id, input.body, key],
      );
      const id = ins.rows[0]?.id ?? (await q.query<{ id: string }>("select id from conversation_messages where org_id = $1 and dedupe_key = $2", [ctx.actor.orgId, key])).rows[0]?.id;
      if (!id) throw new AppError("conflict", "The draft couldn't be saved. Try again.");
      return {
        outcome: "draft", summary: `Drafted a message to ${conv.contact_name}`, targetType: "conversation", targetId: conv.id, targetLabel: conv.contact_name,
        result: { draftId: id, conversationId: conv.id, status: "draft", detail: "Saved as a draft. Nothing was sent. Use request_send_approval to ask a person to send it." },
      };
    },
  },

  request_send_approval: {
    inTx: true,
    async run(ctx, input, db) {
      const q = need(db);
      const orgId = ctx.actor.orgId;
      const { rows } = await q.query<{ id: string; conversation_id: string; status: string; approval_id: string | null; agent_id: string | null; ai_agent_id: string | null; contact_name: string; approval_pending: boolean | null }>(
        `select m.id, m.conversation_id, m.status, m.approval_id, m.agent_id, c.ai_agent_id, coalesce(nullif(k.display_name, ''), 'a customer') as contact_name,
                (a.status = 'pending' and (a.expires_at is null or a.expires_at > now())) as approval_pending
         from conversation_messages m join conversations c on c.id = m.conversation_id and c.org_id = m.org_id join contacts k on k.id = c.contact_id
         left join approval_requests a on a.id = m.approval_id
         where m.id = $1 and m.org_id = $2 and m.direction = 'outbound' and m.author_kind = 'ai' and k.deleted_at is null for update of m`,
        [input.messageId, orgId],
      );
      const m = rows[0];
      if (!m || m.agent_id !== ctx.agent.id || m.ai_agent_id !== ctx.agent.id) throw new AppError("not_found", "Draft not found, or it isn't one this AI employee wrote.");
      if (m.status !== "draft") throw new AppError("conflict", "This draft was already handled, so there is nothing to approve.");
      const base = { targetType: "conversation", targetId: m.conversation_id, targetLabel: m.contact_name };
      if (m.approval_id && m.approval_pending) {
        return { ...base, outcome: "pending_approval", approvalId: m.approval_id, summary: "The draft is already waiting for approval", result: { approvalId: m.approval_id, status: "pending_approval" } };
      }
      const approvalId = await createApproval(q, {
        orgId, agentId: ctx.agent.id, kind: "follow_up_message", title: `Send ${ctx.agent.displayName}'s message to ${m.contact_name}`.slice(0, 200), action: { messageId: m.id },
        targetType: "conversation", targetId: m.conversation_id, targetLabel: m.contact_name,
        reason: input.note?.trim() || `${ctx.agent.displayName} prepared this message and asks a person to approve sending it.`,
        expectedEffect: "Once approved, the message is queued for the customer. Consent, opt-outs, quiet hours, pauses and credits are checked again before it is sent.",
        risk: "medium", expiresInHours: 72, idempotencyKey: `agent-send:${m.id}:${crypto.randomUUID()}`, actorKind: "agent",
      });
      if (!approvalId) throw new AppError("conflict", "The approval couldn't be recorded. Try again.");
      await q.query("update conversation_messages set approval_id = $2 where id = $1", [m.id, approvalId]);
      await notifyOrgRoles(q, orgId, ["owner", "admin"], {
        kind: "approval_requested", severity: "info", title: `${ctx.agent.displayName} asks to send a message to ${m.contact_name}`.slice(0, 200), body: "Review the draft in the Approval Center.",
        link: "/approvals", dedupeKey: `agent-send:${approvalId}`,
      });
      return { ...base, outcome: "pending_approval", approvalId, summary: `Asked a person to approve a message to ${m.contact_name}`, result: { approvalId, status: "pending_approval", detail: "Nothing is sent until a person approves it." } };
    },
  },

  crm_summary_report: {
    inTx: true,
    async run(ctx, input, db) {
      const q = need(db);
      const days = input.periodDays ?? 30;
      const { rows } = await q.query<Record<string, string>>(
        `select
           (select count(*) from contacts where org_id = $1 and deleted_at is null and archived_at is null)::text as contacts,
           (select count(*) from contacts where org_id = $1 and deleted_at is null and created_at > now() - make_interval(days => $2::int))::text as new_contacts,
           (select count(*) from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null and status = 'open')::text as open_deals,
           (select count(*) from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null and status = 'won' and closed_at > now() - make_interval(days => $2::int))::text as won_deals,
           (select count(*) from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null and status = 'lost' and closed_at > now() - make_interval(days => $2::int))::text as lost_deals,
           (select count(*) from tasks where org_id = $1 and status in ('open', 'in_progress'))::text as open_tasks,
           (select count(*) from tasks where org_id = $1 and status in ('open', 'in_progress') and due_at < now())::text as overdue_tasks,
           (select count(*) from appointment_refs where org_id = $1 and start_at between now() and now() + interval '7 days' and status not in ('cancelled', 'invalid'))::text as upcoming_appointments,
           (select count(*) from conversations where org_id = $1 and status = 'open')::text as open_conversations`,
        [ctx.actor.orgId, days],
      );
      const r = rows[0];
      const n = (k: string) => Number(r[k] ?? 0);
      return {
        outcome: "done", summary: `Read CRM counts (last ${days} days)`,
        result: {
          periodDays: days,
          contacts: { total: n("contacts"), newInPeriod: n("new_contacts") },
          deals: { open: n("open_deals"), wonInPeriod: n("won_deals"), lostInPeriod: n("lost_deals") },
          tasks: { open: n("open_tasks"), overdue: n("overdue_tasks") },
          appointments: { next7Days: n("upcoming_appointments") },
          conversations: { open: n("open_conversations") },
        },
      };
    },
  },
};
