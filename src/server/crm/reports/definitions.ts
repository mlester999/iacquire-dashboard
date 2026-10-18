import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { REPORT_SECTIONS, customRangeIssue, reportConfigSchema, reportKind, todayIn, type ReportConfig } from "@/components/crm/reports/spec";
import type { SavedReportView } from "@/components/crm/reports/types";

/**
 * Sharing a saved report with the whole team (and changing or pinning a team report someone else made) is for the people who can export
 * reports: owners and managers by default, or anyone given "Export reports". A private report is its owner's alone.
 */
export const TEAM_REPORT_PERMISSION = "analytics.export" as const;
/** Saved reports one workspace can keep (archived ones don't count). */
export const MAX_SAVED_REPORTS = 200;

export interface SavedReportInput {
  name: string;
  description?: string | null;
  config: ReportConfig;
  visibility?: "private" | "team";
}

type Row = {
  id: string; key: string; name: string; description: string | null; report: string; config: unknown; visibility: "private" | "team"; pinned: boolean;
  owner_user_id: string | null; owner_name: string | null; updated_at: Date;
};

function cleanName(name: unknown): string {
  const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (!n || n.length > 80) throw new AppError("invalid_input", "Name the report (up to 80 characters).");
  return n;
}

function cleanDescription(d: unknown): string | null {
  if (d === null || d === undefined) return null;
  if (typeof d !== "string") throw new AppError("invalid_input", "The description must be text.");
  const t = d.replace(/\s+/g, " ").trim();
  if (t.length > 300) throw new AppError("invalid_input", "Keep the description to 300 characters.");
  return t || null;
}

/** Validates what a report remembers. A fixed period (last 30 days, this month…) moves with time; custom dates stay as chosen. */
function cleanConfig(actor: CrmActor, raw: unknown): ReportConfig {
  const parsed = reportConfigSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the report's filters and sections.");
  const c = parsed.data;
  if (c.filters.range === "custom") {
    const issue = customRangeIssue(c.filters.from, c.filters.to, todayIn(actor.timezone || "UTC"));
    if (issue) throw new AppError("invalid_input", issue);
  } else {
    delete c.filters.from;
    delete c.filters.to;
  }
  return { filters: c.filters, sections: REPORT_SECTIONS.filter((s) => c.sections.includes(s)) };
}

function readConfig(raw: unknown): SavedReportView["config"] {
  const parsed = reportConfigSchema.safeParse(raw);
  // A definition saved by an older version that no longer parses still opens, with the default period and every section.
  return parsed.success ? parsed.data : { filters: { range: "30d" }, sections: [...REPORT_SECTIONS] };
}

const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "report";

async function uniqueKey(db: Queryable, orgId: string, name: string): Promise<string> {
  const base = slug(name);
  const { rows } = await db.query<{ key: string }>("select key from crm_report_definitions where org_id = $1 and archived_at is null and (key = $2 or key like $3)", [orgId, base, `${base}-%`]);
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  throw new AppError("conflict", "Choose a different name for this report.");
}

function toView(actor: CrmActor, r: Row): SavedReportView {
  const mine = Boolean(actor.userId && r.owner_user_id === actor.userId);
  return {
    id: r.id, key: r.key, name: r.name, description: r.description, report: r.report, config: readConfig(r.config), visibility: r.visibility, pinned: r.pinned,
    ownerName: r.owner_name, mine, editable: actor.kind === "member" && (mine || (r.visibility === "team" && actor.can(TEAM_REPORT_PERMISSION))), updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const SELECT = `select d.id, d.key, d.name, d.description, d.report, d.config, d.visibility, d.pinned, d.owner_user_id, nullif(u.full_name, '') as owner_name, d.updated_at
  from crm_report_definitions d left join users u on u.id = d.owner_user_id`;

/** Saved reports this person can open: the team's, and their own private ones. Pinned first. */
export async function listSavedReports(actor: CrmActor): Promise<SavedReportView[]> {
  assertCan(actor, "analytics.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<Row>(
      `${SELECT} where d.org_id = $1 and d.archived_at is null and (d.visibility = 'team' or d.owner_user_id = $2) order by d.pinned desc, lower(d.name)`,
      [actor.orgId, actor.userId],
    );
    return rows.map((r) => toView(actor, r));
  });
}

export async function getSavedReport(actor: CrmActor, id: string): Promise<SavedReportView | null> {
  assertCan(actor, "analytics.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<Row>(`${SELECT} where d.org_id = $1 and d.id = $2 and d.archived_at is null and (d.visibility = 'team' or d.owner_user_id = $3)`, [actor.orgId, id, actor.userId]);
    return rows[0] ? toView(actor, rows[0]) : null;
  });
}

function assertPerson(actor: CrmActor) {
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Saved reports belong to a person in this workspace.");
}

/** Saves a report definition. Private by default; sharing it with the team needs the export permission. */
export async function createSavedReport(actor: CrmActor, input: SavedReportInput): Promise<{ id: string; key: string }> {
  assertCan(actor, "analytics.view");
  assertPerson(actor);
  const visibility = input.visibility ?? "private";
  if (visibility !== "private" && visibility !== "team") throw new AppError("invalid_input", "Choose who can see this report.");
  if (visibility === "team") assertCan(actor, TEAM_REPORT_PERMISSION, "Sharing a report with the team needs the “Export reports” permission. Save it as private instead.");
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const config = cleanConfig(actor, input.config);
  return crmWrite(actor, async (db) => {
    const count = await db.query<{ n: string }>("select count(*)::text as n from crm_report_definitions where org_id = $1 and archived_at is null", [actor.orgId]);
    if (Number(count.rows[0]?.n ?? 0) >= MAX_SAVED_REPORTS) throw new AppError("conflict", `This workspace already has ${MAX_SAVED_REPORTS} saved reports. Archive some before saving more.`);
    const key = await uniqueKey(db, actor.orgId, name);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_report_definitions (org_id, key, name, description, report, config, visibility, owner_user_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [actor.orgId, key, name, description, reportKind(config.sections), JSON.stringify(config), visibility, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.report_saved", targetType: "crm_report_definition", targetId: rows[0].id, result: "success", metadata: { visibility, sections: config.sections, range: config.filters.range } }, db);
    return { id: rows[0].id, key };
  });
}

/** The definition, after checking this person may change it: the owner always; a team report also anyone who may share reports. */
async function editableRow(db: Queryable, actor: CrmActor, id: string): Promise<Row> {
  const { rows } = await db.query<Row>(`${SELECT} where d.org_id = $1 and d.id = $2 and d.archived_at is null for update of d`, [actor.orgId, id]);
  const r = rows[0];
  if (!r || (r.visibility === "private" && r.owner_user_id !== actor.userId)) throw new AppError("not_found", "Report not found.");
  if (r.owner_user_id !== actor.userId) assertCan(actor, TEAM_REPORT_PERMISSION, "Only the person who saved this report, or someone who can export reports, can change it.");
  return r;
}

export async function updateSavedReport(actor: CrmActor, id: string, patch: Partial<SavedReportInput>): Promise<void> {
  assertCan(actor, "analytics.view");
  assertPerson(actor);
  const name = patch.name !== undefined ? cleanName(patch.name) : null;
  const description = patch.description !== undefined ? cleanDescription(patch.description) : undefined;
  const config = patch.config !== undefined ? cleanConfig(actor, patch.config) : null;
  if (patch.visibility !== undefined && patch.visibility !== "private" && patch.visibility !== "team") throw new AppError("invalid_input", "Choose who can see this report.");
  await crmWrite(actor, async (db) => {
    const cur = await editableRow(db, actor, id);
    if (patch.visibility === "team" && cur.visibility !== "team") assertCan(actor, TEAM_REPORT_PERMISSION, "Sharing a report with the team needs the “Export reports” permission.");
    if (patch.visibility === "private" && cur.visibility === "team" && cur.owner_user_id !== actor.userId) throw new AppError("forbidden", "Only the person who saved a team report can make it private again.");
    const key = name && name !== cur.name ? await uniqueKey(db, actor.orgId, name) : null;
    await db.query(
      `update crm_report_definitions set name = coalesce($3, name), key = coalesce($4, key), description = case when $5::boolean then $6 else description end,
         config = coalesce($7::jsonb, config), report = coalesce($8, report), visibility = coalesce($9, visibility),
         pinned = case when coalesce($9, visibility) = 'private' and visibility = 'team' then false else pinned end
       where org_id = $1 and id = $2`,
      [actor.orgId, id, name, key && key !== cur.key ? key : null, description !== undefined, description ?? null, config ? JSON.stringify(config) : null, config ? reportKind(config.sections) : null, patch.visibility ?? null],
    );
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.report_updated", targetType: "crm_report_definition", targetId: id, result: "success",
      metadata: { renamed: Boolean(name && name !== cur.name), filtersChanged: Boolean(config), visibility: patch.visibility ?? cur.visibility },
    }, db);
  });
}

/** Pins a report to the top of the saved list. A team report's pin is shared, so it follows the team rule; a private one is the owner's. */
export async function setSavedReportPinned(actor: CrmActor, id: string, pinned: boolean): Promise<void> {
  assertCan(actor, "analytics.view");
  assertPerson(actor);
  await crmWrite(actor, async (db) => {
    const cur = await editableRow(db, actor, id);
    if (cur.visibility === "team" && cur.owner_user_id === actor.userId) assertCan(actor, TEAM_REPORT_PERMISSION, "Pinning a team report changes it for everyone, which needs the “Export reports” permission.");
    await db.query("update crm_report_definitions set pinned = $3 where org_id = $1 and id = $2", [actor.orgId, id, pinned]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: pinned ? "crm.report_pinned" : "crm.report_unpinned", targetType: "crm_report_definition", targetId: id, result: "success" }, db);
  });
}

/** Archives a saved report. Its key becomes free again; the row is kept. */
export async function archiveSavedReport(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "analytics.view");
  assertPerson(actor);
  await crmWrite(actor, async (db) => {
    await editableRow(db, actor, id);
    await db.query("update crm_report_definitions set archived_at = now(), pinned = false where org_id = $1 and id = $2", [actor.orgId, id]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.report_archived", targetType: "crm_report_definition", targetId: id, result: "success" }, db);
  });
}
