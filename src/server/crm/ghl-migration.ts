import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner, loadWorkspace } from "@/server/crm/workspace";
import {
  advanceImport, cancelImportInTx, createGhlImportJobInTx, getImportJobs, ghlFieldType, HAS_UNDO_SQL, IMPORT_CAPABILITY, ImportLeaseLost, MAX_GHL_ROWS, resumeGhlImportJobInTx,
  revalidateImportInTx, rollbackImport, stageImportRowsInTx, startImportInTx, type ImportFetchState, type ImportJobView, type ImportOptions,
} from "@/server/crm/imports";
import {
  GHL_API_ORIGIN, GHL_DAILY_RESERVE, GHL_VERSIONS, GhlRateLimitError, GhlReadError, ghlMigrationGet, loadGhlMigrationMapping, scopeGhlRows, type GhlMapping,
} from "@/server/integrations/ghl";
import {
  GHL_ENTITY_LABELS, GHL_MIGRATION_ENTITIES, GHL_NOT_MIGRATED, GHL_OPTIONAL_PREREQUISITES, GHL_PREREQUISITES, isGhlMigrationEntity, type GhlMigrationEntity,
} from "@/lib/crm/ghl-migration";
import { ACTIVE_SWITCH_STATUSES } from "@/lib/crm/provider-switch";

// Moving a client's live GoHighLevel records into iAcquire Native CRM.
//
//   * Read-only: every request is a GET to https://services.leadconnectorhq.com (src/server/integrations/ghl.ts), for the client's own mapped
//     location with its vault credential. Aster Homes and iAcquire's agency location are refused before any request. No POST is ever sent,
//     so contacts are listed with GET /contacts/ (documented, marked deprecated; the non-deprecated listing is POST /contacts/search).
//   * Through the import pipeline: each step (custom fields → tags → pipelines → companies → contacts → opportunities) is an import job
//     (source 'ghl_api'). Its rows are staged page by page with a stored cursor, then the normal dry run → import → undo worker runs.
//   * Rate limits: GoHighLevel allows 100 requests per 10 s and 200,000 per day per location. A 429 (with Retry-After), a used-up burst
//     budget, or a nearly used daily allowance pauses the step (fetch_not_before) and it resumes from its cursor. A passing GoHighLevel
//     error (5xx, a timeout) backs off the same way, a few times, before the step stops. Nothing ever hammers.
//   * Re-runs never duplicate: crm_external_ids maps every GoHighLevel id to the native record it became; opportunities also carry the
//     idempotency key ghl:<id>. The GoHighLevel cache rows (provider 'ghl') are never touched.
//   * Authorization: anyone in the workspace may preview; owners and managers may dry run; only the owner (crm.provider.manage), or an
//     iAcquire super admin in a write support session, may import or undo. The import phase runs only while iAcquire owns the capability.

export { GHL_MIGRATION_ENTITIES };
export type { GhlMigrationEntity };

/** The documented endpoint each step reads (all GET). */
export const GHL_MIGRATION_ENDPOINTS: Record<GhlMigrationEntity, { path: string; scope: string; paging: "none" | "skip" | "cursor"; note?: string }> = {
  custom_field: { path: "GET /locations/{locationId}/customFields?model=all", scope: "locations/customFields.readonly", paging: "none" },
  tag: { path: "GET /locations/{locationId}/tags", scope: "locations/tags.readonly", paging: "none" },
  pipeline: { path: "GET /opportunities/pipelines?locationId", scope: "opportunities.readonly", paging: "none" },
  company: { path: "GET /businesses/?locationId&limit&skip", scope: "businesses.readonly", paging: "skip" },
  contact: { path: "GET /contacts/?locationId&limit&startAfterId&startAfter", scope: "contacts.readonly", paging: "cursor", note: "Documented and marked deprecated by GoHighLevel; its replacement is a POST search, which iAcquire never sends." },
  opportunity: { path: "GET /opportunities/search?location_id&status=all&limit&startAfterId&startAfter", scope: "opportunities.readonly", paging: "cursor" },
};

const PAGE = 100;
const PAGES_PER_ADVANCE = 5;

/** The migration panel is read-only while a switch owns these controls; only the provider-switch wizard may change its steps. */
async function lockPanelForActiveSwitch(db: Queryable, orgId: string) {
  await db.query("select org_id from crm_workspaces where org_id = $1 for update", [orgId]);
  const active = await db.query(
    "select 1 from crm_provider_switches where org_id = $1 and status = any($2::text[]) limit 1",
    [orgId, ACTIVE_SWITCH_STATUSES],
  );
  if (active.rows.length) throw new AppError("conflict", "A CRM provider switch is in progress. Manage its migration steps in Settings → CRM Provider.");
}

async function hasActiveProviderSwitch(db: Queryable, orgId: string) {
  const active = await db.query(
    "select 1 from crm_provider_switches where org_id = $1 and status = any($2::text[]) limit 1",
    [orgId, ACTIVE_SWITCH_STATUSES],
  );
  return active.rows.length > 0;
}
/**
 * One worker step stops asking after about this many requests (pages plus contact re-reads; it is checked before every contact re-read
 * too, and a page always stages at least one contact so a step makes progress). The job's lease is renewed with every page it stages.
 */
export const REQUESTS_PER_ADVANCE = 40;
const PLAN_SCAN_PAGES = 5;
/** Passing GoHighLevel errors (5xx, timeouts) in a row a step waits out before it stops, and the most time it spends waiting on them. */
export const GHL_TRANSIENT_MAX_ERRORS = 8;
export const GHL_TRANSIENT_BACKOFF_MS = 30 * 60_000;

/** The wait after the nth passing GoHighLevel error in a row: 2 s, 4 s, 8 s … at most 5 minutes, plus up to a second of jitter. */
export function transientDelayMs(n: number, jitter = Math.random()): number {
  return Math.min(300_000, 2_000 * 2 ** Math.max(0, n - 1)) + Math.floor(Math.min(1, Math.max(0, jitter)) * 1000);
}

const isTransient = (err: unknown): err is GhlReadError => err instanceof GhlReadError && err.transient;

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** Reading a client's GoHighLevel account with its credential is never done from a read-only support session. */
function refuseReadSession(actor: CrmActor) {
  if (actor.kind === "agency" && actor.supportMode !== "write") throw new AppError("forbidden", "This support session is read-only. Reading the client's GoHighLevel account needs a super admin's write session.");
  if (actor.kind === "agent" || actor.kind === "api") throw new AppError("forbidden", "GoHighLevel migrations are run by people.");
}
const canPreview = (actor: CrmActor) => actor.can("crm.view");
const canDryRun = (actor: CrmActor) => actor.can("contacts.import");
const canImport = (actor: CrmActor) => actor.can("crm.provider.manage");

function assertDryRun(actor: CrmActor) {
  refuseReadSession(actor);
  if (!canDryRun(actor)) assertCan(actor, "contacts.import", "Only owners and managers can run a GoHighLevel dry run. Anyone in the workspace can preview it.");
}

function assertImport(actor: CrmActor) {
  refuseReadSession(actor);
  assertCan(actor, "crm.provider.manage", "Only the workspace owner can import from GoHighLevel (an iAcquire super admin can help in a write session).");
}

// ---------------------------------------------------------------------------
// Reading GoHighLevel
// ---------------------------------------------------------------------------

type Get = (path: string, params?: Record<string, string>, version?: (typeof GHL_VERSIONS)[keyof typeof GHL_VERSIONS]) => Promise<Record<string, unknown>>;

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : str(obj(x).email ?? obj(x).phone ?? obj(x).name))).map((s) => s.trim()).filter(Boolean) : []);
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));

/** A reader for one location that counts its requests and remembers what GoHighLevel said about the remaining allowance. */
function reader(m: GhlMapping) {
  const state = { requests: 0, pauseMs: 0, daily: false };
  const get: Get = async (path, params = {}, version = GHL_VERSIONS.default) => {
    state.requests++;
    const { body, rate } = await ghlMigrationGet(m, path, params, version);
    // Nearly out of the daily allowance: finish with this answer, then wait (an hour) rather than use the rest.
    if (rate.dailyRemaining !== null && rate.dailyRemaining < GHL_DAILY_RESERVE) {
      state.daily = true;
      state.pauseMs = Math.max(state.pauseMs, 3_600_000);
    }
    // The burst interval is nearly used up: finish with this answer, then wait out the interval.
    if (rate.burstRemaining !== null && rate.burstRemaining <= 2) state.pauseMs = Math.max(state.pauseMs, rate.intervalMs ?? 10_000);
    return body;
  };
  return { get, state };
}

/** GET /locations/{locationId} must name exactly this location (the token belongs to it), or nothing else is read. */
async function verifyLocation(get: Get, m: GhlMapping): Promise<{ name: string | null; companyId: string | null }> {
  const body = await get(`/locations/${encodeURIComponent(m.locationId)}`);
  const location = obj(body.location);
  if (location.id !== m.locationId) throw new AppError("forbidden", "GoHighLevel location mismatch: the stored token doesn't belong to this workspace's location. Nothing was read.");
  return { name: str(location.name, 200) || null, companyId: str(location.companyId, 60) || null };
}

/** The location's users (id → email), to map owners onto workspace members by email. Needs users.readonly; without it owners stay unmapped. */
async function readUsers(get: Get, m: GhlMapping, companyId: string | null): Promise<{ users: Record<string, string>; readable: boolean; count: number }> {
  if (!companyId) return { users: {}, readable: false, count: 0 };
  const users: Record<string, string> = {};
  let count = 0;
  try {
    for (let page = 0; page < 5; page++) {
      const body = await get("/users/search", { companyId, locationId: m.locationId, limit: String(PAGE), skip: String(page * PAGE) });
      const rows = list(body.users);
      for (const u of rows) {
        const id = str(u.id, 60);
        const email = str(u.email, 254).toLowerCase();
        if (!id || u.deleted === true) continue;
        count++;
        if (email && Object.keys(users).length < 500) users[id] = email;
      }
      if (rows.length < PAGE) break;
    }
    return { users, readable: true, count };
  } catch (err) {
    if (err instanceof GhlReadError && (err.kind === "forbidden" || err.kind === "invalid" || err.kind === "not_found")) return { users: {}, readable: false, count: 0 };
    throw err;
  }
}

function fieldValues(raw: unknown, valueKey: "value" | "fieldValue"): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const f of list(raw)) {
    const id = str(f.id, 60);
    const v = f[valueKey] ?? f.value ?? f.fieldValue;
    if (id && v !== undefined && v !== null && v !== "") out[id] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

const DND_CHANNELS: Record<string, string> = { SMS: "sms", Email: "email", WhatsApp: "whatsapp" };

/**
 * One GoHighLevel contact as a staged row. Field names follow GoHighLevel's documented contact schema. `detail` "not_found": the full record
 * couldn't be read, so the row carries what the list gave (and the dry run flags it).
 */
function stageContact(c: Record<string, unknown>, users: Record<string, string>, detail?: "not_found"): Record<string, unknown> {
  const owner = str(c.assignedTo, 60);
  const dndSettings = obj(c.dndSettings);
  const dndChannels = Object.entries(DND_CHANNELS).filter(([k]) => ["active", "permanent"].includes(str(obj(dndSettings[k]).status))).map(([, v]) => v);
  return compact({
    ghl_id: str(c.id, 60),
    name: str(c.contactName ?? c.name, 300),
    email: str(c.email, 254),
    phone: str(c.phone, 40),
    first_name: str(c.firstName, 100),
    last_name: str(c.lastName, 100),
    email_2: strings(c.additionalEmails).slice(0, 5),
    phone_2: strings(c.additionalPhones).slice(0, 5),
    company: str(c.companyName, 200),
    ghl_business_id: str(c.businessId, 60),
    address_line1: str(c.address1, 200),
    city: str(c.city, 100),
    region: str(c.state, 100),
    postal_code: str(c.postalCode, 20),
    country: str(c.country, 60),
    timezone: str(c.timezone, 64),
    source: str(c.source, 60),
    ghl_owner_id: owner,
    owner_email: owner ? users[owner] : undefined,
    tags: strings(c.tags).map((t) => t.slice(0, 60)).slice(0, 50),
    custom_fields: fieldValues(c.customFields ?? c.customField, "value"),
    dnd: c.dnd === true ? true : undefined,
    dnd_channels: c.dnd === true ? undefined : dndChannels,
    date_added: str(c.dateAdded, 40),
    ghl_detail: detail,
  });
}

function stageOpportunity(o: Record<string, unknown>, users: Record<string, string>): Record<string, unknown> {
  const owner = str(o.assignedTo, 60);
  const contact = obj(o.contact);
  return compact({
    ghl_id: str(o.id, 60),
    name: str(o.name, 300),
    contact_name: str(contact.name, 200),
    ghl_pipeline_id: str(o.pipelineId, 60),
    ghl_stage_id: str(o.pipelineStageId, 60),
    status: str(o.status, 20),
    monetary_value: typeof o.monetaryValue === "number" ? o.monetaryValue : str(o.monetaryValue, 30),
    ghl_owner_id: owner,
    owner_email: owner ? users[owner] : undefined,
    source: str(o.source, 120),
    ghl_contact_id: str(o.contactId ?? contact.id, 60),
    custom_fields: fieldValues(o.customFields, "fieldValue"),
    created_at: str(o.createdAt, 40),
    updated_at: str(o.updatedAt, 40),
    last_status_change_at: str(o.lastStatusChangeAt, 40),
    last_stage_change_at: str(o.lastStageChangeAt, 40),
    lost_reason_id: str(o.lostReasonId, 60),
  });
}

const has = (c: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(c, k);

/**
 * True when a listed contact must be read again with GET /contacts/{id}. The documented list item (ContactsSearchSchema) has no name or
 * phone fields, so the decision is by which keys GoHighLevel sent, not by their values: a list that carries the name and phone keys (even
 * empty) costs no extra request; one in the documented shape is read again contact by contact.
 */
const needsDetail = (c: Record<string, unknown>) => !["firstName", "lastName", "contactName", "name"].some((k) => has(c, k)) || !has(c, "phone");

type Cursor = { startAfterId?: string; startAfter?: number; skip?: number };
type TotalFrom = NonNullable<ImportFetchState["sourceTotalFrom"]>;
type PageResult = {
  rows: Record<string, unknown>[]; next: Cursor | null; total: number | null; totalFrom: TotalFrom | null; detailReads: number; incomplete?: boolean;
  /** The worker step's request budget ran out part way through the page: `next` is right after the last contact staged. */
  stoppedForBudget?: boolean;
};

/**
 * Reads one page of a step. Throws GhlRateLimitError (or a passing GhlReadError) with `partial` when it had to stop part way through
 * enriching a page. `budget` says when the worker step has used its requests: the page then ends after the contacts already read.
 */
async function readPage(
  entity: GhlMigrationEntity, m: GhlMapping, get: Get, cursor: Cursor, users: Record<string, string>, opts: { details?: boolean; budget?: () => boolean } = {},
): Promise<PageResult> {
  const loc = encodeURIComponent(m.locationId);
  if (entity === "custom_field") {
    const body = await get(`/locations/${loc}/customFields`, { model: "all" });
    const rows = scopeGhlRows<{ id: string }>(body.customFields, m).map((f) => {
      const r = f as unknown as Record<string, unknown>;
      return compact({ ghl_id: str(r.id, 60), name: str(r.name, 200), field_key: str(r.fieldKey, 120), data_type: str(r.dataType, 40), model: str(r.model, 40), options: strings(r.picklistOptions).slice(0, 100), position: typeof r.position === "number" ? r.position : undefined, placeholder: str(r.placeholder, 200) });
    });
    return { rows, next: null, total: rows.length, totalFrom: "list", detailReads: 0 };
  }
  if (entity === "tag") {
    const body = await get(`/locations/${loc}/tags`);
    const rows = scopeGhlRows<{ id: string }>(body.tags, m).map((t) => compact({ ghl_id: str(t.id, 60), name: str((t as unknown as Record<string, unknown>).name, 200) }));
    return { rows, next: null, total: rows.length, totalFrom: "list", detailReads: 0 };
  }
  if (entity === "pipeline") {
    const body = await get("/opportunities/pipelines", { locationId: m.locationId });
    const rows = scopeGhlRows<{ id: string }>(body.pipelines, m).map((p) => {
      const r = p as unknown as Record<string, unknown>;
      return compact({ ghl_id: str(r.id, 60), name: str(r.name, 200), stages: list(r.stages).map((s, i) => ({ id: str(s.id, 60), name: str(s.name, 200), position: typeof s.position === "number" ? s.position : i })) });
    });
    return { rows, next: null, total: rows.length, totalFrom: "list", detailReads: 0 };
  }
  if (entity === "company") {
    const skip = cursor.skip ?? 0;
    const body = await get("/businesses/", { locationId: m.locationId, limit: String(PAGE), skip: String(skip) });
    const rows = scopeGhlRows<{ id: string }>(body.businesses, m).map((b) => {
      const r = b as unknown as Record<string, unknown>;
      return compact({ ghl_id: str(r.id, 60), name: str(r.name, 200), phone: str(r.phone, 40), email: str(r.email, 254), website: str(r.website, 300), address_line1: str(r.address, 200), city: str(r.city, 100), region: str(r.state, 100), postal_code: str(r.postalCode, 20), country: str(r.country, 60), description: str(r.description, 2000) });
    });
    // GoHighLevel reports no total for businesses: the comparison says the count is what it listed.
    return { rows, next: rows.length < PAGE ? null : { skip: skip + PAGE }, total: null, totalFrom: null, detailReads: 0 };
  }
  const params: Record<string, string> = entity === "contact" ? { locationId: m.locationId, limit: String(PAGE) } : { location_id: m.locationId, limit: String(PAGE), status: "all" };
  if (cursor.startAfterId && cursor.startAfter !== undefined) {
    params.startAfterId = cursor.startAfterId;
    params.startAfter = String(cursor.startAfter);
  }
  const body = await get(entity === "contact" ? "/contacts/" : "/opportunities/search", params);
  const raw = scopeGhlRows<{ id: string }>(entity === "contact" ? body.contacts : body.opportunities, m) as unknown as Record<string, unknown>[];
  const meta = obj(body.meta);
  // meta.total when GoHighLevel gives it; otherwise the documented top-level `count` (checked against what was read: see noteTotal).
  const count = typeof body.count === "number" && Number.isFinite(body.count) && body.count >= 0 ? body.count : null;
  const total = typeof meta.total === "number" ? meta.total : count;
  const totalFrom: TotalFrom | null = typeof meta.total === "number" ? "meta.total" : count !== null ? "count" : null;
  const rows: Record<string, unknown>[] = [];
  let detailReads = 0;
  for (const r of raw) {
    let rec = r;
    let detail: "not_found" | undefined;
    if (entity === "contact" && opts.details !== false && needsDetail(r)) {
      // Out of requests for this worker step: stop after the contacts already read (always at least one, so every step moves on), when
      // GoHighLevel's cursor can name the last of them. The next step resumes right after it.
      if (rows.length && opts.budget?.()) {
        const at = rowCursor(raw[rows.length - 1]);
        if (at) return { rows, next: at, total, totalFrom, detailReads, stoppedForBudget: true };
      }
      try {
        const found = obj((await get(`/contacts/${encodeURIComponent(str(r.id, 60))}`)).contact);
        detailReads++;
        if (found.id === r.id && (found.locationId === undefined || found.locationId === m.locationId)) rec = { ...r, ...found };
        else detail = "not_found";
      } catch (err) {
        if (err instanceof GhlRateLimitError || isTransient(err)) throw Object.assign(err, { partial: { rows, lastRaw: rows.length ? raw[rows.length - 1] : null, total, detailReads } });
        if (!(err instanceof GhlReadError && err.kind === "not_found")) throw err;
        detailReads++;
        detail = "not_found";
      }
    }
    rows.push(entity === "contact" ? stageContact(rec, users, detail) : stageOpportunity(rec, users));
  }
  // GoHighLevel's cursor (meta.startAfterId/startAfter) when it gives one; otherwise the last contact's id and the time it was added.
  let next: Cursor | null = null;
  let incomplete = false;
  if (raw.length >= PAGE) {
    if (typeof meta.startAfterId === "string" && meta.startAfterId && (meta.nextPageUrl || entity === "contact")) next = { startAfterId: meta.startAfterId, startAfter: Number(meta.startAfter) };
    else if (entity === "contact") next = rowCursor(raw[raw.length - 1]);
    if (next && (!next.startAfterId || !Number.isFinite(next.startAfter))) next = null;
    // A full page and no way to ask for the next one (opportunities say so with meta.nextPageUrl; a missing cursor is reported).
    if (!next && (entity === "contact" || meta.nextPageUrl)) incomplete = true;
  }
  return { rows, next, total, totalFrom, detailReads, incomplete };
}

function rowCursor(r: Record<string, unknown> | null): Cursor | null {
  if (!r) return null;
  const at = Date.parse(str(r.dateAdded, 40));
  return typeof r.id === "string" && Number.isFinite(at) ? { startAfterId: r.id, startAfter: at } : null;
}

/**
 * Records the source total a page reported. GoHighLevel's documented contact list says `count`, which may be the page's size rather than
 * the location's total: once it is smaller than what was already read, it is ignored from then on (countNotTotal).
 */
function noteTotal(state: ImportFetchState, res: PageResult, readSoFar: number) {
  if (res.total === null || !res.totalFrom) return;
  if (res.totalFrom === "count") {
    if (state.countNotTotal) return;
    if (res.total < readSoFar) {
      state.countNotTotal = true;
      if (state.sourceTotalFrom === "count") {
        state.sourceTotal = null;
        delete state.sourceTotalFrom;
      }
      return;
    }
  }
  state.sourceTotal = res.total;
  state.sourceTotalFrom = res.totalFrom;
}

/** Progress was made (a page, or part of one, was staged): passing errors start counting again from zero. */
function resetTransient(state: ImportFetchState) {
  delete state.transientErrors;
  delete state.transientWaitMs;
  delete state.lastError;
}

// ---------------------------------------------------------------------------
// The fetching stage (called by the import worker for jobs in 'fetching')
// ---------------------------------------------------------------------------

type FetchJob = { id: string; org_id: string; entity: string; status: string; source_location: string | null; fetch_cursor: Cursor | null; fetch_state: ImportFetchState; total_rows: number; created_by: string | null };

/**
 * Reads up to a few pages of one step and stages them. Network requests happen outside any database transaction; each page is staged
 * together with the new cursor in one short transaction, so a stop at any point resumes exactly where it left off.
 *
 * `lease` is the claim advanceImport took (crm_import_jobs.claimed_at). Every write first checks the job is still this worker's and still
 * reading, and renews the claim (the same object is updated, so advanceImport's final release matches). A worker whose claim was taken
 * over (a read that outlasted the two-minute claim) throws ImportLeaseLost and writes nothing more; a cancelled step just stops.
 */
export async function fetchGhlChunk(jobId: string, lease?: { at: Date }): Promise<void> {
  const job = (await withSystem((db) => db.query<FetchJob>("select id, org_id, entity, status, source_location, fetch_cursor, fetch_state, total_rows, created_by from crm_import_jobs where id = $1 and source = 'ghl_api'", [jobId]))).rows[0];
  if (!job || job.status !== "fetching" || !isGhlMigrationEntity(job.entity)) return;
  const entity = job.entity;
  const mapping = await withSystem((db) => loadGhlMigrationMapping(db, job.org_id));
  if (!mapping) throw new AppError("integration_unavailable", "The GoHighLevel connection was removed, so this step stopped. Nothing was imported.");
  if (mapping.locationId !== job.source_location) throw new AppError("conflict", "This workspace is now connected to a different GoHighLevel location. Start the migration again.");
  const state: ImportFetchState = { ...(job.fetch_state ?? {}) };
  let cursor: Cursor = job.fetch_cursor ?? {};
  let staged = job.total_rows;
  const r = reader(mapping);
  const persist = async (db: Queryable, extra: { cursor?: Cursor | null; notBefore?: number | null } = {}) => {
    state.requests = (job.fetch_state?.requests ?? 0) + r.state.requests;
    await db.query("update crm_import_jobs set fetch_state = $2, fetch_cursor = $3, fetch_not_before = $4 where id = $1", [
      job.id, JSON.stringify(state), extra.cursor === null ? null : JSON.stringify(extra.cursor ?? cursor), extra.notBefore ? new Date(Date.now() + extra.notBefore) : null,
    ]);
  };
  const write = async <T>(fn: (db: Queryable) => Promise<T>): Promise<{ stopped: true } | { stopped: false; value: T }> => {
    const renewed: { at: Date | null } = { at: null };
    const out = await withSystem(async (db) => {
      const row = (await db.query<{ status: string; claimed_at: Date | null }>("select status, claimed_at from crm_import_jobs where id = $1 for update", [job.id])).rows[0];
      if (lease && (!row?.claimed_at || new Date(row.claimed_at).getTime() !== lease.at.getTime())) throw new ImportLeaseLost();
      if (row?.status !== "fetching") return { stopped: true as const };
      if (lease) renewed.at = (await db.query<{ claimed_at: Date }>("update crm_import_jobs set claimed_at = date_trunc('milliseconds', now()) where id = $1 returning claimed_at", [job.id])).rows[0].claimed_at;
      return { stopped: false as const, value: await fn(db) };
    });
    // The renewed claim counts once its transaction committed.
    if (lease && renewed.at) lease.at = new Date(renewed.at);
    return out;
  };
  try {
    const identity = await verifyLocation(r.get, mapping);
    state.locationName = identity.name;
    state.companyId = identity.companyId;
    if ((entity === "contact" || entity === "opportunity") && state.users === undefined) {
      const owners = await readUsers(r.get, mapping, identity.companyId);
      state.users = owners.users;
      state.ownersReadable = owners.readable;
    }
    for (let page = 0; page < PAGES_PER_ADVANCE; page++) {
      let res: PageResult;
      try {
        res = await readPage(entity, mapping, r.get, cursor, state.users ?? {}, { budget: () => r.state.requests >= REQUESTS_PER_ADVANCE });
      } catch (err) {
        // Stopped part way through a page of contacts: keep what was read (the cursor moves to the last staged contact) when that is safe.
        const partial = (err as { partial?: { rows: Record<string, unknown>[]; lastRaw: Record<string, unknown> | null } }).partial;
        const at = partial?.rows.length ? rowCursor(partial.lastRaw) : null;
        if ((err instanceof GhlRateLimitError || isTransient(err)) && partial && at) {
          await write(async (db) => {
            staged += await stageImportRowsInTx(db, job.org_id, job.id, partial.rows.map((data) => ({ data })));
            cursor = at;
            resetTransient(state);
            await persist(db);
          });
        }
        throw err;
      }
      if (!res.stoppedForBudget) state.pages = (state.pages ?? 0) + 1;
      state.detailReads = (state.detailReads ?? 0) + res.detailReads;
      noteTotal(state, res, staged + res.rows.length);
      if (res.incomplete) state.truncated = true;
      const sameCursor = !!res.next && res.next.startAfterId !== undefined && res.next.startAfterId === cursor.startAfterId;
      if (sameCursor) state.truncated = true;
      let next = sameCursor ? null : res.next;
      const room = MAX_GHL_ROWS - staged;
      const rows = res.rows.slice(0, Math.max(0, room));
      if (rows.length < res.rows.length || (next && staged + rows.length >= MAX_GHL_ROWS)) {
        state.truncated = true;
        next = null;
      }
      const step = await write(async (db) => {
        staged += await stageImportRowsInTx(db, job.org_id, job.id, rows.map((data) => ({ data })));
        resetTransient(state);
        if (next) {
          cursor = next;
          // iAcquire pacing itself (GoHighLevel's burst header nearly empty, or the daily reserve reached) says so, honestly.
          if (r.state.pauseMs) {
            state.lastWaitReason = r.state.daily ? "daily" : "burst";
            state.lastWaitMs = r.state.pauseMs;
          }
          await persist(db, { notBefore: r.state.pauseMs || null });
          return false;
        }
        if (state.sourceTotal === undefined) state.sourceTotal = null;
        // Owners are already resolved into the staged rows: the location's user list isn't kept once reading is done.
        delete state.users;
        await persist(db, { cursor: null });
        // Every page is staged: the dry run starts by itself on the next step of the worker. Nothing is imported yet.
        await db.query("update crm_import_jobs set status = 'validating', fetched_at = now(), fetch_not_before = null, summary = '{}' where id = $1", [job.id]);
        await recordAudit({ orgId: job.org_id, actorUserId: job.created_by, actorKind: "system", action: "crm.ghl_migration_fetched", targetType: "crm_import_job", targetId: job.id, result: "success", metadata: { entity, staged, requests: state.requests, pages: state.pages, rateLimited: state.rateLimited ?? 0, truncated: state.truncated === true, sourceTotal: state.sourceTotal ?? null } }, db);
        return true;
      });
      if (step.stopped || step.value || r.state.pauseMs || r.state.requests >= REQUESTS_PER_ADVANCE) return;
    }
  } catch (err) {
    // Another worker holds the step now: it carries on from the stored cursor, and this one writes nothing more.
    if (err instanceof ImportLeaseLost) throw err;
    let failedTimes = 0;
    if (err instanceof GhlRateLimitError) {
      // GoHighLevel said "not now" (429), or iAcquire's own budget did: wait as long as asked, then resume from the stored cursor. Only
      // GoHighLevel's own answers count as rate limiting; the reason says which it was.
      if (err.reason === "retry_after") state.rateLimited = (state.rateLimited ?? 0) + 1;
      state.lastWaitReason = err.reason;
      state.lastWaitMs = err.retryAfterMs;
      await write((db) => persist(db, { notBefore: Math.max(1000, err.retryAfterMs) }));
      return;
    }
    if (isTransient(err)) {
      // A passing GoHighLevel error (5xx, a timeout, unreachable): back off and resume from the stored cursor, a few times in a row.
      const n = (state.transientErrors ?? 0) + 1;
      const delay = transientDelayMs(n);
      const spent = (state.transientWaitMs ?? 0) + delay;
      state.lastError = err.message.slice(0, 200);
      failedTimes = n;
      if (n <= GHL_TRANSIENT_MAX_ERRORS && spent <= GHL_TRANSIENT_BACKOFF_MS) {
        Object.assign(state, { transientErrors: n, transientWaitMs: spent, lastWaitReason: "error", lastWaitMs: delay });
        await write((db) => persist(db, { notBefore: delay }));
        return;
      }
    }
    // The step stops here. The cursor and counters stay (Run this step again resumes from them); the location's user list goes.
    delete state.users;
    const saved = await write((db) => persist(db)).catch((e: unknown) => {
      if (e instanceof ImportLeaseLost) throw e;
      return null;
    });
    // Cancelled meanwhile: nothing to fail.
    if (saved?.stopped) return;
    if (err instanceof GhlReadError) {
      const info = GHL_MIGRATION_ENDPOINTS[entity];
      throw new AppError(
        err.kind === "forbidden" ? "forbidden" : "upstream_error",
        err.kind === "forbidden"
          ? `The GoHighLevel token can't read ${GHL_ENTITY_LABELS[entity].many.toLowerCase()} (it needs the ${info.scope} scope). Nothing was imported.`
          : `${err.message}${failedTimes ? ` It failed ${failedTimes} times in a row.` : ""} Nothing was imported; run this step again later (it resumes where it stopped).`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Preview (dry, read-only: nothing is stored)
// ---------------------------------------------------------------------------

export interface GhlPlanEntity {
  entity: GhlMigrationEntity;
  label: string;
  status: "ok" | "forbidden" | "unavailable" | "error" | "rate_limited";
  /** Records in GoHighLevel. Exact when GoHighLevel reports a total or the whole list was read; otherwise "at least". */
  count: number | null;
  countKind: "exact" | "at_least" | "unknown";
  detail: string | null;
  endpoint: string;
  scope: string;
  /** Native records already linked to a GoHighLevel record of this kind (an earlier run). */
  alreadyLinked: number;
  /** Who owns this part of the CRM now. The import phase only runs while iAcquire owns it. */
  owner: "native" | "ghl";
  unsupported?: Array<{ name: string; type: string }>;
}

export interface GhlMigrationPlan {
  connected: boolean;
  reason: string | null;
  locationName: string | null;
  checkedAt: string;
  requests: number;
  entities: GhlPlanEntity[];
  owners: { status: "ok" | "unavailable" | "not_checked"; ghlUsers: number; matched: number; unmatched: number };
  appointments: { status: "ok" | "unavailable" | "not_checked"; calendars: number | null; note: string };
  notMigrated: ReadonlyArray<{ what: string; why: string }>;
  can: { dryRun: boolean; import: boolean };
}

async function alreadyLinked(db: Queryable, orgId: string): Promise<Record<GhlMigrationEntity, number>> {
  const out = Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, 0])) as Record<GhlMigrationEntity, number>;
  for (const e of GHL_MIGRATION_ENTITIES) out[e] = await destinationCount(db, orgId, e);
  return out;
}

/** Native records linked to a GoHighLevel record of this kind that still exist. */
async function destinationCount(db: Queryable, orgId: string, entity: GhlMigrationEntity): Promise<number> {
  const join: Record<GhlMigrationEntity, string> = {
    contact: "join contacts x on x.id = e.native_id and x.org_id = e.org_id and x.deleted_at is null",
    company: "join crm_companies x on x.id = e.native_id and x.org_id = e.org_id and x.deleted_at is null",
    opportunity: "join crm_opportunities x on x.id = e.native_id and x.org_id = e.org_id and x.provider = 'native' and x.archived_at is null",
    pipeline: "join crm_pipelines x on x.id = e.native_id and x.org_id = e.org_id and x.provider = 'native' and x.archived_at is null",
    tag: "join crm_tags x on x.id = e.native_id and x.org_id = e.org_id",
    custom_field: "join crm_custom_fields x on x.id = e.native_id and x.org_id = e.org_id and x.archived_at is null",
  };
  const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from crm_external_ids e ${join[entity]} where e.org_id = $1 and e.provider = 'ghl' and e.entity = $2`, [orgId, entity]);
  return Number(rows[0].n);
}

/** Whether the workspace has a usable GoHighLevel mapping, without decrypting anything. */
async function connectionStatus(db: Queryable, orgId: string): Promise<{ connected: boolean; reason: string | null; locationName: string | null }> {
  const { rows } = await db.query<{ status: string; location_name: string | null; has_credential: boolean }>(
    `select g.status, g.location_name, (c.id is not null and c.revoked_at is null) as has_credential from ghl_location_mappings g
     left join integration_credentials c on c.id = g.credential_id where g.org_id = $1`,
    [orgId],
  );
  const g = rows[0];
  if (!g) return { connected: false, reason: "No GoHighLevel location is connected to this workspace. iAcquire support connects your own location read-only when you're ready to migrate.", locationName: null };
  if (g.status === "disabled") return { connected: false, reason: "The GoHighLevel connection is turned off for this workspace.", locationName: g.location_name };
  if (!g.has_credential) return { connected: false, reason: "The GoHighLevel connection has no active read-only token. Ask iAcquire support to reconnect it.", locationName: g.location_name };
  return { connected: true, reason: null, locationName: g.location_name };
}

/**
 * A dry, read-only look at what the client's GoHighLevel location holds: counts per step (exact where GoHighLevel reports a total or the
 * whole list fits; otherwise a capped scan says "at least"), owners, calendars, unsupported field types, and what won't come across.
 * Nothing is stored. Anyone in the workspace may preview; a read-only support session may not (it would use the client's credential).
 */
export async function planGhlMigration(actor: CrmActor): Promise<GhlMigrationPlan> {
  refuseReadSession(actor);
  if (!canPreview(actor)) assertCan(actor, "crm.view");
  const base = await withSystem(async (db) => {
    const ws = await loadWorkspace(db, actor.orgId);
    return { ws, conn: await connectionStatus(db, actor.orgId), linked: await alreadyLinked(db, actor.orgId) };
  });
  const owners = Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, base.ws.capabilities[IMPORT_CAPABILITY[e]]])) as Record<GhlMigrationEntity, "native" | "ghl">;
  const plan: GhlMigrationPlan = {
    connected: base.conn.connected, reason: base.conn.reason, locationName: base.conn.locationName, checkedAt: new Date().toISOString(), requests: 0,
    entities: GHL_MIGRATION_ENTITIES.map((entity) => ({
      entity, label: GHL_ENTITY_LABELS[entity].many, status: "unavailable", count: null, countKind: "unknown", detail: null,
      endpoint: GHL_MIGRATION_ENDPOINTS[entity].path, scope: GHL_MIGRATION_ENDPOINTS[entity].scope, alreadyLinked: base.linked[entity], owner: owners[entity],
    })),
    owners: { status: "not_checked", ghlUsers: 0, matched: 0, unmatched: 0 },
    appointments: { status: "not_checked", calendars: null, note: "Appointments are not copied by this migration. Connect calendars natively in Settings → Calendars." },
    notMigrated: GHL_NOT_MIGRATED,
    can: { dryRun: canDryRun(actor) && actor.kind !== "agent", import: canImport(actor) },
  };
  if (!base.conn.connected) return plan;
  const mapping = await withSystem((db) => loadGhlMigrationMapping(db, actor.orgId));
  if (!mapping) return { ...plan, connected: false, reason: "The GoHighLevel token for this workspace can't be used. Ask iAcquire support to reconnect it." };
  const r = reader(mapping);
  let stopped: string | null = null;
  try {
    const identity = await verifyLocation(r.get, mapping);
    plan.locationName = identity.name ?? plan.locationName;
    for (const e of plan.entities) {
      if (stopped) {
        e.status = "rate_limited";
        e.detail = stopped;
        continue;
      }
      try {
        await countEntity(e, mapping, r.get);
      } catch (err) {
        if (err instanceof GhlRateLimitError) {
          stopped = `GoHighLevel asked iAcquire to slow down. Preview again in ${Math.ceil(err.retryAfterMs / 1000)} seconds.`;
          e.status = "rate_limited";
          e.detail = stopped;
        } else if (err instanceof GhlReadError) {
          e.status = err.kind === "forbidden" ? "forbidden" : err.kind === "not_found" ? "unavailable" : "error";
          e.detail = err.kind === "forbidden" ? `The token can't read this (scope ${e.scope}).` : err.message;
        } else throw err;
      }
    }
    if (!stopped) {
      try {
        const users = await readUsers(r.get, mapping, identity.companyId);
        if (users.readable) {
          const members = await withSystem((db) => db.query<{ email: string }>("select lower(u.email::text) as email from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.status = 'active'", [actor.orgId]));
          const set = new Set(members.rows.map((m) => m.email));
          const emails = Object.values(users.users);
          plan.owners = { status: "ok", ghlUsers: users.count, matched: emails.filter((e) => set.has(e)).length, unmatched: users.count - emails.filter((e) => set.has(e)).length };
        } else plan.owners = { status: "unavailable", ghlUsers: 0, matched: 0, unmatched: 0 };
        const cal = await r.get("/calendars/", { locationId: mapping.locationId }, GHL_VERSIONS.calendars);
        plan.appointments = { ...plan.appointments, status: "ok", calendars: scopeGhlRows<{ id: string }>(cal.calendars, mapping).length };
      } catch (err) {
        if (!(err instanceof GhlRateLimitError || err instanceof GhlReadError)) throw err;
        if (plan.appointments.status === "not_checked") plan.appointments = { ...plan.appointments, status: "unavailable" };
      }
    }
  } catch (err) {
    if (err instanceof GhlRateLimitError) return { ...plan, requests: r.state.requests, reason: `GoHighLevel asked iAcquire to slow down. Preview again in ${Math.ceil(err.retryAfterMs / 1000)} seconds.` };
    if (err instanceof GhlReadError) return { ...plan, requests: r.state.requests, connected: err.kind !== "forbidden", reason: err.kind === "forbidden" ? "GoHighLevel refused the stored token for this location. Ask iAcquire support to reconnect it." : err.message };
    throw err;
  }
  plan.requests = r.state.requests;
  await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.ghl_migration_previewed", targetType: "crm_workspace", targetId: actor.orgId, result: "success", metadata: { requests: plan.requests, counts: Object.fromEntries(plan.entities.map((e) => [e.entity, e.count])) } });
  return plan;
}

async function countEntity(e: GhlPlanEntity, m: GhlMapping, get: Get) {
  if (e.entity === "custom_field" || e.entity === "tag" || e.entity === "pipeline") {
    const page = await readPage(e.entity, m, get, {}, {});
    e.status = "ok";
    e.count = page.rows.length;
    e.countKind = "exact";
    if (e.entity === "pipeline") e.detail = `${page.rows.reduce((n, p) => n + (Array.isArray(p.stages) ? p.stages.length : 0), 0)} stages in total.`;
    if (e.entity === "custom_field") {
      e.unsupported = page.rows
        .filter((f) => !ghlFieldType(str(f.data_type), Array.isArray(f.options) ? (f.options as string[]) : []) || !["contact", "opportunity", ""].includes(str(f.model)))
        .map((f) => ({ name: str(f.name, 80), type: ["contact", "opportunity", ""].includes(str(f.model)) ? str(f.data_type, 40) : `${str(f.model, 40)} object` }))
        .slice(0, 50);
      if (e.unsupported.length) e.detail = `${e.unsupported.length} can't be created here (unsupported type or custom object).`;
    }
    return;
  }
  if (e.entity === "contact" || e.entity === "opportunity") {
    // One small page first: GoHighLevel reports a total in meta.total when it can.
    const params: Record<string, string> = e.entity === "contact" ? { locationId: m.locationId, limit: "1" } : { location_id: m.locationId, limit: "1", status: "all" };
    const body = await get(e.entity === "contact" ? "/contacts/" : "/opportunities/search", params);
    scopeGhlRows(e.entity === "contact" ? body.contacts : body.opportunities, m);
    const total = obj(body.meta).total;
    if (typeof total === "number" && total >= 0) {
      e.status = "ok";
      e.count = total;
      e.countKind = "exact";
      return;
    }
  }
  // No total: a capped scan, honestly labelled.
  let cursor: Cursor = {};
  let n = 0;
  for (let i = 0; i < PLAN_SCAN_PAGES; i++) {
    const page = await readPage(e.entity, m, get, cursor, {}, { details: false });
    n += page.rows.length;
    if (!page.next) {
      e.status = "ok";
      e.count = n;
      e.countKind = "exact";
      return;
    }
    cursor = page.next;
  }
  e.status = "ok";
  e.count = n;
  e.countKind = "at_least";
  e.detail = `Counted the first ${n.toLocaleString("en-US")}; the dry run reads them all.`;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const LIVE = ["fetching", "validating", "validated", "importing", "rolling_back"];

/**
 * Starts one migration step: a GoHighLevel import job that reads its records (GET only) and runs its dry run by itself. Allowed while
 * GoHighLevel still owns the capability (the dry run writes no CRM records). `switchId` ties the job to a provider switch.
 *
 * A step whose latest run stopped while reading (GoHighLevel kept failing, say) carries on from where it stopped instead of reading
 * everything again: the rows it staged stay and the stored cursor picks up the next page. Any other step reads GoHighLevel afresh; a step
 * that was imported is read again and matched to what it created (crm_external_ids), so nothing is duplicated.
 */
export async function createGhlImportJob(actor: CrmActor, opts: { entity: GhlMigrationEntity; switchId?: string | null; duplicates?: NonNullable<ImportOptions["duplicates"]>; switchControl?: boolean }): Promise<ImportJobView> {
  assertDryRun(actor);
  if (!isGhlMigrationEntity(opts.entity)) throw new AppError("invalid_input", "Choose a migration step.");
  const duplicates = opts.duplicates ?? "update";
  if (!["update", "review", "skip"].includes(duplicates)) throw new AppError("invalid_input", "Choose what happens when a record already exists here.");
  if (opts.switchId && !/^[0-9a-f-]{36}$/i.test(opts.switchId)) throw new AppError("invalid_input", "That provider switch isn't valid.");
  if (opts.switchControl && !opts.switchId) throw new AppError("invalid_input", "A provider switch must own this migration step.");
  const mapping = await withSystem((db) => loadGhlMigrationMapping(db, actor.orgId));
  if (!mapping) throw new AppError("integration_unavailable", "No usable GoHighLevel connection for this workspace. iAcquire support connects your own location read-only.");
  return crmWrite(actor, async (db) => {
    await loadWorkspace(db, actor.orgId);
    if (!opts.switchControl) await lockPanelForActiveSwitch(db, actor.orgId);
    await db.query("select pg_advisory_xact_lock(hashtext('crm-ghl-migration:' || $1::text || ':' || $2::text))", [actor.orgId, opts.entity]);
    // Any run of the step still going (an earlier run being undone included) holds the step.
    const running = await db.query<{ id: string; status: string }>("select id, status from crm_import_jobs where org_id = $1 and source = 'ghl_api' and entity = $2 and status = any($3::text[]) order by created_at desc limit 1", [actor.orgId, opts.entity, LIVE]);
    if (running.rows[0]) throw new AppError("conflict", `The ${GHL_ENTITY_LABELS[opts.entity].many.toLowerCase()} step is already ${running.rows[0].status === "validated" ? "checked and waiting to be imported" : running.rows[0].status === "rolling_back" ? "being undone" : "running"}. Finish or cancel it first.`);
    const last = (await db.query<{ id: string; status: string; fetched_at: Date | null; source_location: string | null; switch_id: string | null }>(
      "select id, status, fetched_at, source_location, switch_id from crm_import_jobs where org_id = $1 and source = 'ghl_api' and entity = $2 order by created_at desc limit 1",
      [actor.orgId, opts.entity],
    )).rows[0];
    if (last && last.status === "failed" && !last.fetched_at && last.source_location === mapping.locationId && (last.switch_id ?? null) === (opts.switchId ?? null)) {
      const resumed = await resumeGhlImportJobInTx(db, actor, last.id, { duplicates });
      if (resumed) {
        await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.ghl_migration_step_resumed", targetType: "crm_import_job", targetId: resumed.id, result: "success", metadata: { entity: opts.entity, staged: resumed.totalRows, duplicates } }, db);
        return resumed;
      }
    }
    const job = await createGhlImportJobInTx(db, actor, { entity: opts.entity, sourceLocation: mapping.locationId, switchId: opts.switchId ?? null, duplicates, label: `GoHighLevel: ${GHL_ENTITY_LABELS[opts.entity].many}` });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.ghl_migration_job_created", targetType: "crm_import_job", targetId: job.id, result: "success", metadata: { entity: opts.entity, switchId: opts.switchId ?? null, duplicates } }, db);
    return job;
  });
}

/**
 * Starts the dry run of the steps that still need one, in order: a step never run, or whose latest run failed, was undone, or was cancelled
 * before it imported anything. A step that is running, waiting to be imported, imported, or cancelled part way through its import is left
 * alone (its run, and its Undo, stay the ones the panel shows). Reading an imported step again is explicit: createGhlImportJob for that
 * step ("Run this step again"). Returns the latest job of every step.
 */
export async function createGhlMigrationRun(actor: CrmActor, opts: { switchId?: string | null; duplicates?: NonNullable<ImportOptions["duplicates"]> } = {}): Promise<ImportJobView[]> {
  assertDryRun(actor);
  const { remaining } = await stepRuns(actor);
  for (const entity of remaining) await createGhlImportJob(actor, { entity, switchId: opts.switchId ?? null, duplicates: opts.duplicates });
  return Object.values((await stepJobs(actor)).latest).filter((j): j is ImportJobView => !!j);
}

type StepRun = { id: string; entity: GhlMigrationEntity; status: string; has_undo: boolean };

/**
 * Per step: its latest run, the run its Undo acts on (the latest when that one has something to undo; otherwise the newest earlier run
 * that does, once nothing newer is running, because runs of a step are undone newest first), and the steps the bulk dry run would start.
 */
async function stepRuns(actor: CrmActor): Promise<{ latest: Record<GhlMigrationEntity, string | null>; undo: Record<GhlMigrationEntity, string | null>; remaining: GhlMigrationEntity[] }> {
  const runs = await crmRead(actor, async (db) =>
    (await db.query<StepRun>(
      `select j.id, j.entity, j.status, ${HAS_UNDO_SQL} as has_undo from crm_import_jobs j where j.org_id = $1 and j.source = 'ghl_api' order by j.entity, j.created_at desc`,
      [actor.orgId],
    )).rows,
  );
  const latest = {} as Record<GhlMigrationEntity, string | null>;
  const undo = {} as Record<GhlMigrationEntity, string | null>;
  const remaining: GhlMigrationEntity[] = [];
  for (const e of GHL_MIGRATION_ENTITIES) {
    const mine = runs.filter((r) => r.entity === e);
    const top = mine[0];
    latest[e] = top?.id ?? null;
    // A run with something to undo, or being undone now (so the panel can follow an earlier run's undo too).
    const undoable = (r: StepRun) => ((r.status === "completed" || r.status === "cancelled") && r.has_undo) || r.status === "rolling_back";
    undo[e] = top && undoable(top) ? top.id : top && !LIVE.includes(top.status) ? mine.find(undoable)?.id ?? null : null;
    const busy = mine.some((r) => LIVE.includes(r.status));
    if (!busy && (!top || top.status === "failed" || top.status === "rolled_back" || (top.status === "cancelled" && !top.has_undo))) remaining.push(e);
  }
  return { latest, undo, remaining };
}

async function stepJobs(actor: CrmActor): Promise<{ latest: Record<GhlMigrationEntity, ImportJobView | null>; undo: Record<GhlMigrationEntity, ImportJobView | null>; remaining: GhlMigrationEntity[] }> {
  const runs = await stepRuns(actor);
  const ids = [...new Set([...Object.values(runs.latest), ...Object.values(runs.undo)].filter((id): id is string => !!id))];
  const all = ids.length ? await getImportJobs(actor, ids) : [];
  const view = (id: string | null) => (id ? all.find((j) => j.id === id) ?? null : null);
  return {
    latest: Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, view(runs.latest[e])])) as Record<GhlMigrationEntity, ImportJobView | null>,
    undo: Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, view(runs.undo[e])])) as Record<GhlMigrationEntity, ImportJobView | null>,
    remaining: runs.remaining,
  };
}

/** Runs a step's dry run again (for example after the steps before it were imported). */
export async function checkGhlImportAgain(actor: CrmActor, jobId: string): Promise<void> {
  assertDryRun(actor);
  await crmWrite(actor, async (db) => {
    await lockPanelForActiveSwitch(db, actor.orgId);
    await ownGhlJob(db, actor, jobId);
    await revalidateImportInTx(db, actor, jobId);
  });
}

async function ownGhlJob(db: Queryable, actor: CrmActor, jobId: string) {
  const { rows } = await db.query<{ id: string; entity: string; status: string; validated_at: Date | null; switch_id: string | null }>(
    "select id, entity, status, validated_at, switch_id from crm_import_jobs where id = $1 and org_id = $2 and source = 'ghl_api' for update",
    [jobId, actor.orgId],
  );
  if (!rows[0] || !isGhlMigrationEntity(rows[0].entity)) throw new AppError("not_found", "Migration step not found.");
  return { ...rows[0], entity: rows[0].entity as GhlMigrationEntity };
}

/**
 * The real run of one step, after its dry run. Only the owner (or a super admin's write session). Refused while GoHighLevel owns the
 * capability (a provider switch moves it to iAcquire first) and until the steps it depends on are imported. When those finished after
 * this step's dry run, the dry run is repeated first and the person starts the import again once it is done.
 */
export async function startGhlImport(actor: CrmActor, jobId: string, opts: { switchControl?: boolean } = {}): Promise<{ started: boolean; recheck: boolean }> {
  assertImport(actor);
  return crmWrite(actor, async (db) => {
    if (!opts.switchControl) await lockPanelForActiveSwitch(db, actor.orgId);
    const job = await ownGhlJob(db, actor, jobId);
    if (opts.switchControl && !job.switch_id) throw new AppError("conflict", "This step isn't part of the provider switch.");
    if (job.status === "importing" || job.status === "completed") return { started: true, recheck: false };
    if (job.status !== "validated") throw new AppError("conflict", "The dry run must finish before this step is imported.");
    try {
      await assertNativeOwner(db, actor.orgId, IMPORT_CAPABILITY[job.entity]);
    } catch (err) {
      if (err instanceof AppError && err.code === "conflict") {
        throw new AppError("conflict", `GoHighLevel still owns ${GHL_ENTITY_LABELS[job.entity].many.toLowerCase()} in this workspace. The import runs once that part of the CRM moves to iAcquire (Settings → CRM provider); the dry run is ready.`);
      }
      throw err;
    }
    let newest: Date | null = null;
    for (const dep of [...GHL_PREREQUISITES[job.entity], ...GHL_OPTIONAL_PREREQUISITES[job.entity]]) {
      const optional = !GHL_PREREQUISITES[job.entity].includes(dep);
      const { rows } = await db.query<{ status: string; completed_at: Date | null }>(
        "select status, completed_at from crm_import_jobs where org_id = $1 and source = 'ghl_api' and entity = $2 and status not in ('cancelled', 'failed', 'rolled_back') order by created_at desc limit 1",
        [actor.orgId, dep],
      );
      const d = rows[0];
      if (!d && optional) continue;
      if (!d || d.status !== "completed") throw new AppError("conflict", `Import the ${GHL_ENTITY_LABELS[dep].many.toLowerCase()} step first${d ? " (it hasn't finished)" : ""}.`);
      if (d.completed_at && (!newest || d.completed_at > newest)) newest = d.completed_at;
    }
    if (newest && job.validated_at && newest > job.validated_at) {
      await revalidateImportInTx(db, actor, jobId);
      return { started: false, recheck: true };
    }
    await startImportInTx(db, actor, jobId);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.ghl_migration_import_started", targetType: "crm_import_job", targetId: jobId, result: "success", metadata: { entity: job.entity } }, db);
    return { started: true, recheck: false };
  });
}

/** Undoes one imported step (reverse order; records changed since the import are kept as needs review). Owner only. */
export async function rollbackGhlImport(actor: CrmActor, jobId: string, opts: { switchControl?: boolean } = {}): Promise<void> {
  assertImport(actor);
  await crmRead(actor, async (db) => {
    const { rows } = await db.query("select 1 from crm_import_jobs where id = $1 and org_id = $2 and source = 'ghl_api'", [jobId, actor.orgId]);
    if (!rows.length) throw new AppError("not_found", "Migration step not found.");
  });
  await rollbackImport(actor, jobId, opts.switchControl ? {} : { beforeGhlRollback: (db) => lockPanelForActiveSwitch(db, actor.orgId) });
}

/**
 * Cancels a step that hasn't finished: a read of GoHighLevel stops before its next page is staged, a dry run or a step waiting to be
 * imported stops (the step can then be read again), and a running import stops after its current rows (what it imported stays and can
 * be undone). Stopping a real import is the owner's call, like starting it; stopping a read or a dry run is anyone's who may dry run.
 */
export async function cancelGhlStep(actor: CrmActor, jobId: string): Promise<void> {
  assertDryRun(actor);
  await crmWrite(actor, async (db) => {
    await lockPanelForActiveSwitch(db, actor.orgId);
    const job = await ownGhlJob(db, actor, jobId);
    if (job.status === "importing") assertImport(actor);
    await cancelImportInTx(db, actor, jobId);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.ghl_migration_step_cancelled", targetType: "crm_import_job", targetId: jobId, result: "success", metadata: { entity: job.entity, from: job.status } }, db);
  });
}

/** Moves the given running steps forward one chunk each (the browser's progress polling; the scheduler does the same). */
export async function advanceGhlMigration(actor: CrmActor, jobIds: string[]): Promise<void> {
  if (!canDryRun(actor) && !canImport(actor)) assertCan(actor, "contacts.import");
  refuseReadSession(actor);
  const own = await crmRead(actor, async (db) => (await db.query<{ id: string }>("select id from crm_import_jobs where org_id = $1 and source = 'ghl_api' and id = any($2::uuid[]) and status = any($3::text[])", [actor.orgId, jobIds.slice(0, 12), ["fetching", "validating", "importing", "rolling_back"]])).rows);
  for (const j of own) await advanceImport(j.id);
}

// ---------------------------------------------------------------------------
// Gap report and side-by-side comparison
// ---------------------------------------------------------------------------

export interface GhlComparisonRow {
  entity: GhlMigrationEntity;
  label: string;
  jobId: string | null;
  status: string | null;
  /**
   * Records GoHighLevel holds, and what kind of number that is: "reported" (a total GoHighLevel gave), "listed" (no total, but the whole
   * list was read, so it is what GoHighLevel listed), "at_least" (no total, and reading stopped early, failed or was cancelled: there may be
   * more), or null while a step is still reading without a total.
   */
  sourceCount: number | null;
  sourceCountKind: "reported" | "listed" | "at_least" | null;
  /** Records the step read and staged. */
  staged: number;
  /** Native records linked to a GoHighLevel record of this kind that still exist (all runs). */
  destinationCount: number;
  /** Created or linked by this step. */
  mapped: number;
  created: number;
  linked: number;
  skipped: number;
  failed: number;
  needsReview: number;
  /** Dry-run forecast while the step isn't imported yet. */
  planned: { create: number; update: number; skip: number; review: number; invalid: number };
  flags: Record<string, number>;
  unsupported: Array<{ name: string; type: string }>;
  rolledBack: number;
  truncated: boolean;
}

export interface GhlMigrationComparison {
  generatedAt: string;
  rows: GhlComparisonRow[];
  notMigrated: ReadonlyArray<{ what: string; why: string }>;
}

type ComparedJob = { id: string; entity: GhlMigrationEntity; status: string; total_rows: number; fetch_state: ImportFetchState; fetched_at: Date | null };

/** What the comparison can honestly say GoHighLevel holds for a step (see GhlComparisonRow.sourceCountKind). */
function sourceCountOf(j: ComparedJob): Pick<GhlComparisonRow, "sourceCount" | "sourceCountKind"> {
  const total = j.fetch_state?.sourceTotal;
  if (typeof total === "number") return { sourceCount: total, sourceCountKind: j.fetch_state?.sourceTotalFrom === "list" ? "listed" : "reported" };
  if (j.status === "fetching") return { sourceCount: null, sourceCountKind: null };
  if (j.fetched_at && j.fetch_state?.truncated !== true) return { sourceCount: j.total_rows, sourceCountKind: "listed" };
  return { sourceCount: j.total_rows, sourceCountKind: "at_least" };
}

/**
 * Per step, side by side: what GoHighLevel holds, what was staged, what exists natively now, and how every staged record ended (mapped,
 * skipped, failed, needs review), with the notes the gap report lists. Counts come from the rows themselves, never from estimates.
 * Without job ids, the latest job of every step.
 */
export async function ghlMigrationComparison(actor: CrmActor, jobIds?: string[]): Promise<GhlMigrationComparison> {
  refuseReadSession(actor);
  if (!canDryRun(actor) && !canImport(actor)) assertCan(actor, "contacts.import");
  return crmRead(actor, async (db) => {
    const jobs = jobIds?.length
      ? (await db.query<ComparedJob>(
          "select id, entity, status, total_rows, fetch_state, fetched_at from crm_import_jobs where org_id = $1 and source = 'ghl_api' and id = any($2::uuid[])",
          [actor.orgId, jobIds.slice(0, 60)],
        )).rows
      : (await db.query<ComparedJob>(
          "select distinct on (entity) id, entity, status, total_rows, fetch_state, fetched_at from crm_import_jobs where org_id = $1 and source = 'ghl_api' order by entity, created_at desc",
          [actor.orgId],
        )).rows;
    const rows: GhlComparisonRow[] = [];
    for (const entity of GHL_MIGRATION_ENTITIES) {
      const j = jobs.find((x) => x.entity === entity) ?? null;
      const row: GhlComparisonRow = {
        entity, label: GHL_ENTITY_LABELS[entity].many, jobId: j?.id ?? null, status: j?.status ?? null, sourceCount: null, sourceCountKind: null, staged: j?.total_rows ?? 0,
        destinationCount: await destinationCount(db, actor.orgId, entity), mapped: 0, created: 0, linked: 0, skipped: 0, failed: 0, needsReview: 0,
        planned: { create: 0, update: 0, skip: 0, review: 0, invalid: 0 }, flags: {}, unsupported: [], rolledBack: 0, truncated: j?.fetch_state?.truncated === true,
      };
      if (j) {
        Object.assign(row, sourceCountOf(j));
        const s = await db.query<{ status: string; planned_action: string | null; n: string }>("select status, planned_action, count(*)::text as n from crm_import_rows where job_id = $1 and org_id = $2 group by 1, 2", [j.id, actor.orgId]);
        const c = (pred: (x: { status: string; planned_action: string | null }) => boolean) => s.rows.filter(pred).reduce((acc, x) => acc + Number(x.n), 0);
        row.created = c((x) => x.status === "created");
        row.linked = c((x) => x.status === "updated");
        row.mapped = row.created + row.linked;
        row.skipped = c((x) => x.status === "skipped" || x.status === "duplicate");
        row.failed = c((x) => x.status === "failed" || x.status === "invalid");
        row.needsReview = c((x) => x.status === "needs_review");
        row.rolledBack = c((x) => x.status === "rolled_back");
        row.planned = {
          create: c((x) => x.status === "valid" && x.planned_action === "create"), update: c((x) => x.status === "valid" && x.planned_action === "update"),
          skip: c((x) => (x.status === "valid" && x.planned_action === "skip") || x.status === "duplicate"), review: c((x) => x.status === "valid" && x.planned_action === "review"),
          invalid: c((x) => x.status === "invalid"),
        };
        const f = await db.query<{ f: string; n: string }>("select f, count(*)::text as n from crm_import_rows r, unnest(r.flags) f where r.job_id = $1 and r.org_id = $2 group by f", [j.id, actor.orgId]);
        row.flags = Object.fromEntries(f.rows.map((x) => [x.f, Number(x.n)]));
        if (entity === "custom_field") {
          const u = await db.query<{ name: string; type: string; model: string | null }>(
            "select data->>'name' as name, data->>'data_type' as type, data->>'model' as model from crm_import_rows where job_id = $1 and org_id = $2 and (flags && array['unsupported_type', 'unsupported_object']) order by row_number limit 50",
            [j.id, actor.orgId],
          );
          row.unsupported = u.rows.map((x) => ({ name: (x.name ?? "").slice(0, 80), type: x.model && !["contact", "opportunity"].includes(x.model) ? `${x.model.slice(0, 40)} object` : (x.type ?? "").slice(0, 40) }));
        }
      }
      rows.push(row);
    }
    return { generatedAt: new Date().toISOString(), rows, notMigrated: GHL_NOT_MIGRATED };
  });
}

// ---------------------------------------------------------------------------
// The panel's state
// ---------------------------------------------------------------------------

export interface GhlMigrationState {
  connected: boolean;
  reason: string | null;
  locationName: string | null;
  switching: boolean;
  switchActive: boolean;
  owners: Record<GhlMigrationEntity, "native" | "ghl">;
  /** The latest run of every step. */
  jobs: Record<GhlMigrationEntity, ImportJobView | null>;
  /** The run each step's Undo acts on: the latest run, or an earlier one when the latest has nothing to undo (see stepRuns). */
  undo: Record<GhlMigrationEntity, ImportJobView | null>;
  /** The steps "Dry run the remaining steps" would start (createGhlMigrationRun). */
  remaining: GhlMigrationEntity[];
  comparison: GhlMigrationComparison | null;
  can: { preview: boolean; dryRun: boolean; import: boolean };
  host: string;
}

/** What the migration panel shows. Reads the database only (no GoHighLevel request). */
export async function getGhlMigrationState(actor: CrmActor): Promise<GhlMigrationState> {
  assertCan(actor, "crm.view");
  const readSession = actor.kind === "agency" && actor.supportMode !== "write";
  const base = await withSystem(async (db) => ({
    ws: await loadWorkspace(db, actor.orgId),
    conn: await connectionStatus(db, actor.orgId),
    switchActive: await hasActiveProviderSwitch(db, actor.orgId),
  }));
  const owners = Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, base.ws.capabilities[IMPORT_CAPABILITY[e]]])) as Record<GhlMigrationEntity, "native" | "ghl">;
  const mayDryRun = !readSession && canDryRun(actor);
  const none = Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, null])) as Record<GhlMigrationEntity, ImportJobView | null>;
  const steps = mayDryRun ? await stepJobs(actor) : { latest: none, undo: none, remaining: [] as GhlMigrationEntity[] };
  const jobs = steps.latest;
  return {
    connected: base.conn.connected, reason: base.conn.reason, locationName: base.conn.locationName, switching: base.ws.switching, switchActive: base.switchActive, owners, jobs, undo: steps.undo, remaining: steps.remaining,
    comparison: mayDryRun && Object.values(jobs).some(Boolean) ? await ghlMigrationComparison(actor) : null,
    can: { preview: !readSession && canPreview(actor), dryRun: mayDryRun, import: !readSession && canImport(actor) },
    host: GHL_API_ORIGIN,
  };
}
