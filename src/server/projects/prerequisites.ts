import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import type { SessionUser } from "@/server/auth/service";
import { CLIENT_ROLES, addUpdate, authorizeRequest, isStaff, type LockedProject } from "@/server/projects/access";
import {
  PREREQUISITE_KINDS, PREREQUISITE_BLOCKS, blockedMessage, blockers, defaultPrerequisites, evidenceProblem, waiverProblem, type PrerequisiteBlocks, type PrerequisiteFact,
} from "@/lib/project-prerequisites";

// What a person confirms before a custom project's work starts, or before it is handed over. A record of a human check: nothing is detected, no payment is read and nobody
// is charged. Staff write down what they checked and where, or waive an item with a reason (the owner of quotes decides that); both are kept and audited. Whether accepting a
// quote asks for the two usual items (the written agreement, and the payment its terms describe) is a Super Admin switch, off until the founder decides which ones apply.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string; request_id: string; org_id: string; kind: PrerequisiteFact["kind"]; label: string; required: boolean; blocks: PrerequisiteBlocks; status: PrerequisiteFact["status"];
  change_status: string | null;
}

/** Asks for the agreement (and the payment, when the quote has payment terms) when a quote is accepted. Does nothing while the switch is off, and nothing twice. */
export async function seedDefaultPrerequisites(db: Queryable, project: { id: string; org_id: string }, paymentTerms: string): Promise<number> {
  const on = (await db.query<{ on: boolean }>("select project_prerequisites_enabled as on from support_settings where id")).rows[0]?.on === true;
  if (!on) return 0;
  let made = 0;
  for (const item of defaultPrerequisites(paymentTerms)) {
    const r = await db.query(
      `insert into project_prerequisites (request_id, org_id, kind, label, required, blocks) values ($1,$2,$3,$4,$5,$6)
       on conflict (request_id, kind) where kind in ('agreement', 'deposit') do nothing returning id`,
      [project.id, project.org_id, item.kind, item.label, item.required, item.blocks],
    );
    made += r.rows.length;
  }
  return made;
}

async function waiting(db: Queryable, requestId: string, phase: PrerequisiteBlocks) {
  const rows = (await db.query<Row>(
    `select p.id, p.request_id, p.org_id, p.kind, p.label, p.required, p.blocks, p.status, c.status as change_status
     from project_prerequisites p left join project_change_orders c on c.id = p.change_order_id where p.request_id = $1 order by p.created_at`,
    [requestId],
  )).rows;
  return blockers(rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, required: r.required, blocks: r.blocks, status: r.status, changeStatus: r.change_status })), phase);
}

/** Work does not start while a required item is still waiting. The caller holds the project's lock. */
export async function assertStartAllowed(db: Queryable, requestId: string): Promise<void> {
  const message = blockedMessage("start", await waiting(db, requestId, "start"));
  if (message) throw new AppError("conflict", message);
}

/** The project is not handed over while a required item for the handover is still waiting. */
export async function assertHandoverAllowed(db: Queryable, requestId: string): Promise<void> {
  const message = blockedMessage("handover", await waiting(db, requestId, "handover"));
  if (message) throw new AppError("conflict", message);
}

const tellClient = (db: Queryable, orgId: string, title: string, link: string, dedupeKey: string) => notifyOrgRoles(db, orgId, CLIENT_ROLES, { kind: "project_prerequisite", title, link, dedupeKey });

export const prerequisiteSchema = z.object({
  kind: z.enum(PREREQUISITE_KINDS).refine((k) => k !== "change", "A change's confirmation is asked for when its quote is sent."),
  label: z.string().trim().min(3, "Say what has to be confirmed (at least a few words).").max(160),
  required: z.boolean().default(true),
  blocks: z.enum(PREREQUISITE_BLOCKS).default("start"),
});
export type PrerequisiteInput = z.input<typeof prerequisiteSchema>;

/** Asks for one more thing. For access or content, the client sees it on "Before we start" and knows what to provide. */
export async function addPrerequisite(user: SessionUser, requestId: string, input: PrerequisiteInput): Promise<{ id: string }> {
  const parsed = prerequisiteSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const d = parsed.data;
  return withSystem(async (db) => {
    const project = await authorizeRequest(db, user, requestId, "projects.manage");
    if (project.status === "cancelled" || project.status === "completed") throw new AppError("conflict", "This project is closed, so nothing more can be asked for.");
    const made = await db.query<{ id: string }>(
      `insert into project_prerequisites (request_id, org_id, kind, label, required, blocks, created_by) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (request_id, kind) where kind in ('agreement', 'deposit') do nothing returning id`,
      [project.id, project.org_id, d.kind, d.label, d.required, d.blocks, user.id],
    );
    if (!made.rows[0]) throw new AppError("conflict", `${d.kind === "agreement" ? "The written agreement" : "The payment"} is already on this project's list.`);
    const id = made.rows[0].id;
    await tellClient(db, project.org_id, `${project.ref}: we need something confirmed (${d.label})`, `/projects/${project.id}`, `project:${project.id}:prerequisite:${id}:added`);
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.prerequisite_added", targetType: "project_prerequisite", targetId: id, result: "success", metadata: { kind: d.kind, blocks: d.blocks, required: d.required } }, db);
    return { id };
  });
}

async function lockPrerequisite(db: Queryable, user: SessionUser, id: string, permission: "projects.manage" | "quotes.manage"): Promise<{ item: Row & { evidence_note: string | null }; project: LockedProject }> {
  if (!isStaff(user)) throw new AppError("forbidden", "Agency access is required.");
  if (!UUID.test(id)) throw new AppError("not_found", "That item was not found.");
  const head = (await db.query<{ request_id: string }>("select request_id from project_prerequisites where id = $1", [id])).rows[0];
  if (!head) throw new AppError("not_found", "That item was not found.");
  const project = await authorizeRequest(db, user, head.request_id, permission);
  const item = (await db.query<Row & { evidence_note: string | null }>(
    `select p.id, p.request_id, p.org_id, p.kind, p.label, p.required, p.blocks, p.status, c.status as change_status, p.evidence_note
     from project_prerequisites p left join project_change_orders c on c.id = p.change_order_id where p.id = $1 for update of p`, [id],
  )).rows[0];
  if (!item) throw new AppError("not_found", "That item was not found.");
  return { item, project };
}

/** Records that a person checked it. Who and when are recorded; the evidence says what they checked and where. Nothing is detected and nobody is charged. */
export async function satisfyPrerequisite(user: SessionUser, id: string, evidence: string): Promise<void> {
  const problem = evidenceProblem(evidence);
  if (problem) throw new AppError("invalid_input", problem);
  await withSystem(async (db) => {
    const { item, project } = await lockPrerequisite(db, user, id, "projects.manage");
    if (item.status !== "pending") throw new AppError("conflict", item.status === "satisfied" ? "This was already confirmed." : "This was marked as not needed.");
    await db.query("update project_prerequisites set status = 'satisfied', evidence_note = $2, satisfied_by = $3, satisfied_at = now() where id = $1", [id, evidence.trim(), user.id]);
    await addUpdate(db, project, user.id, "system", `Confirmed: ${item.label}`);
    await tellClient(db, project.org_id, `${project.ref}: confirmed (${item.label})`, `/projects/${project.id}`, `project:${project.id}:prerequisite:${id}:satisfied`);
    // The audit entry records that evidence was written, never its text.
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.prerequisite_satisfied", targetType: "project_prerequisite", targetId: id, result: "success", metadata: { kind: item.kind, blocks: item.blocks } }, db);
  });
}

/** The team decides an item is not needed, with a reason. Needs the same permission as quoting; kept and audited. */
export async function waivePrerequisite(user: SessionUser, id: string, reason: string): Promise<void> {
  const problem = waiverProblem(reason);
  if (problem) throw new AppError("invalid_input", problem);
  await withSystem(async (db) => {
    const { item, project } = await lockPrerequisite(db, user, id, "quotes.manage");
    if (item.status !== "pending") throw new AppError("conflict", item.status === "satisfied" ? "This was already confirmed." : "This was already marked as not needed.");
    await db.query("update project_prerequisites set status = 'waived', waived_reason = $2, waived_by = $3, waived_at = now() where id = $1", [id, reason.trim(), user.id]);
    await addUpdate(db, project, user.id, "system", `Not needed: ${item.label}`);
    await tellClient(db, project.org_id, `${project.ref}: marked as not needed (${item.label})`, `/projects/${project.id}`, `project:${project.id}:prerequisite:${id}:waived`);
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.prerequisite_waived", targetType: "project_prerequisite", targetId: id, result: "success", metadata: { kind: item.kind, blocks: item.blocks, required: item.required } }, db);
  });
}

/** Takes back an item that was asked for by mistake, while it is still waiting. A confirmed or waived item is the record of what a person did, and is kept. */
export async function removePrerequisite(user: SessionUser, id: string): Promise<void> {
  await withSystem(async (db) => {
    const { item, project } = await lockPrerequisite(db, user, id, "projects.manage");
    if (item.status !== "pending") throw new AppError("conflict", "A confirmed or waived item is kept as the record of it.");
    await db.query("delete from project_prerequisites where id = $1", [id]);
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.prerequisite_removed", targetType: "project_prerequisite", targetId: id, result: "success", metadata: { kind: item.kind } }, db);
  });
}
