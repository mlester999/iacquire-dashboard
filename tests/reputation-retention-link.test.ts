// A retention program message that carries the customer's own private feedback link ({feedback_link}). The owner approves the wording; the link goes only by a channel the customer
// agreed to service messages on, once per cool-down; the request behind it exists with the message and goes with it if the message is withdrawn. Synthetic workspaces on embedded
// Postgres: the provider is a recorder, nothing is sent anywhere.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { setClientPause } from "@/server/automation/controls";
import { setContactConsent } from "@/server/crm/contacts";
import { loadReviewPage, reviewLinkForMessage, submitReviewFeedback } from "@/server/crm/reviews";
import { dispatchDue, dispatchMessage } from "@/server/messaging/send";
import { suppressAddress } from "@/server/messaging/contacts";
import { queueFeedbackLinkStep } from "@/server/reputation/program-link";
import { cancelRetention } from "@/server/retention/cancel";
import { enrollEligible, prepareDueSteps } from "@/server/retention/engine";
import { listPrograms, saveProgram, setProgramEnabled, setRetentionPaused } from "@/server/retention/service";
import { DEFAULT_PROGRAMS, FEEDBACK_LINK, hasFeedbackLink, type ProgramKind } from "@/lib/retention";
import { eventsFor } from "./support/crm";
import { recordingProvider } from "./support/messaging";
import { ask, all, count, one, reputationShop, shopCustomer, tokenOf, type ReputationShop } from "./support/reputation";

const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
const LINK_WORDING = "Hi {name}, how did {business} do? {feedback_link}";

let s: ReputationShop;
const owner = () => s.m.ctx("owner");

async function approve(kind: ProgramKind, body: string, delayDays = 1) {
  expect(await saveProgram(s.m.ctx("manager"), kind, { steps: [{ key: kind === "feedback_request" ? "feedback" : "thanks", delayDays, body }] })).toEqual({ ok: true });
  await setProgramEnabled(owner(), kind, true);
}

beforeAll(async () => {
  s = await reputationShop("Link Shop");
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'crm_manager'", [s.m.org.id]));
  await approve("feedback_request", LINK_WORDING);
});

/** A customer whose appointment was marked attended after the program was approved. */
async function attended(opts: { consent?: boolean; email?: string } = {}) {
  const contactId = await shopCustomer(s, { consent: opts.consent, email: opts.email });
  const appt = await one<{ id: string }>(
    `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, last_event_at)
     values ($1, $2, 'cal_link_0001', 'Visit', 'showed', now() - interval '2 hours', now() - interval '90 minutes', $3, now() + interval '1 minute') returning id`,
    [s.m.org.id, `link_${crypto.randomUUID()}`, contactId],
  );
  return { contactId, appointmentId: appt.id };
}

const stepOf = (contactId: string, kind: ProgramKind = "feedback_request") =>
  one<{ id: string; status: string; reason: string | null; message_id: string | null }>(
    `select st.id, st.status, st.reason, st.message_id from retention_steps st join retention_enrollments e on e.id = st.enrollment_id join retention_programs p on p.id = e.program_id
     where e.contact_id = $1 and p.kind = $2`,
    [contactId, kind],
  );
const enrollmentOf = (contactId: string, kind: ProgramKind = "feedback_request") =>
  one<{ status: string; cancel_reason: string | null }>("select e.status, e.cancel_reason from retention_enrollments e join retention_programs p on p.id = e.program_id where e.contact_id = $1 and p.kind = $2", [contactId, kind]);
const requestsOf = (contactId: string) =>
  all<{ id: string; kind: string; scale: string; status: string; requested_via: string; channel: string; message_id: string | null; appointment_id: string | null; template_id: string | null }>(
    "select id, kind, scale, status, requested_via, channel, message_id, appointment_id, template_id from crm_review_requests where contact_id = $1 order by created_at",
    [contactId],
  );
const messageOf = (id: string | null) =>
  one<{ body: string; scope: string; purpose: string; status: string; channel: string; blocked_reason: string | null; send_after: Date }>(
    "select m.body, m.scope, m.purpose, m.status, c.channel, m.blocked_reason, m.send_after from conversation_messages m join conversations c on c.id = m.conversation_id where m.id = $1",
    [id],
  );
const phoneOf = async (id: string) => (await one<{ phone: string }>("select phone from contacts where id = $1", [id])).phone;

/** Enrols the customer, makes the step due, and prepares it. */
async function run(contactId: string, kind: ProgramKind = "feedback_request") {
  await enrollEligible();
  await withSystem((db) => db.query(
    "update retention_steps set due_at = now() - interval '1 hour' where enrollment_id in (select e.id from retention_enrollments e join retention_programs p on p.id = e.program_id where e.contact_id = $1 and p.kind = $2)",
    [contactId, kind],
  ));
  await prepareDueSteps({ now: hours(1), limit: 100 });
  return stepOf(contactId, kind);
}

describe("the wording", () => {
  it("is ordinary program wording with one extra place to put the link, and the standard programs ship without it", () => {
    expect(FEEDBACK_LINK).toBe("{feedback_link}");
    for (const p of DEFAULT_PROGRAMS) for (const st of p.steps) expect(hasFeedbackLink(st.body), `${p.kind}/${st.key}`).toBe(false);
  });

  it("is covered by the owner's approval: it can't be switched on with an offer in it, and changing the link text withdraws the approval", async () => {
    const t = await reputationShop("Link Wording Shop");
    const m = t.m;
    const bad = await saveProgram(m.ctx("manager"), "feedback_request", { steps: [{ key: "feedback", delayDays: 1, body: "Hi {name}, tell us and get 10% off your next visit {feedback_link}" }] });
    expect(bad).toMatchObject({ ok: false, issues: [{ step: 0, message: expect.stringContaining("Remove “10% off”") }] });
    const wrongProgram = await saveProgram(m.ctx("manager"), "welcome", { steps: [{ key: "welcome", delayDays: 0, body: "Welcome {name}! {feedback_link}" }] });
    expect(wrongProgram).toMatchObject({ ok: false });
    expect(await saveProgram(m.ctx("manager"), "feedback_request", { steps: [{ key: "feedback", delayDays: 1, body: LINK_WORDING }] })).toEqual({ ok: true });
    await setProgramEnabled(m.ctx("owner"), "feedback_request", true);
    expect((await listPrograms(m.ctx("owner"))).find((p) => p.kind === "feedback_request")).toMatchObject({ state: "on" });
    // Different words around the link: the program stops until the owner approves them.
    expect(await saveProgram(m.ctx("manager"), "feedback_request", { steps: [{ key: "feedback", delayDays: 1, body: "Hi {name}, we would love your thoughts: {feedback_link}" }] })).toEqual({ ok: true });
    expect((await listPrograms(m.ctx("owner"))).find((p) => p.kind === "feedback_request")).toMatchObject({ state: "needs_approval" });
  });
});

describe("a customer who agreed to service texts", () => {
  it("gets one message with their own link, queued with its request in one go, and the link works only for them", async () => {
    const { contactId, appointmentId } = await attended();
    const st = await run(contactId);
    expect(st).toMatchObject({ status: "queued", reason: null });
    const msg = await messageOf(st.message_id);
    expect(msg).toMatchObject({ scope: "retention", purpose: "service", status: "queued", channel: "sms" });
    // The stored message holds the placeholder, never a link.
    expect(msg.body).toContain("Hi Maria, how did Link Shop do? {{review.link}}");
    expect(msg.body).not.toMatch(/\/r\/[A-Za-z0-9_-]{43}/);

    const [req, ...rest] = await requestsOf(contactId);
    expect(rest).toEqual([]);
    expect(req).toMatchObject({ kind: "survey", scale: "csat5", status: "queued", requested_via: "program", channel: "sms", message_id: st.message_id, appointment_id: appointmentId, template_id: null });
    expect(await count("select count(*)::text as n from crm_review_requests where message_id = $1", [st.message_id])).toBe(1);
    // The request is announced like any other, with where it came from.
    const ev = (await eventsFor(s.m.org.id, "review.requested")).find((e) => e.entity_id === req.id)!;
    expect(ev.payload).toMatchObject({ via: "program", kind: "survey", scale: "csat5", channel: "sms", appointmentId });
    expect(await one("select summary from crm_activities where org_id = $1 and ref_id = $2 and kind = 'review.requested'", [s.m.org.id, req.id])).toEqual({ summary: "Survey requested by SMS" });
    expect(await one("select action, metadata->>'via' as via from audit_logs where org_id = $1 and target_id = $2 and action = 'crm.review_requested'", [s.m.org.id, req.id])).toEqual({ action: "crm.review_requested", via: "program" });

    // The dispatcher fills in the customer's own link for the provider call only.
    const token = await tokenOf(req.id);
    const rec = recordingProvider("twilio");
    expect(await dispatchMessage(st.message_id!, { transport: rec.transport, now: hours(1) })).toEqual({ status: "sent" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].body).toContain(`Hi Maria, how did Link Shop do? http://localhost:3000/r/${token}`);
    expect((await messageOf(st.message_id)).body).toContain("{{review.link}}");
    expect(JSON.stringify(await all("select body from conversation_messages where org_id = $1", [s.m.org.id]))).not.toContain(token);
    // The link is derived again from the request when it is needed; the request is the only record of it, and it keeps only the link's hash.
    expect(await withSystem((db) => reviewLinkForMessage(db, s.m.org.id, st.message_id!))).toBe(`http://localhost:3000/r/${token}`);
  });

  it("shows the customer the business's own page: its name, the same public review links, and a way to answer privately", async () => {
    const { contactId } = await attended();
    const st = await run(contactId);
    const req = (await requestsOf(contactId))[0];
    const token = await tokenOf(req.id);
    const page = await loadReviewPage(token);
    expect(page).toMatchObject({ state: "open", kind: "survey", scale: "csat5", business: { name: "Link Shop" } });
    expect(page.destinations.map((d) => d.label)).toEqual(["Google", "Review us on Facebook"]);
    expect(await submitReviewFeedback(token, { rating: "4", comment: "Nice visit." })).toMatchObject({ outcome: "saved", escalated: false });
    expect(await one("select status from crm_review_requests where id = $1", [req.id])).toEqual({ status: "feedback_received" });
    expect(st.message_id).toBeTruthy();
  });

  it("is then not asked again for the cool-down by anything: not a person's request, not another program's link", async () => {
    const { contactId } = await attended();
    await run(contactId);
    await expect(ask(s, contactId)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already asked/) });
    expect(await requestsOf(contactId)).toHaveLength(1);
  });

  it("is skipped, not stopped, when they were asked recently: the program carries on and no second link exists", async () => {
    const { contactId } = await attended();
    const manual = await ask(s, contactId);
    const st = await run(contactId);
    expect(st).toMatchObject({ status: "blocked", reason: "recently_requested", message_id: null });
    expect(await enrollmentOf(contactId)).toMatchObject({ status: "completed", cancel_reason: null });
    expect((await requestsOf(contactId)).map((r) => r.id)).toEqual([manual.requestId]);
    // The only message this customer has is the person's own request (it is a program-scope message too); the step queued nothing.
    expect((await all<{ id: string }>("select m.id from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1", [contactId])).map((m) => m.id)).toEqual([manual.messageId]);
  });
});

describe("a customer who has not agreed to service texts", () => {
  it("is sent nothing with a link, and nothing is created for them, even though a plain message might be allowed", async () => {
    for (const consent of [false, "revoked"] as const) {
      const { contactId } = await attended({ consent: consent === false ? false : undefined });
      if (consent === "revoked") {
        await setContactConsent(s.owner, contactId, { channel: "sms", purpose: "service", status: "revoked", evidence: "Told us by phone." });
      }
      const st = await run(contactId);
      expect(st, String(consent)).toMatchObject({ status: "blocked", reason: "link_needs_consent", message_id: null });
      expect(await requestsOf(contactId), String(consent)).toEqual([]);
      expect(await count("select count(*)::text as n from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1", [contactId]), String(consent)).toBe(0);
      // Only this step is held back; the rest of their program is not cancelled for it.
      expect((await enrollmentOf(contactId)).status, String(consent)).not.toBe("cancelled");
    }
  });

  it("goes by the channel they did agree to, and only that one", async () => {
    const email = `link.${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { contactId } = await attended({ consent: false, email });
    await setContactConsent(s.owner, contactId, { channel: "email", purpose: "service", status: "granted", evidence: "Ticked the box on the sign-up form." });
    const st = await run(contactId);
    expect(st.status).toBe("queued");
    expect(await messageOf(st.message_id)).toMatchObject({ channel: "email", status: "queued" });
    expect(await requestsOf(contactId)).toMatchObject([{ channel: "email", requested_via: "program", message_id: st.message_id }]);
    expect(await count("select count(*)::text as n from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1 and c.channel = 'sms'", [contactId])).toBe(0);
  });

  it("never uses an address that opted out: it falls to another channel they agreed to, and ends the program when none is left", async () => {
    const email = `optout.${crypto.randomUUID().slice(0, 8)}@example.test`;
    const both = await attended({ email });
    await setContactConsent(s.owner, both.contactId, { channel: "email", purpose: "service", status: "granted", evidence: "Ticked the box on the sign-up form." });
    const bothPhone = await phoneOf(both.contactId);
    await withSystem((db) => suppressAddress(db, { orgId: s.m.org.id, channel: "sms", address: bothPhone, reason: "opt_out", source: "test" }));
    const viaEmail = await run(both.contactId);
    expect(viaEmail.status).toBe("queued");
    expect(await messageOf(viaEmail.message_id)).toMatchObject({ channel: "email" });

    const only = await attended();
    const onlyPhone = await phoneOf(only.contactId);
    await withSystem((db) => suppressAddress(db, { orgId: s.m.org.id, channel: "sms", address: onlyPhone, reason: "opt_out", source: "test" }));
    const stopped = await run(only.contactId);
    expect(stopped).toMatchObject({ status: "blocked", reason: "suppressed", message_id: null });
    // An opt-out ends the customer's program: this one had a single message, so there is nothing left to run.
    expect((await enrollmentOf(only.contactId)).status).not.toBe("active");
    expect(await requestsOf(only.contactId)).toEqual([]);
  });
});

describe("withdrawing the message takes its request with it", () => {
  it("cancels the request when the program is switched off, when the customer's program is stopped, and when the message is blocked", async () => {
    // A program stopped for one customer (they replied, a person excluded them, low feedback came in).
    const a = await attended();
    const sa = await run(a.contactId);
    expect((await requestsOf(a.contactId))[0]).toMatchObject({ status: "queued" });
    await withSystem((db) => cancelRetention(db, s.m.org.id, a.contactId, "customer_replied"));
    expect(await messageOf(sa.message_id)).toMatchObject({ status: "blocked", blocked_reason: "customer_replied" });
    expect((await requestsOf(a.contactId))[0]).toMatchObject({ status: "cancelled" });
    const tokenA = await tokenOf((await requestsOf(a.contactId))[0].id);
    expect(await loadReviewPage(tokenA)).toMatchObject({ state: "closed", closedReason: "cancelled" });
    const rec = recordingProvider("twilio");
    expect(await dispatchMessage(sa.message_id!, { transport: rec.transport, now: hours(1) })).not.toEqual({ status: "sent" });
    expect(rec.calls).toEqual([]);

    // The whole program switched off.
    const b = await attended();
    const sb = await run(b.contactId);
    await setProgramEnabled(s.m.ctx("manager"), "feedback_request", false);
    expect(await messageOf(sb.message_id)).toMatchObject({ status: "blocked", blocked_reason: "program_off" });
    expect((await requestsOf(b.contactId))[0]).toMatchObject({ status: "cancelled" });
    expect(await dispatchMessage(sb.message_id!, { transport: rec.transport, now: hours(1) })).not.toEqual({ status: "sent" });
    expect(rec.calls).toEqual([]);
    await setProgramEnabled(owner(), "feedback_request", true);

    // A message still queued for a customer whose enrolment was already closed is withdrawn with the program too, and so is its request.
    const d = await attended();
    const sd = await run(d.contactId);
    await withSystem((db) => db.query("update retention_enrollments set status = 'completed', closed_at = now() where contact_id = $1", [d.contactId]));
    await setProgramEnabled(s.m.ctx("manager"), "feedback_request", false);
    expect(await messageOf(sd.message_id)).toMatchObject({ status: "blocked", blocked_reason: "program_off" });
    expect((await requestsOf(d.contactId))[0]).toMatchObject({ status: "cancelled" });
    await setProgramEnabled(owner(), "feedback_request", true);
  });

  it("leaves nothing behind when the send path refuses the message, and a message already sent keeps its request", async () => {
    const c = await attended();
    await setClientPause(owner(), { scope: "messaging", paused: true, reason: "test" });
    try {
      const st = await run(c.contactId);
      expect(st).toMatchObject({ status: "blocked", reason: "automation_paused", message_id: null });
    } finally {
      await setClientPause(owner(), { scope: "messaging", paused: false });
    }
    expect(await requestsOf(c.contactId)).toEqual([]);
    expect(await count("select count(*)::text as n from conversation_messages m join conversations c2 on c2.id = m.conversation_id where c2.contact_id = $1 and m.scope = 'retention'", [c.contactId])).toBe(0);

    const sent = await attended();
    const st = await run(sent.contactId);
    const rec = recordingProvider("twilio");
    expect(await dispatchMessage(st.message_id!, { transport: rec.transport, now: hours(1) })).toEqual({ status: "sent" });
    await withSystem((db) => cancelRetention(db, s.m.org.id, sent.contactId, "customer_replied"));
    expect((await requestsOf(sent.contactId))[0]).toMatchObject({ status: "queued" });
  });

  it("holds a message that needs a person's approval as a draft, with its request, and sends nothing until it is approved", async () => {
    const c = await attended();
    const agent = await one<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'crm_manager'", [s.m.org.id]);
    await withSystem((db) => db.query("update agent_instances set mode = 'approval_required' where id = $1", [agent.id]));
    try {
      const res = await withSystem((db) => queueFeedbackLinkStep(db, {
        orgId: s.m.org.id, orgName: "Link Shop", orgTimezone: "UTC", contactId: c.contactId, contactName: "Maria Draft", agentId: agent.id, programKind: "feedback_request", purpose: "service",
        body: LINK_WORDING, businessHoursOnly: false, approvalId: null, stepId: crypto.randomUUID(), triggerRef: null, now: new Date(),
      }));
      expect(res.status).toBe("draft");
      expect(await messageOf(res.messageId!)).toMatchObject({ status: "draft", scope: "retention" });
      expect(await requestsOf(c.contactId)).toMatchObject([{ status: "queued", requested_via: "program", message_id: res.messageId, appointment_id: null }]);
    } finally {
      await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [agent.id]));
    }
  });
});

describe("a person's hold, the shared limits, and other workspaces", () => {
  it("honours a person's explicit hold: an excluded customer is never enrolled or sent a link, and the hold is audited with its reason", async () => {
    const c = await attended();
    await run(c.contactId);
    await setRetentionPaused(owner(), c.contactId, true, "Dispute about the invoice");
    expect(await enrollmentOf(c.contactId)).toMatchObject({ status: "cancelled", cancel_reason: "contact_excluded" });
    expect((await requestsOf(c.contactId))[0]).toMatchObject({ status: "cancelled" });
    expect(await one("select metadata->>'reason' as reason from audit_logs where org_id = $1 and target_id = $2 and action = 'contact.retention_paused'", [s.m.org.id, c.contactId])).toEqual({ reason: "Dispute about the invoice" });
    const later = await attended();
    await setRetentionPaused(owner(), later.contactId, true, "Asked us not to message them");
    await enrollEligible();
    expect(await enrollmentOf(later.contactId)).toBeUndefined();
  });

  it("queues behind another program message for the same customer instead of going out with it, and the link works when it is finally sent", async () => {
    await approve("service_followup", "Hi {name}, thanks for visiting {business}. Reply here if you need anything.", 1);
    const c = await attended();
    await enrollEligible();
    // One after the other, so which is first is not left to the order the database hands steps back in.
    const dueNow = (kind: ProgramKind) => withSystem((db) => db.query(
      `update retention_steps st set due_at = now() - interval '1 hour' from retention_enrollments e join retention_programs p on p.id = e.program_id
       where st.enrollment_id = e.id and e.contact_id = $1 and p.kind = $2`, [c.contactId, kind]));
    await dueNow("service_followup");
    await prepareDueSteps({ now: hours(1), limit: 100 });
    const plain = await stepOf(c.contactId, "service_followup");
    expect(plain.status).toBe("queued");
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: hours(1), limit: 100 });
    await dueNow("feedback_request");
    await prepareDueSteps({ now: hours(1), limit: 100 });
    const linked = await stepOf(c.contactId, "feedback_request");
    expect(linked.status).toBe("queued");
    await dispatchDue({ transport: rec.transport, now: hours(1), limit: 100 });
    const sentNow = (id: string | null) => rec.calls.filter((x) => x.messageId === id).length;
    expect(sentNow(plain.message_id)).toBe(1);
    // The second program message waits out the minimum spacing; its request exists and is not counted as sent.
    expect(sentNow(linked.message_id)).toBe(0);
    expect(new Date((await messageOf(linked.message_id)).send_after).getTime()).toBeGreaterThanOrEqual(hours(1).getTime() + 70 * 3_600_000);
    expect(await requestsOf(c.contactId)).toMatchObject([{ status: "queued", message_id: linked.message_id }]);
    await dispatchDue({ transport: rec.transport, now: hours(80), limit: 100 });
    expect(sentNow(linked.message_id)).toBe(1);
    const token = await tokenOf((await requestsOf(c.contactId))[0].id);
    expect(rec.calls.find((x) => x.messageId === linked.message_id)!.body).toContain(`/r/${token}`);
    await setProgramEnabled(s.m.ctx("manager"), "service_followup", false);
  });

  it("keeps each workspace's links, customers and requests to itself", async () => {
    const t = await reputationShop("Other Link Shop");
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'crm_manager'", [t.m.org.id]));
    expect(await saveProgram(t.m.ctx("manager"), "feedback_request", { steps: [{ key: "feedback", delayDays: 1, body: "Hello {name} from {business}: {feedback_link}" }] })).toEqual({ ok: true });
    await setProgramEnabled(t.m.ctx("owner"), "feedback_request", true);
    const mine = await attended();
    const contactId = await shopCustomer(t);
    await one(
      `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, last_event_at)
       values ($1, $2, 'cal_link_0002', 'Visit', 'showed', now() - interval '2 hours', now() - interval '90 minutes', $3, now() + interval '1 minute') returning id`,
      [t.m.org.id, `link_${crypto.randomUUID()}`, contactId],
    );
    await run(mine.contactId);
    await run(contactId);
    const theirs = (await all<{ id: string; org_id: string }>("select id, org_id from crm_review_requests where contact_id = $1", [contactId]))[0];
    expect(theirs.org_id).toBe(t.m.org.id);
    const page = await loadReviewPage(await tokenOf(theirs.id));
    expect(page.business?.name).toBe("Other Link Shop");
    expect(page.destinations.map((d) => d.id)).toEqual([t.google, t.facebook]);
    expect((await loadReviewPage(await tokenOf((await requestsOf(mine.contactId))[0].id))).business?.name).toBe("Link Shop");
    expect((await requestsOf(mine.contactId)).every((r) => r.id !== theirs.id)).toBe(true);
  });
});
