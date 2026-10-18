import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { assertCan, auditActor, crmRead, crmWrite, systemActor, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { assertAssignable, createContactInTx, DuplicateContactError, findByIdentities, normalizeContactInput, type ContactInput } from "@/server/crm/contacts";
import { createCompanyInTx, normalizeDomain } from "@/server/crm/companies";
import { createOpportunityInTx } from "@/server/crm/opportunities";
import { loadFieldDefinitions, writeFieldValues } from "@/server/crm/fields";
import { applyContactTags, ensureTagsByName } from "@/server/crm/tags";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { coerceFieldValue, normalizeOptions, slugifyKey } from "@/lib/crm/fields";
import { CsvError, parseCsv } from "@/lib/crm/csv";
import { normalizeEmail, normalizePhone } from "@/lib/messaging";
import { GHL_ENTITY_LABELS, ghlDependentsOf, isGhlMigrationEntity } from "@/lib/crm/ghl-migration";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, PREFERRED_CHANNELS, TAG_COLORS, type CrmCapability, type FieldType, type LeadStatus, type PreferredChannel } from "@/lib/crm/types";

// ---------------------------------------------------------------------------
// What a column can be mapped to
// ---------------------------------------------------------------------------

/** What a CSV file can hold. */
export type CsvImportEntity = "contact" | "company";
/** Every kind of import job. Opportunities and the configuration steps (custom fields, tags, pipelines) come from a GoHighLevel migration. */
export type ImportEntity = CsvImportEntity | "opportunity" | "custom_field" | "tag" | "pipeline";
/** Where the rows came from: an uploaded file, or GoHighLevel's official API (read-only, see src/server/crm/ghl-migration.ts). */
export type ImportSource = "csv" | "ghl_api";

/** The capability whose owner must be iAcquire for the import phase to write. */
export const IMPORT_CAPABILITY: Record<ImportEntity, CrmCapability> = {
  contact: "contacts", company: "companies", opportunity: "opportunities", custom_field: "custom_fields", tag: "tags", pipeline: "pipelines",
};

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

const targetsFor = (entity: CsvImportEntity) => (entity === "company" ? COMPANY_IMPORT_TARGETS : CONTACT_IMPORT_TARGETS);
const norm = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

/** Suggests a target for each header, by name. A person always confirms the mapping before anything is imported. */
export function suggestMapping(entity: CsvImportEntity, headers: string[], customFields: Array<{ key: string; label: string }>): Record<string, string> {
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
/** A GoHighLevel step stops staging (and says so) past this many records. */
export const MAX_GHL_ROWS = 100_000;

export interface ImportFetchView {
  pages: number;
  requests: number;
  /** How many times GoHighLevel answered 429 (iAcquire pacing itself is not counted here: see waitReason). */
  rateLimited: number;
  /** The job is waiting until this time before asking GoHighLevel again. */
  waitingUntil: string | null;
  /** Why it is waiting: GoHighLevel's Retry-After, iAcquire's own per-10-second budget, the daily reserve, or a passing GoHighLevel error. */
  waitReason: ImportWaitReason | null;
  /** Passing GoHighLevel errors in a row (5xx, timeouts) since the last page was staged, and the latest one's message. */
  transientErrors: number;
  lastError: string | null;
  /** The total GoHighLevel reported, when it reports one. */
  sourceTotal: number | null;
  truncated: boolean;
  fetchedAt: string | null;
  /** Whether the location's users could be read to map owners (users.readonly). Null before the job got that far. */
  ownersReadable: boolean | null;
}

export interface ImportJobView {
  id: string;
  entity: ImportEntity;
  source: ImportSource;
  fileName: string | null;
  status: string;
  headers: string[];
  mapping: Record<string, string>;
  options: ImportOptions;
  totalRows: number;
  summary: ImportSummary;
  error: string | null;
  createdAt: string;
  validatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  /** Who started the real import (after the dry run). Null before it started. */
  startedBy: string | null;
  /** The provider switch this job belongs to, if a switch started it. */
  switchId: string | null;
  /** GoHighLevel jobs only: how reading the source went. */
  fetch: ImportFetchView | null;
  /**
   * Live progress of a running dry run, import or undo, counted from the rows themselves (the summary is only written when a phase ends).
   * Undo: rows removed so far out of those removed plus those still to undo. Null when the job isn't running.
   */
  progress: { done: number; total: number } | null;
}

export type ImportWaitReason = "retry_after" | "burst" | "daily" | "error";

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
  /** Notes on rows, counted by code (IMPORT_FLAG_LABELS in src/lib/crm/ghl-migration.ts). GoHighLevel jobs only. */
  flags?: Record<string, number>;
}

/** What a GoHighLevel job remembers about reading its source. The location's users map owners by email and is never shown. */
export interface ImportFetchState {
  pages?: number;
  requests?: number;
  rateLimited?: number;
  lastWaitMs?: number;
  /** Why the latest wait happened (shown honestly: GoHighLevel asked, or iAcquire paced itself, or GoHighLevel had a passing error). */
  lastWaitReason?: ImportWaitReason;
  /**
   * Passing GoHighLevel errors in a row (5xx, timeouts) and the time spent waiting them out; both reset after every page staged. The step
   * fails once GHL_TRANSIENT_MAX_ERRORS or GHL_TRANSIENT_BACKOFF_MS (src/server/crm/ghl-migration.ts) runs out.
   */
  transientErrors?: number;
  transientWaitMs?: number;
  lastError?: string;
  sourceTotal?: number | null;
  /** Where sourceTotal came from: meta.total, the documented `count`, or a list GoHighLevel returns whole. */
  sourceTotalFrom?: "meta.total" | "count" | "list";
  /** `count` turned out not to be a total (it was smaller than what had been read), so it is ignored from then on. */
  countNotTotal?: boolean;
  truncated?: boolean;
  users?: Record<string, string>;
  ownersReadable?: boolean;
  companyId?: string | null;
  locationName?: string | null;
  detailReads?: number;
}

type JobRow = {
  id: string; org_id: string; entity: ImportEntity; source: ImportSource; file_name: string | null; status: string; headers: string[]; mapping: Record<string, string>; options: ImportOptions;
  total_rows: number; summary: ImportSummary; error: string | null; created_at: Date; validated_at: Date | null; started_at: Date | null; completed_at: Date | null; created_by: string | null;
  switch_id: string | null; source_location: string | null; fetch_state: ImportFetchState; fetch_not_before: Date | null; fetched_at: Date | null;
  started_by: string | null; rolled_back_by: string | null; claimed_at: Date | null;
};

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

const toView = (j: JobRow): ImportJobView => {
  const waiting = j.status === "fetching" && j.fetch_not_before && new Date(j.fetch_not_before).getTime() > Date.now();
  return {
    id: j.id, entity: j.entity, source: j.source, fileName: j.file_name, status: j.status, headers: j.headers, mapping: j.mapping, options: j.options, totalRows: j.total_rows, summary: j.summary ?? {},
    error: j.error, createdAt: new Date(j.created_at).toISOString(), validatedAt: iso(j.validated_at), startedAt: iso(j.started_at), completedAt: iso(j.completed_at), createdBy: j.created_by,
    startedBy: j.started_by ?? null, switchId: j.switch_id, progress: null,
    fetch: j.source === "ghl_api"
      ? {
          pages: j.fetch_state?.pages ?? 0, requests: j.fetch_state?.requests ?? 0, rateLimited: j.fetch_state?.rateLimited ?? 0,
          waitingUntil: waiting ? iso(j.fetch_not_before) : null, waitReason: waiting ? j.fetch_state?.lastWaitReason ?? null : null,
          transientErrors: j.fetch_state?.transientErrors ?? 0, lastError: j.fetch_state?.lastError ?? null,
          sourceTotal: j.fetch_state?.sourceTotal ?? null, truncated: j.fetch_state?.truncated === true, fetchedAt: iso(j.fetched_at),
          ownersReadable: typeof j.fetch_state?.ownersReadable === "boolean" ? j.fetch_state.ownersReadable : null,
        }
      : null,
  };
};

const JOB_COLUMNS =
  "id, org_id, entity, source, file_name, status, headers, mapping, options, total_rows, summary, error, created_at, validated_at, started_at, completed_at, created_by, switch_id, source_location, fetch_state, fetch_not_before, fetched_at, started_by, rolled_back_by, claimed_at";

/** Fills in live progress for running jobs from their rows (one grouped query). */
async function withProgress(db: Queryable, views: ImportJobView[]): Promise<ImportJobView[]> {
  const running = views.filter((v) => v.status === "validating" || v.status === "importing" || v.status === "rolling_back");
  if (!running.length) return views;
  const { rows } = await db.query<{ job_id: string; checked: number; handled: number; left: number; undone: number }>(
    `select job_id, count(*) filter (where status <> 'pending')::int as checked, count(*) filter (where status not in ('pending', 'valid'))::int as handled,
            count(*) filter (where status in ('created', 'updated'))::int as left, count(*) filter (where status = 'rolled_back')::int as undone
       from crm_import_rows where job_id = any($1::uuid[]) group by job_id`,
    [running.map((v) => v.id)],
  );
  for (const v of running) {
    const c = rows.find((r) => r.job_id === v.id) ?? { checked: 0, handled: 0, left: 0, undone: 0 };
    v.progress = v.status === "validating" ? { done: c.checked, total: v.totalRows }
      : v.status === "importing" ? { done: c.handled, total: v.totalRows }
        : { done: c.undone, total: c.undone + c.left };
  }
  return views;
}

/** The provider a job's external ids are recorded under, and how its records say they arrived. */
const providerOf = (j: { source: ImportSource }) => (j.source === "ghl_api" ? "ghl" : "csv");
const viaOf = (j: { source: ImportSource }) => (j.source === "ghl_api" ? ("ghl_migration" as const) : ("import" as const));

/** Stores an uploaded CSV as rows waiting to be mapped. Nothing is imported yet. */
export async function createImportJob(actor: CrmActor, input: { entity: CsvImportEntity; fileName: string; csv: string }): Promise<{ job: ImportJobView; preview: string[][]; suggested: Record<string, string> }> {
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

/**
 * A GoHighLevel migration step (src/server/crm/ghl-migration.ts authorizes and calls this inside its transaction). It starts in 'fetching':
 * the worker reads the source page by page and stages each record as a row, then runs the dry run by itself. Nothing is imported until a
 * person starts the import after the dry run.
 */
export async function createGhlImportJobInTx(
  db: Queryable,
  actor: CrmActor,
  input: { entity: ImportEntity; sourceLocation: string; switchId: string | null; duplicates: NonNullable<ImportOptions["duplicates"]>; label: string },
): Promise<ImportJobView> {
  const { rows } = await db.query<JobRow>(
    `insert into crm_import_jobs (org_id, entity, source, file_name, status, source_location, switch_id, fetch_cursor, options, created_by)
     values ($1, $2, 'ghl_api', $3, 'fetching', $4, $5, '{}'::jsonb, $6, $7) returning ${JOB_COLUMNS}`,
    [actor.orgId, input.entity, input.label.slice(0, 200), input.sourceLocation, input.switchId, JSON.stringify({ duplicates: input.duplicates }), actor.userId],
  );
  return toView(rows[0]);
}

/**
 * Puts a GoHighLevel step that failed while reading (it never finished staging) back to reading, from its stored cursor: the rows it
 * staged stay, the passing-error counters start again, and the duplicate choice is the new one. Null when the job isn't in that state.
 * Inside the caller's transaction (src/server/crm/ghl-migration.ts authorizes it).
 */
export async function resumeGhlImportJobInTx(db: Queryable, actor: CrmActor, id: string, input: { duplicates: NonNullable<ImportOptions["duplicates"]> }): Promise<ImportJobView | null> {
  const { rows } = await db.query<JobRow>(
    `update crm_import_jobs set status = 'fetching', error = null, completed_at = null, claimed_at = null, fetch_not_before = null, options = options || $3::jsonb,
            fetch_state = fetch_state - 'transientErrors' - 'transientWaitMs' - 'lastError' - 'lastWaitReason'
      where id = $1 and org_id = $2 and source = 'ghl_api' and status = 'failed' and fetched_at is null and validated_at is null returning ${JOB_COLUMNS}`,
    [id, actor.orgId, JSON.stringify({ duplicates: input.duplicates })],
  );
  return rows[0] ? toView(rows[0]) : null;
}

/**
 * Appends staged GoHighLevel records to a job. A record already staged (a page read twice after a resumed cursor) is not staged again.
 * Returns how many were added. Call inside the transaction that also moves the job's cursor.
 */
export async function stageImportRowsInTx(db: Queryable, orgId: string, jobId: string, rows: Array<{ data: Record<string, unknown>; flags?: string[] }>): Promise<number> {
  const ids = rows.map((r) => String(r.data.ghl_id ?? "")).filter(Boolean);
  const have = new Set(
    ids.length
      ? (await db.query<{ id: string }>("select data->>'ghl_id' as id from crm_import_rows where job_id = $1 and data ? 'ghl_id' and data->>'ghl_id' = any($2::text[])", [jobId, ids])).rows.map((r) => r.id)
      : [],
  );
  const fresh: Array<{ data: Record<string, unknown>; flags: string[] }> = [];
  for (const r of rows) {
    const id = String(r.data.ghl_id ?? "");
    if (!id || have.has(id)) continue;
    have.add(id);
    let data = r.data;
    const flags = [...(r.flags ?? [])];
    // A record with an unusually large custom-field payload is staged without those values (and says so) rather than failing the page.
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > 15_000) {
      data = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "custom_fields"));
      flags.push("too_large");
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > 15_000) data = { ghl_id: id, name: String(data.name ?? "").slice(0, 200) };
    }
    fresh.push({ data, flags: [...new Set(flags)].slice(0, 20) });
  }
  if (!fresh.length) return 0;
  const job = (await db.query<{ total_rows: number }>("select total_rows from crm_import_jobs where id = $1 and org_id = $2 for update", [jobId, orgId])).rows[0];
  if (!job) throw new AppError("not_found", "Import not found.");
  for (let i = 0; i < fresh.length; i += 200) {
    const chunk = fresh.slice(i, i + 200);
    const values: string[] = [];
    const params: unknown[] = [orgId, jobId];
    chunk.forEach((r, k) => {
      params.push(job.total_rows + i + k + 1, JSON.stringify(r.data), r.flags);
      values.push(`($1, $2, $${params.length - 2}, $${params.length - 1}::jsonb, $${params.length}::text[])`);
    });
    await db.query(`insert into crm_import_rows (org_id, job_id, row_number, data, flags) values ${values.join(", ")}`, params);
  }
  await db.query("update crm_import_jobs set total_rows = total_rows + $2 where id = $1", [jobId, fresh.length]);
  return fresh.length;
}

/** Staged values as plain text, for showing a row to a person. */
function displayData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (typeof v === "string" && v) out[k] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) out[k] = v.join(", ").slice(0, 200);
  }
  return out;
}

export interface ImportProblem {
  row: number;
  status: string;
  errors: string[];
  flags: string[];
  data: Record<string, string>;
}

export async function getImportJob(actor: CrmActor, id: string): Promise<ImportJobView & { problems: ImportProblem[] }> {
  assertCan(actor, "contacts.import");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<JobRow>(`select ${JOB_COLUMNS} from crm_import_jobs where id = $1 and org_id = $2`, [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "Import not found.");
    const problems = await db.query<{ row_number: number; status: string; errors: string[]; flags: string[]; data: Record<string, unknown> }>(
      `select row_number, status, errors, flags, data from crm_import_rows where job_id = $1 and org_id = $2
       and (status in ('invalid', 'duplicate', 'needs_review', 'failed') or cardinality(flags) > 0) order by row_number limit 200`,
      [id, actor.orgId],
    );
    const [view] = await withProgress(db, [toView(rows[0])]);
    return { ...view, problems: problems.rows.map((p) => ({ row: p.row_number, status: p.status, errors: p.errors, flags: p.flags ?? [], data: displayData(p.data) })) };
  });
}

export async function listImportJobs(actor: CrmActor, limit = 20): Promise<ImportJobView[]> {
  assertCan(actor, "contacts.import");
  return crmRead(actor, async (db) => withProgress(db, (await db.query<JobRow>(`select ${JOB_COLUMNS} from crm_import_jobs where org_id = $1 order by created_at desc limit $2`, [actor.orgId, Math.min(100, limit)])).rows.map(toView)));
}

/** These jobs of the actor's workspace (ids from another workspace are simply not found). */
export async function getImportJobs(actor: CrmActor, ids: string[]): Promise<ImportJobView[]> {
  assertCan(actor, "contacts.import");
  if (!ids.length) return [];
  return crmRead(actor, async (db) => withProgress(db, (await db.query<JobRow>(`select ${JOB_COLUMNS} from crm_import_jobs where org_id = $1 and id = any($2::uuid[]) order by created_at desc`, [actor.orgId, ids.slice(0, 100)])).rows.map(toView)));
}

/** Saves the confirmed mapping and starts the dry run (validation). */
export async function startValidation(actor: CrmActor, id: string, input: { mapping: Record<string, string>; options?: ImportOptions }): Promise<void> {
  assertCan(actor, "contacts.import");
  await crmWrite(actor, async (db) => {
    const { rows } = await db.query<JobRow>(`select ${JOB_COLUMNS} from crm_import_jobs where id = $1 and org_id = $2 for update`, [id, actor.orgId]);
    const job = rows[0];
    if (!job) throw new AppError("not_found", "Import not found.");
    if (job.source !== "csv" || (job.entity !== "contact" && job.entity !== "company")) throw new AppError("conflict", "GoHighLevel migration steps are checked automatically. Use Check again in the migration panel.");
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

/** Runs a GoHighLevel step's dry run again (for example after the steps before it were imported). Inside the caller's transaction. */
export async function revalidateImportInTx(db: Queryable, actor: CrmActor, id: string): Promise<void> {
  const res = await db.query<{ status: string; source: ImportSource }>("select status, source from crm_import_jobs where id = $1 and org_id = $2 for update", [id, actor.orgId]);
  const job = res.rows[0];
  if (!job) throw new AppError("not_found", "Import not found.");
  if (job.source !== "ghl_api") throw new AppError("conflict", "Only GoHighLevel steps are checked again this way.");
  if (job.status !== "validated") throw new AppError("conflict", job.status === "validating" ? "This step is being checked now." : "This step can only be checked again before it is imported.");
  await db.query("update crm_import_rows set status = 'pending', errors = '[]', planned_action = null, match_id = null, flags = array(select f from unnest(flags) f where f in ('too_large')) where job_id = $1", [id]);
  await db.query("update crm_import_jobs set status = 'validating', summary = '{}', validated_at = null, claimed_at = null where id = $1", [id]);
}

export async function startImport(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "contacts.import");
  await crmWrite(actor, async (db) => {
    const src = await db.query<{ source: ImportSource }>("select source from crm_import_jobs where id = $1 and org_id = $2", [id, actor.orgId]);
    // A GoHighLevel step has its own authorization (the owner), ownership and ordering checks: src/server/crm/ghl-migration.ts.
    if (src.rows[0]?.source === "ghl_api") throw new AppError("conflict", "Start GoHighLevel migration steps from the migration panel.");
    await startImportInTx(db, actor, id);
  });
}

/** Moves a dry-run job to importing. The caller has authorized the actor; inside the caller's transaction. */
export async function startImportInTx(db: Queryable, actor: CrmActor, id: string): Promise<void> {
  const res = await db.query<{ status: string }>("select status from crm_import_jobs where id = $1 and org_id = $2 for update", [id, actor.orgId]);
  if (!res.rows[0]) throw new AppError("not_found", "Import not found.");
  if (res.rows[0].status === "importing" || res.rows[0].status === "completed") return; // a double click starts it once
  if (res.rows[0].status !== "validated") throw new AppError("conflict", "Check the file first (the dry run must finish before importing).");
  // The worker writes the import as the person who started it (not whoever uploaded the file or ran the dry run).
  await db.query("update crm_import_jobs set status = 'importing', started_at = now(), started_by = $2, claimed_at = null where id = $1", [id, actor.userId]);
  await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.import_started", targetType: "crm_import_job", targetId: id, result: "success" }, db);
}

export async function cancelImport(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "contacts.import");
  await crmWrite(actor, async (db) => {
    const src = await db.query<{ source: ImportSource }>("select source from crm_import_jobs where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    // A GoHighLevel step has its own rules (only the owner may stop a real import): cancelGhlStep in src/server/crm/ghl-migration.ts.
    if (src.rows[0]?.source === "ghl_api") throw new AppError("conflict", "Cancel GoHighLevel migration steps from the migration panel.");
    await cancelImportInTx(db, actor, id);
  });
}

/**
 * Cancels a job that hasn't finished. The caller has authorized the actor; inside the caller's transaction. A GoHighLevel step's copy of
 * the location's user list (kept only while reading) goes with it.
 */
export async function cancelImportInTx(db: Queryable, actor: CrmActor, id: string): Promise<void> {
  const res = await db.query(
    "update crm_import_jobs set status = 'cancelled', completed_at = now(), fetch_state = fetch_state - 'users' where id = $1 and org_id = $2 and status in ('uploaded', 'fetching', 'validating', 'validated', 'importing')",
    [id, actor.orgId],
  );
  if (!res.rowCount) throw new AppError("conflict", "This import can't be cancelled now.");
}

/**
 * A job (alias j) that still has something to undo: it is importing or undoing now, or it finished (or was cancelled) with records it created
 * or changed. A run that only skipped or held rows has nothing to undo and never blocks another undo.
 */
export const HAS_UNDO_SQL = `(j.status in ('importing', 'rolling_back') or (j.status in ('completed', 'cancelled') and exists (select 1 from crm_import_rows r where r.job_id = j.id and r.status in ('created', 'updated'))))`;

/** A run's start, for messages that name which run is meant ("the run from Oct 17, 2026, 4:05 PM"). */
function runDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: validTimeZone(timeZone) ? timeZone : "UTC" }).format(new Date(d));
}

/** Undoes a finished import: records it created are removed and fields it changed are restored, unless someone changed them since. */
export async function rollbackImport(actor: CrmActor, id: string, opts: { beforeGhlRollback?: (db: Queryable) => Promise<void> } = {}): Promise<void> {
  assertCan(actor, "contacts.import");
  await crmWrite(actor, async (db) => {
    if (opts.beforeGhlRollback) {
      const current = await db.query<{ source: ImportSource }>("select source from crm_import_jobs where id = $1 and org_id = $2", [id, actor.orgId]);
      if (current.rows[0]?.source === "ghl_api") await opts.beforeGhlRollback(db);
    }
    const job = (await db.query<{ source: ImportSource; entity: ImportEntity; created_at: Date }>("select source, entity, created_at from crm_import_jobs where id = $1 and org_id = $2 for update", [id, actor.orgId])).rows[0];
    if (job?.source === "ghl_api") {
      // Undoing a migration step moves records out of the record of truth, so it follows the provider permission (the owner, or a super
      // admin's write session), and runs in reverse order: a step whose records later steps point at waits for those steps to be undone.
      assertCan(actor, "crm.provider.manage", "Only the workspace owner can undo a GoHighLevel migration step.");
      if (isGhlMigrationEntity(job.entity)) {
        const when = (d: Date) => runDate(d, actor.timezone);
        // Runs of one step are undone newest first: a later run's changes sit on the records an earlier run made.
        const newer = await db.query<{ created_at: Date }>(
          `select j.created_at from crm_import_jobs j where j.org_id = $1 and j.source = 'ghl_api' and j.entity = $2 and j.id <> $3 and j.created_at > $4 and ${HAS_UNDO_SQL}
           order by j.created_at desc limit 1`,
          [actor.orgId, job.entity, id, job.created_at],
        );
        if (newer.rows[0]) throw new AppError("conflict", `Undo the newer ${GHL_ENTITY_LABELS[job.entity].many.toLowerCase()} run from ${when(newer.rows[0].created_at)} first: runs of a step are undone newest first.`);
        for (const dep of ghlDependentsOf(job.entity)) {
          const live = await db.query<{ created_at: Date }>(
            `select j.created_at from crm_import_jobs j where j.org_id = $1 and j.source = 'ghl_api' and j.entity = $2 and j.id <> $3 and ${HAS_UNDO_SQL}
             order by j.created_at desc limit 1`,
            [actor.orgId, dep, id],
          );
          if (live.rows[0]) throw new AppError("conflict", `Undo the ${GHL_ENTITY_LABELS[dep].many.toLowerCase()} step first (its run from ${when(live.rows[0].created_at)}): its records point at this step's records.`);
        }
      }
    } else {
      assertCan(actor, "contacts.delete", "Undoing an import needs the archive permission.");
    }
    const res = await db.query("update crm_import_jobs set status = 'rolling_back', claimed_at = null, rolled_back_by = $3 where id = $1 and org_id = $2 and status in ('completed', 'cancelled')", [id, actor.orgId, actor.userId]);
    if (!res.rowCount) throw new AppError("conflict", "Only a finished or cancelled import can be undone.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.import_rollback_started", targetType: "crm_import_job", targetId: id, result: "success", metadata: { source: job?.source ?? "csv" } }, db);
  });
}

// ---------------------------------------------------------------------------
// Processing: a few hundred rows per call, claimed so two workers never process one job at once
// ---------------------------------------------------------------------------

const CHUNK = 250;
const RUNNING_STATUSES = ["fetching", "validating", "importing", "rolling_back"];

/** Advances one job by a chunk. Safe to call from the browser (polling) and from the scheduler at the same time. */
export async function advanceImport(jobId: string): Promise<{ status: string; done: boolean }> {
  const claimed = await withSystem(async (db) => {
    // The claim time (to the millisecond, so it round-trips exactly) doubles as the lease a long GoHighLevel read checks before it writes.
    const { rows } = await db.query<JobRow>(
      `update crm_import_jobs set claimed_at = date_trunc('milliseconds', now()) where id = $1 and status in ('fetching', 'validating', 'importing', 'rolling_back')
         and (claimed_at is null or claimed_at < now() - interval '2 minutes')
         and (status <> 'fetching' or fetch_not_before is null or fetch_not_before <= now()) returning ${JOB_COLUMNS}`,
      [jobId],
    );
    return rows[0] ?? null;
  });
  const statusNow = async () => {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from crm_import_jobs where id = $1", [jobId]));
    return { status: rows[0]?.status ?? "missing", done: !RUNNING_STATUSES.includes(rows[0]?.status ?? "") };
  };
  if (!claimed) return statusNow();
  const org = await withSystem(async (db) => (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [claimed.org_id])).rows[0]);
  // The import is written as the person who started it, and an undo as the person who asked for it (the dry run as whoever created the job).
  const userId = claimed.status === "importing" ? claimed.started_by ?? claimed.created_by : claimed.status === "rolling_back" ? claimed.rolled_back_by ?? claimed.created_by : claimed.created_by;
  const actor: CrmActor = { ...systemActor(org, "Import"), userId };
  // A GoHighLevel read can take a while: it renews its lease as it goes, and a worker that lost the lease writes nothing more.
  const lease = claimed.status === "fetching" && claimed.claimed_at ? { at: new Date(claimed.claimed_at) } : null;
  const stillMine = (n: number) => (lease ? ` and claimed_at = $${n}` : "");
  try {
    if (claimed.status === "fetching") {
      // Reading GoHighLevel (GET only) happens outside any database transaction; see src/server/crm/ghl-migration.ts.
      const { fetchGhlChunk } = await import("@/server/crm/ghl-migration");
      await fetchGhlChunk(claimed.id, lease ?? undefined);
    } else if (claimed.status === "validating") await validateChunk(actor, claimed);
    else if (claimed.status === "importing") await importChunk(actor, claimed);
    else await rollbackChunk(actor, claimed);
  } catch (err) {
    if (err instanceof ImportLeaseLost) return statusNow();
    const message = err instanceof AppError ? err.message.slice(0, 500) : "The import stopped unexpectedly. Nothing after the last finished row was changed.";
    // Only a job that is still running fails (a step cancelled meanwhile stays cancelled). The location's user list, kept only while a
    // GoHighLevel step reads, goes with it.
    await withSystem((db) =>
      db.query(
        `update crm_import_jobs set status = 'failed', error = $2, claimed_at = null, fetch_state = fetch_state - 'users'
          where id = $1 and status in ('fetching', 'validating', 'importing', 'rolling_back')${stillMine(3)}`,
        lease ? [jobId, message, lease.at] : [jobId, message],
      ),
    );
    return statusNow();
  }
  const { rows } = await withSystem((db) => db.query<{ status: string }>(`update crm_import_jobs set claimed_at = null where id = $1${stillMine(2)} returning status`, lease ? [jobId, lease.at] : [jobId]));
  if (!rows[0]) return statusNow();
  return { status: rows[0].status, done: !RUNNING_STATUSES.includes(rows[0].status) };
}

/** Thrown by a GoHighLevel read that found another worker holds its job now: it stops without writing anything. */
export class ImportLeaseLost extends Error {
  constructor() {
    super("Another worker took over this import step.");
    this.name = "ImportLeaseLost";
  }
}

/** For the browser's progress polling: only the job's own workspace can push it forward. */
export async function advanceImportFor(actor: CrmActor, jobId: string) {
  assertCan(actor, "contacts.import");
  const owns = await crmRead(actor, async (db) => (await db.query("select 1 from crm_import_jobs where id = $1 and org_id = $2", [jobId, actor.orgId])).rows.length > 0);
  if (!owns) throw new AppError("not_found", "Import not found.");
  return advanceImport(jobId);
}

/** Scheduler entry point: moves every running import forward a little (a GoHighLevel step waiting out a rate limit is left alone). */
export async function processImports(maxJobs = 5): Promise<{ advanced: number }> {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      `select id from crm_import_jobs where status in ('fetching', 'validating', 'importing', 'rolling_back')
         and (status <> 'fetching' or fetch_not_before is null or fetch_not_before <= now()) order by created_at limit $1`,
      [maxJobs],
    ),
  );
  for (const r of rows) await advanceImport(r.id);
  return { advanced: rows.length };
}

interface RowPlan {
  input: ContactInput;
  companyName: string | null;
  /** A company already in the workspace (a GoHighLevel business migrated earlier). */
  companyId: string | null;
  jobTitle: string | null;
  ownerEmail: string | null;
  tags: string[];
  externalId: string | null;
  note: string | null;
  fields: Record<string, unknown>;
}

type RowData = Record<string, unknown>;
type ImportRow = { row_number: number; data: RowData; status: string; planned_action: string | null; match_id: string | null; entity_id: string | null; result: Record<string, unknown>; flags: string[] };
type PlannedAction = "create" | "update" | "skip" | "review";

const ROW_COLUMNS = "row_number, data, status, planned_action, match_id, entity_id, result, flags";

function pick(data: RowData, mapping: Record<string, string>, target: string): string | null {
  for (const [header, t] of Object.entries(mapping)) {
    if (t !== target) continue;
    const v = data[header];
    return typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null;
  }
  return null;
}

function splitList(v: string | null): string[] {
  return (v ?? "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
}

/** A list target: a CSV cell is split on ; , or |; a GoHighLevel list (tags, extra emails) arrives as a list and is kept whole. */
function pickList(data: RowData, mapping: Record<string, string>, target: string): string[] {
  for (const [header, t] of Object.entries(mapping)) {
    if (t !== target) continue;
    const v = data[header];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
    return splitList(typeof v === "string" ? v : null);
  }
  return [];
}

function enumValue<T extends string>(raw: string | null, values: readonly T[], labels: Record<T, string> | null, what: string, errors: string[]): T | undefined {
  if (!raw) return undefined;
  const n = norm(raw);
  const hit = values.find((v) => v === n.replace(/ /g, "_") || (labels && norm(labels[v]) === n));
  if (!hit) errors.push(`"${raw.slice(0, 40)}" isn't a valid ${what}.`);
  return hit;
}

/** Turns one row into a contact plan, collecting every problem rather than stopping at the first. */
function planContact(data: RowData, mapping: Record<string, string>, callingCode: string | null, fieldDefs: Awaited<ReturnType<typeof loadFieldDefinitions>>): { plan: RowPlan; errors: string[] } {
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
    emails: pickList(data, mapping, "email_2"), phones: pickList(data, mapping, "phone_2"),
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
    if (!t.startsWith("cf:") || data[header] === undefined || data[header] === null || data[header] === "") continue;
    const def = fieldDefs.find((f) => f.key === t.slice(3));
    if (!def) continue;
    const res = coerceFieldValue(def, data[header], { defaultCallingCode: callingCode });
    if (!res.ok) errors.push(res.error);
    else fields[def.key] = data[header];
  }
  return {
    plan: {
      input, companyName: p("company"), companyId: p("company_id"), jobTitle: p("job_title"), ownerEmail: p("owner_email")?.toLowerCase() ?? null, tags: pickList(data, mapping, "tags"),
      externalId: p("external_id"), note: p("note"), fields,
    },
    errors,
  };
}

type Ctx = Awaited<ReturnType<typeof jobContext>>;

async function jobContext(db: Queryable, actor: CrmActor, job: JobRow) {
  const code = (await db.query<{ c: string | null }>("select default_calling_code as c from crm_workspaces where org_id = $1", [actor.orgId])).rows[0]?.c ?? null;
  const fieldEntity = job.entity === "contact" || job.entity === "company" || job.entity === "opportunity" ? job.entity : null;
  const fieldDefs = fieldEntity ? await loadFieldDefinitions(db, actor.orgId, fieldEntity) : [];
  const members = await db.query<{ user_id: string; email: string }>(
    "select m.user_id, u.email::text as email from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.status = 'active' and u.status = 'active'",
    [actor.orgId],
  );
  // GoHighLevel custom field id → the native field it became (from the custom fields step).
  const ghlFields = new Map<string, string>();
  if (job.source === "ghl_api" && fieldEntity) {
    const { rows } = await db.query<{ external_id: string; key: string }>(
      `select e.external_id, f.key from crm_external_ids e join crm_custom_fields f on f.id = e.native_id and f.org_id = e.org_id
       where e.org_id = $1 and e.provider = 'ghl' and e.entity = 'custom_field' and f.entity = $2 and f.archived_at is null`,
      [actor.orgId, fieldEntity],
    );
    for (const r of rows) ghlFields.set(r.external_id, r.key);
  }
  // A contact import may make a company by name only while iAcquire owns companies (in a capability-by-capability cutover GoHighLevel can
  // still own them). Otherwise the contact comes across without that company link, and says so.
  const companiesNative = job.entity === "contact" ? await nativeOwns(db, actor.orgId, "companies") : true;
  return { code, fieldDefs, members: new Map(members.rows.map((m) => [m.email.toLowerCase(), m.user_id])), ghlFields, companies: new Map<string, string>(), companiesNative };
}

/** assertNativeOwner as a yes/no answer. */
async function nativeOwns(db: Queryable, orgId: string, capability: CrmCapability): Promise<boolean> {
  try {
    await assertNativeOwner(db, orgId, capability);
    return true;
  } catch (err) {
    if (err instanceof AppError && err.code === "conflict") return false;
    throw err;
  }
}

/** GoHighLevel business ids in these rows → the native companies they became (from the companies step). */
async function loadGhlCompanies(db: Queryable, orgId: string, rows: Array<{ data: RowData }>, ctx: Ctx) {
  const ids = [...new Set(rows.map((r) => r.data.ghl_business_id).filter((v): v is string => typeof v === "string" && !!v && !ctx.companies.has(v)))];
  if (!ids.length) return;
  const { rows: found } = await db.query<{ external_id: string; native_id: string }>(
    `select e.external_id, e.native_id from crm_external_ids e join crm_companies c on c.id = e.native_id and c.org_id = e.org_id and c.deleted_at is null
     where e.org_id = $1 and e.provider = 'ghl' and e.entity = 'company' and e.external_id = any($2::text[])`,
    [orgId, ids],
  );
  for (const f of found) ctx.companies.set(f.external_id, f.native_id);
}

// ---------------------------------------------------------------------------
// GoHighLevel rows → the import's targets. A value iAcquire can't store is left out and noted (flags), instead of losing the record.
// ---------------------------------------------------------------------------

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** A GoHighLevel custom field value in the shape the native field takes (dates arrive as epoch or ISO strings). Null: nothing to store. */
function ghlFieldValue(type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null;
  if (type === "date") {
    const s = text(value);
    if (/^\d{10,13}$/.test(s)) {
      const n = Number(s);
      const d = new Date(s.length <= 10 ? n * 1000 : n);
      return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
    }
    return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
  }
  if (type === "multiselect") return Array.isArray(value) ? value.map((v) => text(v)).filter(Boolean) : text(value);
  if (type === "boolean") return typeof value === "boolean" ? value : text(value);
  if (Array.isArray(value)) return value.map((v) => text(v)).filter(Boolean).join(", ");
  if (typeof value === "object") return null;
  return typeof value === "number" ? value : text(value);
}

/** Custom field values keyed by GoHighLevel field id → cf: targets for the fields the custom fields step created or linked. */
function ghlCustomFields(raw: unknown, ctx: Ctx, data: RowData, mapping: Record<string, string>, flags: string[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  let unmapped = false;
  let dropped = false;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = ctx.ghlFields.get(id);
    const def = key ? ctx.fieldDefs.find((f) => f.key === key) : undefined;
    if (!def) {
      if (value !== null && value !== undefined && value !== "") unmapped = true;
      continue;
    }
    const v = ghlFieldValue(def.type, value);
    if (v === null) continue;
    if (!coerceFieldValue(def, v, { defaultCallingCode: ctx.code }).ok) {
      dropped = true;
      continue;
    }
    data[`cf:${def.key}`] = v;
    mapping[`cf:${def.key}`] = `cf:${def.key}`;
  }
  if (unmapped) flags.push("field_unmapped");
  if (dropped) flags.push("field_value_dropped");
}

const GHL_CONTACT_KEYS = ["name", "first_name", "last_name", "email", "phone", "email_2", "phone_2", "address_line1", "city", "region", "postal_code", "country", "timezone", "source", "owner_email", "tags"] as const;
const GHL_COMPANY_KEYS = ["name", "website", "phone", "email", "address_line1", "city", "region", "postal_code", "country", "description"] as const;

/** A row as the import's targets see it. CSV rows are used as they are; GoHighLevel rows are mapped by fixed rules. */
function rowView(job: JobRow, data: RowData, ctx: Ctx): { data: RowData; mapping: Record<string, string>; flags: string[] } {
  if (job.source !== "ghl_api") return { data, mapping: job.mapping, flags: [] };
  const flags: string[] = [];
  const out: RowData = {};
  const mapping: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return;
    out[k] = v;
    mapping[k] = k;
  };
  const drop = (k: string, flag: string) => {
    delete out[k];
    delete mapping[k];
    flags.push(flag);
  };
  put("external_id", data.ghl_id);
  if (job.entity === "company") {
    for (const k of GHL_COMPANY_KEYS) put(k, data[k]);
    if (out.website) {
      try {
        const u = new URL(/^https?:\/\//i.test(text(out.website)) ? text(out.website) : `https://${text(out.website)}`);
        if (!u.hostname.includes(".")) throw new Error("bad");
      } catch {
        drop("website", "website_dropped");
      }
    }
  } else {
    for (const k of GHL_CONTACT_KEYS) put(k, data[k]);
    for (const k of ["email_2", "phone_2"] as const) {
      if (!Array.isArray(out[k])) continue;
      const list = (out[k] as unknown[]).map(text).filter(Boolean);
      const ok = list.filter((v) => (k === "email_2" ? normalizeEmail(v) : normalizePhone(v, ctx.code ?? undefined)));
      if (ok.length < list.length) flags.push(k === "email_2" ? "email_dropped" : "phone_dropped");
      if (ok.length) out[k] = ok;
      else {
        delete out[k];
        delete mapping[k];
      }
    }
    if (out.timezone && !validTimeZone(text(out.timezone))) drop("timezone", "timezone_dropped");
    const businessId = typeof data.ghl_business_id === "string" ? data.ghl_business_id : "";
    const business = businessId ? ctx.companies.get(businessId) : undefined;
    if (business) put("company_id", business);
    else if (data.company) {
      put("company", data.company);
      flags.push("company_by_name");
    } else if (businessId) {
      // Its GoHighLevel business wasn't migrated (the companies step is optional, or that business failed or is held): no company link.
      flags.push("company_unmapped");
    }
    if (!out.owner_email && data.ghl_owner_id) flags.push("owner_unmapped");
    // GoHighLevel's list didn't carry the name or phone and the full record couldn't be read (GET /contacts/{id} said not found).
    if (data.ghl_detail === "not_found") flags.push("detail_unavailable");
    ghlCustomFields(data.custom_fields, ctx, out, mapping, flags);
  }
  if (out.email && !normalizeEmail(text(out.email))) drop("email", "email_dropped");
  if (out.phone && !normalizePhone(text(out.phone), ctx.code ?? undefined)) drop("phone", "phone_dropped");
  // A contact that comes across with neither a name nor a phone says so (the comparison counts it), rather than looking complete.
  if (job.entity === "contact" && !out.name && !out.first_name && !out.last_name && !out.phone) flags.push("name_phone_missing");
  if (out.country) {
    const c = countryCode(text(out.country));
    if (c) out.country = c;
    else drop("country", "country_dropped");
  }
  if (typeof out.name === "string" && out.name.length > 200) {
    out.name = out.name.slice(0, 200);
    flags.push("name_truncated");
  }
  return { data: out, mapping, flags };
}

async function setRow(db: Queryable, jobId: string, rowNumber: number, o: { status: "valid" | "invalid" | "duplicate"; planned?: PlannedAction | null; matchId?: string | null; errors?: string[]; flags?: string[] }) {
  await db.query("update crm_import_rows set status = $3, planned_action = $4, match_id = $5, errors = $6, flags = $7 where job_id = $1 and row_number = $2", [
    jobId, rowNumber, o.status, o.planned ?? null, o.matchId ?? null, JSON.stringify((o.errors ?? []).map((e) => e.slice(0, 300)).slice(0, 10)), [...new Set(o.flags ?? [])].slice(0, 20),
  ]);
}

async function flagCounts(db: Queryable, jobId: string): Promise<Record<string, number> | undefined> {
  const { rows } = await db.query<{ f: string; n: string }>("select f, count(*)::text as n from crm_import_rows r, unnest(r.flags) f where r.job_id = $1 group by f order by f", [jobId]);
  return rows.length ? Object.fromEntries(rows.map((r) => [r.f, Number(r.n)])) : undefined;
}

/** The native record a GoHighLevel id already became, if it still exists. */
async function externalMatches(db: Queryable, orgId: string, provider: string, entity: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<{ external_id: string; native_id: string }>(
    "select external_id, native_id from crm_external_ids where org_id = $1 and provider = $2 and entity = $3 and external_id = any($4::text[])",
    [orgId, provider, entity, ids],
  );
  return new Map(rows.map((r) => [r.external_id, r.native_id]));
}

/**
 * Records which native record an external id became. "inserted": this call made the link (so undoing this run removes it); "existing": an
 * earlier run already made exactly this link (undoing this run leaves it to that run); "conflict": the id (or the native record) is
 * already linked to something else.
 */
async function linkExternal(db: Queryable, orgId: string, provider: string, entity: string, externalId: string, nativeId: string): Promise<"inserted" | "existing" | "conflict"> {
  const ins = await db.query("insert into crm_external_ids (org_id, provider, entity, external_id, native_id) values ($1, $2, $3, $4, $5) on conflict do nothing returning native_id", [orgId, provider, entity, externalId, nativeId]);
  if (ins.rows.length) return "inserted";
  const cur = await db.query<{ native_id: string }>("select native_id from crm_external_ids where org_id = $1 and provider = $2 and entity = $3 and external_id = $4", [orgId, provider, entity, externalId]);
  if (cur.rows[0]?.native_id === nativeId) {
    await db.query("update crm_external_ids set synced_at = now() where org_id = $1 and provider = $2 and entity = $3 and external_id = $4", [orgId, provider, entity, externalId]);
    return "existing";
  }
  return "conflict";
}

/** A live company with this name (case-insensitive), oldest first. */
async function companyByName(db: Queryable, orgId: string, name: string): Promise<string | null> {
  return (await db.query<{ id: string }>("select id from crm_companies where org_id = $1 and lower(name) = lower($2) and deleted_at is null order by created_at limit 1", [orgId, name])).rows[0]?.id ?? null;
}

/** A GoHighLevel timestamp that is a real moment in the past (records keep when they were really created; anything else is ignored). */
function pastDate(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const t = /^\d{10,13}$/.test(s) ? Number(s.length <= 10 ? Number(s) * 1000 : Number(s)) : Date.parse(s);
  return Number.isFinite(t) && t >= Date.UTC(2000, 0, 1) && t <= Date.now() ? new Date(t) : null;
}

async function validateChunk(actor: CrmActor, job: JobRow) {
  await withSystem(async (db) => {
    const ctx = await jobContext(db, actor, job);
    const { rows } = await db.query<ImportRow>(`select ${ROW_COLUMNS} from crm_import_rows where job_id = $1 and status = 'pending' order by row_number limit $2`, [job.id, CHUNK * 4]);
    if (!rows.length) {
      // Everything is checked: summarize the dry run.
      const s = await db.query<{ status: string; planned_action: string | null; n: string }>("select status, planned_action, count(*)::text as n from crm_import_rows where job_id = $1 group by 1, 2", [job.id]);
      const count = (pred: (r: { status: string; planned_action: string | null }) => boolean) => s.rows.filter(pred).reduce((acc, r) => acc + Number(r.n), 0);
      const summary: ImportSummary = {
        validated: count(() => true), valid: count((r) => r.status === "valid"), invalid: count((r) => r.status === "invalid"), duplicateInFile: count((r) => r.status === "duplicate"),
        create: count((r) => r.planned_action === "create"), update: count((r) => r.planned_action === "update"), skip: count((r) => r.planned_action === "skip"), review: count((r) => r.planned_action === "review"),
      };
      const flags = job.source === "ghl_api" ? await flagCounts(db, job.id) : undefined;
      if (flags) summary.flags = flags;
      await db.query("update crm_import_jobs set status = 'validated', validated_at = now(), summary = $2 where id = $1", [job.id, JSON.stringify(summary)]);
      return;
    }
    if (job.entity === "contact") return validateContactRows(db, actor, job, rows, ctx);
    if (job.entity === "company") return validateCompanyRows(db, actor, job, rows, ctx);
    if (job.entity === "opportunity") return validateOpportunityRows(db, actor, job, rows, ctx);
    return validateConfigRows(db, actor, job, rows);
  });
}

async function validateCompanyRows(db: Queryable, actor: CrmActor, job: JobRow, rows: ImportRow[], ctx: Ctx) {
  const provider = providerOf(job);
  const view = (d: RowData) => rowView(job, d, ctx);
  const earlier = await db.query<{ row_number: number; data: RowData }>("select row_number, data from crm_import_rows where job_id = $1 and status <> 'pending' and status <> 'invalid'", [job.id]);
  const seen = new Map<string, number>();
  for (const e of earlier.rows) {
    const v = view(e.data);
    const d = normalizeDomain(pick(v.data, v.mapping, "domain") ?? pick(v.data, v.mapping, "website"));
    if (d) seen.set(`d:${d}`, e.row_number);
  }
  const policy = job.options?.duplicates ?? "skip";
  const ext = await externalMatches(db, actor.orgId, provider, "company", rows.map((r) => pick(view(r.data).data, view(r.data).mapping, "external_id")).filter((v): v is string => !!v));
  const liveCompanies = new Set(
    ext.size ? (await db.query<{ id: string }>("select id from crm_companies where org_id = $1 and id = any($2::uuid[]) and deleted_at is null", [actor.orgId, [...ext.values()]])).rows.map((r) => r.id) : [],
  );
  for (const r of rows) {
    const v = view(r.data);
    const name = pick(v.data, v.mapping, "name");
    const domainRaw = pick(v.data, v.mapping, "domain") ?? pick(v.data, v.mapping, "website");
    const domain = domainRaw ? normalizeDomain(domainRaw) : null;
    const errors: string[] = [];
    if (!name) errors.push("The row has no company name.");
    if (pick(v.data, v.mapping, "domain") && !domain) errors.push("That domain doesn't look right.");
    if (errors.length) {
      await setRow(db, job.id, r.row_number, { status: "invalid", errors, flags: [...r.flags, ...v.flags] });
      continue;
    }
    const externalId = pick(v.data, v.mapping, "external_id");
    const mapped = externalId ? ext.get(externalId) : undefined;
    // Already migrated (the same external id became this company): a re-run never makes a second one.
    if (mapped && liveCompanies.has(mapped)) {
      await setRow(db, job.id, r.row_number, { status: "valid", planned: policy === "update" ? "update" : "skip", matchId: mapped, flags: [...r.flags, ...v.flags] });
      if (domain) seen.set(`d:${domain}`, r.row_number);
      continue;
    }
    if (domain && seen.has(`d:${domain}`)) {
      await setRow(db, job.id, r.row_number, { status: "duplicate", planned: "skip", errors: [`Same domain as row ${seen.get(`d:${domain}`)}.`], flags: [...r.flags, ...v.flags] });
      continue;
    }
    if (domain) seen.set(`d:${domain}`, r.row_number);
    const existing = domain ? (await db.query<{ id: string }>("select id from crm_companies where org_id = $1 and domain = $2 and deleted_at is null", [actor.orgId, domain])).rows[0] : null;
    const action: PlannedAction = existing ? (policy === "update" ? "update" : policy === "review" ? "review" : "skip") : "create";
    await setRow(db, job.id, r.row_number, { status: "valid", planned: action, matchId: existing?.id ?? null, flags: [...r.flags, ...v.flags] });
  }
}

async function validateContactRows(db: Queryable, actor: CrmActor, job: JobRow, rows: ImportRow[], ctx: Ctx) {
  const ghl = job.source === "ghl_api";
  const provider = providerOf(job);
  if (ghl) await loadGhlCompanies(db, actor.orgId, rows, ctx);
  // Addresses already seen earlier in this file, so the second copy of a person is flagged instead of imported twice.
  const earlier = await db.query<{ row_number: number; data: RowData }>("select row_number, data from crm_import_rows where job_id = $1 and status <> 'pending' and status <> 'invalid'", [job.id]);
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
    const v = rowView(job, e.data, ctx);
    for (const k of keysOf(planContact(v.data, v.mapping, ctx.code, ctx.fieldDefs).plan)) if (!seen.has(k)) seen.set(k, e.row_number);
  }
  const policy = job.options?.duplicates ?? "skip";
  for (const r of rows) {
    const v = rowView(job, r.data, ctx);
    let flags = [...r.flags, ...v.flags];
    const { plan, errors } = planContact(v.data, v.mapping, ctx.code, ctx.fieldDefs);
    if (!ctx.companiesNative && plan.companyName && !plan.companyId && !(await companyByName(db, actor.orgId, plan.companyName))) {
      // GoHighLevel still owns companies here, so the import can't make this one: the contact comes across without it (forecast here).
      flags = [...flags.filter((f) => f !== "company_by_name"), "company_not_linked"];
    }
    if (plan.ownerEmail && !ctx.members.has(plan.ownerEmail)) {
      // A GoHighLevel owner who isn't a member here: the contact still comes across, unassigned, and the gap report says so.
      if (ghl) flags.push("owner_unmapped");
      else errors.push(`${plan.ownerEmail} isn't a member of this workspace.`);
    }
    if (errors.length) {
      await setRow(db, job.id, r.row_number, { status: "invalid", errors, flags });
      continue;
    }
    const keys = keysOf(plan);
    let matchId: string | null = null;
    if (plan.externalId) {
      const ext = await db.query<{ native_id: string }>(
        "select e.native_id from crm_external_ids e join contacts c on c.id = e.native_id and c.org_id = e.org_id and c.deleted_at is null where e.org_id = $1 and e.provider = $2 and e.entity = 'contact' and e.external_id = $3",
        [actor.orgId, provider, plan.externalId],
      );
      matchId = ext.rows[0]?.native_id ?? null;
    }
    const dupOf = keys.map((k) => seen.get(k)).find((x) => x !== undefined);
    if (dupOf !== undefined && !(ghl && matchId)) {
      if (ghl) {
        // Two GoHighLevel contacts share an email or phone. Both are real records there, so the second is held for a person, never dropped.
        await setRow(db, job.id, r.row_number, { status: "valid", planned: "review", errors: [`Same email or phone as row ${dupOf}; held so you can decide (merge or keep apart).`], flags: [...flags, "duplicate_in_source"] });
      } else {
        await setRow(db, job.id, r.row_number, { status: "duplicate", planned: "skip", errors: [`Same email or phone as row ${dupOf}; only the first is imported.`], flags });
      }
      continue;
    }
    for (const k of keys) if (!seen.has(k)) seen.set(k, r.row_number);
    if (!matchId) {
      const n = normalizeContactInput(plan.input, ctx.code);
      matchId = (await findByIdentities(db, actor.orgId, n.emails, n.phones))[0]?.contactId ?? null;
    }
    const action: PlannedAction = matchId ? (policy === "update" ? "update" : policy === "review" ? "review" : "skip") : "create";
    await setRow(db, job.id, r.row_number, { status: "valid", planned: action, matchId, flags });
  }
}

// --- Opportunities (GoHighLevel migration) ----------------------------------

const GHL_STATUSES = ["open", "won", "lost", "abandoned"];

/** The latest staged step of an entity: the dry run of a later step can point at records that step will create. */
async function latestGhlJob(db: Queryable, orgId: string, entity: ImportEntity): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    "select id from crm_import_jobs where org_id = $1 and source = 'ghl_api' and entity = $2 and status not in ('cancelled', 'failed', 'rolled_back') order by created_at desc limit 1",
    [orgId, entity],
  );
  return rows[0]?.id ?? null;
}

async function stagedRows(db: Queryable, jobId: string | null, ids: string[]): Promise<Map<string, RowData>> {
  if (!jobId || !ids.length) return new Map();
  const { rows } = await db.query<{ id: string; data: RowData }>(
    `select data->>'ghl_id' as id, data from crm_import_rows where job_id = $1 and data ? 'ghl_id' and data->>'ghl_id' = any($2::text[])
       and ((status = 'valid' and planned_action in ('create', 'update')) or status in ('created', 'updated'))`,
    [jobId, ids],
  );
  return new Map(rows.map((r) => [r.id, r.data]));
}

function opportunityPlan(data: RowData) {
  const flags: string[] = [];
  const errors: string[] = [];
  let name = text(data.name).replace(/\s+/g, " ");
  if (!name) name = text(data.contact_name) ? `${text(data.contact_name)}` : "Untitled opportunity";
  if (name.length > 200) {
    name = name.slice(0, 200);
    flags.push("name_truncated");
  }
  const rawValue = data.monetary_value;
  const value = rawValue === undefined || rawValue === null || rawValue === "" ? null : Number(rawValue);
  if (value !== null && (!Number.isFinite(value) || value < 0 || value >= 1e12)) errors.push("The deal value isn't a number of zero or more.");
  let status = text(data.status).toLowerCase() || "open";
  if (!GHL_STATUSES.includes(status)) {
    flags.push("status_unknown");
    status = "open";
  }
  if (status === "abandoned") flags.push("abandoned_as_lost");
  return { name, value, status, flags, errors };
}

async function validateOpportunityRows(db: Queryable, actor: CrmActor, job: JobRow, rows: ImportRow[], ctx: Ctx) {
  const ids = (k: string) => [...new Set(rows.map((r) => r.data[k]).filter((v): v is string => typeof v === "string" && !!v))];
  const pipelines = await externalMatches(db, actor.orgId, "ghl", "pipeline", ids("ghl_pipeline_id"));
  const stages = await externalMatches(db, actor.orgId, "ghl", "stage", ids("ghl_stage_id"));
  const contacts = await externalMatches(db, actor.orgId, "ghl", "contact", ids("ghl_contact_id"));
  const opps = await externalMatches(db, actor.orgId, "ghl", "opportunity", ids("ghl_id"));
  const livePipes = new Set(pipelines.size ? (await db.query<{ id: string }>("select id from crm_pipelines where org_id = $1 and id = any($2::uuid[]) and provider = 'native' and archived_at is null", [actor.orgId, [...pipelines.values()]])).rows.map((r) => r.id) : []);
  const liveContacts = new Set(contacts.size ? (await db.query<{ id: string }>("select id from contacts where org_id = $1 and id = any($2::uuid[]) and deleted_at is null", [actor.orgId, [...contacts.values()]])).rows.map((r) => r.id) : []);
  const liveOpps = new Set(opps.size ? (await db.query<{ id: string }>("select id from crm_opportunities where org_id = $1 and id = any($2::uuid[]) and archived_at is null", [actor.orgId, [...opps.values()]])).rows.map((r) => r.id) : []);
  // Forecast: records the earlier steps will create when they are imported (the dry run of this step can run before them).
  const stagedPipes = await stagedRows(db, await latestGhlJob(db, actor.orgId, "pipeline"), ids("ghl_pipeline_id").filter((id) => !pipelines.has(id)));
  const stagedContacts = await stagedRows(db, await latestGhlJob(db, actor.orgId, "contact"), ids("ghl_contact_id").filter((id) => !contacts.has(id)));
  for (const r of rows) {
    const d = r.data;
    const p = opportunityPlan(d);
    const flags = [...r.flags, ...p.flags];
    const errors = [...p.errors];
    const existing = opps.get(text(d.ghl_id));
    if (existing && liveOpps.has(existing)) {
      await setRow(db, job.id, r.row_number, { status: "valid", planned: "skip", matchId: existing, flags });
      continue;
    }
    const pipeId = text(d.ghl_pipeline_id);
    const stageId = text(d.ghl_stage_id);
    const nativePipe = pipelines.get(pipeId);
    const staged = stagedPipes.get(pipeId);
    if (!(nativePipe && livePipes.has(nativePipe)) && !staged) errors.push(`Its pipeline isn't part of the migration (GoHighLevel pipeline ${pipeId.slice(0, 40) || "missing"}).`);
    else if (!stages.has(stageId) && !(Array.isArray(staged?.stages) && (staged.stages as Array<{ id?: unknown }>).some((s) => s?.id === stageId))) errors.push(`Its stage isn't part of the migration (GoHighLevel stage ${stageId.slice(0, 40) || "missing"}).`);
    if (d.owner_email && !ctx.members.has(text(d.owner_email).toLowerCase())) flags.push("owner_unmapped");
    else if (!d.owner_email && d.ghl_owner_id) flags.push("owner_unmapped");
    if (errors.length) {
      await setRow(db, job.id, r.row_number, { status: "invalid", errors, flags });
      continue;
    }
    const contactId = text(d.ghl_contact_id);
    const nativeContact = contacts.get(contactId);
    if (contactId && !(nativeContact && liveContacts.has(nativeContact)) && !stagedContacts.has(contactId)) {
      // The deal's contact didn't come across (it failed, or is held for review): the deal waits for a person instead of losing its contact.
      await setRow(db, job.id, r.row_number, { status: "valid", planned: "review", errors: ["Its contact wasn't migrated. Resolve the contact first, then run this step again."], flags });
      continue;
    }
    const v: RowData = {};
    const m: Record<string, string> = {};
    ghlCustomFields(d.custom_fields, ctx, v, m, flags);
    await setRow(db, job.id, r.row_number, { status: "valid", planned: "create", flags });
  }
}

// --- Custom fields, tags, pipelines (GoHighLevel migration) -----------------

/** GoHighLevel field types (dataType) → native types. Null: iAcquire has no matching type, so the field is reported, not created. */
export function ghlFieldType(dataType: string, options: string[]): FieldType | null {
  switch (dataType.toUpperCase()) {
    case "TEXT": return "text";
    case "LARGE_TEXT": return "textarea";
    case "NUMERICAL": return "number";
    case "MONETORY": case "MONETARY": return "currency";
    case "PHONE": return "phone";
    case "EMAIL": return "email";
    case "DATE": return "date";
    case "SINGLE_OPTIONS": case "RADIO": return "select";
    case "MULTIPLE_OPTIONS": return "multiselect";
    case "CHECKBOX": return options.length ? "multiselect" : "boolean";
    default: return null; // FILE_UPLOAD, SIGNATURE, TEXTBOX_LIST and anything undocumented
  }
}

const COMPATIBLE: Record<FieldType, FieldType[]> = {
  text: ["text", "textarea", "email", "phone", "url"], textarea: ["textarea", "text"], number: ["number", "currency"], currency: ["currency", "number"], date: ["date"], datetime: ["datetime"],
  boolean: ["boolean"], select: ["select"], multiselect: ["multiselect"], email: ["email", "text"], phone: ["phone", "text"], url: ["url", "text"],
};

function ghlFieldKey(fieldKey: string, name: string): string {
  const bare = fieldKey.replace(/^(contact|opportunity)\./, "");
  return slugifyKey(bare || name).slice(0, 48);
}

const cleanName = (v: unknown, max: number) => text(v).replace(/\s+/g, " ").slice(0, max);

async function validateConfigRows(db: Queryable, actor: CrmActor, job: JobRow, rows: ImportRow[]) {
  const entity = job.entity as "custom_field" | "tag" | "pipeline";
  const ext = await externalMatches(db, actor.orgId, "ghl", entity, rows.map((r) => text(r.data.ghl_id)).filter(Boolean));
  const earlier = (await db.query<{ row_number: number; data: RowData }>("select row_number, data from crm_import_rows where job_id = $1 and status <> 'pending' and status <> 'invalid'", [job.id])).rows;
  for (const r of rows) {
    const d = r.data;
    const flags = [...r.flags];
    const mapped = ext.get(text(d.ghl_id));
    if (entity === "tag") {
      const name = cleanName(d.name, 60);
      if (!name) {
        await setRow(db, job.id, r.row_number, { status: "invalid", errors: ["The tag has no name."], flags });
        continue;
      }
      if (mapped && (await db.query("select 1 from crm_tags where id = $1 and org_id = $2", [mapped, actor.orgId])).rows.length) {
        await setRow(db, job.id, r.row_number, { status: "valid", planned: "skip", matchId: mapped, flags });
        earlier.push({ row_number: r.row_number, data: d });
        continue;
      }
      const twin = earlier.find((e) => cleanName(e.data.name, 60).toLowerCase() === name.toLowerCase());
      if (twin) {
        await setRow(db, job.id, r.row_number, { status: "duplicate", planned: "skip", errors: [`Same name as row ${twin.row_number} (tags are one per name here).`], flags });
        continue;
      }
      earlier.push({ row_number: r.row_number, data: d });
      const same = (await db.query<{ id: string }>("select id from crm_tags where org_id = $1 and name = $2::citext", [actor.orgId, name])).rows[0];
      await setRow(db, job.id, r.row_number, { status: "valid", planned: same ? "update" : "create", matchId: same?.id ?? null, flags });
      continue;
    }
    if (entity === "custom_field") {
      const model = text(d.model) || "contact";
      const name = cleanName(d.name, 80);
      if (model !== "contact" && model !== "opportunity") {
        await setRow(db, job.id, r.row_number, { status: "valid", planned: "skip", errors: [`Fields on ${model.slice(0, 40)} records aren't migrated (custom objects).`], flags: [...flags, "unsupported_object"] });
        continue;
      }
      const options = Array.isArray(d.options) ? d.options.map((o) => text(o)).filter(Boolean) : [];
      const type = ghlFieldType(text(d.data_type), options);
      if (!type) {
        await setRow(db, job.id, r.row_number, { status: "valid", planned: "skip", errors: [`${name || "This field"}: the GoHighLevel type ${text(d.data_type).slice(0, 40) || "(none)"} has no match in iAcquire, so it isn't created.`], flags: [...flags, "unsupported_type"] });
        continue;
      }
      if (!name) {
        await setRow(db, job.id, r.row_number, { status: "invalid", errors: ["The field has no name."], flags });
        continue;
      }
      if ((type === "select" || type === "multiselect") && !normalizeOptions(options).length) {
        await setRow(db, job.id, r.row_number, { status: "invalid", errors: [`${name}: a choice field with no choices.`], flags });
        continue;
      }
      if (mapped && (await db.query("select 1 from crm_custom_fields where id = $1 and org_id = $2", [mapped, actor.orgId])).rows.length) {
        await setRow(db, job.id, r.row_number, { status: "valid", planned: "skip", matchId: mapped, flags });
        continue;
      }
      const key = ghlFieldKey(text(d.field_key), name);
      const twin = earlier.find((e) => (text(e.data.model) || "contact") === model && ghlFieldKey(text(e.data.field_key), cleanName(e.data.name, 80)) === key);
      if (twin) {
        await setRow(db, job.id, r.row_number, { status: "duplicate", planned: "skip", errors: [`Same field key (${key}) as row ${twin.row_number}.`], flags });
        continue;
      }
      earlier.push({ row_number: r.row_number, data: d });
      const same = (await db.query<{ id: string; type: FieldType; archived_at: Date | null }>("select id, type, archived_at from crm_custom_fields where org_id = $1 and entity = $2 and key = $3", [actor.orgId, model, key])).rows[0];
      if (same) {
        const ok = !same.archived_at && COMPATIBLE[same.type]?.includes(type);
        await setRow(db, job.id, r.row_number, ok
          ? { status: "valid", planned: "update", matchId: same.id, flags }
          : { status: "valid", planned: "review", matchId: same.id, errors: [same.archived_at ? `A field with the key ${key} is archived here. Restore or rename it, then run this step again.` : `A field with the key ${key} already exists here as ${same.type}, which can't hold ${type} values.`], flags });
        continue;
      }
      await setRow(db, job.id, r.row_number, { status: "valid", planned: "create", flags });
      continue;
    }
    // Pipelines
    const name = cleanName(d.name, 200);
    const stages = Array.isArray(d.stages) ? (d.stages as Array<Record<string, unknown>>) : [];
    const errors: string[] = [];
    if (!name || name.length > 80) errors.push("Pipeline names are 1 to 80 characters here.");
    if (!stages.length || stages.length > 30) errors.push("A pipeline needs between 1 and 30 stages here.");
    const stageNames = stages.map((s) => cleanName(s.name, 200));
    if (stageNames.some((s) => !s || s.length > 60)) errors.push("Stage names are 1 to 60 characters here.");
    if (new Set(stageNames.map((s) => s.toLowerCase())).size !== stageNames.length) errors.push("Two stages have the same name.");
    if (stages.some((s) => !text(s.id))) errors.push("A stage has no GoHighLevel id.");
    if (errors.length) {
      await setRow(db, job.id, r.row_number, { status: "invalid", errors, flags });
      continue;
    }
    if (mapped && (await db.query("select 1 from crm_pipelines where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [mapped, actor.orgId])).rows.length) {
      const stageMap = await externalMatches(db, actor.orgId, "ghl", "stage", stages.map((s) => text(s.id)));
      const missing = stages.filter((s) => !stageMap.has(text(s.id))).length;
      await setRow(db, job.id, r.row_number, { status: "valid", planned: missing ? "update" : "skip", matchId: mapped, errors: missing ? [`${missing} new stage${missing === 1 ? "" : "s"} will be added.`] : [], flags });
      continue;
    }
    const same = (await db.query<{ id: string }>("select id from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null and lower(name) = lower($2)", [actor.orgId, name])).rows[0];
    if (same) {
      const open = new Set((await db.query<{ n: string }>("select lower(name) as n from crm_pipeline_stages where pipeline_id = $1 and kind = 'open' and archived_at is null", [same.id])).rows.map((x) => x.n));
      const fits = stageNames.every((s) => open.has(s.toLowerCase()));
      await setRow(db, job.id, r.row_number, fits
        ? { status: "valid", planned: "update", matchId: same.id, flags }
        : { status: "valid", planned: "review", matchId: same.id, errors: [`A pipeline called "${name}" already exists here with different stages. Rename one of them, then run this step again.`], flags });
      continue;
    }
    const active = Number((await db.query<{ n: string }>("select count(*)::text as n from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null", [actor.orgId])).rows[0].n);
    const planned = Number((await db.query<{ n: string }>("select count(*)::text as n from crm_import_rows where job_id = $1 and status = 'valid' and planned_action = 'create'", [job.id])).rows[0].n);
    if (active + planned >= 25) {
      await setRow(db, job.id, r.row_number, { status: "invalid", errors: ["A workspace can have up to 25 active pipelines."], flags });
      continue;
    }
    await setRow(db, job.id, r.row_number, { status: "valid", planned: "create", flags });
  }
}

async function importChunk(actor: CrmActor, job: JobRow) {
  await withSystem(async (db) => {
    const status = (await db.query<{ status: string }>("select status from crm_import_jobs where id = $1 for update", [job.id])).rows[0]?.status;
    if (status !== "importing") return;
    const ghl = job.source === "ghl_api";
    if (ghl) {
      // The import phase writes only while iAcquire owns the capability (a provider switch moves it first). If ownership moved back,
      // the step stops here: what was imported stays and can be undone.
      try {
        await assertNativeOwner(db, actor.orgId, IMPORT_CAPABILITY[job.entity]);
      } catch (err) {
        if (!(err instanceof AppError && err.code === "conflict")) throw err;
        await db.query("update crm_import_jobs set status = 'cancelled', completed_at = now(), error = $2, fetch_state = fetch_state - 'users' where id = $1", [job.id, "Stopped: GoHighLevel owns this part of the CRM again. Records already imported stay and can be undone."]);
        return;
      }
    }
    const ctx = await jobContext(db, actor, job);
    const { rows } = await db.query<ImportRow>(`select ${ROW_COLUMNS} from crm_import_rows where job_id = $1 and status = 'valid' order by row_number limit $2`, [job.id, CHUNK]);
    if (!rows.length) {
      const s = await db.query<{ status: string; n: string }>("select status, count(*)::text as n from crm_import_rows where job_id = $1 group by 1", [job.id]);
      const c = (st: string) => Number(s.rows.find((r) => r.status === st)?.n ?? 0);
      const summary: ImportSummary = { ...job.summary, created: c("created"), updated: c("updated"), skipped: c("skipped") + c("duplicate"), needsReview: c("needs_review"), failed: c("failed") + c("invalid") };
      if (ghl) {
        const flags = await flagCounts(db, job.id);
        if (flags) summary.flags = flags;
      }
      await db.query("update crm_import_jobs set status = 'completed', completed_at = now(), summary = $2 where id = $1", [job.id, JSON.stringify(summary)]);
      // The notice goes to whoever started the import (the worker writes as that person), and to whoever ran the dry run when that was
      // someone else, so they hear it finished too. The audit names the person who authorized the import.
      const what = ghl ? `GoHighLevel ${GHL_ENTITY_LABELS[job.entity as keyof typeof GHL_ENTITY_LABELS]?.many.toLowerCase() ?? "records"}` : "Import";
      for (const userId of [...new Set([actor.userId, job.created_by].filter((u): u is string => !!u))]) {
        await notifyUser(db, userId, actor.orgId, {
          kind: "crm_import_finished", severity: summary.failed ? "warning" : "success",
          title: `${what} finished: ${summary.created ?? 0} added, ${summary.updated ?? 0} ${ghl ? "matched" : "updated"}`,
          body: `${summary.skipped ?? 0} skipped, ${summary.needsReview ?? 0} need review, ${summary.failed ?? 0} could not be imported.`,
          link: `/crm/settings/data?import=${job.id}`, dedupeKey: `crm-import:${job.id}`,
        });
      }
      await recordAudit({ orgId: actor.orgId, actorUserId: actor.userId, actorKind: "system", action: "crm.import_completed", targetType: "crm_import_job", targetId: job.id, result: "success", metadata: { ...(summary as Record<string, unknown>), source: job.source, entity: job.entity, dryRunBy: job.created_by } }, db);
      return;
    }
    if (ghl && (job.entity === "contact" || job.entity === "company")) await loadGhlCompanies(db, actor.orgId, rows, ctx);
    const tagAllIds = job.options?.tagAll?.length ? await ensureTagsByName(db, actor, job.options.tagAll) : [];
    for (const r of rows) {
      await db.query("savepoint import_row");
      try {
        const mark = ghl ? Number((await db.query<{ m: string }>("select coalesce(max(id), 0)::text as m from crm_events")).rows[0].m) : 0;
        const outcome =
          job.entity === "company" ? await importCompanyRow(db, actor, job, r, ctx)
            : job.entity === "contact" ? await importContactRow(db, actor, job, r, ctx, tagAllIds)
              : job.entity === "opportunity" ? await importOpportunityRow(db, actor, job, r, ctx)
                : await importConfigRow(db, actor, job, r);
        if (ghl) await quietMigratedEvents(db, actor.orgId, mark);
        await db.query("update crm_import_rows set status = $3, entity_id = $4, result = $5, errors = $6, flags = $7, processed_at = now() where job_id = $1 and row_number = $2", [
          job.id, r.row_number, outcome.status, outcome.entityId, JSON.stringify(outcome.result), JSON.stringify(outcome.errors ?? []), [...new Set([...r.flags, ...(outcome.flags ?? [])])].slice(0, 20),
        ]);
        await db.query("release savepoint import_row");
      } catch (err) {
        await db.query("rollback to savepoint import_row");
        const message = err instanceof AppError ? err.message : "This row couldn't be imported.";
        await db.query("update crm_import_rows set status = 'failed', errors = $3, processed_at = now() where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify([message.slice(0, 300)])]);
      }
    }
  });
}

/**
 * A migrated record already happened in GoHighLevel: its workflows, notifications and webhooks ran there. The events the import wrote for it
 * are marked delivered with the reason, so the native dispatcher never starts workflows, routes or webhooks for history (both systems acting
 * on the same record is exactly what a migration must not cause). The events stay in the outbox and on the timeline.
 */
async function quietMigratedEvents(db: Queryable, orgId: string, afterId: number) {
  await db.query(
    `update crm_events set dispatched_at = now(), dispatch_error = 'Migrated from GoHighLevel: not dispatched (it already happened there).'
     where org_id = $1 and id > $2 and dispatched_at is null and actor_kind = 'system'
       and (payload->>'via' = 'ghl_migration' or payload->>'source' = 'ghl_migration')`,
    [orgId, afterId],
  );
}

type Outcome = { status: "created" | "updated" | "skipped" | "needs_review"; entityId: string | null; result: Record<string, unknown>; errors?: string[]; flags?: string[] };

const PATCHABLE: Array<[keyof ContactInput, string]> = [
  ["firstName", "first_name"], ["lastName", "last_name"], ["addressLine1", "address_line1"], ["addressLine2", "address_line2"], ["city", "city"], ["region", "region"],
  ["postalCode", "postal_code"], ["country", "country"], ["timezone", "timezone"], ["preferredLanguage", "preferred_language"], ["preferredChannel", "preferred_channel"],
  ["leadStatus", "lead_status"], ["leadScore", "lead_score"],
];

/** Sets an owner without the "assigned to you" notification (a migrated owner isn't news). Null when the person can't own records here. */
async function quietOwner(db: Queryable, orgId: string, table: "contacts" | "crm_opportunities", id: string, ownerId: string | null): Promise<boolean> {
  if (!ownerId) return false;
  try {
    await assertAssignable(db, orgId, ownerId);
  } catch {
    return false;
  }
  await db.query(`update ${table} set assigned_user_id = $3 where id = $1 and org_id = $2`, [id, orgId, ownerId]);
  return true;
}

/** Do not disturb in GoHighLevel stays an opt-out here: the contact's addresses are suppressed (an existing suppression is never changed). */
async function suppressDnd(db: Queryable, orgId: string, contactId: string, data: RowData): Promise<number> {
  if (data.dnd !== true && !(Array.isArray(data.dnd_channels) && data.dnd_channels.length)) return 0;
  const channels = data.dnd === true ? ["email", "sms", "whatsapp"] : (data.dnd_channels as unknown[]).map(String).filter((c) => ["email", "sms", "whatsapp"].includes(c));
  const ids = await db.query<{ kind: string; value: string }>("select kind, value from contact_identities where org_id = $1 and contact_id = $2", [orgId, contactId]);
  let n = 0;
  for (const ch of channels) {
    for (const i of ids.rows.filter((x) => x.kind === (ch === "email" ? "email" : "phone"))) {
      const res = await db.query("insert into suppressions (org_id, channel, address, reason, source) values ($1, $2, $3, 'manual', 'ghl_migration_dnd') on conflict (org_id, channel, address) do nothing", [orgId, ch, i.value]);
      n += res.rowCount ?? 0;
    }
  }
  return n;
}

async function importContactRow(db: Queryable, actor: CrmActor, job: JobRow, r: ImportRow, ctx: Ctx, tagAllIds: string[]): Promise<Outcome> {
  const ghl = job.source === "ghl_api";
  const provider = providerOf(job);
  const via = viaOf(job);
  const v = rowView(job, r.data, ctx);
  const { plan } = planContact(v.data, v.mapping, ctx.code, ctx.fieldDefs);
  const ownerId = plan.ownerEmail ? ctx.members.get(plan.ownerEmail) ?? null : null;
  const policy = job.options?.duplicates ?? "skip";
  if (r.planned_action === "skip") return { status: "skipped", entityId: r.match_id, result: {} };
  if (r.planned_action === "review") return { status: "needs_review", entityId: r.match_id, result: {}, errors: (await db.query<{ errors: string[] }>("select errors from crm_import_rows where job_id = $1 and row_number = $2", [job.id, r.row_number])).rows[0]?.errors ?? [] };
  const tagIds = [...tagAllIds, ...(plan.tags.length ? await ensureTagsByName(db, actor, plan.tags) : [])];
  let companyId: string | null = null;
  if (plan.companyId) {
    companyId = (await db.query<{ id: string }>("select id from crm_companies where id = $1 and org_id = $2 and deleted_at is null", [plan.companyId, actor.orgId])).rows[0]?.id ?? null;
  }
  let companyCreated: string | null = null;
  const flags: string[] = [];
  if (!companyId && plan.companyName) {
    companyId = await companyByName(db, actor.orgId, plan.companyName);
    if (!companyId && ctx.companiesNative) {
      const made = await createCompanyInTx(db, actor, { name: plan.companyName }, via);
      companyId = made.id;
      // A migration remembers the company it made by name, so undoing the contact can remove it too when nothing else uses it.
      if (ghl && made.created) companyCreated = made.id;
    } else if (!companyId) {
      // GoHighLevel still owns companies here: the person comes across without the company rather than not at all. Run the contacts step
      // again once companies move to iAcquire to link them.
      flags.push("company_not_linked");
    }
  }
  let target = r.planned_action === "create" ? null : r.match_id;
  if (!target) {
    try {
      // Migrated owners are set without notifying them (GoHighLevel already assigned the record); CSV imports keep notifying.
      const created = await createContactInTx(db, actor, { ...plan.input, ownerId: ghl ? null : ownerId, companyId, companyTitle: plan.jobTitle, customFields: plan.fields }, { via, onDuplicate: "error", tagSource: ghl ? "ghl_migration" : "import" });
      // The record keeps when it was really added in GoHighLevel, so reports don't count a whole history as new on migration day.
      // (Not a change to the record, so its version stays as the import left it.)
      const addedAt = ghl ? pastDate(r.data.date_added) : null;
      if (addedAt) await db.query("update contacts set created_at = $3 where id = $1 and org_id = $2", [created.id, actor.orgId, addedAt]);
      if (ghl && ownerId && !(await quietOwner(db, actor.orgId, "contacts", created.id, ownerId))) flags.push("owner_unmapped");
      if (tagIds.length) await applyContactTags(db, actor, [created.id], tagIds, ghl ? "ghl_migration" : "import");
      if (plan.externalId) {
        if (ghl) {
          if ((await linkExternal(db, actor.orgId, provider, "contact", plan.externalId, created.id)) === "conflict") throw new AppError("conflict", "This GoHighLevel contact was migrated by another run at the same time. Run this step again.");
        } else await db.query("insert into crm_external_ids (org_id, provider, entity, external_id, native_id) values ($1, 'csv', 'contact', $2, $3) on conflict do nothing", [actor.orgId, plan.externalId, created.id]);
      }
      if (plan.note) await addImportNote(db, actor, created.id, plan.note);
      const dnd = ghl ? await suppressDnd(db, actor.orgId, created.id, r.data) : 0;
      if (ghl && (r.data.dnd === true || (Array.isArray(r.data.dnd_channels) && r.data.dnd_channels.length))) flags.push("dnd");
      const ver = await db.query<{ version: number }>("select version from contacts where id = $1", [created.id]);
      return { status: "created", entityId: created.id, result: { tagsAdded: tagIds, version: ver.rows[0].version, ...(dnd ? { suppressed: dnd } : {}), ...(companyCreated ? { companyCreated } : {}) }, flags };
    } catch (err) {
      // Someone created this person after the dry run: follow the chosen rule for duplicates.
      if (!(err instanceof DuplicateContactError)) throw err;
      if (policy === "skip") return { status: "skipped", entityId: err.existingContactId, result: {} };
      if (policy === "review") return { status: "needs_review", entityId: err.existingContactId, result: {} };
      target = err.existingContactId;
    }
  }
  // A GoHighLevel contact is linked to the native record before anything is filled in: one native record never stands for two GoHighLevel ones.
  // Whether this run made the link decides whether undoing this run removes it (a re-run that matched an earlier run's link leaves it).
  const how = ghl && plan.externalId ? await linkExternal(db, actor.orgId, provider, "contact", plan.externalId, target!) : null;
  if (how === "conflict") {
    return { status: "needs_review", entityId: target, result: {}, errors: ["The matching contact here already stands for another GoHighLevel contact (same email or phone). Merge them in GoHighLevel or here, then run this step again."], flags: ["duplicate_in_source"] };
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
    // A migration only fills in what is empty here (and has no lead status to bring); a CSV update keeps its documented behaviour.
    if (ghl && (column === "lead_status" || (cur[column] !== null && cur[column] !== undefined && cur[column] !== ""))) continue;
    previous[column] = cur[column] ?? null;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (ownerId && cur.assigned_user_id !== ownerId && !(ghl && cur.assigned_user_id)) {
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
  // A migration never overwrites a value someone keeps here.
  const fieldValues = ghl ? Object.fromEntries(Object.entries(plan.fields).filter(([k]) => !fieldsBefore.some((f) => f.key === k))) : plan.fields;
  const changedFields = Object.keys(fieldValues).length ? await writeFieldValues(db, actor, "contact", target!, fieldValues, { defaultCallingCode: ctx.code }) : [];
  const added: string[] = [];
  if (tagIds.length) {
    const before = await db.query<{ tag_id: string }>("select tag_id from crm_contact_tags where contact_id = $1 and tag_id = any($2::uuid[])", [target, tagIds]);
    const had = new Set(before.rows.map((x) => x.tag_id));
    await applyContactTags(db, actor, [target!], tagIds, ghl ? "ghl_migration" : "import");
    for (const t of tagIds) if (!had.has(t)) added.push(t);
  }
  if (plan.externalId && !ghl) await db.query("insert into crm_external_ids (org_id, provider, entity, external_id, native_id) values ($1, 'csv', 'contact', $2, $3) on conflict do nothing", [actor.orgId, plan.externalId, target]);
  if (companyId) await db.query("insert into crm_contact_companies (org_id, contact_id, company_id, title, is_primary) values ($1, $2, $3, $4, not exists (select 1 from crm_contact_companies where contact_id = $2 and is_primary)) on conflict do nothing", [actor.orgId, target, companyId, plan.jobTitle]);
  if (plan.note) await addImportNote(db, actor, target!, plan.note);
  if (sets.length || changedFields.length) {
    await emitEvent(db, actor, { type: "contact.updated", entityType: "contact", entityId: target, contactId: target, payload: { changed: [...Object.keys(previous), ...changedFields.map((k) => `cf:${k}`)], via }, dedupeKey: `contact.updated:import:${job.id}:${r.row_number}` });
    await recordActivity(db, actor, { kind: "contact.updated", summary: ghl ? "Details filled in from GoHighLevel" : "Details updated by an import", contactId: target, refType: "import", refId: job.id });
  }
  const dnd = ghl ? await suppressDnd(db, actor.orgId, target!, r.data) : 0;
  if (ghl && (r.data.dnd === true || (Array.isArray(r.data.dnd_channels) && r.data.dnd_channels.length))) flags.push("dnd");
  const ver = await db.query<{ version: number }>("select version from contacts where id = $1", [target]);
  return { status: "updated", entityId: target, result: { previous, previousFields: fieldsBefore, changedFields, tagsAdded: added, version: ver.rows[0].version, linked: ghl, linkInserted: how === "inserted", ...(dnd ? { suppressed: dnd } : {}), ...(companyCreated ? { companyCreated } : {}) }, flags };
}

async function addImportNote(db: Queryable, actor: CrmActor, contactId: string, note: string) {
  await db.query("insert into record_notes (org_id, record_type, record_id, body, author_id) values ($1, 'contact', $2, $3, $4)", [actor.orgId, contactId, note.slice(0, 4000), actor.userId]);
}

async function importCompanyRow(db: Queryable, actor: CrmActor, job: JobRow, r: ImportRow, ctx: Ctx): Promise<Outcome> {
  const ghl = job.source === "ghl_api";
  if (r.planned_action === "skip") return { status: "skipped", entityId: r.match_id, result: {} };
  if (r.planned_action === "review") return { status: "needs_review", entityId: r.match_id, result: {} };
  const v = rowView(job, r.data, ctx);
  const p = (t: string) => pick(v.data, v.mapping, t);
  const fields: Record<string, unknown> = {};
  for (const [header, t] of Object.entries(v.mapping)) if (t.startsWith("cf:") && v.data[header]) fields[t.slice(3)] = v.data[header];
  const countryRaw = p("country");
  const input = {
    name: p("name")!, domain: p("domain"), website: p("website"), industry: p("industry"), phone: p("phone"), email: p("email"), addressLine1: p("address_line1"),
    city: p("city"), region: p("region"), postalCode: p("postal_code"), country: countryRaw ? countryCode(countryRaw) : null, description: ghl ? p("description") : null,
    ownerId: p("owner_email") ? ctx.members.get(p("owner_email")!.toLowerCase()) ?? null : null, customFields: fields,
  };
  if (r.planned_action === "update" && r.match_id) {
    // Whether this run made the link decides whether undoing this run removes it (a re-run that matched an earlier run's link leaves it).
    const how = ghl && p("external_id") ? await linkExternal(db, actor.orgId, "ghl", "company", p("external_id")!, r.match_id) : null;
    if (how === "conflict") {
      return { status: "needs_review", entityId: r.match_id, result: {}, errors: ["The matching company here already stands for another GoHighLevel business."] };
    }
    // Companies are only ever filled in, never overwritten, on import. Nothing to fill in: the company isn't touched (its version stays, so
    // undoing the run that created it still recognizes it as unchanged).
    await db.query(
      `update crm_companies set industry = coalesce(industry, $3), phone = coalesce(phone, $4), city = coalesce(city, $5), region = coalesce(region, $6), country = coalesce(country, $7), version = version + 1
       where id = $1 and org_id = $2 and ((industry is null and $3::text is not null) or (phone is null and $4::text is not null) or (city is null and $5::text is not null)
         or (region is null and $6::text is not null) or (country is null and $7::text is not null))`,
      [r.match_id, actor.orgId, input.industry, null, input.city, input.region, input.country],
    );
    return { status: "updated", entityId: r.match_id, result: { linked: ghl, linkInserted: how === "inserted" } };
  }
  const created = await createCompanyInTx(db, actor, input, viaOf(job), { onDuplicate: "return_existing" });
  const tags = pickList(v.data, v.mapping, "tags");
  if (tags.length) {
    const ids = await ensureTagsByName(db, actor, tags);
    await db.query("insert into crm_company_tags (org_id, company_id, tag_id) select $1, $2, t from unnest($3::uuid[]) t on conflict do nothing", [actor.orgId, created.id, ids]);
  }
  if (p("external_id")) {
    if (ghl) {
      if ((await linkExternal(db, actor.orgId, "ghl", "company", p("external_id")!, created.id)) === "conflict" && created.created) throw new AppError("conflict", "This GoHighLevel business was migrated by another run at the same time. Run this step again.");
    } else await db.query("insert into crm_external_ids (org_id, provider, entity, external_id, native_id) values ($1, 'csv', 'company', $2, $3) on conflict do nothing", [actor.orgId, p("external_id"), created.id]);
  }
  const ver = created.created ? (await db.query<{ version: number }>("select version from crm_companies where id = $1", [created.id])).rows[0]?.version : undefined;
  return { status: created.created ? "created" : "skipped", entityId: created.id, result: ver !== undefined ? { version: ver } : {} };
}

/** A GoHighLevel opportunity: its pipeline, stage and contact resolve through the external ids the earlier steps recorded. */
async function importOpportunityRow(db: Queryable, actor: CrmActor, job: JobRow, r: ImportRow, ctx: Ctx): Promise<Outcome> {
  const d = r.data;
  if (r.planned_action === "skip") return { status: "skipped", entityId: r.match_id, result: {} };
  if (r.planned_action === "review") return { status: "needs_review", entityId: null, result: {}, errors: (await db.query<{ errors: string[] }>("select errors from crm_import_rows where job_id = $1 and row_number = $2", [job.id, r.row_number])).rows[0]?.errors ?? [] };
  const one = async (entity: string, id: unknown) =>
    text(id) ? (await db.query<{ native_id: string }>("select native_id from crm_external_ids where org_id = $1 and provider = 'ghl' and entity = $2 and external_id = $3", [actor.orgId, entity, text(id)])).rows[0]?.native_id ?? null : null;
  const pipelineId = await one("pipeline", d.ghl_pipeline_id);
  const stageId = await one("stage", d.ghl_stage_id);
  if (!pipelineId || !stageId) throw new AppError("not_found", "Its pipeline or stage hasn't been migrated. Import the pipelines step, then run this step again.");
  const stage = (await db.query<{ pipeline_id: string; kind: string }>("select pipeline_id, kind from crm_pipeline_stages where id = $1 and org_id = $2 and archived_at is null", [stageId, actor.orgId])).rows[0];
  if (!stage || stage.pipeline_id !== pipelineId) throw new AppError("conflict", "Its stage no longer belongs to the migrated pipeline.");
  let contactId = await one("contact", d.ghl_contact_id);
  if (contactId && !(await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [contactId, actor.orgId])).rows.length) contactId = null;
  if (text(d.ghl_contact_id) && !contactId) return { status: "needs_review", entityId: null, result: {}, errors: ["Its contact wasn't migrated. Resolve the contact first, then run this step again."] };
  const plan = opportunityPlan(d);
  const flags = [...plan.flags];
  const v: RowData = {};
  const m: Record<string, string> = {};
  ghlCustomFields(d.custom_fields, ctx, v, m, flags);
  const customFields = Object.fromEntries(Object.entries(v).map(([k, val]) => [k.slice(3), val]));
  const created = await createOpportunityInTx(
    db,
    actor,
    { name: plan.name, pipelineId, stageId, contactId, value: plan.value, source: text(d.source).slice(0, 120) || "GoHighLevel", customFields },
    { via: "ghl_migration", idempotencyKey: `ghl:${text(d.ghl_id)}` },
  );
  if (!created.created) return { status: "skipped", entityId: created.id, result: {}, flags };
  // The deal keeps when it was really created in GoHighLevel (and when it entered its stage), so reports don't count a whole history as
  // new on migration day. Not a change to the record: its version is read after this, as the import left it.
  const addedAt = pastDate(d.created_at);
  const stageAt = pastDate(d.last_stage_change_at) ?? addedAt;
  if (addedAt || stageAt) {
    await db.query("update crm_opportunities set created_at = coalesce($3::timestamptz, created_at), stage_entered_at = coalesce($4::timestamptz, stage_entered_at) where id = $1 and org_id = $2", [created.id, actor.orgId, addedAt, stageAt]);
  }
  const ownerId = d.owner_email ? ctx.members.get(text(d.owner_email).toLowerCase()) ?? null : null;
  if (ownerId && !(await quietOwner(db, actor.orgId, "crm_opportunities", created.id, ownerId))) flags.push("owner_unmapped");
  // Won, lost and abandoned deals close where they are, at the time GoHighLevel recorded (an abandoned deal is lost here, and says so).
  if (plan.status !== "open") {
    const outcome = plan.status === "won" ? "won" : "lost";
    const closedAt = [d.last_status_change_at, d.updated_at].map(text).find((s) => s && !Number.isNaN(Date.parse(s))) ?? null;
    await db.query(
      "update crm_opportunities set status = $3, closed_at = coalesce($4::timestamptz, now()), lost_reason = $5 where id = $1 and org_id = $2",
      [created.id, actor.orgId, outcome, closedAt, outcome === "lost" ? (plan.status === "abandoned" ? "Abandoned in GoHighLevel" : "Lost in GoHighLevel") : null],
    );
    await db.query(
      "insert into crm_opportunity_history (org_id, opportunity_id, from_stage, to_stage, from_status, to_status, actor_kind) values ($1, $2, $3, $3, 'open', $4, 'system')",
      [actor.orgId, created.id, stageId, outcome],
    );
  }
  if ((await linkExternal(db, actor.orgId, "ghl", "opportunity", text(d.ghl_id), created.id)) === "conflict") throw new AppError("conflict", "This GoHighLevel opportunity was migrated by another run at the same time. Run this step again.");
  const ver = await db.query<{ version: number }>("select version from crm_opportunities where id = $1", [created.id]);
  return { status: "created", entityId: created.id, result: { version: ver.rows[0].version }, flags };
}

/** Custom fields, tags and pipelines: created, or linked to the matching record already here. Records exactly what to undo. */
async function importConfigRow(db: Queryable, actor: CrmActor, job: JobRow, r: ImportRow): Promise<Outcome> {
  const d = r.data;
  const ghlId = text(d.ghl_id);
  if (r.planned_action === "skip") return { status: "skipped", entityId: r.match_id, result: {} };
  if (r.planned_action === "review") return { status: "needs_review", entityId: r.match_id, result: {}, errors: (await db.query<{ errors: string[] }>("select errors from crm_import_rows where job_id = $1 and row_number = $2", [job.id, r.row_number])).rows[0]?.errors ?? [] };
  // "inserted" when this run made the link (undoing this run removes it), "existing" when an earlier run did (it stays with that run).
  const link = async (entity: string, externalId: string, nativeId: string) => {
    const how = await linkExternal(db, actor.orgId, "ghl", entity, externalId, nativeId);
    if (how === "conflict") throw new AppError("conflict", "This record here already stands for another GoHighLevel record.");
    return how;
  };
  if (job.entity === "tag") {
    const name = cleanName(d.name, 60);
    if (r.planned_action === "update" && r.match_id) {
      const how = await link("tag", ghlId, r.match_id);
      return { status: "updated", entityId: r.match_id, result: { linked: true, linkInserted: how === "inserted" } };
    }
    const color = TAG_COLORS[(name.length + name.charCodeAt(0)) % TAG_COLORS.length];
    const ins = await db.query<{ id: string; updated_at: Date }>("insert into crm_tags (org_id, name, color, created_by) values ($1, $2, $3, $4) on conflict (org_id, name) do nothing returning id, updated_at", [actor.orgId, name, color, actor.userId]);
    if (!ins.rows[0]) {
      const same = (await db.query<{ id: string }>("select id from crm_tags where org_id = $1 and name = $2::citext", [actor.orgId, name])).rows[0];
      const how = await link("tag", ghlId, same.id);
      return { status: "updated", entityId: same.id, result: { linked: true, linkInserted: how === "inserted" } };
    }
    await link("tag", ghlId, ins.rows[0].id);
    return { status: "created", entityId: ins.rows[0].id, result: { updatedAt: new Date(ins.rows[0].updated_at).toISOString() } };
  }
  if (job.entity === "custom_field") {
    const model = text(d.model) || "contact";
    const name = cleanName(d.name, 80);
    const options = Array.isArray(d.options) ? d.options.map((o) => text(o)).filter(Boolean) : [];
    const type = ghlFieldType(text(d.data_type), options)!;
    if (r.planned_action === "update" && r.match_id) {
      const how = await link("custom_field", ghlId, r.match_id);
      return { status: "updated", entityId: r.match_id, result: { linked: true, linkInserted: how === "inserted" } };
    }
    const key = ghlFieldKey(text(d.field_key), name);
    const opts = type === "select" || type === "multiselect" ? normalizeOptions(options) : [];
    const pos = await db.query<{ n: number }>("select coalesce(max(position), 0) + 1 as n from crm_custom_fields where org_id = $1 and entity = $2", [actor.orgId, model]);
    const ins = await db.query<{ id: string; updated_at: Date }>(
      `insert into crm_custom_fields (org_id, entity, key, label, type, options, required, help_text, position, created_by)
       values ($1, $2, $3, $4, $5, $6, false, $7, $8, $9) on conflict (org_id, entity, key) do nothing returning id, updated_at`,
      [actor.orgId, model, key, name, type, JSON.stringify(opts), text(d.placeholder).slice(0, 200) || null, pos.rows[0].n, actor.userId],
    );
    if (!ins.rows[0]) throw new AppError("conflict", `A field with the key ${key} was added here after the dry run. Run this step again.`);
    await link("custom_field", ghlId, ins.rows[0].id);
    await recordAudit({ orgId: actor.orgId, actorUserId: actor.userId, actorKind: "system", action: "crm.field_created", targetType: "crm_custom_field", targetId: ins.rows[0].id, result: "success", metadata: { entity: model, key, type, via: "ghl_migration" } }, db);
    return { status: "created", entityId: ins.rows[0].id, result: { updatedAt: new Date(ins.rows[0].updated_at).toISOString() } };
  }
  // Pipelines and stages. GoHighLevel stages have no won/lost kind (the deal's status says that), so every stage is an open stage.
  const stages = (Array.isArray(d.stages) ? (d.stages as Array<Record<string, unknown>>) : []).slice().sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  if (r.planned_action === "update" && r.match_id) {
    const pipelineId = r.match_id;
    const pipelineLink = await link("pipeline", ghlId, pipelineId);
    const current = await db.query<{ id: string; name: string; kind: string }>("select id, lower(name) as name, kind from crm_pipeline_stages where pipeline_id = $1 and org_id = $2 and archived_at is null", [pipelineId, actor.orgId]);
    const mapped = await externalMatches(db, actor.orgId, "ghl", "stage", stages.map((s) => text(s.id)));
    const linkedStages: string[] = [];
    const addedStages: string[] = [];
    let position = Number((await db.query<{ n: number }>("select coalesce(max(position), 0) as n from crm_pipeline_stages where pipeline_id = $1", [pipelineId])).rows[0].n);
    for (const s of stages) {
      const sid = text(s.id);
      if (mapped.has(sid)) continue;
      const same = current.rows.find((c) => c.name === cleanName(s.name, 60).toLowerCase() && c.kind === "open");
      if (same) {
        await link("stage", sid, same.id);
        linkedStages.push(sid);
        continue;
      }
      position++;
      const ins = await db.query<{ id: string }>("insert into crm_pipeline_stages (org_id, pipeline_id, name, position, kind) values ($1, $2, $3, $4, 'open') returning id", [actor.orgId, pipelineId, cleanName(s.name, 60), position]);
      await link("stage", sid, ins.rows[0].id);
      addedStages.push(ins.rows[0].id);
    }
    // linkedStages / addedStages are only this run's (stages an earlier run mapped are skipped above).
    return { status: "updated", entityId: pipelineId, result: { linked: true, pipelineLinkInserted: pipelineLink === "inserted", linkedStages, addedStages } };
  }
  const name = cleanName(d.name, 80);
  const count = Number((await db.query<{ n: string }>("select count(*)::text as n from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null", [actor.orgId])).rows[0].n);
  if (count >= 25) throw new AppError("invalid_input", "A workspace can have up to 25 active pipelines.");
  const pipe = await db.query<{ id: string; updated_at: Date }>(
    "insert into crm_pipelines (org_id, provider, name, is_default, position, created_by) values ($1, 'native', $2, $3, $4, $5) returning id, updated_at",
    [actor.orgId, name, count === 0, count + 1, actor.userId],
  );
  const pipelineId = pipe.rows[0].id;
  for (const [i, s] of stages.entries()) {
    const ins = await db.query<{ id: string }>("insert into crm_pipeline_stages (org_id, pipeline_id, name, position, kind) values ($1, $2, $3, $4, 'open') returning id", [actor.orgId, pipelineId, cleanName(s.name, 60), i + 1]);
    await link("stage", text(s.id), ins.rows[0].id);
  }
  await link("pipeline", ghlId, pipelineId);
  await recordAudit({ orgId: actor.orgId, actorUserId: actor.userId, actorKind: "system", action: "crm.pipeline_created", targetType: "crm_pipeline", targetId: pipelineId, result: "success", metadata: { via: "ghl_migration" } }, db);
  return { status: "created", entityId: pipelineId, result: { updatedAt: new Date(pipe.rows[0].updated_at).toISOString() } };
}

async function rollbackChunk(actor: CrmActor, job: JobRow) {
  await withSystem(async (db) => {
    const provider = providerOf(job);
    const { rows } = await db.query<ImportRow>(`select ${ROW_COLUMNS} from crm_import_rows where job_id = $1 and status in ('created', 'updated') order by row_number desc limit $2`, [job.id, CHUNK]);
    if (!rows.length) {
      const s = await db.query<{ status: string; n: string }>("select status, count(*)::text as n from crm_import_rows where job_id = $1 group by 1", [job.id]);
      const summary: ImportSummary = { ...job.summary, rolledBack: Number(s.rows.find((r) => r.status === "rolled_back")?.n ?? 0), keptChanged: Number(s.rows.find((r) => r.status === "needs_review")?.n ?? 0) };
      await db.query("update crm_import_jobs set status = 'rolled_back', rolled_back_at = now(), summary = $2 where id = $1", [job.id, JSON.stringify(summary)]);
      // Named as the person who asked for the undo (the worker runs as them).
      await recordAudit({ orgId: actor.orgId, actorUserId: actor.userId, actorKind: "system", action: "crm.import_rolled_back", targetType: "crm_import_job", targetId: job.id, result: "success", metadata: { ...(summary as Record<string, unknown>), source: job.source, entity: job.entity } }, db);
      return;
    }
    const keep = async (r: ImportRow, why: string) => db.query("update crm_import_rows set status = 'needs_review', errors = $3 where job_id = $1 and row_number = $2", [job.id, r.row_number, JSON.stringify([why])]);
    const done = async (r: ImportRow) => db.query("update crm_import_rows set status = 'rolled_back' where job_id = $1 and row_number = $2", [job.id, r.row_number]);
    for (const r of rows) {
      const result = r.result as RollbackResult;
      if (job.entity === "tag" || job.entity === "custom_field" || job.entity === "pipeline") {
        await rollbackConfigRow(db, actor, job, r, result, keep, done);
        continue;
      }
      if (job.entity === "company" && r.status === "updated") {
        // Only a link this run made goes; a re-run that matched an earlier run's link leaves it to that run.
        if (madeLink(result) && r.data.ghl_id) await db.query("delete from crm_external_ids where org_id = $1 and provider = 'ghl' and entity = 'company' and external_id = $2", [actor.orgId, text(r.data.ghl_id)]);
        await keep(r, "The import only filled in empty company details; they were kept.");
        continue;
      }
      const table = job.entity === "company" ? "crm_companies" : job.entity === "opportunity" ? "crm_opportunities" : "contacts";
      const live = job.entity === "opportunity" ? "archived_at is null" : "deleted_at is null";
      const cur = r.entity_id ? (await db.query<{ version: number }>(`select version from ${table} where id = $1 and org_id = $2 and ${live} for update`, [r.entity_id, actor.orgId])).rows[0] : null;
      // Changed by someone since the import: kept as it is and reported, never overwritten.
      if (!cur || (result.version !== undefined && cur.version !== result.version)) {
        await keep(r, "Changed since the import, so it was kept.");
        continue;
      }
      if (job.entity === "contact") {
        // A contact this import created that the team has worked on since (a deal, a note, a task, an appointment, a conversation) is kept
        // as it is, link included, before anything is changed: removing it would orphan that work.
        if (r.status === "created" && (await contactInUse(db, actor.orgId, r.entity_id!, job.completed_at ?? job.started_at ?? job.created_at))) {
          await keep(r, "Used by records added after the import (deals, notes, tasks, appointments or conversations), so it was kept.");
          continue;
        }
        if (result.tagsAdded?.length) await db.query("delete from crm_contact_tags where org_id = $1 and contact_id = $2 and tag_id = any($3::uuid[])", [actor.orgId, r.entity_id, result.tagsAdded]);
        if (r.status === "created") {
          await db.query("delete from contact_identities where org_id = $1 and contact_id = $2", [actor.orgId, r.entity_id]);
          await db.query("delete from crm_external_ids where org_id = $1 and provider = $2 and native_id = $3", [actor.orgId, provider, r.entity_id]);
          await db.query("update contacts set deleted_at = now(), email = null, phone = null where id = $1 and org_id = $2", [r.entity_id, actor.orgId]);
        } else {
          if (result.previous && Object.keys(result.previous).length) {
            const cols = Object.keys(result.previous).filter((c) => /^[a-z_0-9]+$/.test(c));
            const params: unknown[] = [r.entity_id, actor.orgId, ...cols.map((c) => result.previous![c])];
            await db.query(`update contacts set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")}, version = version + 1 where id = $1 and org_id = $2`, params);
          }
          // A GoHighLevel contact linked onto a record that was already here: the link this run made goes, the record stays.
          if (madeLink(result) && r.data.ghl_id) await db.query("delete from crm_external_ids where org_id = $1 and provider = 'ghl' and entity = 'contact' and external_id = $2", [actor.orgId, text(r.data.ghl_id)]);
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
        // A company the migration made by name for this contact goes too, when no live contact or deal uses it any more.
        if (result.companyCreated && !(await companyInUse(db, actor.orgId, result.companyCreated))) {
          await db.query("update crm_companies set deleted_at = now(), domain = null where id = $1 and org_id = $2 and deleted_at is null", [result.companyCreated, actor.orgId]);
        }
        // Opt-outs recorded from GoHighLevel's do-not-disturb stay: undoing an import never makes someone reachable again.
      } else if (job.entity === "opportunity") {
        // Native opportunities are never deleted: the deal is archived and its idempotency key released, so running the step again
        // makes it again. Its stage history is kept (it is immutable).
        await db.query("update crm_opportunities set archived_at = now(), idempotency_key = null, version = version + 1 where id = $1 and org_id = $2", [r.entity_id, actor.orgId]);
        await db.query("delete from crm_opportunity_tags where org_id = $1 and opportunity_id = $2", [actor.orgId, r.entity_id]);
        await db.query("delete from crm_external_ids where org_id = $1 and provider = $2 and entity = 'opportunity' and native_id = $3", [actor.orgId, provider, r.entity_id]);
      } else if (r.status === "created") {
        // A migrated company that live contacts or deals still point at is kept (undo the contacts and opportunities steps first).
        if (job.source === "ghl_api" && (await companyInUse(db, actor.orgId, r.entity_id!))) {
          await keep(r, "Still linked to contacts or deals, so it was kept.");
          continue;
        }
        await db.query("update crm_companies set deleted_at = now(), domain = null where id = $1 and org_id = $2", [r.entity_id, actor.orgId]);
        await db.query("delete from crm_external_ids where org_id = $1 and provider = $2 and entity = 'company' and native_id = $3", [actor.orgId, provider, r.entity_id]);
      }
      await done(r);
    }
  });
}

type RollbackResult = {
  version?: number; previous?: Record<string, unknown>; tagsAdded?: string[]; changedFields?: string[]; updatedAt?: string; addedStages?: string[]; linkedStages?: string[]; companyCreated?: string;
  /** The row matched a record that was already here (it was linked, not created). */
  linked?: boolean;
  /** This run made that external-id link (false: an earlier run had already made it, so undoing this run leaves it). */
  linkInserted?: boolean;
  /** Pipelines: this run made the pipeline's own link. */
  pipelineLinkInserted?: boolean;
  previousFields?: Array<{ key: string; value_text: string | null; value_number: string | null; value_date: string | null; value_ts: string | null; value_bool: boolean | null; value_list: string[] | null }>;
};

/** Whether undoing this row removes its external-id link. Rows written before linkInserted existed keep the old rule (linked → unlink). */
const madeLink = (result: RollbackResult) => result.linkInserted ?? result.linked === true;

/**
 * A contact the team has worked on since `since` (the import's end): a live native deal (migrated deals were archived first, because the
 * opportunities step is undone before contacts), a task, a note added after the import (the import's own note is older), an appointment,
 * or a conversation (its messages hang off it).
 */
async function contactInUse(db: Queryable, orgId: string, contactId: string, since: Date): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from crm_opportunities o where o.org_id = $1 and o.contact_id = $2 and o.provider = 'native' and o.archived_at is null
     union all select 1 from tasks t where t.org_id = $1 and t.contact_id = $2
     union all select 1 from record_notes n where n.org_id = $1 and n.record_type = 'contact' and n.record_id = $2::text and n.deleted_at is null and n.created_at > $3
     union all select 1 from appointment_refs a where a.org_id = $1 and a.contact_id = $2
     union all select 1 from appointment_bookings b where b.org_id = $1 and b.contact_id = $2
     union all select 1 from conversations c where c.org_id = $1 and c.contact_id = $2
     limit 1`,
    [orgId, contactId, since],
  );
  return rows.length > 0;
}

async function companyInUse(db: Queryable, orgId: string, companyId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from crm_contact_companies cc join contacts c on c.id = cc.contact_id and c.deleted_at is null where cc.org_id = $1 and cc.company_id = $2
     union all select 1 from crm_opportunities o where o.org_id = $1 and o.company_id = $2 and o.archived_at is null limit 1`,
    [orgId, companyId],
  );
  return rows.length > 0;
}

/** Configuration made by a migration step goes only when nothing uses it any more and nobody changed it; otherwise it is kept and reported. */
async function rollbackConfigRow(
  db: Queryable,
  actor: CrmActor,
  job: JobRow,
  r: ImportRow,
  result: RollbackResult,
  keep: (r: ImportRow, why: string) => Promise<unknown>,
  done: (r: ImportRow) => Promise<unknown>,
) {
  const unlink = (entity: string, externalIds: string[]) => db.query("delete from crm_external_ids where org_id = $1 and provider = 'ghl' and entity = $2 and external_id = any($3::text[])", [actor.orgId, entity, externalIds]);
  const ghlId = text(r.data.ghl_id);
  // A record that was already here: only a link this run made goes (a re-run that matched an earlier run's link leaves it to that run).
  if (job.entity === "tag") {
    if (result.linked) {
      if (madeLink(result)) await unlink("tag", [ghlId]);
      return done(r);
    }
    const t = (await db.query<{ updated_at: Date }>("select updated_at from crm_tags where id = $1 and org_id = $2", [r.entity_id, actor.orgId])).rows[0];
    if (!t) return done(r);
    const used = await db.query(
      "select 1 from crm_contact_tags where tag_id = $1 union all select 1 from crm_company_tags where tag_id = $1 union all select 1 from crm_opportunity_tags where tag_id = $1 limit 1",
      [r.entity_id],
    );
    if (used.rows.length) return keep(r, "Still used on records, so the tag was kept.");
    if (result.updatedAt && new Date(t.updated_at).toISOString() !== result.updatedAt) return keep(r, "Changed since the import, so it was kept.");
    await unlink("tag", [ghlId]);
    await db.query("delete from crm_tags where id = $1 and org_id = $2", [r.entity_id, actor.orgId]);
    return done(r);
  }
  if (job.entity === "custom_field") {
    if (result.linked) {
      if (madeLink(result)) await unlink("custom_field", [ghlId]);
      return done(r);
    }
    const f = (await db.query<{ updated_at: Date }>("select updated_at from crm_custom_fields where id = $1 and org_id = $2", [r.entity_id, actor.orgId])).rows[0];
    if (!f) return done(r);
    // Values on live records keep the field; values left on records the undo archived go with it.
    const values = await db.query(
      `select 1 from crm_field_values v where v.org_id = $2 and v.field_id = $1 and (
         (v.entity = 'contact' and exists (select 1 from contacts c where c.id = v.entity_id and c.deleted_at is null))
         or (v.entity = 'company' and exists (select 1 from crm_companies c where c.id = v.entity_id and c.deleted_at is null))
         or (v.entity = 'opportunity' and exists (select 1 from crm_opportunities o where o.id = v.entity_id and o.archived_at is null))) limit 1`,
      [r.entity_id, actor.orgId],
    );
    if (values.rows.length) return keep(r, "Records hold values in this field, so it was kept.");
    if (result.updatedAt && new Date(f.updated_at).toISOString() !== result.updatedAt) return keep(r, "Changed since the import, so it was kept.");
    await unlink("custom_field", [ghlId]);
    await db.query("delete from crm_custom_fields where id = $1 and org_id = $2", [r.entity_id, actor.orgId]);
    return done(r);
  }
  // Pipelines
  const stagesOf = Array.isArray(r.data.stages) ? (r.data.stages as Array<Record<string, unknown>>).map((s) => text(s.id)).filter(Boolean) : [];
  if (result.linked) {
    // A pipeline that was already here: the links go; stages the migration added go when no deal sits in them.
    for (const stageId of result.addedStages ?? []) {
      const busy = await db.query("select 1 from crm_opportunities where stage_ref = $1 and org_id = $2 limit 1", [stageId, actor.orgId]);
      if (!busy.rows.length) await db.query("update crm_pipeline_stages set archived_at = now() where id = $1 and org_id = $2", [stageId, actor.orgId]);
    }
    const addedExternal = (await db.query<{ external_id: string }>("select external_id from crm_external_ids where org_id = $1 and provider = 'ghl' and entity = 'stage' and native_id = any($2::uuid[])", [actor.orgId, result.addedStages ?? []])).rows.map((x) => x.external_id);
    await unlink("stage", [...(result.linkedStages ?? []), ...addedExternal]);
    // The pipeline's own link goes only when this run made it (rows from before pipelineLinkInserted existed keep the old rule).
    if (result.pipelineLinkInserted ?? true) await unlink("pipeline", [ghlId]);
    return done(r);
  }
  const p = (await db.query<{ updated_at: Date; archived_at: Date | null }>("select updated_at, archived_at from crm_pipelines where id = $1 and org_id = $2", [r.entity_id, actor.orgId])).rows[0];
  if (!p || p.archived_at) return done(r);
  const deals = await db.query("select 1 from crm_opportunities where pipeline_ref = $1 and org_id = $2 and archived_at is null limit 1", [r.entity_id, actor.orgId]);
  if (deals.rows.length) return keep(r, "Deals are in this pipeline, so it was kept.");
  if (result.updatedAt && new Date(p.updated_at).toISOString() !== result.updatedAt) return keep(r, "Changed since the import, so it was kept.");
  await unlink("stage", stagesOf);
  await unlink("pipeline", [ghlId]);
  await db.query("update crm_pipelines set archived_at = now(), is_default = false where id = $1 and org_id = $2", [r.entity_id, actor.orgId]);
  return done(r);
}
