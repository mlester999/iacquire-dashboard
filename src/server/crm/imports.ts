import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { assertCan, auditActor, crmRead, crmWrite, systemActor, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { createContactInTx, DuplicateContactError, findByIdentities, normalizeContactInput, type ContactInput } from "@/server/crm/contacts";
import { createCompanyInTx, normalizeDomain } from "@/server/crm/companies";
import { loadFieldDefinitions, writeFieldValues } from "@/server/crm/fields";
import { applyContactTags, ensureTagsByName } from "@/server/crm/tags";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { coerceFieldValue } from "@/lib/crm/fields";
import { CsvError, parseCsv } from "@/lib/crm/csv";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, PREFERRED_CHANNELS, type LeadStatus, type PreferredChannel } from "@/lib/crm/types";

// ---------------------------------------------------------------------------
// What a column can be mapped to
// ---------------------------------------------------------------------------

export type ImportEntity = "contact" | "company";

export const CONTACT_IMPORT_TARGETS: Record<string, { label: string; aliases: string[] }> = {
  name: { label: "Full name", aliases: ["name", "full name", "contact name", "fullname"] },
  first_name: { label: "First name", aliases: ["first name", "firstname", "given name", "first"] },
  last_name: { label: "Last name", aliases: ["last name", "lastname", "surname", "family name", "last"] },
  email: { label: "Email", aliases: ["email", "e-mail", "email address", "primary email"] },
  email_2: { label: "Other email", aliases: ["email 2", "secondary email", "other email", "additional emails"] },
  phone: { label: "Phone", aliases: ["phone", "phone number", "mobile", "mobile phone", "cell", "telephone", "primary phone"] },
  phone_2: { label: "Other phone", aliases: ["phone 2", "secondary phone", "other phone", "work phone", "additional phones"] },
  company: { label: "Company", aliases: ["company", "company name", "business name", "organization", "organisation", "account"] },
  job_title: { label: "Job title", aliases: ["title", "job title", "position", "role"] },
  address_line1: { label: "Address", aliases: ["address", "address 1", "address line 1", "street", "street address", "address1"] },
  address_line2: { label: "Address line 2", aliases: ["address 2", "address line 2", "address2", "suite", "unit"] },
  city: { label: "City", aliases: ["city", "town", "municipality"] },
  region: { label: "State / province", aliases: ["state", "province", "region", "county"] },
  postal_code: { label: "Postal code", aliases: ["zip", "zip code", "postal code", "postcode", "postalcode"] },
  country: { label: "Country", aliases: ["country", "country code"] },
  timezone: { label: "Time zone", aliases: ["timezone", "time zone", "tz"] },
  language: { label: "Language", aliases: ["language", "preferred language", "locale"] },
  preferred_channel: { label: "Preferred channel", aliases: ["preferred channel", "contact preference", "preferred contact method"] },
  source: { label: "Lead source", aliases: ["source", "lead source", "contact source", "utm source"] },
  lead_status: { label: "Lead status", aliases: ["status", "lead status", "stage"] },
  lead_score: { label: "Lead score", aliases: ["score", "lead score"] },
  owner_email: { label: "Owner (teammate email)", aliases: ["owner", "assigned to", "owner email", "assigned user", "contact owner"] },
  tags: { label: "Tags", aliases: ["tags", "tag", "labels", "segments"] },
  external_id: { label: "ID from the old system", aliases: ["id", "contact id", "external id", "record id", "ghl id"] },
  note: { label: "Note", aliases: ["note", "notes", "comments", "description"] },
};

export const COMPANY_IMPORT_TARGETS: Record<string, { label: string; aliases: string[] }> = {
  name: { label: "Company name", aliases: ["name", "company", "company name", "business name", "account name"] },
  domain: { label: "Domain", aliases: ["domain", "company domain"] },
  website: { label: "Website", aliases: ["website", "url", "web", "site"] },
  industry: { label: "Industry", aliases: ["industry", "sector", "category"] },
  phone: { label: "Phone", aliases: ["phone", "phone number", "telephone"] },
  email: { label: "Email", aliases: ["email", "company email"] },
  address_line1: { label: "Address", aliases: ["address", "street", "address 1"] },
  city: { label: "City", aliases: ["city", "town"] },
  region: { label: "State / province", aliases: ["state", "province", "region"] },
  postal_code: { label: "Postal code", aliases: ["zip", "postal code", "postcode"] },
  country: { label: "Country", aliases: ["country"] },
  owner_email: { label: "Owner (teammate email)", aliases: ["owner", "assigned to", "owner email"] },
  tags: { label: "Tags", aliases: ["tags", "tag"] },
  external_id: { label: "ID from the old system", aliases: ["id", "company id", "external id"] },
};

const targetsFor = (entity: ImportEntity) => (entity === "company" ? COMPANY_IMPORT_TARGETS : CONTACT_IMPORT_TARGETS);
const norm = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

/** Suggests a target for each header, by name. A person always confirms the mapping before anything is imported. */
export function suggestMapping(entity: ImportEntity, headers: string[], customFields: Array<{ key: string; label: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  const targets = targetsFor(entity);
  for (const h of headers) {
    const n = norm(h);
    let hit: string | null = null;
    for (const [key, t] of Object.entries(targets)) if (!used.has(key) && !hit && (t.aliases.some((a) => norm(a) === n) || norm(t.label) === n || key.replace(/_/g, " ") === n)) hit = key;
    if (!hit) for (const f of customFields) if (!used.has(`cf:${f.key}`) && (norm(f.label) === n || norm(f.key) === n)) hit = `cf:${f.key}`;
    out[h] = hit ?? "ignore";
    if (hit) used.add(hit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Country names → ISO codes (from the runtime's own region names, so nothing is hand-maintained or guessed)
// ---------------------------------------------------------------------------

let countryIndex: Map<string, string> | null = null;
export function countryCode(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  if (!countryIndex) {
    countryIndex = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        try {
          const name = names.of(code);
          if (name && name !== code) countryIndex.set(norm(name), code);
        } catch {
          // Not a region code.
        }
      }
    for (const [alias, code] of [["usa", "US"], ["united states of america", "US"], ["uk", "GB"], ["great britain", "GB"], ["england", "GB"]]) countryIndex.set(alias, code);
  }
  return countryIndex.get(norm(s)) ?? null;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;

export interface ImportJobView {
  id: string;
  entity: ImportEntity;
  fileName: string | null;
  status: string;
  headers: string[];
  mapping: Record<string, string>;
  options: ImportOptions;
  totalRows: number;
  summary: ImportSummary;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
}

export interface ImportOptions {
  /** A row whose email or phone already belongs to a record: leave the record alone, fill in its empty details, or hold the row for a person. */
  duplicates?: "skip" | "update" | "review";
  /** Tags added to every imported record. */
  tagAll?: string[];
}

export interface ImportSummary {
  validated?: number;
  valid?: number;
  invalid?: number;
  duplicateInFile?: number;
  create?: number;
  update?: number;
  skip?: number;
  review?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  needsReview?: number;
  failed?: number;
  rolledBack?: number;
  keptChanged?: number;
}

type JobRow = { id: string; org_id: string; entity: ImportEntity; file_name: string | null; status: string; headers: string[]; mapping: Record<string, string>; options: ImportOptions; total_rows: number; summary: ImportSummary; error: string | null; created_at: Date; completed_at: Date | null; created_by: string | null };

const toView = (j: JobRow): ImportJobView => ({
  id: j.id, entity: j.entity, fileName: j.file_name, status: j.status, headers: j.headers, mapping: j.mapping, options: j.options, totalRows: j.total_rows, summary: j.summary ?? {},
  error: j.error, createdAt: new Date(j.created_at).toISOString(), completedAt: j.completed_at ? new Date(j.completed_at).toISOString() : null, createdBy: j.created_by,
});

const JOB_COLUMNS = "id, org_id, entity, file_name, status, headers, mapping, options, total_rows, summary, error, created_at, completed_at, created_by";

/** Stores an uploaded CSV as rows waiting to be mapped. Nothing is imported yet. */
export async function createImportJob(actor: CrmActor, input: { entity: ImportEntity; fileName: string; csv: string }): Promise<{ job: ImportJobView; preview: string[][]; suggested: Record<string, string> }> {
  assertCan(actor, "contacts.import");
  if (input.entity !== "contact" && input.entity !== "company") throw new AppError("invalid_input", "Choose what you are importing.");
  if (Buffer.byteLength(input.csv, "utf8") > MAX_IMPORT_BYTES) throw new AppError("invalid_input", "This file is larger than 5 MB. Split it into smaller files.");
  let parsed;
  try {
    parsed = parseCsv(input.csv, { maxRows: MAX_IMPORT_ROWS });
  } catch (err) {
    throw new AppError("invalid_input", err instanceof CsvError ? err.message : "This file couldn't be read as CSV.");
  }
  if (!parsed.rows.length) throw new AppError("invalid_input", "The file has column names but no rows.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, input.entity === "company" ? "companies" : "contacts");
    const { rows } = await db.query<JobRow>(
      `insert into crm_import_jobs (org_id, entity, source, file_name, headers, total_rows, created_by) values ($1, $2, 'csv', $3, $4, $5, $6) returning ${JOB_COLUMNS}`,
      [actor.orgId, input.entity, input.fileName.replace(/[^\w .()-]/g, "_").slice(0, 200), parsed.headers, parsed.rows.length, actor.userId],
    );
    const job = rows[0];
    for (let i = 0; i < parsed.rows.length; i += 500) {
      const chunk = parsed.rows.slice(i, i + 500);
      const values: string[] = [];
      const params: unknown[] = [actor.orgId, job.id];
      chunk.forEach((cells, k) => {
        const data: Record<string, string> = {};
        parsed.headers.forEach((h, idx) => {
          if (cells[idx]) data[h] = cells[idx];
        });
        params.push(i + k + 1, JSON.stringify(data));
        values.push(`($1, $2, $${params.length - 1}, $${params.length}::jsonb)`);
      });
      await db.query(`insert into crm_import_rows (org_id, job_id, row_number, data) values ${values.join(", ")}`, params);
    }
    const fields = await loadFieldDefinitions(db, actor.orgId, input.entity);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.import_uploaded", targetType: "crm_import_job", targetId: job.id, result: "success", metadata: { entity: input.entity, rows: parsed.rows.length } }, db);
    return { job: toView(job), preview: parsed.rows.slice(0, 5), suggested: suggestMapping(input.entity, parsed.headers, fields) };
  });
}

export async function getImportJob(actor: CrmActor, id: string): Promise<ImportJobView & { problems: Array<{ row: number; status: string; errors: string[]; data: Record<string, string> }> }> {
  assertCan(actor, "contacts.import");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<JobRow>(`select ${JOB_COLUMNS} from crm_import_jobs where id = $1 and org_id = $2`, [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "Import not found.");
    const problems = await db.query<{ row_number: number; status: string; errors: string[]; data: Record<string, string> }>(
      `select row_number, status, errors, data from crm_import_rows where job_id = $1 and org_id = $2 and status in ('invalid', 'duplicate', 'needs_review', 'failed') order by row_number limit 200`,
      [id, actor.orgId],
    );
    return { ...toView(rows[0]), problems: problems.rows.map((p) => ({ row: p.row_number, status: p.status, errors: p.errors, data: p.data })) };
  });
}

export async function listImportJobs(actor: CrmActor, limit = 20): Promise<ImportJobView[]> {
  assertCan(actor, "contacts.import");
  return crmRead(actor, async (db) => (await db.query<JobRow>(`select ${JOB_COLUMNS} from crm_import_jobs where org_id = $1 order by created_at desc limit $2`, [actor.orgId, Math.min(100, limit)])).rows.map(toView));
}

/** Saves the confirmed mapping and starts the dry run (validation). */
export async function startValidation(actor: CrmActor, id: string, input: { mapping: Record<string, string>; options?: ImportOptions }): Promise<void> {
  assertCan(actor, "contacts.import");
  await crmWrite(actor, async (db) => {
    const { rows } = await db.query<JobRow>(`select ${JOB_COLUMNS} from crm_import_jobs where id = $1 and org_id = $2 for update`, [id, actor.orgId]);
    const job = rows[0];
    if (!job) throw new AppError("not_found", "Import not found.");
    if (!["uploaded", "validated"].includes(job.status)) throw new AppError("conflict", "This import has already started.");
    const targets = targetsFor(job.entity);
    const fields = new Set((await loadFieldDefinitions(db, actor.orgId, job.entity)).map((f) => `cf:${f.key}`));
    const mapping: Record<string, string> = {};
    const used = new Set<string>();
    for (const h of job.headers) {
      const t = input.mapping[h] ?? "ignore";
      if (t !== "ignore" && !(t in targets) && !fields.has(t)) throw new AppError("invalid_input", `"${h}" is mapped to something that doesn't exist.`);
      if (t !== "ignore" && used.has(t)) throw new AppError("invalid_input", `Two columns are mapped to the same field (${t.startsWith("cf:") ? t.slice(3) : targets[t].label}).`);
      if (t !== "ignore") used.add(t);
      mapping[h] = t;
    }
    const identifying = job.entity === "company" ? ["name"] : ["name", "first_name", "last_name", "email", "phone"];
    if (!identifying.some((t) => used.has(t))) throw new AppError("invalid_input", job.entity === "company" ? "Map a column to the company name." : "Map at least a name, email or phone column.");
    const options: ImportOptions = { duplicates: input.options?.duplicates ?? "skip", tagAll: (input.options?.tagAll ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 10) };
    if (options.tagAll?.length && !actor.can("tags.manage")) {
      const existing = await db.query<{ n: string }>("select count(*)::text as n from crm_tags where org_id = $1 and lower(name::text) = any($2::text[])", [actor.orgId, options.tagAll.map((t) => t.toLowerCase())]);
      if (Number(existing.rows[0].n) !== options.tagAll.length) throw new AppError("forbidden", "Only owners and managers can create new tags during an import. Choose existing tags.");
    }
    await db.query("update crm_import_rows set status = 'pending', errors = '[]', planned_action = null, match_id = null where job_id = $1", [id]);
    await db.query("update crm_import_jobs set mapping = $3, options = $4, status = 'validating', summary = '{}', validated_at = null, claimed_at = null where id = $1 and org_id = $2", [id, actor.orgId, JSON.stringify(mapping), JSON.stringify(options)]);
  });
}

export async function startImport(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "contacts.import");
  await crmWrite(actor, async (db) => {
    const res = await db.query<{ status: string }>("select status from crm_import_jobs where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    if (!res.rows[0]) throw new AppError("not_found", "Import not found.");
    if (res.rows[0].status === "importing" || res.rows[0].status === "completed") return; // a double click starts it once
    if (res.rows[0].status !== "validated") throw new AppError("conflict", "Check the file first (the dry run must finish before importing).");
    await db.query("update crm_import_jobs set status = 'importing', started_at = now(), claimed_at = null where id = $1", [id]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.import_started", targetType: "crm_import_job", targetId: id, result: "success" }, db);
  });
}

export async function cancelImport(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "contacts.import");
  await crmWrite(actor, async (db) => {
    const res = await db.query("update crm_import_jobs set status = 'cancelled', completed_at = now() where id = $1 and org_id = $2 and status in ('uploaded', 'validating', 'validated', 'importing')", [id, actor.orgId]);
    if (!res.rowCount) throw new AppError("conflict", "This import can't be cancelled now.");
  });
}

/** Undoes a finished import: records it created are removed and fields it changed are restored, unless someone changed them since. */
export async function rollbackImport(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "contacts.import");
  assertCan(actor, "contacts.delete", "Undoing an import needs the archive permission.");
  await crmWrite(actor, async (db) => {
    const res = await db.query("update crm_import_jobs set status = 'rolling_back', claimed_at = null, rolled_back_by = $3 where id = $1 and org_id = $2 and status in ('completed', 'cancelled')", [id, actor.orgId, actor.userId]);
    if (!res.rowCount) throw new AppError("conflict", "Only a finished or cancelled import can be undone.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.import_rollback_started", targetType: "crm_import_job", targetId: id, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Processing: a few hundred rows per call, claimed so two workers never process one job at once
// ---------------------------------------------------------------------------

const CHUNK = 250;

/** Advances one job by a chunk. Safe to call from the browser (polling) and from the scheduler at the same time. */
export async function advanceImport(jobId: string): Promise<{ status: string; done: boolean }> {
  const claimed = await withSystem(async (db) => {
    const { rows } = await db.query<JobRow>(
      `update crm_import_jobs set claimed_at = now() where id = $1 and status in ('validating', 'importing', 'rolling_back')
         and (claimed_at is null or claimed_at < now() - interval '2 minutes') returning ${JOB_COLUMNS}`,
      [jobId],
    );
    return rows[0] ?? null;
  });
  if (!claimed) {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from crm_import_jobs where id = $1", [jobId]));
    return { status: rows[0]?.status ?? "missing", done: !["validating", "importing", "rolling_back"].includes(rows[0]?.status ?? "") };
  }
  const org = await withSystem(async (db) => (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [claimed.org_id])).rows[0]);
  const actor: CrmActor = { ...systemActor(org, "Import"), userId: claimed.created_by };
  try {
    if (claimed.status === "validating") await validateChunk(actor, claimed);
    else if (claimed.status === "importing") await importChunk(actor, claimed);
    else await rollbackChunk(actor, claimed);
  } catch (err) {
    await withSystem((db) => db.query("update crm_import_jobs set status = 'failed', error = $2, claimed_at = null where id = $1", [jobId, err instanceof AppError ? err.message.slice(0, 500) : "The import stopped unexpectedly. Nothing after the last finished row was changed."]));
    return { status: "failed", done: true };
  }
  const { rows } = await withSystem((db) => db.query<{ status: string }>("update crm_import_jobs set claimed_at = null where id = $1 returning status", [jobId]));
  return { status: rows[0].status, done: !["validating", "importing", "rolling_back"].includes(rows[0].status) };
}

/** For the browser's progress polling: only the job's own workspace can push it forward. */
export async function advanceImportFor(actor: CrmActor, jobId: string) {
  assertCan(actor, "contacts.import");
  const owns = await crmRead(actor, async (db) => (await db.query("select 1 from crm_import_jobs where id = $1 and org_id = $2", [jobId, actor.orgId])).rows.length > 0);
  if (!owns) throw new AppError("not_found", "Import not found.");
  return advanceImport(jobId);
}

/** Scheduler entry point: moves every running import forward a little. */
export async function processImports(maxJobs = 5): Promise<{ advanced: number }> {
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from crm_import_jobs where status in ('validating', 'importing', 'rolling_back') order by created_at limit $1", [maxJobs]));
  for (const r of rows) await advanceImport(r.id);
  return { advanced: rows.length };
}

interface RowPlan {
  input: ContactInput;
  companyName: string | null;
  jobTitle: string | null;
  ownerEmail: string | null;
  tags: string[];
  externalId: string | null;
  note: string | null;
  fields: Record<string, unknown>;
}

type ImportRow = { row_number: number; data: Record<string, string>; status: string; planned_action: string | null; match_id: string | null; entity_id: string | null; result: Record<string, unknown> };

function pick(data: Record<string, string>, mapping: Record<string, string>, target: string): string | null {
  for (const [header, t] of Object.entries(mapping)) if (t === target) return data[header]?.trim() || null;
  return null;
}

function splitList(v: string | null): string[] {
  return (v ?? "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
}

function enumValue<T extends string>(raw: string | null, values: readonly T[], labels: Record<T, string> | null, what: string, errors: string[]): T | undefined {
  if (!raw) return undefined;
  const n = norm(raw);
  const hit = values.find((v) => v === n.replace(/ /g, "_") || (labels && norm(labels[v]) === n));
  if (!hit) errors.push(`"${raw.slice(0, 40)}" isn't a valid ${what}.`);
  return hit;
}

/** Turns one CSV row into a contact plan, collecting every problem rather than stopping at the first. */
function planContact(data: Record<string, string>, mapping: Record<string, string>, callingCode: string | null, fieldDefs: Awaited<ReturnType<typeof loadFieldDefinitions>>): { plan: RowPlan; errors: string[] } {
  const errors: string[] = [];
  const p = (t: string) => pick(data, mapping, t);
  let first = p("first_name");
  let last = p("last_name");
  const full = p("name");
  if (full && !first && !last) {
    const parts = full.split(/\s+/);
    first = parts.length > 1 ? parts.slice(0, -1).join(" ") : full;
    last = parts.length > 1 ? parts[parts.length - 1] : null;
  }
  const countryRaw = p("country");
  const country = countryRaw ? countryCode(countryRaw) : null;
  if (countryRaw && !country) errors.push(`"${countryRaw.slice(0, 40)}" isn't a country we recognize. Use a two-letter code such as PH.`);
  const scoreRaw = p("lead_score");
  const score = scoreRaw ? Number(scoreRaw) : undefined;
  if (scoreRaw && (!Number.isInteger(score) || score! < 0 || score! > 100)) errors.push("Lead score must be a whole number from 0 to 100.");
  const input: ContactInput = {
    firstName: first, lastName: last, displayName: full, email: p("email"), phone: p("phone"),
    emails: splitList(p("email_2")), phones: splitList(p("phone_2")),
    addressLine1: p("address_line1"), addressLine2: p("address_line2"), city: p("city"), region: p("region"), postalCode: p("postal_code"), country,
    timezone: p("timezone"), preferredLanguage: p("language"),
    preferredChannel: enumValue<PreferredChannel>(p("preferred_channel"), PREFERRED_CHANNELS, null, "preferred channel", errors),
    source: p("source"),
    leadStatus: enumValue<LeadStatus>(p("lead_status"), LEAD_STATUSES, LEAD_STATUS_LABELS, "lead status", errors),
    leadScore: scoreRaw && Number.isInteger(score) ? score : undefined,
  };
  try {
    const n = normalizeContactInput(input, callingCode);
    if (!n.displayName && !n.emails.length && !n.phones.length) errors.push("The row has no name, email or phone.");
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "This row is invalid.");
  }
  const fields: Record<string, unknown> = {};
  for (const [header, t] of Object.entries(mapping)) {
    if (!t.startsWith("cf:") || !data[header]) continue;
    const def = fieldDefs.find((f) => f.key === t.slice(3));
    if (!def) continue;
    const res = coerceFieldValue(def, data[header], { defaultCallingCode: callingCode });
    if (!res.ok) errors.push(res.error);
    else fields[def.key] = data[header];
  }
  return {
    plan: { input, companyName: p("company"), jobTitle: p("job_title"), ownerEmail: p("owner_email")?.toLowerCase() ?? null, tags: splitList(p("tags")), externalId: p("external_id"), note: p("note"), fields },
    errors,
  };
}

async function jobContext(db: Queryable, actor: CrmActor, job: JobRow) {
  const code = (await db.query<{ c: string | null }>("select default_calling_code as c from crm_workspaces where org_id = $1", [actor.orgId])).rows[0]?.c ?? null;
  const fieldDefs = await loadFieldDefinitions(db, actor.orgId, job.entity);
  const members = await db.query<{ user_id: string; email: string }>(
    "select m.user_id, u.email::text as email from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.status = 'active' and u.status = 'active'",
    [actor.orgId],
  );
  return { code, fieldDefs, members: new Map(members.rows.map((m) => [m.email.toLowerCase(), m.user_id])) };
}

async function validateChunk(actor: CrmActor, job: JobRow) {
  await withSystem(async (db) => {
    const ctx = await jobContext(db, actor, job);
    const { rows } = await db.query<ImportRow>("select row_number, data, status, planned_action, match_id, entity_id, result from crm_import_rows where job_id = $1 and status = 'pending' order by row_number limit $2", [job.id, CHUNK * 4]);
    if (!rows.length) {
      // Everything is checked: summarize the dry run.
      const s = await db.query<{ status: string; planned_action: string | null; n: string }>("select status, planned_action, count(*)::text as n from crm_import_rows where job_id = $1 group by 1, 2", [job.id]);
      const count = (pred: (r: { status: string; planned_action: string | null }) => boolean) => s.rows.filter(pred).reduce((acc, r) => acc + Number(r.n), 0);
      const summary: ImportSummary = {
        validated: count(() => true), valid: count((r) => r.status === "valid"), invalid: count((r) => r.status === "invalid"), duplicateInFile: count((r) => r.status === "duplicate"),
        create: count((r) => r.planned_action === "create"), update: count((r) => r.planned_action === "update"), skip: count((r) => r.planned_action === "skip"), review: count((r) => r.planned_action === "review"),
      };
      await db.query("update crm_import_jobs set status = 'validated', validated_at = now(), summary = $2 where id = $1", [job.id, JSON.stringify(summary)]);
      return;
    }
    // Addresses already seen earlier in this file, so the second copy of a person is flagged instead of imported twice.
    const earlier = await db.query<{ row_number: number; data: Record<string, string> }>("select row_number, data from crm_import_rows where job_id = $1 and status <> 'pending' and status <> 'invalid'", [job.id]);
    const seen = new Map<string, number>();
    const keysOf = (plan: RowPlan) => {
      try {
        const n = normalizeContactInput(plan.input, ctx.code);
        return [...n.emails.map((e) => `e:${e}`), ...n.phones.map((p) => `p:${p}`)];
      } catch {
        return [];
      }
    };
    for (const e of earlier.rows) {
      if (job.entity === "company") {
        const d = normalizeDomain(pick(e.data, job.mapping, "domain") ?? pick(e.data, job.mapping, "website"));
        if (d) seen.set(`d:${d}`, e.row_number);
        continue;
      }
      for (const k of keysOf(planContact(e.data, job.mapping, ctx.code, ctx.fieldDefs).plan)) if (!seen.has(k)) seen.set(k, e.row_number);
    }
    const policy = job.options?.duplicates ?? "skip";
    for (const r of rows) {
      if (job.entity === "company") {
        const name = pick(r.data, job.mapping, "name");
        const domainRaw = pick(r.data, job.mapping, "domain") ?? pick(r.data, job.mapping, "website");
        const domain = domainRaw ? normalizeDomain(domainRaw) : null;
        const errors: string[] = [];
        if (!name) errors.push("The row has no company name.");
        if (pick(r.data, job.mapping, "domain") && !domain) errors.push("That domain doesn't look right.");
        if (errors.length) {
          await db.query("update crm_import_rows set status = 'invalid', errors = $3 where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify(errors)]);
          continue;
        }
        if (domain && seen.has(`d:${domain}`)) {
          await db.query("update crm_import_rows set status = 'duplicate', planned_action = 'skip', errors = $3 where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify([`Same domain as row ${seen.get(`d:${domain}`)}.`])]);
          continue;
        }
        if (domain) seen.set(`d:${domain}`, r.row_number);
        const existing = domain ? (await db.query<{ id: string }>("select id from crm_companies where org_id = $1 and domain = $2 and deleted_at is null", [actor.orgId, domain])).rows[0] : null;
        const action = existing ? (policy === "update" ? "update" : policy === "review" ? "review" : "skip") : "create";
        await db.query("update crm_import_rows set status = 'valid', planned_action = $3, match_id = $4 where job_id = $1 and row_number = $2", [job.id, r.row_number, action, existing?.id ?? null]);
        continue;
      }
      const { plan, errors } = planContact(r.data, job.mapping, ctx.code, ctx.fieldDefs);
      if (plan.ownerEmail && !ctx.members.has(plan.ownerEmail)) errors.push(`${plan.ownerEmail} isn't a member of this workspace.`);
      if (errors.length) {
        await db.query("update crm_import_rows set status = 'invalid', errors = $3 where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify(errors.slice(0, 10))]);
        continue;
      }
      const keys = keysOf(plan);
      const dupOf = keys.map((k) => seen.get(k)).find((v) => v !== undefined);
      if (dupOf !== undefined) {
        await db.query("update crm_import_rows set status = 'duplicate', planned_action = 'skip', errors = $3 where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify([`Same email or phone as row ${dupOf}; only the first is imported.`])]);
        continue;
      }
      for (const k of keys) seen.set(k, r.row_number);
      let matchId: string | null = null;
      if (plan.externalId) {
        const ext = await db.query<{ native_id: string }>("select native_id from crm_external_ids where org_id = $1 and provider = 'csv' and entity = 'contact' and external_id = $2", [actor.orgId, plan.externalId]);
        matchId = ext.rows[0]?.native_id ?? null;
      }
      if (!matchId) {
        const n = normalizeContactInput(plan.input, ctx.code);
        matchId = (await findByIdentities(db, actor.orgId, n.emails, n.phones))[0]?.contactId ?? null;
      }
      const action = matchId ? (policy === "update" ? "update" : policy === "review" ? "review" : "skip") : "create";
      await db.query("update crm_import_rows set status = 'valid', planned_action = $3, match_id = $4 where job_id = $1 and row_number = $2", [job.id, r.row_number, action, matchId]);
    }
  });
}

async function importChunk(actor: CrmActor, job: JobRow) {
  await withSystem(async (db) => {
    const status = (await db.query<{ status: string }>("select status from crm_import_jobs where id = $1 for update", [job.id])).rows[0]?.status;
    if (status !== "importing") return;
    const ctx = await jobContext(db, actor, job);
    const { rows } = await db.query<ImportRow>("select row_number, data, status, planned_action, match_id, entity_id, result from crm_import_rows where job_id = $1 and status = 'valid' order by row_number limit $2", [job.id, CHUNK]);
    if (!rows.length) {
      const s = await db.query<{ status: string; n: string }>("select status, count(*)::text as n from crm_import_rows where job_id = $1 group by 1", [job.id]);
      const c = (st: string) => Number(s.rows.find((r) => r.status === st)?.n ?? 0);
      const summary: ImportSummary = { ...job.summary, created: c("created"), updated: c("updated"), skipped: c("skipped") + c("duplicate"), needsReview: c("needs_review"), failed: c("failed") + c("invalid") };
      await db.query("update crm_import_jobs set status = 'completed', completed_at = now(), summary = $2 where id = $1", [job.id, JSON.stringify(summary)]);
      if (job.created_by) {
        await notifyUser(db, job.created_by, actor.orgId, {
          kind: "crm_import_finished", severity: summary.failed ? "warning" : "success",
          title: `Import finished: ${summary.created ?? 0} added, ${summary.updated ?? 0} updated`,
          body: `${summary.skipped ?? 0} skipped, ${summary.needsReview ?? 0} need review, ${summary.failed ?? 0} could not be imported.`,
          link: `/crm/settings/data?import=${job.id}`, dedupeKey: `crm-import:${job.id}`,
        });
      }
      await recordAudit({ orgId: actor.orgId, actorUserId: job.created_by, actorKind: "system", action: "crm.import_completed", targetType: "crm_import_job", targetId: job.id, result: "success", metadata: summary as Record<string, unknown> }, db);
      return;
    }
    const tagAllIds = job.options?.tagAll?.length ? await ensureTagsByName(db, actor, job.options.tagAll) : [];
    for (const r of rows) {
      await db.query("savepoint import_row");
      try {
        const outcome = job.entity === "company" ? await importCompanyRow(db, actor, job, r, ctx) : await importContactRow(db, actor, job, r, ctx, tagAllIds);
        await db.query("update crm_import_rows set status = $3, entity_id = $4, result = $5, processed_at = now() where job_id = $1 and row_number = $2", [job.id, r.row_number, outcome.status, outcome.entityId, JSON.stringify(outcome.result)]);
        await db.query("release savepoint import_row");
      } catch (err) {
        await db.query("rollback to savepoint import_row");
        const message = err instanceof AppError ? err.message : "This row couldn't be imported.";
        await db.query("update crm_import_rows set status = 'failed', errors = $3, processed_at = now() where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify([message.slice(0, 300)])]);
      }
    }
  });
}

type Outcome = { status: "created" | "updated" | "skipped" | "needs_review"; entityId: string | null; result: Record<string, unknown> };

const PATCHABLE: Array<[keyof ContactInput, string]> = [
  ["firstName", "first_name"], ["lastName", "last_name"], ["addressLine1", "address_line1"], ["addressLine2", "address_line2"], ["city", "city"], ["region", "region"],
  ["postalCode", "postal_code"], ["country", "country"], ["timezone", "timezone"], ["preferredLanguage", "preferred_language"], ["preferredChannel", "preferred_channel"],
  ["leadStatus", "lead_status"], ["leadScore", "lead_score"],
];

async function importContactRow(db: Queryable, actor: CrmActor, job: JobRow, r: ImportRow, ctx: Awaited<ReturnType<typeof jobContext>>, tagAllIds: string[]): Promise<Outcome> {
  const { plan } = planContact(r.data, job.mapping, ctx.code, ctx.fieldDefs);
  const ownerId = plan.ownerEmail ? ctx.members.get(plan.ownerEmail) ?? null : null;
  const policy = job.options?.duplicates ?? "skip";
  const tagIds = [...tagAllIds, ...(plan.tags.length ? await ensureTagsByName(db, actor, plan.tags) : [])];
  let companyId: string | null = null;
  if (plan.companyName) {
    const found = await db.query<{ id: string }>("select id from crm_companies where org_id = $1 and lower(name) = lower($2) and deleted_at is null order by created_at limit 1", [actor.orgId, plan.companyName]);
    companyId = found.rows[0]?.id ?? (await createCompanyInTx(db, actor, { name: plan.companyName }, "import")).id;
  }
  let target = r.planned_action === "create" ? null : r.match_id;
  if (r.planned_action === "skip") return { status: "skipped", entityId: r.match_id, result: {} };
  if (r.planned_action === "review") return { status: "needs_review", entityId: r.match_id, result: {} };
  if (!target) {
    try {
      const created = await createContactInTx(db, actor, { ...plan.input, ownerId, companyId, companyTitle: plan.jobTitle, customFields: plan.fields }, { via: "import", onDuplicate: "error", tagSource: "import" });
      if (tagIds.length) await applyContactTags(db, actor, [created.id], tagIds, "import");
      if (plan.externalId) await db.query("insert into crm_external_ids (org_id, provider, entity, external_id, native_id) values ($1, 'csv', 'contact', $2, $3) on conflict do nothing", [actor.orgId, plan.externalId, created.id]);
      if (plan.note) await addImportNote(db, actor, created.id, plan.note);
      const v = await db.query<{ version: number }>("select version from contacts where id = $1", [created.id]);
      return { status: "created", entityId: created.id, result: { tagsAdded: tagIds, version: v.rows[0].version } };
    } catch (err) {
      // Someone created this person after the dry run: follow the chosen rule for duplicates.
      if (!(err instanceof DuplicateContactError)) throw err;
      if (policy === "skip") return { status: "skipped", entityId: err.existingContactId, result: {} };
      if (policy === "review") return { status: "needs_review", entityId: err.existingContactId, result: {} };
      target = err.existingContactId;
    }
  }
  // Update: fill in what the file has, never blank out what the record already holds. Remember what changed so it can be undone.
  const cur = (await db.query<Record<string, unknown>>("select * from contacts where id = $1 and org_id = $2 and deleted_at is null for update", [target, actor.orgId])).rows[0];
  if (!cur) return { status: "skipped", entityId: null, result: {} };
  const n = normalizeContactInput(plan.input, ctx.code);
  const previous: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [target, actor.orgId];
  for (const [key, column] of PATCHABLE) {
    const value = (n as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === "" || cur[column] === value) continue;
    previous[column] = cur[column] ?? null;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (ownerId && cur.assigned_user_id !== ownerId) {
    previous.assigned_user_id = cur.assigned_user_id ?? null;
    params.push(ownerId);
    sets.push(`assigned_user_id = $${params.length}`);
  }
  if (sets.length) await db.query(`update contacts set ${sets.join(", ")}, version = version + 1 where id = $1 and org_id = $2`, params);
  const fieldsBefore = Object.keys(plan.fields).length
    ? (await db.query<{ key: string; value_text: string | null; value_number: string | null; value_date: string | null; value_ts: Date | null; value_bool: boolean | null; value_list: string[] | null }>(
        "select f.key, v.value_text, v.value_number::text as value_number, v.value_date::text as value_date, v.value_ts, v.value_bool, v.value_list from crm_field_values v join crm_custom_fields f on f.id = v.field_id where v.org_id = $1 and v.entity_id = $2 and f.key = any($3::text[])",
        [actor.orgId, target, Object.keys(plan.fields)],
      )).rows
    : [];
  const changedFields = Object.keys(plan.fields).length ? await writeFieldValues(db, actor, "contact", target, plan.fields, { defaultCallingCode: ctx.code }) : [];
  const added: string[] = [];
  if (tagIds.length) {
    const before = await db.query<{ tag_id: string }>("select tag_id from crm_contact_tags where contact_id = $1 and tag_id = any($2::uuid[])", [target, tagIds]);
    const had = new Set(before.rows.map((x) => x.tag_id));
    await applyContactTags(db, actor, [target], tagIds, "import");
    for (const t of tagIds) if (!had.has(t)) added.push(t);
  }
  if (plan.externalId) await db.query("insert into crm_external_ids (org_id, provider, entity, external_id, native_id) values ($1, 'csv', 'contact', $2, $3) on conflict do nothing", [actor.orgId, plan.externalId, target]);
  if (companyId) await db.query("insert into crm_contact_companies (org_id, contact_id, company_id, title, is_primary) values ($1, $2, $3, $4, not exists (select 1 from crm_contact_companies where contact_id = $2 and is_primary)) on conflict do nothing", [actor.orgId, target, companyId, plan.jobTitle]);
  if (plan.note) await addImportNote(db, actor, target, plan.note);
  if (sets.length || changedFields.length) {
    await emitEvent(db, actor, { type: "contact.updated", entityType: "contact", entityId: target, contactId: target, payload: { changed: [...Object.keys(previous), ...changedFields.map((k) => `cf:${k}`)], via: "import" }, dedupeKey: `contact.updated:import:${job.id}:${r.row_number}` });
    await recordActivity(db, actor, { kind: "contact.updated", summary: "Details updated by an import", contactId: target, refType: "import", refId: job.id });
  }
  const v = await db.query<{ version: number }>("select version from contacts where id = $1", [target]);
  return { status: "updated", entityId: target, result: { previous, previousFields: fieldsBefore, changedFields, tagsAdded: added, version: v.rows[0].version } };
}

async function addImportNote(db: Queryable, actor: CrmActor, contactId: string, note: string) {
  await db.query("insert into record_notes (org_id, record_type, record_id, body, author_id) values ($1, 'contact', $2, $3, $4)", [actor.orgId, contactId, note.slice(0, 4000), actor.userId]);
}

async function importCompanyRow(db: Queryable, actor: CrmActor, job: JobRow, r: ImportRow, ctx: Awaited<ReturnType<typeof jobContext>>): Promise<Outcome> {
  if (r.planned_action === "skip") return { status: "skipped", entityId: r.match_id, result: {} };
  if (r.planned_action === "review") return { status: "needs_review", entityId: r.match_id, result: {} };
  const p = (t: string) => pick(r.data, job.mapping, t);
  const fields: Record<string, unknown> = {};
  for (const [header, t] of Object.entries(job.mapping)) if (t.startsWith("cf:") && r.data[header]) fields[t.slice(3)] = r.data[header];
  const countryRaw = p("country");
  const input = {
    name: p("name")!, domain: p("domain"), website: p("website"), industry: p("industry"), phone: p("phone"), email: p("email"), addressLine1: p("address_line1"),
    city: p("city"), region: p("region"), postalCode: p("postal_code"), country: countryRaw ? countryCode(countryRaw) : null,
    ownerId: p("owner_email") ? ctx.members.get(p("owner_email")!.toLowerCase()) ?? null : null, customFields: fields,
  };
  if (r.planned_action === "update" && r.match_id) {
    // Companies are only ever filled in, never overwritten, on import.
    await db.query(
      `update crm_companies set industry = coalesce(industry, $3), phone = coalesce(phone, $4), city = coalesce(city, $5), region = coalesce(region, $6), country = coalesce(country, $7), version = version + 1
       where id = $1 and org_id = $2`,
      [r.match_id, actor.orgId, input.industry, null, input.city, input.region, input.country],
    );
    return { status: "updated", entityId: r.match_id, result: {} };
  }
  const created = await createCompanyInTx(db, actor, input, "import", { onDuplicate: "return_existing" });
  const tags = (p("tags") ?? "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
  if (tags.length) {
    const ids = await ensureTagsByName(db, actor, tags);
    await db.query("insert into crm_company_tags (org_id, company_id, tag_id) select $1, $2, t from unnest($3::uuid[]) t on conflict do nothing", [actor.orgId, created.id, ids]);
  }
  if (p("external_id")) await db.query("insert into crm_external_ids (org_id, provider, entity, external_id, native_id) values ($1, 'csv', 'company', $2, $3) on conflict do nothing", [actor.orgId, p("external_id"), created.id]);
  return { status: created.created ? "created" : "skipped", entityId: created.id, result: {} };
}

async function rollbackChunk(actor: CrmActor, job: JobRow) {
  await withSystem(async (db) => {
    const { rows } = await db.query<ImportRow>("select row_number, data, status, planned_action, match_id, entity_id, result from crm_import_rows where job_id = $1 and status in ('created', 'updated') order by row_number desc limit $2", [job.id, CHUNK]);
    if (!rows.length) {
      const s = await db.query<{ status: string; n: string }>("select status, count(*)::text as n from crm_import_rows where job_id = $1 group by 1", [job.id]);
      const summary: ImportSummary = { ...job.summary, rolledBack: Number(s.rows.find((r) => r.status === "rolled_back")?.n ?? 0), keptChanged: Number(s.rows.find((r) => r.status === "needs_review")?.n ?? 0) };
      await db.query("update crm_import_jobs set status = 'rolled_back', rolled_back_at = now(), summary = $2 where id = $1", [job.id, JSON.stringify(summary)]);
      await recordAudit({ orgId: actor.orgId, actorUserId: job.created_by, actorKind: "system", action: "crm.import_rolled_back", targetType: "crm_import_job", targetId: job.id, result: "success", metadata: summary as Record<string, unknown> }, db);
      return;
    }
    for (const r of rows) {
      const result = r.result as {
        version?: number; previous?: Record<string, unknown>; tagsAdded?: string[]; changedFields?: string[];
        previousFields?: Array<{ key: string; value_text: string | null; value_number: string | null; value_date: string | null; value_ts: string | null; value_bool: boolean | null; value_list: string[] | null }>;
      };
      if (job.entity === "company" && r.status === "updated") {
        await db.query("update crm_import_rows set status = 'needs_review', errors = $3 where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify(["The import only filled in empty company details; they were kept."])]);
        continue;
      }
      const table = job.entity === "company" ? "crm_companies" : "contacts";
      const cur = r.entity_id ? (await db.query<{ version: number }>(`select version from ${table} where id = $1 and org_id = $2 and deleted_at is null for update`, [r.entity_id, actor.orgId])).rows[0] : null;
      // Changed by someone since the import: kept as it is and reported, never overwritten.
      if (!cur || (result.version !== undefined && cur.version !== result.version)) {
        await db.query("update crm_import_rows set status = 'needs_review', errors = $3 where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify(["Changed since the import, so it was kept."])]);
        continue;
      }
      if (job.entity === "contact") {
        if (result.tagsAdded?.length) await db.query("delete from crm_contact_tags where org_id = $1 and contact_id = $2 and tag_id = any($3::uuid[])", [actor.orgId, r.entity_id, result.tagsAdded]);
        if (r.status === "created") {
          await db.query("delete from contact_identities where org_id = $1 and contact_id = $2", [actor.orgId, r.entity_id]);
          await db.query("delete from crm_external_ids where org_id = $1 and provider = 'csv' and native_id = $2", [actor.orgId, r.entity_id]);
          await db.query("update contacts set deleted_at = now(), email = null, phone = null where id = $1 and org_id = $2", [r.entity_id, actor.orgId]);
        } else if (result.previous && Object.keys(result.previous).length) {
          const cols = Object.keys(result.previous).filter((c) => /^[a-z_0-9]+$/.test(c));
          const params: unknown[] = [r.entity_id, actor.orgId, ...cols.map((c) => result.previous![c])];
          await db.query(`update contacts set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")}, version = version + 1 where id = $1 and org_id = $2`, params);
        }
        if (r.status === "updated" && result.changedFields?.length) {
          // Custom fields go back to exactly what they held before (or to empty).
          const defs = await db.query<{ id: string; key: string }>("select id, key from crm_custom_fields where org_id = $1 and key = any($2::text[]) and entity = 'contact'", [actor.orgId, result.changedFields]);
          for (const d of defs.rows) {
            await db.query("delete from crm_field_values where org_id = $1 and field_id = $2 and entity_id = $3", [actor.orgId, d.id, r.entity_id]);
            const prev = result.previousFields?.find((f) => f.key === d.key);
            if (prev) {
              await db.query(
                "insert into crm_field_values (org_id, field_id, entity, entity_id, value_text, value_number, value_date, value_ts, value_bool, value_list) values ($1, $2, 'contact', $3, $4, $5, $6, $7, $8, $9)",
                [actor.orgId, d.id, r.entity_id, prev.value_text, prev.value_number, prev.value_date, prev.value_ts, prev.value_bool, prev.value_list],
              );
            }
          }
        }
      } else if (r.status === "created") {
        await db.query("update crm_companies set deleted_at = now(), domain = null where id = $1 and org_id = $2", [r.entity_id, actor.orgId]);
      }
      await db.query("update crm_import_rows set status = 'rolled_back' where job_id = $1 and row_number = $2", [job.id, r.row_number]);
    }
  });
}
