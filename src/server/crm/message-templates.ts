import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { queueOutbound, templateFit } from "@/server/messaging/send";
import { contactAddress, getConsent, recordConsent } from "@/server/messaging/contacts";
import { isTransportName, transportWritesEnabled } from "@/server/messaging/transports/policy";
import { TRANSPORT_LABELS, type TransportName } from "@/server/messaging/transports/types";
import { CHANNEL_LABELS, CHANNELS, isChannel, normalizeAddress, type Channel } from "@/lib/messaging";
import {
  describeMissing, renderMessage, renderTemplate, sampleTokenValues, TEMPLATE_TOKENS, tokensUsed, validateTemplate, type TokenKey, type TokenValues,
  customValueTokenValues, type AnyTokenKey, type CustomValueCatalog, type CustomValueTokenDef,
  REVIEW_LINK_PREVIEW,
} from "@/lib/messaging/tokens";
import { customValueDefsFor, loadCustomValueDefs } from "@/server/crm/custom-values";

// Native message templates and canned replies (crm_message_templates + frozen crm_message_template_versions), the approved test
// destinations a template can be tried on, and the read model of the Communication Settings screen.
//
//  * Every change to what a message says (channel, subject, body) is a new frozen version with its own content hash. Editing an approved
//    template moves it back to draft: automated sends only ever use the exact version a person approved.
//  * Templates are approved by someone in the client's own workspace with templates.manage. iAcquire support can prepare and edit drafts in a
//    write session but never approves wording on the client's behalf.
//  * A test send goes only to an address the workspace approved as a test destination, through the same rule chain as any message
//    (queueOutbound), as a person, and only when the channel is enabled and its transport may send in this environment.

export type TemplateKind = "template" | "canned_reply";
export type TemplateStatus = "draft" | "approved" | "archived";
export type TemplatePurpose = "service" | "marketing";

export interface TemplateView {
  id: string;
  kind: TemplateKind;
  key: string;
  name: string;
  channel: Channel | null;
  purpose: TemplatePurpose;
  category: string | null;
  folderId: string | null;
  folderName: string | null;
  status: TemplateStatus;
  currentVersion: number;
  approvedVersion: number | null;
  approvedAt: string | null;
  approvedByName: string | null;
  whatsappTemplateId: string | null;
  /** The current version's content. */
  subject: string | null;
  body: string;
  contentHash: string;
  tokens: TokenKey[];
  versionCreatedAt: string;
  versionCreatedByName: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TemplateVersionView {
  version: number;
  subject: string | null;
  body: string;
  contentHash: string;
  tokens: string[];
  createdAt: string;
  createdByName: string | null;
}

export interface TemplateDetail extends TemplateView {
  versions: TemplateVersionView[];
}

const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const cleanText = (s: string | null | undefined) => (s ?? "").replace(/\r\n?/g, "\n");

/**
 * What an approval and an automated send are bound to: sha256 over the channel, subject and body, separated so that moving text between
 * the subject and the body changes the hash.
 */
export function templateContentHash(channel: Channel | null, subject: string | null, body: string): string {
  return crypto.createHash("sha256").update(`${channel ?? ""}\u0000${subject ?? ""}\u0000${body}`, "utf8").digest("hex");
}

interface TemplateRow {
  id: string; kind: TemplateKind; key: string; name: string; channel: Channel | null; purpose: TemplatePurpose; category: string | null; folder_id: string | null;
  folder_name: string | null; status: TemplateStatus; current_version: number; approved_version: number | null; approved_at: Date | null; approved_by_name: string | null;
  whatsapp_template_id: string | null; created_at: Date; updated_at: Date; archived_at: Date | null; subject: string | null; body: string; content_hash: string;
  tokens: string[]; version_at: Date; version_by_name: string | null;
}

const SELECT = `
  select t.id, t.kind, t.key, t.name, t.channel, t.purpose, t.category, t.folder_id, f.name as folder_name, t.status, t.current_version, t.approved_version,
         t.approved_at, nullif(ua.full_name, '') as approved_by_name, t.whatsapp_template_id, t.created_at, t.updated_at, t.archived_at,
         v.subject, v.body, v.content_hash, v.tokens, v.created_at as version_at, nullif(uv.full_name, '') as version_by_name
  from crm_message_templates t
  join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.current_version
  left join crm_folders f on f.id = t.folder_id and f.org_id = t.org_id
  left join users ua on ua.id = t.approved_by
  left join users uv on uv.id = v.created_by`;

function toView(r: TemplateRow): TemplateView {
  return {
    id: r.id, kind: r.kind, key: r.key, name: r.name, channel: r.channel, purpose: r.purpose, category: r.category, folderId: r.folder_id, folderName: r.folder_name,
    status: r.status, currentVersion: r.current_version, approvedVersion: r.approved_version, approvedAt: iso(r.approved_at), approvedByName: r.approved_by_name,
    whatsappTemplateId: r.whatsapp_template_id, subject: r.subject, body: r.body, contentHash: r.content_hash, tokens: (r.tokens ?? []).filter((t): t is TokenKey => TEMPLATE_TOKENS.some((d) => d.key === t)),
    versionCreatedAt: iso(r.version_at)!, versionCreatedByName: r.version_by_name, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, archivedAt: iso(r.archived_at),
  };
}

/** Reading templates needs the inbox or template management (the same rule as the row-level security policy). */
function assertCanRead(actor: CrmActor) {
  if (!actor.can("inbox.view") && !actor.can("templates.manage")) assertCan(actor, "inbox.view", "Your role doesn't include message templates.");
}

async function loadTemplate(db: Queryable, orgId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<TemplateRow> {
  if (!UUID_RE.test(id)) throw new AppError("not_found", "Template not found.");
  if (opts.forUpdate) await db.query("select 1 from crm_message_templates where id = $1 and org_id = $2 for update", [id, orgId]);
  const { rows } = await db.query<TemplateRow>(`${SELECT} where t.id = $1 and t.org_id = $2`, [id, orgId]);
  if (!rows[0]) throw new AppError("not_found", "Template not found.");
  return rows[0];
}

export interface TemplateFilters {
  kind?: TemplateKind;
  channel?: Channel;
  q?: string;
  /** Archived templates are hidden unless asked for. */
  includeArchived?: boolean;
  folderId?: string | null;
}

export async function listTemplates(actor: CrmActor, f: TemplateFilters = {}): Promise<TemplateView[]> {
  assertCanRead(actor);
  const params: unknown[] = [actor.orgId];
  const where = ["t.org_id = $1"];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.kind) add("t.kind = ?", f.kind);
  if (f.channel) add("t.channel = ?", f.channel);
  if (!f.includeArchived) where.push("t.archived_at is null");
  if (f.folderId) add("t.folder_id = ?", f.folderId);
  if (f.q?.trim()) add("(t.name ilike ? escape '\\' or t.key ilike ? escape '\\' or v.body ilike ? escape '\\' or coalesce(v.subject, '') ilike ? escape '\\')", `%${f.q.trim().slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<TemplateRow>(`${SELECT} where ${where.join(" and ")} order by t.kind, t.channel nulls first, lower(t.name) limit 500`, params);
    return rows.map(toView);
  });
}

export async function getTemplate(actor: CrmActor, id: string): Promise<TemplateDetail> {
  assertCanRead(actor);
  return crmRead(actor, async (db) => {
    const t = await loadTemplate(db, actor.orgId, id);
    const { rows } = await db.query<{ version: number; subject: string | null; body: string; content_hash: string; tokens: string[]; created_at: Date; by_name: string | null }>(
      `select v.version, v.subject, v.body, v.content_hash, v.tokens, v.created_at, nullif(u.full_name, '') as by_name
       from crm_message_template_versions v left join users u on u.id = v.created_by where v.template_id = $1 and v.org_id = $2 order by v.version desc limit 100`,
      [id, actor.orgId],
    );
    return {
      ...toView(t),
      versions: rows.map((v) => ({ version: v.version, subject: v.subject, body: v.body, contentHash: v.content_hash, tokens: v.tokens ?? [], createdAt: iso(v.created_at)!, createdByName: v.by_name })),
    };
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface TemplateInput {
  name?: string;
  channel?: Channel | null;
  purpose?: TemplatePurpose;
  category?: string | null;
  folderId?: string | null;
  subject?: string | null;
  body?: string;
  whatsappTemplateId?: string | null;
  /** Create only: a stable identifier for workflows. Made from the name when not given. */
  key?: string;
}

function slugKey(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return KEY_RE.test(s) ? s : "template";
}

/** A key nobody else in the workspace is using (among templates that aren't archived). */
async function freeKey(db: Queryable, orgId: string, base: string): Promise<string> {
  const { rows } = await db.query<{ key: string }>("select key from crm_message_templates where org_id = $1 and archived_at is null and (key = $2 or key like $3)", [orgId, base, `${base}-%`]);
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const k = `${base.slice(0, 44)}-${i}`;
    if (!taken.has(k)) return k;
  }
  return `${base.slice(0, 35)}-${crypto.randomBytes(4).toString("hex")}`;
}

function cleanName(raw: string | undefined, kind: TemplateKind): string {
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new AppError("invalid_input", `Name the ${kind === "canned_reply" ? "canned reply" : "template"} (up to 80 characters).`);
  return name;
}

function cleanCategory(raw: string | null | undefined): string | null {
  const c = (raw ?? "").replace(/\s+/g, " ").trim();
  if (c.length > 40) throw new AppError("invalid_input", "Categories are up to 40 characters.");
  return c || null;
}

async function checkFolder(db: Queryable, orgId: string, folderId: string | null | undefined): Promise<string | null> {
  if (!folderId) return null;
  if (!UUID_RE.test(folderId)) throw new AppError("invalid_input", "Choose a folder from the list.");
  const { rows } = await db.query("select 1 from crm_folders where id = $1 and org_id = $2 and kind = 'template'", [folderId, orgId]);
  if (!rows[0]) throw new AppError("invalid_input", "That folder no longer exists.");
  return folderId;
}

type WhatsappTemplateProvider = "ghl" | "meta_whatsapp";
const WA_PROVIDER_LABEL: Record<WhatsappTemplateProvider, string> = { ghl: "GoHighLevel", meta_whatsapp: "WhatsApp Business (Meta)" };

/**
 * Whose WhatsApp templates this workspace can send right now: Meta's own on a channel that sends through Meta, otherwise GoHighLevel's.
 * The send path looks templates up the same way (send.ts), so a template from the other provider is never offered, linked or approved.
 */
export async function currentWhatsappTemplateProvider(db: Queryable, orgId: string): Promise<WhatsappTemplateProvider> {
  const { rows } = await db.query<{ provider: string }>("select provider from messaging_channels where org_id = $1 and channel = 'whatsapp'", [orgId]);
  return rows[0]?.provider === "meta_whatsapp" ? "meta_whatsapp" : "ghl";
}

async function checkWhatsappLink(db: Queryable, orgId: string, channel: Channel | null, id: string | null | undefined): Promise<string | null> {
  const v = (id ?? "").trim();
  if (!v) return null;
  if (channel !== "whatsapp") throw new AppError("invalid_input", "Only WhatsApp templates can be linked to a template approved in WhatsApp Manager.");
  const { rows } = await db.query<{ provider: WhatsappTemplateProvider }>("select provider from whatsapp_templates where org_id = $1 and template_id = $2", [orgId, v]);
  if (!rows[0]) throw new AppError("invalid_input", "That WhatsApp template isn't synced to this workspace.");
  const current = await currentWhatsappTemplateProvider(db, orgId);
  if (rows[0].provider !== current) {
    throw new AppError("invalid_input", `That template belongs to ${WA_PROVIDER_LABEL[rows[0].provider]}, but this workspace's WhatsApp sends through ${WA_PROVIDER_LABEL[current]}. Choose one of its templates.`);
  }
  return v;
}

/**
 * Whether a CRM template's wording can be delivered with the Meta template it is linked to. Meta sends its own approved text, filled with
 * values: each token of the CRM template must sit where the Meta template has a value ({{1}}, {{2}} …) and everything else must be the same
 * words. Tokens are stood in for by a marker, so the check holds for any contact's values.
 */
export function crmWordingFitsWhatsappTemplate(crmBody: string, meta: { name: string; body: string; variables: unknown }): { ok: true } | { ok: false; detail: string } {
  const marked = renderTemplate(crmBody, {}, { missingAs: () => "⟦value⟧" }).text;
  const fit = templateFit({ name: meta.name, body: meta.body, variableCount: Array.isArray(meta.variables) ? meta.variables.length : 0 }, marked);
  return fit.ok ? { ok: true } : { ok: false, detail: fit.detail };
}

/**
 * Checks the content and turns the first error into a clear refusal. Returns what the version row stores. `customValues` is the workspace's
 * configuration values: {{custom_values.<key>}} is accepted only for those keys.
 */
function checkedContent(kind: TemplateKind, channel: Channel | null, purpose: TemplatePurpose, subjectRaw: string | null | undefined, bodyRaw: string | undefined, customValues: CustomValueCatalog = []) {
  if (kind === "template" && !isChannel(channel)) throw new AppError("invalid_input", "Choose the channel this template is for.");
  if (channel !== null && !isChannel(channel)) throw new AppError("invalid_input", "Choose a channel.");
  const body = cleanText(bodyRaw);
  const subject = channel === "email" && kind === "template" ? cleanText(subjectRaw).trim() : null;
  const check = validateTemplate(body, subject, channel, { purpose, kind, customValues });
  if (!check.ok) throw new AppError("invalid_input", check.errors[0].message);
  return { body, subject, tokens: tokensUsed(subject, body), hash: templateContentHash(channel, subject, body) };
}

async function insertVersion(db: Queryable, actor: CrmActor, templateId: string, version: number, c: { subject: string | null; body: string; hash: string; tokens: string[] }) {
  await db.query(
    `insert into crm_message_template_versions (org_id, template_id, version, subject, body, content_hash, tokens, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor.orgId, templateId, version, c.subject, c.body, c.hash, c.tokens, actor.userId],
  );
}

async function createAny(actor: CrmActor, kind: TemplateKind, input: TemplateInput): Promise<TemplateView> {
  assertCan(actor, "templates.manage", "Only owners and managers can manage message templates.");
  const name = cleanName(input.name, kind);
  const channel = input.channel ?? null;
  const purpose: TemplatePurpose = kind === "canned_reply" ? "service" : input.purpose === "marketing" ? "marketing" : "service";
  if (input.purpose && input.purpose !== "service" && input.purpose !== "marketing") throw new AppError("invalid_input", "Choose service or marketing.");
  const content = checkedContent(kind, channel, purpose, input.subject, input.body, await customValueDefsFor(actor.orgId));
  const category = cleanCategory(input.category);
  if (input.key !== undefined && !KEY_RE.test(input.key)) throw new AppError("invalid_input", "Keys use lower-case letters, numbers, - and _ (up to 48 characters).");
  return crmWrite(actor, async (db) => {
    const folderId = await checkFolder(db, actor.orgId, input.folderId);
    const wa = kind === "template" ? await checkWhatsappLink(db, actor.orgId, channel, input.whatsappTemplateId) : null;
    let key: string;
    if (input.key) {
      const dup = await db.query("select 1 from crm_message_templates where org_id = $1 and key = $2 and archived_at is null", [actor.orgId, input.key]);
      if (dup.rows[0]) throw new AppError("conflict", "Another template already uses that key.");
      key = input.key;
    } else key = await freeKey(db, actor.orgId, slugKey(name));
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_message_templates (org_id, kind, key, name, channel, purpose, category, folder_id, whatsapp_template_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [actor.orgId, kind, key, name, channel, purpose, category, folderId, wa, actor.userId],
    );
    await insertVersion(db, actor, rows[0].id, 1, content);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: kind === "canned_reply" ? "crm.canned_reply_created" : "crm.template_created", targetType: "crm_message_template", targetId: rows[0].id, result: "success", metadata: { channel, purpose, hash: content.hash } }, db);
    return toView(await loadTemplate(db, actor.orgId, rows[0].id));
  });
}

export interface UpdateResult {
  template: TemplateView;
  /** A new frozen version was recorded (the wording changed). */
  newVersion: boolean;
  /** The template was approved and is now a draft again. */
  unapproved: boolean;
}

async function updateAny(actor: CrmActor, kind: TemplateKind, id: string, input: TemplateInput & { expectedVersion?: number }): Promise<UpdateResult> {
  assertCan(actor, "templates.manage", "Only owners and managers can manage message templates.");
  return crmWrite(actor, async (db) => {
    const t = await loadTemplate(db, actor.orgId, id, { forUpdate: true });
    if (t.kind !== kind) throw new AppError("not_found", kind === "canned_reply" ? "Canned reply not found." : "Template not found.");
    if (t.status === "archived") throw new AppError("conflict", "Restore it before editing. Archived wording is kept as it was.");
    if (input.expectedVersion !== undefined && input.expectedVersion !== t.current_version) {
      throw new AppError("conflict", `Someone saved a newer version (v${t.current_version}) while you were editing. Reload to see it, then make your change again.`);
    }
    const name = input.name !== undefined ? cleanName(input.name, kind) : t.name;
    const channel = input.channel !== undefined ? input.channel : t.channel;
    const purpose: TemplatePurpose = kind === "canned_reply" ? "service" : input.purpose !== undefined ? (input.purpose === "marketing" ? "marketing" : "service") : t.purpose;
    if (input.purpose !== undefined && input.purpose !== "service" && input.purpose !== "marketing") throw new AppError("invalid_input", "Choose service or marketing.");
    const category = input.category !== undefined ? cleanCategory(input.category) : t.category;
    const folderId = input.folderId !== undefined ? await checkFolder(db, actor.orgId, input.folderId) : t.folder_id;
    const content = checkedContent(kind, channel, purpose, input.subject !== undefined ? input.subject : t.subject, input.body !== undefined ? input.body : t.body, await loadCustomValueDefs(db, actor.orgId));
    let wa = t.whatsapp_template_id;
    if (kind === "template") {
      if (input.whatsappTemplateId !== undefined) wa = await checkWhatsappLink(db, actor.orgId, channel, input.whatsappTemplateId);
      else if (channel !== "whatsapp") wa = null;
    }
    const newVersion = content.hash !== t.content_hash;
    // What a person approved is the wording, the purpose (consent rules differ) and, for WhatsApp, the Meta template it relies on.
    const unapproved = t.status === "approved" && (newVersion || purpose !== t.purpose || wa !== t.whatsapp_template_id);
    const version = newVersion ? t.current_version + 1 : t.current_version;
    if (newVersion) await insertVersion(db, actor, id, version, content);
    await db.query(
      `update crm_message_templates set name = $3, channel = $4, purpose = $5, category = $6, folder_id = $7, whatsapp_template_id = $8, current_version = $9,
         status = case when $10::boolean then 'draft' else status end,
         approved_version = case when $10::boolean then null else approved_version end,
         approved_by = case when $10::boolean then null else approved_by end,
         approved_at = case when $10::boolean then null else approved_at end
       where id = $1 and org_id = $2`,
      [id, actor.orgId, name, channel, purpose, category, folderId, wa, version, unapproved],
    );
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: kind === "canned_reply" ? "crm.canned_reply_updated" : "crm.template_updated", targetType: "crm_message_template", targetId: id, result: "success",
      metadata: { version, newVersion, unapproved, hash: content.hash },
    }, db);
    return { template: toView(await loadTemplate(db, actor.orgId, id)), newVersion, unapproved };
  });
}

async function archiveAny(actor: CrmActor, kind: TemplateKind, id: string): Promise<void> {
  assertCan(actor, "templates.manage", "Only owners and managers can manage message templates.");
  await crmWrite(actor, async (db) => {
    const t = await loadTemplate(db, actor.orgId, id, { forUpdate: true });
    if (t.kind !== kind) throw new AppError("not_found", "Not found.");
    if (t.status === "archived") return;
    // Archiving withdraws the approval too (the database requires it): an archived template is never used for automated sends.
    await db.query(
      "update crm_message_templates set status = 'archived', archived_at = now(), approved_version = null, approved_by = null, approved_at = null where id = $1 and org_id = $2",
      [id, actor.orgId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: kind === "canned_reply" ? "crm.canned_reply_archived" : "crm.template_archived", targetType: "crm_message_template", targetId: id, result: "success", metadata: { wasApproved: t.status === "approved" } }, db);
  });
}

async function restoreAny(actor: CrmActor, kind: TemplateKind, id: string): Promise<TemplateView> {
  assertCan(actor, "templates.manage", "Only owners and managers can manage message templates.");
  return crmWrite(actor, async (db) => {
    const t = await loadTemplate(db, actor.orgId, id, { forUpdate: true });
    if (t.kind !== kind) throw new AppError("not_found", "Not found.");
    if (t.status !== "archived") return toView(t);
    // Another template may have taken the key meanwhile; a restored one then gets a fresh key rather than failing.
    const key = await freeKey(db, actor.orgId, t.key);
    await db.query("update crm_message_templates set status = 'draft', archived_at = null, key = $3 where id = $1 and org_id = $2", [id, actor.orgId, key]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: kind === "canned_reply" ? "crm.canned_reply_restored" : "crm.template_restored", targetType: "crm_message_template", targetId: id, result: "success", metadata: { keyChanged: key !== t.key } }, db);
    return toView(await loadTemplate(db, actor.orgId, id));
  });
}

async function duplicateAny(actor: CrmActor, kind: TemplateKind, id: string): Promise<TemplateView> {
  assertCan(actor, "templates.manage", "Only owners and managers can manage message templates.");
  const source = await crmWrite(actor, (db) => loadTemplate(db, actor.orgId, id));
  if (source.kind !== kind) throw new AppError("not_found", "Not found.");
  const name = `Copy of ${source.name}`.slice(0, 80);
  return createAny(actor, kind, {
    name, channel: source.channel, purpose: source.purpose, category: source.category, folderId: source.folder_id, subject: source.subject, body: source.body,
    whatsappTemplateId: source.whatsapp_template_id,
  });
}

export const createTemplate = (actor: CrmActor, input: TemplateInput) => createAny(actor, "template", input);
export const updateTemplate = (actor: CrmActor, id: string, input: TemplateInput & { expectedVersion?: number }) => updateAny(actor, "template", id, input);
export const archiveTemplate = (actor: CrmActor, id: string) => archiveAny(actor, "template", id);
export const restoreTemplate = (actor: CrmActor, id: string) => restoreAny(actor, "template", id);
export const duplicateTemplate = (actor: CrmActor, id: string) => duplicateAny(actor, "template", id);

/**
 * Approves the exact version a person looked at. The caller names the version and its content hash; if anyone saved a newer version in the
 * meantime, nothing is approved. Only people in the client's own workspace approve: iAcquire support never approves wording for a client.
 */
export async function approveTemplate(actor: CrmActor, id: string, input: { version: number; contentHash: string }): Promise<TemplateView> {
  assertCan(actor, "templates.manage", "Only owners and managers can approve message templates.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Approving wording for automated use is the client's decision. Someone in the workspace with template access approves it.");
  return crmWrite(actor, async (db) => {
    const t = await loadTemplate(db, actor.orgId, id, { forUpdate: true });
    if (t.kind !== "template") throw new AppError("invalid_input", "Canned replies are sent by a person, so they don't need approval.");
    if (t.status === "archived") throw new AppError("conflict", "Restore this template before approving it.");
    if (input.version !== t.current_version || input.contentHash !== t.content_hash) {
      throw new AppError("conflict", `This template changed while you were reviewing it (now v${t.current_version}). Review the latest version and approve that one.`);
    }
    if (t.status === "approved" && t.approved_version === t.current_version) return toView(t);
    const check = validateTemplate(t.body, t.subject, t.channel, { purpose: t.purpose, kind: "template", customValues: await loadCustomValueDefs(db, actor.orgId) });
    if (!check.ok) throw new AppError("invalid_input", `It can't be approved yet: ${check.errors[0].message}`);
    if (t.whatsapp_template_id) {
      const provider = await currentWhatsappTemplateProvider(db, actor.orgId);
      const wa = await db.query<{ status: string; name: string; body: string; variables: unknown }>(
        "select status, name, body, variables from whatsapp_templates where org_id = $1 and template_id = $2 and provider = $3",
        [actor.orgId, t.whatsapp_template_id, provider],
      );
      const w = wa.rows[0];
      if (!w) throw new AppError("conflict", `The linked WhatsApp template isn't one of ${WA_PROVIDER_LABEL[provider]}'s templates, which this workspace's WhatsApp sends through now. Link one of those.`);
      if (w.status !== "approved") throw new AppError("conflict", `The linked WhatsApp template isn't approved by ${provider === "meta_whatsapp" ? "Meta" : "GoHighLevel"} yet, so this can't be approved for sending.`);
      if (provider === "meta_whatsapp") {
        // Meta delivers its own approved wording: approving different words here would approve text no customer receives.
        const fit = crmWordingFitsWhatsappTemplate(t.body, w);
        if (!fit.ok) throw new AppError("conflict", `It can't be approved: WhatsApp would deliver the linked template's wording, not this one. ${fit.detail}`);
      }
    }
    await db.query(
      "update crm_message_templates set status = 'approved', approved_version = current_version, approved_by = $3, approved_at = now() where id = $1 and org_id = $2",
      [id, actor.orgId, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.template_approved", targetType: "crm_message_template", targetId: id, result: "success", metadata: { version: t.current_version, hash: t.content_hash, channel: t.channel, purpose: t.purpose } }, db);
    return toView(await loadTemplate(db, actor.orgId, id));
  });
}

export interface ApprovedTemplateVersion {
  templateId: string;
  key: string;
  name: string;
  channel: Channel;
  purpose: TemplatePurpose;
  version: number;
  subject: string | null;
  body: string;
  contentHash: string;
  tokens: TokenKey[];
  whatsappTemplateId: string | null;
}

/**
 * The exact wording a person approved, for automated sends (workflows, reminders): the frozen approved version, never the draft being edited.
 * Looked up by id or key inside the caller's transaction. Null when the template doesn't exist in this workspace, isn't approved, or the
 * caller expects a content hash that no longer matches (the approval moved on), so nothing unapproved is ever sent automatically.
 */
export async function loadApprovedTemplate(db: Queryable, orgId: string, ref: { id?: string; key?: string; contentHash?: string }): Promise<ApprovedTemplateVersion | null> {
  if (!ref.id && !ref.key) return null;
  if (ref.id && !UUID_RE.test(ref.id)) return null;
  const { rows } = await db.query<{ id: string; key: string; name: string; channel: Channel; purpose: TemplatePurpose; version: number; subject: string | null; body: string; content_hash: string; tokens: string[]; whatsapp_template_id: string | null }>(
    `select t.id, t.key, t.name, t.channel, t.purpose, v.version, v.subject, v.body, v.content_hash, v.tokens, t.whatsapp_template_id
     from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.approved_version
     where t.org_id = $1 and t.kind = 'template' and t.status = 'approved' and ($2::uuid is null or t.id = $2) and ($3::text is null or (t.key = $3 and t.archived_at is null))`,
    [orgId, ref.id ?? null, ref.key ?? null],
  );
  const r = rows[0];
  if (!r || (ref.contentHash && ref.contentHash !== r.content_hash)) return null;
  return {
    templateId: r.id, key: r.key, name: r.name, channel: r.channel, purpose: r.purpose, version: r.version, subject: r.subject, body: r.body, contentHash: r.content_hash,
    tokens: (r.tokens ?? []).filter((t): t is TokenKey => TEMPLATE_TOKENS.some((d) => d.key === t)), whatsappTemplateId: r.whatsapp_template_id,
  };
}

// ---------------------------------------------------------------------------
// Canned replies: any channel, inserted into the inbox composer, edited and sent by a person
// ---------------------------------------------------------------------------

export async function listCannedReplies(actor: CrmActor, opts: { channel?: Channel; q?: string } = {}): Promise<TemplateView[]> {
  const all = await listTemplates(actor, { kind: "canned_reply", q: opts.q });
  return opts.channel ? all.filter((t) => t.channel === null || t.channel === opts.channel) : all;
}
export const createCannedReply = (actor: CrmActor, input: Pick<TemplateInput, "name" | "body" | "channel" | "folderId" | "category">) => createAny(actor, "canned_reply", { ...input, purpose: "service", subject: null });
export const updateCannedReply = (actor: CrmActor, id: string, input: Pick<TemplateInput, "name" | "body" | "channel" | "folderId" | "category"> & { expectedVersion?: number }) =>
  updateAny(actor, "canned_reply", id, { ...input, purpose: "service", subject: null });
export const archiveCannedReply = (actor: CrmActor, id: string) => archiveAny(actor, "canned_reply", id);
export const restoreCannedReply = (actor: CrmActor, id: string) => restoreAny(actor, "canned_reply", id);
export const duplicateCannedReply = (actor: CrmActor, id: string) => duplicateAny(actor, "canned_reply", id);

// ---------------------------------------------------------------------------
// Token values: a real contact of this workspace, or labelled samples
// ---------------------------------------------------------------------------

export type ValueSource = "contact" | "business" | "sender" | "appointment" | "sample" | "missing";

export interface TokenValueRow {
  key: TokenKey;
  label: string;
  value: string | null;
  source: ValueSource;
}

export interface TokenValueSet {
  values: TokenValues;
  rows: TokenValueRow[];
  contact: { id: string; name: string } | null;
  /** The workspace's configuration values ({{custom_values.<key>}}), already in `values`; pass to the renderer for labels and checks. */
  customValues: CustomValueTokenDef[];
}

function formatInZone(d: Date, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(d);
  }
}

/**
 * Values for every token, with where each came from. Business details come from the workspace's own profile and the sender's name from the
 * person acting; contact and appointment details from the chosen contact (which must belong to this workspace), or labelled samples.
 * Appointment details are the contact's next upcoming appointment, when there is one. The manage link is only known when a message is sent
 * for a specific booking (it carries that booking's own token), so it stays missing here and a template that needs it can't be test-sent
 * with a real contact: the preview says so instead of inventing one.
 */
export async function tokenValuesFor(db: Queryable, orgId: string, opts: { contactId?: string | null; senderUserId?: string | null; timezone?: string; now?: Date; samples?: boolean }): Promise<TokenValueSet> {
  const values: TokenValues = {};
  const source: Partial<Record<TokenKey, ValueSource>> = {};
  const set = (k: TokenKey, v: string | null | undefined, s: ValueSource) => {
    const clean = (v ?? "").trim();
    if (clean) {
      values[k] = clean;
      source[k] = s;
    }
  };
  const biz = await db.query<{ name: string; timezone: string; website: string | null; contact_email: string | null; contact_phone: string | null }>(
    "select o.name, o.timezone, o.website, p.contact_email, p.contact_phone from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1",
    [orgId],
  );
  const b = biz.rows[0];
  set("business.name", b?.name, "business");
  set("business.phone", b?.contact_phone, "business");
  set("business.email", b?.contact_email, "business");
  set("business.website", b?.website, "business");
  if (opts.senderUserId) {
    const u = await db.query<{ full_name: string | null }>("select full_name from users where id = $1", [opts.senderUserId]);
    set("user.first_name", (u.rows[0]?.full_name ?? "").trim().split(/\s+/)[0], "sender");
  }
  // Configuration values are the business's own, like its name: filled values, empty optional ones as "" and empty required ones left out
  // (so they count as missing and a send is refused with the reason).
  const customValues = await loadCustomValueDefs(db, orgId);
  Object.assign(values, customValueTokenValues(customValues));
  const tz = opts.timezone ?? b?.timezone ?? "UTC";
  let contact: TokenValueSet["contact"] = null;
  if (opts.contactId) {
    if (!UUID_RE.test(opts.contactId)) throw new AppError("not_found", "Contact not found.");
    const c = await db.query<{ id: string; display_name: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>(
      "select id, display_name, first_name, last_name, email::text as email, phone from contacts where id = $1 and org_id = $2 and deleted_at is null",
      [opts.contactId, orgId],
    );
    const k = c.rows[0];
    if (!k) throw new AppError("not_found", "Contact not found.");
    const ids = await db.query<{ kind: string; value: string }>("select kind, value from contact_identities where org_id = $1 and contact_id = $2 order by verified desc, created_at", [orgId, k.id]);
    const full = (k.display_name || [k.first_name, k.last_name].filter(Boolean).join(" ")).trim();
    contact = { id: k.id, name: full || "Unnamed contact" };
    set("contact.first_name", k.first_name || (k.display_name ? k.display_name.trim().split(/\s+/)[0] : null), "contact");
    set("contact.last_name", k.last_name, "contact");
    set("contact.full_name", full, "contact");
    set("contact.email", k.email ?? ids.rows.find((i) => i.kind === "email")?.value, "contact");
    set("contact.phone", k.phone ?? ids.rows.find((i) => i.kind === "phone")?.value, "contact");
    const appt = await db.query<{ title: string; start_at: Date; timezone: string | null; invitee_timezone: string | null; location: string | null }>(
      `select title, start_at, timezone, invitee_timezone, location from appointment_refs
       where org_id = $1 and contact_id = $2 and status in ('new', 'confirmed') and cancelled_at is null and start_at > $3 order by start_at limit 1`,
      [orgId, k.id, (opts.now ?? new Date()).toISOString()],
    );
    const a = appt.rows[0];
    if (a) {
      // The customer reads the time in their own zone when they booked with one, else in the appointment's or the workspace's.
      const zone = a.invitee_timezone || a.timezone || tz;
      set("appointment.date", formatInZone(new Date(a.start_at), zone, { weekday: "long", month: "long", day: "numeric" }), "appointment");
      set("appointment.time", formatInZone(new Date(a.start_at), zone, { hour: "numeric", minute: "2-digit" }), "appointment");
      set("appointment.type", a.title, "appointment");
      set("appointment.location", a.location, "appointment");
    }
  }
  if (opts.samples) {
    const samples = sampleTokenValues();
    for (const t of TEMPLATE_TOKENS) if (!values[t.key] && (t.group === "contact" || t.group === "appointment" || t.group === "user")) set(t.key, samples[t.key], "sample");
  }
  const rows = TEMPLATE_TOKENS.map((t) => ({ key: t.key as TokenKey, label: t.label, value: (values[t.key] as string | undefined) ?? null, source: source[t.key] ?? ("missing" as const) }));
  return { values, rows, contact, customValues };
}

/**
 * A review request's private link exists only once the request is sent (src/server/crm/reviews.ts issues it), so a preview shows where it
 * goes instead of calling it missing: the labelled sample link with sample values, a placeholder with a real contact. Real sends never use
 * this: anything but a review request still has no value for {{review.link}} and is refused.
 */
function withReviewLinkPreview(set: TokenValueSet, mode: "sample" | "contact"): TokenValueSet {
  if (set.values["review.link"]) return set;
  const value = mode === "sample" ? sampleTokenValues()["review.link"] : REVIEW_LINK_PREVIEW;
  return { ...set, values: { ...set.values, "review.link": value }, rows: set.rows.map((r) => (r.key === "review.link" ? { ...r, value, source: "sample" as const } : r)) };
}

/**
 * The values the template editor previews unsaved wording with: a real contact of this workspace (read as the actor, so only one they may
 * open), or labelled samples. The editor renders with the shared pure renderer, so what it shows is exactly what a send would produce.
 */
export async function previewValues(actor: CrmActor, opts: { contactId?: string | null } = {}): Promise<TokenValueSet> {
  assertCanRead(actor);
  if (opts.contactId && !actor.can("contacts.view")) throw new AppError("forbidden", "Your role can't see contact details, so preview with sample values instead.");
  const set = await crmRead(actor, (db) => tokenValuesFor(db, actor.orgId, { contactId: opts.contactId ?? null, senderUserId: actor.userId, timezone: actor.timezone, samples: !opts.contactId }));
  return withReviewLinkPreview(set, opts.contactId ? "contact" : "sample");
}

export interface TemplatePreview {
  version: number;
  subject: string | null;
  body: string;
  missing: AnyTokenKey[];
  unknown: string[];
  /** Sentence for what is missing, empty when nothing is. */
  missingText: string;
  mode: "contact" | "sample";
  contact: { id: string; name: string } | null;
  values: TokenValueRow[];
}

/** Renders a template version with a real contact of this workspace, or with labelled sample values. */
export async function previewTemplate(actor: CrmActor, id: string, opts: { contactId?: string | null; version?: number } = {}): Promise<TemplatePreview> {
  assertCanRead(actor);
  return crmRead(actor, async (db) => {
    const t = await loadTemplate(db, actor.orgId, id);
    let subject = t.subject;
    let body = t.body;
    let version = t.current_version;
    if (opts.version && opts.version !== t.current_version) {
      const v = await db.query<{ subject: string | null; body: string }>("select subject, body from crm_message_template_versions where template_id = $1 and org_id = $2 and version = $3", [id, actor.orgId, opts.version]);
      if (!v.rows[0]) throw new AppError("not_found", "That version doesn't exist.");
      ({ subject, body } = v.rows[0]);
      version = opts.version;
    }
    // Contact details are read as the actor (row-level security for members), so a preview can't reveal a contact they couldn't open.
    if (opts.contactId && !actor.can("contacts.view")) throw new AppError("forbidden", "Your role can't see contact details, so preview with sample values instead.");
    const set = withReviewLinkPreview(await tokenValuesFor(db, actor.orgId, { contactId: opts.contactId ?? null, senderUserId: actor.userId, timezone: actor.timezone, samples: !opts.contactId }), opts.contactId ? "contact" : "sample");
    const out = renderMessage({ subject, body }, set.values, { customValues: set.customValues });
    return {
      version, subject: out.subject, body: out.body, missing: out.missing, unknown: out.unknown, missingText: describeMissing(out.missing, out.unknown, set.customValues),
      mode: opts.contactId ? "contact" : "sample", contact: set.contact, values: set.rows,
    };
  });
}

/**
 * What the inbox composer needs to insert a canned reply for one conversation's contact: the replies, the values to fill them with, and the
 * workspace's configuration values (labels and whether each is required), so an empty required one is named in the gap it leaves.
 */
export async function cannedRepliesForConversation(actor: CrmActor, input: { channel: Channel; contactId: string }): Promise<{ replies: Array<Pick<TemplateView, "id" | "name" | "body" | "channel" | "folderName">>; values: TokenValues; customValues?: CustomValueTokenDef[] }> {
  if (!actor.can("inbox.reply")) return { replies: [], values: {} };
  const replies = await listCannedReplies(actor, { channel: input.channel });
  if (!replies.length) return { replies: [], values: {} };
  // The person can already see this conversation (the inbox checked it), so the contact's name and address are read with trusted access.
  const set = await withSystem((db) => tokenValuesFor(db, actor.orgId, { contactId: input.contactId, senderUserId: actor.userId, timezone: actor.timezone }));
  return {
    replies: replies.map((r) => ({ id: r.id, name: r.name, body: r.body, channel: r.channel, folderName: r.folderName })), values: set.values,
    customValues: set.customValues.map(({ key, label, required }) => ({ key, label, required })),
  };
}

// ---------------------------------------------------------------------------
// WhatsApp templates synced from Meta (read-only here: they are created and submitted in WhatsApp Manager)
// ---------------------------------------------------------------------------

export interface WhatsappTemplateView {
  templateId: string;
  name: string;
  language: string;
  body: string;
  status: "pending" | "approved" | "rejected";
  category: "marketing" | "utility" | "authentication" | null;
  provider: "ghl" | "meta_whatsapp";
  variables: Array<{ position: number; label: string }>;
  rejectionReason: string | null;
  checkedAt: string | null;
  /**
   * The template belongs to the provider this workspace's WhatsApp sends through now. A template left over from the other provider (after
   * a switch between GoHighLevel and Meta) is listed for reference but can't be linked, approved or sent.
   */
  usable: boolean;
}

/**
 * The WhatsApp templates the inbox composer offers when the reply window has closed: approved ones of the provider that carries WhatsApp
 * now, with their wording so the composer can start from it. Reads with the caller's connection (row-level security for members).
 */
export async function sendableWhatsappTemplates(db: Queryable, orgId: string): Promise<Array<{ id: string; name: string; body: string }>> {
  const provider = await currentWhatsappTemplateProvider(db, orgId);
  const { rows } = await db.query<{ id: string; name: string; body: string }>(
    "select template_id as id, name, body from whatsapp_templates where org_id = $1 and status = 'approved' and provider = $2 order by name",
    [orgId, provider],
  );
  return rows;
}

export async function listWhatsappTemplates(actor: CrmActor): Promise<WhatsappTemplateView[]> {
  assertCanRead(actor);
  return crmRead(actor, async (db) => {
    const current = await currentWhatsappTemplateProvider(db, actor.orgId);
    const { rows } = await db.query<{ template_id: string; name: string; language: string; body: string; status: WhatsappTemplateView["status"]; category: WhatsappTemplateView["category"]; provider: WhatsappTemplateView["provider"]; variables: unknown; rejection_reason: string | null; checked_at: Date | null }>(
      "select template_id, name, language, body, status, category, provider, variables, rejection_reason, checked_at from whatsapp_templates where org_id = $1 order by provider = $2 desc, status = 'approved' desc, lower(name)",
      [actor.orgId, current],
    );
    return rows.map((r) => ({
      usable: r.provider === current,
      templateId: r.template_id, name: r.name, language: r.language, body: r.body, status: r.status, category: r.category, provider: r.provider,
      variables: Array.isArray(r.variables)
        ? (r.variables as unknown[]).flatMap((v, i) => {
            if (typeof v !== "object" || v === null) return [];
            const o = v as Record<string, unknown>;
            return [{ position: Number.isInteger(o.position) ? (o.position as number) : i + 1, label: typeof o.label === "string" ? o.label.slice(0, 80) : `Value ${i + 1}` }];
          })
        : [],
      rejectionReason: r.rejection_reason, checkedAt: iso(r.checked_at),
    }));
  });
}

// ---------------------------------------------------------------------------
// Approved test destinations
// ---------------------------------------------------------------------------

export interface TestDestinationView {
  channel: Channel;
  address: string;
  label: string;
  approvedByName: string | null;
  approvedAt: string;
}

const MAX_TEST_DESTINATIONS_PER_CHANNEL = 10;

/** Who may see the list: people who configure messaging, and people who manage templates (they choose a destination for a test). */
export async function listTestDestinations(actor: CrmActor, opts: { channel?: Channel } = {}): Promise<TestDestinationView[]> {
  if (!actor.can("messaging.configure") && !actor.can("templates.manage")) assertCan(actor, "messaging.configure");
  // Trusted read after the check: the row-level policy only covers messaging.configure.
  return withSystem(async (db) => {
    const { rows } = await db.query<{ channel: Channel; address: string; label: string; by_name: string | null; approved_at: Date }>(
      `select d.channel, d.address, d.label, nullif(u.full_name, '') as by_name, d.approved_at from approved_test_destinations d left join users u on u.id = d.approved_by
       where d.org_id = $1 and ($2::text is null or d.channel = $2) order by d.channel, d.approved_at`,
      [actor.orgId, opts.channel ?? null],
    );
    return rows.map((r) => ({ channel: r.channel, address: r.address, label: r.label, approvedByName: r.by_name, approvedAt: iso(r.approved_at)! }));
  });
}

/**
 * Approves an address of your own (your phone, your inbox) for setup test messages. Customers are never test recipients: the person adding it
 * confirms it belongs to the business, and that confirmation is recorded with their name.
 */
export async function addTestDestination(actor: CrmActor, input: { channel: string; address: string; label?: string; confirmOwnAddress: boolean }): Promise<TestDestinationView> {
  assertCan(actor, "messaging.configure", "Only owners and managers can approve test destinations.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Test destinations are approved by someone in the client's own workspace.");
  if (!isChannel(input.channel)) throw new AppError("invalid_input", "Choose a channel.");
  const channel = input.channel;
  const address = normalizeAddress(channel, input.address);
  if (!address) throw new AppError("invalid_input", channel === "email" ? "Enter a valid email address." : "Enter the number in international format, starting with + and the country code (for example +15555550123).");
  if (!input.confirmOwnAddress) throw new AppError("invalid_input", "Confirm this address belongs to you or your business. Customers are never used as test recipients.");
  const label = (input.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return withSystem(async (db) => {
    const n = await db.query<{ n: string }>("select count(*)::text as n from approved_test_destinations where org_id = $1 and channel = $2", [actor.orgId, channel]);
    if (Number(n.rows[0].n) >= MAX_TEST_DESTINATIONS_PER_CHANNEL) throw new AppError("conflict", `A workspace can approve up to ${MAX_TEST_DESTINATIONS_PER_CHANNEL} test destinations per channel. Remove one first.`);
    const res = await db.query("insert into approved_test_destinations (org_id, channel, address, label, approved_by) values ($1, $2, $3, $4, $5) on conflict do nothing", [actor.orgId, channel, address, label, actor.userId]);
    if (!res.rowCount) throw new AppError("conflict", "That address is already an approved test destination.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "messaging.test_destination_added", targetType: "approved_test_destination", targetId: `${channel}:${address}`.slice(0, 200), result: "success", metadata: { channel } }, db);
    return (await db.query<{ channel: Channel; address: string; label: string; approved_at: Date }>("select channel, address, label, approved_at from approved_test_destinations where org_id = $1 and channel = $2 and address = $3", [actor.orgId, channel, address])).rows
      .map((r) => ({ channel: r.channel, address: r.address, label: r.label, approvedByName: actor.label, approvedAt: iso(r.approved_at)! }))[0];
  });
}

export async function removeTestDestination(actor: CrmActor, input: { channel: string; address: string }): Promise<void> {
  assertCan(actor, "messaging.configure", "Only owners and managers can change test destinations.");
  if (!isChannel(input.channel)) throw new AppError("invalid_input", "Choose a channel.");
  const address = normalizeAddress(input.channel, input.address) ?? input.address.trim();
  await withSystem(async (db) => {
    const res = await db.query("delete from approved_test_destinations where org_id = $1 and channel = $2 and address = $3", [actor.orgId, input.channel, address]);
    if (!res.rowCount) throw new AppError("not_found", "That test destination wasn't found.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "messaging.test_destination_removed", targetType: "approved_test_destination", targetId: `${input.channel}:${address}`.slice(0, 200), result: "success", metadata: { channel: input.channel } }, db);
  });
}

// ---------------------------------------------------------------------------
// Test sends
// ---------------------------------------------------------------------------

const isTransport = isTransportName;

/**
 * The contact a test destination is sent to. An address that already belongs to a contact keeps that record (and its consent history);
 * otherwise a contact is created for it, attributed to a person ("manual") rather than to an inbound message, with the address marked as
 * confirmed by staff: the person approving the destination confirmed it is their own or their business's.
 */
async function testDestinationContact(db: Queryable, orgId: string, channel: Channel, address: string, name: string): Promise<string> {
  const kind = channel === "email" ? "email" : "phone";
  const found = await db.query<{ contact_id: string }>(
    `select i.contact_id from contact_identities i join contacts c on c.id = i.contact_id and c.org_id = i.org_id
     where i.org_id = $1 and i.kind = $2 and i.value = $3 and c.deleted_at is null`,
    [orgId, kind, address],
  );
  if (found.rows[0]) return found.rows[0].contact_id;
  const { rows } = await db.query<{ id: string }>(
    "insert into contacts (org_id, display_name, email, phone, source, created_via) values ($1, $2, $3, $4, 'test_destination', 'manual') returning id",
    [orgId, name.slice(0, 200), kind === "email" ? address : null, kind === "phone" ? address : null],
  );
  await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified, verified_via) values ($1, $2, $3, $4, true, 'staff_confirmed')", [orgId, rows[0].id, kind, address]);
  return rows[0].id;
}

export type TestSendResult =
  | { ok: true; messageId: string; conversationId: string; status: "queued"; to: string; detail: string }
  | {
      ok: false;
      reason: "not_a_template" | "destination_not_approved" | "channel_not_enabled" | "transport_disabled" | "missing_values" | "opted_out" | "refused" | "duplicate";
      detail: string;
    };

/** Test messages for one destination live in their own thread, apart from any real conversation with that address. */
const TEST_THREAD = "test-messages";

/**
 * Sends the template's current version to an approved test destination, through the normal outbound path as the person asking (so consent,
 * suppression, credits and every other rule apply exactly as they would to a customer). Nothing is queued unless every check passes; the
 * result says precisely why when one doesn't. Returns the queued message: the caller dispatches it and shows the real outcome.
 */
export async function testSendTemplate(actor: CrmActor, id: string, input: { destination: string; contactId?: string | null }): Promise<TestSendResult> {
  assertCan(actor, "templates.manage", "Only owners and managers can send test messages.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Test messages are sent by someone in the client's own workspace.");
  const userId = actor.userId;
  const t = await crmRead(actor, (db) => loadTemplate(db, actor.orgId, id));
  if (t.kind !== "template" || !t.channel) return { ok: false, reason: "not_a_template", detail: "Only templates with a channel can be test-sent. Canned replies are tried from the inbox." };
  if (t.status === "archived") return { ok: false, reason: "not_a_template", detail: "This template is archived. Restore it to test it." };
  const channel = t.channel;
  const label = CHANNEL_LABELS[channel];
  const to = normalizeAddress(channel, input.destination);
  if (input.contactId && !actor.can("contacts.view")) throw new AppError("forbidden", "Your role can't see contact details, so test with sample values instead.");

  const pre = await withSystem(async (db) => {
    const dest = to ? await db.query<{ label: string }>("select label from approved_test_destinations where org_id = $1 and channel = $2 and address = $3", [actor.orgId, channel, to]) : { rows: [] as Array<{ label: string }> };
    if (!dest.rows[0]) return { ok: false as const, reason: "destination_not_approved" as const, detail: `Test messages only go to ${label} destinations your workspace approved in Communication Settings. Nothing was sent.` };
    const ch = await db.query<{ enabled: boolean; provider: string }>("select enabled, provider from messaging_channels where org_id = $1 and channel = $2", [actor.orgId, channel]);
    if (!ch.rows[0]?.enabled) return { ok: false as const, reason: "channel_not_enabled" as const, detail: `${label} isn't enabled for this workspace yet, so nothing was sent.` };
    const provider = isTransport(ch.rows[0].provider) ? ch.rows[0].provider : "ghl";
    if (!transportWritesEnabled(provider)) {
      return { ok: false as const, reason: "transport_disabled" as const, detail: `Sending through ${TRANSPORT_LABELS[provider]} is switched off for this environment, so nothing was sent.` };
    }
    // With sample values a review request template carries the sample link, like the sample manage link; with a real contact it has none.
    const loaded = await tokenValuesFor(db, actor.orgId, { contactId: input.contactId ?? null, senderUserId: userId, timezone: actor.timezone, samples: !input.contactId });
    const values = input.contactId ? loaded : withReviewLinkPreview(loaded, "sample");
    const rendered = renderMessage({ subject: t.subject, body: t.body }, values.values, { customValues: values.customValues });
    if (!rendered.ok) return { ok: false as const, reason: "missing_values" as const, detail: `${describeMissing(rendered.missing, rendered.unknown, values.customValues)} Nothing was sent.` };
    return { ok: true as const, rendered, destinationLabel: dest.rows[0].label };
  });
  if (!pre.ok) return pre;

  try {
    return await withSystem(async (db) => {
      // An address that is already a contact keeps its record (and its consent history); otherwise a contact is created for the destination.
      const name = `Test destination${pre.destinationLabel ? `: ${pre.destinationLabel}` : ""}`.slice(0, 200);
      const contactId = await testDestinationContact(db, actor.orgId, channel, to!, name);
      // A message to a contact goes to that contact's main address for the channel. If the approved address is only a second address on
      // someone else's record (a customer's), the test would reach the customer: refuse before anything is recorded on their record.
      if ((await contactAddress(db, actor.orgId, contactId, channel)) !== to) {
        return {
          ok: false as const,
          reason: "destination_not_approved" as const,
          detail: `${to} is also on a customer's record whose main ${channel === "email" ? "email address" : "number"} is different, so a test would reach them. Use another test destination. Nothing was sent.`,
        };
      }
      const consent = await getConsent(db, actor.orgId, contactId, channel, "service");
      if (consent === "revoked") return { ok: false as const, reason: "opted_out" as const, detail: `${to} opted out of ${label} messages, so nothing was sent. They can opt back in by replying START.` };
      if (consent !== "granted") {
        await recordConsent(db, { orgId: actor.orgId, contactId, channel, purpose: "service", status: "granted", source: "test_destination", evidence: `Approved as a ${label} test destination; test sent by ${actor.label}.`, recordedBy: userId });
      }
      let conv = (await db.query<{ id: string }>("select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and thread_key = $4", [actor.orgId, contactId, channel, TEST_THREAD])).rows[0];
      if (!conv) {
        conv = (await db.query<{ id: string }>(
          "insert into conversations (org_id, contact_id, channel, thread_key, subject, owner_kind, owner_user_id) values ($1, $2, $3, $4, $5, 'human', $6) returning id",
          [actor.orgId, contactId, channel, TEST_THREAD, pre.rendered.subject, userId],
        )).rows[0];
      } else {
        // The test thread is always the sender's, so the AI never answers in it; the subject follows the template being tried.
        await db.query("update conversations set owner_kind = 'human', owner_user_id = $2, subject = $3 where id = $1", [conv.id, userId, pre.rendered.subject]);
      }
      const queued = await queueOutbound(db, {
        orgId: actor.orgId, conversationId: conv.id, scope: "human", actor: { kind: "human", userId }, body: pre.rendered.body, purpose: "service",
        templateId: channel === "whatsapp" ? t.whatsapp_template_id : null,
        dedupeKey: `test:${t.id}:v${t.current_version}:${to}:${Math.floor(Date.now() / 60_000)}`,
      });
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.template_test_sent", targetType: "crm_message_template", targetId: t.id, result: "success", metadata: { version: t.current_version, channel, messageId: queued.messageId } }, db);
      return { ok: true as const, messageId: queued.messageId, conversationId: conv.id, status: "queued" as const, to: to!, detail: `Queued for ${to}.` };
    });
  } catch (err) {
    // queueOutbound refuses a person's send it can't make with the reason; the whole attempt rolled back, so nothing was queued.
    if (err instanceof AppError && (err.code === "conflict" || err.code === "usage_limit")) return { ok: false, reason: "refused", detail: `${err.message} Nothing was sent.` };
    if ((err as { code?: string }).code === "23505") return { ok: false, reason: "duplicate", detail: "This version was just sent to that destination. Wait a minute before sending it again." };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Communication Settings (read model: no credentials, ever)
// ---------------------------------------------------------------------------

export interface CapabilityCheckView {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ChannelSettingsView {
  channel: Channel;
  provider: TransportName;
  providerLabel: string;
  /** A channel row exists (someone started setting it up). */
  configured: boolean;
  enabled: boolean;
  senderIdentity: string | null;
  inboundAddress: string | null;
  senderVerified: boolean;
  registrationStatus: string;
  lastTest: { ok: boolean; at: string | null; checks: CapabilityCheckView[] } | null;
  /** Shown when the channel is off: why, in plain words. */
  whyOff: string | null;
  /** The environment lets this transport send. */
  writesEnabled: boolean;
  detail: string | null;
  updatedAt: string | null;
}

/** Turns a stored capability test into something safe to show: labels, pass/fail and short details, nothing else. */
export function parseCapabilityTest(raw: unknown): ChannelSettingsView["lastTest"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.checks) && typeof o.ok !== "boolean") return null;
  const checks = (Array.isArray(o.checks) ? o.checks : []).slice(0, 20).flatMap((c) => {
    if (typeof c !== "object" || c === null) return [];
    const x = c as Record<string, unknown>;
    return [{ label: String(x.label ?? "Check").slice(0, 120), ok: x.ok === true, detail: String(x.detail ?? "").slice(0, 300) }];
  });
  return { ok: o.ok === true, at: typeof o.checkedAt === "string" ? o.checkedAt : null, checks };
}

export async function getCommunicationSettings(actor: CrmActor): Promise<ChannelSettingsView[]> {
  assertCan(actor, "inbox.view", "Your role doesn't include messaging.");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{
      channel: Channel; enabled: boolean; provider: string; sender_identity: string | null; sender_verified_at: Date | null; registration_status: string; detail: string | null;
      inbound_address: string | null; capability_test: unknown; capability_tested_at: Date | null; has_credential: boolean; has_sender_id: boolean; updated_at: Date | null;
    }>(
      `select channel, enabled, provider, sender_identity, sender_verified_at, registration_status, detail, inbound_address::text as inbound_address, capability_test,
              capability_tested_at, credential_id is not null as has_credential, provider_sender_id is not null as has_sender_id, updated_at
       from messaging_channels where org_id = $1`,
      [actor.orgId],
    );
    return CHANNELS.map((channel) => {
      const r = rows.find((x) => x.channel === channel);
      const provider: TransportName = r && isTransport(r.provider) ? r.provider : "ghl";
      const lastTest = r ? parseCapabilityTest(r.capability_test) : null;
      if (lastTest && !lastTest.at && r?.capability_tested_at) lastTest.at = iso(r.capability_tested_at);
      let whyOff: string | null = null;
      if (!r) whyOff = "Not set up yet. iAcquire connects this channel for you.";
      else if (!r.enabled) {
        if (provider === "ghl") {
          if (!r.sender_verified_at) whyOff = "iAcquire hasn't verified this sender in GoHighLevel yet.";
          else if (channel !== "email" && !["not_required", "approved"].includes(r.registration_status)) whyOff = `Sender registration is ${r.registration_status.replace("_", " ")}.`;
          else whyOff = "Verified, but switched off.";
        } else if (!r.has_credential || !r.has_sender_id) whyOff = `Not connected to ${TRANSPORT_LABELS[provider]} yet.`;
        // The stored result first: a failed test leaves no tested time, and that isn't "not run".
        else if (lastTest && !lastTest.ok) whyOff = "The last connection test didn't pass.";
        else if (!r.capability_tested_at) whyOff = "Connected, but the connection test hasn't been run yet.";
        else if (channel !== "email" && !["not_required", "approved"].includes(r.registration_status)) whyOff = `Sender registration is ${r.registration_status.replace("_", " ")}.`;
        else whyOff = "Ready, but switched off.";
      }
      return {
        channel, provider, providerLabel: TRANSPORT_LABELS[provider], configured: Boolean(r), enabled: Boolean(r?.enabled), senderIdentity: r?.sender_identity ?? null,
        inboundAddress: r?.inbound_address ?? null, senderVerified: Boolean(r?.sender_verified_at), registrationStatus: r?.registration_status ?? "not_started", lastTest,
        whyOff, writesEnabled: transportWritesEnabled(provider), detail: r?.detail ?? null, updatedAt: iso(r?.updated_at ?? null),
      };
    });
  });
}
