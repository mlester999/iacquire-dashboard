// Cases the rest of the Phase 2 suites lean on but do not exercise end to end: the real signed webhook path with duplicates and out-of-order delivery, the
// customer's own time zone deciding quiet hours, the Automation Studio plan boundary for the new triggers and steps, and the AI employees' tool list.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { createContact } from "@/server/crm/contacts";
import { createWorkflow } from "@/server/crm/workflows/definitions";
import { saveVoiceConnection } from "@/server/crm/calls";
import { handleVoiceWebhook } from "@/server/integrations/voice/handler";
import { headersFrom } from "@/server/integrations/voice/types";
import { vapiHmacSignature } from "@/server/integrations/voice/vapi";
import { AGENT_TOOL_NAMES } from "@/server/crm/agent-tools/catalog";
import { processMissedCalls } from "@/server/missed-calls/engine";
import type { WorkflowStep } from "@/lib/crm/workflow/spec";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { actionsOf, caseOf, callerNumber, count, eventsOf, messagesFor, minutesAfter, recoveryWorkspace, rows } from "./support/missed-calls";

const SECRET = "vapi-hmac-secret-for-phase2-001";
const rid = (p: string) => `${p}_${crypto.randomBytes(5).toString("hex")}`;
const headers = (body: string, at = Date.now()) => {
  const ts = String(at);
  return headersFrom({ "x-signature": vapiHmacSignature(SECRET, ts, body), "x-timestamp": ts, "content-type": "application/json" });
};

describe("signed webhooks, end to end", () => {
  let o: CrmOrg;
  let admin: CrmActor;
  const assistant = rid("asst");
  beforeAll(async () => {
    o = await crmOrg({ name: "Phase 2 Voice Co" });
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, o.org.id, { mode: "write", reason: "Connecting the voice assistant" });
    admin = await agencyActor(superAdmin, o.org.id);
    await saveVoiceConnection(admin, { provider: "vapi", externalIds: assistant, vapiAuthMode: "hmac", secret: SECRET, storeRecordings: false });
  });

  const status = (callId: string, s: string, customer: string, endedReason?: string) =>
    JSON.stringify({ message: { type: "status-update", status: s, endedReason, startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: s === "ended" ? new Date().toISOString() : undefined, call: { id: callId, type: "inboundPhoneCall", assistantId: assistant, customer: { number: customer } }, customer: { number: customer }, phoneNumber: { number: "+15555550100" } } });
  const report = (callId: string, customer: string, endedReason: string) =>
    JSON.stringify({ message: { type: "end-of-call-report", endedReason, startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString(), call: { id: callId, type: "inboundPhoneCall", assistantId: assistant, customer: { number: customer } }, customer: { number: customer }, phoneNumber: { number: "+15555550100" } } });

  it("a redelivered final report changes nothing, a late 'ringing' does not undo the end, and a more specific final reason reclassifies the same case", async () => {
    const caller = callerNumber();
    const callId = rid("call");
    const ringing = status(callId, "ringing", caller);
    expect(await handleVoiceWebhook("vapi", ringing, headers(ringing))).toMatchObject({ status: 200, outcome: "processed" });
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1", [o.org.id])).toBe(0);

    const ended = status(callId, "ended", caller, "customer-did-not-answer");
    expect(await handleVoiceWebhook("vapi", ended, headers(ended))).toMatchObject({ status: 200, outcome: "processed" });
    const first = await caseOf(o.org.id, caller);
    expect(first).toMatchObject({ state: "detected", call_count: 1 });
    const kinds = async () => (await eventsOf(first.id)).map((e) => e.kind);

    // The provider delivers the same report again, and a stale "ringing" update arrives after the call ended.
    expect(await handleVoiceWebhook("vapi", ended, headers(ended))).toMatchObject({ status: 200, outcome: "duplicate" });
    const late = status(callId, "ringing", caller);
    await handleVoiceWebhook("vapi", late, headers(late));
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number = $2", [o.org.id, caller])).toBe(1);
    expect(await kinds()).toEqual(["case_created"]);
    expect((await rows<{ status: string }>("select status from crm_call_records where org_id = $1 and provider_call_id = $2", [o.org.id, callId]))[0].status).toBe("no_answer");

    // The end-of-call report arrives later and says the caller reached voicemail: the same case, reclassified, nothing doubled.
    const vm = report(callId, caller, "voicemail");
    expect(await handleVoiceWebhook("vapi", vm, headers(vm))).toMatchObject({ status: 200, outcome: "processed" });
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number = $2", [o.org.id, caller])).toBe(1);
    expect((await rows<{ classification: string }>("select classification from missed_call_case_calls where case_id = $1", [first.id]))[0].classification).toBe("voicemail");
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'call.missed'", [o.org.id])).toBe(1);
  });

  it("refuses a forged report and records nothing", async () => {
    const caller = callerNumber();
    const body = report(rid("call"), caller, "customer-did-not-answer");
    const forged = headersFrom({ "x-signature": "0".repeat(64), "x-timestamp": String(Date.now()) });
    expect(await handleVoiceWebhook("vapi", body, forged)).toMatchObject({ status: 401, outcome: "unauthorized" });
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number = $2", [o.org.id, caller])).toBe(0);
  });
});

describe("the customer's own time zone", () => {
  it("holds a text during the customer's quiet hours even when it is daytime for the business", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '21:00', quiet_hours_end = '08:00'"));
    const at = new Date("2026-10-22T13:00:00Z"); // 13:00 in the business's UTC, 21:00 in Manila
    const manila = callerNumber();
    const local = callerNumber();
    const a = await createContact(r.owner, { displayName: "Manila Mae", phone: manila });
    const b = await createContact(r.owner, { displayName: "Local Lou", phone: local });
    await withSystem(async (db) => {
      await db.query("update contacts set timezone = 'Asia/Manila' where id = $1", [a.id]);
      for (const id of [a.id, b.id]) await db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source) values ($1, $2, 'sms', 'service', 'granted', 'test')", [r.w.org.id, id]);
    });
    const { recordCall, voice } = await import("./support/missed-calls");
    await recordCall(r.w.org.id, voice({ customerNumber: manila, startedAt: at }), at);
    await recordCall(r.w.org.id, voice({ customerNumber: local, startedAt: at }), at);
    await processMissedCalls({ now: minutesAfter(5, at), orgId: r.w.org.id });
    expect(await messagesFor(a.id)).toEqual([]);
    expect((await caseOf(r.w.org.id, manila)).state).toBe("scheduled");
    expect((await caseOf(r.w.org.id, manila)).next_action_at!.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-22T00:00:00Z").getTime() + 24 * 3_600_000);
    expect(await messagesFor(b.id)).toHaveLength(1);
    expect((await actionsOf((await caseOf(r.w.org.id, local)).id)).find((x) => x.kind === "message")?.status).toBe("queued");
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
  });
});

describe("the Automation Studio plan boundary", () => {
  const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>): WorkflowStep => ({ key, kind, config, next: null }) as WorkflowStep;
  const def = { trigger: { type: "lead.became_hot" }, steps: [step("a", "request_reassessment", {})] };

  it("builds in the CRM screens without the plan, and needs the plan to build the same thing in Automation Studio", async () => {
    const o = await crmOrg({ name: "No Plan Co" });
    const owner = o.actor("owner");
    const crm = await createWorkflow(owner, { name: "Reassess hot leads", definition: def });
    expect(crm.id).toBeTruthy();
    const err = await createWorkflow(owner, { name: "Studio version", definition: def, origin: "studio" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("plan_required");
  });
});

describe("AI employees", () => {
  it("were given no new tool: nothing in their tool list reads or writes missed-call cases, lead priorities or overrides", () => {
    const names = [...AGENT_TOOL_NAMES] as string[];
    expect(names.filter((n) => /priorit|override|missed|recover|score|assess/i.test(n))).toEqual([]);
  });
});
