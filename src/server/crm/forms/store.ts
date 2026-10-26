import "server-only";
import type { Queryable } from "@/server/db";
import { surveysEnabledIn } from "@/server/reputation/entitlement";
import { formContextFrom, publicDefinition, type FormActions, type FormConsent, type FormContext, type FormKind, type FormPurpose, type FormQuestion, type FormSettings, type FormStatus, type PublicFormDef } from "@/lib/crm/forms/spec";
import type { FieldType } from "@/lib/crm/types";

// Row shapes and loaders shared by the forms services (definitions, submissions, processing, the hosted page and the website runtime's
// trusted reads). Every query names the organization; callers decide who may run them.

export interface FormRow {
  id: string;
  org_id: string;
  key: string;
  name: string;
  kind: FormKind;
  purpose: FormPurpose;
  folder_id: string | null;
  status: FormStatus;
  draft: unknown;
  draft_revision: number;
  published_version_id: string | null;
  hosted: boolean;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  updated_by: string | null;
}

export interface VersionRow {
  id: string;
  org_id: string;
  form_id: string;
  version: number;
  fields: FormQuestion[];
  actions: FormActions;
  consent: FormConsent;
  settings: FormSettings;
  content_hash: string;
  published_at: Date;
  published_by: string | null;
}

export const FORM_COLUMNS = "id, org_id, key, name, kind, purpose, folder_id, status, draft, draft_revision, published_version_id, hosted, created_at, updated_at, archived_at, updated_by";
export const VERSION_COLUMNS = "id, org_id, form_id, version, fields, actions, consent, settings, content_hash, published_at, published_by";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadFormRow(db: Queryable, orgId: string, id: string, opts: { lock?: boolean } = {}): Promise<FormRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<FormRow>(`select ${FORM_COLUMNS} from crm_forms where id = $1 and org_id = $2${opts.lock ? " for update" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

export async function loadVersionRow(db: Queryable, orgId: string, versionId: string): Promise<VersionRow | null> {
  if (!UUID.test(versionId)) return null;
  const { rows } = await db.query<VersionRow>(`select ${VERSION_COLUMNS} from crm_form_versions where id = $1 and org_id = $2`, [versionId, orgId]);
  return rows[0] ?? null;
}

/** A workspace's live form by key: published and not archived, with its published version. */
export async function loadPublishedByKey(db: Queryable, orgId: string, key: string): Promise<{ form: FormRow; version: VersionRow } | null> {
  const { rows } = await db.query<FormRow>(
    `select ${FORM_COLUMNS} from crm_forms where org_id = $1 and key = $2 and status = 'published' and archived_at is null and published_version_id is not null`,
    [orgId, key],
  );
  const form = rows[0];
  if (!form?.published_version_id) return null;
  const version = await loadVersionRow(db, orgId, form.published_version_id);
  return version ? { form, version } : null;
}

export function toPublicDef(form: Pick<FormRow, "key" | "name" | "kind">, version: VersionRow): PublicFormDef {
  return publicDefinition({ key: form.key, name: form.name, kind: form.kind }, { version: version.version, fields: version.fields, consent: version.consent, settings: version.settings, actions: version.actions });
}

/** Whether this workspace's contacts live in iAcquire (forms create and update native contacts). */
export async function contactsAreNative(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ mode: string; provider: string | null }>(
    "select w.mode, p.provider from crm_workspaces w left join crm_capability_providers p on p.org_id = w.org_id and p.capability = 'contacts' where w.org_id = $1",
    [orgId],
  );
  const w = rows[0];
  if (!w) return true; // a workspace row is created native on first use
  return (w.mode === "hybrid" ? (w.provider ?? "native") : w.mode) === "native";
}

export interface FormOptionLists {
  tags: Array<{ id: string; name: string; color: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; kind: "open" | "won" | "lost" }> }>;
  contactFields: Array<{ id: string; key: string; label: string; type: FieldType; options: Array<{ value: string; label: string }> }>;
  assignmentRules: Array<{ id: string; name: string; entity: "contact" | "opportunity"; active: boolean }>;
}

const optionList = (raw: unknown): Array<{ value: string; label: string }> =>
  Array.isArray(raw)
    ? raw.map((o) => (typeof o === "string" ? { value: o, label: o } : { value: String((o as { value?: unknown }).value ?? ""), label: String((o as { label?: unknown }).label ?? (o as { value?: unknown }).value ?? "") }))
    : [];

/** What a form can refer to in this workspace: tags, native pipelines with stages, contact custom fields, assignment rules. */
export async function loadFormOptionLists(db: Queryable, orgId: string): Promise<FormOptionLists> {
  const q = <T>(sql: string) => db.query<T>(sql, [orgId]).then((r) => r.rows);
  const tags = await q<{ id: string; name: string; color: string }>("select id, name::text as name, color from crm_tags where org_id = $1 order by lower(name::text)");
  const pipes = await q<{ id: string; name: string }>("select id, name from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null order by is_default desc, lower(name)");
  const stages = await q<{ id: string; name: string; kind: "open" | "won" | "lost"; pipeline_id: string }>(
    "select id, name, kind, pipeline_id from crm_pipeline_stages where org_id = $1 and archived_at is null order by position",
  );
  const fields = await q<{ id: string; key: string; label: string; type: FieldType; options: unknown }>(
    "select id, key, label, type, options from crm_custom_fields where org_id = $1 and entity = 'contact' and archived_at is null order by position, lower(label)",
  );
  const rules = await q<{ id: string; name: string; entity: "contact" | "opportunity"; active: boolean }>("select id, name, entity, active from crm_assignment_rules where org_id = $1 order by entity, position, lower(name)");
  return {
    tags,
    pipelines: pipes.map((p) => ({ id: p.id, name: p.name, stages: stages.filter((s) => s.pipeline_id === p.id).map((s) => ({ id: s.id, name: s.name, kind: s.kind })) })),
    contactFields: fields.map((f) => ({ id: f.id, key: f.key, label: f.label, type: f.type, options: optionList(f.options) })),
    assignmentRules: rules,
  };
}

export async function loadFormContext(db: Queryable, orgId: string): Promise<FormContext> {
  // Whether the workspace has satisfaction surveys decides whether a question may be saved as private feedback (src/server/reputation/entitlement.ts).
  return { ...formContextFrom(await loadFormOptionLists(db, orgId)), feedbackEnabled: await surveysEnabledIn(db, orgId) };
}
