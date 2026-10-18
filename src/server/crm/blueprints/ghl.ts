import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { resolveCredential, revokeCredential, saveCredential } from "@/server/security/credentials";
import { authorizeBlueprintAction, canReachClient, isUuid, needBlueprintAction, type AgencyUser } from "@/server/crm/blueprints/access";
import { assertImportableLocation, readGhlInventory, type GhlReaderOptions } from "@/server/crm/blueprints/ghl-read";
import { convertGhlInventory, ghlBlueprintMeta, type GhlConversion } from "@/lib/crm/blueprints/ghl/convert";
import { GHL_IMPORT_SCOPES, GHL_KIND_INFO, GHL_LOCATION_RE, GHL_READ_ORDER, isProtectedGhlLocation, type GhlInventory } from "@/lib/crm/blueprints/ghl/inventory";
import { totalAssets } from "@/lib/crm/blueprints/requirements";
import type { GhlSourceView, ImportDetail } from "@/lib/crm/blueprints/views";

// Importing configuration from GoHighLevel through its official, documented, read-only API: a client's connected location, or an
// agency-owned template sub-account (the place a GoHighLevel snapshot is installed). Every call is a GET to services.leadconnectorhq.com
// (src/server/crm/blueprints/ghl-read.ts); nothing is ever written to GoHighLevel, and the protected locations are refused before any request.
//
// Sources:
//   "client:<orgId>"   a client's own GoHighLevel connection, verified in Integrations (status connected or permission limited). Importing
//                      from it is a client step: the person must reach that client (super admins reach every client).
//   "agency:<id>"      a template sub-account the agency keeps for building snapshots (crm_blueprint_ghl_sources), connected with a
//                      read-only private integration token saved in the credential vault as an agency credential (org null).
// Tokens are resolved from the vault for the duration of one read, held in memory only, and never stored elsewhere, returned, logged or
// audited. An import records a previewed Blueprint proposal with its compatibility report; GoHighLevel IDs stay in its source_refs.

/** A read-only GoHighLevel scope. Some are camelCase ("locations/customFields.readonly"). */
const SCOPE_RE = /^[a-z][A-Za-z0-9./-]{2,60}\.readonly$/;
const PG_CODES: Record<string, AppError> = {
  blueprint_source_is_client_location: new AppError("conflict", "This GoHighLevel location is connected to a client workspace. Import from that client instead."),
  blueprint_source_credential_invalid: new AppError("integration_unavailable", "The token couldn't be stored as an agency credential. Save it again."),
};

/** "abc…xyz": enough to recognise a location without displaying its ID. */
export function maskLocation(locationId: string): string {
  return locationId.length <= 8 ? "…" : `${locationId.slice(0, 3)}…${locationId.slice(-3)}`;
}

export type ParsedSourceRef = { kind: "client"; orgId: string } | { kind: "agency"; sourceId: string };

/** A GhlSourceView.ref, checked. */
export function parseGhlSourceRef(ref: unknown): ParsedSourceRef {
  const m = typeof ref === "string" ? /^(client|agency):(.+)$/.exec(ref) : null;
  if (!m || !isUuid(m[2])) throw new AppError("invalid_input", "Choose a GoHighLevel source.");
  return m[1] === "client" ? { kind: "client", orgId: m[2].toLowerCase() } : { kind: "agency", sourceId: m[2].toLowerCase() };
}

const scopesOf = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string" && SCOPE_RE.test(s)))].sort() : []);
const missingScopes = (scopes: string[]) => GHL_IMPORT_SCOPES.filter((s) => !scopes.includes(s));
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

function mapDbError(e: unknown): never {
  const msg = e instanceof Error ? e.message : "";
  for (const [code, err] of Object.entries(PG_CODES)) if (msg.includes(code)) throw err;
  if (/duplicate key|unique/i.test(msg)) throw new AppError("conflict", "This GoHighLevel location is already saved as a template source.");
  throw e;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface ClientSourceRow {
  org_id: string;
  name: string;
  status: string;
  config: Record<string, unknown> | null;
  credential_id: string | null;
  location_id: string;
  mapping_status: string;
  verified_at: Date | null;
}

interface AgencySourceRow {
  id: string;
  label: string;
  location_id: string;
  credential_id: string | null;
  scopes: string[];
  status: string;
  location_name: string | null;
  timezone: string | null;
  verified_at: Date | null;
  last_error: string | null;
}

const CLIENT_SOURCE_SQL = `
  select c.org_id, o.name, c.status, c.config, c.credential_id, g.location_id, g.status as mapping_status, g.verified_at
  from integration_connections c
  join organizations o on o.id = c.org_id and o.kind = 'client'
  join ghl_location_mappings g on g.org_id = c.org_id
  where c.provider = 'ghl'`;

const clientView = (r: ClientSourceRow): GhlSourceView => {
  const scopes = scopesOf(r.config?.scopes);
  return {
    ref: `client:${r.org_id}`, kind: "ghl_client", label: r.name, locationHint: maskLocation(r.location_id), status: r.status, verifiedAt: iso(r.verified_at),
    scopes, missingScopes: missingScopes(scopes),
  };
};

const agencyView = (r: AgencySourceRow): GhlSourceView => {
  const scopes = scopesOf(r.scopes);
  return {
    ref: `agency:${r.id}`, kind: "ghl_agency_source", label: r.label, locationHint: maskLocation(r.location_id), status: r.status, verifiedAt: iso(r.verified_at),
    scopes, missingScopes: missingScopes(scopes),
  };
};

/** A client connection can be imported from only when it was verified and still points at the mapped location. */
function usableClientSource(r: ClientSourceRow): string | null {
  if (!["connected", "permission_limited"].includes(r.status)) return "This client's GoHighLevel connection hasn't been verified. Test it in the client's Integrations first.";
  if (!r.credential_id) return "This client's GoHighLevel connection has no stored token. Reconnect it in Integrations.";
  if (r.mapping_status === "disabled") return "This client's GoHighLevel location mapping is switched off.";
  if (typeof r.config?.locationId !== "string" || r.config.locationId !== r.location_id) return "This client's GoHighLevel connection and location mapping don't match. Save the connection again.";
  return null;
}

/** Sources the person can import from: verified client connections they can reach, and agency template sub-accounts. */
export async function listGhlSources(user: AgencyUser): Promise<GhlSourceView[]> {
  needBlueprintAction(user, "import_ghl");
  const { clients, agency } = await withSystem(async (db) => ({
    clients: (await db.query<ClientSourceRow>(`${CLIENT_SOURCE_SQL} and o.status <> 'archived' order by lower(o.name)`)).rows,
    agency: (await db.query<AgencySourceRow>("select * from crm_blueprint_ghl_sources where status <> 'disconnected' order by lower(label), created_at")).rows,
  }));
  const out: GhlSourceView[] = [];
  for (const r of clients) {
    if (isProtectedGhlLocation(r.location_id) || usableClientSource(r)) continue;
    if (!(await canReachClient(user, r.org_id))) continue;
    out.push(clientView(r));
  }
  for (const r of agency) if (!isProtectedGhlLocation(r.location_id)) out.push(agencyView(r));
  return out;
}

const sourceInputSchema = z.strictObject({
  label: z.string().trim().min(1, "Name this template sub-account.").max(120, "Keep the name to 120 characters."),
  locationId: z.string().trim().regex(GHL_LOCATION_RE, "Enter the sub-account's location ID (10 to 40 letters and digits)."),
  token: z.string().trim().min(16, "Paste the private integration token.").max(4096, "That doesn't look like a private integration token.").regex(/^\S+$/, "That doesn't look like a private integration token."),
  scopes: z.array(z.string().regex(SCOPE_RE, "Only read-only scopes can be used.")).max(30, "Choose at most 30 scopes."),
});

/** Saves an agency template sub-account with a read-only private integration token (stored in the credential vault, never echoed). */
export async function saveGhlTemplateSource(user: AgencyUser, input: { label: string; locationId: string; token: string; scopes: string[] }): Promise<{ id: string }> {
  needBlueprintAction(user, "import_ghl");
  const parsed = sourceInputSchema.safeParse(input);
  // Zod issues never include the value; only the message is passed on.
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the template sub-account details.");
  const d = parsed.data;
  assertImportableLocation(d.locationId);
  const scopes = [...new Set(d.scopes)].sort();
  return withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "import_ghl");
    const mapped = await db.query("select 1 from ghl_location_mappings where location_id = $1", [d.locationId]);
    if (mapped.rows.length) throw PG_CODES.blueprint_source_is_client_location;
    const existing = (await db.query<{ id: string; credential_id: string | null }>("select id, credential_id from crm_blueprint_ghl_sources where location_id = $1 for update", [d.locationId])).rows[0];
    const credential = await saveCredential(db, { orgId: null, provider: "ghl", label: `Blueprint source: ${d.label}`.slice(0, 120), secret: d.token, scopes, actorId: user.id, replaces: existing?.credential_id ?? null });
    let id: string;
    if (existing) {
      await db.query(
        `update crm_blueprint_ghl_sources set label = $2, credential_id = $3, scopes = $4, status = 'credentials_saved', verified_at = null, last_error = null
         where id = $1`,
        [existing.id, d.label, credential.id, scopes],
      );
      id = existing.id;
    } else {
      id = (await db.query<{ id: string }>(
        "insert into crm_blueprint_ghl_sources (label, location_id, credential_id, scopes, status, created_by) values ($1, $2, $3, $4, 'credentials_saved', $5) returning id",
        [d.label, d.locationId, credential.id, scopes, user.id],
      )).rows[0].id;
    }
    await recordAudit({
      orgId: null, actorUserId: user.id, actorKind: "agency", action: existing ? "crm.blueprint_ghl_source_updated" : "crm.blueprint_ghl_source_saved", targetType: "crm_blueprint_ghl_source",
      targetId: id, result: "success", metadata: { location: maskLocation(d.locationId), scopes: scopes.length },
    }, db);
    return { id };
  }).catch(mapDbError);
}

async function loadAgencySource(db: Queryable, sourceId: string, lock: boolean): Promise<AgencySourceRow> {
  if (!isUuid(sourceId)) throw new AppError("not_found", "Template sub-account not found.");
  const row = (await db.query<AgencySourceRow>(`select * from crm_blueprint_ghl_sources where id = $1 ${lock ? "for update" : ""}`, [sourceId])).rows[0];
  if (!row || row.status === "disconnected") throw new AppError("not_found", "Template sub-account not found.");
  return row;
}

/** The source's token, from the vault. Never leaves the server; held only for one read. */
async function sourceToken(db: Queryable, credentialId: string | null, orgId: string | null): Promise<string> {
  if (!credentialId) throw new AppError("integration_unavailable", "No token is stored for this source. Save its token again.");
  const token = await resolveCredential(db, credentialId, orgId, "ghl");
  if (!token) throw new AppError("integration_unavailable", "The stored token is no longer available. Save the token again.");
  return token;
}

/** Readable kinds' scopes that worked in a read. */
function provenScopes(inv: GhlInventory): string[] {
  return ["locations.readonly", ...GHL_READ_ORDER.filter((k) => inv.kinds[k].status === "ok").map((k) => GHL_KIND_INFO[k].scope!).filter(Boolean)].sort();
}

/**
 * Checks the token against the location (one identity GET, then one small GET per configuration kind) and records which read scopes work.
 * A token that belongs to another location, or that GoHighLevel refuses, is recorded as an error and the reason is thrown.
 */
export async function testGhlTemplateSource(user: AgencyUser, sourceId: string, opts: GhlReaderOptions = {}): Promise<GhlSourceView> {
  needBlueprintAction(user, "import_ghl");
  const src = await withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "import_ghl");
    const row = await loadAgencySource(db, sourceId, false);
    assertImportableLocation(row.location_id);
    return { row, token: await sourceToken(db, row.credential_id, null) };
  });
  let inventory: GhlInventory;
  try {
    ({ inventory } = await readGhlInventory({ locationId: src.row.location_id, token: src.token }, { ...opts, probe: true }));
  } catch (e) {
    const reason = e instanceof AppError ? e.message : "GoHighLevel couldn't be checked.";
    await withSystem(async (db) => {
      await db.query("update crm_blueprint_ghl_sources set status = 'error', verified_at = null, last_error = $2 where id = $1", [src.row.id, reason.slice(0, 500)]);
      await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_ghl_source_tested", targetType: "crm_blueprint_ghl_source", targetId: src.row.id, result: "failure", metadata: { location: maskLocation(src.row.location_id), reason } }, db);
    });
    throw e;
  }
  const scopes = provenScopes(inventory);
  const failed = GHL_READ_ORDER.filter((k) => inventory.kinds[k].status !== "ok");
  const status = failed.length ? "permission_limited" : "connected";
  const detail = failed.length ? failed.map((k) => inventory.kinds[k].reason ?? GHL_KIND_INFO[k].label).join(" ").slice(0, 500) : null;
  const row = await withSystem(async (db) => {
    const updated = (await db.query<AgencySourceRow>(
      `update crm_blueprint_ghl_sources set status = $2, scopes = $3, location_name = $4, timezone = $5, verified_at = now(), last_error = $6
       where id = $1 and status <> 'disconnected' returning *`,
      [src.row.id, status, scopes, inventory.locationName?.slice(0, 200) ?? null, inventory.timezone, detail],
    )).rows[0];
    if (!updated) throw new AppError("not_found", "Template sub-account not found.");
    await recordAudit({
      orgId: null, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_ghl_source_tested", targetType: "crm_blueprint_ghl_source", targetId: src.row.id,
      result: "success", metadata: { location: maskLocation(src.row.location_id), status, provenScopes: scopes.length, limitedKinds: failed },
    }, db);
    return updated;
  });
  return agencyView(row);
}

/**
 * Removes the source and revokes its stored token in iAcquire. Nothing changes in GoHighLevel (revoke the private integration token there
 * too). A source that imports were made from is kept as a disconnected record for their history; otherwise it is deleted.
 */
export async function removeGhlTemplateSource(user: AgencyUser, sourceId: string): Promise<void> {
  needBlueprintAction(user, "import_ghl");
  await withSystem(async (db) => {
    await authorizeBlueprintAction(db, user, "import_ghl");
    const row = await loadAgencySource(db, sourceId, true);
    if (row.credential_id) await revokeCredential(db, row.credential_id, null, "ghl", user.id);
    const used = await db.query("select 1 from crm_blueprint_imports where ghl_source_id = $1 limit 1", [row.id]);
    if (used.rows.length) {
      await db.query("update crm_blueprint_ghl_sources set status = 'disconnected', credential_id = null, scopes = '{}', verified_at = null, last_error = null where id = $1", [row.id]);
    } else {
      await db.query("delete from crm_blueprint_ghl_sources where id = $1", [row.id]);
    }
    await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_ghl_source_removed", targetType: "crm_blueprint_ghl_source", targetId: row.id, result: "success", metadata: { location: maskLocation(row.location_id), kept: used.rows.length > 0 } }, db);
  });
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

const importInputSchema = z.strictObject({ sourceRef: z.string().max(200), includeValues: z.boolean(), includePlaceholders: z.boolean() });

interface ResolvedSource {
  sourceKind: "ghl_client" | "ghl_agency_source";
  orgId: string | null;
  sourceId: string | null;
  /**
   * What the import history stores. For a client's own location it never names the client: the library is shared with staff who aren't
   * assigned to that client, so the client's name is looked up when someone who can reach the client reads the import.
   */
  label: string;
  /** What the person running the import sees (the client's name for a client source: they can reach it). */
  displayLabel: string;
  locationId: string;
  token: string;
}

/** The stored label of an import from a client's own GoHighLevel location (the client is recorded by source_org_id). */
export const CLIENT_GHL_SOURCE_LABEL = "A client's GoHighLevel location";

export interface GhlImportDeps {
  reader?: GhlReaderOptions;
  now?: () => Date;
}

/**
 * Reads every supported configuration kind from the source, converts what the official API exposes, and records a previewed import with an
 * honest compatibility report. `sourceRef` is a GhlSourceView.ref. `includeValues` keeps custom values' contents (checked for secrets).
 */
export async function runGhlImport(user: AgencyUser, input: { sourceRef: string; includeValues: boolean; includePlaceholders: boolean }, deps: GhlImportDeps = {}): Promise<ImportDetail> {
  needBlueprintAction(user, "import_ghl");
  const parsed = importInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", "Choose a GoHighLevel source and the import options.");
  const opts = parsed.data;
  const ref = parseGhlSourceRef(opts.sourceRef);
  if (ref.kind === "client") needBlueprintAction(user, "import_ghl_client");

  let source: ResolvedSource;
  try {
    source = await withSystem(async (db): Promise<ResolvedSource> => {
      if (ref.kind === "client") {
        const org = (await authorizeBlueprintAction(db, user, "import_ghl_client", ref.orgId))!;
        const row = (await db.query<ClientSourceRow>(`${CLIENT_SOURCE_SQL} and c.org_id = $1`, [org.id])).rows[0];
        if (!row) throw new AppError("not_found", "This client has no GoHighLevel connection.");
        // The protected locations are refused before the token is even read.
        assertImportableLocation(row.location_id);
        const unusable = usableClientSource(row);
        if (unusable) throw new AppError("conflict", unusable);
        return {
          sourceKind: "ghl_client", orgId: org.id, sourceId: null, label: CLIENT_GHL_SOURCE_LABEL, displayLabel: org.name, locationId: row.location_id,
          token: await sourceToken(db, row.credential_id, org.id),
        };
      }
      await authorizeBlueprintAction(db, user, "import_ghl");
      const row = await loadAgencySource(db, ref.sourceId, false);
      assertImportableLocation(row.location_id);
      return { sourceKind: "ghl_agency_source", orgId: null, sourceId: row.id, label: row.label, displayLabel: row.label, locationId: row.location_id, token: await sourceToken(db, row.credential_id, null) };
    });
  } catch (e) {
    if (e instanceof AppError && e.code === "forbidden") {
      await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_ghl_import", result: "denied", metadata: { source: ref.kind, reason: e.message } });
    }
    throw e;
  }

  const now = deps.now?.() ?? new Date();
  let inventory: GhlInventory;
  let requests = 0;
  try {
    ({ inventory, requests } = await readGhlInventory({ locationId: source.locationId, token: source.token }, deps.reader ?? {}));
  } catch (e) {
    const reason = e instanceof AppError ? e.message : "GoHighLevel couldn't be read.";
    await recordFailedImport(user, source, reason);
    throw e;
  }

  const conversion = convertGhlInventory(inventory, {
    includeValues: opts.includeValues, includePlaceholders: opts.includePlaceholders,
    meta: ghlBlueprintMeta({ label: source.label, locationName: inventory.locationName, importedOn: now, clientSource: source.sourceKind === "ghl_client" }),
  });
  const hasContent = totalAssets(conversion.content) > 0;
  const kinds = Object.fromEntries(GHL_READ_ORDER.map((k) => [k, inventory.kinds[k].status]));
  const stored = fitImportForStorage(conversion);

  const row = await withSystem(async (db) => {
    // Re-checked inside the write: access removed while GoHighLevel was being read can't still record an import.
    await authorizeBlueprintAction(db, user, source.sourceKind === "ghl_client" ? "import_ghl_client" : "import_ghl", source.orgId);
    const inserted = (await db.query<{ id: string; created_at: Date }>(
      `insert into crm_blueprint_imports (source_kind, source_org_id, ghl_source_id, source_label, status, report, package, source_refs, counts, created_by)
       values ($1, $2, $3, $4, 'previewed', $5, $6, $7, $8, $9) returning id, created_at`,
      [
        source.sourceKind, source.orgId, source.sourceId, source.label.slice(0, 200), JSON.stringify(stored.report),
        hasContent ? JSON.stringify(conversion.content) : null, JSON.stringify(stored.sourceRefs), JSON.stringify(conversion.counts), user.id,
      ],
    )).rows[0];
    await recordAudit({
      orgId: source.orgId, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_ghl_import", targetType: "crm_blueprint_import", targetId: inserted.id, result: "success",
      metadata: { source: source.sourceKind, location: maskLocation(source.locationId), kinds, counts: conversion.counts, requests, includeValues: opts.includeValues, includePlaceholders: opts.includePlaceholders },
    }, db);
    return inserted;
  });
  return importDetailFrom(row, source, { ...conversion, report: stored.report }, hasContent, user);
}

/** crm_blueprint_imports keeps source_refs under 256 KB and the report under 1.5 MB (migration 0035). */
const SOURCE_REFS_MAX = 240_000;
const REPORT_MAX = 1_400_000;

/**
 * Makes an import fit its columns without dropping anything a person needs: provenance links between assets go first, then provenance of
 * nested stages and appointment types (their parent's stays), and very long note lists are shortened. The package itself is already bounded
 * by the Blueprint size limit.
 */
export function fitImportForStorage(c: Pick<GhlConversion, "report" | "sourceRefs">): Pick<GhlConversion, "report" | "sourceRefs"> & { trimmed: boolean } {
  let sourceRefs = c.sourceRefs;
  let report = c.report;
  let trimmed = false;
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
  if (size(sourceRefs) > SOURCE_REFS_MAX) {
    sourceRefs = Object.fromEntries(Object.entries(sourceRefs).map(([k, v]) => [k, { kind: v.kind, externalId: v.externalId }]));
    trimmed = true;
  }
  if (size(sourceRefs) > SOURCE_REFS_MAX) sourceRefs = Object.fromEntries(Object.entries(sourceRefs).filter(([k]) => !/^(stage|apptype)\./.test(k)));
  if (size(sourceRefs) > SOURCE_REFS_MAX) {
    const keep: Record<string, (typeof sourceRefs)[string]> = {};
    let used = 2;
    for (const [k, v] of Object.entries(sourceRefs)) {
      used += size({ [k]: v });
      if (used > SOURCE_REFS_MAX) break;
      keep[k] = v;
    }
    sourceRefs = keep;
  }
  if (size(report) > REPORT_MAX) {
    report = { ...report, items: report.items.map((i) => ({ ...i, notes: i.notes.length > 3 ? [...i.notes.slice(0, 3), `${i.notes.length - 3} more notes were left out to keep the report small.`] : i.notes })) };
    trimmed = true;
  }
  if (size(report) > REPORT_MAX) report = { ...report, items: report.items.map((i) => ({ ...i, notes: i.notes.slice(0, 1) })) };
  return { report, sourceRefs, trimmed };
}

async function recordFailedImport(user: AgencyUser, source: ResolvedSource, reason: string) {
  await withSystem(async (db) => {
    const id = (await db.query<{ id: string }>(
      `insert into crm_blueprint_imports (source_kind, source_org_id, ghl_source_id, source_label, status, error, created_by)
       values ($1, $2, $3, $4, 'failed', $5, $6) returning id`,
      [source.sourceKind, source.orgId, source.sourceId, source.label.slice(0, 200), reason.slice(0, 500), user.id],
    )).rows[0].id;
    await recordAudit({
      orgId: source.orgId, actorUserId: user.id, actorKind: "agency", action: "crm.blueprint_ghl_import", targetType: "crm_blueprint_import", targetId: id, result: "failure",
      metadata: { source: source.sourceKind, location: maskLocation(source.locationId), reason },
    }, db);
  });
}

function importDetailFrom(row: { id: string; created_at: Date }, source: ResolvedSource, c: GhlConversion, hasContent: boolean, user: AgencyUser): ImportDetail {
  return {
    id: row.id, sourceKind: source.sourceKind, sourceLabel: source.displayLabel.slice(0, 200), status: "previewed", counts: c.counts, blueprintId: null,
    createdBy: user.fullName || user.email, createdAt: new Date(row.created_at).toISOString(), report: c.report, content: hasContent ? c.content : null,
    validation: c.validation, error: null,
  };
}
