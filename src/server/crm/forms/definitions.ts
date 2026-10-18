import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import {
  draftHash, emptyDraft, FORM_KEY_RE, FORM_KINDS, FORM_PURPOSES, hasErrors, normalizeDraft, readDraft, validateDraft, type FormDraft, type FormIssue, type FormKind, type FormPurpose,
  type FormStatus,
} from "@/lib/crm/forms/spec";
import {
  contactsAreNative, FORM_COLUMNS, loadFormContext, loadFormOptionLists, loadFormRow, loadVersionRow, toPublicDef, UUID, VERSION_COLUMNS, type FormOptionLists, type FormRow,
  type VersionRow,
} from "@/server/crm/forms/store";
import type { PublicFormDef } from "@/lib/crm/forms/spec";
import type { SiteFormChoice, SiteFormOptions } from "@/lib/crm/forms/website";

// Form definitions: the list, the builder's draft (saved with a revision so two people never overwrite each other silently), publishing
// (a validated draft frozen into an immutable version with a content hash), taking a form offline, archiving, duplicating, and restoring
// an older version into the draft. Reading needs "crm.view" (the row-level security rule); every change needs "Build forms".

export interface FormSummary {
  id: string;
  key: string;
  name: string;
  kind: FormKind;
  purpose: FormPurpose;
  status: FormStatus;
  hosted: boolean;
  folderId: string | null;
  folderName: string | null;
  publishedVersion: number | null;
  /** The saved draft differs from the published version. */
  unpublishedChanges: boolean;
  questionCount: number;
  submissions: { total: number; last7Days: number; lastAt: string | null; waiting: number; failed: number; spam: number };
  createdAt: string;
  updatedAt: string;
}

export interface FormDetail extends FormSummary {
  draft: FormDraft;
  draftRevision: number;
  draftHash: string;
  publishedVersionId: string | null;
  publishedHash: string | null;
  updatedByName: string | null;
  /** The hosted page's path (/f/<workspace>/<key>), whether or not it is switched on. */
  hostedPath: string;
  /** The form has ever been published, so its address is in use and can't change. */
  everPublished: boolean;
  /** Where the published version is used on the workspace's live website (page titles). */
  websitePages: string[];
}

export interface FormVersionView {
  id: string;
  version: number;
  publishedAt: string;
  publishedByName: string | null;
  contentHash: string;
  questionCount: number;
  current: boolean;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new AppError("invalid_input", "Give the form a name.");
  if (name.length > 80) throw new AppError("invalid_input", "Keep the name to 80 characters.");
  return name;
}

function cleanKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (!FORM_KEY_RE.test(key)) throw new AppError("invalid_input", "The form's address can use lower-case letters, numbers and hyphens (up to 48), like free-quote.");
  return key;
}

/** A key unique among the workspace's forms that aren't archived, from the name. */
async function uniqueKey(db: Queryable, orgId: string, name: string, exceptId: string | null = null): Promise<string> {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "form";
  const { rows } = await db.query<{ key: string }>("select key from crm_forms where org_id = $1 and archived_at is null and key like $2 and ($3::uuid is null or id <> $3)", [orgId, `${base}%`, exceptId]);
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

async function assertKeyFree(db: Queryable, orgId: string, key: string, exceptId: string | null) {
  const { rows } = await db.query("select 1 from crm_forms where org_id = $1 and key = $2 and archived_at is null and ($3::uuid is null or id <> $3)", [orgId, key, exceptId]);
  if (rows[0]) throw new AppError("conflict", `Another form already uses the address “${key}”. Choose another.`);
}

async function assertFolder(db: Queryable, orgId: string, folderId: string | null | undefined) {
  if (!folderId) return;
  if (!UUID.test(folderId)) throw new AppError("not_found", "Folder not found.");
  const f = await db.query("select 1 from crm_folders where id = $1 and org_id = $2 and kind = 'form'", [folderId, orgId]);
  if (!f.rows[0]) throw new AppError("not_found", "Folder not found.");
}

async function lockedForm(db: Queryable, actor: CrmActor, id: string): Promise<FormRow> {
  const form = await loadFormRow(db, actor.orgId, id, { lock: true });
  if (!form) throw new AppError("not_found", "Form not found.");
  return form;
}

const audit = (db: Queryable, actor: CrmActor, action: string, formId: string, metadata?: Record<string, unknown>) =>
  recordAudit({ orgId: actor.orgId, ...auditActor(actor), action, targetType: "crm_form", targetId: formId, result: "success", metadata }, db);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface SummaryRow extends FormRow {
  folder_name: string | null;
  version: number | null;
  content_hash: string | null;
  total: string;
  last7: string;
  last_at: Date | null;
  waiting: string;
  failed: string;
  spam: string;
}

const SUMMARY_SQL = `
  select f.id, f.org_id, f.key, f.name, f.kind, f.purpose, f.folder_id, f.status, f.draft, f.draft_revision, f.published_version_id, f.hosted, f.created_at, f.updated_at,
         f.archived_at, f.updated_by, fo.name as folder_name, v.version, v.content_hash,
         (select count(*) from crm_form_submissions s where s.form_id = f.id and s.org_id = f.org_id)::text as total,
         (select count(*) from crm_form_submissions s where s.form_id = f.id and s.org_id = f.org_id and s.created_at > now() - interval '7 days' and s.status <> 'spam')::text as last7,
         (select max(s.created_at) from crm_form_submissions s where s.form_id = f.id and s.org_id = f.org_id and s.status <> 'spam') as last_at,
         (select count(*) from crm_form_submissions s where s.form_id = f.id and s.org_id = f.org_id and s.status = 'received')::text as waiting,
         (select count(*) from crm_form_submissions s where s.form_id = f.id and s.org_id = f.org_id and s.status = 'failed')::text as failed,
         (select count(*) from crm_form_submissions s where s.form_id = f.id and s.org_id = f.org_id and s.status = 'spam')::text as spam
  from crm_forms f
  left join crm_folders fo on fo.id = f.folder_id and fo.org_id = f.org_id
  left join crm_form_versions v on v.id = f.published_version_id and v.org_id = f.org_id`;

function toSummary(r: SummaryRow): FormSummary {
  const draft = readDraft(r.draft, r.kind);
  return {
    id: r.id, key: r.key, name: r.name, kind: r.kind, purpose: r.purpose, status: r.status, hosted: r.hosted, folderId: r.folder_id, folderName: r.folder_name,
    publishedVersion: r.version, unpublishedChanges: Boolean(r.content_hash) && r.content_hash !== draftHash(normalizeDraft(draft)), questionCount: draft.questions.length,
    submissions: { total: Number(r.total), last7Days: Number(r.last7), lastAt: iso(r.last_at), waiting: Number(r.waiting), failed: Number(r.failed), spam: Number(r.spam) },
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

export async function listForms(actor: CrmActor, q: { status?: FormStatus | "all" } = {}): Promise<FormSummary[]> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const status = q.status && q.status !== "all" ? q.status : null;
    const { rows } = await db.query<SummaryRow>(`${SUMMARY_SQL} where f.org_id = $1 and ($2::text is null or f.status = $2) order by f.archived_at nulls first, lower(f.name), f.created_at`, [actor.orgId, status]);
    return rows.map(toSummary);
  });
}

async function orgSlug(db: Queryable, orgId: string): Promise<string> {
  const { rows } = await db.query<{ slug: string }>("select slug from organizations where id = $1", [orgId]);
  return rows[0]?.slug ?? "";
}

/**
 * Where the live website uses this form: page titles (plus "Shared sections", "Header", "Footer"). Read from the published content, which
 * the application role can't select, so this runs as trusted code after the caller has been authorized for the workspace; it returns only
 * page titles of the workspace's own site.
 */
async function livePagesUsing(orgId: string, key: string): Promise<string[]> {
  const { rows } = await withSystem((db) =>
    db.query<{ content: unknown }>(
      `select p.content from websites w join website_publications p on p.id = w.published_publication_id and p.org_id = w.org_id where w.org_id = $1 and p.status = 'live'`,
      [orgId],
    ),
  );
  const pages = new Set<string>();
  const uses = (v: unknown) => JSON.stringify(v ?? null).includes(`"formKey":"${key}"`);
  for (const r of rows) {
    const c = r.content as { pages?: Array<{ title?: string; items?: unknown[] }>; globals?: Record<string, unknown>; header?: unknown; footer?: unknown } | null;
    for (const page of c?.pages ?? []) if (uses(page.items)) pages.add(page.title || "Page");
    if (uses(c?.globals)) pages.add("Shared sections");
    if (uses(c?.header)) pages.add("Header");
    if (uses(c?.footer)) pages.add("Footer");
  }
  return [...pages];
}

export async function getForm(actor: CrmActor, id: string): Promise<FormDetail> {
  assertCan(actor, "crm.view");
  if (!UUID.test(id)) throw new AppError("not_found", "Form not found.");
  const detail = await crmRead(actor, async (db) => {
    const { rows } = await db.query<SummaryRow & { updated_by_name: string | null }>(
      `select x.*, (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = x.updated_by) as updated_by_name from (${SUMMARY_SQL} where f.id = $1 and f.org_id = $2) x`,
      [id, actor.orgId],
    );
    const r = rows[0];
    if (!r) throw new AppError("not_found", "Form not found.");
    const draft = readDraft(r.draft, r.kind);
    const ever = await db.query("select 1 from crm_form_versions where form_id = $1 and org_id = $2 limit 1", [id, actor.orgId]);
    const out: FormDetail = {
      ...toSummary(r),
      draft,
      draftRevision: r.draft_revision,
      draftHash: draftHash(normalizeDraft(draft)),
      publishedVersionId: r.published_version_id,
      publishedHash: r.content_hash,
      updatedByName: r.updated_by_name,
      hostedPath: `/f/${await orgSlug(db, actor.orgId)}/${r.key}`,
      everPublished: ever.rows.length > 0,
      websitePages: [],
    };
    return out;
  });
  if (detail.status === "published") detail.websitePages = await livePagesUsing(actor.orgId, detail.key);
  return detail;
}

export async function listFormVersions(actor: CrmActor, id: string): Promise<FormVersionView[]> {
  assertCan(actor, "crm.view");
  if (!UUID.test(id)) throw new AppError("not_found", "Form not found.");
  return crmRead(actor, async (db) => {
    const form = await db.query<{ published_version_id: string | null }>("select published_version_id from crm_forms where id = $1 and org_id = $2", [id, actor.orgId]);
    if (!form.rows[0]) throw new AppError("not_found", "Form not found.");
    const { rows } = await db.query<{ id: string; version: number; published_at: Date; content_hash: string; n: number; by_name: string | null }>(
      `select v.id, v.version, v.published_at, v.content_hash, jsonb_array_length(v.fields) as n,
              (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = v.published_by) as by_name
       from crm_form_versions v where v.form_id = $1 and v.org_id = $2 order by v.version desc limit 100`,
      [id, actor.orgId],
    );
    return rows.map((v) => ({ id: v.id, version: v.version, publishedAt: iso(v.published_at)!, publishedByName: v.by_name, contentHash: v.content_hash, questionCount: Number(v.n), current: v.id === form.rows[0].published_version_id }));
  });
}

/** One frozen version as visitors saw it (for the version history's preview). */
export async function getFormVersionPreview(actor: CrmActor, formId: string, versionId: string): Promise<PublicFormDef> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const form = await loadFormRow(db, actor.orgId, formId);
    const version = await loadVersionRow(db, actor.orgId, versionId);
    if (!form || !version || version.form_id !== form.id) throw new AppError("not_found", "Version not found.");
    return toPublicDef(form, version);
  });
}

export interface FormBuilderOptions extends FormOptionLists {
  /**
   * Every active assignment rule as a bare reference (no name), for everyone who can open the builder: the live checks then judge a rule
   * someone else chose the way publishing does, even when this person's role can't list rules.
   */
  assignmentRuleRefs: Array<{ id: string; entity: "contact" | "opportunity" }>;
  folders: Array<{ id: string; name: string }>;
  /** Why forms can't create contacts here, or null. */
  contactsProblem: string | null;
  orgSlug: string;
}

export async function getFormBuilderOptions(actor: CrmActor): Promise<FormBuilderOptions> {
  assertCan(actor, "crm.view");
  // Bare rule references are read on their own (trusted, ids and kinds only): transactions can't nest.
  const refs = await withSystem((db) => db.query<{ id: string; entity: "contact" | "opportunity" }>("select id, entity from crm_assignment_rules where org_id = $1 and active", [actor.orgId]));
  const out = await crmRead(actor, async (db) => {
    const lists = await loadFormOptionLists(db, actor.orgId);
    const folders = await db.query<{ id: string; name: string }>("select id, name from crm_folders where org_id = $1 and kind = 'form' order by position, lower(name)", [actor.orgId]);
    const native = await contactsAreNative(db, actor.orgId);
    return {
      ...lists,
      assignmentRuleRefs: [] as FormBuilderOptions["assignmentRuleRefs"],
      // Assignment rules are shown only to people who may assign.
      assignmentRules: actor.can("contacts.assign") || actor.can("forms.manage") ? lists.assignmentRules : [],
      folders: folders.rows,
      contactsProblem: native ? null : "Contacts are managed in GoHighLevel for this workspace, so native forms can't add or update contacts. Move contacts to iAcquire CRM in Settings → CRM provider to publish forms.",
      orgSlug: await orgSlug(db, actor.orgId),
    };
  });
  return { ...out, assignmentRuleRefs: refs.rows };
}

/** Live validation of a draft the builder holds (saved or not) against the workspace. */
export async function validateFormDraft(actor: CrmActor, draft: unknown, kind: FormKind): Promise<FormIssue[]> {
  assertCan(actor, "crm.view");
  // Checked against everything the workspace has (as publishing checks it), not only what this person's role can list: an assignment
  // rule they can't see is still a valid choice someone else made. Only ids and kinds are read; nothing is returned but the issues.
  return withSystem(async (db) => validateDraft(draft, await loadFormContext(db, actor.orgId), { kind }));
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

export interface CreateFormInput {
  name: string;
  kind?: FormKind;
  purpose?: FormPurpose;
  key?: string | null;
  folderId?: string | null;
}

export async function createForm(actor: CrmActor, input: CreateFormInput): Promise<{ id: string; key: string }> {
  assertCan(actor, "forms.manage", "Building forms needs the “Build forms” permission.");
  const name = cleanName(input.name);
  const kind: FormKind = input.kind && FORM_KINDS.includes(input.kind) ? input.kind : "form";
  const purpose: FormPurpose = input.purpose && FORM_PURPOSES.includes(input.purpose) ? input.purpose : kind === "survey" ? "survey" : "contact";
  return crmWrite(actor, async (db) => {
    await assertFolder(db, actor.orgId, input.folderId);
    let key: string;
    if (input.key?.trim()) {
      key = cleanKey(input.key);
      await assertKeyFree(db, actor.orgId, key, null);
    } else key = await uniqueKey(db, actor.orgId, name);
    const draft = emptyDraft(kind);
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_forms (org_id, key, name, kind, purpose, folder_id, draft, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id",
      [actor.orgId, key, name, kind, purpose, input.folderId ?? null, JSON.stringify(draft), actor.userId],
    );
    await audit(db, actor, "crm.form_created", rows[0].id, { key, kind });
    return { id: rows[0].id, key };
  });
}

/**
 * Saves the builder's working copy. `expectedRevision` is the revision the builder loaded; when someone else saved in between, the save is
 * refused so neither person's changes are lost. A draft may be incomplete; the issues come back so the builder can show them.
 */
export async function saveFormDraft(actor: CrmActor, id: string, input: { draft: unknown; expectedRevision: number }): Promise<{ revision: number; issues: FormIssue[]; draftHash: string }> {
  assertCan(actor, "forms.manage", "Building forms needs the “Build forms” permission.");
  return crmWrite(actor, async (db) => {
    const form = await lockedForm(db, actor, id);
    if (form.status === "archived") throw new AppError("conflict", "This form is archived. Restore it to edit it.");
    if (form.draft_revision !== input.expectedRevision) throw new AppError("conflict", "Someone else saved this form while you were editing. Reload to see their changes, then make yours again.");
    const draft = readDraft(input.draft, form.kind);
    const json = JSON.stringify(draft);
    if (json.length > 120_000) throw new AppError("invalid_input", "This form is too large to save. Remove some questions or choices.");
    const { rows } = await db.query<{ draft_revision: number }>(
      "update crm_forms set draft = $3, draft_revision = draft_revision + 1, updated_by = $4 where id = $1 and org_id = $2 returning draft_revision",
      [id, actor.orgId, json, actor.userId],
    );
    return { revision: rows[0].draft_revision, issues: validateDraft(draft, await loadFormContext(db, actor.orgId), { kind: form.kind }), draftHash: draftHash(normalizeDraft(draft)) };
  });
}

export interface FormSettingsInput {
  name?: string;
  key?: string;
  kind?: FormKind;
  purpose?: FormPurpose;
  folderId?: string | null;
  hosted?: boolean;
}

/** Name, address, purpose, folder and the hosted page switch. A form that has been published keeps its address. */
export async function updateFormSettings(actor: CrmActor, id: string, input: FormSettingsInput): Promise<void> {
  assertCan(actor, "forms.manage", "Building forms needs the “Build forms” permission.");
  await crmWrite(actor, async (db) => {
    const form = await lockedForm(db, actor, id);
    if (form.status === "archived") throw new AppError("conflict", "This form is archived. Restore it to change it.");
    const sets: string[] = [];
    const params: unknown[] = [id, actor.orgId];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    const changed: Record<string, unknown> = {};
    if (input.name !== undefined) {
      set("name", cleanName(input.name));
      changed.name = true;
    }
    if (input.key !== undefined && input.key.trim().toLowerCase() !== form.key) {
      const key = cleanKey(input.key);
      const ever = await db.query("select 1 from crm_form_versions where form_id = $1 and org_id = $2 limit 1", [id, actor.orgId]);
      if (ever.rows[0]) throw new AppError("conflict", "This form has been published, so its address is in use on links and your website and can't change. Duplicate the form to use a new address.");
      await assertKeyFree(db, actor.orgId, key, id);
      set("key", key);
      changed.key = key;
    }
    if (input.kind !== undefined) {
      if (!FORM_KINDS.includes(input.kind)) throw new AppError("invalid_input", "Choose form or survey.");
      set("kind", input.kind);
      changed.kind = input.kind;
    }
    if (input.purpose !== undefined) {
      if (!FORM_PURPOSES.includes(input.purpose)) throw new AppError("invalid_input", "Choose what the form is for.");
      set("purpose", input.purpose);
      changed.purpose = input.purpose;
    }
    if (input.folderId !== undefined) {
      await assertFolder(db, actor.orgId, input.folderId);
      set("folder_id", input.folderId);
      changed.folder = true;
    }
    if (input.hosted !== undefined) {
      set("hosted", input.hosted === true);
      changed.hosted = input.hosted === true;
    }
    if (!sets.length) return;
    set("updated_by", actor.userId);
    await db.query(`update crm_forms set ${sets.join(", ")} where id = $1 and org_id = $2`, params);
    await audit(db, actor, "crm.form_settings_changed", id, changed);
  });
}

export interface PublishResult {
  /** The published version number (a new one, or the existing one when nothing changed). */
  version: number;
  created: boolean;
  issues: FormIssue[];
}

/**
 * Publishes the saved draft: validated against the workspace (any error refuses), normalized, and frozen as the next version with its
 * content hash. When the draft is identical to the published version, nothing new is created. Visitors get the new version straight away;
 * submissions already received keep the version they answered.
 */
export async function publishForm(actor: CrmActor, id: string, input: { expectedRevision?: number } = {}): Promise<PublishResult> {
  assertCan(actor, "forms.manage", "Publishing forms needs the “Build forms” permission.");
  return crmWrite(actor, async (db) => {
    const form = await lockedForm(db, actor, id);
    if (form.status === "archived") throw new AppError("conflict", "This form is archived. Restore it to publish it.");
    if (input.expectedRevision !== undefined && form.draft_revision !== input.expectedRevision) {
      throw new AppError("conflict", "Someone else saved this form while you were editing. Reload to see their changes before publishing.");
    }
    if (!(await contactsAreNative(db, actor.orgId))) await assertNativeOwner(db, actor.orgId, "contacts");
    const draft = readDraft(form.draft, form.kind);
    const issues = validateDraft(draft, await loadFormContext(db, actor.orgId), { kind: form.kind });
    if (hasErrors(issues)) {
      const err = new AppError("invalid_input", `This form can't be published yet: ${issues.find((i) => i.level === "error")!.message}`);
      (err as AppError & { issues?: FormIssue[] }).issues = issues;
      throw err;
    }
    const clean = normalizeDraft(draft);
    const hash = draftHash(clean);
    if (form.published_version_id) {
      const cur = await loadVersionRow(db, actor.orgId, form.published_version_id);
      if (cur && cur.content_hash === hash) {
        if (form.status !== "published") {
          await db.query("update crm_forms set status = 'published', updated_by = $3 where id = $1 and org_id = $2", [id, actor.orgId, actor.userId]);
          await audit(db, actor, "crm.form_published", id, { version: cur.version, republished: true });
        }
        return { version: cur.version, created: false, issues };
      }
    }
    const next = await db.query<{ n: number }>("select coalesce(max(version), 0) + 1 as n from crm_form_versions where form_id = $1 and org_id = $2", [id, actor.orgId]);
    const version = Number(next.rows[0].n);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_form_versions (org_id, form_id, version, fields, actions, consent, settings, content_hash, published_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [actor.orgId, id, version, JSON.stringify(clean.questions), JSON.stringify(clean.actions), JSON.stringify(clean.consent), JSON.stringify(clean.settings), hash, actor.userId],
    );
    await db.query("update crm_forms set status = 'published', published_version_id = $3, updated_by = $4 where id = $1 and org_id = $2", [id, actor.orgId, rows[0].id, actor.userId]);
    await audit(db, actor, "crm.form_published", id, { version, contentHash: hash });
    return { version, created: true, issues };
  });
}

/** Takes the form offline: the hosted page and website stop accepting it. Its versions and submissions stay. */
export async function unpublishForm(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "forms.manage", "Changing forms needs the “Build forms” permission.");
  await crmWrite(actor, async (db) => {
    const form = await lockedForm(db, actor, id);
    if (form.status !== "published") throw new AppError("conflict", "This form isn't live.");
    await db.query("update crm_forms set status = 'draft', updated_by = $3 where id = $1 and org_id = $2", [id, actor.orgId, actor.userId]);
    await audit(db, actor, "crm.form_unpublished", id);
  });
}

export async function setFormArchived(actor: CrmActor, id: string, archived: boolean): Promise<void> {
  assertCan(actor, "forms.manage", "Changing forms needs the “Build forms” permission.");
  await crmWrite(actor, async (db) => {
    const form = await lockedForm(db, actor, id);
    if (archived) {
      if (form.status === "archived") return;
      await db.query("update crm_forms set status = 'archived', archived_at = now(), updated_by = $3 where id = $1 and org_id = $2", [id, actor.orgId, actor.userId]);
      await audit(db, actor, "crm.form_archived", id);
      return;
    }
    if (form.status !== "archived") return;
    await assertKeyFree(db, actor.orgId, form.key, id);
    // A restored form comes back offline: someone decides to publish it again.
    await db.query("update crm_forms set status = 'draft', archived_at = null, updated_by = $3 where id = $1 and org_id = $2", [id, actor.orgId, actor.userId]);
    await audit(db, actor, "crm.form_restored", id);
  });
}

/** A new draft form with the same questions, consent and actions (from the saved draft), under a new name and address. */
export async function duplicateForm(actor: CrmActor, id: string, input: { name?: string } = {}): Promise<{ id: string; key: string }> {
  assertCan(actor, "forms.manage", "Building forms needs the “Build forms” permission.");
  return crmWrite(actor, async (db) => {
    const form = await loadFormRow(db, actor.orgId, id);
    if (!form) throw new AppError("not_found", "Form not found.");
    const name = cleanName(input.name ?? `${form.name} (copy)`.slice(0, 80));
    const key = await uniqueKey(db, actor.orgId, name);
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_forms (org_id, key, name, kind, purpose, folder_id, draft, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id",
      [actor.orgId, key, name, form.kind, form.purpose, form.folder_id, JSON.stringify(readDraft(form.draft, form.kind)), actor.userId],
    );
    await audit(db, actor, "crm.form_created", rows[0].id, { key, copiedFrom: id });
    return { id: rows[0].id, key };
  });
}

/** Puts an older version's content back into the draft (publishing it again creates a new version). */
export async function restoreFormVersion(actor: CrmActor, id: string, versionId: string, expectedRevision: number): Promise<{ revision: number }> {
  assertCan(actor, "forms.manage", "Building forms needs the “Build forms” permission.");
  return crmWrite(actor, async (db) => {
    const form = await lockedForm(db, actor, id);
    if (form.status === "archived") throw new AppError("conflict", "This form is archived. Restore it to edit it.");
    if (form.draft_revision !== expectedRevision) throw new AppError("conflict", "Someone else saved this form while you were looking. Reload and try again.");
    const v: VersionRow | null = await loadVersionRow(db, actor.orgId, versionId);
    if (!v || v.form_id !== id) throw new AppError("not_found", "Version not found.");
    const draft: FormDraft = readDraft({ questions: v.fields, consent: v.consent, actions: v.actions, settings: v.settings }, form.kind);
    const { rows } = await db.query<{ draft_revision: number }>(
      "update crm_forms set draft = $3, draft_revision = draft_revision + 1, updated_by = $4 where id = $1 and org_id = $2 returning draft_revision",
      [id, actor.orgId, JSON.stringify(draft), actor.userId],
    );
    await audit(db, actor, "crm.form_version_restored", id, { version: v.version });
    return { revision: rows[0].draft_revision };
  });
}

/** The forms a workflow trigger can filter on (every form that isn't archived). */
export async function listFormChoices(actor: CrmActor): Promise<Array<{ id: string; name: string; status: FormStatus }>> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; status: FormStatus }>("select id, name, status from crm_forms where org_id = $1 and archived_at is null order by lower(name)", [actor.orgId]);
    return rows;
  });
}

export { FORM_COLUMNS, VERSION_COLUMNS };

/**
 * The Website Studio's form picker for one workspace: its forms that aren't archived, with what visitors see for those that are live.
 * The caller has already authorized the person for this workspace's website (website.edit); nothing here goes beyond what the forms'
 * own visitors are shown, plus the names and status of drafts.
 */
export async function websiteFormOptionsFor(orgId: string, opts: { agency?: boolean } = {}): Promise<SiteFormOptions> {
  const manageHref = opts.agency ? `/admin/clients/${orgId}/crm/forms` : "/crm/forms";
  return withSystem(async (db) => {
    await db.query("set transaction read only");
    if (!(await contactsAreNative(db, orgId))) {
      return { available: false, reason: "Contacts are managed in GoHighLevel for this workspace, so the website uses its built-in enquiry form.", forms: [], manageHref };
    }
    const { rows } = await db.query<FormRow>(`select ${FORM_COLUMNS} from crm_forms where org_id = $1 and archived_at is null order by lower(name) limit 200`, [orgId]);
    const forms: SiteFormChoice[] = [];
    for (const f of rows) {
      let def: PublicFormDef | null = null;
      if (f.status === "published" && f.published_version_id) {
        const v = await loadVersionRow(db, orgId, f.published_version_id);
        if (v) def = toPublicDef(f, v);
      }
      forms.push({ key: f.key, name: f.name, status: f.status, def });
    }
    return { available: true, forms, manageHref };
  });
}
