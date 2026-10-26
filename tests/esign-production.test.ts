// The stand-in signing service does not exist in production, whatever else is set: it cannot be connected, its requests are not handed over, a notice for it is not believed, and
// nobody can act as its signer. Real signing services write only when their own switch is on. The environment is replaced (NODE_ENV and the write switch only) around the calls
// that decide this; the real validation of production configuration is not what is tested here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ nodeEnv: "test" as string, writes: false }));
vi.mock("@/server/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/env")>();
  return { ...actual, env: () => ({ ...actual.env(), NODE_ENV: mode.nodeEnv, ESIGN_WRITES_ENABLED: mode.writes }) };
});

import { connectSimulated } from "@/server/esign/connections";
import { liveEsignWritesEnabled, providerFor, simulatedAllowed } from "@/server/esign/providers";
import { signedDelivery, simulatedEsign } from "@/server/esign/providers/simulated";
import { actAsSimulatedSigner } from "@/server/esign/simulate";
import { processDueRequests } from "@/server/esign/worker";
import { signingStatus } from "@/server/proposals/signing";
import { withSystem } from "@/server/db";
import { askToSign, connectionKeys, freshIp, handedOver, NOW, requestRow, rows, sentForSigning, signingOrg } from "./support/proposals";
import { handleEsignWebhook } from "@/server/esign/webhook";

beforeEach(() => simulatedEsign.reset());
afterEach(() => {
  mode.nodeEnv = "test";
  mode.writes = false;
});

describe("in production", () => {
  it("has no stand-in service: the registry refuses it, it cannot be connected, and the real one is left to its own switch", async () => {
    expect(simulatedAllowed()).toBe(true);
    expect(providerFor("simulated").adapter).toBe("simulated");
    const p = await signingOrg({ connect: false });
    mode.nodeEnv = "production";
    expect(simulatedAllowed()).toBe(false);
    expect(() => providerFor("simulated")).toThrow(/not available in production/);
    await expect(connectSimulated(p.actor("owner"))).rejects.toThrow(/not available in production/);
    expect(await rows("select 1 from esign_connections where org_id = $1", [p.org.id])).toEqual([]);
    expect(providerFor("pandadoc").adapter).toBe("pandadoc");
    expect(liveEsignWritesEnabled()).toBe(false);
    mode.writes = true;
    expect(liveEsignWritesEnabled()).toBe(true);
  });

  it("does not hand over a stand-in request that is somehow there, and does not believe a notice for it", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const { requestId } = await askToSign(p, sent.proposal.id);
    const keys = await connectionKeys(p.org.id);
    mode.nodeEnv = "production";
    expect(await processDueRequests({ orgId: p.org.id, now: () => NOW, jitter: () => 0 })).toMatchObject({ claimed: 0 });
    expect((await requestRow(requestId)).status).toBe("queued");
    expect(simulatedEsign.documents()).toEqual([]);
    // A notice for its address gets the same answer as an address that belongs to nothing.
    const d = signedDelivery(Buffer.from(JSON.stringify({ id: "ev1", type: "document.status", documentId: "simdoc_1", status: "viewed" })), keys.creds.webhookKey, new Date());
    expect(await handleEsignWebhook({ token: keys.token, rawBody: d.rawBody, headers: d.headers, query: d.query, ip: freshIp(), now: NOW })).toEqual({ status: 404, body: { received: false, reason: "not_found" } });
    mode.nodeEnv = "test";
    expect(await processDueRequests({ orgId: p.org.id, now: () => NOW, jitter: () => 0 })).toMatchObject({ claimed: 1, sent: 1 });
  });

  it("lets nobody act as the stand-in's signer", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    mode.nodeEnv = "production";
    await expect(actAsSimulatedSigner(p.actor("owner"), h.requestId, "sign")).rejects.toThrow(/not available in production/);
    expect((await requestRow(h.requestId)).status).toBe("sent");
  });

  it("does not count a stand-in connection as a way to sign, so a proposal that needs a signature cannot be sent on the strength of one", async () => {
    const p = await signingOrg();
    expect(await withSystem((db) => signingStatus(db, p.org.id))).toEqual({ available: true });
    mode.nodeEnv = "production";
    expect(await withSystem((db) => signingStatus(db, p.org.id))).toEqual({ available: false, why: "none" });
  });
});

describe("a real service", () => {
  it("is available for sending only when its own write switch is on, and the stand-in never needs it", async () => {
    const p = await signingOrg();
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update esign_connections set provider = 'pandadoc', mode = 'sandbox' where org_id = $1", [p.org.id]);
    });
    expect(await withSystem((db) => signingStatus(db, p.org.id))).toEqual({ available: false, why: "writes_off" });
    mode.writes = true;
    expect(await withSystem((db) => signingStatus(db, p.org.id))).toEqual({ available: true });
    mode.writes = false;
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update esign_connections set provider = 'simulated', mode = 'simulated' where org_id = $1", [p.org.id]);
    });
    expect(await withSystem((db) => signingStatus(db, p.org.id))).toEqual({ available: true });
  });
});
