"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUser } from "@/server/db";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { actionError, AppError } from "@/server/errors";
import { syncGhl } from "@/server/integrations/ghl";

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i);

export async function listNotesAction(recordType: string, recordId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("workspace.view");
    const type = z.enum(["opportunity", "lead", "retention_account", "appointment"]).parse(recordType);
    const rows = await withUser(ctx.user.id, (db) =>
      db.query<{ id: string; body: string; created_at: Date; author: string | null }>(
        `select n.id, n.body, n.created_at, u.full_name as author from record_notes n left join users u on u.id = n.author_id
         where n.org_id = $1 and n.record_type = $2 and n.record_id = $3 order by n.created_at desc limit 50`,
        [ctx.org.orgId, type, recordId.slice(0, 120)],
      ),
    );
    return { ok: true as const, data: rows.rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) };
  } catch (err) {
    return actionError(err);
  }
}

export async function addNoteAction(recordType: string, recordId: string, body: string) {
  try {
    const ctx = await requireOrgContextOrThrow("notes.write");
    const type = z.enum(["opportunity", "lead", "retention_account", "appointment"]).parse(recordType);
    const text = body.trim();
    if (!text || text.length > 4000) throw new AppError("invalid_input", "Notes can be up to 4,000 characters.");
    await withUser(ctx.user.id, (db) =>
      db.query("insert into record_notes (org_id, record_type, record_id, body, author_id) values ($1, $2, $3, $4, $5)", [ctx.org.orgId, type, recordId.slice(0, 120), text, ctx.user.id]),
    );
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

const taskSchema = z.object({
  title: z.string().trim().min(1, "Add a title.").max(200),
  dueAt: z.string().max(40).optional().nullable(),
  category: z.enum(["general", "follow_up", "retention", "sales", "setup"]).default("general"),
  relatedType: z.string().max(60).optional().nullable(),
  relatedId: z.string().max(120).optional().nullable(),
});

export async function createTaskAction(input: z.input<typeof taskSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("tasks.manage");
    const d = taskSchema.parse(input);
    const due = d.dueAt ? new Date(d.dueAt) : null;
    if (due && Number.isNaN(due.getTime())) throw new AppError("invalid_input", "Choose a valid due date.");
    await withUser(ctx.user.id, (db) =>
      db.query("insert into tasks (org_id, title, category, due_at, related_type, related_id, source, created_by) values ($1, $2, $3, $4, $5, $6, 'user', $7)", [
        ctx.org.orgId,
        d.title,
        d.category,
        due,
        d.relatedType ?? null,
        d.relatedId ?? null,
        ctx.user.id,
      ]),
    );
    revalidatePath("/", "layout");
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the task.", code: "invalid_input" as const };
    return actionError(err);
  }
}

export async function completeTaskAction(taskId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("tasks.manage");
    uuid.parse(taskId);
    const res = await withUser(ctx.user.id, (db) =>
      db.query("update tasks set status = 'done', completed_at = now() where id = $1 and org_id = $2 and status in ('open', 'in_progress')", [taskId, ctx.org.orgId]),
    );
    if (!res.rowCount) throw new AppError("not_found", "Task not found.");
    revalidatePath("/", "layout");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

const accountSchema = z.object({
  customerName: z.string().trim().min(1, "Add the customer's name.").max(200),
  status: z.enum(["onboarding", "active", "at_risk", "churned"]).default("active"),
  health: z.enum(["unknown", "healthy", "watch", "at_risk"]).default("unknown"),
  onboardingProgress: z.coerce.number().int().min(0).max(100).optional().nullable(),
  renewalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal("")),
  openIssues: z.coerce.number().int().min(0).max(999).default(0),
  repeatOpportunity: z.string().trim().max(500).optional().default(""),
});

export async function saveAccountAction(id: string | null, input: z.input<typeof accountSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("retention.edit");
    const d = accountSchema.parse(input);
    await withUser(ctx.user.id, async (db) => {
      if (id) {
        uuid.parse(id);
        const res = await db.query(
          `update retention_accounts set customer_name = $3, status = $4, health = $5, onboarding_progress = $6,
             renewal_date = nullif($7, '')::date, open_issues = $8, repeat_opportunity = nullif($9, '')
           where id = $1 and org_id = $2`,
          [id, ctx.org.orgId, d.customerName, d.status, d.health, d.onboardingProgress ?? null, d.renewalDate ?? "", d.openIssues, d.repeatOpportunity],
        );
        if (!res.rowCount) throw new AppError("not_found", "Customer not found.");
      } else {
        await db.query(
          `insert into retention_accounts (org_id, customer_name, status, health, onboarding_progress, renewal_date, open_issues, repeat_opportunity, created_by)
           values ($1, $2, $3, $4, $5, nullif($6, '')::date, $7, nullif($8, ''), $9)`,
          [ctx.org.orgId, d.customerName, d.status, d.health, d.onboardingProgress ?? null, d.renewalDate ?? "", d.openIssues, d.repeatOpportunity, ctx.user.id],
        );
      }
    });
    revalidatePath("/retention");
    return { ok: true as const };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the details.", code: "invalid_input" as const };
    return actionError(err);
  }
}

export async function addFeedbackAction(accountId: string, rating: number, comment: string) {
  try {
    const ctx = await requireOrgContextOrThrow("retention.edit");
    uuid.parse(accountId);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError("invalid_input", "Choose a rating from 1 to 5.");
    await withUser(ctx.user.id, (db) =>
      db.query("insert into customer_feedback (org_id, account_id, rating, comment, created_by) values ($1, $2, $3, nullif($4, ''), $5)", [ctx.org.orgId, accountId, rating, comment.trim().slice(0, 2000), ctx.user.id]),
    );
    revalidatePath("/retention");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function addServiceEventAction(accountId: string, event: string) {
  try {
    const ctx = await requireOrgContextOrThrow("retention.edit");
    uuid.parse(accountId);
    const text = event.trim();
    if (!text || text.length > 500) throw new AppError("invalid_input", "Describe the service event in up to 500 characters.");
    await withUser(ctx.user.id, async (db) => {
      await db.query("insert into service_history (org_id, account_id, event, created_by) values ($1, $2, $3, $4)", [ctx.org.orgId, accountId, text, ctx.user.id]);
      await db.query("update retention_accounts set last_contact_at = now() where id = $1 and org_id = $2", [accountId, ctx.org.orgId]);
    });
    revalidatePath("/retention");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/** Owners/admins can refresh the read-only CRM cache once iAcquire has connected the CRM. */
export async function refreshCrmAction() {
  try {
    const ctx = await requireOrgContextOrThrow("integrations.view");
    const res = await syncGhl(ctx.org.orgId, ctx.user.id);
    revalidatePath("/sales");
    revalidatePath("/appointments");
    return res.ok ? { ok: true as const, data: res } : { ok: false as const, error: res.detail, code: "integration_unavailable" as const };
  } catch (err) {
    return actionError(err);
  }
}
