// The server actions behind the signing screens, on embedded Postgres: which role each one needs, what they check before the service does, what they refuse to take from a browser,
// that no key ever comes back, and that the agency never connects a client's signing account. The signed-in person is replaced by a fixture's context; PandaDoc is the platform's
// fetch, replaced; nothing else is mocked except the framework's cache.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/auth/service";
import { startSupportSession } from "@/server/crm/actor";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { agencyPeople, CRM_ROLES, type CrmWho } from "./support/crm";
import { ctxFor } from "./support/fixtures";
import { connectionKeys, handedOver, requestRow, rows, sentForSigning, signingOrg, type ProposalOrg } from "./support/proposals";

const mocks = vi.hoisted(() => ({ ctx: null as unknown, user: null as unknown, revalidate: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/server/auth/session", async (original) => ({ ...(await original<typeof import("@/server/auth/session")>()), requireUserOrThrow: async () => mocks.user }));
vi.mock("@/server/tenancy/context", async (original) => ({
  ...(await original<typeof import("@/server/tenancy/context")>()),
  requireOrgContextOrThrow: async () => {
    if (!mocks.ctx) throw new (await import("@/server/errors")).AppError("forbidden", "You don't have access to a workspace.");
    return mocks.ctx;
  },
}));

import {
  actAsSimulatedSignerAction, checkSigningConnectionAction, connectPandaDocAction, connectSimulatedSigningAction, disconnectSigningAction, getSigningWebhookUrlAction, requestSignatureAction,
  voidSignatureRequestAction,
} from "@/app/actions/proposals";

const who = (p: ProposalOrg, w: CrmWho) => {
  const ctx = ctxFor(p.people[w], p.org, CRM_ROLES[w]);
  mocks.ctx = ctx;
  mocks.user = ctx.user;
};
const FORBIDDEN = { ok: false, code: "forbidden" };
const ID = "3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23";
const KEY = "pd_sandbox_api_key_0123456789";
const WEBHOOK_KEY = "wh_shared_key_abcdef";

beforeEach(() => {
  mocks.revalidate.mockReset();
  simulatedEsign.reset();
});
afterEach(() => vi.unstubAllGlobals());

const pandaDocOk = () => vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } }));

describe("which role each action needs", () => {
  it("lets only the owner and a manager connect, check, show the notice address of, and disconnect the signing account", async () => {
    const p = await signingOrg({ connect: false });
    pandaDocOk();
    for (const w of ["sales", "setter", "support", "viewer"] as const) {
      who(p, w);
      expect(await connectPandaDocAction({ apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox" }), w).toMatchObject(FORBIDDEN);
      expect(await connectSimulatedSigningAction(), w).toMatchObject(FORBIDDEN);
      expect(await checkSigningConnectionAction(), w).toMatchObject(FORBIDDEN);
      expect(await getSigningWebhookUrlAction(), w).toMatchObject(FORBIDDEN);
      expect(await disconnectSigningAction(), w).toMatchObject(FORBIDDEN);
    }
    expect(await rows("select 1 from esign_connections where org_id = $1", [p.org.id])).toEqual([]);
    who(p, "manager");
    expect(await connectPandaDocAction({ apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox", label: "Acme" })).toMatchObject({ ok: true, data: { provider: "pandadoc", mode: "sandbox", label: "Acme", status: "connected" } });
    who(p, "owner");
    expect(await checkSigningConnectionAction()).toMatchObject({ ok: true, data: { status: "connected" } });
    expect(await getSigningWebhookUrlAction()).toMatchObject({ ok: true, data: { provider: "pandadoc", url: expect.stringMatching(/\/api\/webhooks\/esign\/[A-Za-z0-9_-]{43}$/) } });
    expect(await disconnectSigningAction()).toMatchObject({ ok: true, data: { ended: 0 } });
  });

  it("lets only people who can send ask for a signature, withdraw the ask, and play the stand-in's signer", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    for (const w of ["setter", "support", "viewer"] as const) {
      who(p, w);
      expect(await requestSignatureAction(sent.proposal.id, {}), w).toMatchObject(FORBIDDEN);
      expect(await voidSignatureRequestAction(ID), w).toMatchObject(FORBIDDEN);
      expect(await actAsSimulatedSignerAction(ID, "sign"), w).toMatchObject(FORBIDDEN);
    }
    expect(await rows("select 1 from signature_requests where org_id = $1", [p.org.id])).toEqual([]);
    who(p, "sales");
    const asked = await requestSignatureAction(sent.proposal.id, {});
    expect(asked).toMatchObject({ ok: true, data: { requestId: expect.any(String), created: true } });
    const requestId = (asked as { data: { requestId: string } }).data.requestId;
    expect(await requestSignatureAction(sent.proposal.id, {})).toMatchObject({ ok: true, data: { requestId, created: false } });
    expect(await voidSignatureRequestAction(requestId)).toMatchObject({ ok: true, data: true });
    expect((await requestRow(requestId)).status).toBe("voided");
  });
});

describe("what is checked before the service is asked", () => {
  it("names a bad item in words, and takes only the fields it knows", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    who(p, "sales");
    expect(await requestSignatureAction("not-a-uuid", {})).toMatchObject({ ok: false, error: "That item was not found." });
    expect(await voidSignatureRequestAction("nonsense")).toMatchObject({ ok: false, error: "That item was not found." });
    expect(await actAsSimulatedSignerAction("nonsense", "sign")).toMatchObject({ ok: false });
    expect(await actAsSimulatedSignerAction(ID, "levitate")).toMatchObject({ ok: false });
    expect(await requestSignatureAction(sent.proposal.id, { signerName: "x".repeat(401) })).toMatchObject({ ok: false });
    // Fields a browser has no business sending are dropped, not obeyed.
    const r = await requestSignatureAction(sent.proposal.id, { signerName: "Jose Reyes", signerEmail: "jose@example.test", status: "completed", idempotency_key: "mine", provider: "pandadoc", connectionId: ID, appliedAt: "2020-01-01", signedFileId: ID });
    expect(r).toMatchObject({ ok: true });
    const [row] = await rows<{ status: string; idempotency_key: string; provider: string; signer_name: string; applied_at: Date | null }>("select status, idempotency_key, provider, signer_name, applied_at from signature_requests where proposal_id = $1", [sent.proposal.id]);
    expect(row).toEqual({ status: "queued", idempotency_key: `proposal:${sent.proposal.id}:1:0`, provider: "simulated", signer_name: "Jose Reyes", applied_at: null });
    // A missing body is the customer on the proposal.
    const q = await signingOrg();
    const s = await sentForSigning(q);
    who(q, "sales");
    expect(await requestSignatureAction(s.proposal.id, undefined)).toMatchObject({ ok: true });
  });

  it("checks the PandaDoc form's shape before anything is sent to PandaDoc", async () => {
    const p = await signingOrg({ connect: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    who(p, "owner");
    for (const input of [null, {}, { apiKey: KEY }, { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "staging" }, { apiKey: "x".repeat(401), webhookKey: WEBHOOK_KEY, mode: "live" }, { apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "live", label: "l".repeat(121) }, { apiKey: 5, webhookKey: WEBHOOK_KEY, mode: "live" }]) {
      expect(await connectPandaDocAction(input), JSON.stringify(input)).toMatchObject({ ok: false });
    }
    expect(await connectPandaDocAction({ apiKey: "short", webhookKey: WEBHOOK_KEY, mode: "live" })).toMatchObject({ ok: false, error: expect.stringMatching(/whole API key/) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rows("select 1 from esign_connections where org_id = $1", [p.org.id])).toEqual([]);
  });

  it("will not play the signer for a request that is not the stand-in's, or another workspace's", async () => {
    const a = await signingOrg();
    const b = await signingOrg();
    const h = await handedOver(a);
    who(b, "sales");
    expect(await actAsSimulatedSignerAction(h.requestId, "sign")).toMatchObject({ ok: false, error: "That signing request was not found." });
    who(a, "sales");
    await withRealRequest(a, h.requestId);
    expect(await actAsSimulatedSignerAction(h.requestId, "sign")).toMatchObject({ ok: false, error: expect.stringMatching(/Only a request made through the simulated signing service/) });
    expect((await requestRow(h.requestId)).status).toBe("sent");
  });
});

async function withRealRequest(p: ProposalOrg, requestId: string) {
  const { withSystem } = await import("@/server/db");
  await withSystem(async (db) => {
    await db.query("set local session_replication_role = replica");
    await db.query("update esign_connections set provider = 'pandadoc', mode = 'sandbox' where org_id = $1", [p.org.id]);
    await db.query("update signature_requests set provider = 'pandadoc', mode = 'sandbox' where id = $1", [requestId]);
  });
}

describe("playing the stand-in's signer", () => {
  it("goes through the same signed notice a real service uses, and ends with the proposal accepted and the signed copy stored, all marked simulated", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    who(p, "sales");
    const asked = (await requestSignatureAction(sent.proposal.id, {})) as { data: { requestId: string } };
    const id = asked.data.requestId;
    expect(await actAsSimulatedSignerAction(id, "sign")).toMatchObject({ ok: false, error: expect.stringMatching(/has not reached the simulated service yet/) });
    expect(await actAsSimulatedSignerAction(id, "send_now")).toMatchObject({ ok: true, data: { status: "sent" } });
    expect(await actAsSimulatedSignerAction(id, "view")).toMatchObject({ ok: true, data: { status: "viewed" } });
    const done = await actAsSimulatedSignerAction(id, "sign");
    expect(done).toMatchObject({ ok: true, data: { status: "completed", note: "Done at the simulated service. Nothing real was signed." } });
    const [req] = await rows<{ mode: string; applied_at: Date | null; signed_file_id: string | null }>("select mode, applied_at, signed_file_id from signature_requests where id = $1", [id]);
    expect(req.mode).toBe("simulated");
    expect(req.applied_at).not.toBeNull();
    expect(req.signed_file_id).not.toBeNull();
    expect((await rows<{ status: string; signature_state: string }>("select status, signature_state from proposals where id = $1", [sent.proposal.id]))[0]).toEqual({ status: "accepted", signature_state: "completed" });
    // The signed notice went through the handler: it left the same history a real one would.
    expect((await rows<{ source: string }>("select source from signature_events where request_id = $1 and kind = 'completed'", [id]))[0].source).toBe("provider_webhook");
    // Declining and running out work the same way.
    const q = await signingOrg();
    const s = await sentForSigning(q);
    who(q, "sales");
    const qid = ((await requestSignatureAction(s.proposal.id, {})) as { data: { requestId: string } }).data.requestId;
    await actAsSimulatedSignerAction(qid, "send_now");
    expect(await actAsSimulatedSignerAction(qid, "decline")).toMatchObject({ ok: true, data: { status: "declined" } });
  });
});

describe("what never comes back to a browser", () => {
  it("returns no key from any action, and writes none to the audit trail", async () => {
    const p = await signingOrg({ connect: false });
    pandaDocOk();
    who(p, "owner");
    const results = [
      await connectPandaDocAction({ apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox" }),
      await checkSigningConnectionAction(),
    ];
    const keys = await connectionKeys(p.org.id);
    for (const r of results) {
      const text = JSON.stringify(r);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(WEBHOOK_KEY);
      expect(text).not.toContain(keys.token);
      expect(text).not.toMatch(/credentials|webhook_token_hash|apiKey|webhookKey/);
    }
    // The notice address is shown to the person who asked, and only to them: it is not audited, and refreshing the page does not repeat it.
    mocks.revalidate.mockReset();
    const shown = await getSigningWebhookUrlAction();
    expect(shown).toMatchObject({ ok: true });
    expect(JSON.stringify(shown)).toContain(keys.token);
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(JSON.stringify(await rows("select action, metadata from audit_logs where org_id = $1", [p.org.id]))).not.toContain(keys.token);
  });

  it("refreshes the proposal screens after a change, so the Signature tab is never stale", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    who(p, "sales");
    mocks.revalidate.mockReset();
    await requestSignatureAction(sent.proposal.id, {});
    expect(mocks.revalidate).toHaveBeenCalledWith("/proposals", "layout");
  });
});

describe("the agency", () => {
  it("never connects, checks or disconnects a client's signing account, even in a write support session, and cannot ask for or withdraw a signature either", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const agency = await agencyPeople();
    mocks.user = agency.superAdmin as SessionUser;
    mocks.ctx = null;
    await startSupportSession(agency.superAdmin, p.org.id, { mode: "write", reason: "Looking at the setup" });
    pandaDocOk();
    expect(await connectPandaDocAction({ apiKey: KEY, webhookKey: WEBHOOK_KEY, mode: "sandbox" })).toMatchObject(FORBIDDEN);
    expect(await connectSimulatedSigningAction()).toMatchObject(FORBIDDEN);
    expect(await checkSigningConnectionAction()).toMatchObject(FORBIDDEN);
    expect(await getSigningWebhookUrlAction()).toMatchObject(FORBIDDEN);
    expect(await disconnectSigningAction()).toMatchObject(FORBIDDEN);
    expect(await requestSignatureAction(sent.proposal.id, {})).toMatchObject(FORBIDDEN);
    expect((await rows<{ status: string }>("select status from esign_connections where org_id = $1", [p.org.id]))[0].status).toBe("connected");
    expect(await rows("select 1 from signature_requests where org_id = $1", [p.org.id])).toEqual([]);
  });
});
