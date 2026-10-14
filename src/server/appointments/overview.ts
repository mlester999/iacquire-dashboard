import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { formatSlot } from "@/lib/appointments";
import type { OrgContext } from "@/server/tenancy/context";

export interface PendingBookingRow {
  id: string;
  contactName: string;
  startAt: string;
  label: string;
  status: "awaiting_approval" | "needs_manual";
  requestedBy: "ai" | "staff";
  reason: string | null;
  approvalId: string | null;
  createdAt: string;
}

/** Bookings that are waiting on a person: an AI proposal to confirm, or a time to add to the calendar by hand. */
export async function listPendingBookings(ctx: OrgContext): Promise<PendingBookingRow[]> {
  if (!ctx.can("appointments.view")) return [];
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; start_at: Date; timezone: string; status: PendingBookingRow["status"]; requested_by_kind: "ai" | "staff"; failure_reason: string | null; approval_id: string | null; created_at: Date }>(
      `select b.id, coalesce(nullif(c.display_name, ''), 'A customer') as name, b.start_at, b.timezone, b.status, b.requested_by_kind, b.failure_reason, b.approval_id, b.created_at
       from appointment_bookings b join contacts c on c.id = b.contact_id and c.org_id = b.org_id
       where b.org_id = $1 and b.status in ('awaiting_approval', 'needs_manual') order by b.start_at limit 50`,
      [ctx.org.orgId],
    );
    return rows.map((r) => ({
      id: r.id, contactName: r.name, startAt: new Date(r.start_at).toISOString(), label: formatSlot(new Date(r.start_at).toISOString(), r.timezone), status: r.status,
      requestedBy: r.requested_by_kind, reason: r.failure_reason, approvalId: r.approval_id, createdAt: new Date(r.created_at).toISOString(),
    }));
  });
}

export interface BookableContact {
  id: string;
  name: string;
  detail: string;
  linkedToCrm: boolean;
}

/** Finds contacts to book for. Row-level security decides which contacts this person may see. */
export async function searchBookableContacts(ctx: OrgContext, query: string): Promise<BookableContact[]> {
  if (!ctx.can("appointments.book")) throw new AppError("forbidden", "You can't book appointments.");
  const q = query.trim().slice(0, 80);
  if (q.length < 2) return [];
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; display_name: string; email: string | null; phone: string | null; ghl_contact_id: string | null }>(
      `select id, display_name, email::text, phone, ghl_contact_id from contacts
       where org_id = $1 and deleted_at is null and (display_name ilike $2 or email::text ilike $2 or phone like $3) order by display_name limit 8`,
      [ctx.org.orgId, `%${q.replace(/[%_\\]/g, "")}%`, `%${q.replace(/[^0-9+]/g, "")}%`],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.display_name || "Unnamed contact",
      detail: r.phone ? `Phone ending ${r.phone.slice(-3)}` : (r.email ?? "No phone or email"),
      linkedToCrm: Boolean(r.ghl_contact_id),
    }));
  });
}
