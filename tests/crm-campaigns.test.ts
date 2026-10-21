// Compliant segmented campaigns: preview and exclusions, published-rate estimates, the owner's approval bound to a fingerprint, the sending
// job (idempotency, pace, quiet hours, credits), pause/resume/cancel, delivery reconciliation, permissions and tenant isolation.
// Synthetic workspaces only: no provider is ever called (dispatch uses a recording transport) and nothing is sent anywhere.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { AppError } from "@/server/errors";
import { adjustCredits } from "@/server/billing/ledger";
import { decideApproval } from "@/server/approvals/service";
import { setClientPause } from "@/server/automation/controls";
import { agencyActor, memberActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { createSmartList, updateSmartList } from "@/server/crm/smart-lists";
import { approveTemplate, createTemplate, updateTemplate } from "@/server/crm/message-templates";
import { createCustomValue, updateCustomValue } from "@/server/crm/custom-values";
import { applyDeliveryEventForMessage, dispatchDue } from "@/server/messaging/send";
import {
  cancelCampaign, createCampaign, getCampaign, listCampaignRecipients, listCampaigns, pauseCampaign, pendingApprovalFor, previewCampaign, requestCampaignApproval,
  resumeCampaign, updateCampaign, duplicateCampaign, campaignBuilderOptions, testableTemplate,
} from "@/server/crm/campaigns";
import { campaignApprovalHash, stableJson } from "@/server/crm/campaigns/rules";
import { processCampaigns } from "@/server/crm/campaigns/job";
import { JOBS } from "@/server/ops/tick";
import { CRM_NAV } from "@/lib/crm/nav";
import type { Channel } from "@/lib/messaging";
import type { CrmScope } from "@/server/crm/page";
import { CampaignsList } from "@/components/crm/campaigns/campaigns-list";
import { CampaignWorkspace } from "@/components/crm/campaigns/campaign-workspace";
import { reasonLabel } from "@/components/crm/campaigns/parts";
import { agencyPeople, eventsFor } from "./support/crm";
import { messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/campaigns", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-campaigns", () => Object.fromEntries([
  "createCampaignAction", "updateCampaignAction", "duplicateCampaignAction", "previewCampaignAction", "requestCampaignApprovalAction", "approveCampaignAction", "returnCampaignAction",
  "pauseCampaignAction", "resumeCampaignAction", "cancelCampaignAction", "testSendCampaignAction",
].map((n) => [n, stub])));

const NATIVE = { email: "resend", sms: "twilio", whatsapp: "meta_whatsapp" } as const;
const ENV = ["TWILIO_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED"] as const;

const expectError = async (p: Promise<unknown>, code: string, text?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (text) expect((err as AppError).message).toMatch(text);
};

interface Ws {
  m: MessagingOrg;
  owner: CrmActor;
  manager: CrmActor;
  sales: CrmActor;
  viewer: CrmActor;
  smsTemplateId: string;
  listId: string;
}

let seq = 0;
const nextPhone = () => `+1555${String(2000000 + (seq += 1) + Math.floor(Math.random() * 900) * 1000).padStart(7, "0")}`;

/** A contact on the "springfield" list (unless another city is given) with marketing consent, opt-outs and addresses as asked. */
async function contact(orgId: string, o: { name?: string; firstName?: string | null; city?: string; phone?: string | null; email?: string | null; sms?: "granted" | "revoked" | null; email_consent?: "granted" | "revoked" | null; suppressSms?: boolean; timezone?: string | null } = {}) {
  const phone = o.phone === undefined ? nextPhone() : o.phone;
  const email = o.email ?? null;
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into contacts (org_id, display_name, first_name, email, phone, city, source, created_via, timezone) values ($1, $2, $3, $4, $5, $6, 'manual', 'manual', $7) returning id",
      [orgId, o.name ?? "Pat Example", o.firstName === undefined ? (o.name ?? "Pat Example").split(" ")[0] : o.firstName, email, phone, o.city ?? "Springfield", o.timezone ?? null],
    );
    const id = rows[0].id;
    if (phone) await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified, verified_via) values ($1, $2, 'phone', $3, true, 'staff_confirmed')", [orgId, id, phone]);
    if (email) await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified, verified_via) values ($1, $2, 'email', $3, true, 'staff_confirmed')", [orgId, id, email]);
    const consent = async (channel: Channel, status: "granted" | "revoked") => {
      await db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source, evidence) values ($1, $2, $3, 'marketing', 'granted', 'test', 'Opted in on a form')", [orgId, id, channel]);
      if (status === "revoked") await db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source, evidence) values ($1, $2, $3, 'marketing', 'revoked', 'test', 'Unsubscribed')", [orgId, id, channel]);
    };
    if (o.sms) await consent("sms", o.sms);
    if (o.email_consent) await consent("email", o.email_consent);
    if (o.suppressSms && phone) await db.query("insert into suppressions (org_id, channel, address, reason, source) values ($1, 'sms', $2, 'opt_out', 'test')", [orgId, phone]);
    return { id, phone, email };
  });
}

async function workspace(opts: { credits?: number; publishNativeRates?: boolean; city?: string } = {}): Promise<Ws> {
  const m = await messagingOrg({ provider: { ...NATIVE }, credits: opts.credits, publishNativeRates: opts.publishNativeRates });
  const owner = memberActor(m.ctx("owner"));
  const manager = memberActor(m.ctx("manager"));
  const sales = memberActor(m.ctx("sales"));
  const viewer = memberActor(m.ctx("viewer"));
  const t = await createTemplate(owner, { name: "Autumn offer", channel: "sms", purpose: "marketing", body: "Hi {{contact.first_name}}, 20% off this week at {{business.name}}. Reply STOP to opt out." });
  await approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
  const list = await createSmartList(owner, { entity: "contact", name: "Springfield", visibility: "team", filter: { op: "and", conditions: [{ field: "city", op: "equals", value: opts.city ?? "springfield" }] } });
  return { m, owner, manager, sales, viewer, smsTemplateId: t.id, listId: list.id };
}

async function draft(w: Ws, over: Partial<Parameters<typeof createCampaign>[1]> = {}) {
  return createCampaign(w.manager, { name: "Autumn offer", channel: "sms", smartListId: w.listId, templateId: w.smsTemplateId, schedule: { mode: "now" }, ratePerMinute: 30, ...over });
}

/** Prepared by the manager, approved by the owner through the Approval Center's own decision. */
async function approved(w: Ws, over: Partial<Parameters<typeof createCampaign>[1]> = {}) {
  const { id } = await draft(w, over);
  const p = await previewCampaign(w.manager, { campaignId: id });
  expect(p.problems).toEqual([]);
  const req = await requestCampaignApproval(w.manager, id, { fingerprint: p.fingerprint! });
  const { outcome } = await decideApproval(w.m.ctx("owner"), req.approvalId, "approve");
  expect(outcome?.status, outcome?.detail).toBe("succeeded");
  return { id, approvalId: req.approvalId, fingerprint: p.fingerprint! };
}

const campaignRow = (id: string) => withSystem(async (db) => (await db.query<{ status: string; approved_hash: string | null; counts: Record<string, unknown>; started_at: Date | null; completed_at: Date | null }>("select status, approved_hash, counts, started_at, completed_at from crm_campaigns where id = $1", [id])).rows[0]);
const recipients = (id: string) => withSystem(async (db) => (await db.query<{ contact_id: string; status: string; reason: string | null; message_id: string | null }>("select contact_id, status, reason, message_id from crm_campaign_recipients where campaign_id = $1 order by contact_id", [id])).rows);
const campaignMessages = (orgId: string, id: string) => withSystem(async (db) => (await db.query<{ id: string; dedupe_key: string; author_kind: string; author_user_id: string | null; agent_id: string | null; purpose: string; scope: string; status: string; send_after: Date; reservation_id: string | null; body: string }>(
  "select id, dedupe_key, author_kind, author_user_id, agent_id, purpose, scope, status, send_after, reservation_id, body from conversation_messages where org_id = $1 and dedupe_key like $2 order by created_at", [orgId, `camp:${id}:%`])).rows);
const approvalStatus = (id: string) => withSystem(async (db) => (await db.query<{ status: string }>("select status from approval_requests where id = $1", [id])).rows[0]?.status);
const messageCount = async (orgId: string, id: string) => (await campaignMessages(orgId, id)).length;
/** The sends a recorder saw for one workspace (the dispatcher sends every workspace's due messages). */
const callsFor = (rec: ReturnType<typeof recordingProvider>, orgId: string) => rec.calls.filter((c) => c.orgId === orgId);
/** A date about a month ahead, in the workspace's (UTC) calendar. */
const monthAhead = () => new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

beforeAll(() => {
  for (const k of ENV) process.env[k] = "true";
  resetEnvCache();
});
afterAll(() => {
  for (const k of ENV) delete process.env[k];
  resetEnvCache();
});

// ---------------------------------------------------------------------------
// Preview: who it reaches, who is left out (counts only), what it costs
// ---------------------------------------------------------------------------

// Runs first: rates are published per provider for every workspace, so this is the only point at which Twilio has no published rate.
describe("prices", () => {
  it("are never estimated: without a published rate there is no number", async () => {
    const { estimateCost } = await import("@/server/crm/campaigns/rules");
    const e = await withSystem((db) => estimateCost(db, "sms", "twilio", 1200, 2));
    expect(e).toMatchObject({ provider: "twilio", unit: "sms_segment", units: 2400, rate: null, costMicros: null });
  });

  it("shows no price at all when the provider's rate isn't published, and then it can't be approved", async () => {
    const x = await workspace({ publishNativeRates: false });
    await contact(x.m.org.id, { sms: "granted" });
    const { id } = await draft(x);
    const p = await previewCampaign(x.manager, { campaignId: id });
    expect(p.estimate?.rate).toBeNull();
    expect(p.estimate?.costMicros).toBeNull();
    expect(p.credits?.status).toBe("unknown");
    expect(p.problems.join(" ")).toMatch(/hasn't published a price/);
    expect(p.ready).toBe(false);
    await expectError(requestCampaignApproval(x.manager, id, { fingerprint: p.fingerprint! }), "invalid_input", /published a price/);
  });

});

describe("campaign preview", () => {
  let w: Ws;
  beforeAll(async () => {
    w = await workspace();
  });

  it("counts who it reaches and who is left out, by reason, without naming anyone", async () => {
    await contact(w.m.org.id, { name: "Ana Reyes", sms: "granted" });
    await contact(w.m.org.id, { name: "Ben Cruz" }); // never agreed to marketing
    await contact(w.m.org.id, { name: "Cara Lim", sms: "revoked" });
    await contact(w.m.org.id, { name: "Dan Uy", sms: "granted", suppressSms: true });
    await contact(w.m.org.id, { name: "Eve Tan", phone: null, email: "eve@example.test", sms: "granted" });
    await contact(w.m.org.id, { name: "", firstName: null, sms: "granted" }); // the message needs a first name
    await contact(w.m.org.id, { name: "Gus Ong", sms: "granted", city: "Shelbyville" }); // not on the list
    const { id } = await draft(w);
    const p = await previewCampaign(w.manager, { campaignId: id });
    expect(p.list).toEqual({ name: "Springfield", total: 6 });
    expect(p.eligible).toBe(1);
    expect(Object.fromEntries(p.exclusions.map((e) => [e.reason, e.count]))).toEqual({
      no_marketing_consent: 1, consent_withdrawn: 1, suppressed: 1, no_address: 1, missing_values: 1,
    });
    const text = JSON.stringify(p);
    for (const leak of ["Ana", "Ben", "Cara", "Dan", "Eve", "eve@example.test", "+1555"]) expect(text, leak).not.toContain(leak);
    expect(p.problems).toEqual([]);
    expect(p.ready).toBe(true);
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(reasonLabel("no_marketing_consent", "sms")).toBe("Hasn't agreed to SMS marketing");
  });

  it("prices it only from the provider's published rate", async () => {
    const { id } = await draft(w);
    const p = await previewCampaign(w.manager, { campaignId: id });
    const rate = await withSystem(async (db) => (await db.query<{ c: string; version: number }>(
      "select r.client_micros_per_unit::text as c, v.version from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id where r.provider = 'twilio' and r.unit_type = 'sms_segment' order by v.version desc limit 1",
    )).rows[0]);
    expect(p.estimate).toMatchObject({ provider: "twilio", unit: "sms_segment", messages: p.eligible, unitsPerMessage: 1, rate: { clientMicrosPerUnit: Number(rate.c), version: rate.version } });
    expect(p.estimate!.costMicros).toBe(Math.ceil(Number(rate.c) * p.eligible!));
    expect(p.credits?.status).toBe("enough");
    // People who can't see usage are told whether it's covered, not the balance.
    expect(p.credits?.availableMicros).not.toBeNull();
  });

  it("previews the unsaved form the same way, and reports a bad schedule instead of approving it", async () => {
    const p = await previewCampaign(w.manager, { draft: { channel: "sms", smartListId: w.listId, templateId: w.smsTemplateId, schedule: { mode: "later", date: "2020-01-01", time: "09:00" } } });
    expect(p.ready).toBe(false);
    expect(p.fingerprint).toBeNull();
    expect(p.problems[0]).toMatch(/at least a minute from now/);
    expect(p.list?.total).toBeGreaterThan(0);
  });

  it("refuses marketing texts without opt-out wording, service templates and unapproved wording", async () => {
    const noStop = await createTemplate(w.owner, { name: "No stop", channel: "sms", purpose: "marketing", body: "Hi {{contact.first_name}}, big sale today." });
    await approveTemplate(w.owner, noStop.id, { version: noStop.currentVersion, contentHash: noStop.contentHash });
    const service = await createTemplate(w.owner, { name: "Service", channel: "sms", purpose: "service", body: "Your order is ready. Reply STOP to opt out." });
    await approveTemplate(w.owner, service.id, { version: service.currentVersion, contentHash: service.contentHash });
    const unapproved = await createTemplate(w.owner, { name: "Draft offer", channel: "sms", purpose: "marketing", body: "Offer! Reply STOP to opt out." });
    const problems = async (templateId: string) => (await previewCampaign(w.manager, { draft: { channel: "sms", smartListId: w.listId, templateId } })).problems.join(" ");
    expect(await problems(noStop.id)).toMatch(/Reply STOP to opt out/);
    expect(await problems(service.id)).toMatch(/service template/);
    expect(await problems(unapproved.id)).toMatch(/isn't approved/);
    // A draft can hold it, but it can't go for approval.
    const { id } = await draft(w, { templateId: noStop.id });
    const p = await previewCampaign(w.manager, { campaignId: id });
    await expectError(requestCampaignApproval(w.manager, id, { fingerprint: p.fingerprint ?? "0".repeat(64) }), "invalid_input", /opt out/);
  });

  it("requires the native email provider for email campaigns, so each email carries the one-click unsubscribe", async () => {
    const g = await messagingOrg({}); // every channel on GoHighLevel
    const owner = memberActor(g.ctx("owner"));
    const t = await createTemplate(owner, { name: "News", channel: "email", purpose: "marketing", subject: "News", body: "Hello {{contact.first_name}}. Unsubscribe any time." });
    await approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const list = await createSmartList(owner, { entity: "contact", name: "All", visibility: "team", filter: { op: "and", conditions: [] } });
    const p = await previewCampaign(owner, { draft: { channel: "email", smartListId: list.id, templateId: t.id } });
    expect(p.problems.join(" ")).toMatch(/one-click unsubscribe/);
  });
});

// ---------------------------------------------------------------------------
// Approval bound to a fingerprint
// ---------------------------------------------------------------------------

describe("owner approval", () => {
  let w: Ws;
  beforeAll(async () => {
    w = await workspace();
    await contact(w.m.org.id, { sms: "granted" });
  });

  it("binds the fingerprint to channel, list filter, template version and content, the values the wording uses, schedule and pace", () => {
    const b = {
      channel: "sms" as const, smartListId: "l", filter: { op: "and" as const, conditions: [] }, templateId: "t", templateVersion: 1, templateContentHash: "a".repeat(64), whatsappTemplateId: null, scheduledAt: null, ratePerMinute: 30,
      businessValues: { "business.name": "Acme", "custom_values.offer_link": "https://acme.example/offer" },
    };
    const h = campaignApprovalHash(b);
    expect(campaignApprovalHash({ ...b, businessValues: { "custom_values.offer_link": "https://acme.example/offer", "business.name": "Acme" } })).toBe(h);
    for (const change of [
      { channel: "email" as const }, { smartListId: "m" }, { filter: { op: "or" as const, conditions: [] } }, { templateVersion: 2 }, { templateContentHash: "b".repeat(64) }, { scheduledAt: "2030-01-01T00:00:00.000Z" }, { ratePerMinute: 31 }, { whatsappTemplateId: "x" },
      { businessValues: { ...b.businessValues, "custom_values.offer_link": "https://evil.example/phish" } }, { businessValues: { ...b.businessValues, "business.name": "Acme Ltd" } }, { businessValues: { "business.name": "Acme" } },
    ]) {
      expect(campaignApprovalHash({ ...b, ...change }), JSON.stringify(change)).not.toBe(h);
    }
    expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it("refuses a request for something other than what was shown", async () => {
    const { id } = await draft(w);
    await expectError(requestCampaignApproval(w.manager, id, { fingerprint: "f".repeat(64) }), "conflict", /changed since you looked/);
  });

  it("only the owner decides; the manager's request waits for them", async () => {
    const { id } = await draft(w);
    const p = await previewCampaign(w.manager, { campaignId: id });
    const req = await requestCampaignApproval(w.manager, id, { fingerprint: p.fingerprint! });
    expect(req.status).toBe("requested");
    expect((await getCampaign(w.manager, id)).status).toBe("awaiting_approval");
    expect((await requestCampaignApproval(w.manager, id, { fingerprint: p.fingerprint! })).status).toBe("pending");
    // A manager can decide approvals in general, but not this high-risk one; and can't use the campaign's own approve path.
    await expectError(decideApproval(w.m.ctx("manager"), req.approvalId, "approve"), "forbidden", /owner/);
    await expectError(pendingApprovalFor(w.manager, id, p.fingerprint!), "forbidden");
    expect(await pendingApprovalFor(w.owner, id, p.fingerprint!)).toBe(req.approvalId);
    const { outcome } = await decideApproval(w.m.ctx("owner"), req.approvalId, "approve");
    expect(outcome?.status).toBe("succeeded");
    const c = await getCampaign(w.owner, id);
    expect(c).toMatchObject({ status: "scheduled", approval: "approved", approvedHash: p.fingerprint });
  });

  it("changing anything it covers withdraws the approval and puts it back to draft; renaming doesn't", async () => {
    const a = await approved(w, { schedule: { mode: "later", date: monthAhead(), time: "09:00" } });
    await updateCampaign(w.manager, a.id, { name: "Autumn offer (renamed)" });
    expect((await getCampaign(w.owner, a.id)).status).toBe("scheduled");
    const res = await updateCampaign(w.manager, a.id, { ratePerMinute: 10 });
    expect(res.approvalWithdrawn).toBe(true);
    const c = await getCampaign(w.owner, a.id);
    expect(c).toMatchObject({ status: "draft", approvedHash: null, approval: "withdrawn" });
    expect(c.notice?.code).toBe("approval_void");
    expect(await approvalStatus(a.approvalId)).toBe("cancelled");
    expect((await previewCampaign(w.manager, { campaignId: a.id })).fingerprint).not.toBe(a.fingerprint);
  });

  it("a change to the Smart List's filter after approval voids it before anything is sent", async () => {
    const list = await createSmartList(w.owner, { entity: "contact", name: "Springfield copy", visibility: "team", filter: { op: "and", conditions: [{ field: "city", op: "equals", value: "springfield" }] } });
    const a = await approved(w, { smartListId: list.id });
    await updateSmartList(w.owner, list.id, { filter: { op: "and", conditions: [{ field: "city", op: "equals", value: "shelbyville" }] } });
    await processCampaigns();
    const c = await getCampaign(w.owner, a.id);
    expect(c.status).toBe("draft");
    expect(c.notice?.code).toBe("approval_void");
    expect(c.notice?.detail).toMatch(/Smart List's filter changed/);
    expect(await approvalStatus(a.approvalId)).toBe("cancelled");
    expect(await campaignMessages(w.m.org.id, a.id)).toEqual([]);
    expect(await recipients(a.id)).toEqual([]);
  });

  it("an edited template stops it before it sends a wording the owner didn't approve", async () => {
    const t = await createTemplate(w.owner, { name: "Edited later", channel: "sms", purpose: "marketing", body: "Offer for {{contact.first_name}}. Reply STOP to opt out." });
    await approveTemplate(w.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const a = await approved(w, { templateId: t.id });
    await updateTemplate(w.owner, t.id, { body: "A different offer. Reply STOP to opt out." });
    await processCampaigns();
    const c = await getCampaign(w.owner, a.id);
    expect(c.status).toBe("paused");
    expect(c.notice?.code).toBe("template_changed");
    expect(await campaignMessages(w.m.org.id, a.id)).toEqual([]);
  });

  it("sending back from the Approval Center returns it to draft with the owner's note", async () => {
    const { id } = await draft(w);
    const p = await previewCampaign(w.manager, { campaignId: id });
    const req = await requestCampaignApproval(w.manager, id, { fingerprint: p.fingerprint! });
    await decideApproval(w.m.ctx("owner"), req.approvalId, "request_changes", "Send it on Monday instead.");
    const c = await getCampaign(w.manager, id);
    expect(c).toMatchObject({ status: "draft", approval: "declined" });
    expect(c.notice).toMatchObject({ code: "returned" });
    expect(c.notice?.detail).toContain("Send it on Monday instead.");
  });
});

// ---------------------------------------------------------------------------
// The sending job
// ---------------------------------------------------------------------------

describe("sending", () => {
  it("queues one marketing message per eligible person as the system on the owner's approval, however often the job runs", async () => {
    const w = await workspace();
    const ok1 = await contact(w.m.org.id, { name: "Ana Reyes", sms: "granted" });
    const ok2 = await contact(w.m.org.id, { name: "Bo Santos", sms: "granted" });
    const no = await contact(w.m.org.id, { name: "Cy Lopez" });
    const a = await approved(w);
    const first = await processCampaigns();
    expect(first.started).toBeGreaterThanOrEqual(1);
    expect((await campaignRow(a.id)).status).toBe("sending");
    expect(await messageCount(w.m.org.id, a.id)).toBe(2);
    await processCampaigns();
    await processCampaigns();
    const msgs = await campaignMessages(w.m.org.id, a.id);
    expect(msgs).toHaveLength(2);
    expect(new Set(msgs.map((m) => m.dedupe_key))).toEqual(new Set([`camp:${a.id}:${ok1.id}`, `camp:${a.id}:${ok2.id}`]));
    for (const m of msgs) {
      expect(m).toMatchObject({ author_kind: "system", author_user_id: w.m.people.owner.id, agent_id: null, purpose: "marketing", scope: "retention", status: "queued" });
      expect(m.reservation_id).toBeTruthy();
    }
    expect(msgs.map((m) => m.body).sort()).toEqual([`Hi Ana, 20% off this week at ${w.m.org.name}. Reply STOP to opt out.`, `Hi Bo, 20% off this week at ${w.m.org.name}. Reply STOP to opt out.`]);
    const r = await recipients(a.id);
    expect(r.find((x) => x.contact_id === no.id)).toMatchObject({ status: "excluded", reason: "no_marketing_consent", message_id: null });
    expect(r.filter((x) => x.status === "queued")).toHaveLength(2);

    // The dispatcher sends them; the job reads the result back and completes the campaign, emitting campaign.sent once.
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, limit: 100 });
    expect(callsFor(rec, w.m.org.id)).toHaveLength(2);
    expect(callsFor(rec, w.m.org.id).every((c) => c.body.includes("Reply STOP to opt out."))).toBe(true);
    await processCampaigns();
    await processCampaigns();
    const c = await getCampaign(w.owner, a.id);
    expect(c.status).toBe("completed");
    expect(c.counts).toMatchObject({ total: 3, sent: 2, excluded: 1, pending: 0, queued: 0 });
    const events = await eventsFor(w.m.org.id, "campaign.sent");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity_id: a.id, payload: { recipients: 3, sent: 2, excluded: 1 } });
    // Nothing more is ever sent for it.
    await processCampaigns();
    expect(await campaignMessages(w.m.org.id, a.id)).toHaveLength(2);
  });

  it("re-checks each person when their turn comes: someone who opted out after it started is left out", async () => {
    const w = await workspace();
    const c1 = await contact(w.m.org.id, { sms: "granted" });
    const c2 = await contact(w.m.org.id, { sms: "granted" });
    const a = await approved(w, { ratePerMinute: 1 });
    await processCampaigns(); // starts and queues one
    const queued = (await recipients(a.id)).find((r) => r.status === "queued")!;
    const waiting = queued.contact_id === c1.id ? c2 : c1;
    await withSystem((db) => db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source) values ($1, $2, 'sms', 'marketing', 'revoked', 'stop_keyword')", [w.m.org.id, waiting.id]));
    await dispatchDue({ transport: recordingProvider("twilio").transport });
    await processCampaigns({ now: new Date(Date.now() + 61_000) });
    expect((await recipients(a.id)).find((r) => r.contact_id === waiting.id)).toMatchObject({ status: "excluded", reason: "consent_withdrawn" });
    expect(await campaignMessages(w.m.org.id, a.id)).toHaveLength(1);
  });

  it("never queues more than its pace allows in any minute", async () => {
    const w = await workspace();
    for (let i = 0; i < 5; i += 1) await contact(w.m.org.id, { sms: "granted" });
    const a = await approved(w, { ratePerMinute: 2 });
    const t0 = Date.now();
    const count = () => messageCount(w.m.org.id, a.id);
    await processCampaigns({ now: new Date(t0) });
    expect(await count()).toBe(2);
    await processCampaigns({ now: new Date(t0 + 1_000) });
    expect(await count()).toBe(2);
    await dispatchDue({ transport: recordingProvider("twilio").transport, limit: 100 });
    // Sent, but still within the same minute.
    await processCampaigns({ now: new Date(t0 + 30_000) });
    expect(await count()).toBe(2);
    await processCampaigns({ now: new Date(t0 + 61_000) });
    expect(await count()).toBe(4);
    // A backlog the dispatcher hasn't sent holds the next batch back too.
    await processCampaigns({ now: new Date(t0 + 125_000) });
    expect(await count()).toBe(4);
    await dispatchDue({ transport: recordingProvider("twilio").transport, limit: 100, now: new Date(t0 + 125_000) });
    await processCampaigns({ now: new Date(t0 + 125_000) });
    expect(await count()).toBe(5);
  });

  it("waits through quiet hours without queuing anyone, then continues", async () => {
    const w = await workspace();
    await contact(w.m.org.id, { sms: "granted" });
    await contact(w.m.org.id, { sms: "granted" });
    const a = await approved(w);
    const day = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '02:00', quiet_hours_end = '04:00'"));
    try {
      const at3 = new Date(`${day}T03:00:00.000Z`);
      await processCampaigns({ now: at3 });
      expect(await campaignMessages(w.m.org.id, a.id)).toEqual([]);
      const c = await campaignRow(a.id);
      expect(c.status).toBe("sending");
      expect(c.counts.waitUntil).toBe(`${day}T04:00:00.000Z`);
      expect((await recipients(a.id)).some((x) => x.reason?.startsWith("waiting:quiet_hours|"))).toBe(true);
      // Still quiet: the campaign isn't even looked at.
      await processCampaigns({ now: new Date(`${day}T03:30:00.000Z`) });
      expect(await messageCount(w.m.org.id, a.id)).toBe(0);
      await processCampaigns({ now: new Date(`${day}T04:01:00.000Z`) });
      expect(await messageCount(w.m.org.id, a.id)).toBe(2);
    } finally {
      await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
    }
  });

  it("stops by itself with a clear reason when credits run out, and owners are told", async () => {
    const w = await workspace();
    for (let i = 0; i < 3; i += 1) await contact(w.m.org.id, { sms: "granted" });
    const a = await approved(w);
    const rate = await withSystem(async (db) => Number((await db.query<{ c: string }>("select r.client_micros_per_unit::text as c from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id where r.provider = 'twilio' and r.unit_type = 'sms_segment' order by v.version desc limit 1")).rows[0].c));
    // Leave credit for one message and a half.
    await withSystem(async (db) => {
      const bal = Number((await db.query<{ b: string }>("select balance_micros::text as b from credit_accounts where org_id = $1", [w.m.org.id])).rows[0].b);
      await adjustCredits(db, { orgId: w.m.org.id, deltaMicros: -(bal - Math.floor(rate * 1.5)), reason: "test: nearly out of credit", userId: w.m.people.owner.id });
    });
    await processCampaigns();
    const c = await getCampaign(w.owner, a.id);
    expect(c.status).toBe("paused");
    expect(c.notice?.code).toBe("credits");
    expect(c.notice?.detail).toMatch(/credits ran out/);
    expect(await campaignMessages(w.m.org.id, a.id)).toHaveLength(1);
    expect((await recipients(a.id)).filter((x) => x.status === "pending")).toHaveLength(2);
    const notes = await withSystem(async (db) => (await db.query<{ kind: string }>("select kind from notifications where org_id = $1 and link = $2", [w.m.org.id, `/crm/campaigns/${a.id}`])).rows);
    expect(notes.some((n) => n.kind === "billing_credits_exhausted")).toBe(true);
    // Nothing more is queued while it is stopped.
    await processCampaigns({ now: new Date(Date.now() + 120_000) });
    expect(await campaignMessages(w.m.org.id, a.id)).toHaveLength(1);
  });

  it("a workspace pause holds the campaign and what it queued, and it continues by itself when lifted", async () => {
    const w = await workspace();
    await contact(w.m.org.id, { sms: "granted" });
    await contact(w.m.org.id, { sms: "granted" });
    const a = await approved(w, { ratePerMinute: 1 });
    await processCampaigns();
    expect(await messageCount(w.m.org.id, a.id)).toBe(1);
    await setClientPause(w.m.ctx("owner"), { scope: "outbound", paused: true, reason: "Checking a complaint" });
    await processCampaigns({ now: new Date(Date.now() + 61_000) });
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, limit: 100 });
    expect(callsFor(rec, w.m.org.id)).toHaveLength(0);
    expect(await messageCount(w.m.org.id, a.id)).toBe(1);
    const paused = await getCampaign(w.owner, a.id);
    expect(paused.status).toBe("sending");
    expect(paused.notice?.code).toBe("workspace_paused");
    await setClientPause(w.m.ctx("owner"), { scope: "outbound", paused: false });
    const later = new Date(Date.now() + 10 * 60_000);
    await processCampaigns({ now: later });
    await dispatchDue({ transport: rec.transport, limit: 100, now: later });
    expect(callsFor(rec, w.m.org.id).length).toBeGreaterThanOrEqual(1);
    expect((await getCampaign(w.owner, a.id)).notice).toBeNull();
  });

  it("marketing email carries the one-click unsubscribe link and goes in a thread with the campaign's subject", async () => {
    const w = await workspace();
    const t = await createTemplate(w.owner, { name: "Newsletter", channel: "email", purpose: "marketing", subject: "News for {{contact.first_name}}", body: "Hello {{contact.first_name}}, here is our autumn news. Unsubscribe any time." });
    await approveTemplate(w.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const person = await contact(w.m.org.id, { name: "Lea Moreno", phone: null, email: `lea-${seq}@example.test`, email_consent: "granted" });
    const a = await approved(w, { channel: "email", templateId: t.id });
    await processCampaigns();
    const rec = recordingProvider("resend");
    await dispatchDue({ transport: rec.transport, limit: 100 });
    const [sent] = callsFor(rec, w.m.org.id);
    expect(sent.to).toBe(person.email);
    expect(sent.subject).toBe("News for Lea");
    expect(sent.unsubscribeUrl).toMatch(/unsubscribe/);
    const conv = await withSystem(async (db) => (await db.query<{ thread_key: string }>("select thread_key from conversations where org_id = $1 and contact_id = $2 and channel = 'email'", [w.m.org.id, person.id])).rows);
    expect(conv.map((c) => c.thread_key)).toEqual([`campaign:${a.id}`]);
  });

  it("WhatsApp campaigns need a linked, Meta-approved marketing template", async () => {
    const w = await workspace();
    const t = await createTemplate(w.owner, { name: "WA offer", channel: "whatsapp", purpose: "marketing", body: "Hi {{contact.first_name}}, our autumn offer is here." });
    await approveTemplate(w.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const p = await previewCampaign(w.manager, { draft: { channel: "whatsapp", smartListId: w.listId, templateId: t.id } });
    expect(p.problems.join(" ")).toMatch(/template Meta approved/);
  });

  it("records delivery, bounces and unsubscribes from the provider's events and consent history", async () => {
    const w = await workspace();
    const people = [await contact(w.m.org.id, { sms: "granted" }), await contact(w.m.org.id, { sms: "granted" }), await contact(w.m.org.id, { sms: "granted" })];
    const a = await approved(w);
    await processCampaigns();
    await dispatchDue({ transport: recordingProvider("twilio").transport });
    const byContact = new Map((await recipients(a.id)).map((r) => [r.contact_id, r.message_id!]));
    await withSystem(async (db) => {
      await applyDeliveryEventForMessage(db, { messageId: byContact.get(people[0].id)!, provider: "twilio", providerEventId: `ev-${a.id}-1`, status: "delivered" });
      await applyDeliveryEventForMessage(db, { messageId: byContact.get(people[1].id)!, provider: "twilio", providerEventId: `ev-${a.id}-2`, status: "undelivered", suppress: "invalid", detail: "Unknown destination" });
      await db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source) values ($1, $2, 'sms', 'marketing', 'revoked', 'stop_keyword')", [w.m.org.id, people[2].id]);
    });
    await processCampaigns();
    const r = new Map((await recipients(a.id)).map((x) => [x.contact_id, x]));
    expect(r.get(people[0].id)).toMatchObject({ status: "delivered" });
    expect(r.get(people[1].id)).toMatchObject({ status: "bounced", reason: "bounce" });
    expect(r.get(people[2].id)).toMatchObject({ status: "unsubscribed" });
    const page = await listCampaignRecipients(w.owner, a.id, { status: "bounced" });
    expect(page.total).toBe(1);
    expect(page.rows[0].name).toBe("Pat Example");
  });
});

// ---------------------------------------------------------------------------
// Pause, resume, cancel
// ---------------------------------------------------------------------------

describe("pause, resume and cancel", () => {
  it("pausing holds what it queued, only the owner resumes, and cancelling stops the rest", async () => {
    const w = await workspace();
    for (let i = 0; i < 3; i += 1) await contact(w.m.org.id, { sms: "granted" });
    const a = await approved(w, { ratePerMinute: 1 });
    await processCampaigns();
    const [m1] = await campaignMessages(w.m.org.id, a.id);
    expect(m1.status).toBe("queued");

    expect((await pauseCampaign(w.manager, a.id)).held).toBe(1);
    const held = (await campaignMessages(w.m.org.id, a.id))[0];
    expect(new Date(held.send_after).getUTCFullYear()).toBe(9999);
    expect(await withSystem(async (db) => (await db.query<{ status: string }>("select status from usage_reservations where id = $1", [m1.reservation_id])).rows[0].status)).not.toBe("held");
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, limit: 100 });
    expect(callsFor(rec, w.m.org.id)).toHaveLength(0);
    await processCampaigns({ now: new Date(Date.now() + 61_000) });
    expect(await campaignMessages(w.m.org.id, a.id)).toHaveLength(1);
    expect((await getCampaign(w.owner, a.id)).notice?.code).toBe("paused");

    await expectError(resumeCampaign(w.manager, a.id), "forbidden", /owner/);
    expect((await resumeCampaign(w.owner, a.id)).status).toBe("sending");
    await dispatchDue({ transport: rec.transport, limit: 100 });
    expect(callsFor(rec, w.m.org.id)).toHaveLength(1);
    await processCampaigns({ now: new Date(Date.now() + 61_000) });
    expect(await campaignMessages(w.m.org.id, a.id)).toHaveLength(2);

    const res = await cancelCampaign(w.manager, a.id);
    expect(res.stopped).toBe(1);
    const c = await getCampaign(w.owner, a.id);
    expect(c.status).toBe("cancelled");
    const r = await recipients(a.id);
    expect(r.filter((x) => x.reason === "campaign_cancelled")).toHaveLength(2);
    expect((await campaignMessages(w.m.org.id, a.id)).filter((m) => m.status === "blocked")).toHaveLength(1);
    await dispatchDue({ transport: rec.transport, limit: 100 });
    expect(callsFor(rec, w.m.org.id)).toHaveLength(1);
    await expectError(resumeCampaign(w.owner, a.id), "conflict");
    await expectError(cancelCampaign(w.manager, a.id), "conflict");
  });

  it("a campaign paused before it starts resumes to its schedule, and a changed list then voids it", async () => {
    const w = await workspace();
    await contact(w.m.org.id, { sms: "granted" });
    const list = await createSmartList(w.owner, { entity: "contact", name: "Later", visibility: "team", filter: { op: "and", conditions: [{ field: "city", op: "equals", value: "springfield" }] } });
    const a = await approved(w, { smartListId: list.id, schedule: { mode: "later", date: monthAhead(), time: "09:00" } });
    await pauseCampaign(w.manager, a.id);
    expect((await resumeCampaign(w.owner, a.id)).status).toBe("scheduled");
    await pauseCampaign(w.manager, a.id);
    await updateSmartList(w.owner, list.id, { filter: { op: "and", conditions: [{ field: "city", op: "equals", value: "elsewhere" }] } });
    await expectError(resumeCampaign(w.owner, a.id), "conflict", /back to draft/);
    expect((await getCampaign(w.owner, a.id)).status).toBe("draft");
    expect(await approvalStatus(a.approvalId)).toBe("cancelled");
  });

  it("discarding a draft or an awaiting campaign withdraws its request", async () => {
    const w = await workspace();
    await contact(w.m.org.id, { sms: "granted" });
    const { id } = await draft(w);
    const p = await previewCampaign(w.manager, { campaignId: id });
    const req = await requestCampaignApproval(w.manager, id, { fingerprint: p.fingerprint! });
    await cancelCampaign(w.manager, id);
    expect(await approvalStatus(req.approvalId)).toBe("cancelled");
    expect((await getCampaign(w.manager, id)).status).toBe("cancelled");
    await expectError(updateCampaign(w.manager, id, { name: "x" }), "conflict");
    const copy = await duplicateCampaign(w.manager, id);
    expect((await getCampaign(w.manager, copy.id)).status).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// Who may do what, and tenant isolation
// ---------------------------------------------------------------------------

describe("permissions and isolation", () => {
  let w: Ws;
  let other: Ws;
  let id: string;
  beforeAll(async () => {
    w = await workspace();
    other = await workspace();
    await contact(w.m.org.id, { sms: "granted" });
    ({ id } = await draft(w));
  });

  it("viewers and sales reps can't see, create or send campaigns", async () => {
    for (const who of [w.viewer, w.sales]) {
      await expectError(listCampaigns(who), "forbidden");
      await expectError(createCampaign(who, { name: "x", channel: "sms" }), "forbidden");
      await expectError(getCampaign(who, id), "forbidden");
      await expectError(previewCampaign(who, { campaignId: id }), "forbidden");
      await expectError(requestCampaignApproval(who, id, { fingerprint: "a".repeat(64) }), "forbidden");
      await expectError(resumeCampaign(who, id), "forbidden");
      await expectError(pauseCampaign(who, id), "forbidden");
      await expectError(cancelCampaign(who, id), "forbidden");
      await expectError(campaignBuilderOptions(who), "forbidden");
      // Row-level security agrees.
      const rows = await withUser(who.userId!, (db) => db.query("select id from crm_campaigns where org_id = $1", [w.m.org.id]));
      expect(rows.rows).toHaveLength(0);
    }
    // The manager prepares but doesn't send.
    await expectError(resumeCampaign(w.manager, id), "forbidden");
  });

  it("iAcquire support sessions don't include campaigns", async () => {
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, w.m.org.id, { mode: "write", reason: "Checking the CRM setup" });
    const agency = await agencyActor(superAdmin, w.m.org.id);
    await expectError(listCampaigns(agency), "forbidden");
    await expectError(createCampaign(agency, { name: "x", channel: "sms" }), "forbidden");
  });

  it("another workspace can't read, preview, change or reuse this one's campaign, list or template", async () => {
    await expectError(getCampaign(other.owner, id), "not_found");
    await expectError(previewCampaign(other.owner, { campaignId: id }), "not_found");
    await expectError(updateCampaign(other.manager, id, { name: "hijack" }), "not_found");
    await expectError(cancelCampaign(other.manager, id), "not_found");
    await expectError(pauseCampaign(other.manager, id), "not_found");
    await expectError(listCampaignRecipients(other.owner, id), "not_found");
    await expectError(testableTemplate(other.owner, id), "not_found");
    expect((await listCampaigns(other.owner)).some((c) => c.id === id)).toBe(false);
    await expectError(createCampaign(other.manager, { name: "x", channel: "sms", smartListId: w.listId }), "invalid_input", /no longer exists/);
    await expectError(createCampaign(other.manager, { name: "x", channel: "sms", templateId: w.smsTemplateId }), "invalid_input", /no longer exists/);
    const rls = await withUser(other.m.people.owner.id, (db) => db.query("select id from crm_campaigns where id = $1", [id]));
    expect(rls.rows).toHaveLength(0);
    // A draft preview naming the other workspace's list sees nothing of it.
    const p = await previewCampaign(other.manager, { draft: { channel: "sms", smartListId: w.listId, templateId: w.smsTemplateId } });
    expect(p.list).toBeNull();
    expect(p.problems.join(" ")).toMatch(/no longer exists|isn't approved|Choose the message/);
  });

  it("only offers the person's own or team Smart Lists", async () => {
    const mine = await createSmartList(w.manager, { entity: "contact", name: "Manager only", visibility: "private", filter: { op: "and", conditions: [] } });
    const opts = await campaignBuilderOptions(w.owner);
    expect(opts.lists.some((l) => l.id === mine.id)).toBe(false);
    await expectError(createCampaign(w.owner, { name: "x", channel: "sms", smartListId: mine.id }), "invalid_input", /private to someone else/);
    expect((await campaignBuilderOptions(w.manager)).lists.some((l) => l.id === mine.id)).toBe(true);
    // A campaign the manager built on their own list keeps it when the owner renames it, and the owner sees its name to approve it.
    const { id: privateDraft } = await createCampaign(w.manager, { name: "Private list", channel: "sms", smartListId: mine.id, templateId: w.smsTemplateId });
    await updateCampaign(w.owner, privateDraft, { name: "Renamed by the owner" });
    const c = await getCampaign(w.owner, privateDraft);
    expect(c.list).toEqual({ id: mine.id, name: "Manager only" });
    expect(c.name).toBe("Renamed by the owner");
  });

  it("moves to a template's newer approved version only when asked, and that needs approving again", async () => {
    const t = await createTemplate(w.owner, { name: "Versioned", channel: "sms", purpose: "marketing", body: "First offer. Reply STOP to opt out." });
    await approveTemplate(w.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const a = await approved(w, { templateId: t.id, schedule: { mode: "later", date: monthAhead(), time: "10:00" } });
    const v2 = (await updateTemplate(w.owner, t.id, { body: "Second offer. Reply STOP to opt out." })).template;
    await approveTemplate(w.owner, t.id, { version: v2.currentVersion, contentHash: v2.contentHash });
    await updateCampaign(w.manager, a.id, { name: "Still v1" });
    expect((await getCampaign(w.owner, a.id))).toMatchObject({ status: "scheduled", templateVersion: 1 });
    const res = await updateCampaign(w.manager, a.id, { templateId: t.id });
    expect(res.approvalWithdrawn).toBe(true);
    expect((await getCampaign(w.owner, a.id))).toMatchObject({ status: "draft", templateVersion: 2 });
  });
});

// ---------------------------------------------------------------------------
// Wiring and screens
// ---------------------------------------------------------------------------

describe("wiring and screens", () => {
  it("runs between the workflow runs and the dispatcher, and is in the CRM navigation for people who prepare campaigns", () => {
    const names = JOBS.map((j) => j.name);
    expect(names).toContain("crmCampaigns");
    expect(names.indexOf("crmCampaigns")).toBeGreaterThan(names.indexOf("crmWorkflowRuns"));
    expect(names.indexOf("crmCampaigns")).toBeLessThan(names.indexOf("messagesDispatched"));
    const item = CRM_NAV.flatMap((s) => s.items).find((i) => i.path === "/campaigns");
    expect(item).toMatchObject({ permission: "campaigns.manage" });
  });

  it("renders the list and a campaign's builder and progress", async () => {
    const w = await workspace();
    await contact(w.m.org.id, { name: "Ana Reyes", sms: "granted" });
    const a = await approved(w);
    const { id: draftId } = await draft(w, { name: "Spring draft" });
    const scope: CrmScope = { base: "/crm", orgId: null, agency: false, readOnly: false, userId: w.m.people.owner.id, timezone: "UTC", currency: "USD", can: { "campaigns.manage": true, "campaigns.send": true, "contacts.view": true, "inbox.view": true } };
    const list = renderToStaticMarkup(React.createElement(CampaignsList, { scope, campaigns: await listCampaigns(w.owner), canManage: true, initialFilter: "" }));
    expect(list).toContain("Spring draft");
    expect(list).toContain("only reach people who agreed to receive marketing");
    // The filter tiles are toggle buttons with plain text: never buttons inside a <dl> or <dt>/<dd> inside a button (invalid lists).
    const tiles = /<div role="group" aria-label="Show campaigns"[^>]*>([\s\S]*?)<\/div>/.exec(list)?.[1] ?? "";
    expect(tiles.match(/<button[^>]*aria-pressed/g)).toHaveLength(4);
    expect(tiles).toMatch(/<button[^>]*>.*Drafts.*<\/button>/);
    expect(list).not.toMatch(/<dl[^>]*>\s*<button/);
    expect(list).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<d[td][\s>]/);

    const d = await getCampaign(w.owner, draftId);
    const filterOptions = { tags: [], members: [], pipelines: [], customFields: [] };
    const builder = renderToStaticMarkup(React.createElement(CampaignWorkspace, {
      scope, campaign: JSON.parse(JSON.stringify(d)), options: await campaignBuilderOptions(w.owner), filterOptions, preview: await previewCampaign(w.owner, { campaignId: draftId }),
      recipients: null, recipientFilter: "all", testDestinations: [], listFilter: null,
    }));
    expect(builder).toContain("Who it reaches");
    expect(builder).toContain("Approve and schedule");
    expect(builder).not.toContain("Ana Reyes");

    await processCampaigns();
    await dispatchDue({ transport: recordingProvider("twilio").transport });
    await processCampaigns();
    const s = await getCampaign(w.owner, a.id);
    const progress = renderToStaticMarkup(React.createElement(CampaignWorkspace, {
      scope, campaign: JSON.parse(JSON.stringify(s)), options: null, filterOptions, preview: null, recipients: await listCampaignRecipients(w.owner, a.id), recipientFilter: "all", testDestinations: [], listFilter: null,
    }));
    expect(progress).toContain("Delivery log");
    expect(progress).toContain("Ana Reyes");
  });
});

// ---------------------------------------------------------------------------
// Configuration values ({{custom_values.<key>}}) in campaign messages
// ---------------------------------------------------------------------------

describe("configuration values in campaign messages", () => {
  it("are measured with their real value, and an empty required one blocks approval and stops sending with a clear reason", async () => {
    const w = await workspace();
    await contact(w.m.org.id, { name: "Ana Reyes", sms: "granted" });
    const code = `AUTUMN-${"X".repeat(110)}`;
    const v = await createCustomValue(w.owner, { key: "promo_code", label: "Promo code", value: code, required: true });
    const t = await createTemplate(w.owner, { name: "Promo", channel: "sms", purpose: "marketing", body: "Hi {{contact.first_name}}, use code {{custom_values.promo_code}} this week. Reply STOP to opt out." });
    await approveTemplate(w.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });

    // The estimate renders the business's own value: about 170 characters, so two SMS segments (its label alone would fit in one).
    const { id } = await draft(w, { name: "Promo", templateId: t.id });
    const p = await previewCampaign(w.manager, { campaignId: id });
    expect(p.problems).toEqual([]);
    expect(p.estimate?.unitsPerMessage).toBe(2);
    expect(p.message?.sampleBody).toContain(code);

    // Emptied: nothing can go for approval, and the reason names the value and where to fill it in.
    await updateCustomValue(w.owner, v.id, { value: "" });
    const blocked = await previewCampaign(w.manager, { campaignId: id });
    expect(blocked.ready).toBe(false);
    expect(blocked.problems.join(" ")).toMatch(/your “Promo code” configuration value/);
    expect(blocked.problems.join(" ")).toMatch(/CRM Settings → Configuration Values/);
    await expectError(requestCampaignApproval(w.manager, id, { fingerprint: p.fingerprint! }), "invalid_input", /Promo code/);

    // Approved while filled, then emptied before it starts: the value it was approved with changed, so the approval is void and nothing is sent.
    await updateCustomValue(w.owner, v.id, { value: code });
    const a = await approved(w, { name: "Promo again", templateId: t.id });
    await updateCustomValue(w.owner, v.id, { value: "" });
    await processCampaigns();
    const c = await getCampaign(w.owner, a.id);
    expect(c.status).toBe("draft");
    expect(c.notice).toMatchObject({ code: "approval_void" });
    expect(c.notice?.detail).toMatch(/“Promo code” configuration value changed after the owner approved it/);
    expect(await approvalStatus(a.approvalId)).toBe("cancelled");
    expect(await messageCount(w.m.org.id, a.id)).toBe(0);

    // Started, and then emptied: it stops with the reason (holding nothing back that was approved), and the screen says where to look.
    await updateCustomValue(w.owner, v.id, { value: "AUTUMN26" });
    await contact(w.m.org.id, { name: "Bo Santos", sms: "granted" });
    const s = await approved(w, { name: "Promo started", templateId: t.id, ratePerMinute: 1 });
    await processCampaigns();
    expect(await messageCount(w.m.org.id, s.id)).toBe(1);
    await dispatchDue({ transport: recordingProvider("twilio").transport, limit: 100 });
    await updateCustomValue(w.owner, v.id, { value: "" });
    await processCampaigns({ now: new Date(Date.now() + 2 * 60_000) });
    const stopped = await getCampaign(w.owner, s.id);
    expect(stopped.status).toBe("paused");
    expect(stopped.notice?.code).toBe("approval_void");
    expect(stopped.notice?.detail).toMatch(/“Promo code” configuration value changed after the owner approved this campaign/);
    expect(await messageCount(w.m.org.id, s.id)).toBe(1);
    const scope: CrmScope = { base: "/crm", orgId: null, agency: false, readOnly: false, userId: w.m.people.owner.id, timezone: "UTC", currency: "USD", can: { "campaigns.manage": true, "campaigns.send": true, "contacts.view": true } };
    const html = renderToStaticMarkup(React.createElement(CampaignWorkspace, {
      scope, campaign: JSON.parse(JSON.stringify(stopped)), options: null, filterOptions: { tags: [], members: [], pipelines: [], customFields: [] }, preview: null, recipients: null, recipientFilter: "all", testDestinations: [], listFilter: null,
    }));
    expect(html).toContain("Promo code");
    // Filled in again (even with the approved value) it can't simply be resumed: the approval was withdrawn.
    await updateCustomValue(w.owner, v.id, { value: "AUTUMN26" });
    await expectError(resumeCampaign(w.owner, s.id), "conflict", /no longer stands/);
    await processCampaigns({ now: new Date(Date.now() + 4 * 60_000) });
    expect(await messageCount(w.m.org.id, s.id)).toBe(1);
  });

  it("are part of what the owner approves: a value changed after approval is never sent under it", async () => {
    // The review's case: the manager prepares a campaign with a link value, the owner approves it, the manager changes the link.
    const w = await workspace();
    await contact(w.m.org.id, { name: "Ana Reyes", sms: "granted" });
    await contact(w.m.org.id, { name: "Bo Santos", sms: "granted" });
    const v = await createCustomValue(w.owner, { key: "offer_link", label: "Offer link", type: "url", value: "https://acme.example/offer" });
    const t = await createTemplate(w.owner, { name: "Offer link", channel: "sms", purpose: "marketing", body: "Hi {{contact.first_name}}, see {{custom_values.offer_link}}. Reply STOP to opt out." });
    await approveTemplate(w.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });

    // Before it starts: back to draft, the approval withdrawn, nothing sent.
    const a = await approved(w, { name: "Offer", templateId: t.id });
    await updateCustomValue(w.manager, v.id, { value: "https://evil.example/phish" });
    await processCampaigns();
    const c = await getCampaign(w.owner, a.id);
    expect(c).toMatchObject({ status: "draft", approval: "withdrawn" });
    expect(c.notice?.detail).toMatch(/“Offer link” configuration value changed/);
    expect(await approvalStatus(a.approvalId)).toBe("cancelled");
    expect(await campaignMessages(w.m.org.id, a.id)).toEqual([]);

    // While a request waits for the owner: approving it now refuses, because the fingerprint covered the old value.
    await updateCustomValue(w.manager, v.id, { value: "https://acme.example/offer" });
    const { id } = await draft(w, { name: "Offer 2", templateId: t.id });
    const p = await previewCampaign(w.manager, { campaignId: id });
    const req = await requestCampaignApproval(w.manager, id, { fingerprint: p.fingerprint! });
    await updateCustomValue(w.manager, v.id, { value: "https://evil.example/phish" });
    const { outcome } = await decideApproval(w.m.ctx("owner"), req.approvalId, "approve");
    expect(outcome?.status).toBe("blocked");
    expect(outcome?.detail).toMatch(/“Offer link” configuration value changed/);
    expect((await getCampaign(w.owner, id)).status).toBe("draft");

    // After it started: the next message isn't queued with the new value; the campaign stops and the approval is withdrawn.
    await updateCustomValue(w.manager, v.id, { value: "https://acme.example/offer" });
    const s = await approved(w, { name: "Offer 3", templateId: t.id, ratePerMinute: 1 });
    await processCampaigns();
    expect((await campaignMessages(w.m.org.id, s.id)).map((m) => m.body)).toEqual([expect.stringContaining("https://acme.example/offer")]);
    // The first one leaves, so the pace would allow the next one now.
    await dispatchDue({ transport: recordingProvider("twilio").transport, limit: 100 });
    await updateCustomValue(w.manager, v.id, { value: "https://evil.example/phish" });
    await processCampaigns({ now: new Date(Date.now() + 2 * 60_000) });
    const msgs = await campaignMessages(w.m.org.id, s.id);
    expect(msgs).toHaveLength(1);
    expect(msgs.some((m) => m.body.includes("evil.example"))).toBe(false);
    expect((await getCampaign(w.owner, s.id))).toMatchObject({ status: "paused", approval: "withdrawn" });
    expect(await approvalStatus(s.approvalId)).toBe("cancelled");
    await expectError(resumeCampaign(w.owner, s.id), "conflict", /no longer stands/);

    // A business detail the wording uses (the business name) is bound the same way.
    await updateCustomValue(w.manager, v.id, { value: "https://acme.example/offer" });
    const named = await approved(w, { name: "Autumn by name" });
    await withSystem((db) => db.query("update organizations set name = $2 where id = $1", [w.m.org.id, `${w.m.org.name} (renamed)`]));
    await processCampaigns();
    const n = await getCampaign(w.owner, named.id);
    expect(n.status).toBe("draft");
    expect(n.notice?.detail).toMatch(/your business name changed/i);
    expect(await campaignMessages(w.m.org.id, named.id)).toEqual([]);
  });
});
