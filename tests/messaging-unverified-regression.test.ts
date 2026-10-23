// The attack this guards against: a visitor types SOMEONE ELSE'S phone number or email address into the website chat's details form. Before the rule, the form recorded
// consent for that address and a workflow started by the form (or a campaign, reminder or follow-up) could message a stranger who never agreed to anything. These tests
// drive the real paths end to end and prove nothing reaches the stranger, while the same paths still work for everyone else.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { decideApproval } from "@/server/approvals/service";
import { memberActor } from "@/server/crm/actor";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import { createWorkflow, publishWorkflow, requestWorkflowApproval } from "@/server/crm/workflows/definitions";
import { startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { confirmContactIdentity } from "@/server/messaging/consent-identity";
import { queueOutreach, type OutreachRequest } from "@/server/messaging/outreach";
import { dispatchDue } from "@/server/messaging/send";
import { inbound, recordingProvider } from "./support/messaging";
import { identityOf, nativeChatOrg, typedLead, channelConversation } from "./support/unverified";
import { answer, clientId, embedCall, hashOf, start, type ChatOrg } from "./support/webchat";

const NOW = new Date("2026-10-21T12:00:00Z");
let c: ChatOrg;
let onLeadWorkflow: string;
let manualWorkflow: string;

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;

async function settle() {
  for (let i = 0; i < 40; i += 1) {
    const d = await crmEventDispatch();
    const r = await processWorkflowRuns();
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

/** A workflow sending the approved text, made by the manager and approved by the owner for exactly this version, as a real one is. */
async function liveWorkflow(trigger: WorkflowDefinition["trigger"], templateId: string, contentHash: string): Promise<string> {
  const manager = memberActor(c.m.ctx("manager"));
  const def: WorkflowDefinition = { trigger, steps: [step("send", "send_message", { templateId, contentHash, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: false })] };
  const { id } = await createWorkflow(manager, { name: `Welcome ${Math.random().toString(36).slice(2, 8)}`, definition: def });
  expect((await publishWorkflow(manager, id)).needsApproval).toBe(true);
  const req = await requestWorkflowApproval(manager, id, null, { activate: true });
  await decideApproval(c.m.ctx("owner"), req.approvalId!, "approve");
  return id;
}

const stepResults = (workflowId: string) =>
  rows<{ status: string; result: Record<string, unknown> }>("select s.status, s.result from crm_workflow_run_steps s join crm_workflow_runs r on r.id = s.run_id and r.org_id = s.org_id where r.workflow_id = $1 order by s.id", [workflowId]);
const outboundFor = (contactId: string) =>
  rows<{ id: string; status: string; blocked_reason: string | null }>(
    "select m.id, m.status, m.blocked_reason from conversation_messages m join conversations cv on cv.id = m.conversation_id where cv.contact_id = $1 and m.direction = 'outbound' and cv.channel in ('sms', 'whatsapp', 'email')",
    [contactId],
  );
const anyOutbound = () => rows("select 1 from conversation_messages m join conversations cv on cv.id = m.conversation_id where cv.org_id = $1 and m.direction = 'outbound' and cv.channel in ('sms', 'whatsapp', 'email')", [c.m.org.id]);

/** Everything that is queued, handed to recording providers, so the test can see what would have left the building. */
async function whatLeaves() {
  const sms = recordingProvider("twilio");
  const mail = recordingProvider("resend");
  const a = await dispatchDue({ transport: sms.transport });
  const b = await dispatchDue({ transport: mail.transport });
  return { attempted: a.attempted + b.attempted, sent: [...sms.calls, ...mail.calls] };
}

beforeAll(async () => {
  c = await nativeChatOrg();
  const owner = memberActor(c.m.ctx("owner"));
  const t = await createTemplate(owner, { name: "Welcome text", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, thanks for asking about a quote." });
  const approved = await approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
  onLeadWorkflow = await liveWorkflow({ type: "webchat.lead_captured" }, t.id, approved.contentHash);
  manualWorkflow = await liveWorkflow({ type: "manual" }, t.id, approved.contentHash);
});

describe("a workflow started by the details form", () => {
  it("cannot text the number the visitor typed: the step is blocked with the plain reason and nothing is queued or sent", async () => {
    const stranger = "+639175550777"; // somebody else's number
    const lead = await typedLead(c, { phone: stranger, email: null });
    await settle();
    const results = await stepResults(onLeadWorkflow);
    expect(results.at(-1)).toMatchObject({ status: "skipped", result: { outcome: "blocked", reason: "identity_unverified" } });
    expect(String(results.at(-1)?.result.detail)).toMatch(/visitor typed this number or address and it has not been confirmed/);
    expect(await outboundFor(lead.contactId)).toEqual([]);
    expect(await anyOutbound()).toEqual([]);
    expect(await whatLeaves()).toEqual({ attempted: 0, sent: [] });
  });

  it("is the same when a person runs the same step by hand on the chat's contact", async () => {
    const lead = await typedLead(c, { email: null });
    const run = await startManualRun(memberActor(c.m.ctx("owner")), manualWorkflow, { contactId: lead.contactId });
    await processWorkflowRuns();
    expect(run.runId).toBeTruthy();
    expect((await stepResults(manualWorkflow)).at(-1)).toMatchObject({ status: "skipped", result: { outcome: "blocked", reason: "identity_unverified" } });
    expect(await outboundFor(lead.contactId)).toEqual([]);
  });

  it("still works for everyone else: the same step texts an ordinary customer who agreed to it", async () => {
    const owner = memberActor(c.m.ctx("owner"));
    const customer = await createContact(owner, { firstName: "Olga", lastName: "Reyes", phone: "+639171110042" });
    await setContactConsent(owner, customer.id, { channel: "sms", purpose: "service", status: "granted", evidence: "Asked to be texted at the front desk." });
    await startManualRun(owner, manualWorkflow, { contactId: customer.id });
    await processWorkflowRuns();
    const queued = await outboundFor(customer.id);
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("queued");
    const sent = recordingProvider("twilio");
    expect((await dispatchDue({ transport: sent.transport })).attempted).toBeGreaterThanOrEqual(1);
    expect(sent.calls.map((x) => x.to)).toContain("+639171110042");
    expect(sent.calls.every((x) => x.to !== "+639175550777")).toBe(true);
  });

  it("is shown as 'would be blocked' in a test run, before anything is switched on", async () => {
    const lead = await typedLead(c, { email: null });
    const res = await startTestRun(memberActor(c.m.ctx("owner")), manualWorkflow, { contactId: lead.contactId });
    expect(res.steps.at(-1)).toMatchObject({ stepKey: "send", outcome: "would_skip" });
    expect(res.steps.at(-1)?.detail).toMatch(/visitor typed this number or address and it has not been confirmed/);
  });
});

describe("the other automated paths", () => {
  const outreach = (contactId: string, over: Partial<OutreachRequest>): OutreachRequest => ({
    orgId: c.m.org.id, contactId, agentId: c.m.salesAgentId, scope: "followup", body: "A short message.", subject: "Hello", approvalId: null, dedupeKey: `reg-${Math.random().toString(36).slice(2)}`, now: NOW, businessHoursOnly: false, ...over,
  });

  it("refuses an appointment reminder, a retention program message, a follow-up and a promotional campaign, each with the real reason, and queues nothing", async () => {
    const lead = await typedLead(c, { marketing: true });
    const before = (await outboundFor(lead.contactId)).length;
    for (const req of [
      outreach(lead.contactId, { scope: "reminder" }),
      outreach(lead.contactId, { scope: "retention" }),
      outreach(lead.contactId, { scope: "followup" }),
      outreach(lead.contactId, { scope: "retention", purpose: "marketing" }),
      outreach(lead.contactId, { scope: "followup", approvalId: "00000000-0000-4000-8000-000000000001" }),
    ]) {
      const res = await withSystem((db) => queueOutreach(db, req));
      expect(res, `${req.scope} ${req.purpose ?? ""}`).toMatchObject({ status: "blocked", reason: "identity_unverified" });
    }
    expect((await outboundFor(lead.contactId)).length).toBe(before);
  });

  it("says there is no way to reach a chat that left no details, instead of pointing at the chat window", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi!").generate });
    const contact = (await rows<{ contact_id: string }>("select contact_id from web_chat_sessions where token_hash = $1", [hashOf(token)]))[0].contact_id;
    const res = await withSystem((db) => queueOutreach(db, outreach(contact, { scope: "reminder" })));
    expect(res).toMatchObject({ status: "blocked", reason: "no_contact_channel" });
  });
});

describe("a visitor who types an existing customer's number", () => {
  it("reaches nobody: the customer's record is untouched, the chat's contact has no number of its own, and no message leaves", async () => {
    const owner = memberActor(c.m.ctx("owner"));
    const customerPhone = "+639179990123";
    const customer = await createContact(owner, { firstName: "Real", lastName: "Customer", phone: customerPhone });
    await setContactConsent(owner, customer.id, { channel: "sms", purpose: "service", status: "granted", evidence: "Texted us first." });
    const before = (await rows<{ version: number }>("select version from contacts where id = $1", [customer.id]))[0].version;
    const outboundBefore = (await anyOutbound()).length;

    const lead = await typedLead(c, { phone: customerPhone, email: null });
    await settle();
    expect(await identityOf(c.m.org.id, "phone", customerPhone)).toMatchObject({ contact_id: customer.id });
    expect((await rows<{ version: number }>("select version from contacts where id = $1", [customer.id]))[0].version).toBe(before);
    expect(await rows("select 1 from contact_identities where contact_id = $1", [lead.contactId])).toHaveLength(0);
    expect((await anyOutbound()).length).toBe(outboundBefore);
    const sent = await whatLeaves();
    expect(sent.sent.every((x) => x.to !== customerPhone)).toBe(true);
  });
});

describe("when the real owner of the number writes in", () => {
  it("lets service messages through from then on, but never the promotional tick the visitor made", async () => {
    const lead = await typedLead(c, { email: null, marketing: true });
    await channelConversation(c, lead.contactId, "sms");
    const decide =(req: Partial<OutreachRequest>) => withSystem((db) => queueOutreach(db, { orgId: c.m.org.id, contactId: lead.contactId, agentId: c.m.salesAgentId, scope: "followup", body: "Checking in.", subject: "Hi", approvalId: null, dedupeKey: `own-${Math.random().toString(36).slice(2)}`, now: NOW, businessHoursOnly: false, channel: "sms", ...req }));
    expect(await decide({})).toMatchObject({ status: "blocked", reason: "identity_unverified" });
    // The number's real owner texts the business (the carrier proves where it came from).
    await inbound(c.m.org.id, { provider: "twilio", channel: "sms", address: lead.phone!, ghlContactId: null, body: "Hello, is this the roofing company?" });
    expect((await identityOf(c.m.org.id, "phone", lead.phone!)).verified).toBe(true);
    expect(await decide({})).toMatchObject({ status: "queued" });
    // Whoever typed the number also ticked the box for offers. That was not the number owner's decision, so it is not honoured.
    expect(await decide({ scope: "retention", purpose: "marketing", dedupeKey: "promo-1" })).toMatchObject({ status: "blocked", reason: "no_consent" });
  });

  it("keeps the person's own confirmation as the only other way in, and it unlocks service messages only", async () => {
    const lead = await typedLead(c, { email: null, marketing: true });
    const decide = (req: Partial<OutreachRequest>) => withSystem((db) => queueOutreach(db, { orgId: c.m.org.id, contactId: lead.contactId, agentId: c.m.salesAgentId, scope: "followup", body: "Checking in.", subject: "Hi", approvalId: null, dedupeKey: `conf-${Math.random().toString(36).slice(2)}`, now: NOW, businessHoursOnly: false, channel: "sms", ...req }));
    expect(await decide({})).toMatchObject({ status: "blocked", reason: "identity_unverified" });
    await confirmContactIdentity(c.m.ctx("owner"), { identityId: (await identityOf(c.m.org.id, "phone", lead.phone!)).id, how: "Called the number and spoke to Dana." });
    expect(await decide({})).toMatchObject({ status: "queued" });
    expect(await decide({ scope: "retention", purpose: "marketing", dedupeKey: "promo-2" })).toMatchObject({ status: "blocked", reason: "no_consent" });
  });
});
