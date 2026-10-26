import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { collectStrings, emptyTemplateDoc, parseTemplateDoc, type TemplateDoc } from "@/lib/proposals/doc";
import { contentHash } from "@/lib/proposals/hash";
import { findTokens, hasStrayBraces } from "@/lib/proposals/tokens";
import { assertProposalsEnabled } from "@/server/proposals/features";
import { iso } from "@/server/proposals/core";
import { namesOf } from "@/server/proposals/view";
import { newPartId } from "@/server/proposals/doc-build";

// Reusable wording and a starting set of price book items. A template's lines name price book items, never prices: the price is read when a proposal is made from it. Editing a
// template makes a new frozen version; the owner approves a version before anyone sends a proposal made from it, and until the new version is approved people keep using the
// approved one. The price book, tax rates and templates are also set up by the agency as a service (inside an audited support session); approving stays with the owner.

export interface TemplateSummary {
  id: string;
  key: string;
  name: string;
  status: "draft" | "approved" | "archived";
  currentVersion: number;
  approvedVersion: number | null;
  approvedAt: string | null;
  updatedAt: string;
}

export interface TemplateDetail extends TemplateSummary {
  /** The newest version's document (which may not be the approved one). */
  doc: TemplateDoc;
  approvedByName: string | null;
  versions: Array<{ version: number; contentHash: string; createdAt: string; approved: boolean }>;
}

interface TemplateRow { id: string; key: string; name: string; status: TemplateSummary["status"]; current_version: number; approved_version: number | null; approved_by: string | null; approved_at: Date | null; updated_at: Date }
const COLUMNS = "id, key, name, status, current_version, approved_version, approved_by, approved_at, updated_at";
const toSummary = (r: TemplateRow): TemplateSummary => ({ id: r.id, key: r.key, name: r.name, status: r.status, currentVersion: r.current_version, approvedVersion: r.approved_version, approvedAt: iso(r.approved_at), updatedAt: new Date(r.updated_at).toISOString() });

export async function listTemplates(actor: CrmActor, opts: { includeArchived?: boolean } = {}): Promise<TemplateSummary[]> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.view", "Your role can't see proposals.");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<TemplateRow>(`select ${COLUMNS} from proposal_templates where org_id = $1 and ($2::boolean or archived_at is null) order by archived_at nulls first, lower(name)`, [actor.orgId, opts.includeArchived === true]);
    return rows.map(toSummary);
  });
}

async function detailOf(db: Queryable, orgId: string, row: TemplateRow): Promise<TemplateDetail> {
  const versions = await db.query<{ version: number; doc: unknown; content_hash: string; created_at: Date }>("select version, doc, content_hash, created_at from proposal_template_versions where template_id = $1 and org_id = $2 order by version desc", [row.id, orgId]);
  const current = versions.rows.find((v) => v.version === row.current_version);
  const parsed = parseTemplateDoc(current?.doc);
  const names = await namesOf(db, [row.approved_by]);
  return {
    ...toSummary(row), doc: parsed.ok ? parsed.value : emptyTemplateDoc(), approvedByName: row.approved_by ? names.get(row.approved_by) ?? null : null,
    versions: versions.rows.map((v) => ({ version: v.version, contentHash: v.content_hash, createdAt: new Date(v.created_at).toISOString(), approved: v.version === row.approved_version })),
  };
}

export async function getTemplate(actor: CrmActor, id: string): Promise<TemplateDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.view", "Your role can't see proposals.");
  return crmRead(actor, async (db) => {
    const row = (await db.query<TemplateRow>(`select ${COLUMNS} from proposal_templates where id = $1 and org_id = $2`, [id, actor.orgId])).rows[0];
    if (!row) throw new AppError("not_found", "That template was not found.");
    return detailOf(db, actor.orgId, row);
  });
}

export interface TemplateDocInput {
  sections?: Array<{ id?: string; heading: string; body?: string }>;
  lines?: Array<{ id?: string; catalogItemId: string; quantityMilli: number; note?: string }>;
  terms?: string;
}

/** The stored document for what was submitted, checked: every placeholder is one iAcquire knows, every line names a price book item of THIS workspace that is still in use. */
async function buildTemplateDoc(db: Queryable, orgId: string, input: TemplateDocInput): Promise<TemplateDoc> {
  const parsed = parseTemplateDoc({
    v: 1,
    sections: (input.sections ?? []).map((s) => ({ id: s.id ?? newPartId(), heading: s.heading, body: s.body ?? "" })),
    lines: (input.lines ?? []).map((l) => ({ id: l.id ?? newPartId(), catalogItemId: l.catalogItemId, quantityMilli: l.quantityMilli, note: l.note ?? "" })),
    terms: input.terms ?? "",
  });
  if (!parsed.ok) throw new AppError("invalid_input", parsed.errors[0]);
  const doc = parsed.value;
  const unknown = new Set<string>();
  for (const text of collectStrings({ sections: doc.sections, terms: doc.terms, notes: doc.lines.map((l) => l.note) })) {
    for (const t of findTokens(text)) if (!t.known) unknown.add(t.raw);
    if (hasStrayBraces(text)) throw new AppError("invalid_input", "There is an unfinished placeholder: every {{ needs a matching }}.");
  }
  if (unknown.size) throw new AppError("invalid_input", `${[...unknown].slice(0, 3).join(", ")} ${unknown.size === 1 ? "isn't a placeholder" : "aren't placeholders"} iAcquire knows. Pick them from the list.`);
  const ids = [...new Set(doc.lines.map((l) => l.catalogItemId))];
  if (ids.length) {
    const ok = await db.query<{ n: string }>("select count(*)::text as n from proposal_catalog_items where org_id = $1 and id = any($2::uuid[]) and archived_at is null", [orgId, ids]);
    // An item of another workspace is indistinguishable from one that does not exist.
    if (Number(ok.rows[0].n) !== ids.length) throw new AppError("not_found", "A price book item you chose was not found, or is archived.");
  }
  return doc;
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 46).replace(/-+$/g, "") || "template";

async function freeKey(db: Queryable, orgId: string, name: string): Promise<string> {
  const base = slug(name);
  for (let n = 1; n < 100; n += 1) {
    const key = n === 1 ? base : `${base.slice(0, 44)}-${n}`;
    if (!(await db.query("select 1 from proposal_templates where org_id = $1 and key = $2 and archived_at is null", [orgId, key])).rows[0]) return key;
  }
  throw new AppError("conflict", "Choose a different name for this template.");
}

const cleanName = (name: string | undefined): string => {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (!n || n.length > 80) throw new AppError("invalid_input", "Give the template a name of up to 80 characters.");
  return n;
};

export async function createTemplate(actor: CrmActor, input: { name: string; doc?: TemplateDocInput }): Promise<TemplateDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.catalog", "Only the business owner or a manager can change the proposal templates.");
  const name = cleanName(input.name);
  return crmWrite(actor, async (db) => {
    const doc = await buildTemplateDoc(db, actor.orgId, input.doc ?? {});
    const key = await freeKey(db, actor.orgId, name);
    const t = (await db.query<TemplateRow>(`insert into proposal_templates (org_id, key, name, created_by) values ($1, $2, $3, $4) returning ${COLUMNS}`, [actor.orgId, key, name, actor.userId])).rows[0];
    await db.query("insert into proposal_template_versions (org_id, template_id, version, doc, content_hash, created_by) values ($1, $2, 1, $3::jsonb, $4, $5)", [actor.orgId, t.id, JSON.stringify(doc), contentHash(doc), actor.userId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.template_created", targetType: "proposal_template", targetId: t.id, result: "success" }, db);
    return detailOf(db, actor.orgId, t);
  });
}

/**
 * Saves a template. A changed document is a new frozen version; saving the same document again makes nothing. `expectedVersion` is the version the person was editing: two
 * people cannot overwrite each other. The version people use does not change until the owner approves the new one.
 */
export async function saveTemplate(actor: CrmActor, id: string, input: { name?: string; doc?: TemplateDocInput }, expectedVersion: number): Promise<TemplateDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.catalog", "Only the business owner or a manager can change the proposal templates.");
  return crmWrite(actor, async (db) => {
    const row = (await db.query<TemplateRow>(`select ${COLUMNS} from proposal_templates where id = $1 and org_id = $2 for update`, [id, actor.orgId])).rows[0];
    if (!row) throw new AppError("not_found", "That template was not found.");
    if (row.status === "archived") throw new AppError("conflict", "This template is archived.");
    if (row.current_version !== expectedVersion) throw new AppError("conflict", "Someone else changed this template. Reload to see their changes, then try again.");
    const name = input.name !== undefined ? cleanName(input.name) : row.name;
    let version = row.current_version;
    if (input.doc) {
      const doc = await buildTemplateDoc(db, actor.orgId, input.doc);
      const hash = contentHash(doc);
      const last = (await db.query<{ content_hash: string }>("select content_hash from proposal_template_versions where template_id = $1 and org_id = $2 and version = $3", [id, actor.orgId, row.current_version])).rows[0];
      if (last?.content_hash !== hash) {
        version = row.current_version + 1;
        await db.query("insert into proposal_template_versions (org_id, template_id, version, doc, content_hash, created_by) values ($1, $2, $3, $4::jsonb, $5, $6)", [actor.orgId, id, version, JSON.stringify(doc), hash, actor.userId]);
      }
    }
    await db.query("update proposal_templates set name = $3, current_version = $4 where id = $1 and org_id = $2", [id, actor.orgId, name, version]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.template_saved", targetType: "proposal_template", targetId: id, result: "success", metadata: { version } }, db);
    return detailOf(db, actor.orgId, (await db.query<TemplateRow>(`select ${COLUMNS} from proposal_templates where id = $1 and org_id = $2`, [id, actor.orgId])).rows[0]);
  });
}

/** The owner approves one version of a template, which makes it the version proposals are made from. Only the owner can: the wording is the business's to stand behind. */
export async function approveTemplate(actor: CrmActor, id: string, version: number): Promise<TemplateDetail> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.settings", "Only the business owner can approve a proposal template.");
  return crmWrite(actor, async (db) => {
    const row = (await db.query<TemplateRow>(`select ${COLUMNS} from proposal_templates where id = $1 and org_id = $2 for update`, [id, actor.orgId])).rows[0];
    if (!row) throw new AppError("not_found", "That template was not found.");
    if (row.status === "archived") throw new AppError("conflict", "This template is archived.");
    const v = (await db.query<{ doc: unknown }>("select doc from proposal_template_versions where template_id = $1 and org_id = $2 and version = $3", [id, actor.orgId, version])).rows[0];
    if (!v) throw new AppError("not_found", "That version of the template was not found.");
    // Checked again now: an item can have been archived since the version was saved.
    const parsed = parseTemplateDoc(v.doc);
    if (!parsed.ok) throw new AppError("internal", "That template could not be read. Contact support.");
    await buildTemplateDoc(db, actor.orgId, parsed.value);
    await db.query("update proposal_templates set status = 'approved', approved_version = $3, approved_by = $4, approved_at = now() where id = $1 and org_id = $2", [id, actor.orgId, version, actor.userId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.template_approved", targetType: "proposal_template", targetId: id, result: "success", metadata: { version } }, db);
    return detailOf(db, actor.orgId, (await db.query<TemplateRow>(`select ${COLUMNS} from proposal_templates where id = $1 and org_id = $2`, [id, actor.orgId])).rows[0]);
  });
}

export async function archiveTemplate(actor: CrmActor, id: string): Promise<void> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.catalog", "Only the business owner or a manager can change the proposal templates.");
  await crmWrite(actor, async (db) => {
    const r = await db.query("update proposal_templates set status = 'archived', archived_at = now() where id = $1 and org_id = $2 and archived_at is null returning id", [id, actor.orgId]);
    if (!r.rows[0]) throw new AppError("not_found", "That template was not found.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.template_archived", targetType: "proposal_template", targetId: id, result: "success" }, db);
  });
}
