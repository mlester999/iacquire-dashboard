import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { createContactInTx, findByIdentities, normalizeContactInput } from "@/server/crm/contacts";
import { isPremiumVersion, loadApprovalState, trimJson, versionAuthorized, workflowActor } from "@/server/crm/workflows/engine";
import { createRun } from "@/server/crm/workflows/triggers";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import type { TriggerConfig, WorkflowStep } from "@/lib/crm/workflow/spec";

/**
 * The "inbound webhook" trigger: another system starts a workflow by POSTing JSON to the workflow's private URL,
 * /api/public/workflows/<workflow id>.<signature>. The signature is an HMAC of the workflow id and the nonce in the published version's
 * trigger, keyed from the server's encryption key, so the URL can't be guessed, changes when someone generates a new one and publishes,
 * and proves nothing else. The body can be matched to a contact by email or phone (and, when the trigger allows it, create one). Runs are
 * limited like every other start (the workflow's hourly limit) plus a per-minute limit on the URL, and an Idempotency-Key header makes a
 * retried call start nothing new.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;
export const INBOUND_MAX_BODY_BYTES = 32_768;
const INBOUND_PER_MINUTE: RateLimitRule = { name: "wf-inbound:workflow", limit: 120, windowSeconds: 60 };

function keyFrom(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("iacquire", "utf8"), Buffer.from("workflow-inbound-v1", "utf8"), 32));
}

/** The signing key, then retired keys that still verify (so rotating APP_ENCRYPTION_KEY doesn't break URLs at once). */
function keys(): Buffer[] {
  const e = env();
  if (!e.APP_ENCRYPTION_KEY && e.NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY is required to sign workflow webhook URLs.");
  const previous = (e.APP_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return [e.APP_ENCRYPTION_KEY ?? "iacquire-local-development-only-key", ...previous].map(keyFrom);
}

const mac = (key: Buffer, workflowId: string, nonce: string) => crypto.createHmac("sha256", key).update(`${workflowId.toLowerCase()}:${nonce}`).digest("base64url");

export function inboundToken(workflowId: string, nonce: string): string {
  return `${workflowId.toLowerCase()}.${mac(keys()[0], workflowId, nonce)}`;
}

export function inboundUrlFor(workflowId: string, nonce: string): string {
  return new URL(`/api/public/workflows/${inboundToken(workflowId, nonce)}`, env().APP_URL).toString();
}

function verifyToken(workflowId: string, signature: string, nonce: string): boolean {
  const given = Buffer.from(signature);
  return keys().some((k) => {
    const expected = Buffer.from(mac(k, workflowId, nonce));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

export interface InboundResult {
  httpStatus: number;
  body: { status: "accepted" | "duplicate" | "not_started" | "error"; runId?: string; detail: string };
}

const result = (httpStatus: number, body: InboundResult["body"]): InboundResult => ({ httpStatus, body });
const NOT_FOUND = result(404, { status: "error", detail: "Not found." });

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const pick = (body: Record<string, unknown>, ...keys: string[]): unknown => {
  const contact = body.contact && typeof body.contact === "object" && !Array.isArray(body.contact) ? (body.contact as Record<string, unknown>) : {};
  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null) return body[k];
    if (contact[k] !== undefined && contact[k] !== null) return contact[k];
  }
  return null;
};

/** Finds (or, when allowed, creates) the contact the body is about, by an exact email or phone match only. */
async function matchContact(db: Queryable, org: { id: string; name: string; timezone: string }, workflowName: string, body: Record<string, unknown>, create: boolean): Promise<{ contactId: string | null; created: boolean }> {
  const email = text(pick(body, "email"), 320);
  const phone = text(pick(body, "phone", "phoneNumber", "phone_number"), 40);
  if (!email && !phone) return { contactId: null, created: false };
  const code = (await db.query<{ c: string | null }>("select default_calling_code as c from crm_workspaces where org_id = $1", [org.id])).rows[0]?.c ?? null;
  // Each address on its own: a malformed email doesn't stop a good phone number from matching.
  const normalized = (input: { email?: string | null; phone?: string | null }) => {
    try {
      return normalizeContactInput(input, code);
    } catch (err) {
      if (err instanceof AppError) return null;
      throw err;
    }
  };
  const emails = email ? (normalized({ email })?.emails ?? []) : [];
  const phones = phone ? (normalized({ phone })?.phones ?? []) : [];
  if (!emails.length && !phones.length) return { contactId: null, created: false };
  const found = await findByIdentities(db, org.id, emails, phones);
  for (const f of found) {
    const live = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [f.contactId, org.id]);
    if (live.rows[0]) return { contactId: f.contactId, created: false };
  }
  // An address that belongs to an archived contact is not taken over by a new one.
  if (found.length || !create) return { contactId: null, created: false };
  const name = text(pick(body, "name", "fullName", "full_name"), 120);
  const r = await createContactInTx(db, workflowActor(org, workflowName), {
    email: emails[0] ?? null, phone: phones[0] ?? null, displayName: name, firstName: text(pick(body, "firstName", "first_name"), 80), lastName: text(pick(body, "lastName", "last_name"), 80),
  }, { via: "workflow", onDuplicate: "return_existing" });
  return { contactId: r.id, created: r.created };
}

/**
 * Handles one call to a workflow's inbound URL. Unknown or forged URLs, and workflows that are archived, get the same 404, so the URL
 * leaks nothing. A workflow that is off, or that is waiting for an owner's approval, answers 409 and starts nothing.
 */
export async function handleInboundWebhook(input: { token: string; body: unknown; idempotencyKey?: string | null; ipHash?: string | null; now?: Date }): Promise<InboundResult> {
  const m = TOKEN.exec(input.token ?? "");
  if (!m || !UUID.test(m[1])) return NOT_FOUND;
  const workflowId = m[1].toLowerCase();
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) return result(400, { status: "error", detail: "Send a JSON object." });
  const body = input.body as Record<string, unknown>;
  const idem = input.idempotencyKey?.trim() || null;
  if (idem && (idem.length > 200 || /[\r\n]/.test(idem))) return result(400, { status: "error", detail: "The Idempotency-Key header must be at most 200 characters." });
  const now = input.now ?? new Date();

  // Cheap checks first: the signature, from the published version's nonce (no lock taken for a forged URL).
  const target = await withSystem(async (db) => {
    const { rows } = await db.query<{ org_id: string; trigger_config: TriggerConfig }>(
      `select w.org_id, v.trigger_config from crm_workflows w join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
       where w.id = $1 and w.archived_at is null`,
      [workflowId],
    );
    return rows[0] ?? null;
  });
  const nonce = target?.trigger_config.type === "inbound_webhook" ? target.trigger_config.inbound?.nonce : null;
  if (!target || !nonce || !verifyToken(workflowId, m[2], nonce)) return NOT_FOUND;

  const rl = await consumeRateLimit(INBOUND_PER_MINUTE, workflowId);
  if (!rl.allowed) return result(429, { status: "not_started", detail: "Too many calls to this workflow. Try again in a minute." });

  return withSystem(async (db): Promise<InboundResult> => {
    const w = (await db.query<{ id: string; org_id: string; name: string; status: string; hourly_run_limit: number; published_version_id: string | null }>(
      "select id, org_id, name, status, hourly_run_limit, published_version_id from crm_workflows where id = $1 and archived_at is null for update",
      [workflowId],
    )).rows[0];
    if (!w || !w.published_version_id) return NOT_FOUND;
    const v = (await db.query<{ id: string; trigger_config: TriggerConfig; steps: WorkflowStep[]; effects: string[]; premium_features: string[]; content_hash: string; approved_hash: string | null; approval_id: string | null }>(
      "select id, trigger_config, steps, effects, premium_features, content_hash, approved_hash, approval_id from crm_workflow_versions where id = $1 and org_id = $2",
      [w.published_version_id, w.org_id],
    )).rows[0];
    // The URL belongs to the version that is published now: generating a new one and publishing retires the old URL.
    if (!v || v.trigger_config.type !== "inbound_webhook" || v.trigger_config.inbound?.nonce !== nonce) return NOT_FOUND;
    if (w.status !== "active") return result(409, { status: "not_started", detail: "This workflow is switched off, so nothing was started." });
    if (!versionAuthorized(v, await loadApprovalState(db, w.org_id, v.approval_id), now)) return result(409, { status: "not_started", detail: "This workflow is waiting for an owner's approval, so nothing was started." });
    // Checked before the body is matched to a contact, which can create one: a workspace without the plan gets nothing done for its call.
    const premium = isPremiumVersion(v);
    if (premium) {
      const plan = await studioEntitlement(db, w.org_id, now);
      if (!plan.entitled) return result(409, { status: "not_started", detail: `This workflow is part of Automation Studio, which isn't active for this workspace, so nothing was started. ${plan.reason}` });
    }
    if (idem) {
      // A call the hourly limit (or a plan limit) refused started nothing, so the caller's retry with the same key is a new attempt, not a duplicate.
      const dup = await db.query<{ id: string }>(
        `select id from crm_workflow_runs where workflow_id = $1 and org_id = $2 and started_via = 'webhook' and context->>'idempotencyKey' = $3
           and coalesce(context->>'outcome', '') not in ('rate_limited', 'quota_exceeded') limit 1`,
        [w.id, w.org_id, idem],
      );
      if (dup.rows[0]) return result(200, { status: "duplicate", runId: dup.rows[0].id, detail: "Already received; nothing new was started." });
    }
    const org = (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [w.org_id])).rows[0];
    const inbound = v.trigger_config.inbound!;
    const match = inbound.match === "email_or_phone" ? await matchContact(db, org, w.name, body, inbound.createContact) : { contactId: null, created: false };
    const r = await createRun(db, {
      orgId: w.org_id, workflowId: w.id, workflowName: w.name, hourlyRunLimit: w.hourly_run_limit, versionId: v.id, steps: v.steps, startedVia: "webhook",
      contactId: match.contactId, reentry: v.trigger_config.reentry, premium, now,
      context: { trigger: { type: "inbound_webhook", payload: { contactCreated: match.created } }, inbound: trimJson(body, 6000), ...(idem ? { idempotencyKey: idem } : {}) },
    });
    await recordAudit({
      orgId: w.org_id, actorKind: "system", action: "crm.workflow_inbound_received", targetType: "crm_workflow", targetId: w.id, ipHash: input.ipHash ?? null,
      result: r.status === "created" ? "success" : "denied", metadata: { outcome: r.status, runId: r.runId, contactMatched: Boolean(match.contactId), contactCreated: match.created },
    }, db);
    if (r.status === "created") return result(202, { status: "accepted", runId: r.runId, detail: "Accepted. The workflow runs shortly." });
    if (r.status === "limited") return result(429, { status: "not_started", detail: r.reason });
    return result(200, { status: "not_started", detail: r.reason });
  });
}
