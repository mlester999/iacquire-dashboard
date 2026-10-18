// Phase 5 integration: the growth events (campaign.sent, review.requested, feedback.received, call.completed, form.submitted) as workflow
// triggers and outbound webhook events, {{review.link}} in template previews, configuration values in a workflow's own texts, the contact
// profile's "Request a review" action, the shared-template form check and the native copy on /analytics and /overview. Synthetic
// workspaces only: webhook deliveries go to a recording double, DNS answers are mocked, and no message is sent anywhere.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} }), usePathname: () => "/crm/contacts", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm", async (original) => Object.fromEntries(Object.keys(await original<Record<string, unknown>>()).map((k) => [k, stub])));
vi.mock("@/app/actions/crm-calls", async (original) => Object.fromEntries(Object.keys(await original<Record<string, unknown>>()).map((k) => [k, stub])));

import { withSystem } from "@/server/db";
import { hostResolver } from "@/server/calendars/adapters/http";
import { pinnedHttps } from "@/server/security/pinned-https";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { emitEvent } from "@/server/crm/events";
import { createContact, getContactDetail } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { createTag } from "@/server/crm/tags";
import { logCall } from "@/server/crm/calls";
import { createCustomValue } from "@/server/crm/custom-values";
import { cannedRepliesForConversation, createCannedReply, createTemplate, previewTemplate, previewValues, tokenValuesFor } from "@/server/crm/message-templates";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { loadValidationContext } from "@/server/crm/workflows/context";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { createWebhookSubscription, deliverDueWebhooks, isWebhookEventType, WEBHOOK_EVENTS, webhookEventPermissions } from "@/server/crm/webhooks";
import { FINAL_CALL_STATUSES } from "@/server/integrations/voice/types";
import { checkTemplate } from "@/server/websites/templates";
import { siteReadiness } from "@/server/websites/service";
import { createForm, publishForm } from "@/server/crm/forms/definitions";
import { scopeFor } from "@/server/crm/page";
import {
  CALL_TRIGGER_STATUSES, EVENT_TRIGGER_TYPES, TRIGGERS, validateDefinition, validationContextFrom, type WorkflowDefinition, type WorkflowStep,
} from "@/lib/crm/workflow/spec";
import { anyTokenLabel, emptyRequiredValues, renderTemplate, REVIEW_LINK_PREVIEW, sampleTokenValues } from "@/lib/messaging/tokens";
import { ALL_TEMPLATE_KEYS, buildSite } from "@/lib/website/templates/index";
import { eachElement, isRef, type Section, type SiteContent } from "@/lib/website/doc";
import { checkReadiness } from "@/lib/website/lint";
import { formKeysIn } from "@/lib/crm/forms/website";
import { newElement } from "@/lib/website/editor/library";
import { insertElement } from "@/lib/website/ops";
import { namesFrom, triggerSummary } from "@/components/crm/workflows/summaries";
import { ContactProfile } from "@/components/crm/contact-profile";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { TooltipProvider } from "@/components/ui/overlays";
import { agencyPeople, crmOrg, eventsFor, type CrmOrg } from "./support/crm";

const all = async <T>(sql: string, params: unknown[]): Promise<T[]> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows as T[];
const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await all<T>(sql, params))[0];
const uid = () => crypto.randomUUID().slice(0, 8);
let seq = 0;
const phone = () => `+1555${String(3000000 + (seq += 1) * 41 + Math.floor(Math.random() * 1000)).padStart(7, "0")}`;
const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null) => ({ key, kind, config, next }) as WorkflowStep;
const EMPTY_CTX = { tags: [], users: [], pipelines: [], fields: [], templates: [], n8nMappings: [], webhookSubscriptions: [], assignmentRules: [], agents: [], calendars: [], appointmentTypes: [] };

/** Publishes and switches on a workflow that only acts inside the CRM (no owner approval needed). */
async function liveWorkflow(o: CrmOrg, name: string, definition: WorkflowDefinition) {
  const owner = o.actor("owner");
  const { id } = await createWorkflow(owner, { name, definition });
  const published = await publishWorkflow(owner, id);
  expect(published.needsApproval).toBe(false);
  await setWorkflowStatus(owner, id, "active");
  return id;
}

/** Hands every pending event to the workflows (and webhooks) and runs what they started, until nothing is left. */
async function settle() {
  for (let i = 0; i < 12; i += 1) {
    const d = await crmEventDispatch({ now: new Date() });
    const r = await processWorkflowRuns({ now: new Date() });
    if (!d.claimed && !r.claimed && !r.scheduled) break;
  }
}

const runsOf = (workflowId: string) => all<{ contact_id: string | null; opportunity_id: string | null; status: string }>("select contact_id, opportunity_id, status from crm_workflow_runs where workflow_id = $1 order by created_at", [workflowId]);

let a: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Growth Co" });
});

// ---------------------------------------------------------------------------
// The workflow trigger catalog
// ---------------------------------------------------------------------------

describe("growth events as workflow triggers", () => {
  it("lists every growth event the CRM emits, in the Growth group, with honest filters", () => {
    for (const t of ["form.submitted", "campaign.sent", "review.requested", "feedback.received", "call.completed"] as const) expect(EVENT_TRIGGER_TYPES).toContain(t);
    expect(TRIGGERS["campaign.sent"]).toMatchObject({ group: "Growth", entity: "none", carries: { contact: "never", opportunity: "never" }, filters: ["channels"] });
    expect(TRIGGERS["review.requested"]).toMatchObject({ group: "Growth", entity: "contact", carries: { contact: "always", opportunity: "maybe" }, filters: ["channels"] });
    expect(TRIGGERS["call.completed"]).toMatchObject({ group: "Growth", carries: { contact: "maybe", opportunity: "never" }, filters: ["callStatuses", "callDirections"] });
    // No rating filter: a workflow can't single out happy customers for public reviews.
    expect(TRIGGERS["feedback.received"]).toMatchObject({ group: "Growth", carries: { contact: "always", opportunity: "never" }, filters: [] });
    expect([...CALL_TRIGGER_STATUSES]).toEqual([...FINAL_CALL_STATUSES]);

    const end = [step("end", "end", {})];
    const codes = (d: unknown) => validateDefinition(d, validationContextFrom(EMPTY_CTX)).map((i) => i.code);
    expect(codes({ trigger: { type: "feedback.received", filters: { ratings: [5] } }, steps: end })).toContain("invalid_trigger");
    expect(codes({ trigger: { type: "feedback.received", filters: { channels: ["sms"] } }, steps: end })).toContain("invalid_trigger");
    expect(codes({ trigger: { type: "contact.created", filters: { callStatuses: ["no_answer"] } }, steps: end })).toContain("invalid_trigger");
    expect(codes({ trigger: { type: "call.completed", filters: { callStatuses: ["ringing"] } }, steps: end })).toContain("invalid_trigger");
    expect(codes({ trigger: { type: "call.completed", filters: { callStatuses: ["no_answer", "voicemail"], callDirections: ["inbound"] } }, steps: end })).toEqual([]);
    // A campaign run has no contact, so contact steps and re-entry rules are refused.
    const campaign = validateDefinition({ trigger: { type: "campaign.sent", reentry: "once" }, steps: [step("t", "create_task", { title: "Check results", priority: "normal", assignee: "contact_owner" })] }, validationContextFrom(EMPTY_CTX));
    expect(campaign.map((i) => i.code)).toEqual(expect.arrayContaining(["invalid_trigger", "needs_contact"]));

    const names = namesFrom({});
    expect(triggerSummary({ type: "call.completed", filters: { callStatuses: ["no_answer", "voicemail"], callDirections: ["inbound"] } }, names)).toEqual({ title: "Call ended", detail: "incoming calls · ended as no answer, voicemail" });
    expect(triggerSummary({ type: "campaign.sent", filters: { channels: ["sms"] } }, names)).toEqual({ title: "Campaign finished", detail: "on SMS" });
    const panel = readFileSync(path.resolve("src/components/crm/workflows/trigger-panel.tsx"), "utf8");
    expect(panel).toMatch(/const GROUPS = \[[^\]]*"Growth"/);
  });

  it("starts on a call that ended the chosen way, filling the workspace's configuration values into the task", async () => {
    const owner = a.actor("owner");
    await createCustomValue(owner, { key: "callback_window", label: "Callback window", value: "weekdays 9 to 5" });
    const id = await liveWorkflow(a, "Call back missed callers", {
      trigger: { type: "call.completed", filters: { callStatuses: ["no_answer", "busy", "voicemail"], callDirections: ["inbound"] } },
      steps: [step("task", "create_task", { title: "Call back {{contact.first_name}} ({{custom_values.callback_window}})", priority: "high", assignee: "none" })],
    });
    const c = await createContact(owner, { firstName: "Pat", lastName: "Missed", phone: phone() });
    const at = new Date(Date.now() - 600_000).toISOString();
    await logCall(owner, { contactId: c.id, direction: "inbound", status: "no_answer", startedAt: at });
    await logCall(owner, { contactId: c.id, direction: "inbound", status: "completed", startedAt: at, durationSeconds: 120 });
    await logCall(owner, { contactId: c.id, direction: "outbound", status: "no_answer", startedAt: at });
    await settle();
    expect(await runsOf(id)).toEqual([{ contact_id: c.id, opportunity_id: null, status: "completed" }]);
    expect(await all("select title from tasks where org_id = $1 and contact_id = $2", [a.org.id, c.id])).toEqual([{ title: "Call back Pat (weekdays 9 to 5)" }]);
  });

  it("starts on review requests (with their deal), private feedback and finished campaigns", async () => {
    const owner = a.actor("owner");
    await listPipelines(owner, { ensureDefault: true });
    const c = await createContact(owner, { firstName: "Rita", lastName: "Review", email: `rita.${uid()}@example.test` });
    const deal = await createOpportunity(owner, { name: "Kitchen", contactId: c.id, value: 900, currency: "USD" });
    const tag = await createTag(owner, { name: `Gave feedback ${uid()}` });
    const asked = await liveWorkflow(a, "After a review request", { trigger: { type: "review.requested", filters: { channels: ["sms"] } }, steps: [step("t", "create_task", { title: "Watch for {{contact.first_name}}'s review", priority: "low", assignee: "none", linkOpportunity: true })] });
    const answered = await liveWorkflow(a, "After feedback", { trigger: { type: "feedback.received" }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] });
    const finished = await liveWorkflow(a, "After a campaign", { trigger: { type: "campaign.sent" }, steps: [step("n", "notify_team", { roles: ["owner"], title: "A campaign finished" })] });
    await withSystem(async (db) => {
      await emitEvent(db, a.system, { type: "review.requested", entityType: "review_request", entityId: crypto.randomUUID(), contactId: c.id, payload: { channel: "sms", via: "manual", opportunityId: deal.id, appointmentId: null }, dedupeKey: `t-rr:${uid()}` });
      await emitEvent(db, a.system, { type: "review.requested", entityType: "review_request", entityId: crypto.randomUUID(), contactId: c.id, payload: { channel: "email", via: "manual" }, dedupeKey: `t-rr:${uid()}` });
      await emitEvent(db, a.system, { type: "feedback.received", entityType: "customer_feedback", entityId: crypto.randomUUID(), contactId: c.id, payload: { rating: 1, hasComment: false, source: "review_request" }, dedupeKey: `t-fb:${uid()}`, byContact: true });
      await emitEvent(db, a.system, { type: "campaign.sent", entityType: "campaign", entityId: crypto.randomUUID(), payload: { channel: "sms", recipients: 3, sent: 2, failed: 0, excluded: 1 }, dedupeKey: `t-cs:${uid()}` });
    });
    await settle();
    expect(await runsOf(asked)).toEqual([{ contact_id: c.id, opportunity_id: deal.id, status: "completed" }]);
    expect(await all("select title, opportunity_id from tasks where org_id = $1 and title like 'Watch for%'", [a.org.id])).toEqual([{ title: "Watch for Rita's review", opportunity_id: deal.id }]);
    expect(await runsOf(answered)).toEqual([{ contact_id: c.id, opportunity_id: null, status: "completed" }]);
    expect(await all("select 1 from crm_contact_tags where contact_id = $1 and tag_id = $2", [c.id, tag.id])).toHaveLength(1);
    expect(await runsOf(finished)).toEqual([{ contact_id: null, opportunity_id: null, status: "completed" }]);
  });

  it("accepts the workspace's configuration values in its own texts and refuses keys it doesn't have", async () => {
    const ctx = await withSystem((db) => loadValidationContext(db, a.org.id));
    expect(ctx.customValues?.has("callback_window")).toBe(true);
    const def = (title: string) => ({ trigger: { type: "contact.created" }, steps: [step("t", "create_task", { title, priority: "low", assignee: "none" })] });
    expect(validateDefinition(def("Call in {{custom_values.callback_window}}"), ctx)).toEqual([]);
    const unknown = validateDefinition(def("Call in {{custom_values.office_hours}}"), ctx);
    expect(unknown).toEqual([expect.objectContaining({ code: "unknown_token", stepKey: "t", path: "config.title" })]);
    expect(unknown[0].message).toMatch(/isn't one of this workspace's configuration values/);
    // Without the workspace's list (the structural check), any well-formed key is accepted; malformed ones never are.
    expect(validateDefinition(def("Call in {{custom_values.office_hours}}"), null)).toEqual([]);
    expect(validateDefinition(def("Call in {{custom_values.Office-Hours}}"), null).map((i) => i.code)).toEqual(["unknown_token"]);
    const notify = { trigger: { type: "contact.created" }, steps: [step("n", "notify_team", { roles: ["owner"], title: "New lead", body: "Reply within {{custom_values.nope}}" })] };
    expect(validateDefinition(notify, ctx).map((i) => i.path)).toEqual(["config.body"]);
    const { id } = await createWorkflow(a.actor("owner"), { name: "Bad value", definition: def("Call in {{custom_values.office_hours}}") });
    await expect(publishWorkflow(a.actor("owner"), id)).rejects.toThrow(/configuration values/);
  });
});

// ---------------------------------------------------------------------------
// The outbound webhook catalog
// ---------------------------------------------------------------------------

describe("growth events as outbound webhooks", () => {
  const sent: Array<{ url: string; body: string }> = [];
  const originalLookup = hostResolver.lookup;
  const originalPost = pinnedHttps.post;
  beforeAll(() => {
    hostResolver.lookup = async (host: string) => {
      if (host === "hooks.growth.test") return ["93.184.216.50"];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    };
    pinnedHttps.post = async (i) => {
      sent.push({ url: i.url, body: i.body });
      return { status: 200 };
    };
  });
  afterAll(() => {
    hostResolver.lookup = originalLookup;
    pinnedHttps.post = originalPost;
  });

  it("are in the catalog with the permissions their records need", () => {
    for (const t of ["form.submitted", "campaign.sent", "review.requested", "feedback.received", "call.completed"]) expect(isWebhookEventType(t), t).toBe(true);
    expect(WEBHOOK_EVENTS.filter((e) => ["campaign.sent", "review.requested", "feedback.received", "call.completed"].includes(e.type)).map((e) => [e.type, e.group])).toEqual([
      ["campaign.sent", "Campaigns"], ["review.requested", "Reviews"], ["feedback.received", "Reviews"], ["call.completed", "Calls"],
    ]);
    expect(webhookEventPermissions("campaign.sent")).toEqual(["campaigns.manage"]);
    expect(webhookEventPermissions("feedback.received")).toEqual(["contacts.view"]);
    expect(webhookEventPermissions("call.completed")).toEqual(["calls.view", "contacts.view"]);
    const doc = readFileSync(path.resolve("docs/crm-api.md"), "utf8");
    for (const t of ["form.submitted", "campaign.sent", "review.requested", "feedback.received", "call.completed"]) expect(doc, t).toContain(`| \`${t}\` |`);
  });

  it("deliver the record with its contact, never the customer's link, feedback comment, phone numbers or recording references", async () => {
    const o = await crmOrg({ name: "Hooked Growth Co" });
    const owner = o.actor("owner");
    const sub = await createWebhookSubscription(owner, { name: "Growth", url: "https://hooks.growth.test/in", eventTypes: ["call.completed", "review.requested", "feedback.received", "campaign.sent", "form.submitted"] });
    expect(sub.id).toBeTruthy();
    const number = phone();
    const c = await createContact(owner, { firstName: "Hana", lastName: "Hook", phone: number });
    await logCall(owner, { contactId: c.id, direction: "inbound", status: "voicemail", startedAt: new Date(Date.now() - 60_000).toISOString(), summary: "Left a message about pricing." });
    const ids = await withSystem(async (db) => {
      const token = crypto.randomBytes(24).toString("hex");
      const rr = (await db.query<{ id: string }>(
        "insert into crm_review_requests (org_id, contact_id, channel, token_hash, status, requested_via, expires_at) values ($1, $2, 'sms', $3, 'queued', 'manual', now() + interval '60 days') returning id",
        [o.org.id, c.id, crypto.createHash("sha256").update(token).digest("hex")],
      )).rows[0].id;
      const fb = (await db.query<{ id: string }>(
        "insert into customer_feedback (org_id, rating, comment, contact_id, review_request_id, source, follow_up_status) values ($1, 2, 'The installer was late twice.', $2, $3, 'review_request', 'escalated') returning id",
        [o.org.id, c.id, rr],
      )).rows[0].id;
      const camp = (await db.query<{ id: string }>("insert into crm_campaigns (org_id, name, channel, status) values ($1, 'Spring offer', 'sms', 'draft') returning id", [o.org.id])).rows[0].id;
      const form = (await db.query<{ id: string }>("insert into crm_forms (org_id, key, name, kind, purpose) values ($1, 'free-quote', 'Free quote', 'form', 'quote') returning id", [o.org.id])).rows[0].id;
      await emitEvent(db, o.system, { type: "review.requested", entityType: "review_request", entityId: rr, contactId: c.id, payload: { requestId: rr, channel: "sms", via: "manual" }, dedupeKey: `review.requested:${rr}` });
      await emitEvent(db, o.system, { type: "feedback.received", entityType: "customer_feedback", entityId: fb, contactId: c.id, payload: { feedbackId: fb, reviewRequestId: rr, rating: 2, hasComment: true, source: "review_request" }, dedupeKey: `feedback.received:${fb}`, byContact: true });
      await emitEvent(db, o.system, { type: "campaign.sent", entityType: "campaign", entityId: camp, payload: { campaignId: camp, name: "Spring offer", channel: "sms", recipients: 4, sent: 3, failed: 0, excluded: 1 }, dedupeKey: `campaign.sent:${camp}` });
      await emitEvent(db, o.system, { type: "form.submitted", entityType: "form", entityId: form, contactId: c.id, payload: { formId: form, formKey: "free-quote", source: "hosted" }, dedupeKey: `form.submitted:${uid()}` });
      return { rr, fb, camp, form, token };
    });
    await settle();
    await deliverDueWebhooks();
    const bodies = sent.filter((s) => s.url === "https://hooks.growth.test/in").map((s) => JSON.parse(s.body) as { type: string; data: { object: Record<string, unknown>; context: Record<string, unknown> } });
    const of = (type: string) => bodies.find((b) => b.type === type)!;
    expect(bodies.map((b) => b.type).sort()).toEqual(["call.completed", "campaign.sent", "feedback.received", "form.submitted", "review.requested"]);
    expect(of("call.completed").data.object).toMatchObject({ type: "call", provider: "manual", direction: "inbound", status: "voicemail", contactId: c.id });
    expect(of("call.completed").data.context).toMatchObject({ status: "voicemail", contactMatched: true });
    expect(of("review.requested").data.object).toMatchObject({ type: "review_request", id: ids.rr, contactId: c.id, channel: "sms", status: "queued", via: "manual" });
    expect(of("feedback.received").data.object).toMatchObject({ type: "customer_feedback", id: ids.fb, contactId: c.id, reviewRequestId: ids.rr, rating: 2, followUpStatus: "escalated" });
    expect(of("campaign.sent").data.object).toMatchObject({ type: "campaign", id: ids.camp, name: "Spring offer", channel: "sms" });
    expect(of("campaign.sent").data.context).toMatchObject({ recipients: 4, sent: 3, excluded: 1 });
    expect(of("form.submitted").data.object).toMatchObject({ type: "form", id: ids.form, key: "free-quote", name: "Free quote", kind: "form" });
    const everything = JSON.stringify(bodies);
    for (const leak of [number, ids.token, crypto.createHash("sha256").update(ids.token).digest("hex"), "installer was late", "Left a message about pricing", "token_hash"]) expect(everything, leak).not.toContain(leak);
  });
});

// ---------------------------------------------------------------------------
// {{review.link}} in template previews
// ---------------------------------------------------------------------------

describe("the review link in template previews", () => {
  it("previews as the labelled sample link, or as a placeholder with a real contact, and is never filled for real sends", async () => {
    const owner = a.actor("owner");
    const t = await createTemplate(owner, { name: `How did we do ${uid()}`, channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, how did we do? {{review.link}}" });
    const sample = await previewTemplate(owner, t.id);
    expect(sample).toMatchObject({ mode: "sample", missing: [], missingText: "" });
    expect(sample.body).toBe(`Hi Maria, how did we do? ${sampleTokenValues()["review.link"]}`);
    expect(sample.values.find((r) => r.key === "review.link")).toMatchObject({ value: sampleTokenValues()["review.link"], source: "sample" });
    const c = await createContact(owner, { firstName: "Lia", lastName: "Preview", email: `lia.${uid()}@example.test` });
    const real = await previewTemplate(owner, t.id, { contactId: c.id });
    expect(real).toMatchObject({ mode: "contact", missing: [] });
    expect(real.body).toBe(`Hi Lia, how did we do? ${REVIEW_LINK_PREVIEW}`);
    // The editor's live preview loads the same values.
    expect((await previewValues(owner)).values["review.link"]).toBe(sampleTokenValues()["review.link"]);
    expect((await previewValues(owner, { contactId: c.id })).values["review.link"]).toBe(REVIEW_LINK_PREVIEW);
    // Sends (and the campaign estimate, which uses samples) still have no value: only a review request issues the customer's link.
    const forSend = await withSystem((db) => tokenValuesFor(db, a.org.id, { contactId: c.id }));
    expect(forSend.values["review.link"]).toBeUndefined();
    expect((await withSystem((db) => tokenValuesFor(db, a.org.id, { samples: true }))).values["review.link"]).toBeUndefined();
  });
});

describe("configuration values in the inbox composer", () => {
  it("names an empty required value in the gap a canned reply leaves, and leaves an empty optional one out", async () => {
    const owner = a.actor("owner");
    await createCustomValue(owner, { key: "office_address", label: "Office address", value: "", required: true });
    await createCustomValue(owner, { key: "parking_note", label: "Parking note", value: "" });
    await createCannedReply(owner, { name: "Directions", channel: "whatsapp", body: "Find us at {{custom_values.office_address}}.{{custom_values.parking_note}}" });
    const c = await createContact(owner, { firstName: "Ola", lastName: "Inbox", email: `ola.${uid()}@example.test` });
    const out = await cannedRepliesForConversation(a.actor("sales"), { channel: "whatsapp", contactId: c.id });
    expect(out.customValues).toEqual(expect.arrayContaining([{ key: "office_address", label: "Office address", required: true }, { key: "parking_note", label: "Parking note", required: false }]));
    // The composer's own rendering: the same call inbox-workspace.tsx makes when a reply is inserted.
    const gaps: string[] = [];
    const filled = renderTemplate("Find us at {{custom_values.office_address}}.{{custom_values.parking_note}}", out.values, {
      customValues: out.customValues,
      missingAs: (key) => {
        const gap = `[${anyTokenLabel(key, out.customValues) ?? "Missing detail"}]`;
        gaps.push(gap);
        return gap;
      },
    });
    expect(filled.text).toBe("Find us at [Office address].");
    expect(gaps).toEqual(["[Office address]"]);
    const composer = readFileSync(path.resolve("src/components/inbox/inbox-workspace.tsx"), "utf8");
    expect(composer).toContain("anyTokenLabel(key, props.cannedCustomValues)");
    expect(composer).toContain("customValues: props.cannedCustomValues ?? null");
  });

  it("are flagged before a template using an empty required one is approved", () => {
    const catalog = [
      { key: "office_address", label: "Office address", required: true, value: "" },
      { key: "promo", label: "Promo", required: true, value: "AUTUMN" },
      { key: "note", label: "Note", required: false, value: "" },
    ];
    expect(emptyRequiredValues(catalog, "Visit {{custom_values.office_address}} {{custom_values.note}}", "Code {{custom_values.promo}} at {{custom_values.office_address}}").map((d) => d.label)).toEqual(["Office address"]);
    expect(emptyRequiredValues(null, "{{custom_values.office_address}}")).toEqual([]);
    const dialog = readFileSync(path.resolve("src/components/crm/templates/template-dialogs.tsx"), "utf8");
    expect(dialog).toContain("emptyRequiredValues(useCustomValueTokens()");
    expect(dialog).toContain("CRM Settings → Configuration Values");
  });
});

// ---------------------------------------------------------------------------
// Screens and checks
// ---------------------------------------------------------------------------

describe("the contact profile's Request a review action", () => {
  it("links to the review dialog with the contact chosen, only for the client's own owners and managers", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Rae", lastName: "Profile", email: `rae.${uid()}@example.test` });
    const render = async (actor: ReturnType<CrmOrg["actor"]> | Awaited<ReturnType<typeof agencyActor>>) => {
      const scope = await scopeFor(actor, actor.kind === "agency" ? `/admin/clients/${a.org.id}/crm` : "/crm");
      const detail = JSON.parse(JSON.stringify(await getContactDetail(actor, c.id)));
      return renderToStaticMarkup(React.createElement(ContactProfile, {
        scope, detail, timeline: { items: [], nextBefore: null }, notes: [], tasks: [], opportunities: [], conversations: [], appointments: [], tags: [], members: [], pipelines: [],
      }));
    };
    const link = `href="/crm/reviews?contact=${c.id}"`;
    for (const who of ["owner", "manager"] as const) {
      const html = await render(a.actor(who));
      expect(html, who).toContain(link);
      expect(html, who).toContain("Request a review");
    }
    expect(await render(a.actor("sales"))).not.toContain("Request a review");
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, a.org.id, { mode: "write", reason: "Checking the contact profile" });
    expect(await render(await agencyActor(superAdmin, a.org.id))).not.toContain("Request a review");
  });
});

describe("Website Studio template check", () => {
  const withForm = (content: SiteContent, props: Record<string, unknown>) => {
    const first = content.pages.find((p) => p.slug === "home")!.items.find((i): i is Section => !isRef(i))!;
    const el = newElement(content, "form");
    Object.assign(el.props, props);
    return insertElement(content, first.columns[0].id, 0, el);
  };

  it("warns when a shared template's form is set to a CRM form, and not for the built-in form", () => {
    const base = buildSite(ALL_TEMPLATE_KEYS()[0], { businessName: "Template Co", industry: "other", services: [{ title: "Repairs" }] });
    expect(checkTemplate(base).warnings.map((w) => w.code)).not.toContain("crm_form");
    expect(checkTemplate(withForm(base, { formKey: "" })).warnings.map((w) => w.code)).not.toContain("crm_form");
    const check = checkTemplate(withForm(base, { formKey: "free-quote" }));
    const warning = check.warnings.find((w) => w.code === "crm_form");
    expect(warning).toMatchObject({ where: base.pages.find((p) => p.slug === "home")!.title });
    expect(warning!.message).toMatch(/built-in enquiry form/);
    expect(check.blockers.map((b) => b.code)).not.toContain("crm_form");
  });

  it("tells the owner before publishing when a form element's CRM form isn't live, without blocking the site", async () => {
    const o = await crmOrg({ name: "Site Forms Co" });
    const owner = o.actor("owner");
    const base = buildSite(ALL_TEMPLATE_KEYS()[0], { businessName: "Site Forms Co", industry: "other", services: [{ title: "Repairs" }] });
    const drafted = await createForm(owner, { name: "Quote request" });
    const live = await createForm(owner, { name: "Callback" });
    await publishForm(owner, live.id);
    const check = async (key: string) => {
      const r = await siteReadiness(o.org.id, withForm(base, { formKey: key }));
      expect(r.blockers.map((b) => b.code)).not.toContain("form_not_live");
      return r.warnings.filter((w) => w.code === "form_not_live");
    };
    expect(await check(live.key)).toEqual([]);
    const notLive = await check(drafted.key);
    expect(notLive).toHaveLength(1);
    expect(notLive[0].message).toMatch(/“Quote request” isn't published, so visitors see the built-in enquiry form/);
    expect(notLive[0].nodeId).toBeTruthy();
    expect((await check("gone-form"))[0].message).toMatch(/no longer exists/);
    expect((await siteReadiness(o.org.id, base)).warnings.map((w) => w.code)).not.toContain("form_not_live");
  });

  it("lets a site whose forms are all live CRM forms go live with the built-in enquiry form switched off", async () => {
    // The review's case: the only form element names a live CRM form and enquiries are off in Site settings; no phone or email either.
    const o = await crmOrg({ name: "Native Forms Only Co" });
    const live = await createForm(o.actor("owner"), { name: "Callback request" });
    await publishForm(o.actor("owner"), live.id);
    const drafted = await createForm(o.actor("owner"), { name: "Not yet" });
    const site = (key: string) => {
      const built = buildSite("luxe.maison", { businessName: "Native Forms Only Co", industry: "other", services: [{ title: "Repairs" }] });
      let content = built;
      eachElement(content, (e) => {
        if (e.type === "form") Object.assign(e.props, { formKey: key });
      });
      if (!formKeysIn(content).length) content = withForm(content, { formKey: key });
      return { ...content, isSample: false, form: { ...content.form, enabled: false }, business: { ...content.business, phone: "", email: "" } } as SiteContent;
    };
    const codes = (r: { blockers: Array<{ code: string }> }) => r.blockers.map((b) => b.code);
    // The pure check: a CRM form isn't the built-in form, and it is a way in.
    const pure = checkReadiness(site(live.key));
    expect(codes(pure)).not.toContain("form_disabled");
    expect(codes(pure)).not.toContain("no_contact");
    // With the workspace: a live CRM form needs nothing more.
    const ready = await siteReadiness(o.org.id, site(live.key));
    expect(codes(ready)).not.toContain("form_disabled");
    expect(codes(ready)).not.toContain("no_contact");
    // One that isn't live would fall back to the switched-off built-in form: that is a blocker, and it says why.
    const notLive = await siteReadiness(o.org.id, site(drafted.key));
    const blocker = notLive.blockers.find((b) => b.code === "form_disabled");
    expect(blocker?.message).toMatch(/“Not yet” isn't published\. Visitors would see the built-in enquiry form here, which is switched off/);
    // The built-in form switched off is still a blocker, as before.
    const builtIn = { ...site(""), form: { ...site("").form, enabled: false } } as SiteContent;
    eachElement(builtIn, (e) => {
      if (e.type === "form") Object.assign(e.props, { formKey: "" });
    });
    expect(codes(checkReadiness(builtIn))).toContain("form_disabled");
  });
});

describe("analytics and overview copy for iAcquire CRM workspaces", () => {
  const data = (native: boolean) => ({
    sources: { crm: true, calendar: true, native: { opportunities: native, appointments: native } },
    leads: { totals: { total: 0, approved: 0, rejected: 0, reviewed: 0, avg_score: null, with_sources: 0 }, bySource: [] },
    appointments: { booked: 3, showed: 1, noshow: 1, cancelled: 1 },
    sales: { stages: [{ stage: "Qualified", n: 2, value: null }], won: 1, lost: 1, wonValue: 0, wonValues: [{ currency: "USD", value: 900 }] },
    workforce: { byAgent: [], toolSteps: 0, cancelled: 0 },
    execution: { succeeded: 0, blocked: 0, failed: 0, rejected: 0, expired: 0 },
    usage: { messages: 0, tokens: 0, research: 0, help: 0 },
    retention: { total: 0, active: 0, at_risk: 0, churned: 0 },
  });
  const render = (native: boolean) => renderToStaticMarkup(React.createElement(TooltipProvider, null, React.createElement(AnalyticsView, {
    data: data(native), leadsByDay: [], messagesByDay: [], range: { key: "30d", from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString(), days: 30 },
    timeZone: "UTC", canExport: false, canChat: false,
  })));

  it("names the iAcquire CRM and links its reports instead of the connected GoHighLevel copy", () => {
    const native = render(true);
    expect(native).toContain('href="/crm/reports"');
    expect(native).toContain("Workflow runs, form submissions and campaign results from your iAcquire CRM are in");
    expect(native).not.toContain("Automation workflow (n8n/GHL) run statistics");
    const ghl = render(false);
    expect(ghl).not.toContain('href="/crm/reports"');
    expect(ghl).toContain("Automation workflow (n8n/GHL) run statistics");

    const overview = readFileSync(path.resolve("src/app/(portal)/overview/page.tsx"), "utf8");
    expect(overview).toMatch(/href: nativeDeals \? "\/crm\/opportunities" : "\/sales"/);
    expect(overview).toContain("on your iAcquire CRM calendars");
    expect(overview).toContain("Open deals in your iAcquire CRM pipelines.");
    expect(overview).toMatch(/nativeDeals = data\.sources\.native\.opportunities/);
  });
});

it("records the growth events once, for the workspace that emitted them", async () => {
  // Guard: the synthetic events above stayed in their own workspace.
  const types = new Set((await eventsFor(a.org.id)).map((e) => e.type));
  for (const t of ["call.completed", "review.requested", "feedback.received", "campaign.sent"]) expect(types.has(t), t).toBe(true);
  const elsewhere = await one<{ n: string }>("select count(*)::text as n from crm_events where org_id <> $1 and type = 'campaign.sent' and payload->>'recipients' = '3'", [a.org.id]);
  expect(elsewhere.n).toBe("0");
});
