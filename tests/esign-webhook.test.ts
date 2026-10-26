// What a signing service tells iAcquire: believed only by its signature over the exact bytes, with the key of the ONE connection whose secret address it came to; found within that
// connection by the service's document id and never by anything the body claims; applied once however often it is delivered; refused or held in every case it should be. Embedded
// Postgres, the stand-in service and (for the notice shapes PandaDoc is remembered to send) the PandaDoc adapter's reading of a notice. No network.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ failApply: false }));
vi.mock("@/server/esign/apply", async (original) => {
  const real = await original<typeof import("@/server/esign/apply")>();
  return { ...real, applyProviderFact: (...args: Parameters<typeof real.applyProviderFact>) => (hooks.failApply ? Promise.reject(new Error("the database went away: secret-detail-123")) : real.applyProviderFact(...args)) };
});

import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { hashIp } from "@/server/security/crypto";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { handleEsignWebhook, MAX_BODY_BYTES } from "@/server/esign/webhook";
import { createPandaDocProvider } from "@/server/esign/providers/pandadoc";
import { SIM_SIGNATURE_HEADER, SIM_TIMESTAMP_HEADER, SIM_TOLERANCE_SECONDS, simulatedEsign, signedDelivery } from "@/server/esign/providers/simulated";
import { disconnect } from "@/server/esign/connections";
import { connectionKeys, freshIp, handedOver, NOW, requestRow, rows, setFeature, sigEvents, signerActs, signingOrg, type ProposalOrg } from "./support/proposals";

beforeEach(() => {
  simulatedEsign.reset();
  hooks.failApply = false;
});
afterEach(() => {
  delete process.env.PROPOSALS_PUBLIC_DISABLED;
  resetEnvCache();
  vi.restoreAllMocks();
});

type Delivery = ReturnType<typeof simulatedEsign.delivery>;
async function deliveryFor(p: ProposalOrg, documentId: string, opts: { at?: Date; eventId?: string; status?: "view" | "complete" } = {}): Promise<{ token: string; d: Delivery }> {
  const keys = await connectionKeys(p.org.id);
  return { token: keys.token, d: simulatedEsign.delivery(documentId, keys.creds.webhookKey, { at: opts.at, eventId: opts.eventId }) };
}
const post = (token: string, d: Pick<Delivery, "rawBody" | "headers" | "query">, extra: { ip?: string; deps?: Parameters<typeof handleEsignWebhook>[1] } = {}) =>
  handleEsignWebhook({ token, rawBody: d.rawBody, headers: d.headers, query: d.query, ip: extra.ip ?? freshIp(), now: NOW }, extra.deps);

describe("a notice that is believed", () => {
  it("moves the request forward on the service's word, once, and says who said it", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    simulatedEsign.signerAction(h.documentId, "view");
    const { token, d } = await deliveryFor(p, h.documentId);
    const r = await post(token, d);
    expect(r).toEqual({ status: 200, body: { received: true, events: 1 } });
    expect((await requestRow(h.requestId)).status).toBe("viewed");
    const ev = (await sigEvents(h.requestId)).filter((e) => e.source === "provider_webhook");
    expect(ev).toEqual([{ kind: "viewed", source: "provider_webhook", provider_event_id: `sim:simev-${h.documentId}-viewed`, detail: { from: "sent" } }]);
  });

  it("changes nothing when the same notice is delivered again, however many times, even at the same moment", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    simulatedEsign.signerAction(h.documentId, "decline");
    const { token, d } = await deliveryFor(p, h.documentId);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => post(token, d)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await requestRow(h.requestId)).status).toBe("declined");
    expect((await sigEvents(h.requestId)).filter((e) => e.source === "provider_webhook")).toHaveLength(1);
    // One announcement of the decline, not five: one notice for each of the owner, the second owner, the manager and the sales rep who asked.
    expect((await rows("select 1 from notifications where org_id = $1 and dedupe_key = $2", [p.org.id, `signature-declined:${h.requestId}`]))).toHaveLength(4);
    expect(await rows("select 1 from crm_events where org_id = $1 and type = 'signature.failed'", [p.org.id])).toHaveLength(1);
    await post(token, d);
    expect((await sigEvents(h.requestId)).filter((e) => e.source === "provider_webhook")).toHaveLength(1);
  });

  it("ignores a report that is behind what is already known, and writes it down once so that its replay is recognised too", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    expect((await signerActs(p, h.requestId, "complete")).status).toBe(200);
    expect((await requestRow(h.requestId)).status).toBe("completed");
    simulatedEsign.signerAction(h.documentId, "view");
    // (The stand-in's document is now "viewed" again; the delivery says so.)
    const { token, d } = await deliveryFor(p, h.documentId, { eventId: "late-viewed" });
    await post(token, d);
    await post(token, d);
    expect((await requestRow(h.requestId)).status).toBe("completed");
    const ignored = (await sigEvents(h.requestId)).filter((e) => e.kind === "delivery_ignored");
    expect(ignored).toEqual([{ kind: "delivery_ignored", source: "provider_webhook", provider_event_id: "sim:late-viewed", detail: { fact: "viewed", why: "behind", status: "completed" } }]);
  });

  it("reads the notice shapes PandaDoc is remembered to send (unexercised): a state change moves the request, anything else is written down once and changes nothing", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const { token, creds } = await connectionKeys(p.org.id);
    const adapter = { provider: () => createPandaDocProvider({ writesEnabled: () => false }) };
    const send = (events: unknown[], key = creds.webhookKey) => {
      const rawBody = Buffer.from(JSON.stringify(events));
      return post(token, { rawBody, headers: new Headers(), query: new URLSearchParams({ signature: createHmac("sha256", key).update(rawBody).digest("hex") }) }, { deps: adapter });
    };
    const note = [{ event: "recipient_completed", data: { id: h.documentId, status: "document.sent", date_modified: "2026-10-23T10:00:00Z" } }];
    expect(await send(note)).toEqual({ status: 200, body: { received: true, events: 1 } });
    expect(await send(note)).toEqual({ status: 200, body: { received: true, events: 1 } });
    expect((await requestRow(h.requestId)).status).toBe("sent");
    expect((await sigEvents(h.requestId)).filter((e) => e.kind === "delivery_noted")).toHaveLength(1);
    expect(await send([{ event: "document_state_changed", data: { id: h.documentId, status: "document.viewed", date_modified: "2026-10-23T10:01:00Z" } }])).toMatchObject({ status: 200 });
    expect((await requestRow(h.requestId)).status).toBe("viewed");
    expect(await send(note, "someone-elses-key")).toEqual({ status: 401, body: { received: false, reason: "bad_signature" } });
    expect(await send([{ event: "x" }])).toEqual({ status: 400, body: { received: false, reason: "malformed" } });
  });
});

describe("a notice that is refused", () => {
  it("is refused when it is not signed with the connection's key, or was changed on the way, or is old, and nothing changes", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    simulatedEsign.signerAction(h.documentId, "complete");
    const keys = await connectionKeys(p.org.id);
    const good = simulatedEsign.delivery(h.documentId, keys.creds.webhookKey);
    const refuse = { status: 401, body: { received: false, reason: "bad_signature" } };
    // Signed with some other key.
    expect(await post(keys.token, simulatedEsign.delivery(h.documentId, "another-key-entirely"))).toEqual(refuse);
    // The body changed after it was signed.
    expect(await post(keys.token, { ...good, rawBody: Buffer.from(good.rawBody.toString().replace("completed", "completed ")) })).toEqual(refuse);
    // Older than the tolerance (a captured delivery played back later).
    expect(await post(keys.token, simulatedEsign.delivery(h.documentId, keys.creds.webhookKey, { at: new Date(Date.now() - (SIM_TOLERANCE_SECONDS + 30) * 1000) }))).toEqual(refuse);
    // No signature at all, or one of the wrong shape.
    expect(await post(keys.token, { rawBody: good.rawBody, headers: new Headers(), query: new URLSearchParams() })).toEqual(refuse);
    expect(await post(keys.token, { rawBody: good.rawBody, headers: new Headers({ [SIM_SIGNATURE_HEADER]: "abc", [SIM_TIMESTAMP_HEADER]: "123" }), query: new URLSearchParams() })).toEqual(refuse);
    // The timestamp is part of what is signed.
    const forged = new Headers(good.headers);
    forged.set(SIM_TIMESTAMP_HEADER, String(Number(good.headers.get(SIM_TIMESTAMP_HEADER)) + 1));
    expect(await post(keys.token, { ...good, headers: forged })).toEqual(refuse);
    expect((await requestRow(h.requestId)).status).toBe("sent");
    expect((await sigEvents(h.requestId)).filter((e) => e.source === "provider_webhook")).toEqual([]);
    // And the genuine one still works afterwards: a refusal used nothing up.
    expect((await post(keys.token, good)).status).toBe(200);
    expect((await requestRow(h.requestId)).status).toBe("completed");
  });

  it("is refused as malformed, and records nothing, when it is signed but is not what a notice looks like", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const keys = await connectionKeys(p.org.id);
    for (const body of ["not json", "[]", JSON.stringify({ id: 5 }), JSON.stringify({ id: "x", documentId: "../x", status: "completed" }), JSON.stringify({ id: "x", documentId: h.documentId })]) {
      const d = signedDelivery(Buffer.from(body), keys.creds.webhookKey, new Date());
      expect(await post(keys.token, d), body).toEqual({ status: 400, body: { received: false, reason: "malformed" } });
    }
    expect((await requestRow(h.requestId)).status).toBe("sent");
  });

  it("answers an address that is not one, or not any connection's, or belongs to a connection that ended, the same way", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const { token, d } = await deliveryFor(p, h.documentId);
    const notFound = { status: 404, body: { received: false, reason: "not_found" } };
    for (const bad of ["", "short", "x".repeat(42), "x".repeat(44), `${token.slice(0, 42)}!`, "../../../etc/passwd", " ".repeat(43)]) expect(await post(bad, d), JSON.stringify(bad)).toEqual(notFound);
    // Well formed, but nobody's.
    expect(await post("A".repeat(43), d)).toEqual(notFound);
    expect((await requestRow(h.requestId)).status).toBe("sent");
    await disconnect(p.actor("owner"));
    expect(await post(token, d)).toEqual(notFound);
  });

  it("holds a notice back with 'try again later' while the workspace takes no answers, and applies it when the service delivers it again", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    simulatedEsign.signerAction(h.documentId, "view");
    const { token, d } = await deliveryFor(p, h.documentId);
    const later = { status: 503, body: { received: false, reason: "unavailable" } };
    await setFeature(p.org.id, false, "esign");
    expect(await post(token, d)).toEqual(later);
    await setFeature(p.org.id, true, "esign");
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [p.org.id]));
    expect(await post(token, d)).toEqual(later);
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [p.org.id]));
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, 'agency', true, null, null, now())", [p.org.id]));
    expect(await post(token, d)).toEqual(later);
    expect((await requestRow(h.requestId)).status).toBe("sent");
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [p.org.id]));
    expect((await post(token, d)).status).toBe(200);
    expect((await requestRow(h.requestId)).status).toBe("viewed");
  });

  it("holds every notice back, before it reads anything, while the platform's emergency switch is on", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    simulatedEsign.signerAction(h.documentId, "view");
    const { token, d } = await deliveryFor(p, h.documentId);
    process.env.PROPOSALS_PUBLIC_DISABLED = "true";
    resetEnvCache();
    const ip = freshIp();
    expect(await post(token, d, { ip })).toEqual({ status: 503, body: { received: false, reason: "unavailable" } });
    // Not even the per-address counter was touched: nothing was read.
    expect(await rows("select 1 from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.esignWebhookByIp.name}:${hashIp(ip)}`])).toHaveLength(0);
    delete process.env.PROPOSALS_PUBLIC_DISABLED;
    resetEnvCache();
    expect((await post(token, d, { ip })).status).toBe(200);
  });

  it("limits how often one address can knock, before the secret in the address is looked up, so guessing addresses costs the guesser", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const { token, d } = await deliveryFor(p, h.documentId);
    const ip = freshIp();
    const key = `${RATE_LIMITS.esignWebhookByIp.name}:${hashIp(ip)}`;
    // Wrong addresses count against the address.
    await post("A".repeat(43), d, { ip });
    await post("not a token", d, { ip });
    expect((await rows<{ hits: number }>("select hits from rate_limit_buckets where bucket_key = $1", [key]))[0].hits).toBe(2);
    await withSystem((db) => db.query("update rate_limit_buckets set hits = $2 where bucket_key = $1", [key, RATE_LIMITS.esignWebhookByIp.limit]));
    expect(await post(token, d, { ip })).toEqual({ status: 429, body: { received: false, reason: "rate_limited" } });
    expect((await requestRow(h.requestId)).status).toBe("sent");
    // Another address is not affected.
    expect((await post(token, d, { ip: freshIp() })).status).toBe(200);
  });
});

describe("two workspaces", () => {
  it("never confuse each other: a notice signed with one workspace's key is no use at another's address, and a document of one is not found in the other", async () => {
    const a = await signingOrg();
    const b = await signingOrg();
    const ha = await handedOver(a);
    const hb = await handedOver(b);
    const ka = await connectionKeys(a.org.id);
    const kb = await connectionKeys(b.org.id);
    expect(ka.token).not.toBe(kb.token);
    expect(ka.creds.webhookKey).not.toBe(kb.creds.webhookKey);
    simulatedEsign.signerAction(ha.documentId, "complete");
    simulatedEsign.signerAction(hb.documentId, "complete");
    // A's notice with A's key, posted to B's address: B's key does not match.
    expect((await post(kb.token, simulatedEsign.delivery(ha.documentId, ka.creds.webhookKey))).status).toBe(401);
    // A's notice signed with B's key (somebody who has B's key): B's address believes it, finds no such document among B's, and acknowledges without changing anything.
    expect(await post(kb.token, simulatedEsign.delivery(ha.documentId, kb.creds.webhookKey))).toEqual({ status: 200, body: { received: true, events: 0 } });
    expect((await requestRow(ha.requestId)).status).toBe("sent");
    expect((await requestRow(hb.requestId)).status).toBe("sent");
    // The genuine ones each reach their own.
    expect((await post(ka.token, simulatedEsign.delivery(ha.documentId, ka.creds.webhookKey))).status).toBe(200);
    expect((await requestRow(ha.requestId)).status).toBe("completed");
    expect((await requestRow(hb.requestId)).status).toBe("sent");
    expect((await post(kb.token, simulatedEsign.delivery(hb.documentId, kb.creds.webhookKey))).status).toBe(200);
    expect((await requestRow(hb.requestId)).status).toBe("completed");
  });

  it("finds a document only within the connection whose address the notice came to, even when another connection has a document with the same id", async () => {
    const a = await signingOrg();
    const b = await signingOrg();
    const ha = await handedOver(a);
    const hb = await handedOver(b);
    // Both workspaces' services now claim a document with the same id (two real services could).
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update signature_requests set provider_document_id = $2 where id = $1", [hb.requestId, ha.documentId]);
    });
    simulatedEsign.signerAction(ha.documentId, "decline");
    const kb = await connectionKeys(b.org.id);
    await post(kb.token, simulatedEsign.delivery(ha.documentId, kb.creds.webhookKey));
    expect((await requestRow(hb.requestId)).status).toBe("declined");
    expect((await requestRow(ha.requestId)).status).toBe("sent");
  });
});

describe("a delivery that cannot be applied", () => {
  it("is answered with a server error so the service delivers it again, leaves no trace, says nothing about the body, and is applied on the next try", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    simulatedEsign.signerAction(h.documentId, "view");
    const { token, d } = await deliveryFor(p, h.documentId);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    hooks.failApply = true;
    await expect(post(token, d)).rejects.toThrow("a signing delivery could not be applied");
    expect((await requestRow(h.requestId)).status).toBe("sent");
    expect((await sigEvents(h.requestId)).filter((e) => e.source === "provider_webhook")).toEqual([]);
    hooks.failApply = false;
    expect(await post(token, d)).toEqual({ status: 200, body: { received: true, events: 1 } });
    expect((await requestRow(h.requestId)).status).toBe("viewed");
    // In a test run the failure is not logged at all; whatever is ever logged is the error's type, not its words.
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-detail-123");
  });

  it("applies the events of one delivery each in a transaction of its own: a replay finishes what a failed delivery did not", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const { token, creds } = await connectionKeys(p.org.id);
    const provider = () => createPandaDocProvider({ writesEnabled: () => false });
    const events = [
      { event: "document_state_changed", data: { id: h.documentId, status: "document.viewed", date_modified: "2026-10-23T10:00:00Z" } },
      { event: "document_state_changed", data: { id: h.documentId, status: "document.completed", date_modified: "2026-10-23T10:01:00Z" } },
    ];
    const rawBody = Buffer.from(JSON.stringify(events));
    const query = new URLSearchParams({ signature: createHmac("sha256", creds.webhookKey).update(rawBody).digest("hex") });
    expect(await post(token, { rawBody, headers: new Headers(), query }, { deps: { provider } })).toEqual({ status: 200, body: { received: true, events: 2 } });
    expect((await requestRow(h.requestId)).status).toBe("completed");
    expect(await post(token, { rawBody, headers: new Headers(), query }, { deps: { provider } })).toEqual({ status: 200, body: { received: true, events: 2 } });
    expect((await rows("select 1 from proposal_decisions where proposal_id = $1", [h.proposal.id]))).toHaveLength(1);
  });
});

describe("nothing leaks", () => {
  it("writes the body, the key, the address and the document's id to no log on any path", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const keys = await connectionKeys(p.org.id);
    simulatedEsign.signerAction(h.documentId, "view");
    const d = simulatedEsign.delivery(h.documentId, keys.creds.webhookKey);
    await post(keys.token, d);
    await post(keys.token, simulatedEsign.delivery(h.documentId, "wrong"));
    await post("A".repeat(43), d);
    await post("nonsense", d);
    const printed = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of [keys.token, keys.creds.webhookKey, keys.creds.apiKey, h.documentId, d.rawBody.toString()]) expect(printed).not.toContain(secret);
  });

  it("keeps the notice address and the keys out of the history it writes", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "complete");
    const keys = await connectionKeys(p.org.id);
    const everything = JSON.stringify([
      await sigEvents(h.requestId),
      await rows("select * from proposal_events where proposal_id = $1", [h.proposal.id]),
      await rows("select action, metadata from audit_logs where org_id = $1", [p.org.id]),
      await rows("select title, body, link from notifications where org_id = $1", [p.org.id]),
      await rows("select payload from crm_events where org_id = $1", [p.org.id]),
    ]);
    for (const secret of [keys.token, keys.creds.webhookKey, keys.creds.apiKey]) expect(everything).not.toContain(secret);
    expect(MAX_BODY_BYTES).toBe(256 * 1024);
  });
});
