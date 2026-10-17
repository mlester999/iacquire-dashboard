import "server-only";
import { z } from "zod";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { notifyAgency, notifyUser, sendAgencySlackAlert } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";

export const TICKET_STATUSES = ["open", "in_progress", "waiting_for_client", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const newTicketSchema = z.object({
  subject: z.string().trim().min(3, "Add a short subject.").max(160),
  message: z.string().trim().min(5, "Tell us a little more.").max(5000),
  category: z.enum(["general", "ai_employees", "integrations", "billing", "account", "bug", "onboarding", "project", "maintenance"]).default("general"),
  projectId: z.string().uuid().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  pageContext: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9/_-]*$/)
    .optional()
    .catch(undefined),
});

export interface TicketRow {
  id: string;
  ref: string;
  subject: string;
  category: string;
  priority: string;
  status: TicketStatus;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date;
  external_notification: string;
  created_by_name: string | null;
  /** Null for client users: row-level security keeps agency staff profiles private. */
  assigned_to_name: string | null;
  is_assigned: boolean;
  org_name?: string;
  org_id?: string;
}

type AgencySupportPermission = "agency.support.view" | "agency.support.manage";

async function assertAgencySupportPermission(user: Pick<SessionUser, "id" | "platformRole">, orgId: string | null, permission: AgencySupportPermission) {
  const { rows } = await withSystem((db) => db.query<{ active: boolean; platform_role: string; in_scope: boolean; allowed: boolean }>(
    `select u.status='active' as active,u.platform_role,
       ($2::uuid is null or app.user_can_access_org(u.id,$2)) as in_scope,
       coalesce(app.user_has_agency_permission(u.id,$3),false) as allowed
     from users u where u.id=$1`,
    [user.id, orgId, permission],
  ));
  const current = rows[0];
  if (!current?.active || current.platform_role !== user.platformRole || current.platform_role === "none") {
    throw new AppError("forbidden", "Agency access is required; authorization has changed.");
  }
  if (!current.in_scope) throw new AppError("not_found", "Support request not found.");
  if (!current.allowed) throw new AppError("forbidden", "Your agency role does not allow this support action.");
}

export async function createTicket(ctx: OrgContext, input: z.input<typeof newTicketSchema>) {
  if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't open support requests.");
  const data = newTicketSchema.parse(input);
  const limit = await consumeRateLimit(RATE_LIMITS.supportTicketByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You've opened several requests recently. Please add to an existing one.");

  const ticket = await withSystem(async (db) => {
    if (data.projectId) {
      const own = await db.query("select 1 from client_project_requests where id = $1 and org_id = $2", [data.projectId, ctx.org.orgId]);
      if (!own.rows[0]) throw new AppError("not_found", "Project not found.");
    }
    const { rows } = await db.query<{ id: string; ref: string }>(
      `insert into support_tickets (org_id, created_by, subject, category, priority, page_context, project_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, ref`,
      [ctx.org.orgId, ctx.user.id, data.subject, data.category, data.priority, data.pageContext ?? null, data.projectId ?? null],
    );
    const t = rows[0];
    await db.query("insert into support_messages (ticket_id, org_id, author_id, author_kind, body) values ($1, $2, $3, 'client', $4)", [
      t.id,
      ctx.org.orgId,
      ctx.user.id,
      data.message,
    ]);
    await notifyAgency(db, ctx.org.orgId, {
      kind: "support_ticket_created",
      severity: data.priority === "urgent" || data.priority === "high" ? "warning" : "info",
      title: `${t.ref}: ${data.subject}`,
      body: `${ctx.org.name} · ${data.category.replace("_", " ")}`,
      link: `/admin/support/${t.id}`,
    });
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "support.ticket_created", targetType: "support_ticket", targetId: t.id, result: "success", metadata: { ref: t.ref, category: data.category } },
      db,
    );
    return t;
  });

  // External alert carries no message body: only the reference, tenant name and category.
  const external = await sendAgencySlackAlert(`New iAcquire support request ${ticket.ref} from ${ctx.org.name} (${data.category}, ${data.priority}).`);
  await withSystem((db) => db.query("update support_tickets set external_notification = $2 where id = $1", [ticket.id, external]));
  return { ...ticket, externalNotification: external };
}

export async function listTickets(ctx: OrgContext): Promise<TicketRow[]> {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<TicketRow>(
      `select t.id, t.ref, t.subject, t.category, t.priority, t.status, t.created_at, t.updated_at, t.last_message_at,
              t.external_notification, cu.full_name as created_by_name, au.full_name as assigned_to_name, (t.assigned_to is not null) as is_assigned
       from support_tickets t left join users cu on cu.id = t.created_by left join users au on au.id = t.assigned_to
       where t.org_id = $1 order by t.last_message_at desc limit 100`,
      [ctx.org.orgId],
    );
    return rows;
  });
}

export interface TicketMessage {
  id: string;
  author_kind: "client" | "agency" | "system";
  author_name: string | null;
  body: string;
  internal: boolean;
  created_at: Date;
}

export async function getTicketForClient(ctx: OrgContext, ticketId: string) {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<TicketRow>(
      `select t.id, t.ref, t.subject, t.category, t.priority, t.status, t.created_at, t.updated_at, t.last_message_at,
              t.external_notification, cu.full_name as created_by_name, au.full_name as assigned_to_name, (t.assigned_to is not null) as is_assigned
       from support_tickets t left join users cu on cu.id = t.created_by left join users au on au.id = t.assigned_to
       where t.id = $1 and t.org_id = $2`,
      [ticketId, ctx.org.orgId],
    );
    if (!rows[0]) return null;
    // RLS hides internal agency notes from client users.
    const { rows: messages } = await db.query<TicketMessage>(
      `select m.id, m.author_kind, u.full_name as author_name, m.body, m.internal, m.created_at
       from support_messages m left join users u on u.id = m.author_id
       where m.ticket_id = $1 order by m.created_at asc`,
      [ticketId],
    );
    return { ticket: rows[0], messages };
  });
}

export async function clientReply(ctx: OrgContext, ticketId: string, body: string) {
  if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't reply to support requests.");
  const text = body.trim();
  if (text.length < 1 || text.length > 5000) throw new AppError("invalid_input", "Replies can be up to 5,000 characters.");
  const ticket = await getTicketForClient(ctx, ticketId);
  if (!ticket) throw new AppError("not_found", "Support request not found.");
  if (ticket.ticket.status === "closed") throw new AppError("conflict", "This request is closed. Open a new one if you still need help.");
  await withSystem(async (db) => {
    await db.query("insert into support_messages (ticket_id, org_id, author_id, author_kind, body) values ($1, $2, $3, 'client', $4)", [
      ticketId,
      ctx.org.orgId,
      ctx.user.id,
      text,
    ]);
    await db.query(
      `update support_tickets set last_message_at = now(),
         status = case when status in ('waiting_for_client', 'resolved') then 'open' else status end
       where id = $1`,
      [ticketId],
    );
    await notifyAgency(db, ctx.org.orgId, {
      kind: "support_reply",
      title: `${ticket.ticket.ref}: new reply from ${ctx.org.name}`,
      link: `/admin/support/${ticketId}`,
    });
  });
}

// ---------------------------------------------------------------------------
// Agency inbox
// ---------------------------------------------------------------------------

export async function listAgencyTickets(user: SessionUser, status?: TicketStatus | "active"): Promise<TicketRow[]> {
  await assertAgencySupportPermission(user, null, "agency.support.view");
  return withUser(user.id, async (db) => {
    const { rows } = await db.query<TicketRow>(
      `select t.id, t.ref, t.subject, t.category, t.priority, t.status, t.created_at, t.updated_at, t.last_message_at,
              t.external_notification, cu.full_name as created_by_name, au.full_name as assigned_to_name, (t.assigned_to is not null) as is_assigned, o.name as org_name, t.org_id
       from support_tickets t join organizations o on o.id = t.org_id
       left join users cu on cu.id = t.created_by left join users au on au.id = t.assigned_to
       where app.user_can_access_org($2,t.org_id)
         and ($1::text is null or ($1 = 'active' and t.status in ('open', 'in_progress', 'waiting_for_client')) or t.status = $1)
       order by case t.priority when 'urgent' then 0 when 'high' then 1 else 2 end, t.last_message_at desc limit 200`,
      [status ?? null, user.id],
    );
    return rows;
  });
}

export async function getTicketForAgency(user: SessionUser, ticketId: string) {
  const org = await withSystem((db) => db.query<{ org_id: string }>("select org_id from support_tickets where id=$1", [ticketId]));
  if (!org.rows[0]) return null;
  try {
    await assertAgencySupportPermission(user, org.rows[0].org_id, "agency.support.view");
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") return null;
    throw error;
  }
  return withUser(user.id, async (db) => {
    const { rows } = await db.query<TicketRow>(
      `select t.id, t.ref, t.subject, t.category, t.priority, t.status, t.created_at, t.updated_at, t.last_message_at,
              t.external_notification, cu.full_name as created_by_name, au.full_name as assigned_to_name, (t.assigned_to is not null) as is_assigned, o.name as org_name, t.org_id
       from support_tickets t join organizations o on o.id = t.org_id
       left join users cu on cu.id = t.created_by left join users au on au.id = t.assigned_to where t.id = $1`,
      [ticketId],
    );
    if (!rows[0]) return null;
    const { rows: messages } = await db.query<TicketMessage>(
      `select m.id, m.author_kind, u.full_name as author_name, m.body, m.internal, m.created_at
       from support_messages m left join users u on u.id = m.author_id where m.ticket_id = $1 order by m.created_at asc`,
      [ticketId],
    );
    return { ticket: rows[0], messages };
  });
}

async function assertAgencyTicketAccess(user: SessionUser, ticketId: string, permission: AgencySupportPermission) {
  const { rows } = await withSystem((db) =>
    db.query<{ org_id: string; created_by: string | null; ref: string; status: TicketStatus }>(
      "select org_id, created_by, ref, status from support_tickets where id = $1",
      [ticketId],
    ),
  );
  const t = rows[0];
  if (!t) throw new AppError("not_found", "Support request not found.");
  await assertAgencySupportPermission(user, t.org_id, permission);
  return t;
}

export async function agencyReply(user: SessionUser, ticketId: string, body: string, opts: { internal: boolean; status?: TicketStatus }) {
  const text = body.trim();
  if (!text || text.length > 5000) throw new AppError("invalid_input", "Replies can be up to 5,000 characters.");
  const t = await assertAgencyTicketAccess(user, ticketId, "agency.support.manage");
  await withSystem(async (db) => {
    await db.query(
      "insert into support_messages (ticket_id, org_id, author_id, author_kind, body, internal) values ($1, $2, $3, 'agency', $4, $5)",
      [ticketId, t.org_id, user.id, text, opts.internal],
    );
    const nextStatus = opts.status ?? (opts.internal ? null : "waiting_for_client");
    await db.query(
      `update support_tickets set last_message_at = now(), status = coalesce($2, status),
         assigned_to = coalesce(assigned_to, $3) where id = $1`,
      [ticketId, nextStatus, user.id],
    );
    if (!opts.internal && t.created_by) {
      await notifyUser(db, t.created_by, t.org_id, {
        kind: "support_reply",
        title: `iAcquire replied to ${t.ref}`,
        body: text.slice(0, 140),
        link: `/support/${ticketId}`,
      });
    }
    await recordAudit(
      { orgId: t.org_id, actorUserId: user.id, actorKind: "agency", action: opts.internal ? "support.internal_note" : "support.agency_reply", targetType: "support_ticket", targetId: ticketId, result: "success" },
      db,
    );
  });
}

export async function updateTicket(user: SessionUser, ticketId: string, changes: { status?: TicketStatus; assignToMe?: boolean; priority?: string }) {
  const t = await assertAgencyTicketAccess(user, ticketId, "agency.support.manage");
  if (changes.status && !TICKET_STATUSES.includes(changes.status)) throw new AppError("invalid_input", "Unknown status.");
  if (changes.priority && !["low", "normal", "high", "urgent"].includes(changes.priority)) throw new AppError("invalid_input", "Unknown priority.");
  await withSystem(async (db) => {
    await db.query(
      `update support_tickets set status = coalesce($2, status), priority = coalesce($3, priority),
         assigned_to = case when $4 then $5::uuid else assigned_to end where id = $1`,
      [ticketId, changes.status ?? null, changes.priority ?? null, Boolean(changes.assignToMe), user.id],
    );
    if (changes.status && changes.status !== t.status && t.created_by) {
      await db.query(
        "insert into support_messages (ticket_id, org_id, author_kind, body) values ($1, $2, 'system', $3)",
        [ticketId, t.org_id, `Status changed to ${changes.status.replace(/_/g, " ")}.`],
      );
      await notifyUser(db, t.created_by, t.org_id, {
        kind: "support_reply",
        title: `${t.ref} is now ${changes.status.replace(/_/g, " ")}`,
        link: `/support/${ticketId}`,
      });
    }
    await recordAudit(
      { orgId: t.org_id, actorUserId: user.id, actorKind: "agency", action: "support.ticket_updated", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: changes },
      db,
    );
  });
}
