// Reputation: review links, review requests through the gated outbound path, the customer's review page, private feedback and its
// escalation, reporting, the "Request a review" workflow step and the screens. Synthetic workspaces only: messages are queued, never
// dispatched, and nothing contacts a provider.
import crypto from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/crm/reviews",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("not found");
  },
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-reviews", () => Object.fromEntries([
  "createReviewDestinationAction", "updateReviewDestinationAction", "setReviewDestinationActiveAction", "moveReviewDestinationAction", "deleteReviewDestinationAction",
  "previewReviewRequestAction", "requestReviewAction", "cancelReviewRequestAction", "setFeedbackFollowUpAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction"].map((n) => [n, stub])));

import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { decideApproval } from "@/server/approvals/service";
import { agencyActor, memberActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import {
  cancelReviewRequest, createReviewDestination, effectiveRequestStatus, getReviewStats, hashReviewToken, listFeedback, listReviewDestinations, listReviewRequests,
  listReviewTemplates, loadReviewPage, moveReviewDestination, newReviewToken, previewReviewRequest, recordReviewClick, requestReview, REVIEW_TOKEN_RE, reviewTokenFor,
  setFeedbackFollowUp, setReviewDestinationActive, submitReviewFeedback, validateDestinationUrl,
} from "@/server/crm/reviews";
import { getSites } from "@/server/reputation/connections";
import { createWorkflow, publishWorkflow, requestWorkflowApproval } from "@/server/crm/workflows/definitions";
import { startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { maskCustomerLinks, REVIEW_LINK_LABEL } from "@/server/messaging/redact";
import { dispatchMessage } from "@/server/messaging/send";
import { getConversationDetail } from "@/server/messaging/inbox";
import { STEP_KINDS, validateDefinition, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { renderTemplate, validateTemplate } from "@/lib/messaging/tokens";
import { scopeFor } from "@/server/crm/page";
import { ReviewsWorkspace } from "@/components/crm/reviews/reviews-workspace";
import { DEFAULT_REPUTATION_SETTINGS } from "@/lib/reputation/settings";
import ReviewRequestPage from "@/app/r/[token]/page";
import { POST as feedbackRoute, GET as feedbackGet } from "@/app/api/public/reviews/feedback/route";
import { POST as clickRoute, GET as clickGet } from "@/app/api/public/reviews/click/route";
import { agencyPeople } from "./support/crm";
import { messagingOrg, phone, recordingProvider, type MessagingOrg } from "./support/messaging";

const expectError = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (message) expect((err as AppError).message).toMatch(message);
};

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows[0] as T;
const all = async <T>(sql: string, params: unknown[]): Promise<T[]> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows as T[];
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);

/** The customer's token: derived from the request (it is stored nowhere), and checked against the hash the request keeps. */
async function tokenOf(requestId: string): Promise<string> {
  const r = await one<{ token_hash: string }>("select token_hash from crm_review_requests where id = $1", [requestId]);
  const token = reviewTokenFor(requestId);
  if (hashReviewToken(token) !== r.token_hash) throw new Error("the request's token doesn't match its hash");
  return token;
}

interface Shop {
  m: MessagingOrg;
  owner: CrmActor;
  manager: CrmActor;
  sales: CrmActor;
  viewer: CrmActor;
  smsTemplate: { id: string; contentHash: string };
  emailTemplate: { id: string; contentHash: string };
  google: string;
  facebook: string;
}

async function shop(name: string): Promise<Shop> {
  const m = await messagingOrg({ name, provider: { sms: "twilio", email: "resend" } });
  const owner = memberActor(m.ctx("owner"));
  const sms = await createTemplate(owner, { name: "How did we do", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, thanks for visiting {{business.name}}. How did we do? {{review.link}}" });
  const smsOk = await approveTemplate(owner, sms.id, { version: sms.currentVersion, contentHash: sms.contentHash });
  const email = await createTemplate(owner, { name: "Review email", channel: "email", purpose: "service", subject: "How was your visit?", body: "Hi {{contact.first_name}},\n\nTell us how it went: {{review.link}}" });
  const emailOk = await approveTemplate(owner, email.id, { version: email.currentVersion, contentHash: email.contentHash });
  const google = await createReviewDestination(owner, { platform: "google", url: "https://g.page/r/CAbc123xyz/review" });
  const facebook = await createReviewDestination(owner, { platform: "facebook", label: "Review us on Facebook", url: "https://www.facebook.com/exampleshop/reviews" });
  return {
    m, owner, manager: memberActor(m.ctx("manager")), sales: memberActor(m.ctx("sales")), viewer: memberActor(m.ctx("viewer")),
    smsTemplate: { id: sms.id, contentHash: smsOk.contentHash }, emailTemplate: { id: email.id, contentHash: emailOk.contentHash }, google: google.id, facebook: facebook.id,
  };
}

async function customer(s: Shop, consent: "granted" | "revoked" | null = "granted", over: { firstName?: string; email?: string } = {}) {
  const c = await createContact(s.owner, { firstName: over.firstName ?? "Maria", lastName: crypto.randomUUID().slice(0, 6), phone: phone(), email: over.email });
  if (consent === "granted" || consent === "revoked") {
    if (consent === "revoked") await setContactConsent(s.owner, c.id, { channel: "sms", purpose: "service", status: "granted", evidence: "Front desk sign-up sheet." });
    await setContactConsent(s.owner, c.id, { channel: "sms", purpose: "service", status: consent, evidence: "Front desk sign-up sheet, 12 Oct." });
  }
  return c.id;
}

let a: Shop;
let b: Shop;
beforeAll(async () => {
  a = await shop("Reviews Shop");
  b = await shop("Other Reviews Shop");
});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe("tokens, links and statuses (pure)", () => {
  it("issues random 43-character tokens and stores only their sha256", () => {
    const t = newReviewToken();
    expect(t).toMatch(REVIEW_TOKEN_RE);
    expect(newReviewToken()).not.toBe(t);
    expect(hashReviewToken(t)).toBe(crypto.createHash("sha256").update(t).digest("hex"));
    expect(hashReviewToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("knows {{review.link}} as a template token, and leaves it missing anywhere it has no value", () => {
    expect(validateTemplate("How did we do? {{review.link}}", null, "sms").ok).toBe(true);
    const r = renderTemplate("How did we do? {{review.link}}", { "review.link": "https://x.example/r/abc" });
    expect(r).toMatchObject({ ok: true, text: "How did we do? https://x.example/r/abc" });
    const missing = renderTemplate("Hi {{review.link}}", {});
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(["review.link"]);
    expect(missing.text).not.toContain("{{");
  });

  it("accepts only https review links on the named platform's own hosts", () => {
    expect(validateDestinationUrl("google", "https://g.page/r/CAbc/review")).toBe("https://g.page/r/CAbc/review");
    expect(validateDestinationUrl("google", "https://search.google.com/local/writereview?placeid=ChIJ")).toMatch(/^https:/);
    expect(validateDestinationUrl("google", "https://www.google.co.uk/maps/place/x")).toMatch(/^https:/);
    expect(validateDestinationUrl("yelp", "https://www.yelp.ca/writeareview/biz/abc")).toMatch(/^https:/);
    expect(validateDestinationUrl("other", "https://reviews.example.org/us")).toMatch(/^https:/);
    const bad = (p: Parameters<typeof validateDestinationUrl>[0], u: string, re: RegExp) => {
      expect(() => validateDestinationUrl(p, u)).toThrow(re);
    };
    bad("google", "http://g.page/r/x/review", /https/);
    bad("google", "https://www.facebook.com/page/reviews", /isn't on Google/);
    bad("google", "https://g.page.evil.example/r/x", /isn't on Google/);
    bad("other", "https://user:pass@reviews.example.org/", /user name or password/);
    bad("other", "https://127.0.0.1/reviews", /IP address/);
    bad("other", "https://localhost/reviews", /IP address|local name/);
    bad("other", "not a link", /full link/);
    // A pasted link with an upper-case scheme or host is stored the way the database's https:// check reads it.
    expect(validateDestinationUrl("google", "HTTPS://g.page/r/abc/review")).toBe("https://g.page/r/abc/review");
    expect(validateDestinationUrl("other", "  HTTPS://Reviews.Example.org/Us?x=1 ")).toBe("https://reviews.example.org/Us?x=1");
  });

  it("saves a pasted link with an upper-case scheme instead of failing the database's check", async () => {
    const s = await shop("Upper Case Links");
    const d = await createReviewDestination(s.owner, { platform: "yelp", url: "HTTPS://www.yelp.com/writeareview/biz/upper" });
    expect(d.url).toBe("https://www.yelp.com/writeareview/biz/upper");
    // The same link typed differently is recognised as already on the list.
    await expectError(createReviewDestination(s.owner, { platform: "yelp", url: "https://WWW.yelp.com/writeareview/biz/upper" }), "conflict", /already on the list/);
  });

  it("moves a request's shown status forward from its message's delivery, never back", () => {
    expect(effectiveRequestStatus("queued", "queued")).toBe("queued");
    expect(effectiveRequestStatus("queued", "delivered")).toBe("sent");
    expect(effectiveRequestStatus("queued", "blocked")).toBe("failed");
    expect(effectiveRequestStatus("opened", "failed")).toBe("opened");
    expect(effectiveRequestStatus("feedback_received", "sent")).toBe("feedback_received");
    expect(effectiveRequestStatus("cancelled", "sent")).toBe("cancelled");
  });

  it("masks a customer's review link wherever the team reads message text", () => {
    const token = newReviewToken();
    expect(maskCustomerLinks(`How did we do? https://app.example.com/r/${token}`)).toBe(`How did we do? ${REVIEW_LINK_LABEL}`);
    expect(maskCustomerLinks(`Relative /r/${token}.`)).toBe(`Relative ${REVIEW_LINK_LABEL}.`);
    // A review site's own address that happens to contain /r/ isn't one of ours.
    expect(maskCustomerLinks("Review us at https://g.page/r/CAbc123/review")).toBe("Review us at https://g.page/r/CAbc123/review");
    // The placeholder a queued request keeps is never shown raw either.
    expect(maskCustomerLinks("How did we do? {{review.link}}")).toBe(`How did we do? ${REVIEW_LINK_LABEL}`);
    // A request's token is derived from its id: the same every time (so every attempt carries the same link), different per request.
    const id = crypto.randomUUID();
    expect(reviewTokenFor(id)).toMatch(REVIEW_TOKEN_RE);
    expect(reviewTokenFor(id)).toBe(reviewTokenFor(id));
    expect(reviewTokenFor(crypto.randomUUID())).not.toBe(reviewTokenFor(id));
  });
});

// ---------------------------------------------------------------------------
// Review links
// ---------------------------------------------------------------------------

describe("review links", () => {
  it("are managed by owners and managers in the client's own workspace, in the order customers see them", async () => {
    const list = await listReviewDestinations(a.sales);
    expect(list.map((d) => d.platform)).toEqual(["google", "facebook"]);
    expect(list[0]).toMatchObject({ label: "Google", active: true });
    await expectError(createReviewDestination(a.sales, { platform: "yelp", url: "https://www.yelp.com/biz/x" }), "forbidden");
    await expectError(createReviewDestination(a.owner, { platform: "google", url: "https://g.page/r/CAbc123xyz/review" }), "conflict", /already on the list/);
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, a.m.org.id, { mode: "write", reason: "Helping set up reviews" });
    const agency = await agencyActor(superAdmin, a.m.org.id);
    await expectError(createReviewDestination(agency, { platform: "yelp", url: "https://www.yelp.com/biz/x" }), "forbidden", /client's own workspace/);

    const yelp = await createReviewDestination(a.manager, { platform: "yelp", url: "https://www.yelp.com/writeareview/biz/shop" });
    await moveReviewDestination(a.manager, yelp.id, "up");
    expect((await listReviewDestinations(a.owner)).map((d) => d.platform)).toEqual(["google", "yelp", "facebook"]);
    await setReviewDestinationActive(a.manager, yelp.id, false);
    expect((await listReviewDestinations(a.owner)).find((d) => d.id === yelp.id)?.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

describe("review requests", () => {
  it("lists only approved service templates that contain {{review.link}}", async () => {
    const plain = await createTemplate(a.owner, { name: "Plain thanks", channel: "sms", purpose: "service", body: "Thanks for visiting!" });
    await approveTemplate(a.owner, plain.id, { version: plain.currentVersion, contentHash: plain.contentHash });
    const ids = (await listReviewTemplates(a.owner)).map((t) => t.id);
    expect(ids).toContain(a.smsTemplate.id);
    expect(ids).toContain(a.emailTemplate.id);
    expect(ids).not.toContain(plain.id);
    const contactId = await customer(a);
    await expectError(requestReview(a.owner, { contactId, templateId: plain.id, contentHash: null }), "conflict", /review\.link/);
  });

  it("refuses, with the reason, when the contact has no consent on that channel, and leaves nothing behind", async () => {
    const none = await customer(a, null);
    const before = await count("select count(*)::text as n from conversations where org_id = $1 and contact_id = $2", [a.m.org.id, none]);
    const preview = await previewReviewRequest(a.owner, { contactId: none, templateId: a.smsTemplate.id });
    expect(preview.canSend).toBe(false);
    expect(preview.problem).toMatch(/no consent on record/);
    expect(preview.checks.find((c) => c.label.startsWith("Consent"))).toMatchObject({ ok: false });
    expect(preview.body).toContain("[review link]");
    await expectError(requestReview(a.owner, { contactId: none, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash }), "conflict", /no consent on record/);
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [none])).toBe(0);
    expect(await count("select count(*)::text as n from conversations where org_id = $1 and contact_id = $2", [a.m.org.id, none])).toBe(before);

    const revoked = await customer(a, "revoked");
    await expectError(requestReview(a.owner, { contactId: revoked, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash }), "conflict", /withdrew consent/);
    // Consent on SMS says nothing about email.
    const smsOnly = await customer(a, "granted", { email: `maria-${crypto.randomUUID().slice(0, 6)}@example.test` });
    await expectError(requestReview(a.owner, { contactId: smsOnly, templateId: a.emailTemplate.id, contentHash: a.emailTemplate.contentHash }), "conflict", /no consent on record/);
  });

  it("queues a service message with the customer's own link, stores only the token's hash, and records the event once", async () => {
    const contactId = await customer(a, "granted", { firstName: "Olga" });
    const preview = await previewReviewRequest(a.owner, { contactId, templateId: a.smsTemplate.id });
    expect(preview).toMatchObject({ canSend: true, problem: null });
    const { requestId, messageId } = await requestReview(a.owner, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash, businessHoursOnly: false });
    const row = await one<{ status: string; token_hash: string; message_id: string; requested_via: string; channel: string; expires_at: Date; created_at: Date }>(
      "select status, token_hash, message_id, requested_via, channel, expires_at, created_at from crm_review_requests where id = $1", [requestId]);
    expect(row).toMatchObject({ status: "queued", message_id: messageId, requested_via: "manual", channel: "sms" });
    const msg = await one<{ body: string; status: string; scope: string; purpose: string; author_kind: string; dedupe_key: string }>(
      "select body, status, scope, purpose, author_kind, dedupe_key from conversation_messages where id = $1", [messageId]);
    expect(msg).toMatchObject({ status: "queued", scope: "retention", purpose: "service", author_kind: "system", dedupe_key: `review:${requestId}` });
    // The stored message holds the placeholder, never the customer's link: anyone who can read the conversation can't use it.
    expect(msg.body).toBe("Hi Olga, thanks for visiting Reviews Shop. How did we do? {{review.link}}");
    const token = await tokenOf(requestId);
    expect(row.token_hash).toBe(hashReviewToken(token));
    // The token itself is in no column of the request, and in no stored message or preview.
    const raw = JSON.stringify(await one("select * from crm_review_requests where id = $1", [requestId]));
    expect(raw).not.toContain(token);
    expect(await count("select count(*)::text as n from conversation_messages where org_id = $1 and body like $2", [a.m.org.id, `%${token}%`])).toBe(0);
    expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBe(60 * 86_400_000);
    const events = await all<{ dedupe_key: string; payload: Record<string, unknown> }>("select dedupe_key, payload from crm_events where org_id = $1 and type = 'review.requested' and entity_id = $2", [a.m.org.id, requestId]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ dedupe_key: `review.requested:${requestId}`, payload: { channel: "sms", via: "manual" } });

    // Asked recently: refused for 30 days, on any channel.
    await expectError(requestReview(a.owner, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash }), "conflict", /already asked for a review/);
    // A stale approval binds nothing.
    const other = await customer(a);
    await expectError(requestReview(a.owner, { contactId: other, templateId: a.smsTemplate.id, contentHash: "0".repeat(64) }), "conflict", /approved/);
  });

  it("puts the customer's link into the message only for the provider, never into what the inbox or a support session reads", async () => {
    // The review's case: the token used to be stored in the message body, readable by inbox users and read-only support sessions.
    const contactId = await customer(a, "granted", { firstName: "Nadia" });
    const { requestId, messageId } = await requestReview(a.owner, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash, businessHoursOnly: false });
    const token = await tokenOf(requestId);
    const rec = recordingProvider("twilio");
    expect(await dispatchMessage(messageId, { transport: rec.transport })).toEqual({ status: "sent" });
    // The provider got the working link...
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].body).toBe(`Hi Nadia, thanks for visiting Reviews Shop. How did we do? http://localhost:3000/r/${token}`);
    // ...and it is still nowhere in the database, nor in what the team reads (the conversation shows a neutral label).
    const stored = await one<{ body: string; status: string }>("select body, status from conversation_messages where id = $1", [messageId]);
    expect(stored).toEqual({ body: "Hi Nadia, thanks for visiting Reviews Shop. How did we do? {{review.link}}", status: "sent" });
    const conv = await one<{ id: string; last_message_preview: string }>("select c.id, c.last_message_preview from conversation_messages m join conversations c on c.id = m.conversation_id where m.id = $1", [messageId]);
    expect(conv.last_message_preview).toContain(REVIEW_LINK_LABEL);
    expect(conv.last_message_preview).not.toContain(token);
    const thread = await getConversationDetail(a.m.ctx("owner"), conv.id);
    expect(thread.messages.find((x) => x.id === messageId)?.body).toBe(`Hi Nadia, thanks for visiting Reviews Shop. How did we do? ${REVIEW_LINK_LABEL}`);
    expect(JSON.stringify(thread)).not.toContain(token);
    // The link the customer got works.
    expect((await loadReviewPage(token)).state).not.toBe("invalid");
    // A message holding the placeholder whose request is gone is never sent with a raw placeholder (or at all).
    const other = await customer(a, "granted", { firstName: "Rosa" });
    const r2 = await requestReview(a.owner, { contactId: other, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash, businessHoursOnly: false });
    await withSystem((db) => db.query("update crm_review_requests set message_id = null where id = $1", [r2.requestId]));
    expect(await dispatchMessage(r2.messageId, { transport: rec.transport })).toEqual({ status: "blocked" });
    expect(rec.calls).toHaveLength(1);
    expect(await one("select blocked_reason from conversation_messages where id = $1", [r2.messageId])).toEqual({ blocked_reason: "review_link_unavailable" });
  });

  it("is sent only by owners and managers in the client's own workspace", async () => {
    const contactId = await customer(a);
    await expectError(requestReview(a.sales, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash }), "forbidden");
    await expectError(requestReview(a.viewer, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash }), "forbidden");
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, a.m.org.id, { mode: "write", reason: "Checking review requests" });
    await expectError(requestReview(await agencyActor(superAdmin, a.m.org.id), { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash }), "forbidden", /can't send them/);
  });

  it("can be cancelled before it goes out (withdrawing the queued message), not after", async () => {
    const contactId = await customer(a);
    const { requestId, messageId } = await requestReview(a.manager, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const hold = await one<{ reservation_id: string }>("select reservation_id from conversation_messages where id = $1", [messageId]);
    await cancelReviewRequest(a.manager, requestId);
    expect(await one("select status, blocked_reason from conversation_messages where id = $1", [messageId])).toMatchObject({ status: "blocked", blocked_reason: "cancelled" });
    expect(await one("select status from usage_reservations where id = $1", [hold.reservation_id])).toMatchObject({ status: "released" });
    expect((await one<{ status: string }>("select status from crm_review_requests where id = $1", [requestId])).status).toBe("cancelled");
    // The link stops taking feedback, but still shows the public links.
    const page = await loadReviewPage(await tokenOf(requestId));
    expect(page).toMatchObject({ state: "closed", closedReason: "cancelled" });
    expect(page.destinations.length).toBeGreaterThan(0);

    const sent = await customer(a);
    const r2 = await requestReview(a.manager, { contactId: sent, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    await withSystem((db) => db.query("update conversation_messages set status = 'sent', sent_at = now() where id = $1", [r2.messageId]));
    await expectError(cancelReviewRequest(a.manager, r2.requestId), "conflict", /already on its way|already sent/);
  });
});

// ---------------------------------------------------------------------------
// The customer's page and private feedback
// ---------------------------------------------------------------------------

describe("the customer's review page", () => {
  it("always shows every public review link, the same for low and high ratings, and keeps feedback private", async () => {
    const low = await customer(a, "granted", { firstName: "Lena" });
    const high = await customer(a, "granted", { firstName: "Hugo" });
    const rLow = await requestReview(a.owner, { contactId: low, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const rHigh = await requestReview(a.owner, { contactId: high, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const tLow = await tokenOf(rLow.requestId);
    const tHigh = await tokenOf(rHigh.requestId);
    const active = (await listReviewDestinations(a.owner)).filter((d) => d.active).map((d) => ({ id: d.id, label: d.label }));

    const opened = await loadReviewPage(tLow);
    expect(opened).toMatchObject({ state: "open", closedReason: null, feedback: null, business: { name: "Reviews Shop" } });
    expect(opened.destinations.map((d) => ({ id: d.id, label: d.label }))).toEqual(active);
    const afterOpen = await one<{ status: string; opened_at: Date | null }>("select status, opened_at from crm_review_requests where id = $1", [rLow.requestId]);
    expect(afterOpen.status).toBe("opened");
    expect(afterOpen.opened_at).not.toBeNull();

    // A 1-star rating: saved privately, escalated to a task, and the page shows exactly the same public links afterwards.
    const lowResult = await submitReviewFeedback(tLow, { rating: "1", comment: "The wait was far too long." });
    expect(lowResult).toMatchObject({ outcome: "saved", escalated: true });
    const fb = await one<{ rating: number; comment: string; source: string; contact_id: string; review_request_id: string; follow_up_status: string; escalated_task_id: string }>(
      "select rating, comment, source, contact_id, review_request_id, follow_up_status, escalated_task_id from customer_feedback where id = $1", [lowResult.feedbackId]);
    expect(fb).toMatchObject({ rating: 1, comment: "The wait was far too long.", source: "review_request", contact_id: low, review_request_id: rLow.requestId, follow_up_status: "escalated" });
    const task = await one<{ title: string; priority: string; contact_id: string; description: string }>("select title, priority, contact_id, description from tasks where id = $1", [fb.escalated_task_id]);
    expect(task).toMatchObject({ priority: "high", contact_id: low });
    expect(task.title).toMatch(/Follow up on Lena .*feedback \(1 of 5\)/);
    expect(task.description).toMatch(/public review links were shown/);
    expect((await one<{ status: string }>("select status from crm_review_requests where id = $1", [rLow.requestId])).status).toBe("feedback_received");
    const ev = await all<{ dedupe_key: string; actor_kind: string; payload: Record<string, unknown> }>("select dedupe_key, actor_kind, payload from crm_events where org_id = $1 and type = 'feedback.received' and entity_id = $2", [a.m.org.id, lowResult.feedbackId]);
    expect(ev).toEqual([expect.objectContaining({ dedupe_key: `feedback.received:${lowResult.feedbackId}`, actor_kind: "contact", payload: expect.objectContaining({ rating: 1, hasComment: true }) })]);
    const lowAfter = await loadReviewPage(tLow);
    expect(lowAfter.destinations.map((d) => ({ id: d.id, label: d.label }))).toEqual(active);
    expect(lowAfter.feedback).toEqual({ rating: 1, followUp: true });
    expect(await submitReviewFeedback(tLow, { rating: "5" })).toEqual({ outcome: "already" });

    // A 5-star rating: saved, not escalated; the same links.
    await loadReviewPage(tHigh);
    const highResult = await submitReviewFeedback(tHigh, { rating: 5 });
    expect(highResult).toMatchObject({ outcome: "saved", escalated: false });
    expect(await one("select follow_up_status, escalated_task_id from customer_feedback where id = $1", [highResult.feedbackId])).toMatchObject({ follow_up_status: "new", escalated_task_id: null });
    const highAfter = await loadReviewPage(tHigh);
    expect(highAfter.destinations).toEqual(lowAfter.destinations);
    expect(highAfter.feedback).toEqual({ rating: 5, followUp: false });

    // The rendered page lists the same review sites for both customers, next to the private form's thank-you.
    for (const t of [tLow, tHigh]) {
      const html = renderToStaticMarkup(await ReviewRequestPage({ params: Promise.resolve({ token: t }), searchParams: Promise.resolve({}) }));
      for (const d of active) expect(html).toContain(d.label);
      expect(html).toContain("Leave a public review");
      expect(html).toContain("Your feedback was sent");
    }
  });

  it("checks what a customer sends and refuses invalid, empty, unknown and expired links", async () => {
    const contactId = await customer(a);
    const r = await requestReview(a.owner, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const token = await tokenOf(r.requestId);
    expect(await submitReviewFeedback(token, {})).toEqual({ outcome: "empty" });
    expect(await submitReviewFeedback(token, { rating: "7" })).toEqual({ outcome: "invalid" });
    expect(await submitReviewFeedback(token, { rating: "2.5" })).toEqual({ outcome: "invalid" });
    expect(await submitReviewFeedback("short", { rating: "3" })).toEqual({ outcome: "invalid" });
    expect(await submitReviewFeedback(newReviewToken(), { rating: "3" })).toEqual({ outcome: "invalid" });
    expect((await loadReviewPage(newReviewToken())).state).toBe("invalid");
    expect((await loadReviewPage("not-a-token")).state).toBe("invalid");

    // A comment only is fine; control characters are removed and the length is capped.
    const c2 = await customer(a);
    const r2 = await requestReview(a.owner, { contactId: c2, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const saved = await submitReviewFeedback(await tokenOf(r2.requestId), { comment: `Lovely\u0000 staff ${"x".repeat(3000)}` });
    expect(saved.outcome).toBe("saved");
    const fb = await one<{ comment: string; rating: number | null }>("select comment, rating from customer_feedback where id = $1", [saved.feedbackId]);
    expect(fb.rating).toBeNull();
    expect(fb.comment.startsWith("Lovely staff")).toBe(true);
    expect(fb.comment.length).toBe(2000);

    // Expired: no more feedback, but the public links are still there.
    await withSystem((db) => db.query("update crm_review_requests set expires_at = now() - interval '1 minute' where id = $1", [r.requestId]));
    const page = await loadReviewPage(token);
    expect(page).toMatchObject({ state: "closed", closedReason: "expired" });
    expect(page.destinations.length).toBeGreaterThan(0);
    expect(await submitReviewFeedback(token, { rating: "4" })).toEqual({ outcome: "closed" });
  });

  it("records a review site being opened, redirecting only to the business's own active links", async () => {
    const contactId = await customer(a);
    const r = await requestReview(a.owner, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const token = await tokenOf(r.requestId);
    expect(await recordReviewClick(token, a.google)).toEqual({ url: "https://g.page/r/CAbc123xyz/review" });
    await recordReviewClick(token, a.google);
    const req = await one<{ status: string; clicked_at: Date | null; opened_at: Date | null }>("select status, clicked_at, opened_at from crm_review_requests where id = $1", [r.requestId]);
    expect(req.status).toBe("review_link_clicked");
    expect(req.clicked_at).not.toBeNull();
    expect(req.opened_at).not.toBeNull();
    const acts = await all<{ metadata: Record<string, unknown> }>("select metadata from crm_activities where org_id = $1 and kind = 'review.link_clicked' and ref_id = $2", [a.m.org.id, r.requestId]);
    expect(acts).toEqual([{ metadata: { destinationId: a.google, platform: "google" } }]);
    // Another workspace's link, an unknown id, a hidden link: nowhere to go.
    expect(await recordReviewClick(token, b.google)).toBeNull();
    expect(await recordReviewClick(token, crypto.randomUUID())).toBeNull();
    expect(await recordReviewClick(token, "javascript:alert(1)")).toBeNull();
    const hidden = await createReviewDestination(a.owner, { platform: "trustpilot", url: "https://www.trustpilot.com/evaluate/shop.example" });
    await setReviewDestinationActive(a.owner, hidden.id, false);
    expect(await recordReviewClick(token, hidden.id)).toBeNull();
  });
});

describe("the customer page's form endpoints", () => {
  const form = (fields: Record<string, string>) => ({ method: "POST", body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

  it("save feedback and send the customer back to their page, without JavaScript", async () => {
    const contactId = await customer(a);
    const r = await requestReview(a.owner, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const token = await tokenOf(r.requestId);
    const empty = await feedbackRoute(new Request("http://localhost/api/public/reviews/feedback", form({ t: token })));
    expect(empty.status).toBe(303);
    expect(empty.headers.get("location")).toBe(`/r/${token}?r=empty`);
    const saved = await feedbackRoute(new Request("http://localhost/api/public/reviews/feedback", form({ t: token, rating: "4", comment: "Quick and friendly." })));
    expect(saved.headers.get("location")).toBe(`/r/${token}?r=saved`);
    expect(saved.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await one("select rating, comment from customer_feedback where review_request_id = $1", [r.requestId])).toEqual({ rating: 4, comment: "Quick and friendly." });
    const junk = await feedbackRoute(new Request("http://localhost/api/public/reviews/feedback", form({ t: "../../etc", rating: "4" })));
    expect(junk.headers.get("location")).toBe("/r/invalid?r=invalid");
    // Opening the endpoint records nothing.
    expect((await feedbackGet(new Request(`http://localhost/api/public/reviews/feedback?t=${token}`))).headers.get("location")).toBe(`/r/${token}`);
  });

  it("redirect a review-site click only to the business's own link, with no referrer", async () => {
    const contactId = await customer(a);
    const r = await requestReview(a.owner, { contactId, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const token = await tokenOf(r.requestId);
    const go = await clickRoute(new Request("http://localhost/api/public/reviews/click", form({ t: token, d: a.facebook })));
    expect(go.status).toBe(303);
    expect(go.headers.get("location")).toBe("https://www.facebook.com/exampleshop/reviews");
    expect(go.headers.get("referrer-policy")).toBe("no-referrer");
    const elsewhere = await clickRoute(new Request("http://localhost/api/public/reviews/click", form({ t: token, d: "https://evil.example/phish" })));
    expect(elsewhere.headers.get("location")).toBe(`/r/${token}?r=link_missing`);
    const before = await one<{ clicked_at: Date | null }>("select clicked_at from crm_review_requests where id = $1", [r.requestId]);
    expect(before.clicked_at).not.toBeNull();
    const c2 = await customer(a);
    const r2 = await requestReview(a.owner, { contactId: c2, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    const t2 = await tokenOf(r2.requestId);
    expect((await clickGet(new Request(`http://localhost/api/public/reviews/click?t=${t2}&d=${a.google}`))).headers.get("location")).toBe(`/r/${t2}`);
    expect((await one<{ clicked_at: Date | null }>("select clicked_at from crm_review_requests where id = $1", [r2.requestId])).clicked_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reporting, feedback follow-up, isolation
// ---------------------------------------------------------------------------

describe("reporting and follow-up", () => {
  it("counts requests, opens, clicks and private feedback from this workspace's own records", async () => {
    const s = await shop("Counting Shop");
    const c1 = await customer(s);
    const c2 = await customer(s);
    const c3 = await customer(s);
    const r1 = await requestReview(s.owner, { contactId: c1, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash });
    const r2 = await requestReview(s.owner, { contactId: c2, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash });
    const r3 = await requestReview(s.owner, { contactId: c3, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash });
    await withSystem((db) => db.query("update conversation_messages set status = 'delivered', sent_at = now() where id = any($1::uuid[])", [[r1.messageId, r2.messageId]]));
    await withSystem((db) => db.query("update conversation_messages set status = 'failed' where id = $1", [r3.messageId]));
    await loadReviewPage(await tokenOf(r1.requestId));
    await recordReviewClick(await tokenOf(r1.requestId), s.facebook);
    await submitReviewFeedback(await tokenOf(r2.requestId), { rating: "2", comment: "Rude on the phone." });
    const stats = await getReviewStats(s.viewer, { days: 30 });
    expect(stats.requests).toEqual({ created: 3, waiting: 0, sent: 2, opened: 2, clicked: 1, feedback: 1, failed: 1 });
    expect(stats.feedback).toMatchObject({ count: 1, rated: 1, average: 2, low: 1, open: 1, byRating: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0 } });
    expect(stats.clicksByPlatform).toEqual([{ platform: "facebook", label: "Facebook", clicks: 1 }]);

    const list = await listReviewRequests(s.viewer, { filter: "all" });
    expect(list.total).toBe(3);
    expect(Object.fromEntries(list.rows.map((r) => [r.id, r.status]))).toEqual({ [r1.requestId]: "review_link_clicked", [r2.requestId]: "feedback_received", [r3.requestId]: "failed" });
    expect((await listReviewRequests(s.viewer, { filter: "failed" })).rows.map((r) => r.id)).toEqual([r3.requestId]);
    expect((await listReviewRequests(s.viewer, { filter: "feedback" })).rows[0].feedback).toMatchObject({ rating: 2, comment: "Rude on the phone.", followUpStatus: "escalated" });

    const open = await listFeedback(s.viewer, { filter: "open" });
    expect(open.rows).toHaveLength(1);
    await expectError(setFeedbackFollowUp(s.sales, open.rows[0].id, "resolved"), "forbidden");
    await setFeedbackFollowUp(s.manager, open.rows[0].id, "resolved");
    expect((await listFeedback(s.viewer, { filter: "open" })).rows).toHaveLength(0);
    expect((await listFeedback(s.viewer, { filter: "low" })).rows[0]).toMatchObject({ followUpStatus: "resolved", rating: 2 });

    // A request whose message failed never reached the customer, so they can be asked again; one that was delivered can't.
    await expect(requestReview(s.owner, { contactId: c3, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash })).resolves.toMatchObject({ requestId: expect.any(String) });
    await expectError(requestReview(s.owner, { contactId: c1, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash }), "conflict", /already asked/);
  });

  it("keeps each workspace's requests, feedback and contacts to itself", async () => {
    const mine = await customer(a);
    await expectError(requestReview(b.owner, { contactId: mine, templateId: b.smsTemplate.id, contentHash: b.smsTemplate.contentHash }), "not_found");
    await expectError(requestReview(b.owner, { contactId: await customer(b), templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash }), "conflict", /approved/);
    const r = await requestReview(a.owner, { contactId: mine, templateId: a.smsTemplate.id, contentHash: a.smsTemplate.contentHash });
    expect((await listReviewRequests(b.owner, { pageSize: 100 })).rows.some((x) => x.id === r.requestId)).toBe(false);
    expect((await listReviewDestinations(b.owner)).some((d) => d.id === a.google)).toBe(false);
    await expectError(cancelReviewRequest(b.owner, r.requestId), "not_found");
    await submitReviewFeedback(await tokenOf(r.requestId), { rating: "1" });
    expect((await listFeedback(b.owner, { filter: "all", pageSize: 100 })).rows.some((f) => f.reviewRequestId === r.requestId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The "Request a review" workflow step
// ---------------------------------------------------------------------------

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;

describe("the request_review workflow step", () => {
  it("is in the catalog, sends a message (so the owner approves the version) and validates its template", () => {
    expect(STEP_KINDS.request_review).toMatchObject({ group: "Messages", approvable: true, emitsEvents: true });
    expect(STEP_KINDS.request_review.effects({ channel: "sms" } as never)).toEqual(["send_sms"]);
    expect(STEP_KINDS.request_review.effects({ channel: "email" } as never)).toEqual(["send_email"]);
    const def = { trigger: { type: "manual" }, steps: [step("ask", "request_review", { templateId: crypto.randomUUID(), contentHash: "a".repeat(64), channel: "sms", businessHoursOnly: true })] };
    const ctx = {
      tags: new Set<string>(), users: new Set<string>(), pipelines: new Map(), fields: new Map(), templates: new Map(), n8nMappings: new Set<string>(), webhookSubscriptions: new Set<string>(),
      assignmentRules: new Map(), agents: new Set<string>(), calendars: new Set<string>(), appointmentTypes: new Set<string>(),
    };
    expect(validateDefinition(def, ctx).map((i) => i.code)).toContain("missing_template");
    expect(validateDefinition({ ...def, steps: [step("ask", "request_review", { channel: "sms" })] }, null).map((i) => i.code)).toContain("invalid_config");
  });

  it("asks the run's contact for a review under the owner's approval, once per step visit, and only with consent", async () => {
    const s = await shop("Workflow Reviews Shop");
    const def: WorkflowDefinition = { trigger: { type: "manual" }, steps: [step("ask", "request_review", { templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, channel: "sms", businessHoursOnly: false })] };
    const { id } = await createWorkflow(s.manager, { name: "Ask for reviews", definition: def });
    const pub = await publishWorkflow(s.manager, id);
    expect(pub).toMatchObject({ needsApproval: true, effects: ["send_sms"] });
    const req = await requestWorkflowApproval(s.manager, id, null, { activate: true });
    expect((await decideApproval(s.m.ctx("owner"), req.approvalId!, "approve")).outcome?.status).toBe("succeeded");

    const stepsOf = (runId: string) => all<{ status: string; result: Record<string, unknown> }>("select status, result from crm_workflow_run_steps where run_id = $1 order by id", [runId]);
    const without = await customer(s, null);
    const r1 = await startManualRun(s.owner, id, { contactId: without });
    await processWorkflowRuns();
    expect((await stepsOf(r1.runId))[0]).toMatchObject({ status: "skipped", result: { outcome: "blocked", reason: "no_consent" } });
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [without])).toBe(0);

    const ok = await customer(s);
    const test = await startTestRun(s.owner, id, { contactId: ok });
    expect(JSON.stringify(test)).toMatch(/Would ask/);
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [ok])).toBe(0);

    const r2 = await startManualRun(s.owner, id, { contactId: ok });
    await processWorkflowRuns();
    const [st] = await stepsOf(r2.runId);
    expect(st).toMatchObject({ status: "completed", result: { status: "queued" } });
    const made = await one<{ id: string; requested_via: string; message_id: string }>("select id, requested_via, message_id from crm_review_requests where contact_id = $1", [ok]);
    expect(made.requested_via).toBe("workflow");
    expect(await one("select dedupe_key, author_kind from conversation_messages where id = $1", [made.message_id])).toMatchObject({ dedupe_key: `wf:${r2.runId}:ask`, author_kind: "system" });
    const ev = await one<{ actor_kind: string }>("select actor_kind from crm_events where type = 'review.requested' and entity_id = $1", [made.id]);
    expect(ev.actor_kind).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

describe("the Reviews screen", () => {
  it("renders the links, the numbers, the public review sites' honest state and the rules", async () => {
    const scope = await scopeFor(a.owner, "/crm");
    const [stats, destinations, templates, requests, feedback] = await Promise.all([
      getReviewStats(a.owner, { days: 30 }), listReviewDestinations(a.owner), listReviewTemplates(a.owner), listReviewRequests(a.owner, { pageSize: 5 }), listFeedback(a.owner, { filter: "open", pageSize: 5 }),
    ]);
    const html = renderToStaticMarkup(React.createElement(ReviewsWorkspace, {
      scope, tab: "overview", days: 30, stats, destinations, templates, requests, feedback, requestFilter: "all", feedbackFilter: "open",
      canManageLinks: true, canSend: true, canFollowUp: true, contactsLinked: true,
      limits: { cooldownDays: 30, linkDays: 60, escalateAtOrBelow: 2, maxActive: 6, maxTotal: 10 }, initialContact: null,
      settings: DEFAULT_REPUTATION_SETTINGS, canEditSettings: true, surveysEnabled: true, satisfaction: null,
      publicReviews: { sites: await getSites(a.owner), enabled: false, any: false, data: null, filter: "all", focusId: null, pending: null, pendingStateId: null, notice: null, canManageSites: true },
    }));
    expect(html).toContain("Public review links");
    expect(html).toContain("tab=satisfaction");
    expect(html).toContain("A survey goes the same way and opens the same page, with the same review links.");
    expect(html).toContain("Nothing is offered in return for a review or feedback");
    expect(html).toContain("Review us on Facebook");
    // The old static "Blocked" card is a status card now: each site says where it stands, in words, and nothing claims a connection that does not exist.
    expect(html).toContain("Public reviews in iAcquire");
    expect(html).toContain("Not available yet");
    expect(html).toContain("Business Profile reviews");
    expect(html).toContain("Public reviews aren&#x27;t switched on for this workspace yet");
    expect(html).not.toContain("Blocked");
    expect(html).not.toContain("Public reviews</a>");
    expect(html).toContain("whatever rating they give you privately");
    expect(html).toContain("Request a review");
    expect(html).toContain("tab=settings");
    expect(html).not.toMatch(/\/r\/[A-Za-z0-9_-]{43}/);
  });
});
