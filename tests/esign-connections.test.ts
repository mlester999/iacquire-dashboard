// Connecting the business's own signing account: who may, what is checked first, how the keys are kept, what the address for notices is, and what disconnecting does. Embedded
// Postgres; PandaDoc is a replaced HTTP layer (the platform's fetch) and the stand-in service is in-process. Nothing reaches another machine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { decryptSecret } from "@/server/security/crypto";
import { checkConnection, connectPandaDoc, connectSimulated, disconnect, disconnectWorkspaceEsign, getConnection, getWebhookUrl } from "@/server/esign/connections";
import { openCredentials, sealCredentials } from "@/server/esign/credentials";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { hashWebhookToken, looksLikeWebhookToken, tokenForStoredConnection, webhookTokenFor } from "@/server/esign/webhook-token";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { askToSign, connectionKeys, proposalOrg, rows, sentForSigning, setFeature, signingOrg } from "./support/proposals";

const KEY = "pd_sandbox_api_key_0123456789";
const WEBHOOK_KEY = "wh_shared_key_abcdef";

beforeEach(() => simulatedEsign.reset());
afterEach(() => vi.unstubAllGlobals());

/** The platform's fetch, replaced: answers the one question a connection asks (can this key list documents?). */
function pandaDocAnswers(status = 200) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
    return new Response(JSON.stringify({ results: [] }), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}
const connections = (orgId: string) => rows<{ id: string; provider: string; mode: string; status: string; credentials: string | null; webhook_token_hash: string; label: string; connected_by: string | null; disconnected_at: Date | null }>(
  "select id, provider, mode, status, credentials, webhook_token_hash, label, connected_by, disconnected_at from esign_connections where org_id = $1 order by connected_at, id", [orgId]);

describe("who may connect, and when", () => {
  it("lets only the owner and a manager connect, change or disconnect it, and everyone who can see proposals look at it", async () => {
    const p = await signingOrg({ connect: false });
    for (const who of ["sales", "setter", "support", "viewer"] as const) {
      await expect(connectSimulated(p.actor(who)), who).rejects.toThrow(/Only the business owner or a manager/);
      await expect(connectPandaDoc(p.actor(who), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox" }), who).rejects.toThrow(/Only the business owner or a manager/);
      await expect(disconnect(p.actor(who)), who).rejects.toThrow(/Only the business owner or a manager/);
      await expect(checkConnection(p.actor(who)), who).rejects.toThrow(/Only the business owner or a manager/);
      await expect(getWebhookUrl(p.actor(who)), who).rejects.toThrow(/Only the business owner or a manager/);
    }
    expect(await connections(p.org.id)).toEqual([]);
    // A manager connects it; the sales rep, who can send proposals but cannot connect, can see that it is there.
    const view = await connectSimulated(p.actor("manager"));
    expect(view).toMatchObject({ provider: "simulated", mode: "simulated", status: "connected" });
    expect(await getConnection(p.actor("sales"))).toMatchObject({ id: view.id });
    expect(await getConnection(p.actor("viewer"))).toMatchObject({ id: view.id });
    expect((await connections(p.org.id))[0].connected_by).toBe(p.people.manager.id);
  });

  it("is refused with a plain message while proposals or signing is not switched on for the workspace", async () => {
    const p = await signingOrg({ connect: false });
    await setFeature(p.org.id, false, "esign");
    await expect(connectSimulated(p.actor("owner"))).rejects.toThrow(/Electronic signing isn't switched on/);
    await setFeature(p.org.id, true, "esign");
    await setFeature(p.org.id, false, "proposals");
    await expect(connectSimulated(p.actor("owner"))).rejects.toThrow(/Proposals aren't switched on/);
    await expect(getConnection(p.actor("owner"))).rejects.toThrow(/Proposals aren't switched on/);
    expect(await connections(p.org.id)).toEqual([]);
  });
});

describe("connecting PandaDoc (against a replaced HTTP layer)", () => {
  it("checks the key with PandaDoc first, with a question that creates nothing, and saves it sealed", async () => {
    const p = await signingOrg({ connect: false });
    const calls = pandaDocAnswers();
    const view = await connectPandaDoc(p.actor("owner"), { apiKey: ` ${KEY} `, webhookKey: WEBHOOK_KEY, mode: "sandbox", label: "  Acme   PandaDoc " });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.pandadoc.com/public/v1/documents?count=1");
    expect(calls[0].auth).toBe(`API-Key ${KEY}`);
    expect(view).toMatchObject({ provider: "pandadoc", providerLabel: "PandaDoc", mode: "sandbox", label: "Acme PandaDoc", status: "connected", usable: false });
    // Real writes are off in this environment, and the card says so instead of looking ready.
    expect(view.notice).toMatch(/switched off in this environment/);
    const [row] = await connections(p.org.id);
    expect(row.credentials).toBeTruthy();
    expect(row.credentials).not.toContain(KEY);
    expect(row.credentials).not.toContain(WEBHOOK_KEY);
    expect(JSON.parse(decryptSecret(row.credentials as string))).toEqual({ apiKey: KEY, webhookKey: WEBHOOK_KEY });
    expect(openCredentials(row.credentials)).toEqual({ apiKey: KEY, webhookKey: WEBHOOK_KEY });
  });

  it("saves nothing when PandaDoc does not accept the key, whatever the reason", async () => {
    const p = await signingOrg({ connect: false });
    for (const status of [401, 403]) {
      pandaDocAnswers(status);
      await expect(connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "live" }), String(status)).rejects.toThrow(/PandaDoc did not accept this key/);
    }
    pandaDocAnswers(404);
    await expect(connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "live" })).rejects.toThrow(/PandaDoc did not accept this key/);
    // PandaDoc could not be reached, or was too slow: the key is neither accepted nor refused, so nothing is saved and the person is told it could not be checked.
    for (const answer of [500, 503]) {
      pandaDocAnswers(answer);
      await expect(connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "live" }), String(answer)).rejects.toThrow(/could not be reached to check the key, so nothing was saved/);
    }
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    await expect(connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "live" })).rejects.toThrow(/could not be reached to check the key, so nothing was saved/);
    expect(await connections(p.org.id)).toEqual([]);
  });

  it("asks for a whole key and a shared key before anything is sent, and for a sandbox or live choice", async () => {
    const p = await signingOrg({ connect: false });
    const calls = pandaDocAnswers();
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ apiKey: "short", webhookKey: WEBHOOK_KEY, mode: "sandbox" }, /whole API key/],
      [{ apiKey: "has some spaces in the key 0123456789", webhookKey: WEBHOOK_KEY, mode: "sandbox" }, /whole API key/],
      [{ apiKey: "", webhookKey: WEBHOOK_KEY, mode: "sandbox" }, /whole API key/],
      [{ apiKey: KEY, webhookKey: "short", mode: "sandbox" }, /webhook shared key/],
      [{ apiKey: KEY, webhookKey: "", mode: "sandbox" }, /webhook shared key/],
      [{ apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "staging" }, /sandbox \(test\) key or a live one/],
      [{ apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "simulated" }, /sandbox \(test\) key or a live one/],
    ];
    for (const [input, message] of bad) await expect(connectPandaDoc(p.actor("owner"), input as never), JSON.stringify(input)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("limits how often a workspace can try, so a stolen session cannot be used to test keys", async () => {
    const p = await signingOrg({ connect: false });
    pandaDocAnswers(401);
    for (let i = 0; i < RATE_LIMITS.esignConnectByOrg.limit; i += 1) await expect(connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "live" })).rejects.toThrow(/did not accept/);
    await expect(connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "live" })).rejects.toThrow(/Too many attempts to connect/);
  });
});

describe("how the keys are kept", () => {
  it("seals them in a column no signed-in person can read, and never returns them, writes them to the audit trail or sends them in a notification", async () => {
    const p = await signingOrg({ connect: false });
    pandaDocAnswers();
    const view = await connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox" });
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(view)).not.toContain(WEBHOOK_KEY);
    expect(Object.keys(view).sort()).toEqual(["accountLabel", "connectedAt", "id", "label", "lastCheckedAt", "lastSuccessAt", "mode", "notice", "provider", "providerLabel", "status", "statusDetail", "usable"]);
    const privileges = await rows<{ col: string; ok: boolean }>(
      `select c as col, has_column_privilege('iaq_app_user', 'public.esign_connections', c, 'select') as ok from unnest(array['credentials', 'webhook_token_hash', 'status', 'provider', 'label']) c`,
    );
    expect(Object.fromEntries(privileges.map((x) => [x.col, x.ok]))).toEqual({ credentials: false, webhook_token_hash: false, status: true, provider: true, label: true });
    // Reading the row as a signed-in member through the database role works for the allowed columns and fails for the sealed one.
    const read = (cols: string) => withSystem(async (db) => {
      await db.query("select set_config('app.user_id', $1, true)", [p.people.owner.id]);
      await db.query("savepoint as_member");
      await db.query("set local role iaq_app_user");
      try {
        return (await db.query(`select ${cols} from esign_connections where org_id = $1`, [p.org.id])).rows;
      } catch (e) {
        // The refusal aborts the statement block: go back to before it, then report the refusal itself.
        await db.query("rollback to savepoint as_member");
        throw e;
      } finally {
        await db.query("reset role");
      }
    });
    expect(await read("status, provider")).toEqual([{ status: "connected", provider: "pandadoc" }]);
    await expect(read("credentials")).rejects.toThrow(/permission denied/);
    await expect(read("webhook_token_hash")).rejects.toThrow(/permission denied/);
    await expect(read("*")).rejects.toThrow(/permission denied/);
    const trail = JSON.stringify(await rows("select action, metadata from audit_logs where org_id = $1", [p.org.id]));
    expect(trail).toContain("proposals.esign_connected");
    expect(trail).not.toContain(KEY);
    expect(trail).not.toContain(WEBHOOK_KEY);
    expect(trail).not.toContain("apiKey");
    expect(JSON.stringify(await rows("select title, body from notifications where org_id = $1", [p.org.id]))).not.toContain(KEY);
  });

  it("cannot open keys that were sealed with something else, or are not keys at all", () => {
    expect(openCredentials(null)).toBeNull();
    expect(openCredentials("")).toBeNull();
    expect(openCredentials("not sealed")).toBeNull();
    expect(openCredentials(sealCredentials({ apiKey: KEY, webhookKey: WEBHOOK_KEY }))).toEqual({ apiKey: KEY, webhookKey: WEBHOOK_KEY });
  });
});

describe("the address the signing service sends its notices to", () => {
  it("is secret, derived from the connection (so it can be shown again), and kept only as a hash", async () => {
    const p = await signingOrg();
    const { token, connectionId } = await connectionKeys(p.org.id);
    expect(looksLikeWebhookToken(token)).toBe(true);
    expect(token).toBe(webhookTokenFor(connectionId));
    const [row] = await connections(p.org.id);
    expect(row.webhook_token_hash).toBe(hashWebhookToken(token));
    expect(row.webhook_token_hash).not.toContain(token);
    const a = await getWebhookUrl(p.actor("owner"));
    const b = await getWebhookUrl(p.actor("manager"));
    expect(a.url).toBe(b.url);
    expect(a).toMatchObject({ provider: "simulated" });
    expect(new URL(a.url).pathname).toBe(`/api/webhooks/esign/${token}`);
    // Showing it leaves no trace of it anywhere that is kept.
    expect(JSON.stringify(await rows("select action, metadata from audit_logs where org_id = $1", [p.org.id]))).not.toContain(token);
    // Two connections never share an address.
    const other = await signingOrg();
    expect((await connectionKeys(other.org.id)).token).not.toBe(token);
  });

  it("cannot be found again once the key it is derived from is gone, and says so instead of showing a wrong one", async () => {
    const p = await signingOrg();
    const [row] = await connections(p.org.id);
    expect(tokenForStoredConnection(row.id, "0".repeat(64))).toBeNull();
    await withSystem((db) => db.query("update esign_connections set webhook_token_hash = $2 where id = $1", [row.id, "f".repeat(64)]));
    await expect(getWebhookUrl(p.actor("owner"))).rejects.toThrow(/can't be shown again/);
  });
});

describe("one connection at a time", () => {
  it("replaces the keys of the connection that is there when the same account is connected again, and keeps its address", async () => {
    const p = await signingOrg({ connect: false });
    pandaDocAnswers();
    const first = await connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox" });
    const before = await getWebhookUrl(p.actor("owner"));
    const second = await connectPandaDoc(p.actor("manager"), { apiKey: `${KEY}_NEW`, webhookKey: `${WEBHOOK_KEY}_NEW`, mode: "sandbox", label: "Renewed" });
    expect(second.id).toBe(first.id);
    expect(second.label).toBe("Renewed");
    expect(await connections(p.org.id)).toHaveLength(1);
    expect(openCredentials((await connections(p.org.id))[0].credentials)).toEqual({ apiKey: `${KEY}_NEW`, webhookKey: `${WEBHOOK_KEY}_NEW` });
    expect(await getWebhookUrl(p.actor("owner"))).toEqual(before);
  });

  it("ends the old connection when a different kind of account is connected, but never while requests are out through it", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await askToSign(p, sent.proposal.id);
    pandaDocAnswers();
    await expect(connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox" })).rejects.toThrow(/still out through the current connection/);
    expect((await connections(p.org.id)).map((c) => c.status)).toEqual(["connected"]);
    const q = await signingOrg();
    pandaDocAnswers();
    await connectPandaDoc(q.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "live" });
    const all = await connections(q.org.id);
    expect(all.map((c) => [c.provider, c.status, c.credentials === null])).toEqual([["simulated", "disconnected", true], ["pandadoc", "connected", false]]);
    // The old address no longer belongs to a live connection.
    const live = await rows("select 1 from esign_connections where org_id = $1 and webhook_token_hash = $2 and status not in ('revoked', 'disconnected')", [q.org.id, all[0].webhook_token_hash]);
    expect(live).toHaveLength(0);
  });

  it("keeps two workspaces apart: one cannot see, check or take the other's connection", async () => {
    const a = await signingOrg();
    const b = await signingOrg({ connect: false });
    expect(await getConnection(b.actor("owner"))).toBeNull();
    await expect(getWebhookUrl(b.actor("owner"))).rejects.toThrow(/No signing service is connected/);
    await expect(checkConnection(b.actor("owner"))).rejects.toThrow(/No signing service is connected/);
    await expect(disconnect(b.actor("owner"))).rejects.toThrow(/No signing service is connected/);
    expect((await connections(a.org.id)).map((c) => c.status)).toEqual(["connected"]);
    // Through the database role, another workspace's member reads none of it.
    const countFor = (userId: string) => withSystem(async (db) => {
      await db.query("select set_config('app.user_id', $1, true)", [userId]);
      await db.query("set local role iaq_app_user");
      try {
        return Number((await db.query<{ n: string }>("select count(*)::text as n from esign_connections")).rows[0].n);
      } finally {
        await db.query("reset role");
      }
    });
    expect(await countFor(a.people.owner.id)).toBe(1);
    expect(await countFor(a.people.viewer.id)).toBe(1);
    expect(await countFor(b.people.owner.id)).toBe(0);
  });
});

describe("checking the key", () => {
  it("records a key the service no longer accepts, tells the owner and the managers once a day, and leaves what is waiting on hold", async () => {
    const p = await signingOrg();
    const { creds } = await connectionKeys(p.org.id);
    simulatedEsign.revoke(creds.apiKey);
    const view = await checkConnection(p.actor("owner"));
    expect(view).toMatchObject({ status: "needs_attention", statusDetail: expect.stringMatching(/no longer accepts/), usable: false });
    await checkConnection(p.actor("manager"));
    const notes = await rows<{ user_id: string; title: string; kind: string }>("select user_id, title, kind from notifications where org_id = $1 and kind = 'signature_failed'", [p.org.id]);
    // The owner, the second owner and the manager: everyone who can connect it. Nobody else (the sales rep, the viewer) is told.
    expect(notes.map((n) => n.user_id).sort()).toEqual([p.people.manager.id, p.people.owner.id, (p.coOwner as { userId: string }).userId].sort());
    expect(notes[0].title).toBe("Your signing service needs to be connected again");
    // Connecting again with a working key puts it right.
    const fixed = await connectSimulated(p.actor("owner"));
    expect(fixed.status).toBe("connected");
  });

  it("leaves the status as it was when the service cannot be reached, and says so", async () => {
    const p = await signingOrg({ connect: false });
    pandaDocAnswers();
    await connectPandaDoc(p.actor("owner"), { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox" });
    pandaDocAnswers(503);
    await expect(checkConnection(p.actor("owner"))).rejects.toThrow(/could not be reached just now, so the connection could not be checked. Nothing about it has changed/);
    expect((await connections(p.org.id))[0].status).toBe("connected");
    pandaDocAnswers(401);
    expect(await checkConnection(p.actor("owner"))).toMatchObject({ status: "needs_attention" });
    pandaDocAnswers();
    expect(await checkConnection(p.actor("owner"))).toMatchObject({ status: "connected", statusDetail: null });
  });

  it("flags keys that can no longer be opened (for example after an encryption key change) instead of using them", async () => {
    const p = await signingOrg();
    await withSystem((db) => db.query("update esign_connections set credentials = 'garbage' where org_id = $1", [p.org.id]));
    expect(await checkConnection(p.actor("owner"))).toMatchObject({ status: "needs_attention", statusDetail: expect.stringMatching(/can no longer be used/) });
  });
});

describe("disconnecting", () => {
  it("deletes the keys, ends requests that are out, stops the old address from working, and leaves the proposals alone", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const { requestId } = await askToSign(p, sent.proposal.id);
    const { token } = await connectionKeys(p.org.id);
    const r = await disconnect(p.actor("manager"));
    expect(r).toEqual({ ended: 1 });
    const [row] = await connections(p.org.id);
    expect(row).toMatchObject({ status: "disconnected", credentials: null });
    expect(row.disconnected_at).not.toBeNull();
    const [req] = await rows<{ status: string; cancel_state: string; void_reason: string }>("select status, cancel_state, void_reason from signature_requests where id = $1", [requestId]);
    expect(req).toMatchObject({ status: "voided", void_reason: "The signing service was disconnected." });
    // It was never handed over, so there is nothing at the service to withdraw.
    expect(req.cancel_state).toBe("none");
    expect((await rows<{ status: string; signature_state: string }>("select status, signature_state from proposals where id = $1", [sent.proposal.id]))[0]).toEqual({ status: "sent", signature_state: "none" });
    expect(await getConnection(p.actor("owner"))).toBeNull();
    expect(hashWebhookToken(token)).toBe(row.webhook_token_hash);
    const trail = await rows<{ action: string; actor_user_id: string }>("select action, actor_user_id from audit_logs where org_id = $1 and action = 'proposals.esign_disconnected'", [p.org.id]);
    expect(trail).toEqual([{ action: "proposals.esign_disconnected", actor_user_id: p.people.manager.id }]);
    // There is nothing left to disconnect.
    await expect(disconnect(p.actor("owner"))).rejects.toThrow(/No signing service is connected/);
    // And a new one can be connected.
    expect((await connectSimulated(p.actor("owner"))).status).toBe("connected");
    expect(await connections(p.org.id)).toHaveLength(2);
  });

  it("asks the business to withdraw a document that is already at the signing service, because the keys are gone", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const { requestId } = await askToSign(p, sent.proposal.id);
    await withSystem((db) => db.query("update signature_requests set status = 'sent', provider_document_id = 'simdoc_1', provider_state = '{\"documentId\":\"simdoc_1\",\"ready\":true,\"sent\":true}'::jsonb where id = $1", [requestId]));
    await disconnect(p.actor("owner"));
    expect((await rows<{ status: string; cancel_state: string }>("select status, cancel_state from signature_requests where id = $1", [requestId]))[0]).toEqual({ status: "voided", cancel_state: "manual" });
  });

  it("closes a departing workspace's connection as its owner would, and reports nothing to do for one without", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await askToSign(p, sent.proposal.id);
    expect(await disconnectWorkspaceEsign(p.org.id, p.people.owner.id)).toEqual({ disconnected: 1, ended: 1, failed: false });
    expect((await connections(p.org.id))[0]).toMatchObject({ status: "disconnected", credentials: null });
    expect(await rows("select metadata from audit_logs where org_id = $1 and action = 'proposals.esign_disconnected' and metadata->>'why' = 'workspace_closed'", [p.org.id])).toHaveLength(1);
    expect(await disconnectWorkspaceEsign(p.org.id, p.people.owner.id)).toEqual({ disconnected: 0, ended: 0, failed: false });
    const none = await proposalOrg();
    expect(await disconnectWorkspaceEsign(none.org.id, none.people.owner.id)).toEqual({ disconnected: 0, ended: 0, failed: false });
  });
});

describe("the stand-in service", () => {
  it("is connected with throwaway keys of its own, says it is simulated, and is usable without the real-writes switch", async () => {
    const p = await signingOrg({ connect: false });
    const view = await connectSimulated(p.actor("owner"), { label: "  Demo  " });
    expect(view).toMatchObject({ provider: "simulated", mode: "simulated", label: "Demo", usable: true, accountLabel: "Simulated signing service" });
    expect(view.notice).toMatch(/Simulated: no real document is sent and nothing here is legally binding/);
    const keys = await connectionKeys(p.org.id);
    expect(keys.creds.apiKey).toMatch(/^sim_/);
  });
});
