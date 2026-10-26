import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { classifyEsignFailure, isRetryable, retryDelayMs, type FailureKind } from "@/lib/esign/errors";
import { documentName } from "@/lib/esign/pandadoc";
import { PROVIDER_LABELS, signingEmail } from "@/lib/esign/state";
import { pdfPageCount } from "@/lib/pdf/info";
import { SIGNATURE_BOX } from "@/lib/proposals/pdf";
import { loadProposalRow, type ProposalRow } from "@/server/proposals/core";
import { readVersionPdf } from "@/server/proposals/documents";
import { addSigEvent, esignOnSql, loadConnection, orgRunnableSql, REQUEST_COLUMNS, type RequestRow } from "@/server/esign/core";
import { applyProviderFact, failRequest, voidLiveRequestsInTx } from "@/server/esign/apply";
import { openCredentials } from "@/server/esign/credentials";
import { flagConnectionAttention } from "@/server/esign/connections";
import { liveEsignWritesEnabled, providerFor, simulatedAllowed, type Adapter } from "@/server/esign/providers";
import { EsignProviderError, type CreateInput, type CreateState, type EsignCredentials, type EsignProvider } from "@/server/esign/providers/types";

// Asking the signing service, durably. A request has a row. A worker claims a due one for a short LEASE, does the next step at the service, and saves what happened after EVERY
// step, so a worker that dies and the worker that takes over continue from the same place. The rules that keep a signer from being asked twice:
//
//   1. One live request per version of a proposal (a database index), so a second worker, a double click or a retry cannot start a parallel signing.
//   2. A request is claimed by one worker at a time (`for update skip locked`, then a lease). A worker that loses its lease stops writing.
//   3. The intent to make something at the service is written BEFORE the call that could (`sendingAt` and `step` in the saved state). If the worker dies, or the answer never
//      arrives, the request is marked "unknown": it is CHECKED with the service, never sent again on a guess.
//   4. What a step created (the document, whether it is ready) is saved and reused, so a retry resumes instead of creating another.
//   5. A request belongs to one version. If the proposal moved on, the request is ended instead of sent.
//   6. A document the service already holds an answer for is never stepped again.
//
// Nothing here reaches a real signing service unless ESIGN_WRITES_ENABLED is on: requests for real connections simply wait. They also wait while the workspace is suspended,
// archived or paused (a shut-down client is), and while the connection needs attention. The simulated service reaches nothing and is refused in production.

export const LEASE_SECONDS = 120;
/** How long after a step with an unknown outcome before "I could not find it" is believed. */
export const RECONCILE_GRACE_MS = 10 * 60_000;
/** After this long without a way to check, the request is ended and a person is told to look at the signing account. */
export const RECONCILE_GIVE_UP_MS = 24 * 3_600_000;
/** How long one scheduler pass spends on signing work (of the tick's 120 seconds). Work left over waits for the next pass. */
export const WORK_BUDGET_MS = 25_000;
const MAX_STEPS_PER_RUN = 6;

export interface WorkerDeps {
  provider?: (adapter: Adapter) => EsignProvider;
  now?: () => Date;
  workerId?: string;
  /** Whether real signing services may be written to. Simulated connections are not affected. */
  liveEnabled?: () => boolean;
  /** A number in [0, 1) that spreads retry times. */
  jitter?: () => number;
}

export const clock = (d: { now?: () => Date }): Date => (d.now ? d.now() : new Date());
export const prov = (d: WorkerDeps, adapter: Adapter): EsignProvider => (d.provider ? d.provider(adapter) : providerFor(adapter));
const sha256 = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const iso = (d: Date): string => d.toISOString();

type Outcome = "sent" | "failed" | "requeued" | "unknown" | "cancelled" | "lost";

const hasMarker = (s: CreateState | null | undefined): boolean => Boolean(s?.sendingAt);
const withoutMarker = (s: CreateState): CreateState => {
  const { sendingAt: _a, step: _b, ...rest } = s;
  void _a;
  void _b;
  return rest;
};

// ---------------------------------------------------------------------------
// Taking over a dead worker's request
// ---------------------------------------------------------------------------

/** A worker that stopped renewing its lease is taken over: resumed from its saved state, or sent to be checked when it may already have made something at the service. */
export async function recoverExpiredLeases(db: Queryable, now: Date, orgId: string | null = null): Promise<number> {
  const { rows } = await db.query<RequestRow>(`select ${REQUEST_COLUMNS} from signature_requests where status = 'sending' and lease_until < $1 and ($2::uuid is null or org_id = $2) for update skip locked`, [now.toISOString(), orgId]);
  for (const r of rows) {
    // Each request on its own savepoint: one that cannot be put right is left as it was and tried again next time, and does not stop the rest of the pass.
    await db.query("savepoint esign_recover");
    try {
      if (hasMarker(r.provider_state)) {
        await db.query("update signature_requests set status = 'unknown', claimed_by = null, lease_until = null, run_at = $2::timestamptz, last_error_kind = 'unknown_outcome', last_error = 'The worker stopped while the request was being made; the result is being checked.' where id = $1", [r.id, iso(new Date(now.getTime() + 60_000))]);
        await addSigEvent(db, r.org_id, r.id, "worker_lost_while_sending", "system", { attempt: r.attempt });
      } else if (r.attempt >= r.max_attempts) {
        await failRequest(db, r.org_id, r.id, "Signing kept stopping unexpectedly before anything was sent, so this was not sent. Try again.", "transient", now);
      } else {
        await db.query("update signature_requests set status = 'queued', claimed_by = null, lease_until = null, run_at = $2::timestamptz where id = $1", [r.id, iso(now)]);
        await addSigEvent(db, r.org_id, r.id, "worker_lost_resumed", "system", { attempt: r.attempt });
      }
      await db.query("release savepoint esign_recover");
    } catch (e) {
      await db.query("rollback to savepoint esign_recover");
      await db.query("release savepoint esign_recover");
      if (process.env.NODE_ENV !== "test") console.error("[iacquire] a signing request could not be taken over", { type: e instanceof Error ? e.name : "unknown" });
    }
  }
  return rows.length;
}

async function claimNext(db: Queryable, workerId: string, now: Date, live: boolean, orgId: string | null): Promise<RequestRow | null> {
  // The write switch for real connections, a workspace that is stopped and a connection that needs attention each hold a request back untouched. The stand-in service has no
  // requests to hand over in production.
  const { rows } = await db.query<RequestRow>(
    `update signature_requests r set status = 'sending', attempt = r.attempt + 1, lease_until = $2::timestamptz, claimed_by = $1
     where r.id = (
       select q.id from signature_requests q join esign_connections c on c.id = q.connection_id and c.org_id = q.org_id
       where q.status = 'queued' and q.run_at <= $3::timestamptz and ($5::uuid is null or q.org_id = $5) and c.status = 'connected'
         and (c.provider = 'simulated' or $4::boolean) and (c.provider <> 'simulated' or $6::boolean) and ${orgRunnableSql("q.org_id")} and ${esignOnSql("q.org_id")}
       order by q.run_at, q.created_at limit 1 for update of q skip locked
     )
     returning ${REQUEST_COLUMNS}`,
    [workerId, iso(new Date(now.getTime() + LEASE_SECONDS * 1000)), iso(now), live, orgId, simulatedAllowed()],
  );
  return rows[0] ?? null;
}

/** Saves the request's state and extends its lease. False means this worker no longer holds the request (it was taken over, or ended), and it must stop. */
async function persist(requestId: string, workerId: string, state: CreateState, now: Date): Promise<boolean> {
  return withSystem(async (db) => {
    const r = await db.query(
      "update signature_requests set provider_state = $3::jsonb, provider_document_id = coalesce(provider_document_id, $4), lease_until = $5::timestamptz where id = $1 and claimed_by = $2 and status = 'sending' returning id",
      [requestId, workerId, JSON.stringify(state), state.documentId ?? null, iso(new Date(now.getTime() + LEASE_SECONDS * 1000))],
    );
    return r.rows.length === 1;
  });
}

async function requeue(requestId: string, workerId: string, state: CreateState, runAt: Date, error: { kind: FailureKind | null; message: string | null }, refundAttempt: boolean): Promise<void> {
  await withSystem((db) => db.query(
    `update signature_requests set status = 'queued', provider_state = $3::jsonb, provider_document_id = coalesce(provider_document_id, $4), run_at = $5::timestamptz, lease_until = null, claimed_by = null,
       last_error = $6, last_error_kind = $7, attempt = greatest(0, attempt - $8)
     where id = $1 and claimed_by = $2 and status = 'sending'`,
    [requestId, workerId, JSON.stringify(state), state.documentId ?? null, iso(runAt), error.message, error.kind, refundAttempt ? 1 : 0],
  ));
}

/**
 * A step finished after the request was ended under the worker (a revision or a withdrawal landed while the service was being asked). If a document was made, its id is kept on
 * the ended request so the business is told it exists at the signing service and can be asked to withdraw it.
 */
async function adoptAfterLoss(requestId: string, orgId: string, state: CreateState): Promise<void> {
  if (!state.documentId) return;
  await withSystem(async (db) => {
    const r = await db.query<{ id: string }>(
      "update signature_requests set provider_document_id = coalesce(provider_document_id, $3), cancel_state = case when cancel_state = 'none' then 'manual' else cancel_state end where id = $1 and org_id = $2 and status in ('voided', 'superseded') returning id",
      [requestId, orgId, state.documentId],
    );
    if (r.rows[0]) await addSigEvent(db, orgId, requestId, "document_left_behind", "system", { note: "The request was withdrawn while the signing service was being asked; a document may exist there." });
  });
}

// ---------------------------------------------------------------------------
// Running one request
// ---------------------------------------------------------------------------

interface Prepared {
  creds: EsignCredentials;
  provider: EsignProvider;
  proposal: ProposalRow;
  businessName: string;
}

/** Ends a request whose proposal moved on (or was closed) before the worker got to it. Normally the revision or withdrawal already did; this closes the race. */
async function standDown(req: RequestRow, proposal: ProposalRow | null, now: Date): Promise<void> {
  await withSystem(async (db) => {
    if (!proposal) return;
    const locked = await loadProposalRow(db, req.org_id, proposal.id, true);
    if (!locked) return;
    const superseded = locked.version !== req.proposal_version;
    await voidLiveRequestsInTx(db, req.org_id, locked.id, superseded ? "superseded" : "voided", superseded ? "The proposal was revised." : "The proposal was closed.", { userId: null, now });
  });
}

async function prepare(req: RequestRow, deps: WorkerDeps, now: Date): Promise<{ ok: true; p: Prepared } | { ok: false; outcome: Outcome }> {
  const workerId = deps.workerId ?? "worker";
  const loaded = await withSystem(async (db) => ({
    proposal: await loadProposalRow(db, req.org_id, req.proposal_id),
    connection: await loadConnection(db, req.org_id, req.connection_id),
    org: (await db.query<{ name: string }>("select name from organizations where id = $1", [req.org_id])).rows[0],
  }));
  const { proposal, connection } = loaded;
  if (!proposal || proposal.version !== req.proposal_version || proposal.status !== "sent" || proposal.sent_version !== req.proposal_version) {
    await standDown(req, proposal, now);
    return { ok: false, outcome: "cancelled" };
  }
  // The connection stopped being usable since the request was claimed: it waits, untouched, for the person to connect again.
  if (!connection || connection.status !== "connected") {
    await requeue(req.id, workerId, req.provider_state, new Date(now.getTime() + 15 * 60_000), { kind: null, message: "The signing service connection needs attention, so this is waiting." }, true);
    return { ok: false, outcome: "requeued" };
  }
  const creds = openCredentials(connection.credentials);
  if (!creds) {
    await withSystem(async (db) => {
      await failRequest(db, req.org_id, req.id, "The saved keys for the signing service can no longer be used. Connect it again.", "auth", now);
      await flagConnectionAttention(db, connection.id, req.org_id, "The saved keys can no longer be used. Connect the signing service again.", now);
    });
    return { ok: false, outcome: "failed" };
  }
  return { ok: true, p: { creds, provider: prov(deps, req.provider), proposal, businessName: loaded.org?.name ?? "" } };
}

/** The document and the words for the signer. Read only when a step that needs them is next, and checked against the hash the request was made for. */
async function buildInput(req: RequestRow, p: Prepared): Promise<{ ok: true; input: CreateInput } | { ok: false; message: string }> {
  const pdf = await readVersionPdf(req.org_id, req.proposal_id, req.proposal_version);
  if (!pdf) return { ok: false, message: "The saved document for this version could not be found, so nothing was sent." };
  if (sha256(pdf.bytes) !== req.pdf_sha256) return { ok: false, message: "The saved PDF no longer matches the one this request was made for, so nothing was sent. Revise the proposal and ask again." };
  const pages = pdfPageCount(pdf.bytes);
  if (!pages) return { ok: false, message: "The saved PDF could not be read, so nothing was sent." };
  const words = signingEmail({ business: p.businessName, signerName: req.signer_name, number: p.proposal.number, version: req.proposal_version });
  return {
    ok: true,
    input: {
      requestId: req.id, idempotencyKey: req.idempotency_key, name: documentName(p.proposal.number, req.proposal_version, req.id), signer: { name: req.signer_name, email: req.signer_email },
      pdf: pdf.bytes, pdfFilename: pdf.filename, placement: { page: pages, x: SIGNATURE_BOX.x, yTop: SIGNATURE_BOX.yTop, width: SIGNATURE_BOX.width, height: SIGNATURE_BOX.height },
      emailSubject: words.subject, emailMessage: words.message,
    },
  };
}

/**
 * Runs one claimed request as far as it can go. Never throws: every way it can end is recorded, and one that cannot even be recorded (the database is down) is left to the
 * lease, which another worker takes over from the saved state.
 */
export async function runClaimedRequest(req: RequestRow, deps: WorkerDeps = {}): Promise<Outcome> {
  try {
    return await runSteps(req, deps);
  } catch (e) {
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] a signing request stopped unexpectedly", { type: e instanceof Error ? e.name : "unknown" });
    return settleAfterCrash(req, deps);
  }
}

async function runSteps(req: RequestRow, deps: WorkerDeps): Promise<Outcome> {
  const workerId = deps.workerId ?? "worker";
  const now = clock(deps);
  const prep = await prepare(req, deps, now);
  if (!prep.ok) return prep.outcome;
  const { creds, provider } = prep.p;
  let state: CreateState = { ...req.provider_state };
  // The document and the words for the signer, read once and checked against the hash the request was made for before anything leaves.
  const built = await buildInput(req, prep.p);
  if (!built.ok) {
    await withSystem((db) => failRequest(db, req.org_id, req.id, built.message, "invalid_content", clock(deps)));
    return "failed";
  }
  const input = built.input;

  for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
    if (i > 0) {
      // Between steps: the workspace may have been stopped since the lease was taken.
      const held = await withSystem(async (db) => (await db.query<{ ok: boolean }>(`select ${orgRunnableSql("o.id")} as ok from organizations o where o.id = $1`, [req.org_id])).rows[0]?.ok);
      if (!held) {
        await requeue(req.id, workerId, state, new Date(req.run_at), { kind: null, message: "The workspace is paused, so this is waiting." }, true);
        return "requeued";
      }
    }
    // The intent to make something is saved first. From here until the answer is saved, a crash means "possibly made".
    if (provider.mayCreate(state) && !state.sendingAt) {
      state = { ...state, sendingAt: iso(clock(deps)), step: state.documentId ? "send" : "create" };
      if (!(await persist(req.id, workerId, state, clock(deps)))) return "lost";
    }
    let result;
    try {
      result = await provider.createRequest(creds, input, state);
    } catch (e) {
      return handleFailure(req, state, e, deps, workerId);
    }
    state = withoutMarker(result.state);
    if (!(await persist(req.id, workerId, state, clock(deps)))) {
      await adoptAfterLoss(req.id, req.org_id, state);
      return "lost";
    }
    if (state.sent) {
      await withSystem((db) => applyProviderFact(db, req.org_id, req.id, "sent", { source: "system", eventId: null, now: clock(deps) }));
      return "sent";
    }
    if (result.waitSeconds && result.waitSeconds > 0) {
      await requeue(req.id, workerId, state, new Date(clock(deps).getTime() + result.waitSeconds * 1000), { kind: null, message: null }, true);
      return "requeued";
    }
  }
  // Too many steps in one run without finishing: come back to it rather than hold the worker.
  await requeue(req.id, workerId, state, new Date(clock(deps).getTime() + 15_000), { kind: null, message: null }, true);
  return "requeued";
}

/**
 * Something unexpected threw outside the service's own answers. What was saved is the truth, so the request is put where that truth says: a request that may have made
 * something is checked and never repeated; anything else is tried again within the attempts and failed plainly when they run out.
 */
async function settleAfterCrash(req: RequestRow, deps: WorkerDeps): Promise<Outcome> {
  const workerId = deps.workerId ?? "worker";
  try {
    const cur = (await withSystem((db) => db.query<{ status: string; provider_state: CreateState }>("select status, provider_state from signature_requests where id = $1 and claimed_by = $2", [req.id, workerId]))).rows[0];
    if (!cur || cur.status !== "sending") return "lost";
    const e = hasMarker(cur.provider_state)
      ? new EsignProviderError("unknown_outcome", "Signing stopped unexpectedly while the request was being made. It is being checked and will not be sent again until that is known.")
      : new EsignProviderError("transient", req.attempt < req.max_attempts ? "Signing stopped unexpectedly before anything was sent. It will try again." : "Signing stopped unexpectedly before anything was sent, so this was not sent. Try again.");
    return await handleFailure(req, cur.provider_state ?? {}, e, deps, workerId);
  } catch {
    return "lost";
  }
}

async function handleFailure(req: RequestRow, state: CreateState, error: unknown, deps: WorkerDeps, workerId: string): Promise<Outcome> {
  const now = clock(deps);
  const e = error instanceof EsignProviderError
    ? error
    : (() => {
        const c = classifyEsignFailure({ httpStatus: null, sent: hasMarker(state), providerLabel: PROVIDER_LABELS[req.provider] });
        return new EsignProviderError(c.kind, c.message);
      })();
  if (e.kind === "unknown_outcome") {
    // Keep the marker: this is exactly the case it exists for.
    await withSystem(async (db) => {
      const done = await db.query(
        "update signature_requests set status = 'unknown', provider_state = $2::jsonb, lease_until = null, claimed_by = null, run_at = $3::timestamptz, last_error = $4, last_error_kind = 'unknown_outcome' where id = $1 and claimed_by = $5 and status = 'sending' returning id",
        [req.id, JSON.stringify(state), iso(new Date(now.getTime() + 60_000)), e.message.slice(0, 400), workerId],
      );
      if (done.rows[0]) await addSigEvent(db, req.org_id, req.id, "outcome_unknown", "system", { attempt: req.attempt, step: state.step ?? null });
    });
    return "unknown";
  }
  // Every other kind is a definite answer: nothing was made by the step that failed, so the intent is withdrawn.
  const cleared = withoutMarker(state);
  if (e.kind === "blocked") {
    // A switch is off: not the request's fault and not an attempt used.
    await requeue(req.id, workerId, cleared, new Date(now.getTime() + 5 * 60_000), { kind: "blocked", message: e.message.slice(0, 400) }, true);
    return "requeued";
  }
  if (isRetryable(e.kind) && req.attempt < req.max_attempts) {
    await requeue(req.id, workerId, cleared, new Date(now.getTime() + retryDelayMs(req.attempt, e.retryAfterSec, (deps.jitter ?? Math.random)())), { kind: e.kind, message: e.message.slice(0, 400) }, false);
    await withSystem((db) => addSigEvent(db, req.org_id, req.id, "retry_scheduled", "system", { attempt: req.attempt, kind: e.kind }));
    return "requeued";
  }
  await withSystem(async (db) => {
    await failRequest(db, req.org_id, req.id, e.message, e.kind, now);
    if (e.needsAttention) await flagConnectionAttention(db, req.connection_id, req.org_id, e.message, now);
  });
  return "failed";
}

// ---------------------------------------------------------------------------
// Checking what a lost answer did
// ---------------------------------------------------------------------------

const CANNOT_TELL = "iAcquire could not tell whether the signing service sent this. Look in your signing account for a document named with this request's reference, then ask again if it is not there.";

/**
 * For every request whose outcome is unknown: asks the signing service whether the document exists. Found and already sent (or further): recorded as such, once. Found but not sent:
 * after a grace period the send resumes. Not found and long enough since the attempt: ended as not made, and the person may ask again. Several documents fit, or no way to check for
 * a day: ended with a plain note to look in the signing account.
 */
export async function reconcileUnknownRequests(deps: WorkerDeps & { orgId?: string | null; budgetMs?: number } = {}): Promise<{ checked: number; adopted: number; resumed: number; failed: number }> {
  const now = clock(deps);
  const deadline = Date.now() + (deps.budgetMs ?? WORK_BUDGET_MS);
  const out = { checked: 0, adopted: 0, resumed: 0, failed: 0 };
  const reqs = await withSystem((db) => db.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from signature_requests where status = 'unknown' and run_at <= $1::timestamptz and ($2::uuid is null or org_id = $2) order by run_at limit 25`, [iso(now), deps.orgId ?? null],
  ).then((r) => r.rows));
  for (const req of reqs) {
    if (Date.now() >= deadline) break;
    const loaded = await withSystem(async (db) => ({
      connection: await loadConnection(db, req.org_id, req.connection_id),
      proposal: await loadProposalRow(db, req.org_id, req.proposal_id),
    }));
    const attemptedAt = req.provider_state?.sendingAt && !Number.isNaN(Date.parse(req.provider_state.sendingAt)) ? new Date(req.provider_state.sendingAt) : new Date(req.run_at);
    const later = (ms: number, why: string) => withSystem((db) => db.query("update signature_requests set run_at = $2::timestamptz, last_error = $3 where id = $1 and status = 'unknown'", [req.id, iso(new Date(now.getTime() + ms)), why.slice(0, 400)]));
    const giveUp = async (message = CANNOT_TELL) => {
      await withSystem((db) => failRequest(db, req.org_id, req.id, message, "unknown_outcome", now));
      out.failed += 1;
    };
    const creds = loaded.connection && loaded.connection.status === "connected" ? openCredentials(loaded.connection.credentials) : null;
    if (!creds || !loaded.proposal) {
      if (now.getTime() - attemptedAt.getTime() > RECONCILE_GIVE_UP_MS) await giveUp();
      else await later(3_600_000, "The signing service is not connected, so the request could not be checked yet.");
      continue;
    }
    out.checked += 1;
    try {
      const provider = prov(deps, req.provider);
      const name = documentName(loaded.proposal.number, req.proposal_version, req.id);
      const r = await provider.reconcile(creds, { requestId: req.id, idempotencyKey: req.idempotency_key, name }, req.provider_state ?? {});
      const fact = r.fact;
      if (r.found && r.documentId && fact && fact !== "draft") {
        await withSystem(async (db) => {
          await db.query("update signature_requests set provider_document_id = coalesce(provider_document_id, $2), provider_state = (provider_state - 'sendingAt' - 'step') || jsonb_build_object('documentId', $2::text, 'ready', true, 'sent', true) where id = $1", [req.id, r.documentId]);
          await addSigEvent(db, req.org_id, req.id, "reconciled_found", "system", { fact });
          await applyProviderFact(db, req.org_id, req.id, fact, { source: "system", eventId: null, now });
        });
        out.adopted += 1;
      } else if (r.found && r.documentId) {
        // The service holds the document and has not sent it. If the lost step was making it, it is simply there now; if the lost step was the send, wait out the grace period
        // (an answer can be slow) and then send.
        const step = req.provider_state?.step;
        if (step === "send" && now.getTime() - attemptedAt.getTime() < RECONCILE_GRACE_MS) {
          await later(5 * 60_000, "The document is at the signing service but not sent yet; checking again shortly.");
        } else {
          await withSystem(async (db) => {
            const next: CreateState = { documentId: r.documentId, ...(step === "send" ? { ready: true } : {}) };
            await db.query(
              "update signature_requests set status = 'queued', provider_document_id = coalesce(provider_document_id, $2), provider_state = $3::jsonb, run_at = $4::timestamptz, claimed_by = null, lease_until = null, last_error = null, last_error_kind = null, attempt = greatest(0, attempt - 1) where id = $1 and status = 'unknown'",
              [req.id, r.documentId, JSON.stringify(next), iso(now)],
            );
            await addSigEvent(db, req.org_id, req.id, "reconciled_resumed", "system", { step: step ?? null });
          });
          out.resumed += 1;
        }
      } else if (r.uncertain) {
        await giveUp();
      } else if (now.getTime() - attemptedAt.getTime() >= RECONCILE_GRACE_MS) {
        await withSystem((db) => addSigEvent(db, req.org_id, req.id, "reconciled_not_found", "system", {}));
        await giveUp("The signing service confirmed it does not have this document, so nothing was sent to the signer. You can ask again.");
      } else {
        await later(5 * 60_000, "Not found yet; checking again shortly.");
      }
    } catch (e) {
      if (e instanceof EsignProviderError && e.needsAttention) await withSystem((db) => flagConnectionAttention(db, req.connection_id, req.org_id, e.message, now));
      if (now.getTime() - attemptedAt.getTime() > RECONCILE_GIVE_UP_MS) await giveUp();
      else await later(30 * 60_000, e instanceof EsignProviderError ? e.message : "The signing service could not be reached.");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

export interface WorkResult {
  recovered: number;
  claimed: number;
  sent: number;
  failed: number;
  requeued: number;
  unknown: number;
  reconciled: number;
}

/** Takes over dead workers' requests, runs what is due, checks what is unknown. Safe to run from several workers at once; stops taking new work when its time budget is spent. */
export async function processDueRequests(deps: WorkerDeps & { limit?: number; orgId?: string | null; budgetMs?: number } = {}): Promise<WorkResult> {
  const workerId = deps.workerId ?? `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const live = (deps.liveEnabled ?? liveEsignWritesEnabled)();
  const budget = deps.budgetMs ?? WORK_BUDGET_MS;
  const started = Date.now();
  const res: WorkResult = { recovered: 0, claimed: 0, sent: 0, failed: 0, requeued: 0, unknown: 0, reconciled: 0 };
  res.recovered = await withSystem((db) => recoverExpiredLeases(db, clock(deps), deps.orgId ?? null));
  for (let i = 0; i < (deps.limit ?? 20); i++) {
    // Sending takes three quarters of the budget, so checking unknown outcomes is never starved by a long queue.
    if (Date.now() - started >= budget * 0.75) break;
    const req = await withSystem((db) => claimNext(db, workerId, clock(deps), live, deps.orgId ?? null));
    if (!req) break;
    res.claimed += 1;
    const o = await runClaimedRequest(req, { ...deps, workerId });
    if (o === "sent") res.sent += 1;
    else if (o === "failed") res.failed += 1;
    else if (o === "requeued") res.requeued += 1;
    else if (o === "unknown") res.unknown += 1;
  }
  const r = await reconcileUnknownRequests({ ...deps, budgetMs: Math.max(5_000, budget - (Date.now() - started)) });
  res.reconciled = r.adopted + r.resumed + r.failed;
  return res;
}
