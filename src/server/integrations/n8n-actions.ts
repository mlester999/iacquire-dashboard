import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { sha256 } from "@/server/security/crypto";
import { assertCredentialAdmin, encodeCredentialSecret, parseCredentialSecret, resolveCredential, revokeCredential, saveCredential } from "@/server/security/credentials";
import { validateIntegrationEndpoint } from "@/server/integrations/safety";
import { assertPublicHttps } from "@/server/calendars/adapters/http";
import { UnsafeAddressError, pinnedHttps } from "@/server/security/pinned-https";
import { classifyFetchFailure, signWebhookPayload, SIGNATURE_HEADER, WEBHOOK_API_VERSION } from "@/server/crm/webhooks";

// The workflow engine's "n8n" step: starts an agency-approved n8n workflow for one client through the workflow's Webhook trigger.
//
// How n8n is triggered from outside (verified against n8n's source, packages/nodes-base/nodes/Webhook and packages/cli/src/webhooks,
// October 2026): a Webhook node listens on <n8n base URL>/webhook/<path> (the "Production URL"; the segment is N8N_ENDPOINT_WEBHOOK, default
// "webhook"). That URL only answers while the workflow is active (published); otherwise n8n returns 404 "The requested webhook … is not
// registered" (also when the node doesn't accept the method). The node's HTTP Method must be POST here. Its "Header Auth" option reads an
// httpHeaderAuth credential (name + value), looks up that header (names are case-insensitive) and compares its value exactly, answering 403
// when it differs and 500 when the credential is missing (nodes/Webhook/utils.ts, validateWebhookAuthentication). "Respond: Immediately"
// (responseMode onReceived, the default) answers as soon as the request is accepted. n8n itself does not de-duplicate requests, so the
// Idempotency-Key header is for the workflow to use. The test URL (/webhook-test/…) only works while someone listens in the editor and is
// never used.
//
// Rules this module keeps:
//  * Off unless N8N_ACTIONS_ENABLED=true. It never activates, edits or lists workflows; an inactive workflow is reported, not switched on.
//  * Only a mapping in status "verified" (the agency's approved workflow for this client, checked by the integrations manager) whose
//    workflow is still on the connection's approved list, on an agency connection that passed its test, with a trigger an agency super
//    admin stored (configureN8nTrigger): the production URL on the
//    connection's own approved host, a header name and a token. The token lives in the credential vault, never in plain configuration.
//  * Every call is gated at the moment it runs by the workspace's status and its messaging/outbound/workflows pauses and the agency pause.
//  * Three phases: check and claim in one transaction (an append-only ledger in the audit log under the call's idempotency key), POST
//    outside any transaction with a timeout, record the outcome in a second transaction. A call whose outcome is unknown (timeout, dropped
//    connection, a server error from n8n) is never repeated: calling again with the same key returns the earlier outcome.

export const N8N_TRIGGER_HEADER_DEFAULT = "X-iAcquire-Token";
const CALL_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD = 64_000;
const LEDGER_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const triggerScope = (mappingId: string) => `n8n_webhook_trigger:${mappingId}`;

export const n8nActionsEnabled = () => env().N8N_ACTIONS_ENABLED === true;

export type N8nCallStatus = "sent" | "blocked" | "rejected" | "not_sent" | "unknown";

/**
 * - sent: n8n accepted the request (2xx); the workflow started.
 * - blocked: nothing was sent (switched off, paused, mapping not verified, trigger not configured). Safe to try again later.
 * - not_sent: the request never reached n8n (address refused, DNS, connection refused). `retryable` says whether trying again can help.
 * - rejected: n8n answered with an error, so the workflow did not run (403 token, 404 workflow inactive, 4xx). Retrying with the same key
 *   is allowed once the cause is fixed.
 * - unknown: sent but no clear answer (timeout, dropped connection, 5xx). Never retried; the same key returns "unknown" again.
 */
export interface N8nCallResult {
  status: N8nCallStatus;
  retryable: boolean;
  detail: string;
  httpStatus?: number | null;
  /** True when this key was already used and the earlier outcome is returned without calling n8n again. */
  duplicate?: boolean;
}

interface TriggerSecret {
  url: string;
  headerName: string;
  token: string;
}

async function activeTriggerCredential(db: Queryable, orgId: string, mappingId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    "select id from integration_credentials where org_id = $1 and provider = 'n8n' and $2 = any(scopes) and revoked_at is null order by created_at desc limit 1",
    [orgId, triggerScope(mappingId)],
  );
  return rows[0]?.id ?? null;
}

/** The trigger URL must be on the agency connection's own approved host and must not be the editor's test URL or n8n's REST API. */
function checkTriggerUrl(raw: string, baseUrl: string): string {
  const base = new URL(validateIntegrationEndpoint(baseUrl));
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new AppError("invalid_input", "Enter the workflow's full Production URL from its Webhook node.");
  }
  if (u.origin !== base.origin) throw new AppError("invalid_input", `The trigger must be on the agency n8n host (${base.host}).`);
  if (u.username || u.password || u.search || u.hash) throw new AppError("invalid_input", "Use the Production URL without credentials, query parameters or fragments.");
  if (/^\/(webhook-test|webhook-waiting|form-test|rest|api)\//i.test(u.pathname)) throw new AppError("invalid_input", "Use the Webhook node's Production URL (…/webhook/…), not the test URL or the n8n API.");
  if (u.pathname.length < 3 || u.toString().length > 500 || u.pathname.includes("..")) throw new AppError("invalid_input", "That trigger address doesn't look right.");
  return u.toString();
}

/**
 * Stores (or replaces) the webhook trigger for one client's approved workflow mapping. Agency super admins only. The token is the value of
 * the Header Auth credential on the workflow's Webhook node; it goes to the credential vault, with the URL and header name.
 */
export async function configureN8nTrigger(actorUserId: string, input: { orgId: string; mappingId: string; url: string; headerName?: string | null; token: string }): Promise<{ credentialId: string; host: string }> {
  if (!UUID.test(input.orgId) || !UUID.test(input.mappingId)) throw new AppError("invalid_input", "Choose a mapped workflow.");
  const headerName = (input.headerName ?? "").trim() || N8N_TRIGGER_HEADER_DEFAULT;
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(headerName)) throw new AppError("invalid_input", "Use a header name of letters, digits and dashes, as entered in the n8n Header Auth credential.");
  const token = String(input.token ?? "").trim();
  if (token.length < 32 || token.length > 512 || /\s/.test(token)) throw new AppError("invalid_input", "Use a token of 32 to 512 characters without spaces, the same value as in the n8n Header Auth credential.");
  return withSystem(async (db) => {
    await assertCredentialAdmin(db, actorUserId);
    const { rows } = await db.query<{ workflow_id: string; config: Record<string, unknown> }>(
      `select m.workflow_id, c.config from automation_template_mappings m join integration_connections c on c.id = m.global_connection_id
       where m.id = $1 and m.org_id = $2 and c.org_id is null and c.provider = 'n8n'`,
      [input.mappingId, input.orgId],
    );
    const m = rows[0];
    if (!m) throw new AppError("not_found", "That workflow isn't mapped to this client.");
    if (typeof m.config.baseUrl !== "string") throw new AppError("integration_unavailable", "Save the agency n8n connection first.");
    const url = checkTriggerUrl(input.url, m.config.baseUrl);
    const previous = await activeTriggerCredential(db, input.orgId, input.mappingId);
    const saved = await saveCredential(db, {
      orgId: input.orgId, provider: "n8n", label: `n8n webhook trigger (${m.workflow_id})`.slice(0, 120), secret: encodeCredentialSecret({ url, headerName, token }),
      scopes: [triggerScope(input.mappingId)], actorId: actorUserId,
    });
    if (previous) await revokeCredential(db, previous, input.orgId, "n8n", actorUserId);
    const host = new URL(url).host;
    await recordAudit({ orgId: input.orgId, actorUserId, actorKind: "agency", action: "automation.external_trigger_configured", targetType: "automation_template_mapping", targetId: input.mappingId, result: "success", metadata: { workflowId: m.workflow_id, host, headerName, replaced: Boolean(previous) } }, db);
    return { credentialId: saved.id, host };
  });
}

/** Removes a mapping's trigger: its n8n step is blocked until a new one is stored. */
export async function removeN8nTrigger(actorUserId: string, input: { orgId: string; mappingId: string }): Promise<boolean> {
  if (!UUID.test(input.orgId) || !UUID.test(input.mappingId)) throw new AppError("invalid_input", "Choose a mapped workflow.");
  return withSystem(async (db) => {
    await assertCredentialAdmin(db, actorUserId);
    const id = await activeTriggerCredential(db, input.orgId, input.mappingId);
    if (!id) return false;
    await revokeCredential(db, id, input.orgId, "n8n", actorUserId);
    await recordAudit({ orgId: input.orgId, actorUserId, actorKind: "agency", action: "automation.external_trigger_removed", targetType: "automation_template_mapping", targetId: input.mappingId, result: "success" }, db);
    return true;
  });
}

/** What the agency and the workflow editor may show about a mapping's trigger: never the token. */
export async function getN8nTriggerStatus(orgId: string, mappingId: string): Promise<{ configured: boolean; mappingStatus: string | null; workflowId: string | null }> {
  return withSystem(async (db) => {
    const m = await db.query<{ status: string; workflow_id: string }>("select status, workflow_id from automation_template_mappings where id = $1 and org_id = $2", [mappingId, orgId]);
    return { configured: Boolean(await activeTriggerCredential(db, orgId, mappingId)), mappingStatus: m.rows[0]?.status ?? null, workflowId: m.rows[0]?.workflow_id ?? null };
  });
}

/** What a client sees when n8n calls are off for the whole environment. Never the setting's name. */
export const N8N_SWITCHED_OFF = "Starting n8n automations is switched off by iAcquire for now, so nothing was sent to n8n.";

/**
 * For each of a workspace's verified mappings, why an n8n step starting it can't run right now, or null when it can: the same checks a call
 * makes before sending (switched on, the agency connection, the approved list, a stored trigger), short of pauses, which the editor shows
 * separately. Client-safe words only, for the workflow editor and its approval preview.
 */
export async function n8nStepReadiness(db: Queryable, orgId: string): Promise<Map<string, string | null>> {
  const { rows } = await db.query<{ id: string; workflow_id: string; connection_status: string | null; config: Record<string, unknown> | null }>(
    `select m.id, m.workflow_id, c.status as connection_status, c.config from automation_template_mappings m
     left join integration_connections c on c.id = m.global_connection_id and c.org_id is null and c.provider = 'n8n'
     where m.org_id = $1 and m.status = 'verified'`,
    [orgId],
  );
  const enabled = n8nActionsEnabled();
  const out = new Map<string, string | null>();
  for (const m of rows) {
    const approved = m.config?.approvedWorkflowIds;
    out.set(
      m.id,
      !enabled ? "Starting n8n automations is switched off by iAcquire for now, so this step won't run."
      : !m.connection_status || !["connected", "permission_limited"].includes(m.connection_status) ? "Your agency's n8n connection needs attention, so this step won't run."
      : !Array.isArray(approved) || !approved.includes(m.workflow_id) ? "This automation is no longer on your agency's approved list, so this step won't run."
      : !(await activeTriggerCredential(db, orgId, m.id)) ? "Your agency hasn't finished setting up this automation's trigger yet, so this step won't run."
      : null,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calling a workflow
// ---------------------------------------------------------------------------

type Claim =
  | { kind: "done"; result: N8nCallResult }
  | { kind: "call"; trigger: TriggerSecret; attempt: number; idem: string; workflowId: string; body: string };

const blocked = (detail: string): N8nCallResult => ({ status: "blocked", retryable: true, detail });

async function gate(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query<{ status: string; kind: string; pauses: string[] | null }>(
    `select o.status, o.kind,
       (select array_agg(p.scope) from automation_pauses p join organizations po on po.id = p.org_id
         where p.active and (p.org_id = o.id or (po.kind = 'agency' and p.scope = 'agency'))) as pauses
     from organizations o where o.id = $1`,
    [orgId],
  );
  const o = rows[0];
  if (!o || o.kind !== "client" || ["suspended", "archived"].includes(o.status)) return "This workspace is not active.";
  const pauses = new Set(o.pauses ?? []);
  if (pauses.has("agency")) return "iAcquire has paused automation for this workspace.";
  if (pauses.has("workflows")) return "Workflows are paused for this workspace.";
  if (pauses.has("outbound") || pauses.has("messaging")) return "Outbound automation is paused for this workspace.";
  return null;
}

/** The earlier outcome for this key, if a call already started; null when a new attempt may be made (with its number). */
async function ledger(db: Queryable, orgId: string, idem: string): Promise<{ result: N8nCallResult } | { attempt: number }> {
  const { rows } = await db.query<{ action: string; attempt: number; outcome: string | null; http: string | null }>(
    `select action, (metadata->>'attempt')::int as attempt, metadata->>'outcome' as outcome, metadata->>'httpStatus' as http from audit_logs
     where org_id = $1 and action in ('automation.external_call_started', 'automation.external_call_finished') and metadata->>'idem' = $2
       and created_at > now() - make_interval(days => $3::int) order by id`,
    [orgId, idem, LEDGER_DAYS],
  );
  const started = rows.filter((r) => r.action === "automation.external_call_started").map((r) => r.attempt);
  const finished = new Map(rows.filter((r) => r.action === "automation.external_call_finished").map((r) => [r.attempt, r]));
  const http = (r?: { http: string | null }) => (r?.http ? Number(r.http) : null);
  if (started.some((a) => !finished.has(a))) return { result: { status: "unknown", retryable: false, duplicate: true, detail: "A call with this key already started and its outcome is unknown, so it isn't repeated." } };
  const sent = [...finished.values()].find((r) => r.outcome === "sent");
  if (sent) return { result: { status: "sent", retryable: false, duplicate: true, httpStatus: http(sent), detail: "Already sent to n8n with this key." } };
  const unknown = [...finished.values()].find((r) => r.outcome === "unknown");
  if (unknown) return { result: { status: "unknown", retryable: false, duplicate: true, httpStatus: http(unknown), detail: "An earlier call with this key had an unknown outcome, so it isn't repeated." } };
  return { attempt: Math.max(0, ...started) + 1 };
}

async function claim(input: { orgId: string; mappingId: string; payload: Record<string, unknown>; idempotencyKey: string }): Promise<Claim> {
  return withSystem(async (db) => {
    const idem = sha256(`${input.orgId}:${input.idempotencyKey}`);
    // One call per key at a time: a concurrent duplicate waits here and then sees the first one's ledger entry.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`n8n:${idem}`]);
    const paused = await gate(db, input.orgId);
    if (paused) return { kind: "done", result: blocked(paused) };
    const { rows } = await db.query<{ workflow_id: string; status: string; connection_status: string; config: Record<string, unknown> }>(
      `select m.workflow_id, m.status, c.status as connection_status, c.config from automation_template_mappings m
       join integration_connections c on c.id = m.global_connection_id where m.id = $1 and m.org_id = $2 and c.org_id is null and c.provider = 'n8n'`,
      [input.mappingId, input.orgId],
    );
    const m = rows[0];
    if (!m) return { kind: "done", result: { status: "blocked", retryable: false, detail: "That n8n workflow isn't mapped to this workspace." } };
    if (m.status !== "verified") return { kind: "done", result: blocked("The agency hasn't verified this n8n workflow for this workspace yet.") };
    if (!["connected", "permission_limited"].includes(m.connection_status)) return { kind: "done", result: blocked("The agency n8n connection needs attention.") };
    // The agency's approved list is the allowlist: a workflow taken off it is never started, even if its mapping is still verified.
    const approved = m.config.approvedWorkflowIds;
    if (!Array.isArray(approved) || !approved.includes(m.workflow_id)) return { kind: "done", result: { status: "blocked", retryable: false, detail: "This n8n workflow is no longer on the agency's approved list." } };
    const credentialId = await activeTriggerCredential(db, input.orgId, input.mappingId);
    if (!credentialId) return { kind: "done", result: blocked("The agency hasn't set up this workflow's webhook trigger yet.") };
    const trigger = parseCredentialSecret(await resolveCredential(db, credentialId, input.orgId, "n8n"), ["url", "headerName", "token"] as const);
    if (!trigger) return { kind: "done", result: blocked("This workflow's webhook trigger couldn't be read. The agency needs to store it again.") };
    try {
      if (typeof m.config.baseUrl !== "string") throw new AppError("integration_unavailable", "The agency n8n connection has no address.");
      checkTriggerUrl(trigger.url, m.config.baseUrl);
    } catch (err) {
      return { kind: "done", result: { status: "blocked", retryable: false, detail: err instanceof AppError ? err.message : "The trigger address is no longer allowed." } };
    }
    const prior = await ledger(db, input.orgId, idem);
    if ("result" in prior) return { kind: "done", result: prior.result };
    const body = JSON.stringify({ id: `n8n_${idem.slice(0, 24)}`, type: "workflow.n8n", apiVersion: WEBHOOK_API_VERSION, occurredAt: new Date().toISOString(), orgId: input.orgId, idempotencyKey: input.idempotencyKey, data: input.payload });
    await recordAudit({ orgId: input.orgId, actorKind: "system", action: "automation.external_call_started", targetType: "automation_template_mapping", targetId: input.mappingId, result: "success", metadata: { idem, attempt: prior.attempt, workflowId: m.workflow_id, host: new URL(trigger.url).host } }, db);
    return { kind: "call", trigger, attempt: prior.attempt, idem, workflowId: m.workflow_id, body };
  });
}

async function post(trigger: TriggerSecret, body: string, idempotencyKey: string, callId: string): Promise<{ result: N8nCallResult; outcome: N8nCallStatus }> {
  try {
    await assertPublicHttps(new URL(trigger.url));
  } catch {
    return { outcome: "not_sent", result: { status: "not_sent", retryable: false, detail: "The trigger address resolves to a private or unknown network address, so it wasn't called." } };
  }
  const t = Math.floor(Date.now() / 1000);
  let res: { status: number };
  try {
    // Pinned to the addresses its own lookup checked, so a trigger host that starts resolving to a private address is never reached.
    res = await pinnedHttps.post({
      url: trigger.url,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "iAcquire-Workflows/1.0",
        [trigger.headerName]: trigger.token,
        [SIGNATURE_HEADER]: signWebhookPayload(trigger.token, body, t),
        "Idempotency-Key": idempotencyKey,
        "iAcquire-Event-Id": callId,
      },
      body,
      timeoutMs: CALL_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof UnsafeAddressError) return { outcome: "not_sent", result: { status: "not_sent", retryable: false, detail: "The trigger address resolves to a private or unknown network address, so it wasn't called." } };
    const c = classifyFetchFailure(err, CALL_TIMEOUT_MS);
    return c.kind === "not_sent"
      ? { outcome: "not_sent", result: { status: "not_sent", retryable: true, detail: `n8n couldn't be reached. ${c.error}` } }
      : { outcome: "unknown", result: { status: "unknown", retryable: false, detail: `${c.error} It won't be repeated automatically; check the workflow's executions in n8n.` } };
  }
  const s = res.status;
  if (s >= 200 && s < 300) return { outcome: "sent", result: { status: "sent", retryable: false, httpStatus: s, detail: `n8n accepted the request (HTTP ${s}).` } };
  if (s >= 500) return { outcome: "unknown", result: { status: "unknown", retryable: false, httpStatus: s, detail: `n8n answered HTTP ${s}; the workflow may have started. It won't be repeated automatically.` } };
  const detail =
    s === 401 || s === 403 ? "n8n refused the trigger token. The agency needs to store the token from the workflow's Header Auth credential again."
    : s === 404 ? "n8n says this webhook isn't registered for POST: the workflow is inactive, its path changed, or its Webhook node doesn't accept POST. iAcquire never activates n8n workflows; the agency activates it in n8n."
    : s === 429 ? "n8n asked us to slow down."
    : s >= 300 && s < 400 ? `n8n answered with a redirect (HTTP ${s}). Store the final Production URL.`
    : `n8n refused the request (HTTP ${s}).`;
  return { outcome: "rejected", result: { status: "rejected", retryable: s === 429, httpStatus: s, detail } };
}

/**
 * Starts the n8n workflow behind one verified mapping. Call it outside any transaction (it opens its own). `idempotencyKey` identifies the
 * step attempt (for example `wf:<runStepId>`): it is sent as the Idempotency-Key header, and a second call with it never sends again
 * unless the first one provably didn't run the workflow.
 */
export async function callN8nWorkflow(input: { orgId: string; mappingId: string; payload: Record<string, unknown>; idempotencyKey: string }): Promise<N8nCallResult> {
  if (!UUID.test(input.orgId) || !UUID.test(input.mappingId)) throw new AppError("invalid_input", "An n8n step needs a workspace and a mapped workflow.");
  if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 || /[\r\n]/.test(input.idempotencyKey)) throw new AppError("invalid_input", "An n8n step needs an idempotency key of 8 to 200 characters.");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new AppError("invalid_input", "An n8n step's payload must be an object.");
  if (JSON.stringify(input.payload).length > MAX_PAYLOAD) throw new AppError("invalid_input", "This n8n payload is too large (64 KB at most).");
  if (!n8nActionsEnabled()) return { status: "blocked", retryable: false, detail: N8N_SWITCHED_OFF };

  const c = await claim(input);
  if (c.kind === "done") return c.result;
  const { result, outcome } = await post(c.trigger, c.body, input.idempotencyKey, `n8n_${c.idem.slice(0, 24)}`);
  await recordAudit({
    orgId: input.orgId, actorKind: "system", action: "automation.external_call_finished", targetType: "automation_template_mapping", targetId: input.mappingId,
    result: outcome === "sent" ? "success" : "failure", metadata: { idem: c.idem, attempt: c.attempt, outcome, httpStatus: result.httpStatus ?? null, workflowId: c.workflowId },
  });
  return result;
}
