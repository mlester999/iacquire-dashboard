import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import { sanitizeErrorText } from "@/lib/ops";
import { isOrgRole, roleHasPermission } from "@/lib/permissions";
import { retryDelayMs } from "@/lib/esign/errors";
import { removeStoredObjectTrusted, uploadPrivateFile } from "@/server/storage/private";
import { addSigEvent, esignOnSql, loadConnection, orgRunnableSql, requestColumns, type RequestRow } from "@/server/esign/core";
import { applyProviderFact } from "@/server/esign/apply";
import { flagConnectionAttention, recordHealth } from "@/server/esign/connections";
import { openCredentials } from "@/server/esign/credentials";
import { liveEsignWritesEnabled } from "@/server/esign/providers";
import { EsignProviderError } from "@/server/esign/providers/types";
import { clock, prov, processDueRequests, WORK_BUDGET_MS, type WorkerDeps } from "@/server/esign/worker";

// The work around a request that is not the first ask: reading what the service says when no delivery came (a safety net, not the main path), fetching the signed copy once
// there is one, telling the service to withdraw what a person withdrew, and checking that each connection's key still works. Like the worker, every step is bounded by a time
// budget, runs only for a workspace that has signing switched on and may have work done right now, and touches a real service only for a connection that is usable.

/** How often a request that is out is read at the service when no notice has come. */
export const POLL_EVERY_MS = 15 * 60_000;
/** After this many failed attempts at fetching the signed copy, it is given up and the business is told to download it from the signing service. */
export const MAX_COPY_ATTEMPTS = 8;
/** Withdrawing at the service is tried this many times before the business is asked to do it by hand. */
export const MAX_CANCEL_ATTEMPTS = 5;
/** A connection's key is checked about this often. */
export const HEALTH_EVERY_MS = 6 * 3_600_000;

const iso = (d: Date): string => d.toISOString();
const MAINTENANCE_SCOPE = (reqAlias: string) => `${orgRunnableSql(`${reqAlias}.org_id`)} and ${esignOnSql(`${reqAlias}.org_id`)}`;

interface Opts {
  deps: WorkerDeps;
  orgId?: string | null;
  deadline: number;
}

// ---------------------------------------------------------------------------
// Reading the service when no notice came
// ---------------------------------------------------------------------------

/** Requests that are out, read at the service about every fifteen minutes. A fact it shows is applied exactly as a delivery of it would be. Returns how many changed. */
export async function pollOutRequests(o: Opts): Promise<number> {
  const now = clock(o.deps);
  const due = (await withSystem((db) => db.query<RequestRow>(
    `select ${requestColumns("r")} from signature_requests r join esign_connections c on c.id = r.connection_id and c.org_id = r.org_id
     where r.status in ('sent', 'viewed') and r.provider_document_id is not null and (r.last_polled_at is null or r.last_polled_at <= $1::timestamptz) and c.status in ('connected', 'error')
       and ($2::uuid is null or r.org_id = $2) and ${MAINTENANCE_SCOPE("r")} order by r.last_polled_at nulls first limit 25`,
    [iso(new Date(now.getTime() - POLL_EVERY_MS)), o.orgId ?? null],
  ))).rows;
  let changed = 0;
  for (const r of due) {
    if (Date.now() >= o.deadline) break;
    const connection = await withSystem((db) => loadConnection(db, r.org_id, r.connection_id));
    const creds = connection ? openCredentials(connection.credentials) : null;
    const stamp = () => withSystem((db) => db.query("update signature_requests set last_polled_at = $2::timestamptz where id = $1", [r.id, iso(now)]));
    if (!creds || !connection) {
      await stamp();
      continue;
    }
    try {
      const status = await prov(o.deps, r.provider).getStatus(creds, r.provider_document_id as string);
      await stamp();
      if (status.fact && status.fact !== "draft") {
        const fact = status.fact;
        const res = await withSystem((db) => applyProviderFact(db, r.org_id, r.id, fact, { source: "provider_poll", eventId: null, now }));
        if (res?.kind === "changed") changed += 1;
      }
    } catch (e) {
      await stamp();
      if (e instanceof EsignProviderError && e.needsAttention) await withSystem((db) => flagConnectionAttention(db, r.connection_id, r.org_id, e.message, now));
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// The signed copy
// ---------------------------------------------------------------------------

const fileName = (prefix: string, number: string, version: number): string => `${prefix}-${number}-v${version}.pdf`.replace(/[^A-Za-z0-9_.()-]/g, "-");

/**
 * The person on whose permission a file is stored: whoever asked for the signature, else whoever sent or owns the proposal, else an owner or manager of the workspace. A file in
 * the proposal-documents bucket is written under a real member's permission, as everywhere else.
 */
async function uploaderFor(db: Queryable, req: RequestRow): Promise<string | null> {
  const p = (await db.query<{ sent_by: string | null; owner_user_id: string | null; created_by: string | null }>("select sent_by, owner_user_id, created_by from proposals where id = $1 and org_id = $2", [req.proposal_id, req.org_id])).rows[0];
  const candidates = [req.created_by, p?.sent_by, p?.owner_user_id, p?.created_by].filter((x): x is string => Boolean(x));
  if (candidates.length) {
    const members = (await db.query<{ user_id: string; role: string }>("select user_id, role from organization_memberships where org_id = $1 and status = 'active' and user_id = any($2::uuid[])", [req.org_id, candidates])).rows;
    for (const id of candidates) {
      const m = members.find((x) => x.user_id === id);
      if (m && isOrgRole(m.role) && roleHasPermission(m.role, "proposals.create")) return id;
    }
  }
  return (await db.query<{ user_id: string }>("select user_id from organization_memberships where org_id = $1 and status = 'active' and role in ('owner', 'admin') order by created_at limit 1", [req.org_id])).rows[0]?.user_id ?? null;
}

/** Fetches and stores the signed copy of every completed request that has none yet, on a back-off, and gives up after a while with a plain note. Returns how many were stored. */
export async function fetchSignedCopies(o: Opts): Promise<number> {
  const now = clock(o.deps);
  const due = (await withSystem((db) => db.query<RequestRow & { number: string }>(
    `select ${requestColumns("r")}, p.number from signature_requests r
       join esign_connections c on c.id = r.connection_id and c.org_id = r.org_id join proposals p on p.id = r.proposal_id and p.org_id = r.org_id
     where r.status = 'completed' and r.signed_file_id is null and r.copy_gave_up_at is null and r.provider_document_id is not null and (r.copy_next_at is null or r.copy_next_at <= $1::timestamptz)
       and c.status in ('connected', 'error') and ($2::uuid is null or r.org_id = $2) and ${MAINTENANCE_SCOPE("r")} order by r.copy_next_at nulls first limit 10`,
    [iso(now), o.orgId ?? null],
  ))).rows;
  let stored = 0;
  for (const r of due) {
    if (Date.now() >= o.deadline) break;
    try {
      const connection = await withSystem((db) => loadConnection(db, r.org_id, r.connection_id));
      const creds = connection ? openCredentials(connection.credentials) : null;
      if (!creds) throw new AppError("conflict", "The saved keys can no longer be used.");
      const copies = await prov(o.deps, r.provider).downloadSigned(creds, r.provider_document_id as string);
      if (copies.signedPdf.length < 8 || copies.signedPdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new AppError("conflict", "The signing service did not return a PDF.");
      const userId = await withSystem((db) => uploaderFor(db, r));
      if (!userId) throw new AppError("conflict", "No member of the workspace could store the file.");
      const signed = await uploadPrivateFile({ userId, orgId: r.org_id, bucket: "proposal-documents", path: `${r.org_id}/${crypto.randomUUID()}/${fileName("Signed", r.number, r.proposal_version)}`, bytes: copies.signedPdf, contentType: "application/pdf", filename: fileName("Signed", r.number, r.proposal_version), visibility: "client" });
      const cert = copies.certificate && copies.certificate.subarray(0, 5).toString("latin1") === "%PDF-"
        ? await uploadPrivateFile({ userId, orgId: r.org_id, bucket: "proposal-documents", path: `${r.org_id}/${crypto.randomUUID()}/${fileName("Certificate", r.number, r.proposal_version)}`, bytes: copies.certificate, contentType: "application/pdf", filename: fileName("Certificate", r.number, r.proposal_version), visibility: "client" })
        : null;
      const claimed = await withSystem(async (db) => {
        const res = await db.query<{ id: string }>(
          `update signature_requests set signed_file_id = $2, signed_sha256 = $3, certificate_file_id = $4, certificate_sha256 = $5, copy_next_at = null
           where id = $1 and status = 'completed' and signed_file_id is null returning id`,
          [r.id, signed.id, crypto.createHash("sha256").update(copies.signedPdf).digest("hex"), cert?.id ?? null, cert && copies.certificate ? crypto.createHash("sha256").update(copies.certificate).digest("hex") : null],
        );
        if (res.rows[0]) await addSigEvent(db, r.org_id, r.id, "copy_stored", "system", { certificate: Boolean(cert) });
        return Boolean(res.rows[0]);
      });
      if (claimed) stored += 1;
      else {
        // Another worker stored it first: this copy is surplus.
        for (const f of [signed, cert]) {
          if (!f) continue;
          await withSystem((db) => db.query("update private_files set status = 'deleted' where id = $1 and org_id = $2", [f.id, r.org_id]));
          await removeStoredObjectTrusted({ orgId: r.org_id, bucket: "proposal-documents", storageKey: f.storageKey }).catch(() => undefined);
        }
      }
    } catch (e) {
      const attempts = r.copy_attempts + 1;
      const message = (e instanceof AppError || e instanceof EsignProviderError ? e.message : sanitizeErrorText(e)).slice(0, 300);
      await withSystem(async (db) => {
        if (attempts >= MAX_COPY_ATTEMPTS) {
          await db.query("update signature_requests set copy_attempts = $2, copy_gave_up_at = $3::timestamptz, copy_next_at = null, last_error = $4 where id = $1", [r.id, attempts, iso(now), message]);
          await addSigEvent(db, r.org_id, r.id, "copy_gave_up", "system", { attempts });
          await notifyOrgRoles(db, r.org_id, ["owner", "admin"], {
            kind: "signature_failed", severity: "warning", title: `The signed copy of ${r.number} could not be fetched`, body: "The signature is recorded, but iAcquire could not fetch the signed copy. Download it from your signing service.",
            link: `/proposals/${r.proposal_id}?tab=signature`, dedupeKey: `signature-copy:${r.id}`,
          });
        } else {
          await db.query("update signature_requests set copy_attempts = $2, copy_next_at = $3::timestamptz, last_error = $4 where id = $1", [r.id, attempts, iso(new Date(now.getTime() + retryDelayMs(attempts, null, (o.deps.jitter ?? Math.random)()))), message]);
          await addSigEvent(db, r.org_id, r.id, "copy_failed", "system", { attempts });
        }
      });
    }
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Withdrawing at the service
// ---------------------------------------------------------------------------

/** Tells the service to withdraw requests a person withdrew, where it allows that. Real services are written to only while the write switch is on. Returns how many were done. */
export async function cancelWithdrawn(o: Opts): Promise<number> {
  const live = (o.deps.liveEnabled ?? liveEsignWritesEnabled)();
  const due = (await withSystem((db) => db.query<RequestRow>(
    `select ${requestColumns("r")} from signature_requests r join esign_connections c on c.id = r.connection_id and c.org_id = r.org_id
     where r.cancel_state = 'wanted' and r.provider_document_id is not null and c.status in ('connected', 'error') and (c.provider = 'simulated' or $1::boolean)
       and ($2::uuid is null or r.org_id = $2) and ${MAINTENANCE_SCOPE("r")} order by r.finished_at limit 10`,
    [live, o.orgId ?? null],
  ))).rows;
  let done = 0;
  for (const r of due) {
    if (Date.now() >= o.deadline) break;
    try {
      const connection = await withSystem((db) => loadConnection(db, r.org_id, r.connection_id));
      const creds = connection ? openCredentials(connection.credentials) : null;
      if (!creds) throw new AppError("conflict", "The saved keys can no longer be used.");
      await prov(o.deps, r.provider).cancel(creds, r.provider_document_id as string);
      await withSystem(async (db) => {
        await db.query("update signature_requests set cancel_state = 'done' where id = $1 and cancel_state = 'wanted'", [r.id]);
        await addSigEvent(db, r.org_id, r.id, "cancel_done", "system", {});
      });
      done += 1;
    } catch {
      const attempts = r.cancel_attempts + 1;
      await withSystem(async (db) => {
        await db.query("update signature_requests set cancel_attempts = $2, cancel_state = case when $2 >= $3 then 'manual' else cancel_state end where id = $1", [r.id, attempts, MAX_CANCEL_ATTEMPTS]);
        await addSigEvent(db, r.org_id, r.id, attempts >= MAX_CANCEL_ATTEMPTS ? "cancel_manual" : "cancel_failed", "system", { attempts });
      });
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// The connection's key
// ---------------------------------------------------------------------------

/** Checks each connection's key about every six hours. A change for the worse is recorded and announced; a service that cannot be reached leaves the status as it was. Returns how many were checked. */
export async function checkConnections(o: Opts): Promise<number> {
  const now = clock(o.deps);
  const due = (await withSystem((db) => db.query<{ id: string; org_id: string }>(
    `select c.id, c.org_id from esign_connections c where c.status in ('connected', 'error', 'needs_attention') and (c.last_checked_at is null or c.last_checked_at <= $1::timestamptz)
       and ($2::uuid is null or c.org_id = $2) and ${MAINTENANCE_SCOPE("c")} order by c.last_checked_at nulls first limit 25`,
    [iso(new Date(now.getTime() - HEALTH_EVERY_MS)), o.orgId ?? null],
  ))).rows;
  let checked = 0;
  for (const c of due) {
    if (Date.now() >= o.deadline) break;
    const row = await withSystem((db) => loadConnection(db, c.org_id, c.id));
    if (!row) continue;
    const creds = openCredentials(row.credentials);
    try {
      if (!creds) {
        await withSystem((db) => flagConnectionAttention(db, row.id, row.org_id, "The saved keys can no longer be used. Connect the signing service again.", now));
      } else {
        const health = await prov(o.deps, row.provider).health(creds);
        await withSystem((db) => recordHealth(db, row, health, now));
      }
      checked += 1;
    } catch {
      // Silence, a server error or a limit says nothing about the key: the status stays, and it is looked at again at the next interval.
      await withSystem((db) => db.query("update esign_connections set last_checked_at = $2::timestamptz where id = $1", [row.id, iso(now)]));
    }
  }
  return checked;
}

// ---------------------------------------------------------------------------
// The scheduler's entry point
// ---------------------------------------------------------------------------

export interface SyncResult {
  claimed: number;
  recovered: number;
  reconciled: number;
  polled: number;
  copies: number;
  cancelled: number;
  checked: number;
}

/**
 * One pass of the signing worker: ask the service for what is due, check what is unknown, read what is out, fetch signed copies, withdraw what was withdrawn, check the keys. It
 * stops taking new work when its time budget is spent (the scheduler's tick has 120 seconds for everything); what it did not reach waits for the next pass.
 */
export async function runEsignSync(deps: WorkerDeps & { orgId?: string | null; budgetMs?: number } = {}): Promise<SyncResult> {
  const budget = deps.budgetMs ?? WORK_BUDGET_MS;
  const started = Date.now();
  const w = await processDueRequests({ ...deps, budgetMs: Math.round(budget * 0.5) });
  const o = (share: number): Opts => ({ deps, orgId: deps.orgId ?? null, deadline: started + budget * share });
  const polled = await pollOutRequests(o(0.7));
  const copies = await fetchSignedCopies(o(0.85));
  const cancelled = await cancelWithdrawn(o(0.92));
  const checked = await checkConnections(o(1));
  return { claimed: w.claimed, recovered: w.recovered, reconciled: w.reconciled, polled, copies, cancelled, checked };
}
