import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { decryptSecret } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { pinnedHttps, PinnedRequestError, type PinnedResponse } from "@/server/security/pinned-https";
import { notifyOrgRoles } from "@/server/notifications";
import {
  HTTP_LIMITS, OutboundPolicyError, buildTarget, clampTimeout, cleanStepHeaders, judgeFailure, judgeResponse, redact, safeExcerpt, type CallJudgement, type HttpMethod,
} from "@/server/security/outbound-http";
import { FAILURES_BEFORE_ATTENTION, SLACK_WEBHOOK_URL, type HttpAuth, type HttpSettings } from "@/lib/automation-studio/connections";

/**
 * The one place an Automation Studio step or a person's confirmed test leaves iAcquire for an outside address (an HTTP API or a Slack webhook).
 *
 * What it guarantees, in order:
 *   1. the connection is this workspace's own and is usable (verified, not revoked), and the workspace is within its limits (calls in flight, calls per
 *      minute for the connection) before anything is built;
 *   2. the address is the connection's host plus a checked path and an encoded query; headers are the connection's credential plus harmless extras; the body is
 *      size-limited and has a content type from a short list;
 *   3. the request goes through the pinned transport (a public address resolved once and used for the socket, https on 443, no redirect followed);
 *   4. the answer is judged (sent, rejected, blocked, not sent, unknown) in terms of whether repeating it is safe;
 *   5. what is recorded (call log, step result, connection status, owner notice) holds the host, path without its query, status, size and time and a
 *      redacted excerpt of an error, and never a header, a body or a secret.
 * The secret is decrypted here, used for one request and not kept; it never appears in anything this returns.
 */

export type OutboundCall =
  | {
      kind: "http";
      orgId: string;
      connectionId: string;
      origin: "step" | "test";
      workflowId?: string | null;
      runId?: string | null;
      /** The same value for every attempt of one step visit, sent as the Idempotency-Key. */
      idempotencyKey: string;
      method: HttpMethod;
      path: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      /** The body, already rendered. */
      body?: string;
      contentType?: "application/json" | "application/x-www-form-urlencoded" | "text/plain";
      timeoutSeconds?: number;
      safeToRepeat?: boolean;
    }
  | {
      kind: "slack";
      orgId: string;
      connectionId: string;
      origin: "step" | "test";
      workflowId?: string | null;
      runId?: string | null;
      idempotencyKey: string;
      /** The message, already rendered and made safe (see slackText). */
      text: string;
      timeoutSeconds?: number;
    };

export interface OutboundResult extends CallJudgement {
  httpStatus: number | null;
  /** What goes on the step's row and in the log: nothing here is secret. */
  record: { host: string; path: string; method: string; httpStatus: number | null; bytes: number | null; durationMs: number; outcome: string; excerpt: string | null; note: string | null };
}

export interface OutboundDeps {
  request: (input: Parameters<typeof pinnedHttps.request>[0]) => Promise<PinnedResponse>;
  now: () => number;
}
const realDeps: OutboundDeps = { request: (input) => pinnedHttps.request(input), now: () => Date.now() };

/** How many outside calls a workspace may have going at once. */
export const MAX_CALLS_IN_FLIGHT = 5;

interface ConnectionRow {
  id: string;
  kind: "http" | "slack_webhook";
  status: "unverified" | "active" | "needs_attention" | "revoked";
  settings: unknown;
  secret_ciphertext: string | null;
  consecutive_failures: number;
}

/** Escapes what Slack would act on (mentions, links, channel-wide pings) in text made from workspace data. */
export function slackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 1500);
}

const blocked = (detail: string, retryable: boolean, extra: Partial<OutboundResult["record"]> = {}): OutboundResult => ({
  status: "blocked", retryable, detail, httpStatus: null,
  record: { host: "", path: "", method: "", httpStatus: null, bytes: null, durationMs: 0, outcome: "blocked", excerpt: null, note: null, ...extra },
});

/**
 * Makes one outside call for a connection and records what happened. `origin: "test"` is a person's confirmed test; the caller has already checked the
 * confirmation, the permission and the plan. Never throws for an outcome (it returns it); it throws only for a bug.
 */
export async function performOutbound(call: OutboundCall, deps: OutboundDeps = realDeps): Promise<OutboundResult> {
  const started = deps.now();
  const conn = await withSystem(async (db) => {
    const row = (await db.query<ConnectionRow>("select id, kind, status, settings, secret_ciphertext, consecutive_failures from automation_connections where id = $1 and org_id = $2", [call.connectionId, call.orgId])).rows[0];
    if (!row) return { row: null, inFlight: 0 };
    const inFlight = (await db.query<{ n: number }>("select count(*)::int as n from crm_workflow_run_steps where org_id = $1 and status = 'running' and kind in ('http_request', 'slack_message')", [call.orgId])).rows[0]?.n ?? 0;
    return { row, inFlight };
  });
  const row = conn.row;
  if (!row || row.kind !== (call.kind === "http" ? "http" : "slack_webhook")) return blocked("The connection this step uses doesn't exist any more. Edit the workflow.", false);
  if (row.status === "revoked") return blocked("The connection this step uses was revoked. Choose another connection in the workflow.", false);
  // A test is how a connection becomes verified, so it can run on an unverified one; a step needs it verified.
  if (call.origin === "step" && row.status !== "active") {
    return blocked(row.status === "unverified" ? "The connection this step uses hasn't been verified. Send its test in Connections, then the run continues." : "The connection this step uses needs attention (its recent calls failed). Check it in Connections, then the run continues.", true);
  }
  if (!row.secret_ciphertext && row.kind === "slack_webhook") return blocked("The connection has no secret stored. Rotate it in Connections.", false);

  if (call.origin === "step") {
    if (conn.inFlight > MAX_CALLS_IN_FLIGHT) return blocked("This workspace has several outside calls going at once. This one waits its turn.", true);
    const limit = await consumeRateLimit(RATE_LIMITS.studioCallsByConnection, call.connectionId);
    if (!limit.allowed) return { ...blocked(`This connection is being called very often. The call waits ${limit.retryAfterSeconds} seconds.`, true), retryAfterSeconds: limit.retryAfterSeconds };
  }

  let secret = "";
  try {
    secret = row.secret_ciphertext ? decryptSecret(row.secret_ciphertext) : "";
  } catch {
    return blocked("The connection's secret can't be read. Rotate it in Connections.", false);
  }
  const secrets = secret ? [secret] : [];

  let method: HttpMethod | "SLACK";
  let host = "";
  let path = "";
  let judgement: CallJudgement;
  let response: PinnedResponse | null = null;
  try {
    if (call.kind === "slack") {
      method = "SLACK";
      if (!SLACK_WEBHOOK_URL.test(secret)) return blocked("The stored Slack address isn't a valid Slack incoming-webhook address. Rotate the connection.", false);
      const url = new URL(secret);
      host = url.hostname;
      path = "/services/…";
      response = await deps.request({
        method: "POST", url: secret, headers: { "Content-Type": "application/json; charset=utf-8", Accept: "text/plain" }, body: JSON.stringify({ text: call.text }),
        timeoutMs: clampTimeout(call.timeoutSeconds ?? 10), maxResponseBytes: 2048,
      });
      judgement = judgeResponse("POST", response.status, { retryAfterSeconds: response.retryAfterSeconds });
      // Slack answers 200 with the text "ok"; a 200 with anything else isn't a delivery.
      if (judgement.status === "sent" && response.body.trim() !== "ok") judgement = { status: "rejected", retryable: false, detail: "Slack answered, but not with its usual confirmation, so the message may not have been posted." };
      else if (response.status === 404 || response.status === 410 || response.status === 403) judgement = { status: "rejected", retryable: false, detail: "Slack no longer accepts this webhook (it was removed, or the channel is gone). Create a new one in Slack and rotate the connection." };
      else if (response.status === 400) judgement = { status: "rejected", retryable: false, detail: "Slack couldn't read the message." };
    } else {
      const settings = row.settings as HttpSettings;
      method = call.method;
      if (!settings?.methods?.includes(call.method)) return blocked(`This connection doesn't allow ${call.method} requests.`, false);
      const target = buildTarget({ host: settings.host, pathPrefix: settings.pathPrefix }, call.path, call.query ?? {});
      host = target.host;
      path = target.path;
      const extra = cleanStepHeaders(call.headers);
      const headers: Record<string, string> = { Accept: "application/json, text/plain;q=0.9, */*;q=0.1", ...extra, ...authHeaders(settings.auth, secret) };
      if (call.method !== "GET") headers["Idempotency-Key"] = call.idempotencyKey.slice(0, 120);
      const body = call.body;
      if (body !== undefined) {
        if (call.method === "GET") throw new OutboundPolicyError("A GET request doesn't carry a body.", "body");
        if (Buffer.byteLength(body) > HTTP_LIMITS.maxBodyBytes) throw new OutboundPolicyError(`The body is larger than ${HTTP_LIMITS.maxBodyBytes / 1024} KB.`, "body");
        if (!call.contentType) throw new OutboundPolicyError("The body needs a content type.", "content_type");
        headers["Content-Type"] = call.contentType;
      }
      response = await deps.request({ method: call.method, url: target.url, headers, ...(body !== undefined ? { body } : {}), timeoutMs: clampTimeout(call.timeoutSeconds), maxResponseBytes: HTTP_LIMITS.maxResponseBytes });
      judgement = judgeResponse(call.method, response.status, { retryAfterSeconds: response.retryAfterSeconds, safeToRepeat: call.safeToRepeat });
    }
  } catch (err) {
    method = call.kind === "slack" ? "SLACK" : call.method;
    judgement = judgeFailure(method === "SLACK" ? "POST" : method, err, { safeToRepeat: call.kind === "http" ? call.safeToRepeat : false });
    if (err instanceof OutboundPolicyError) judgement = { ...judgement, detail: err.message };
    if (!(err instanceof OutboundPolicyError) && !(err instanceof PinnedRequestError)) console.error("[iacquire] outbound call failed", { type: err instanceof Error ? err.name : "unknown" });
  }

  const durationMs = Math.max(0, deps.now() - started);
  const ok = judgement.status === "sent";
  const excerpt = response && !ok ? safeExcerpt(response.body, secrets, 160) : { text: null, note: null };
  const detail = redact(judgement.detail, secrets).slice(0, 300);
  const outcome = ok ? "sent" : judgement.status === "blocked" ? "blocked" : judgement.status === "rejected" ? "rejected" : "failed";
  const record = { host, path, method, httpStatus: response?.status ?? null, bytes: response?.bytes ?? null, durationMs, outcome, excerpt: excerpt.text, note: excerpt.note };

  await withSystem(async (db) => {
    await db.query(
      `insert into automation_connection_calls (org_id, connection_id, workflow_id, run_id, origin, method, host, path, outcome, http_status, response_bytes, duration_ms, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [call.orgId, call.connectionId, call.workflowId ?? null, call.runId ?? null, call.origin, method, host.slice(0, 253), path.slice(0, 300), outcome, response?.status ?? null, response?.bytes ?? null, durationMs, detail],
    );
    // Housekeeping: the log keeps the last 30 days.
    await db.query("delete from automation_connection_calls where org_id = $1 and connection_id = $2 and created_at < now() - interval '30 days'", [call.orgId, call.connectionId]);
    await settleConnection(db, call, row, judgement, response?.status ?? null, detail);
  });
  return { ...judgement, detail, httpStatus: response?.status ?? null, record };
}

function authHeaders(auth: HttpAuth, secret: string): Record<string, string> {
  switch (auth.type) {
    case "bearer": return { Authorization: `Bearer ${secret}` };
    case "header": return { [auth.name]: secret };
    case "basic": return { Authorization: `Basic ${Buffer.from(`${auth.username}:${secret}`).toString("base64")}` };
    default: return {};
  }
}

/** What the call means for the connection: a success clears its failures; credentials refused, or too many failures in a row, ask for attention. */
async function settleConnection(db: Queryable, call: OutboundCall, row: ConnectionRow, j: CallJudgement, httpStatus: number | null, detail: string): Promise<void> {
  if (j.status === "blocked") return;
  if (j.status === "sent") {
    await db.query(
      `update automation_connections set last_used_at = now(), consecutive_failures = 0,
         status = case when $3 and status <> 'revoked' then 'active' else status end,
         status_detail = case when $3 and status <> 'revoked' then null else status_detail end,
         verified_at = case when $3 and status <> 'revoked' then now() else verified_at end
       where id = $1 and org_id = $2`,
      [call.connectionId, call.orgId, call.origin === "test" || row.status === "needs_attention"],
    );
    return;
  }
  const refused = httpStatus === 401 || httpStatus === 403 || httpStatus === 410 || (httpStatus === 404 && call.kind === "slack");
  const failures = row.consecutive_failures + 1;
  const attention = refused || failures >= FAILURES_BEFORE_ATTENTION;
  const becameAttention = attention && row.status !== "needs_attention";
  await db.query(
    `update automation_connections set last_used_at = now(), consecutive_failures = $3, status = case when $4 and status <> 'revoked' then 'needs_attention' else status end,
       status_detail = case when $4 and status <> 'revoked' then $5 else status_detail end where id = $1 and org_id = $2`,
    [call.connectionId, call.orgId, failures, attention, detail.slice(0, 300)],
  );
  if (becameAttention) {
    const name = (await db.query<{ name: string }>("select name from automation_connections where id = $1", [call.connectionId])).rows[0]?.name ?? "A connection";
    await notifyOrgRoles(db, call.orgId, ["owner", "admin"], {
      kind: "system", severity: "warning", title: `The connection “${name}” needs attention`,
      body: refused ? "The other system refused the credentials. Workflows using it wait until it is fixed." : "Its recent calls kept failing. Workflows using it wait until it is checked.",
      link: "/automation-studio/connections", dedupeKey: `connection-attention:${call.connectionId}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
}
