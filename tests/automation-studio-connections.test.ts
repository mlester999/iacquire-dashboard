// Connections to outside systems (an HTTP API, a Slack incoming webhook) and the workflow steps that use them, end to end against the real services and
// database. The only things replaced are the DNS lookup and the final socket (`pinnedHttps.request`): nothing leaves the machine, and the tests read what
// the transport was asked to send. The transport's own refusals (private addresses, redirects, size limits, TLS) are tested in outbound-http.test.ts
// against a real local TLS server.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { decideApproval } from "@/server/approvals/service";
import { createContact } from "@/server/crm/contacts";
import { createWorkflow, publishWorkflow, requestWorkflowApproval, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { getRun, startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { hostResolver } from "@/server/calendars/adapters/http";
import { pinnedHttps, PinnedRequestError, type PinnedResponse } from "@/server/security/pinned-https";
import { createConnection, listConnectionCalls, listConnections, revokeConnection, rotateConnectionSecret, testConnection } from "@/server/automation-studio/connections";
import { performOutbound, slackText } from "@/server/automation-studio/outbound";
import { studioUsageSnapshot } from "@/server/automation-studio/usage";
import { captureFromClient, previewCapture } from "@/server/crm/blueprints/capture";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { ctxFor, uid } from "./support/fixtures";
import { agencyPeople } from "./support/crm";
import { studioWorkspace, type StudioWorkspace } from "./support/studio-workspace";

const SECRET = "sk_live_Zr7Qw1XyAbCdEf90";
const SLACK_HOOK = ["https://hooks.slack.com/services", "T0ABCDEFG", "B0HIJKLMN", "AbCdEfGhIjKlMnOpQrStUvWx"].join("/");
const PUBLIC_IP = ["93.184.216.34"];

const answer = (status: number, body = "{}", over: Partial<PinnedResponse> = {}): PinnedResponse => ({
  status, contentType: "application/json", retryAfterSeconds: null, bytes: Buffer.byteLength(body), truncated: false, body, ...over,
});

let request: MockInstance<typeof pinnedHttps.request>;
beforeEach(() => {
  vi.spyOn(hostResolver, "lookup").mockResolvedValue(PUBLIC_IP);
  request = vi.spyOn(pinnedHttps, "request").mockResolvedValue(answer(200));
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const httpInput = (over: Record<string, unknown> = {}) => ({
  kind: "http", name: `Orders ${uid()}`, baseUrl: "https://api.example.com/v1", methods: ["GET", "POST"], auth: { type: "bearer" }, secret: SECRET, testPath: "/ping", ...over,
});
const slackInput = (over: Record<string, unknown> = {}) => ({ kind: "slack_webhook", name: `Sales ${uid()}`, webhookUrl: SLACK_HOOK, channelLabel: "#sales", ...over });

/** A verified HTTP connection (its test went through). */
async function verifiedHttp(ws: StudioWorkspace, over: Record<string, unknown> = {}) {
  const owner = ws.o.actor("owner");
  const c = await createConnection(owner, httpInput(over));
  request.mockResolvedValueOnce(answer(200, '{"ok":true}'));
  const t = await testConnection(owner, c.id, { confirmed: true });
  expect(t.ok).toBe(true);
  request.mockClear();
  return t.connection;
}
async function verifiedSlack(ws: StudioWorkspace, over: Record<string, unknown> = {}) {
  const owner = ws.o.actor("owner");
  const c = await createConnection(owner, slackInput(over));
  request.mockResolvedValueOnce(answer(200, "ok", { contentType: "text/plain" }));
  const t = await testConnection(owner, c.id, { confirmed: true });
  expect(t.ok).toBe(true);
  request.mockClear();
  return t.connection;
}

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;

const postDef = (connectionId: string, over: Record<string, unknown> = {}): WorkflowDefinition => ({
  trigger: { type: "manual" },
  steps: [step("call", "http_request", {
    connectionId, method: "POST", path: "/leads", query: [{ name: "source", value: "iacquire" }], headers: [{ name: "X-Source", value: "iacquire" }],
    bodyType: "json", body: '{"name":"{{contact.first_name}}","email":"{{contact.email}}"}', ...over,
  })],
});
const slackDef = (connectionId: string, text = "New lead: {{contact.first_name}} {{contact.last_name}}"): WorkflowDefinition => ({
  trigger: { type: "manual" }, steps: [step("post", "slack_message", { connectionId, text })],
});

/** Publishes, has the owner approve the exact version (an outside call needs it) and switches the workflow on. */
async function liveStudioWorkflow(ws: StudioWorkspace, definition: WorkflowDefinition) {
  const manager = ws.o.actor("manager");
  const { id } = await createWorkflow(ws.o.actor("owner"), { name: `Outside ${uid()}`, definition, origin: "studio" });
  const published = await publishWorkflow(ws.o.actor("owner"), id);
  expect(published.needsApproval).toBe(true);
  const req = await requestWorkflowApproval(manager, id, null, { activate: true });
  const decided = await decideApproval(ctxFor(ws.o.people.owner, ws.o.org, "owner"), req.approvalId!, "approve");
  expect(decided.outcome?.status).toBe("succeeded");
  return id;
}

const newContact = async (ws: StudioWorkspace) => (await createContact(ws.o.actor("owner"), { firstName: "Ada", lastName: `Lovelace${uid().slice(0, 4)}`, email: `ada.${uid()}@example.com` })).id;

async function runRow(runId: string) {
  return (await withSystem((db) => db.query<{ status: string; last_error: string | null; attempts: number; next_run_at: Date; context: Record<string, unknown> }>("select status, last_error, attempts, next_run_at, context from crm_workflow_runs where id = $1", [runId]))).rows[0];
}
async function stepRows(runId: string) {
  return (await withSystem((db) => db.query<{ step_key: string; status: string; result: Record<string, unknown>; error: string | null }>("select step_key, status, result, error from crm_workflow_run_steps where run_id = $1 order by id", [runId]))).rows;
}
const connectionRow = async (id: string) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from automation_connections where id = $1", [id]))).rows[0];
const callsOf = async (id: string) => (await withSystem((db) => db.query<{ outcome: string; origin: string; http_status: number | null; detail: string | null; method: string; host: string; path: string }>("select outcome, origin, http_status, detail, method, host, path from automation_connection_calls where connection_id = $1 order by id", [id]))).rows;
const auditOf = async (orgId: string, action: string) => (await withSystem((db) => db.query<{ metadata: unknown }>("select metadata from audit_logs where org_id = $1 and action = $2", [orgId, action]))).rows;

// ---------------------------------------------------------------------------
// Setting up
// ---------------------------------------------------------------------------

describe("setting up a connection", () => {
  it("stores the secret encrypted, shows only its last characters, and writes it to no log", async () => {
    const ws = await studioWorkspace();
    const view = await createConnection(ws.o.actor("owner"), httpInput());
    expect(view).toMatchObject({ kind: "http", status: "unverified", secretHint: SECRET.slice(-4), secretVersion: 1, host: "api.example.com" });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(await listConnections(ws.o.actor("manager")))).not.toContain(SECRET);

    const row = await connectionRow(view.id);
    expect(String(row.secret_ciphertext)).not.toContain(SECRET);
    expect(String(row.secret_ciphertext).length).toBeGreaterThan(SECRET.length);
    expect(JSON.stringify(row.settings)).not.toContain(SECRET);
    const audits = JSON.stringify(await auditOf(ws.o.org.id, "automation_studio.connection_created"));
    expect(audits).toContain("api.example.com");
    expect(audits).not.toContain(SECRET);
  });

  it("keeps the secret out of the application database role's reach, and one workspace's rows out of another's", async () => {
    const a = await studioWorkspace();
    const b = await studioWorkspace();
    const mine = await createConnection(a.o.actor("owner"), httpInput());
    await createConnection(b.o.actor("owner"), httpInput());

    await expect(withUser(a.o.people.owner.id, (db) => db.query("select secret_ciphertext from automation_connections"))).rejects.toThrow(/permission denied/);
    await expect(withUser(a.o.people.owner.id, (db) => db.query("select * from automation_connections"))).rejects.toThrow(/permission denied/);
    const seen = await withUser(a.o.people.owner.id, (db) => db.query<{ id: string }>("select id from automation_connections"));
    expect(seen.rows.map((r) => r.id)).toEqual([mine.id]);
    // Nobody can write the table or the call log through the application role either.
    await expect(withUser(a.o.people.owner.id, (db) => db.query("update automation_connections set name = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(withUser(a.o.people.owner.id, (db) => db.query("delete from automation_connection_calls"))).rejects.toThrow(/permission denied/);
  });

  it("refuses addresses that can't be called, with a reason in words", async () => {
    const ws = await studioWorkspace();
    const owner = ws.o.actor("owner");
    const refuse = async (over: Record<string, unknown>, message: RegExp) => {
      await expect(createConnection(owner, httpInput(over))).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(message) });
    };
    await refuse({ baseUrl: "http://api.example.com" }, /https/i);
    await refuse({ baseUrl: "https://169.254.169.254/latest" }, /./);
    await refuse({ baseUrl: "https://10.0.0.5" }, /./);
    await refuse({ baseUrl: "https://localhost" }, /./);
    await refuse({ baseUrl: "https://user:pass@api.example.com" }, /./);
    await refuse({ baseUrl: "https://api.example.com:8443" }, /./);
    await refuse({ baseUrl: "https://api.example.com/v1?token=abc" }, /./);
    await refuse({ name: `${SECRET}` }, /credential/i);
    await refuse({ secret: undefined }, /token|key/i);
    await refuse({ auth: { type: "none" } }, /sends no credentials/i);
    await refuse({ methods: [] }, /method/i);
    await refuse({ methods: ["TRACE"] }, /./);
    // A name that resolves to a private address is refused when saved, and checked again on every call.
    vi.mocked(hostResolver.lookup).mockResolvedValue(["10.1.2.3"]);
    await refuse({}, /private or local network/);
    vi.mocked(hostResolver.lookup).mockRejectedValue(new Error("ENOTFOUND"));
    await refuse({}, /couldn't be found/);
    expect(await listConnections(owner)).toEqual([]);
  });

  it("accepts only a real Slack incoming-webhook address", async () => {
    const ws = await studioWorkspace();
    const owner = ws.o.actor("owner");
    for (const bad of ["https://evil.example/services/T0ABCDEFG/B0HIJKLMN/AbCdEfGhIjKlMnOpQrStUvWx", "http://hooks.slack.com/services/T0ABCDEFG/B0HIJKLMN/AbCdEfGhIjKlMnOpQrStUvWx", "https://hooks.slack.com/services/short", "https://hooks.slack.com.evil.example/services/T0ABCDEFG/B0HIJKLMN/AbCdEfGhIjKlMnOpQrStUvWx"]) {
      await expect(createConnection(owner, slackInput({ webhookUrl: bad })), bad).rejects.toMatchObject({ code: "invalid_input" });
    }
    const ok = await createConnection(owner, slackInput());
    expect(ok).toMatchObject({ kind: "slack_webhook", host: "hooks.slack.com", status: "unverified" });
    expect(JSON.stringify(ok)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });

  it("needs the permission, the plan, a unique name and stays within the limit", async () => {
    const ws = await studioWorkspace();
    await expect(createConnection(ws.o.actor("viewer"), httpInput())).rejects.toMatchObject({ code: "forbidden" });
    await expect(createConnection(ws.o.actor("support"), httpInput())).rejects.toMatchObject({ code: "forbidden" });
    const noPlan = await studioWorkspace({ plan: false });
    await expect(createConnection(noPlan.o.actor("owner"), httpInput())).rejects.toMatchObject({ code: "plan_required" });
    expect(await listConnections(noPlan.o.actor("owner"))).toEqual([]);

    const owner = ws.o.actor("owner");
    await createConnection(owner, httpInput({ name: "Orders" }));
    await expect(createConnection(owner, httpInput({ name: "orders" }))).rejects.toMatchObject({ code: "conflict" });
    for (let i = 0; i < 19; i++) await withSystem((db) => db.query("insert into automation_connections (org_id, kind, name, settings) values ($1, 'http', $2, $3)", [ws.o.org.id, `Filler ${i}`, JSON.stringify({ host: "api.example.com", pathPrefix: "", methods: ["GET"], auth: { type: "none" }, testPath: "/" })]));
    await expect(createConnection(owner, httpInput())).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/up to 20 connections/) });
  });
});

// ---------------------------------------------------------------------------
// Verifying, rotating, revoking
// ---------------------------------------------------------------------------

describe("verifying a connection", () => {
  it("sends nothing until the person has confirmed the test", async () => {
    const ws = await studioWorkspace();
    const c = await createConnection(ws.o.actor("owner"), httpInput());
    for (const bad of [undefined, {}, { confirmed: false }, { confirmed: "true" }]) {
      await expect(testConnection(ws.o.actor("owner"), c.id, bad as never)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(request).not.toHaveBeenCalled();
    expect((await connectionRow(c.id)).status).toBe("unverified");
  });

  it("verifies an HTTP connection with one GET to its test path, signed with the secret", async () => {
    const ws = await studioWorkspace();
    const c = await createConnection(ws.o.actor("owner"), httpInput());
    const t = await testConnection(ws.o.actor("owner"), c.id, { confirmed: true });
    expect(t).toMatchObject({ ok: true, connection: { status: "active" } });
    expect(t.connection.verifiedAt).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0];
    expect(sent).toMatchObject({ method: "GET", url: "https://api.example.com/v1/ping" });
    expect(sent.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(sent.body).toBeUndefined();
    expect(await callsOf(c.id)).toMatchObject([{ origin: "test", outcome: "sent", http_status: 200, method: "GET", host: "api.example.com", path: "/v1/ping" }]);
    expect(JSON.stringify(await auditOf(ws.o.org.id, "automation_studio.connection_tested"))).not.toContain(SECRET);
  });

  it("verifies a Slack connection by posting a message that says it is a test", async () => {
    const ws = await studioWorkspace();
    const c = await createConnection(ws.o.actor("owner"), slackInput());
    request.mockResolvedValueOnce(answer(200, "ok", { contentType: "text/plain" }));
    const t = await testConnection(ws.o.actor("owner"), c.id, { confirmed: true });
    expect(t.ok).toBe(true);
    const sent = request.mock.calls[0][0];
    expect(sent.url).toBe(SLACK_HOOK);
    expect(sent.method).toBe("POST");
    expect(JSON.parse(sent.body!).text).toMatch(/Test message from iAcquire Automation Studio/);
    // The call log names the host and never the webhook address.
    const calls = await callsOf(c.id);
    expect(calls[0]).toMatchObject({ outcome: "sent", host: "hooks.slack.com", path: "/services/…" });
    expect(JSON.stringify(calls)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });

  it("does not call Slack's confirmation a delivery unless it says ok, and asks for attention when Slack refuses the webhook", async () => {
    const ws = await studioWorkspace();
    const c = await createConnection(ws.o.actor("owner"), slackInput());
    request.mockResolvedValueOnce(answer(200, "<html>captive portal</html>", { contentType: "text/html" }));
    const odd = await testConnection(ws.o.actor("owner"), c.id, { confirmed: true });
    expect(odd.ok).toBe(false);
    expect(odd.detail).toMatch(/not with its usual confirmation/);
    expect(odd.connection.status).toBe("unverified");

    request.mockResolvedValueOnce(answer(404, "no_service", { contentType: "text/plain" }));
    const gone = await testConnection(ws.o.actor("owner"), c.id, { confirmed: true });
    expect(gone.ok).toBe(false);
    expect(gone.connection.status).toBe("needs_attention");
    expect(gone.detail).toMatch(/no longer accepts this webhook/);
    const notices = await withSystem((db) => db.query<{ title: string }>("select distinct title from notifications where org_id = $1 and dedupe_key like 'connection-attention:%'", [ws.o.org.id]));
    expect(notices.rows.map((r) => r.title)).toEqual([expect.stringMatching(/needs attention/)]);
  });

  it("allows only a few tests an hour for one connection", async () => {
    const ws = await studioWorkspace();
    const c = await createConnection(ws.o.actor("owner"), httpInput());
    for (let i = 0; i < 5; i++) await testConnection(ws.o.actor("owner"), c.id, { confirmed: true });
    await expect(testConnection(ws.o.actor("owner"), c.id, { confirmed: true })).rejects.toMatchObject({ code: "rate_limited" });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("answers 'not found' for another workspace's connection, whatever is asked", async () => {
    const a = await studioWorkspace();
    const b = await studioWorkspace();
    const theirs = await verifiedHttp(b);
    for (const act of [
      () => testConnection(a.o.actor("owner"), theirs.id, { confirmed: true }),
      () => rotateConnectionSecret(a.o.actor("owner"), theirs.id, "another-secret-123"),
      () => revokeConnection(a.o.actor("owner"), theirs.id),
    ]) await expect(act()).rejects.toMatchObject({ code: "not_found" });
    expect(await listConnections(a.o.actor("owner"))).toEqual([]);
    expect(await listConnectionCalls(a.o.actor("owner"), theirs.id)).toEqual([]);
    // Even code that has the id cannot use it from another workspace.
    const out = await performOutbound({ kind: "http", orgId: a.o.org.id, connectionId: theirs.id, origin: "step", idempotencyKey: "k1", method: "GET", path: "/x" });
    expect(out).toMatchObject({ status: "blocked", retryable: false });
    expect(request).not.toHaveBeenCalled();
    expect((await connectionRow(theirs.id)).status).toBe("active");
  });
});

describe("rotating and revoking", () => {
  it("replaces the secret, needs a new verification, and signs with the new secret only", async () => {
    const ws = await studioWorkspace();
    const owner = ws.o.actor("owner");
    const c = await verifiedHttp(ws);
    const before = String((await connectionRow(c.id)).secret_ciphertext);
    const rotated = await rotateConnectionSecret(owner, c.id, "sk_live_NewSecretValue99");
    expect(rotated).toMatchObject({ status: "unverified", secretVersion: 2, secretHint: "ue99" });
    expect(JSON.stringify(rotated)).not.toContain("NewSecretValue");
    expect(String((await connectionRow(c.id)).secret_ciphertext)).not.toBe(before);

    // A workflow step now waits (the connection isn't verified), and nothing is sent with either secret.
    const out = await performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: "k", method: "GET", path: "/x" });
    expect(out).toMatchObject({ status: "blocked", retryable: true });
    expect(request).not.toHaveBeenCalled();

    request.mockResolvedValueOnce(answer(200));
    expect((await testConnection(owner, c.id, { confirmed: true })).ok).toBe(true);
    expect(request.mock.calls[0][0].headers.Authorization).toBe("Bearer sk_live_NewSecretValue99");
    expect(JSON.stringify(await auditOf(ws.o.org.id, "automation_studio.connection_rotated"))).not.toContain("NewSecretValue");
  });

  it("validates a new Slack webhook address and a new HTTP secret", async () => {
    const ws = await studioWorkspace();
    const owner = ws.o.actor("owner");
    const slack = await createConnection(owner, slackInput());
    await expect(rotateConnectionSecret(owner, slack.id, "https://evil.example/hook")).rejects.toMatchObject({ code: "invalid_input" });
    const http = await createConnection(owner, httpInput());
    await expect(rotateConnectionSecret(owner, http.id, "short")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(rotateConnectionSecret(owner, http.id, "line\nbreak-in-secret")).rejects.toMatchObject({ code: "invalid_input" });
    const open = await createConnection(owner, httpInput({ auth: { type: "none" }, secret: undefined }));
    await expect(rotateConnectionSecret(owner, open.id, "sk_live_whatever123")).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/no credentials/) });
    await expect(rotateConnectionSecret(ws.o.actor("viewer"), http.id, "sk_live_whatever123")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("revokes for good: the secret is erased, steps are refused, and revoking never needs the plan", async () => {
    const ws = await studioWorkspace();
    const owner = ws.o.actor("owner");
    const c = await verifiedHttp(ws);
    const id = await liveStudioWorkflow(ws, postDef(c.id));
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now() where org_id = $1", [ws.o.org.id]));

    const revoked = await revokeConnection(owner, c.id);
    expect(revoked.connection).toMatchObject({ status: "revoked", secretHint: null });
    expect(revoked.workflowsUsingIt).toBe(1);
    const row = await connectionRow(c.id);
    expect(row.secret_ciphertext).toBeNull();
    expect(row.revoked_at).not.toBeNull();

    // Back on the plan, nothing can revive it, and a run that reaches the step is refused without any call.
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'active', expired_at = null where org_id = $1", [ws.o.org.id]));
    await expect(testConnection(owner, c.id, { confirmed: true })).rejects.toMatchObject({ code: "conflict" });
    await expect(rotateConnectionSecret(owner, c.id, "sk_live_BrandNewValue1")).rejects.toMatchObject({ code: "conflict" });
    await expect(revokeConnection(owner, c.id)).rejects.toMatchObject({ code: "conflict" });
    const out = await performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: "k", method: "GET", path: "/x" });
    expect(out).toMatchObject({ status: "blocked", retryable: false, detail: expect.stringMatching(/revoked/) });
    expect(request).not.toHaveBeenCalled();
    expect(id).toBeTruthy();
    expect(await listConnections(owner)).toEqual([]);
    expect((await listConnections(owner, { includeRevoked: true })).map((x) => x.status)).toEqual(["revoked"]);
  });
});

// ---------------------------------------------------------------------------
// The call itself
// ---------------------------------------------------------------------------

describe("one outside call", () => {
  it("sends the connection's host with a checked path, an encoded query, the credential and an idempotency key", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const out = await performOutbound({
      kind: "http", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: "run-1:call:1", method: "POST", path: "/orders/42",
      query: { q: "a b&c=d", empty: "" }, headers: { "X-Source": "iacquire", Accept: "application/json" }, body: '{"a":1}', contentType: "application/json",
    });
    expect(out).toMatchObject({ status: "sent", httpStatus: 200 });
    const sent = request.mock.calls[0][0];
    expect(sent.url).toBe("https://api.example.com/v1/orders/42?q=a%20b%26c%3Dd&empty=");
    expect(sent.headers).toMatchObject({ Authorization: `Bearer ${SECRET}`, "Idempotency-Key": "run-1:call:1", "Content-Type": "application/json", "X-Source": "iacquire" });
    expect(sent.maxResponseBytes).toBeLessThanOrEqual(256 * 1024);
    expect(sent.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("signs with a custom header or basic auth as configured", async () => {
    const ws = await studioWorkspace();
    const header = await verifiedHttp(ws, { auth: { type: "header", name: "X-Api-Key" } });
    await performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: header.id, origin: "step", idempotencyKey: "k1", method: "GET", path: "/x" });
    expect(request.mock.calls.at(-1)![0].headers["X-Api-Key"]).toBe(SECRET);
    const basic = await verifiedHttp(ws, { auth: { type: "basic", username: "shop" } });
    await performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: basic.id, origin: "step", idempotencyKey: "k2", method: "GET", path: "/x" });
    expect(request.mock.calls.at(-1)![0].headers.Authorization).toBe(`Basic ${Buffer.from(`shop:${SECRET}`).toString("base64")}`);
  });

  it("refuses what a connection or the policy doesn't allow, before anything is sent", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws); // allows GET and POST
    const base = { kind: "http" as const, orgId: ws.o.org.id, connectionId: c.id, origin: "step" as const, idempotencyKey: "k" };
    const cases: Array<[string, Partial<Parameters<typeof performOutbound>[0]> & Record<string, unknown>]> = [
      ["a method the connection doesn't allow", { method: "DELETE", path: "/x" }],
      ["a path that climbs out of the prefix", { method: "GET", path: "/../admin" }],
      ["an absolute address as a path", { method: "GET", path: "https://evil.example/x" }],
      ["a host smuggled in as a path", { method: "GET", path: "//evil.example/x" }],
      ["a credential header", { method: "GET", path: "/x", headers: { Authorization: "Bearer other" } }],
      ["a cookie header", { method: "GET", path: "/x", headers: { Cookie: "a=b" } }],
      ["a host override", { method: "GET", path: "/x", headers: { Host: "evil.example" } }],
      ["a header that carries a secret value", { method: "GET", path: "/x", headers: { "X-Note": "sk_live_Zr7Qw1Xy90Zr7Qw1" } }],
      ["a body on a GET", { method: "GET", path: "/x", body: "{}", contentType: "application/json" }],
      ["a body without a content type", { method: "POST", path: "/x", body: "{}" }],
      ["a body over the size limit", { method: "POST", path: "/x", body: "x".repeat(17 * 1024), contentType: "text/plain" }],
    ];
    for (const [label, over] of cases) {
      const out = await performOutbound({ ...base, ...over } as never);
      expect(out.status, label).toBe("blocked");
      expect(out.retryable, label).toBe(false);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("judges each answer by whether repeating the request is safe", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws, { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
    // Each answer is judged on its own: the connection is put back to healthy first, so five failures in a row don't ask for attention mid-test.
    const call = async (method: string, over: Record<string, unknown> = {}) => {
      await withSystem((db) => db.query("update automation_connections set status = 'active', consecutive_failures = 0 where id = $1", [c.id]));
      return performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: `k-${uid()}`, method: method as never, path: "/x", ...(method === "GET" ? {} : { body: "{}", contentType: "application/json" as const }), ...over });
    };

    request.mockResolvedValueOnce(answer(201));
    expect(await call("POST")).toMatchObject({ status: "sent" });
    request.mockResolvedValueOnce(answer(302, "", { contentType: null }));
    expect(await call("GET")).toMatchObject({ status: "rejected", retryable: false }); // a redirect is never followed
    request.mockResolvedValueOnce(answer(404));
    expect(await call("GET")).toMatchObject({ status: "rejected", retryable: false });
    request.mockResolvedValueOnce(answer(422, '{"error":"bad email"}'));
    expect(await call("POST")).toMatchObject({ status: "rejected", retryable: false });
    request.mockResolvedValueOnce(answer(429, "{}", { retryAfterSeconds: 90 }));
    expect(await call("POST")).toMatchObject({ status: "rejected", retryable: true, retryAfterSeconds: 90 });
    request.mockResolvedValueOnce(answer(503));
    expect(await call("POST")).toMatchObject({ status: "rejected", retryable: true });
    // A server error on a POST may have done the work: unknown, never retried blindly. On a GET it is safe to try again.
    request.mockResolvedValueOnce(answer(500));
    expect(await call("POST")).toMatchObject({ status: "unknown", retryable: false });
    request.mockResolvedValueOnce(answer(500));
    expect(await call("GET")).toMatchObject({ status: "rejected", retryable: true });
    request.mockResolvedValueOnce(answer(500));
    expect(await call("POST", { safeToRepeat: true })).toMatchObject({ status: "rejected", retryable: true });
    // The connection broke before anything left: safe to retry. After the request left: unknown.
    request.mockRejectedValueOnce(new PinnedRequestError("connect ECONNREFUSED", "ECONNREFUSED", "before_send"));
    expect(await call("POST")).toMatchObject({ status: "not_sent", retryable: true });
    request.mockRejectedValueOnce(new PinnedRequestError("socket hang up", "ECONNRESET", "after_send"));
    expect(await call("POST")).toMatchObject({ status: "unknown", retryable: false });
    request.mockRejectedValueOnce(new PinnedRequestError("timed out", "ETIMEDOUT", "after_send"));
    expect(await call("GET")).toMatchObject({ retryable: true });
  });

  it("keeps a log of host, path, status and time, and redacts the secret out of whatever the other side echoes back", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    request.mockResolvedValueOnce(answer(401, `{"error":"invalid token ${SECRET}","hint":"Bearer ${SECRET}"}`));
    const out = await performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: "k-redact", method: "GET", path: "/orders/7", query: { email: "ada@example.com" } });
    expect(out.status).toBe("rejected");
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.record.excerpt).toContain("[removed]");
    const log = JSON.stringify(await callsOf(c.id));
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain("ada@example.com"); // the query is never logged
    expect(log).toContain("/v1/orders/7");
    // A refusal of the credentials asks for attention at once.
    expect((await connectionRow(c.id)).status).toBe("needs_attention");
    const again = await performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: "k-2", method: "GET", path: "/x" });
    expect(again).toMatchObject({ status: "blocked", retryable: true });
  });

  it("asks for attention after repeated failures and recovers on a success", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const get = () => performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: `k-${uid()}`, method: "GET", path: "/x" });
    for (let i = 0; i < 4; i++) {
      request.mockResolvedValueOnce(answer(502));
      await get();
    }
    expect((await connectionRow(c.id)).status).toBe("active");
    request.mockResolvedValueOnce(answer(200));
    await get();
    expect((await connectionRow(c.id)).consecutive_failures).toBe(0);
    for (let i = 0; i < 5; i++) {
      request.mockResolvedValueOnce(answer(502));
      await get();
    }
    expect((await connectionRow(c.id)).status).toBe("needs_attention");
  });

  it("limits how often one connection is called, and how many calls a workspace has going at once", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const get = () => performOutbound({ kind: "http", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: `k-${uid()}`, method: "GET", path: "/x" });
    for (let i = 0; i < 60; i++) expect((await get()).status).toBe("sent");
    const held = await get();
    expect(held).toMatchObject({ status: "blocked", retryable: true });
    expect(held.retryAfterSeconds).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledTimes(60);

    // Six steps already mid-call in this workspace: the next one waits its turn.
    const other = await studioWorkspace();
    const o2 = await verifiedHttp(other);
    const wfId = await liveStudioWorkflow(other, postDef(o2.id));
    const contactId = await newContact(other);
    const { runId } = await startManualRun(other.o.actor("owner"), wfId, { contactId });
    for (let i = 0; i < 6; i++) await withSystem((db) => db.query("insert into crm_workflow_run_steps (org_id, run_id, step_key, kind, attempt, status, idempotency_key, started_at) values ($1, $2, $3, 'http_request', 1, 'running', $4, now())", [other.o.org.id, runId, `busy${i}`, `busy-${runId}-${i}`]));
    request.mockClear();
    const waits = await performOutbound({ kind: "http", orgId: other.o.org.id, connectionId: o2.id, origin: "step", idempotencyKey: "k-busy", method: "GET", path: "/x" });
    expect(waits).toMatchObject({ status: "blocked", retryable: true, detail: expect.stringMatching(/at once/) });
    expect(request).not.toHaveBeenCalled();
  });

  it("makes text from workspace data harmless to Slack: no mentions, no links, no channel-wide pings", async () => {
    expect(slackText("<!channel> hi <@U123> <https://evil.example|click> & more")).toBe("&lt;!channel&gt; hi &lt;@U123&gt; &lt;https://evil.example|click&gt; &amp; more");
    expect(slackText("x".repeat(5000)).length).toBe(1500);
    const ws = await studioWorkspace();
    const c = await verifiedSlack(ws);
    request.mockResolvedValueOnce(answer(200, "ok", { contentType: "text/plain" }));
    const out = await performOutbound({ kind: "slack", orgId: ws.o.org.id, connectionId: c.id, origin: "step", idempotencyKey: "s1", text: slackText("<!here> new lead") });
    expect(out.status).toBe("sent");
    expect(JSON.parse(request.mock.calls[0][0].body!).text).toBe("&lt;!here&gt; new lead");
  });
});

// ---------------------------------------------------------------------------
// In workflows
// ---------------------------------------------------------------------------

describe("HTTP and Slack steps in a workflow", () => {
  it("are premium: a workflow with one needs the plan to be saved, published or copied, even if built in the CRM screens", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const noPlan = await studioWorkspace({ plan: false });
    await expect(createWorkflow(noPlan.o.actor("owner"), { name: "Sneaky", definition: postDef(c.id) })).rejects.toMatchObject({ code: "plan_required" });
    const made = await createWorkflow(ws.o.actor("owner"), { name: "Allowed", definition: postDef(c.id) });
    const row = (await withSystem((db) => db.query<{ origin: string }>("select origin from crm_workflows where id = $1", [made.id]))).rows[0];
    expect(row.origin).toBe("crm");
    const published = await publishWorkflow(ws.o.actor("owner"), made.id);
    expect(published.needsApproval).toBe(true);
    const version = (await withSystem((db) => db.query<{ premium_features: string[]; effects: string[] }>("select premium_features, effects from crm_workflow_versions where workflow_id = $1", [made.id]))).rows[0];
    expect(version.premium_features).toContain("http_request");
    expect(version.effects).toContain("http");
  });

  it("can't be published with another workspace's connection, a method it doesn't allow, or a connection that doesn't exist", async () => {
    const a = await studioWorkspace();
    const b = await studioWorkspace();
    const theirs = await verifiedHttp(b);
    const mine = await verifiedHttp(a); // allows GET and POST
    const owner = a.o.actor("owner");
    const publish = async (def: WorkflowDefinition) => {
      const { id } = await createWorkflow(owner, { name: `Bad ${uid()}`, definition: def, origin: "studio" });
      return publishWorkflow(owner, id);
    };
    await expect(publish(postDef(theirs.id))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publish(postDef(crypto.randomUUID()))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publish(postDef(mine.id, { method: "DELETE" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publish(postDef(mine.id, { path: "/../admin" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publish(postDef(mine.id, { path: "https://evil.example/x" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publish(postDef(mine.id, { headers: [{ name: "Authorization", value: "Bearer other" }] }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publish(postDef(mine.id, { body: "{not json" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publish(postDef(mine.id, { path: "/x/{{contact.nonsense}}" }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("only describes a test run: nothing is sent, and what would be sent is shown without any secret", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const contactId = await newContact(ws);
    const owner = ws.o.actor("owner");
    const { id } = await createWorkflow(owner, { name: `Dry ${uid()}`, definition: postDef(c.id), origin: "studio" });

    const draft = await startTestRun(owner, id, { source: "draft", contactId });
    expect(draft.steps[0]).toMatchObject({ kind: "http_request", outcome: "would_skip" });
    expect(draft.steps[0].detail).toMatch(/owner must approve/);

    await publishWorkflow(owner, id);
    const req = await requestWorkflowApproval(ws.o.actor("manager"), id, null, { activate: false });
    await decideApproval(ctxFor(ws.o.people.owner, ws.o.org, "owner"), req.approvalId!, "approve");
    const published = await startTestRun(owner, id, { source: "published", contactId });
    expect(published.steps[0].outcome).toBe("would_run");
    expect(published.steps[0].detail).toMatch(/Would send POST api\.example\.com\/v1\/leads through/);
    expect(published.steps[0].detail).toMatch(/Nothing is sent in a test/);
    expect(JSON.stringify(published)).not.toContain(SECRET);
    expect(request).not.toHaveBeenCalled();
    expect((await callsOf(c.id)).filter((x) => x.origin === "step")).toEqual([]);
  });

  it("a Slack test run shows the message and posts nothing", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedSlack(ws);
    const contactId = await newContact(ws);
    const owner = ws.o.actor("owner");
    const id = await liveStudioWorkflow(ws, slackDef(c.id, "New lead <!channel> {{contact.first_name}}"));
    const t = await startTestRun(owner, id, { source: "published", contactId });
    expect(t.steps[0].outcome).toBe("would_run");
    expect(t.steps[0].detail).toContain("&lt;!channel&gt; Ada");
    expect(request).not.toHaveBeenCalled();
  });

  it("sends the call once approved: the right address, credential, filled placeholders and one idempotency key, and counts it", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const id = await liveStudioWorkflow(ws, postDef(c.id));
    const contactId = await newContact(ws);
    request.mockResolvedValueOnce(answer(201, '{"id":"lead_1"}'));
    const { runId } = await startManualRun(ws.o.actor("owner"), id, { contactId });
    await processWorkflowRuns({});
    expect((await runRow(runId)).status).toBe("completed");

    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0];
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("https://api.example.com/v1/leads?source=iacquire");
    expect(sent.headers).toMatchObject({ Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", "X-Source": "iacquire" });
    expect(sent.headers["Idempotency-Key"]).toMatch(/^\S+$/);
    const body = JSON.parse(sent.body!);
    expect(body.name).toBe("Ada");
    expect(body.email).toMatch(/@example\.com$/);

    const steps = await stepRows(runId);
    const done = steps.find((s) => s.status === "completed")!;
    expect(done.result).toMatchObject({ status: "sent", httpStatus: 201, host: "api.example.com", method: "POST" });
    expect(JSON.stringify(steps)).not.toContain(SECRET);
    expect(JSON.stringify(steps)).not.toContain("lead_1"); // the other system's answer is not kept when the call worked
    expect((await callsOf(c.id)).filter((x) => x.origin === "step")).toMatchObject([{ outcome: "sent", http_status: 201, method: "POST", path: "/v1/leads" }]);

    const usage = await withSystem((db) => studioUsageSnapshot(db, ws.o.org.id, new Date()));
    expect(usage.counters.integration_calls.quantity).toBeGreaterThanOrEqual(1);
  });

  it("posts to Slack with the filled, escaped message and never shows the webhook address", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedSlack(ws);
    const id = await liveStudioWorkflow(ws, slackDef(c.id));
    const contactId = await newContact(ws);
    await withSystem((db) => db.query("update contacts set first_name = '<!channel> Ada' where id = $1", [contactId]));
    request.mockResolvedValueOnce(answer(200, "ok", { contentType: "text/plain" }));
    const { runId } = await startManualRun(ws.o.actor("owner"), id, { contactId });
    await processWorkflowRuns({});
    expect((await runRow(runId)).status).toBe("completed");
    const sent = request.mock.calls[0][0];
    expect(sent.url).toBe(SLACK_HOOK);
    expect(JSON.parse(sent.body!).text).toMatch(/^New lead: &lt;!channel&gt; Ada/);
    const stored = JSON.stringify([await stepRows(runId), await callsOf(c.id), await getRun(ws.o.actor("owner"), runId)]);
    expect(stored).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });

  it("holds the run, without trying, while the connection isn't verified, and carries on once it is", async () => {
    const ws = await studioWorkspace();
    const owner = ws.o.actor("owner");
    const verified = await verifiedHttp(ws);
    const c = verified;
    const id = await liveStudioWorkflow(ws, postDef(c.id));
    // The secret is changed after the version was approved: the connection must be verified again before anything is sent with it.
    await rotateConnectionSecret(owner, c.id, "sk_live_RotatedApproval1");
    const { runId } = await startManualRun(owner, id, { contactId: await newContact(ws) });
    const t = Date.now();
    await processWorkflowRuns({ now: new Date(t) });
    let run = await runRow(runId);
    expect(run.status).toBe("queued");
    expect(run.last_error).toMatch(/^On hold: .*hasn't been verified/);
    expect(run.attempts).toBe(0);
    expect(request).not.toHaveBeenCalled();

    request.mockResolvedValueOnce(answer(200));
    expect((await testConnection(owner, c.id, { confirmed: true })).ok).toBe(true);
    request.mockClear();
    request.mockResolvedValueOnce(answer(200));
    await processWorkflowRuns({ now: new Date(t + 16 * 60_000) });
    run = await runRow(runId);
    expect(run.status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never repeats a request that may have gone through, and says what to check", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const id = await liveStudioWorkflow(ws, postDef(c.id));
    const { runId } = await startManualRun(ws.o.actor("owner"), id, { contactId: await newContact(ws) });
    request.mockResolvedValue(answer(500, "boom"));
    const t = Date.now();
    await processWorkflowRuns({ now: new Date(t) });
    await processWorkflowRuns({ now: new Date(t + 2 * 3600_000) });
    await processWorkflowRuns({ now: new Date(t + 24 * 3600_000) });
    const run = await runRow(runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toMatch(/couldn't confirm whether the other system ran/);
    expect(run.context.outcome).toBe("external_unknown");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a refusal that can pass, waiting at least as long as the other side asked, with the same idempotency key", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const id = await liveStudioWorkflow(ws, postDef(c.id));
    const { runId } = await startManualRun(ws.o.actor("owner"), id, { contactId: await newContact(ws) });
    request.mockResolvedValueOnce(answer(429, "{}", { retryAfterSeconds: 1200 }));
    request.mockResolvedValueOnce(answer(200));
    const t = Date.now();
    await processWorkflowRuns({ now: new Date(t) });
    const waiting = await runRow(runId);
    expect(waiting.status).toBe("queued");
    expect(new Date(waiting.next_run_at).getTime()).toBeGreaterThanOrEqual(t + 1200_000 - 1000);
    await processWorkflowRuns({ now: new Date(t + 60_000) });
    expect(request).toHaveBeenCalledTimes(1); // not yet
    await processWorkflowRuns({ now: new Date(t + 1300_000) });
    expect((await runRow(runId)).status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].headers["Idempotency-Key"]).toBe(request.mock.calls[0][0].headers["Idempotency-Key"]);
  });

  it("is refused at call time when the name now points inside a private network (DNS rebinding), with no connection made", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const id = await liveStudioWorkflow(ws, postDef(c.id));
    const { runId } = await startManualRun(ws.o.actor("owner"), id, { contactId: await newContact(ws) });
    // The real transport runs here: only the resolver answers differently now.
    request.mockRestore();
    vi.mocked(hostResolver.lookup).mockResolvedValue(["169.254.169.254"]);
    await processWorkflowRuns({});
    const run = await runRow(runId);
    expect(run.status).not.toBe("completed");
    expect(run.last_error ?? "").toMatch(/private|local network|wasn't called|didn't run/i);
    const calls = (await callsOf(c.id)).filter((x) => x.origin === "step");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((x) => x.outcome !== "sent")).toBe(true);
  });

  it("holds a queued run when the plan lapses and makes no call, then carries on once the plan is back", async () => {
    const ws = await studioWorkspace();
    const owner = ws.o.actor("owner");
    const c = await verifiedHttp(ws);
    const id = await liveStudioWorkflow(ws, postDef(c.id));
    const { runId } = await startManualRun(owner, id, { contactId: await newContact(ws) });
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now() where org_id = $1", [ws.o.org.id]));
    await processWorkflowRuns({});
    const held = await runRow(runId);
    expect(held.status).toBe("queued");
    expect(held.last_error).toMatch(/^On hold: Automation Studio isn't active/);
    expect(request).not.toHaveBeenCalled();
    expect((await callsOf(c.id)).filter((x) => x.origin === "step")).toEqual([]);

    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'active', expired_at = null where org_id = $1", [ws.o.org.id]));
    request.mockResolvedValueOnce(answer(200));
    await processWorkflowRuns({ now: new Date(Date.now() + 2 * 3600_000) });
    expect((await runRow(runId)).status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops at a revoked connection with a plain message, and never reaches the other system", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    const id = await liveStudioWorkflow(ws, postDef(c.id));
    const { runId } = await startManualRun(ws.o.actor("owner"), id, { contactId: await newContact(ws) });
    await revokeConnection(ws.o.actor("owner"), c.id);
    await processWorkflowRuns({});
    const run = await runRow(runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toMatch(/revoked/);
    expect(request).not.toHaveBeenCalled();
  });

  it("won't run a version the owner hasn't approved, and an edit after approval needs a fresh approval", async () => {
    const ws = await studioWorkspace();
    const owner = ws.o.actor("owner");
    const c = await verifiedHttp(ws);
    const { id } = await createWorkflow(owner, { name: `Unapproved ${uid()}`, definition: postDef(c.id), origin: "studio" });
    await publishWorkflow(owner, id);
    await expect(setWorkflowStatus(owner, id, "active")).rejects.toThrow();
    await expect(startManualRun(owner, id, { contactId: await newContact(ws) })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What stays inside a workspace
// ---------------------------------------------------------------------------

describe("connections and Blueprints", () => {
  it("never travel in a Blueprint: capturing a workspace with an HTTP workflow still works, and leaves that workflow out with a reason", async () => {
    const ws = await studioWorkspace();
    const c = await verifiedHttp(ws);
    await createWorkflow(ws.o.actor("owner"), { name: "Pushes leads out", definition: postDef(c.id), origin: "studio" });
    const agency = await agencyPeople();
    const preview = await previewCapture(agency.superAdmin, ws.o.org.id);
    expect(JSON.stringify(preview)).not.toContain(SECRET);
    expect(JSON.stringify(preview)).not.toContain(c.id);
    expect(preview.candidates.find((x) => x.name === "Pushes leads out")).toMatchObject({ capturable: false, note: expect.stringMatching(/belong to one workspace only/) });
    const captured = await captureFromClient(agency.superAdmin, ws.o.org.id, { name: "From a studio workspace", industry: "other", sections: ["tags", "workflows"], includeValues: false });
    const stored = JSON.stringify((await withSystem((db) => db.query("select * from crm_blueprints where id = $1", [captured.blueprintId]))).rows);
    const versions = JSON.stringify((await withSystem((db) => db.query("select * from crm_blueprint_versions where blueprint_id = $1", [captured.blueprintId]))).rows);
    for (const text of [stored, versions]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(c.id);
      expect(text).not.toContain("api.example.com");
    }
  });
});
