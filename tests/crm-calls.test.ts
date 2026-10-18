// Call activity: the Vapi and Retell webhook adapters (signature checks with vectors computed exactly as each provider documents them),
// tenant resolution through the voice connection, exact-phone contact matching, recording references only when the workspace keeps
// them, idempotent upserts, manual call logging, follow-ups, connections and the screens. Synthetic workspaces only: no request leaves
// the machine, and every secret is a test-vault value.
import crypto from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/calls", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-calls", () => Object.fromEntries(["logCallAction", "updateCallAction", "createCallFollowUpAction", "saveVoiceConnectionAction", "disconnectVoiceConnectionAction"].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction"].map((n) => [n, stub])));

import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { createContact } from "@/server/crm/contacts";
import {
  createCallFollowUp, disconnectVoiceConnection, listCalls, listContactCalls, listVoiceConnections, logCall, matchContactByPhone, parseExternalIds, recordVoiceEvent,
  saveVoiceConnection, updateCall,
} from "@/server/crm/calls";
import { handleVoiceWebhook } from "@/server/integrations/voice/handler";
import { headersFrom, safeEqual, type VoiceCallEvent } from "@/server/integrations/voice/types";
import { parseVapiEvent, vapiHmacSignature, vapiStatusFor, verifyVapiRequest } from "@/server/integrations/voice/vapi";
import { parseRetellEvent, retellStatusFor, signRetell, verifyRetellSignature } from "@/server/integrations/voice/retell";
import { POST as retellRoute, GET as retellGet } from "@/app/api/webhooks/retell/route";
import { POST as vapiRoute } from "@/app/api/webhooks/vapi/route";
import { scopeFor } from "@/server/crm/page";
import { CallsWorkspace } from "@/components/crm/calls/calls-workspace";
import { ContactCalls } from "@/components/crm/calls/contact-calls";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";

const expectError = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (message) expect((err as AppError).message).toMatch(message);
};
const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows[0] as T;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);
const rid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
let n = 0;
const number = () => `+1555${String(2000000 + ++n * 37 + Math.floor(Math.random() * 1000)).padStart(7, "0")}`;

// ---------------------------------------------------------------------------
// Payloads shaped like the providers' own (see the field notes in src/server/integrations/voice/*.ts)
// ---------------------------------------------------------------------------

function vapiEndOfCall(o: { callId: string; assistantId: string; customer?: string | null; endedReason?: string; recording?: boolean; transcript?: boolean; startedAt?: string; endedAt?: string; type?: string }) {
  const startedAt = o.startedAt ?? "2026-10-16T09:00:00.000Z";
  const endedAt = o.endedAt ?? "2026-10-16T09:03:12.000Z";
  return {
    message: {
      type: "end-of-call-report",
      timestamp: Date.parse(endedAt),
      endedReason: o.endedReason ?? "customer-ended-call",
      startedAt,
      endedAt,
      call: { id: o.callId, type: o.type ?? "inboundPhoneCall", assistantId: o.assistantId, phoneNumberId: "pn_shared_not_listed", customer: { number: o.customer ?? undefined } },
      customer: o.customer === null ? {} : { number: o.customer, name: "Maria Santos" },
      phoneNumber: { id: "pn_shared_not_listed", number: "+15555550100" },
      artifact: { recordingUrl: o.recording === false ? undefined : `https://storage.vapi.example/recordings/${o.callId}.wav`, transcript: o.transcript === false ? "" : "AI: Thanks for calling.\nUser: What are your hours?" },
      analysis: { summary: "Caller asked about opening hours." },
    },
  };
}

function vapiStatus(o: { callId: string; assistantId: string; status: string; customer?: string; endedReason?: string }) {
  return { message: { type: "status-update", status: o.status, endedReason: o.endedReason, call: { id: o.callId, type: "inboundPhoneCall", assistantId: o.assistantId }, customer: { number: o.customer } } };
}

function retellEvent(event: string, o: { callId: string; agentId: string; from?: string; to?: string; direction?: "inbound" | "outbound"; reason?: string; voicemail?: boolean; recording?: boolean }) {
  const start = 1_760_605_200_000;
  return {
    event,
    call: {
      call_id: o.callId, agent_id: o.agentId, call_type: "phone_call", direction: o.direction ?? "inbound", from_number: o.from ?? "+15555550999", to_number: o.to ?? "+15555550100",
      call_status: event === "call_started" ? "ongoing" : "ended", start_timestamp: start,
      ...(event === "call_started" ? {} : { end_timestamp: start + 65_000, duration_ms: 65_000, disconnection_reason: o.reason ?? "user_hangup", transcript: "Agent: Hello.", recording_url: o.recording === false ? undefined : `https://retell.example/${o.callId}/recording.wav` }),
      ...(event === "call_analyzed" ? { call_analysis: { call_summary: "Booked a cleaning for Tuesday.", in_voicemail: o.voicemail === true } } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

describe("Retell signature (X-Retell-Signature)", () => {
  const body = '{"event":"call_ended"}';
  const apiKey = "test-api-key";
  const ts = 1_700_000_000_000;
  // The vector from Retell's own SDK test (retell-typescript-sdk tests/webhook-auth.test.ts).
  const sdkDigest = "07024cabe7dd8f6d1c6e4a8324ca92c812e6ad4a7ee506c04f7e462e3321823e";

  it("signs v=<ms>,d=<hex HMAC-SHA256 of body + timestamp> exactly as the SDK does", () => {
    expect(signRetell(body, apiKey, ts)).toBe(`v=${ts},d=${sdkDigest}`);
    expect(crypto.createHmac("sha256", apiKey).update(body + ts).digest("hex")).toBe(sdkDigest);
    expect(verifyRetellSignature({ rawBody: body, apiKey, header: `v=${ts},d=${sdkDigest}`, now: ts })).toEqual({ ok: true });
  });

  it("refuses tampered bodies, wrong keys, malformed headers and timestamps outside five minutes", () => {
    const header = `v=${ts},d=${sdkDigest}`;
    expect(verifyRetellSignature({ rawBody: `${body} `, apiKey, header, now: ts })).toEqual({ ok: false, reason: "signature" });
    expect(verifyRetellSignature({ rawBody: body, apiKey: "wrong-api-key", header, now: ts })).toEqual({ ok: false, reason: "signature" });
    expect(verifyRetellSignature({ rawBody: body, apiKey, header: null, now: ts })).toEqual({ ok: false, reason: "missing" });
    for (const h of ["", `v=${ts}`, `d=${sdkDigest},v=${ts}`, `prefix-v=${ts},d=${sdkDigest}`, `v=${ts},d=${sdkDigest}-suffix`, `v=${ts},d=not-hex`, `v=${ts},d=${sdkDigest.slice(2)}`]) {
      expect(verifyRetellSignature({ rawBody: body, apiKey, header: h, now: ts }).ok, h).toBe(false);
    }
    expect(verifyRetellSignature({ rawBody: body, apiKey, header: `v=999999999999999999999999,d=${sdkDigest}`, now: ts }).ok).toBe(false);
    expect(verifyRetellSignature({ rawBody: body, apiKey, header, now: ts + 300_000 })).toEqual({ ok: true });
    expect(verifyRetellSignature({ rawBody: body, apiKey, header, now: ts + 300_001 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyRetellSignature({ rawBody: body, apiKey, header, now: ts - 300_001 })).toEqual({ ok: false, reason: "stale" });
  });
});

describe("Vapi authentication", () => {
  const body = JSON.stringify(vapiStatus({ callId: "call_1", assistantId: "asst_1", status: "ringing" }));
  const secret = "vapi-shared-secret-0123456789";

  it("checks an HMAC-SHA256 hex signature over {timestamp}.{body}, Vapi's default HMAC plan, within five minutes", () => {
    const ts = String(Date.now());
    const expected = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(vapiHmacSignature(secret, ts, body)).toBe(expected);
    const h = (sig: string, t = ts) => headersFrom({ "X-Signature": sig, "X-Timestamp": t });
    const s = { mode: "hmac" as const, secret };
    expect(verifyVapiRequest({ headers: h(expected), rawBody: body, secret: s })).toEqual({ ok: true });
    expect(verifyVapiRequest({ headers: h(`sha256=${expected}`), rawBody: body, secret: s })).toEqual({ ok: true });
    expect(verifyVapiRequest({ headers: h(expected), rawBody: body.replace("ringing", "ended"), secret: s })).toEqual({ ok: false, reason: "signature" });
    expect(verifyVapiRequest({ headers: h(expected), rawBody: body, secret: { mode: "hmac", secret: `${secret}x` } })).toEqual({ ok: false, reason: "signature" });
    expect(verifyVapiRequest({ headers: headersFrom({ "x-signature": expected }), rawBody: body, secret: s })).toEqual({ ok: false, reason: "missing" });
    expect(verifyVapiRequest({ headers: h("zz"), rawBody: body, secret: s })).toEqual({ ok: false, reason: "malformed" });
    const old = String(Date.now() - 301_000);
    expect(verifyVapiRequest({ headers: h(vapiHmacSignature(secret, old, body), old), rawBody: body, secret: s })).toEqual({ ok: false, reason: "stale" });
    // A timestamp in seconds is read as seconds.
    const sec = String(Math.floor(Date.now() / 1000));
    expect(verifyVapiRequest({ headers: h(vapiHmacSignature(secret, sec, body), sec), rawBody: body, secret: s })).toEqual({ ok: true });
  });

  it("checks a Bearer token or the legacy X-Vapi-Secret header", () => {
    const bearer = { mode: "bearer" as const, secret };
    expect(verifyVapiRequest({ headers: headersFrom({ Authorization: `Bearer ${secret}` }), rawBody: body, secret: bearer })).toEqual({ ok: true });
    expect(verifyVapiRequest({ headers: headersFrom({ Authorization: `Bearer ${secret}0` }), rawBody: body, secret: bearer })).toEqual({ ok: false, reason: "signature" });
    expect(verifyVapiRequest({ headers: headersFrom({ Authorization: secret }), rawBody: body, secret: bearer })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyVapiRequest({ headers: headersFrom({}), rawBody: body, secret: bearer })).toEqual({ ok: false, reason: "missing" });
    const legacy = { mode: "x-vapi-secret" as const, secret };
    expect(verifyVapiRequest({ headers: headersFrom({ "X-Vapi-Secret": secret }), rawBody: body, secret: legacy })).toEqual({ ok: true });
    expect(verifyVapiRequest({ headers: headersFrom({ "X-Vapi-Secret": "nope" }), rawBody: body, secret: legacy })).toEqual({ ok: false, reason: "signature" });
    expect(verifyVapiRequest({ headers: headersFrom({ Authorization: `Bearer ${secret}` }), rawBody: body, secret: legacy })).toEqual({ ok: false, reason: "missing" });
    // The comparison never throws on different lengths.
    expect(safeEqual("a", "a much longer value")).toBe(false);
    expect(safeEqual("same", "same")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parsing and status mapping (pure)
// ---------------------------------------------------------------------------

describe("provider events", () => {
  it("reads a Vapi end-of-call report and status updates, and ignores everything else", () => {
    const p = parseVapiEvent(vapiEndOfCall({ callId: "call_a", assistantId: "asst_a", customer: "+15555550123" }));
    expect(p.kind).toBe("call");
    const e = (p as { event: VoiceCallEvent }).event;
    expect(e).toMatchObject({
      provider: "vapi", eventType: "end-of-call-report", receiptKey: "call_a:end-of-call-report", callId: "call_a", direction: "inbound", status: "completed", final: true,
      customerNumber: "+15555550123", businessNumber: "+15555550100", durationSeconds: 192, disposition: "customer-ended-call", summary: "Caller asked about opening hours.",
      recordingUrl: "https://storage.vapi.example/recordings/call_a.wav", hasTranscript: true,
    });
    expect(e.externalIds).toEqual(["asst_a", "pn_shared_not_listed"]);
    expect((parseVapiEvent(vapiStatus({ callId: "c", assistantId: "a", status: "in-progress" })) as { event: VoiceCallEvent }).event).toMatchObject({ status: "in_progress", final: false, receiptKey: "c:status-update:in-progress" });
    expect(parseVapiEvent({ message: { type: "transcript", call: { id: "c" } } }).kind).toBe("ignored");
    expect(parseVapiEvent({ message: { type: "assistant-request" } }).kind).toBe("ignored");
    expect(parseVapiEvent({ nope: true }).kind).toBe("ignored");
    expect((parseVapiEvent(vapiEndOfCall({ callId: "c2", assistantId: "a", customer: "5550123" })) as { event: VoiceCallEvent }).event.customerNumber).toBeNull();
    expect((parseVapiEvent(vapiEndOfCall({ callId: "c3", assistantId: "a", type: "outboundPhoneCall" })) as { event: VoiceCallEvent }).event.direction).toBe("outbound");
    expect([vapiStatusFor("voicemail", true), vapiStatusFor("customer-did-not-answer", false), vapiStatusFor("customer-busy", false), vapiStatusFor("pipeline-error-openai-llm-failed", true), vapiStatusFor("assistant-forwarded-call", true), vapiStatusFor("silence-timed-out", false)])
      .toEqual(["voicemail", "no_answer", "busy", "failed", "completed", "failed"]);
  });

  it("reads Retell call_started, call_ended and call_analyzed, and ignores transcript updates", () => {
    const started = (parseRetellEvent(retellEvent("call_started", { callId: "rc", agentId: "agent_x" })) as { event: VoiceCallEvent }).event;
    expect(started).toMatchObject({ status: "in_progress", final: false, receiptKey: "rc:call_started", externalIds: ["agent_x"], customerNumber: "+15555550999", businessNumber: "+15555550100" });
    const ended = (parseRetellEvent(retellEvent("call_ended", { callId: "rc", agentId: "agent_x" })) as { event: VoiceCallEvent }).event;
    expect(ended).toMatchObject({ status: "completed", final: true, durationSeconds: 65, disposition: "user_hangup", recordingUrl: "https://retell.example/rc/recording.wav", hasTranscript: true });
    const out = (parseRetellEvent(retellEvent("call_ended", { callId: "ro", agentId: "agent_x", direction: "outbound", from: "+15555550100", to: "+15555550777" })) as { event: VoiceCallEvent }).event;
    expect(out).toMatchObject({ direction: "outbound", customerNumber: "+15555550777" });
    const vm = (parseRetellEvent(retellEvent("call_analyzed", { callId: "rc", agentId: "agent_x", voicemail: true })) as { event: VoiceCallEvent }).event;
    expect(vm).toMatchObject({ status: "voicemail", summary: "Booked a cleaning for Tuesday.", receiptKey: "rc:call_analyzed" });
    expect(parseRetellEvent({ event: "transcript_updated", call: { call_id: "rc" } }).kind).toBe("ignored");
    expect([retellStatusFor("ended", "dial_no_answer", false), retellStatusFor("not_connected", "dial_busy", false), retellStatusFor("error", "error_asr", false), retellStatusFor("ended", "agent_hangup", false), retellStatusFor("not_connected", null, false)])
      .toEqual(["no_answer", "busy", "failed", "completed", "failed"]);
  });
});

// ---------------------------------------------------------------------------
// End to end: connections, tenant resolution, replay, matching, recordings, upserts
// ---------------------------------------------------------------------------

const VAPI_SECRET = "vapi-hmac-secret-for-tests-0001";
const RETELL_KEY = "key_retell_test_webhook_badge_0001";

async function writeAdmin(o: CrmOrg) {
  const { superAdmin } = await agencyPeople();
  await startSupportSession(superAdmin, o.org.id, { mode: "write", reason: "Connecting the voice assistant" });
  return agencyActor(superAdmin, o.org.id);
}

function vapiHeaders(body: string, secret = VAPI_SECRET, at = Date.now()) {
  const ts = String(at);
  return headersFrom({ "x-signature": vapiHmacSignature(secret, ts, body), "x-timestamp": ts, "content-type": "application/json" });
}
const retellHeaders = (body: string, key = RETELL_KEY, at = Date.now()) => headersFrom({ "x-retell-signature": signRetell(body, key, at) });

describe("voice webhooks end to end", () => {
  let a: CrmOrg;
  let b: CrmOrg;
  let adminA: CrmActor;
  let adminB: CrmActor;
  const assistantA = rid("asst");
  const agentA = rid("agent");
  const assistantB = rid("asst");
  beforeAll(async () => {
    a = await crmOrg({ name: "Calls Co" });
    b = await crmOrg({ name: "Other Calls Co" });
    adminA = await writeAdmin(a);
    adminB = await writeAdmin(b);
    await saveVoiceConnection(adminA, { provider: "vapi", externalIds: assistantA, vapiAuthMode: "hmac", secret: VAPI_SECRET, storeRecordings: false });
    await saveVoiceConnection(adminA, { provider: "retell", externalIds: [agentA], secret: RETELL_KEY, storeRecordings: false });
    await saveVoiceConnection(adminB, { provider: "vapi", externalIds: `${assistantB}\n`, vapiAuthMode: "bearer", secret: "vapi-bearer-token-for-b-000001", storeRecordings: false });
  });

  it("only an agency super admin in a write session sets up a connection, and an id belongs to one workspace", async () => {
    await expectError(saveVoiceConnection(a.actor("owner"), { provider: "vapi", externalIds: "asst_x", vapiAuthMode: "bearer", secret: "x".repeat(20), storeRecordings: false }), "forbidden", /agency super admin/);
    const { staff } = await agencyPeople();
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [a.org.id, staff.id]));
    await startSupportSession(staff, a.org.id, { mode: "read", reason: "Looking at calls" });
    await expectError(saveVoiceConnection(await agencyActor(staff, a.org.id), { provider: "vapi", externalIds: "asst_x", vapiAuthMode: "bearer", secret: "x".repeat(20), storeRecordings: false }), "forbidden");
    await expectError(saveVoiceConnection(adminB, { provider: "vapi", externalIds: [assistantB, assistantA], vapiAuthMode: "bearer", storeRecordings: false }), "conflict", /another workspace/);
    await expectError(saveVoiceConnection(adminA, { provider: "vapi", externalIds: assistantA, vapiAuthMode: "hmac", storeRecordings: true }), "invalid_input", /tells every caller/);
    await expectError(saveVoiceConnection(adminA, { provider: "vapi", externalIds: assistantA, vapiAuthMode: "bearer", storeRecordings: false }), "invalid_input", /needs its secret again/);
    expect(() => parseExternalIds("ok_1, has space")).not.toThrow();
    expect(() => parseExternalIds("")).toThrow(/at least one/);
    expect(() => parseExternalIds(Array.from({ length: 21 }, (_, i) => `id_${i}`))).toThrow(/at most 20/);

    const views = await listVoiceConnections(a.actor("sales"));
    const vapi = views.find((v) => v.provider === "vapi")!;
    expect(vapi).toMatchObject({ configured: true, status: "credentials_saved", externalIds: [assistantA], credentialSaved: true, vapiAuthMode: "hmac", storeRecordings: false, webhookUrl: "http://localhost:3000/api/webhooks/vapi" });
    expect(JSON.stringify(views)).not.toContain(VAPI_SECRET);
    expect(JSON.stringify(views)).not.toContain(RETELL_KEY);
    await expectError(listVoiceConnections(a.actor("viewer")), "forbidden");
  });

  it("finds the workspace only through its connection's ids and authenticates with that workspace's own secret", async () => {
    const body = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistantA, customer: number() }));
    expect(await handleVoiceWebhook("vapi", body, vapiHeaders(body, "the-wrong-secret-0000000000"))).toMatchObject({ status: 401, outcome: "unauthorized" });
    const unknown = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: "asst_nobody", customer: number() }));
    expect(await handleVoiceWebhook("vapi", unknown, vapiHeaders(unknown))).toMatchObject({ status: 404, outcome: "unknown_workspace" });
    // B's assistant id with A's secret: B's own (bearer) credential is used, so it fails.
    const forB = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistantB }));
    expect(await handleVoiceWebhook("vapi", forB, vapiHeaders(forB))).toMatchObject({ status: 401, orgId: b.org.id });
    expect(await handleVoiceWebhook("vapi", forB, headersFrom({ authorization: "Bearer vapi-bearer-token-for-b-000001" }))).toMatchObject({ status: 200, outcome: "processed", orgId: b.org.id });
    expect(await handleVoiceWebhook("vapi", "{not json", vapiHeaders("{not json"))).toMatchObject({ status: 400, outcome: "invalid" });
    expect(await handleVoiceWebhook("vapi", JSON.stringify({ message: { type: "speech-update" } }), headersFrom({}))).toMatchObject({ status: 200, outcome: "ignored" });

    const ok = await handleVoiceWebhook("vapi", body, vapiHeaders(body));
    expect(ok).toMatchObject({ status: 200, outcome: "processed", orgId: a.org.id });
    const conn = await one<{ status: string; last_event_at: Date | null }>("select status, last_event_at from crm_voice_connections where org_id = $1 and provider = 'vapi'", [a.org.id]);
    expect(conn.status).toBe("connected");
    expect(conn.last_event_at).not.toBeNull();
  });

  it("records a replayed or redelivered event once, and refuses a stale signature", async () => {
    const callId = rid("call");
    const body = JSON.stringify(vapiEndOfCall({ callId, assistantId: assistantA, customer: number() }));
    const headers = vapiHeaders(body);
    expect((await handleVoiceWebhook("vapi", body, headers)).outcome).toBe("processed");
    expect(await handleVoiceWebhook("vapi", body, headers)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(await handleVoiceWebhook("vapi", body, vapiHeaders(body, VAPI_SECRET, Date.now() - 6 * 60_000))).toMatchObject({ status: 401, outcome: "unauthorized" });
    expect(await count("select count(*)::text as n from crm_call_records where provider = 'vapi' and provider_call_id = $1", [callId])).toBe(1);
    expect(await count("select count(*)::text as n from crm_events where type = 'call.completed' and entity_id = (select id from crm_call_records where provider_call_id = $1)", [callId])).toBe(1);
    expect(await one("select outcome, org_id from webhook_receipts where provider = 'vapi' and external_id = $1", [`${a.org.id}:${callId}:end-of-call-report`])).toMatchObject({ outcome: "processed", org_id: a.org.id });
  });

  it("matches a contact by the caller's exact E.164 number only, never by name", async () => {
    const phoneNo = number();
    const maria = await createContact(a.actor("owner"), { firstName: "Maria", lastName: "Santos", phone: phoneNo });
    await createContact(a.actor("owner"), { firstName: "Maria", lastName: "Santos", email: `maria-${crypto.randomUUID().slice(0, 6)}@example.test` });
    expect(await withSystem((db) => matchContactByPhone(db, a.org.id, phoneNo))).toBe(maria.id);
    expect(await withSystem((db) => matchContactByPhone(db, a.org.id, phoneNo.slice(1)))).toBeNull();
    expect(await withSystem((db) => matchContactByPhone(db, b.org.id, phoneNo))).toBeNull();

    const known = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistantA, customer: phoneNo }));
    const r1 = await handleVoiceWebhook("vapi", known, vapiHeaders(known));
    expect(await one("select contact_id, from_number, to_number, direction, status, duration_seconds, disposition, summary from crm_call_records where id = $1", [r1.recordId])).toMatchObject({
      // This connection keeps no call content, so the provider's summary of the conversation isn't stored.
      contact_id: maria.id, from_number: phoneNo, to_number: "+15555550100", direction: "inbound", status: "completed", duration_seconds: 192, disposition: "customer-ended-call", summary: null,
    });
    const act = await one<{ kind: string; summary: string }>("select kind, summary from crm_activities where org_id = $1 and contact_id = $2 and ref_id = $3", [a.org.id, maria.id, r1.recordId]);
    expect(act).toMatchObject({ kind: "call.completed" });
    expect(act.summary).toMatch(/Inbound call with the Vapi assistant completed \(3 min 12 s\)/);
    // The payload names "Maria Santos", but an unknown number matches nobody.
    const stranger = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistantA, customer: number() }));
    const r2 = await handleVoiceWebhook("vapi", stranger, vapiHeaders(stranger));
    expect((await one<{ contact_id: string | null }>("select contact_id from crm_call_records where id = $1", [r2.recordId])).contact_id).toBeNull();
    const ev = await one<{ contact_id: string | null; payload: Record<string, unknown> }>("select contact_id, payload from crm_events where type = 'call.completed' and entity_id = $1", [r2.recordId]);
    expect(ev).toMatchObject({ contact_id: null, payload: { contactMatched: false, provider: "vapi", status: "completed" } });
  });

  it("keeps recording and transcript references, and the provider's summary, only when the connection keeps them, and records the basis", async () => {
    const off = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistantA, customer: number() }));
    const r1 = await handleVoiceWebhook("vapi", off, vapiHeaders(off));
    // Nothing of what was said is kept: no references, and not the provider's synopsis of the conversation either.
    expect(await one("select recording_ref, transcript_ref, recording_consent, summary from crm_call_records where id = $1", [r1.recordId])).toEqual({ recording_ref: null, transcript_ref: null, recording_consent: "unknown", summary: null });
    // Retell's call_analyzed summary is treated the same way.
    const rcOff = rid("rc");
    for (const event of ["call_ended", "call_analyzed"]) {
      const body = JSON.stringify(retellEvent(event, { callId: rcOff, agentId: agentA }));
      await handleVoiceWebhook("retell", body, retellHeaders(body));
    }
    expect(await one("select summary from crm_call_records where provider = 'retell' and provider_call_id = $1", [rcOff])).toEqual({ summary: null });

    await saveVoiceConnection(adminA, { provider: "vapi", externalIds: assistantA, vapiAuthMode: "hmac", storeRecordings: true, recordingAnnounced: true });
    const callId = rid("call");
    const on = JSON.stringify(vapiEndOfCall({ callId, assistantId: assistantA, customer: number() }));
    const r2 = await handleVoiceWebhook("vapi", on, vapiHeaders(on));
    expect(await one("select recording_ref, transcript_ref, recording_consent, summary from crm_call_records where id = $1", [r2.recordId])).toEqual({
      recording_ref: `https://storage.vapi.example/recordings/${callId}.wav`, transcript_ref: `vapi:call/${callId}/transcript`, recording_consent: "announced", summary: "Caller asked about opening hours.",
    });
    // The transcript's text is never stored anywhere on the record.
    expect(JSON.stringify(await one("select * from crm_call_records where id = $1", [r2.recordId]))).not.toContain("What are your hours");
    const silent = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistantA, customer: number(), recording: false, transcript: false }));
    const r3 = await handleVoiceWebhook("vapi", silent, vapiHeaders(silent));
    expect((await one<{ recording_consent: string }>("select recording_consent from crm_call_records where id = $1", [r3.recordId])).recording_consent).toBe("not_recorded");
    await saveVoiceConnection(adminA, { provider: "vapi", externalIds: assistantA, vapiAuthMode: "hmac", storeRecordings: false });
  });

  it("upserts one record per provider call, forward only, emitting call.completed once", async () => {
    const callId = rid("rc");
    const send = async (event: string, extra: Partial<Parameters<typeof retellEvent>[1]> = {}) => {
      const body = JSON.stringify(retellEvent(event, { callId, agentId: agentA, ...extra }));
      return handleVoiceWebhook("retell", body, retellHeaders(body));
    };
    expect((await send("call_started")).outcome).toBe("processed");
    const id = (await one<{ id: string; status: string }>("select id, status from crm_call_records where provider = 'retell' and provider_call_id = $1", [callId])).id;
    expect((await one<{ status: string }>("select status from crm_call_records where id = $1", [id])).status).toBe("in_progress");
    // call_analyzed (voicemail) arrives before call_ended: the more specific outcome is kept.
    expect((await send("call_analyzed", { voicemail: true })).outcome).toBe("processed");
    expect((await send("call_ended")).outcome).toBe("processed");
    expect((await send("call_started")).outcome).toBe("duplicate");
    const rec = await one<{ status: string; duration_seconds: number; summary: string; disposition: string }>("select status, duration_seconds, summary, disposition from crm_call_records where id = $1", [id]);
    expect(rec).toMatchObject({ status: "voicemail", duration_seconds: 65, summary: null, disposition: "user_hangup" });
    expect(await count("select count(*)::text as n from crm_call_records where provider_call_id = $1", [callId])).toBe(1);
    expect(await count("select count(*)::text as n from crm_events where type = 'call.completed' and entity_id = $1", [id])).toBe(1);

    // The same event recorded twice straight through the service (no receipt) changes nothing more.
    const ended = (parseRetellEvent(retellEvent("call_ended", { callId, agentId: agentA })) as { event: VoiceCallEvent }).event;
    expect(await withSystem((db) => recordVoiceEvent(db, { orgId: a.org.id, storeRecordings: false }, ended))).toMatchObject({ outcome: "updated", completed: false });
    expect(await count("select count(*)::text as n from crm_events where type = 'call.completed' and entity_id = $1", [id])).toBe(1);

    // A late "in progress" from Vapi never re-opens an ended call.
    const vCall = rid("call");
    const end = JSON.stringify(vapiEndOfCall({ callId: vCall, assistantId: assistantA, customer: number() }));
    await handleVoiceWebhook("vapi", end, vapiHeaders(end));
    const late = JSON.stringify(vapiStatus({ callId: vCall, assistantId: assistantA, status: "in-progress" }));
    expect((await handleVoiceWebhook("vapi", late, vapiHeaders(late))).outcome).toBe("processed");
    expect((await one<{ status: string }>("select status from crm_call_records where provider_call_id = $1", [vCall])).status).toBe("completed");
  });

  it("never lets one workspace's event touch another workspace's call", async () => {
    const callId = rid("call");
    const mine = JSON.stringify(vapiEndOfCall({ callId, assistantId: assistantA, customer: number() }));
    const r = await handleVoiceWebhook("vapi", mine, vapiHeaders(mine));
    const before = await one("select * from crm_call_records where id = $1", [r.recordId]);
    // B's connection reports a call with the same provider call id (a forged or misrouted event): refused, A's record untouched.
    const theirs = JSON.stringify(vapiEndOfCall({ callId, assistantId: assistantB, customer: number(), endedReason: "customer-busy" }));
    expect(await handleVoiceWebhook("vapi", theirs, headersFrom({ authorization: "Bearer vapi-bearer-token-for-b-000001" }))).toMatchObject({ status: 409, outcome: "rejected", orgId: b.org.id });
    expect(await one("select * from crm_call_records where id = $1", [r.recordId])).toEqual(before);
    expect((await listCalls(b.actor("owner"), { pageSize: 100 })).rows.some((c) => c.id === r.recordId)).toBe(false);
    expect((await listCalls(a.actor("owner"), { pageSize: 100 })).rows.some((c) => c.id === r.recordId)).toBe(true);
  });

  it("stops accepting a provider's events once it is disconnected", async () => {
    const c = await crmOrg({ name: "Disconnecting Co" });
    const admin = await writeAdmin(c);
    const agent = rid("agent");
    await saveVoiceConnection(admin, { provider: "retell", externalIds: agent, secret: RETELL_KEY, storeRecordings: false });
    const body = JSON.stringify(retellEvent("call_ended", { callId: rid("rc"), agentId: agent }));
    expect((await handleVoiceWebhook("retell", body, retellHeaders(body))).outcome).toBe("processed");
    await disconnectVoiceConnection(admin, "retell");
    const again = JSON.stringify(retellEvent("call_ended", { callId: rid("rc"), agentId: agent }));
    expect(await handleVoiceWebhook("retell", again, retellHeaders(again))).toMatchObject({ status: 404, outcome: "unknown_workspace" });
    expect((await listVoiceConnections(c.actor("owner"))).find((v) => v.provider === "retell")).toMatchObject({ status: "disconnected", credentialSaved: false });
  });

  it("answers through the route handlers with only the outcome word", async () => {
    const body = JSON.stringify(retellEvent("call_ended", { callId: rid("rc"), agentId: agentA }));
    const res = await retellRoute(new Request("http://localhost/api/webhooks/retell", { method: "POST", body, headers: { "x-retell-signature": signRetell(body, RETELL_KEY, Date.now()), "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "processed" });
    const bad = await retellRoute(new Request("http://localhost/api/webhooks/retell", { method: "POST", body, headers: { "x-retell-signature": "v=1,d=00" } }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ received: false, outcome: "unauthorized" });
    const big = await vapiRoute(new Request("http://localhost/api/webhooks/vapi", { method: "POST", body: "x", headers: { "content-length": "3000000" } }));
    expect(big.status).toBe(413);
    expect((await retellGet()).status).toBe(405);
  });

  it("stops reading the vault for an address whose requests keep failing authentication, without holding back the provider's own", async () => {
    const c = await crmOrg({ name: "Forged Calls Co" });
    const admin = await writeAdmin(c);
    const assistant = rid("asst");
    await saveVoiceConnection(admin, { provider: "vapi", externalIds: assistant, vapiAuthMode: "hmac", secret: VAPI_SECRET, storeRecordings: false });
    const from = (ip: string, h: ReturnType<typeof headersFrom>) => ({ get: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? `${ip}, 10.0.0.1` : h.get(name)) });
    const forged = () => {
      const body = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistant, customer: number() }));
      return { body, headers: vapiHeaders(body, "a-guessed-secret-000000000000") };
    };
    const resolved = () => count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'credential.resolved'", [c.org.id]);

    for (let i = 0; i < 20; i += 1) {
      const f = forged();
      expect(await handleVoiceWebhook("vapi", f.body, from("203.0.113.7", f.headers))).toMatchObject({ status: 401, outcome: "unauthorized", orgId: c.org.id });
    }
    const lookups = await resolved();
    expect(lookups).toBeGreaterThanOrEqual(20);
    // The 21st from that address is refused before the vault is read: no credential lookup, no audit row, nothing recorded.
    const f = forged();
    const blocked = await handleVoiceWebhook("vapi", f.body, from("203.0.113.7", f.headers));
    expect(blocked).toMatchObject({ status: 429, outcome: "rate_limited", orgId: c.org.id });
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(await resolved()).toBe(lookups);
    // The provider's own signed events come from its own addresses and still go through; another address isn't blocked either.
    const real = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistant, customer: number() }));
    expect(await handleVoiceWebhook("vapi", real, from("198.51.100.2", vapiHeaders(real)))).toMatchObject({ status: 200, outcome: "processed", orgId: c.org.id });
    const other = forged();
    expect(await handleVoiceWebhook("vapi", other.body, from("198.51.100.99", other.headers))).toMatchObject({ status: 401, outcome: "unauthorized" });
    // Valid requests never count: the same connection keeps working from the provider's address after many calls.
    for (let i = 0; i < 3; i += 1) {
      const ok = JSON.stringify(vapiEndOfCall({ callId: rid("call"), assistantId: assistant, customer: number() }));
      expect((await handleVoiceWebhook("vapi", ok, from("198.51.100.2", vapiHeaders(ok)))).outcome).toBe("processed");
    }
    // Through the route: 429 with Retry-After and only the outcome word.
    const g = forged();
    const res = await vapiRoute(new Request("http://localhost/api/webhooks/vapi", { method: "POST", body: g.body, headers: { "x-signature": g.headers.get("x-signature")!, "x-timestamp": g.headers.get("x-timestamp")!, "x-forwarded-for": "203.0.113.7" } }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ received: false, outcome: "rate_limited" });
  });
});

// ---------------------------------------------------------------------------
// People logging and working with calls
// ---------------------------------------------------------------------------

describe("calls logged and worked by the team", () => {
  let o: CrmOrg;
  beforeAll(async () => {
    o = await crmOrg({ name: "Logging Co" });
  });

  it("logs a call a person made, completing it with a timeline entry, an event and an optional follow-up task", async () => {
    const sales = o.actor("sales");
    const phoneNo = number();
    const c = await createContact(o.actor("owner"), { firstName: "Paolo", lastName: "Reyes", phone: phoneNo });
    const started = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await logCall(sales, { contactId: c.id, direction: "outbound", status: "completed", startedAt: started, durationSeconds: 300, disposition: "Booked", summary: "Booked a visit for Friday.", followUp: { title: "Send the quote", assigneeId: o.people.sales.id } });
    expect(r.taskId).toBeTruthy();
    const rec = await one<Record<string, unknown>>("select provider, provider_call_id, direction, status, to_number, from_number, contact_id, owner_user_id, duration_seconds, disposition, recording_consent, follow_up_task_id from crm_call_records where id = $1", [r.id]);
    expect(rec).toMatchObject({ provider: "manual", provider_call_id: null, direction: "outbound", status: "completed", to_number: phoneNo, from_number: null, contact_id: c.id, owner_user_id: o.people.sales.id, duration_seconds: 300, disposition: "Booked", recording_consent: "not_recorded", follow_up_task_id: r.taskId });
    expect(await one("select title, contact_id, assigned_user_id from tasks where id = $1", [r.taskId])).toMatchObject({ title: "Send the quote", contact_id: c.id, assigned_user_id: o.people.sales.id });
    expect(await count("select count(*)::text as n from crm_events where type = 'call.completed' and entity_id = $1", [r.id])).toBe(1);
    expect(await one("select kind from crm_activities where org_id = $1 and ref_id = $2", [o.org.id, r.id])).toMatchObject({ kind: "call.logged" });
    expect((await listContactCalls(o.actor("setter"), c.id)).map((x) => x.id)).toEqual([r.id]);
  });

  it("checks what a person enters, and who may log calls", async () => {
    const c = await createContact(o.actor("owner"), { firstName: "Ana", lastName: "Lim", phone: number() });
    const base = { contactId: c.id, direction: "inbound" as const, status: "completed" as const, startedAt: new Date().toISOString() };
    await expectError(logCall(o.actor("viewer"), base), "forbidden");
    await expectError(logCall(o.actor("sales"), { ...base, startedAt: new Date(Date.now() + 3_600_000).toISOString() }), "invalid_input", /future/);
    await expectError(logCall(o.actor("sales"), { ...base, status: "no_answer", durationSeconds: 60 }), "invalid_input", /answered/);
    await expectError(logCall(o.actor("sales"), { ...base, status: "ringing" }), "invalid_input");
    await expectError(logCall(o.actor("sales"), { ...base, recordingUrl: "https://files.example/rec.mp3" }), "invalid_input", /told the call was recorded/);
    await expectError(logCall(o.actor("sales"), { ...base, recordingConsent: "granted", recordingUrl: "http://files.example/rec.mp3" }), "invalid_input", /https/);
    await expectError(logCall(o.actor("sales"), { ...base, phone: "0917 123 4567" }), "invalid_input", /international format/);
    await expectError(logCall(o.actor("sales"), { ...base, contactId: crypto.randomUUID() }), "not_found");
    const ok = await logCall(o.actor("sales"), { ...base, recordingConsent: "granted", recordingUrl: "https://files.example/rec.mp3" });
    expect(await one("select recording_ref, recording_consent from crm_call_records where id = $1", [ok.id])).toEqual({ recording_ref: "https://files.example/rec.mp3", recording_consent: "granted" });
  });

  it("lets the team annotate a call, link an unmatched one to a contact, and create one follow-up", async () => {
    const admin = await writeAdmin(o);
    const agent = rid("agent");
    await saveVoiceConnection(admin, { provider: "retell", externalIds: agent, secret: RETELL_KEY, storeRecordings: false });
    const caller = number();
    const body = JSON.stringify(retellEvent("call_ended", { callId: rid("rc"), agentId: agent, from: caller }));
    const { recordId } = await handleVoiceWebhook("retell", body, retellHeaders(body));
    const call = recordId!;
    await expectError(updateCall(o.actor("viewer"), call, { notes: "x" }), "forbidden");
    await expectError(updateCall(o.actor("sales"), call, { disposition: "Booked" }), "invalid_input", /provider's own/);
    const c = await createContact(o.actor("owner"), { firstName: "Late", lastName: "Linker" });
    await updateCall(o.actor("sales"), call, { notes: "Wants a call back after 5pm.", contactId: c.id });
    expect(await one("select notes, contact_id, disposition from crm_call_records where id = $1", [call])).toEqual({ notes: "Wants a call back after 5pm.", contact_id: c.id, disposition: "user_hangup" });
    const other = await createContact(o.actor("owner"), { firstName: "Someone", lastName: "Else" });
    await expectError(updateCall(o.actor("sales"), call, { contactId: other.id }), "conflict", /already linked/);
    const t = await createCallFollowUp(o.actor("sales"), call, {});
    expect((await one<{ title: string }>("select title from tasks where id = $1", [t.taskId])).title).toBe("Follow up on the call with Late Linker");
    await expectError(createCallFollowUp(o.actor("sales"), call, {}), "conflict", /already has a follow-up/);
    await expectError(createCallFollowUp(o.actor("viewer"), call, {}), "forbidden");
  });

  it("filters calls by outcome, source, direction and whether a contact matched", async () => {
    const f = await crmOrg({ name: "Filter Calls Co" });
    const admin = await writeAdmin(f);
    const agent = rid("agent");
    await saveVoiceConnection(admin, { provider: "retell", externalIds: agent, secret: RETELL_KEY, storeRecordings: false });
    const c = await createContact(f.actor("owner"), { firstName: "Known", lastName: "Caller", phone: number() });
    const send = async (event: string, extra: Partial<Parameters<typeof retellEvent>[1]>) => {
      const body = JSON.stringify(retellEvent(event, { callId: rid("rc"), agentId: agent, ...extra }));
      return handleVoiceWebhook("retell", body, retellHeaders(body));
    };
    await send("call_ended", {});
    await send("call_ended", { reason: "dial_no_answer", direction: "outbound", from: "+15555550100", to: number() });
    await send("call_started", {});
    await logCall(f.actor("sales"), { contactId: c.id, direction: "outbound", status: "busy", startedAt: new Date().toISOString() });
    const owner = f.actor("owner");
    const all = await listCalls(owner, {});
    expect(all.counts).toEqual({ all: 4, completed: 1, missed: 2, failed: 0, live: 1 });
    expect((await listCalls(owner, { status: "missed" })).rows.map((r) => r.status).sort()).toEqual(["busy", "no_answer"]);
    expect((await listCalls(owner, { provider: "manual" })).rows).toHaveLength(1);
    expect((await listCalls(owner, { direction: "outbound" })).rows).toHaveLength(2);
    expect((await listCalls(owner, { match: "matched" })).rows.map((r) => r.contact?.id)).toEqual([c.id]);
    expect((await listCalls(owner, { match: "unmatched", status: "live" })).rows).toHaveLength(1);
    await expectError(listCalls(f.actor("viewer"), {}), "forbidden");
  });
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

describe("the call screens", () => {
  it("render the list, the filters, the connections (without secrets) and a contact's Calls section", async () => {
    const o = await crmOrg({ name: "Screen Calls Co" });
    const admin = await writeAdmin(o);
    await saveVoiceConnection(admin, { provider: "vapi", externalIds: rid("asst"), vapiAuthMode: "bearer", secret: "screen-secret-should-never-show", storeRecordings: false });
    const c = await createContact(o.actor("owner"), { firstName: "Screen", lastName: "Person", phone: number() });
    await logCall(o.actor("sales"), { contactId: c.id, direction: "inbound", status: "completed", startedAt: new Date().toISOString(), durationSeconds: 75, summary: "Asked about prices." });
    const owner = o.actor("owner");
    const scope = await scopeFor(owner, "/crm");
    const [calls, connections] = await Promise.all([listCalls(owner, {}), listVoiceConnections(owner)]);
    const html = renderToStaticMarkup(React.createElement(CallsWorkspace, {
      scope, tab: "calls", filters: { status: "all", provider: "all", direction: "all", match: "all", days: null }, calls, connections, members: [], canLog: true, canFollowUp: true, canConnect: false,
      vapiAuthModes: [{ value: "bearer", label: "Bearer token" }],
    }));
    expect(html).toContain("Screen Person");
    expect(html).toContain("1 min 15 s");
    expect(html).toContain("Log a call");
    const conn = renderToStaticMarkup(React.createElement(CallsWorkspace, {
      scope, tab: "connections", filters: { status: "all", provider: "all", direction: "all", match: "all", days: null }, calls, connections, members: [], canLog: true, canFollowUp: true, canConnect: false,
      vapiAuthModes: [{ value: "bearer", label: "Bearer token" }],
    }));
    expect(conn).toContain("http://localhost:3000/api/webhooks/vapi");
    expect(conn).toContain("agency super admin");
    expect(conn).not.toContain("screen-secret-should-never-show");
    const section = renderToStaticMarkup(React.createElement(ContactCalls, { scope, contact: { id: c.id, name: "Screen Person" }, calls: calls.rows, members: [] }));
    expect(section).toContain("Incoming call");
    expect(section).toContain("exact phone number");
  });
});
