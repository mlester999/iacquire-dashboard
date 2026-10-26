// Review request batches, the service side: preparing a batch, the preview of who would be asked and who would not (and why), the owner's approval bound to what they were shown,
// pause, resume and cancel, who may do what, and that one workspace never sees or touches another's. Synthetic workspaces on embedded Postgres; nothing is sent.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { createTemplate, approveTemplate, updateTemplate } from "@/server/crm/message-templates";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { requestReview, reviewRequestProblem } from "@/server/crm/reviews";
import { suppressAddress } from "@/server/messaging/contacts";
import {
  approveBatch, assess, batchBuilderOptions, batchesStatus, cancelBatch, createBatch, duplicateBatch, getBatch, listBatchPeople, listBatches, pauseBatch, previewBatch, requestBatchApproval,
  resumeBatch, returnBatch, updateBatch,
} from "@/server/reputation/batches";
import { setBatchesEnabled } from "@/server/reputation/entitlement";
import { MAX_OPEN_BATCHES, MAX_BATCH_PEOPLE } from "@/lib/reputation/batches";
import { agencyPeople } from "./support/crm";
import { createOrg } from "./support/fixtures";
import { all, attend, batchInput, calendarWithType, count, dayAgo, one, pipelineFor, reputationShop, setBatches, shopCustomer, winDeal, type ReputationShop } from "./support/reputation";

// Several tests make a dozen customers, calendars and templates first, and the whole suite is run with many other files at once.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function expectError(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; message?: string });
  expect(err, "expected a refusal").not.toBeNull();
  expect(err?.code).toBe(code);
  if (message) expect(err?.message).toMatch(message);
}

let s: ReputationShop;
beforeAll(async () => {
  s = await reputationShop("Batch Shop");
  await setBatches(s.m.org.id, true);
});

/** What an approval of this batch would cover right now, whether or not the preview would offer it (null when the batch can't be read well enough to bind). */
const fingerprintOf = (id: string) => withSystem(async (db) => (await assess(db, (await db.query("select * from review_request_batches where id = $1", [id])).rows[0] as never, new Date())).hash);
const phoneOf = async (id: string) => (await one<{ phone: string }>("select phone from contacts where id = $1", [id])).phone;
const batchRow = (id: string) => one<{ status: string; approved_hash: string | null; approval_id: string | null; template_id: string | null; criteria: Record<string, unknown>; requested_by: string | null; rate_per_minute: number; channel: string; kind: string; scale: string }>(
  "select status, approved_hash, approval_id, template_id, criteria, requested_by, rate_per_minute, channel, kind, scale from review_request_batches where id = $1", [id],
);
const audits = (orgId: string, action: string) => count("select count(*)::text as n from audit_logs where org_id = $1 and action = $2", [orgId, action]);

/** A workspace with a mixed customer base, every one of them served in the last few days. */
async function population(shop: ReputationShop) {
  const eligible = await shopCustomer(shop, { firstName: "Elena" });
  const noConsent = await shopCustomer(shop, { consent: false });
  const withdrew = await shopCustomer(shop);
  await setContactConsent(shop.owner, withdrew, { channel: "sms", purpose: "service", status: "revoked", evidence: "Replied STOP in person" });
  const optedOut = await shopCustomer(shop);
  const optedOutPhone = await phoneOf(optedOut);
  await withSystem((db) => suppressAddress(db, { orgId: shop.m.org.id, channel: "sms", address: optedOutPhone, reason: "opt_out", source: "test" }));
  const emailOnly = (await createContact(shop.owner, { firstName: "Eve", lastName: "Emailonly", email: `eve-${Math.random().toString(36).slice(2)}@example.test` })).id;
  await setContactConsent(shop.owner, emailOnly, { channel: "sms", purpose: "service", status: "granted", evidence: "Front desk sign-up sheet, 12 Oct." });
  const askedBefore = await shopCustomer(shop);
  await requestReview(shop.owner, { contactId: askedBefore, templateId: shop.smsTemplate.id, contentHash: shop.smsTemplate.contentHash, businessHoursOnly: false });
  const held = await shopCustomer(shop);
  await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [held]));
  const archived = await shopCustomer(shop);
  await withSystem((db) => db.query("update contacts set archived_at = now() where id = $1", [archived]));
  const removed = await shopCustomer(shop);
  await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [removed]));
  const noShow = await shopCustomer(shop);
  const tooOld = await shopCustomer(shop);
  const ids = { eligible, noConsent, withdrew, optedOut, emailOnly, askedBefore, held, archived, removed, noShow, tooOld };
  for (const id of [eligible, noConsent, withdrew, optedOut, emailOnly, askedBefore, held, archived, removed]) await attend(shop, id);
  await attend(shop, noShow, { status: "noshow" });
  await attend(shop, tooOld, { daysAgo: 90 });
  return ids;
}

describe("a workspace that was not given batches", () => {
  it("can't make one, sees no tab, and the switch is a Super Admin's, audited", async () => {
    const t = await reputationShop("No Batches Shop");
    await expectError(createBatch(t.owner, batchInput(t)), "not_enabled", /aren't switched on/);
    expect(await batchesStatus(t.owner)).toEqual({ enabled: false, any: false });
    expect(await listBatches(t.owner)).toEqual([]);

    await expectError(setBatchesEnabled({ id: t.m.people.owner.id, platformRole: "none" }, t.m.org.id, true), "forbidden", /Super Admin/);
    await expectError(setBatchesEnabled(t.m.superAdmin, "00000000-0000-4000-8000-000000000000", true), "not_found");
    const agency = await createOrg({ name: "Agency Workspace", kind: "agency" });
    await expectError(setBatchesEnabled(t.m.superAdmin, agency.id, true), "invalid_input", /client's own workspace/);
    await setBatchesEnabled(t.m.superAdmin, t.m.org.id, true);
    expect(await batchesStatus(t.owner)).toEqual({ enabled: true, any: false });
    expect(await audits(t.m.org.id, "reputation.batches_enabled")).toBe(1);
    const made = await createBatch(t.owner, batchInput(t));
    // Switched off again: what exists stays visible, nothing new can be made or approved.
    await setBatchesEnabled(t.m.superAdmin, t.m.org.id, false);
    expect(await audits(t.m.org.id, "reputation.batches_disabled")).toBe(1);
    expect(await batchesStatus(t.owner)).toEqual({ enabled: false, any: true });
    expect((await listBatches(t.owner)).map((b) => b.id)).toEqual([made.id]);
    await expectError(createBatch(t.owner, batchInput(t)), "not_enabled");
    await expectError(updateBatch(t.owner, made.id, batchInput(t, { name: "Renamed" })), "not_enabled");
    await expectError(requestBatchApproval(t.owner, made.id, { fingerprint: "a".repeat(64) }), "not_enabled");
    await expectError(approveBatch(t.owner, made.id, { fingerprint: "a".repeat(64) }), "not_enabled");
    // It can still be cancelled by a person.
    await cancelBatch(t.owner, made.id);
    expect((await getBatch(t.owner, made.id)).status).toBe("cancelled");
  });
});

describe("preparing a batch", () => {
  it("saves a draft with the criteria in one canonical shape and writes down who made it", async () => {
    const cal = await calendarWithType(s, "Front desk", "front-desk-1");
    const { id } = await createBatch(s.manager, batchInput(s, { criteria: { source: "appointments_showed", from: dayAgo(30), to: dayAgo(0), calendarIds: [cal.calendarId, cal.calendarId.toUpperCase()] }, ratePerMinute: 20 }));
    const row = await batchRow(id);
    expect(row).toMatchObject({ status: "draft", approved_hash: null, approval_id: null, rate_per_minute: 20, channel: "sms", kind: "review", scale: "csat5", template_id: s.smsTemplate.id });
    expect(row.criteria).toEqual({ source: "appointments_showed", from: dayAgo(30), to: dayAgo(0), calendarIds: [cal.calendarId] });
    const view = await getBatch(s.viewer, id);
    expect(view).toMatchObject({ name: "October visits", status: "draft", createdByName: "Mia Manager", ratePerMinute: 20, approved: false, template: { id: s.smsTemplate.id } });
    expect(view.criteriaText).toMatch(/^Appointments marked attended from \d{1,2} \w{3} \d{4} to \d{1,2} \w{3} \d{4}, on Front desk\.$/);
    expect(await audits(s.m.org.id, "reputation.batch_created")).toBeGreaterThanOrEqual(1);
  });

  it("refuses what does not make sense, with a sentence that says what to fix", async () => {
    await expectError(createBatch(s.owner, batchInput(s, { name: "  " })), "invalid_input", /name/);
    await expectError(createBatch(s.owner, batchInput(s, { name: "x".repeat(121) })), "invalid_input", /120/);
    await expectError(createBatch(s.owner, batchInput(s, { ratePerMinute: 0 })), "invalid_input", /1 to 60/);
    await expectError(createBatch(s.owner, batchInput(s, { ratePerMinute: 61 })), "invalid_input", /1 to 60/);
    await expectError(createBatch(s.owner, batchInput(s, { ratePerMinute: 2.5 })), "invalid_input");
    await expectError(createBatch(s.owner, batchInput(s, { kind: "newsletter" as never })), "invalid_input", /review request or a survey/);
    await expectError(createBatch(s.owner, batchInput(s, { kind: "survey", scale: "nps11" as never })), "invalid_input", /scale/);
    await expectError(createBatch(s.owner, batchInput(s, { criteria: { source: "appointments_showed", from: dayAgo(0), to: dayAgo(30) } })), "invalid_input", /before the first day/);
    await expectError(createBatch(s.owner, batchInput(s, { criteria: { source: "appointments_showed", from: dayAgo(5), to: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) } })), "invalid_input", /in the future/);
    await expectError(createBatch(s.owner, batchInput(s, { criteria: { source: "appointments_showed", from: dayAgo(400), to: dayAgo(0) } })), "invalid_input", /at most 366 days/);
    await expectError(createBatch(s.owner, batchInput(s, { criteria: null })), "invalid_input");
    await expectError(createBatch(s.owner, batchInput(s, { templateId: "nope" })), "invalid_input", /approved message template/);
    await expectError(createBatch(s.owner, batchInput(s, { templateId: "00000000-0000-4000-8000-000000000000" })), "invalid_input", /isn't approved/);
  });

  it("can't be chosen by how anyone felt: a rating, a score, a comment, an escalation or a status in the criteria is refused, and nothing is stored", async () => {
    const before = await count("select count(*)::text as n from review_request_batches where org_id = $1", [s.m.org.id]);
    for (const key of ["rating", "minRating", "nps", "score", "sentiment", "feedback", "followUpStatus", "lowScore", "escalated", "complaint", "leadScore", "tags", "status"]) {
      await expectError(createBatch(s.owner, batchInput(s, { criteria: { source: "appointments_showed", from: dayAgo(30), to: dayAgo(0), [key]: 5 } })), "invalid_input", /never depends on how someone felt/);
    }
    expect(await count("select count(*)::text as n from review_request_batches where org_id = $1", [s.m.org.id])).toBe(before);
  });

  it("only takes the wording of a template that is approved, a service message and carries the customer's link", async () => {
    const draft = await createTemplate(s.owner, { name: "Never approved", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, how did we do? {{review.link}}" });
    await expectError(createBatch(s.owner, batchInput(s, { templateId: draft.id })), "invalid_input", /isn't approved/);
    const noLink = await createTemplate(s.owner, { name: "No link", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, thanks for coming." });
    await approveTemplate(s.owner, noLink.id, { version: noLink.currentVersion, contentHash: noLink.contentHash });
    await expectError(createBatch(s.owner, batchInput(s, { templateId: noLink.id })), "invalid_input", /\{\{review\.link\}\}/);
    const promo = await createTemplate(s.owner, { name: "Marketing link", channel: "sms", purpose: "marketing", body: "Hi {{contact.first_name}}, review us: {{review.link}}" });
    await approveTemplate(s.owner, promo.id, { version: promo.currentVersion, contentHash: promo.contentHash });
    await expectError(createBatch(s.owner, batchInput(s, { templateId: promo.id })), "invalid_input", /service messages/);
  });

  it("only names calendars, appointment types and pipelines of its own workspace", async () => {
    const other = await reputationShop("Other Batch Shop");
    const foreign = await calendarWithType(other, "Their desk", "their-desk");
    const foreignPipeline = await pipelineFor(other, "Their sales");
    await expectError(createBatch(s.owner, batchInput(s, { criteria: { source: "appointments_showed", from: dayAgo(30), to: dayAgo(0), calendarIds: [foreign.calendarId] } })), "not_found", /calendar/);
    await expectError(createBatch(s.owner, batchInput(s, { criteria: { source: "appointments_showed", from: dayAgo(30), to: dayAgo(0), appointmentTypeIds: [foreign.typeId] } })), "not_found", /appointment type/);
    await expectError(createBatch(s.owner, batchInput(s, { criteria: { source: "deals_won", from: dayAgo(30), to: dayAgo(0), pipelineId: foreignPipeline } })), "not_found", /pipeline/);
    // The template of another workspace is just as unknown.
    await expectError(createBatch(s.owner, batchInput(s, { templateId: other.smsTemplate.id })), "invalid_input", /isn't approved/);
  });

  it("keeps at most 20 batches that have not finished", async () => {
    const t = await reputationShop("Crowded Shop");
    await setBatches(t.m.org.id, true);
    for (let i = 0; i < MAX_OPEN_BATCHES; i += 1) await createBatch(t.owner, batchInput(t, { name: `Batch ${i}` }));
    await expectError(createBatch(t.owner, batchInput(t)), "conflict", /20 batches/);
    const first = (await listBatches(t.owner)).at(-1)!;
    await cancelBatch(t.owner, first.id);
    await createBatch(t.owner, batchInput(t, { name: "One more" }));
  });

  it("changes a draft, and refuses two people saving over each other", async () => {
    const { id } = await createBatch(s.owner, batchInput(s, { name: "To change" }));
    const view = await getBatch(s.owner, id);
    await updateBatch(s.manager, id, { ...batchInput(s, { name: "Changed", ratePerMinute: 30 }), expectedUpdatedAt: view.updatedAt });
    expect(await batchRow(id)).toMatchObject({ rate_per_minute: 30 });
    expect((await getBatch(s.owner, id)).name).toBe("Changed");
    await expectError(updateBatch(s.owner, id, { ...batchInput(s, { name: "Stale" }), expectedUpdatedAt: view.updatedAt }), "conflict", /Someone else changed/);
    await expectError(updateBatch(s.owner, "nope", batchInput(s)), "not_found");
  });

  it("is copied as a fresh draft with no approval", async () => {
    const { id } = await createBatch(s.owner, batchInput(s, { name: "Original", ratePerMinute: 15 }));
    const copy = await duplicateBatch(s.manager, id);
    expect(await batchRow(copy.id)).toMatchObject({ status: "draft", approved_hash: null, approval_id: null, rate_per_minute: 15 });
    expect((await getBatch(s.owner, copy.id)).name).toBe("Copy of Original");
  });
});

describe("who may do what", () => {
  it("lets owners and managers prepare; everyone who can open contacts look; nobody else do either", async () => {
    const { id } = await createBatch(s.owner, batchInput(s, { name: "Roles" }));
    for (const who of [s.sales, s.support, s.viewer]) {
      await expectError(createBatch(who, batchInput(s)), "forbidden");
      await expectError(updateBatch(who, id, batchInput(s)), "forbidden");
      await expectError(pauseBatch(who, id), "forbidden");
      await expectError(cancelBatch(who, id), "forbidden");
      await expectError(approveBatch(who, id, { fingerprint: "a".repeat(64) }), "forbidden");
      await expectError(requestBatchApproval(who, id, { fingerprint: "a".repeat(64) }), "forbidden");
      expect((await getBatch(who, id)).id).toBe(id);
      expect((await listBatches(who)).some((b) => b.id === id)).toBe(true);
      expect((await previewBatch(who, id)).batchId).toBe(id);
    }
    await createBatch(s.manager, batchInput(s, { name: "By the manager" }));
  });

  it("lets iAcquire support look at a batch, never prepare, approve, pause or cancel one", async () => {
    const { id } = await createBatch(s.owner, batchInput(s, { name: "Support look" }));
    const { superAdmin } = await agencyPeople();
    for (const mode of ["read", "write"] as const) {
      await startSupportSession(superAdmin, s.m.org.id, { mode, reason: `Looking at batches (${mode})` });
      const agency = await agencyActor(superAdmin, s.m.org.id);
      expect((await getBatch(agency, id)).id).toBe(id);
      expect((await previewBatch(agency, id)).batchId).toBe(id);
      expect((await listBatches(agency)).some((b) => b.id === id)).toBe(true);
      await expectError(createBatch(agency, batchInput(s)), "forbidden", mode === "read" ? /read-only/ : /client's own workspace/);
      await expectError(updateBatch(agency, id, batchInput(s)), "forbidden");
      await expectError(requestBatchApproval(agency, id, { fingerprint: "a".repeat(64) }), "forbidden");
      await expectError(approveBatch(agency, id, { fingerprint: "a".repeat(64) }), "forbidden");
      await expectError(pauseBatch(agency, id), "forbidden");
      await expectError(resumeBatch(agency, id), "forbidden");
      await expectError(cancelBatch(agency, id), "forbidden");
      await expectError(duplicateBatch(agency, id), "forbidden");
    }
    expect((await batchRow(id)).status).toBe("draft");
  });
});

describe("the preview", () => {
  let ids: Awaited<ReturnType<typeof population>>;
  let t: ReputationShop;
  beforeAll(async () => {
    t = await reputationShop("Preview Shop");
    await setBatches(t.m.org.id, true);
    ids = await population(t);
  });

  it("counts who would be asked and who would not, by the first rule that applies, and leaves out contacts that are archived or removed or not served in the dates", async () => {
    const { id } = await createBatch(t.owner, batchInput(t));
    const p = await previewBatch(t.owner, id);
    expect(p.problems).toEqual([]);
    expect(p.canApprove).toBe(true);
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Seven people were served and not archived or removed: one can be asked, six cannot.
    expect(p.audience).toEqual({
      total: 7, eligible: 1, tooLarge: false,
      excluded: { no_consent: 1, consent_withdrawn: 1, suppressed: 1, no_address: 1, recently_requested: 1, held_by_person: 1 },
    });
    expect(p.sample.eligible.map((x) => x.id)).toEqual([ids.eligible]);
    expect(new Map(p.sample.excluded.map((x) => [x.id, x.reason]))).toEqual(new Map([
      [ids.noConsent, "no_consent"], [ids.withdrew, "consent_withdrawn"], [ids.optedOut, "suppressed"], [ids.emailOnly, "no_address"], [ids.askedBefore, "recently_requested"], [ids.held, "held_by_person"],
    ]));
    for (const gone of [ids.archived, ids.removed, ids.noShow, ids.tooOld]) {
      expect(p.sample.eligible.concat(p.sample.excluded as never).some((x) => x.id === gone), gone).toBe(false);
    }
    expect(p.template).toMatchObject({ id: t.smsTemplate.id, name: "How did we do", version: 1 });
    expect(p.message?.forName).toContain("Elena");
    expect(p.message?.body).toContain("Hi Elena, thanks for visiting Preview Shop. How did we do? [review link]");
    expect(p.minutes).toBe(1);
  });

  it("applies the rules the send path applies: for every customer the preview and a single review request agree (a parity check)", async () => {
    const { id } = await createBatch(t.owner, batchInput(t));
    const p = await previewBatch(t.owner, id);
    const outcome = new Map<string, string>([...p.sample.eligible.map((x) => [x.id, "eligible"] as const), ...p.sample.excluded.map((x) => [x.id, x.reason] as const)]);
    for (const [name, contactId] of Object.entries(ids)) {
      const single = await withSystem((db) => reviewRequestProblem(db, t.m.org.id, { contactId, templateId: t.smsTemplate.id, contentHash: t.smsTemplate.contentHash }));
      const inPreview = outcome.get(contactId);
      if (["archived", "removed", "noShow", "tooOld"].includes(name)) {
        expect(inPreview, name).toBeUndefined();
        continue;
      }
      // The held customer is the one deliberate difference: a person pressing Send is not stopped by a hold on automatic messages; an automatic ask is.
      const expected = single === null ? (name === "held" ? "held_by_person" : "eligible")
        : ({ contact_unreachable: "no_address", suppressed: "suppressed", recently_requested: "recently_requested" } as Record<string, string>)[single.reason] ?? (single.reason === "no_consent" ? (name === "withdrew" ? "consent_withdrawn" : "no_consent") : single.reason);
      expect(inPreview, `${name}: the single request says ${single?.reason ?? "fine"}`).toBe(name === "held" ? "held_by_person" : expected);
    }
  });

  it("does not count a customer who was served only in someone else's workspace", async () => {
    const other = await reputationShop("Neighbour Shop");
    await setBatches(other.m.org.id, true);
    const theirs = await shopCustomer(other);
    await attend(other, theirs);
    const { id } = await createBatch(t.owner, batchInput(t));
    const p = await previewBatch(t.owner, id);
    expect(p.audience.total).toBe(7);
    expect(JSON.stringify(p)).not.toContain(theirs);
  });

  it("chooses the people by the service chosen: deals won (narrowed to a pipeline) and customers since a date", async () => {
    const won = await shopCustomer(t, { firstName: "Wanda" });
    const lost = await shopCustomer(t);
    const pipeline = await pipelineFor(t, "Sales");
    const other = await pipelineFor(t, "Renewals");
    await winDeal(t, won, { pipelineId: pipeline });
    await winDeal(t, lost, { pipelineId: pipeline, status: "lost" });
    const wonElsewhere = await shopCustomer(t);
    await winDeal(t, wonElsewhere, { pipelineId: other });
    const base = { from: dayAgo(30), to: dayAgo(0) };
    const everyone = await createBatch(t.owner, batchInput(t, { criteria: { source: "deals_won", ...base } }));
    expect((await previewBatch(t.owner, everyone.id)).audience).toMatchObject({ total: 2, eligible: 2 });
    const narrowed = await createBatch(t.owner, batchInput(t, { criteria: { source: "deals_won", ...base, pipelineId: pipeline } }));
    const pv = await previewBatch(t.owner, narrowed.id);
    expect(pv.audience).toMatchObject({ total: 1, eligible: 1 });
    expect(pv.sample.eligible.map((x) => x.id)).toEqual([won]);

    const newcomer = await shopCustomer(t, { firstName: "Nia" });
    await withSystem((db) => db.query("update contacts set lifecycle_stage = 'customer', customer_since = now() - interval '2 days' where id = $1", [newcomer]));
    const since = await createBatch(t.owner, batchInput(t, { criteria: { source: "customers_since", ...base } }));
    const sv = await previewBatch(t.owner, since.id);
    expect(sv.sample.eligible.map((x) => x.id)).toContain(newcomer);
    expect(sv.audience.total).toBe(1);
  });

  it("narrows appointments to the calendars and appointment types chosen", async () => {
    const front = await calendarWithType(t, "Front desk", "preview-front");
    const clinic = await calendarWithType(t, "Clinic", "preview-clinic", "Surgery");
    const a = await shopCustomer(t, { firstName: "Alma" });
    const b = await shopCustomer(t, { firstName: "Bea" });
    await attend(t, a, { calendarId: front.calendarId, typeId: front.typeId });
    await attend(t, b, { calendarId: clinic.calendarId, typeId: clinic.typeId });
    const base = { source: "appointments_showed", from: dayAgo(30), to: dayAgo(0) };
    const onFront = await createBatch(t.owner, batchInput(t, { criteria: { ...base, calendarIds: [front.calendarId] } }));
    expect((await previewBatch(t.owner, onFront.id)).sample.eligible.map((x) => x.id)).toEqual([a]);
    const surgery = await createBatch(t.owner, batchInput(t, { criteria: { ...base, appointmentTypeIds: [clinic.typeId] } }));
    expect((await previewBatch(t.owner, surgery.id)).sample.eligible.map((x) => x.id)).toEqual([b]);
    const both = await createBatch(t.owner, batchInput(t, { criteria: { ...base, calendarIds: [front.calendarId, clinic.calendarId] } }));
    expect((await previewBatch(t.owner, both.id)).audience.total).toBe(2);
    const options = await batchBuilderOptions(t.owner);
    expect(options.calendars.map((c) => c.name)).toEqual(expect.arrayContaining(["Front desk", "Clinic"]));
    expect(options.appointmentTypes.find((x) => x.name === "Surgery")).toMatchObject({ calendarName: "Clinic" });
  });

  it("uses the workspace's own days for the window: a visit late on the last day is in, one just after is out", async () => {
    const u = await reputationShop("Window Shop");
    await setBatches(u.m.org.id, true);
    await withSystem((db) => db.query("update organizations set timezone = 'Pacific/Auckland' where id = $1", [u.m.org.id]));
    const inside = await shopCustomer(u);
    const outside = await shopCustomer(u);
    // Auckland is 12 or 13 hours ahead of UTC. Pick a day in the past and put one visit at 23:30 that day there, one at 00:30 the next day there.
    const lastDay = dayAgo(3);
    const at = async (contact: string, local: string) => withSystem((db) => db.query(
      `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id)
       values ($1, $2, 'cal_tz', 'Visit', 'showed', ($3::timestamp at time zone 'Pacific/Auckland') - interval '30 minutes', ($3::timestamp at time zone 'Pacific/Auckland'), $4)`,
      [u.m.org.id, `tz_${Math.random().toString(36).slice(2)}`, local, contact],
    ));
    await at(inside, `${lastDay} 23:30:00`);
    const next = new Date(new Date(`${lastDay}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    await at(outside, `${next} 00:30:00`);
    const { id } = await createBatch(u.owner, batchInput(u, { criteria: { source: "appointments_showed", from: dayAgo(10), to: lastDay } }), { now: new Date() });
    const p = await previewBatch(u.owner, id);
    expect(p.audience.total).toBe(1);
    expect(p.sample.eligible.map((x) => x.id)).toEqual([inside]);
  });

  it("refuses to approve a batch nobody could be asked in, or one that matches nobody, and says so", async () => {
    const u = await reputationShop("Empty Shop");
    await setBatches(u.m.org.id, true);
    const none = await createBatch(u.owner, batchInput(u));
    const p = await previewBatch(u.owner, none.id);
    expect(p).toMatchObject({ fingerprint: null, canApprove: false, problems: ["Nobody matches these choices. Check the dates and what they are for."] });
    const c = await shopCustomer(u, { consent: false });
    await attend(u, c);
    const noConsent = await previewBatch(u.owner, none.id);
    expect(noConsent.problems).toEqual(["Nobody who matches can be asked right now. See why below."]);
    expect(noConsent.audience.excluded).toEqual({ no_consent: 1 });
    // Even with the fingerprint an approval would cover, a batch nobody can be asked in is not sent to the owner.
    await expectError(requestBatchApproval(u.owner, none.id, { fingerprint: (await fingerprintOf(none.id))! }), "invalid_input", /Nobody who matches can be asked/);
  });

  it("refuses a batch bigger than one batch may be, rather than sending part of it", async () => {
    const u = await reputationShop("Big Shop");
    await setBatches(u.m.org.id, true);
    const { id } = await createBatch(u.owner, batchInput(u));
    await withSystem(async (db) => {
      await db.query(
        `with c as (insert into contacts (org_id, display_name) select $1, 'Bulk ' || g from generate_series(1, $2::int) g returning id)
         insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id)
         select $1, 'bulk_' || c.id, 'cal_bulk', 'Visit', 'showed', now() - interval '3 days', now() - interval '3 days' + interval '30 minutes', c.id from c`,
        [u.m.org.id, MAX_BATCH_PEOPLE + 5],
      );
    });
    const p = await previewBatch(u.owner, id);
    expect(p.audience.tooLarge).toBe(true);
    expect(p.audience.total).toBe(MAX_BATCH_PEOPLE);
    expect(p.fingerprint).toBeNull();
    expect(p.problems.join(" ")).toContain("More than 1,000 people match");
  }, 60_000);
});

describe("what can stop a batch from being approved", () => {
  async function shopWith(name: string) {
    const u = await reputationShop(name);
    await setBatches(u.m.org.id, true);
    const c = await shopCustomer(u);
    await attend(u, c);
    return { u, c };
  }

  it("an edit to the template takes its approval away until someone approves the new wording, and the new wording has a new fingerprint", async () => {
    const { u } = await shopWith("Edited Shop");
    const { id } = await createBatch(u.owner, batchInput(u));
    const before = await previewBatch(u.owner, id);
    expect(before.canApprove).toBe(true);
    await updateTemplate(u.owner, u.smsTemplate.id, { body: "Hi {{contact.first_name}}, a new draft we have not approved. {{review.link}}" });
    // Nothing unapproved is ever used: the batch can't go anywhere until the new wording is approved.
    const during = await previewBatch(u.owner, id);
    expect(during).toMatchObject({ fingerprint: null, canApprove: false, template: null, message: null });
    expect(during.problems[0]).toMatch(/no longer approved/);
    const v = await one<{ current_version: number; content_hash: string }>("select t.current_version, v.content_hash from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.id = $1", [u.smsTemplate.id]);
    await approveTemplate(u.owner, u.smsTemplate.id, { version: v.current_version, contentHash: v.content_hash });
    const after = await previewBatch(u.owner, id);
    expect(after.template?.version).toBe(2);
    expect(after.message?.body).toContain("a new draft we have not approved");
    expect(after.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("a template that is no longer approved, has no link or became a marketing message each stop it with a plain reason, and a single request is refused for the same reason", async () => {
    const { u, c } = await shopWith("Defects Shop");
    const { id } = await createBatch(u.owner, batchInput(u));
    const noLink = await createTemplate(u.owner, { name: "No link", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, thanks for coming." });
    await approveTemplate(u.owner, noLink.id, { version: noLink.currentVersion, contentHash: noLink.contentHash });
    const promo = await createTemplate(u.owner, { name: "Promo link", channel: "sms", purpose: "marketing", body: "Hi {{contact.first_name}}, review us {{review.link}}" });
    await approveTemplate(u.owner, promo.id, { version: promo.currentVersion, contentHash: promo.contentHash });
    const point = (templateId: string) => withSystem((db) => db.query("update review_request_batches set template_id = $2 where id = $1", [id, templateId]));
    const single = (templateId: string) => withSystem((db) => reviewRequestProblem(db, u.m.org.id, { contactId: c, templateId }));

    await point(noLink.id);
    expect((await previewBatch(u.owner, id)).problems[0]).toMatch(/doesn't contain \{\{review\.link\}\}/);
    expect(await single(noLink.id)).toMatchObject({ reason: "no_review_link" });
    await point(promo.id);
    expect((await previewBatch(u.owner, id)).problems[0]).toMatch(/service messages/);
    expect(await single(promo.id)).toMatchObject({ reason: "marketing_template" });

    await point(u.smsTemplate.id);
    await withSystem((db) => db.query("update crm_message_templates set status = 'draft', approved_version = null, approved_by = null, approved_at = null where id = $1", [u.smsTemplate.id]));
    const p = await previewBatch(u.owner, id);
    expect(p.problems[0]).toMatch(/no longer approved/);
    expect(p).toMatchObject({ fingerprint: null, template: null, canApprove: false });
    const a = await withSystem(async (db) => assess(db, (await db.query("select * from review_request_batches where id = $1", [id])).rows[0] as never, new Date()));
    expect(a.hash).toBeNull();
    expect(await single(u.smsTemplate.id)).toMatchObject({ reason: "template_changed" });
  });

  it("wording that offers something is refused even if it got into an approved template some other way, as a single request refuses it", async () => {
    const { u, c } = await shopWith("Offer Shop");
    const { id } = await createBatch(u.owner, batchInput(u));
    expect((await previewBatch(u.owner, id)).canApprove).toBe(true);
    // Saved versions are frozen, so getting an offer into one takes switching the freeze off for this one change (the wording was fine when it was approved, or came in by an import).
    await withSystem(async (db) => {
      await db.query("alter table crm_message_template_versions disable trigger crm_message_template_versions_frozen");
      await db.query("update crm_message_template_versions set body = body || ' Get 10% off your next visit.' where template_id = $1", [u.smsTemplate.id]);
      await db.query("alter table crm_message_template_versions enable trigger crm_message_template_versions_frozen");
    });
    const p = await previewBatch(u.owner, id);
    expect(p).toMatchObject({ canApprove: false, fingerprint: null });
    expect(p.problems[0]).toContain("Remove “10% off”");
    expect(await withSystem((db) => reviewRequestProblem(db, u.m.org.id, { contactId: c, templateId: u.smsTemplate.id }))).toMatchObject({ reason: "incentive_wording" });
  });

  it("no public review link means a review request has nothing to point to; a survey does not need one", async () => {
    const { u } = await shopWith("No Links Shop");
    const review = await createBatch(u.owner, batchInput(u));
    const survey = await createBatch(u.owner, batchInput(u, { kind: "survey", name: "Survey" }));
    await withSystem((db) => db.query("update crm_review_destinations set active = false where org_id = $1", [u.m.org.id]));
    expect((await previewBatch(u.owner, review.id)).problems).toEqual(["Add at least one public review link first. Every customer you ask sees the same links."]);
    expect((await previewBatch(u.owner, survey.id)).problems).toEqual([]);
  });

  it("a survey is dormant until surveys are switched on for the workspace", async () => {
    const { u } = await shopWith("Survey Dormant Shop");
    const survey = await createBatch(u.owner, batchInput(u, { kind: "survey", scale: "nps10", name: "Survey" }));
    expect((await previewBatch(u.owner, survey.id)).problems).toEqual([]);
    await withSystem((db) => db.query("update org_features set enabled = false where org_id = $1 and feature = 'reputation_surveys'", [u.m.org.id]));
    const p = await previewBatch(u.owner, survey.id);
    expect(p.canApprove).toBe(false);
    expect(p.problems[0]).toMatch(/Satisfaction surveys aren't switched on/);
    expect(await batchRow(survey.id)).toMatchObject({ kind: "survey", scale: "nps10" });
  });
});

describe("the owner's approval", () => {
  let t: ReputationShop;
  beforeAll(async () => {
    t = await reputationShop("Approval Shop");
    await setBatches(t.m.org.id, true);
    await population(t);
  });

  it("goes from the manager to the owner, who approves exactly what they were shown", async () => {
    const { id } = await createBatch(t.manager, batchInput(t, { name: "For approval" }));
    const p = await previewBatch(t.manager, id);
    // The manager can ask but not approve.
    await expectError(approveBatch(t.manager, id, { fingerprint: p.fingerprint! }), "forbidden", /Only the business owner/);
    expect(await requestBatchApproval(t.manager, id, { fingerprint: p.fingerprint! })).toEqual({ status: "requested" });
    expect(await requestBatchApproval(t.manager, id, { fingerprint: p.fingerprint! })).toEqual({ status: "already_requested" });
    expect(await batchRow(id)).toMatchObject({ status: "awaiting_approval", approved_hash: null, requested_by: t.m.people.manager.id });
    expect(await one<{ n: string }>("select count(*)::text as n from notifications where org_id = $1 and kind = 'approval_requested' and user_id = $2 and title like '%For approval%'", [t.m.org.id, t.m.people.owner.id])).toEqual({ n: "1" });
    expect(await one<{ n: string }>("select count(*)::text as n from notifications where org_id = $1 and kind = 'approval_requested' and user_id = $2", [t.m.org.id, t.m.people.manager.id])).toEqual({ n: "0" });

    // The owner is shown the same fingerprint, and approving a different one is refused.
    expect((await previewBatch(t.owner, id)).fingerprint).toBe(p.fingerprint);
    await expectError(approveBatch(t.owner, id, { fingerprint: "f".repeat(64) }), "conflict", /changed since you looked/);
    expect(await batchRow(id)).toMatchObject({ status: "awaiting_approval" });
    const done = await approveBatch(t.owner, id, { fingerprint: p.fingerprint! });
    expect(done).toEqual({ eligible: 1, minutes: 1 });

    const row = await batchRow(id);
    expect(row).toMatchObject({ status: "approved", approved_hash: p.fingerprint });
    const approval = await one<{ status: string; kind: string; decided_by: string; expires_at: Date }>("select status, kind, decided_by, expires_at from approval_requests where id = $1", [row.approval_id]);
    expect(approval).toMatchObject({ status: "approved", kind: "standing_authorization", decided_by: t.m.people.owner.id });
    expect(new Date(approval.expires_at).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(new Date(approval.expires_at).getTime()).toBeLessThan(Date.now() + 15 * 86_400_000);
    const stored = await one<{ approved_binding: Record<string, unknown>; approved_by: string }>("select approved_binding, approved_by from review_request_batches where id = $1", [id]);
    expect(stored.approved_by).toBe(t.m.people.owner.id);
    expect(stored.approved_binding).toMatchObject({ kind: "review", channel: "sms", templateId: t.smsTemplate.id, templateVersion: 1, ratePerMinute: 10, businessValues: { "business.name": "Approval Shop" } });
    expect(stored.approved_binding.criteria).toMatchObject({ source: "appointments_showed" });
    expect(await audits(t.m.org.id, "reputation.batch_approved")).toBeGreaterThanOrEqual(1);
    expect(await audits(t.m.org.id, "reputation.batch_approval_requested")).toBeGreaterThanOrEqual(1);
    // The requester hears about the decision; nothing was sent.
    expect(await one<{ n: string }>("select count(*)::text as n from notifications where org_id = $1 and kind = 'approval_decided' and user_id = $2", [t.m.org.id, t.m.people.manager.id])).toEqual({ n: "1" });
    expect(await count("select count(*)::text as n from crm_review_requests where batch_id = $1", [id])).toBe(0);
    expect(await count("select count(*)::text as n from review_request_batch_items where batch_id = $1", [id])).toBe(0);
    // It can't be approved twice, changed, or sent for approval again.
    await expectError(approveBatch(t.owner, id, { fingerprint: p.fingerprint! }), "conflict", /already decided/);
    await expectError(updateBatch(t.owner, id, batchInput(t, { name: "Too late" })), "conflict", /approved or has finished/);
    await expectError(requestBatchApproval(t.manager, id, { fingerprint: p.fingerprint! }), "conflict", /Only a draft/);
  });

  it("lets the owner approve a draft straight away", async () => {
    const { id } = await createBatch(t.owner, batchInput(t, { name: "Owner's own" }));
    const p = await previewBatch(t.owner, id);
    await approveBatch(t.owner, id, { fingerprint: p.fingerprint! });
    expect((await getBatch(t.viewer, id))).toMatchObject({ status: "approved", approved: true, approvedByName: "Olivia Owner" });
  });

  it("is withdrawn when the batch is changed in a way the owner would notice, but not for a rename", async () => {
    const { id } = await createBatch(t.manager, batchInput(t, { name: "Changing" }));
    const p = await previewBatch(t.manager, id);
    await requestBatchApproval(t.manager, id, { fingerprint: p.fingerprint! });
    await updateBatch(t.manager, id, batchInput(t, { name: "Renamed only" }));
    expect((await batchRow(id)).status).toBe("awaiting_approval");
    const r = await updateBatch(t.manager, id, batchInput(t, { name: "Renamed only", ratePerMinute: 30 }));
    expect(r.returnedToDraft).toBe(true);
    expect(await batchRow(id)).toMatchObject({ status: "draft", requested_by: null, rate_per_minute: 30 });
    expect((await getBatch(t.manager, id)).counts.notice?.code).toBe("returned");
    // The owner can no longer approve what was asked for before.
    await expectError(approveBatch(t.owner, id, { fingerprint: p.fingerprint! }), "conflict", /changed since you looked/);
  });

  it("is refused when the wording changed between the look and the decision", async () => {
    const u = await reputationShop("Drift Shop");
    await setBatches(u.m.org.id, true);
    await attend(u, await shopCustomer(u));
    const { id } = await createBatch(u.owner, batchInput(u));
    const p = await previewBatch(u.owner, id);
    await updateTemplate(u.owner, u.smsTemplate.id, { body: "Hi {{contact.first_name}}, one more thing. {{review.link}}" });
    const v = await one<{ current_version: number; content_hash: string }>("select t.current_version, v.content_hash from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.version = t.current_version where t.id = $1", [u.smsTemplate.id]);
    await approveTemplate(u.owner, u.smsTemplate.id, { version: v.current_version, contentHash: v.content_hash });
    await expectError(approveBatch(u.owner, id, { fingerprint: p.fingerprint! }), "conflict", /changed since you looked/);
    expect((await batchRow(id)).status).toBe("draft");
  });

  it("is refused when a business detail the wording uses is empty, and when it changes between the look and the decision", async () => {
    const u = await reputationShop("Value Shop");
    await setBatches(u.m.org.id, true);
    await attend(u, await shopCustomer(u));
    const phoneTemplate = await createTemplate(u.owner, { name: "With phone", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, how did we do? Call {{business.phone}} or {{review.link}}" });
    await approveTemplate(u.owner, phoneTemplate.id, { version: phoneTemplate.currentVersion, contentHash: phoneTemplate.contentHash });
    const { id } = await createBatch(u.owner, batchInput(u, { templateId: phoneTemplate.id }));
    expect((await previewBatch(u.owner, id)).problems[0]).toMatch(/isn't filled in yet/);
    await withSystem((db) => db.query("insert into company_profiles (org_id, contact_phone) values ($1, '+639170000001') on conflict (org_id) do update set contact_phone = excluded.contact_phone", [u.m.org.id]));
    const p = await previewBatch(u.owner, id);
    expect(p.problems).toEqual([]);
    await withSystem((db) => db.query("update company_profiles set contact_phone = '+639170000002' where org_id = $1", [u.m.org.id]));
    await expectError(approveBatch(u.owner, id, { fingerprint: p.fingerprint! }), "conflict", /changed since you looked/);
  });

  it("is sent back by the owner with a note, and the author is told", async () => {
    const { id } = await createBatch(t.manager, batchInput(t, { name: "Not yet" }));
    const p = await previewBatch(t.manager, id);
    await expectError(returnBatch(t.owner, id, "Too soon"), "conflict", /isn't waiting/);
    await requestBatchApproval(t.manager, id, { fingerprint: p.fingerprint! });
    await expectError(returnBatch(t.manager, id, "Mine"), "forbidden");
    await returnBatch(t.owner, id, "Wait until after the holiday");
    expect(await batchRow(id)).toMatchObject({ status: "draft", requested_by: null });
    expect((await getBatch(t.owner, id)).counts.notice).toMatchObject({ code: "returned", detail: "The owner sent it back: “Wait until after the holiday”" });
    expect(await one<{ n: string }>("select count(*)::text as n from notifications where org_id = $1 and kind = 'approval_decided' and user_id = $2 and title like '%Not yet%'", [t.m.org.id, t.m.people.manager.id])).toEqual({ n: "1" });
    expect(await audits(t.m.org.id, "reputation.batch_returned")).toBeGreaterThanOrEqual(1);
  });

  it("can be asked of the owner, or given, only for a batch somebody could be asked in", async () => {
    const { id } = await createBatch(t.manager, batchInput(t, { name: "Ready check", criteria: { source: "appointments_showed", from: dayAgo(300), to: dayAgo(200) } }));
    // Even with the right fingerprint (the one the owner would be shown), a batch that matches nobody is refused.
    const hash = await fingerprintOf(id);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await expectError(requestBatchApproval(t.manager, id, { fingerprint: hash! }), "invalid_input", /Nobody who matches can be asked/);
    await expectError(approveBatch(t.owner, id, { fingerprint: hash! }), "invalid_input", /Nobody who matches can be asked/);
    expect((await batchRow(id)).status).toBe("draft");
    expect(await count("select count(*)::text as n from approval_requests where org_id = $1 and target_id = $2", [t.m.org.id, `review_batch:${id}`])).toBe(0);
  });
});

describe("pausing, resuming and cancelling", () => {
  let t: ReputationShop;
  beforeAll(async () => {
    t = await reputationShop("Control Shop");
    await setBatches(t.m.org.id, true);
    await attend(t, await shopCustomer(t));
  });

  async function approved(name: string) {
    const { id } = await createBatch(t.owner, batchInput(t, { name }));
    const p = await previewBatch(t.owner, id);
    await approveBatch(t.owner, id, { fingerprint: p.fingerprint! });
    return id;
  }

  it("pauses an approved batch and resumes it; a pause needs a batch that is going, a resume one that is paused", async () => {
    const id = await approved("Pause me");
    await expectError(resumeBatch(t.owner, id), "conflict", /isn't paused/);
    expect(await pauseBatch(t.manager, id)).toEqual({ held: 0 });
    const view = await getBatch(t.owner, id);
    expect(view.status).toBe("paused");
    expect(view.counts.notice).toMatchObject({ code: "paused", detail: `${t.manager.label} paused it.` });
    await expectError(pauseBatch(t.owner, id), "conflict", /waiting to start or sending/);
    await resumeBatch(t.manager, id);
    expect(await batchRow(id)).toMatchObject({ status: "approved" });
    expect((await getBatch(t.owner, id)).counts.notice).toBeNull();
    expect(await audits(t.m.org.id, "reputation.batch_paused")).toBeGreaterThanOrEqual(1);
    expect(await audits(t.m.org.id, "reputation.batch_resumed")).toBeGreaterThanOrEqual(1);
    const draft = await createBatch(t.owner, batchInput(t, { name: "Still a draft" }));
    await expectError(pauseBatch(t.owner, draft.id), "conflict");
  });

  it("cancels a draft, a waiting batch and an approved batch, withdrawing the approval; a finished one can't be cancelled again", async () => {
    const draft = await createBatch(t.owner, batchInput(t, { name: "Discard me" }));
    await cancelBatch(t.manager, draft.id);
    expect((await getBatch(t.owner, draft.id)).status).toBe("cancelled");
    const id = await approved("Cancel me");
    const approvalId = (await batchRow(id)).approval_id!;
    await cancelBatch(t.owner, id);
    expect(await batchRow(id)).toMatchObject({ status: "cancelled" });
    expect(await one<{ status: string }>("select status from approval_requests where id = $1", [approvalId])).toEqual({ status: "cancelled" });
    await expectError(cancelBatch(t.owner, id), "conflict", /already ended/);
    await expectError(pauseBatch(t.owner, id), "conflict");
    await expectError(resumeBatch(t.owner, id), "conflict");
    await expectError(updateBatch(t.owner, id, batchInput(t)), "conflict");
    expect(await audits(t.m.org.id, "reputation.batch_cancelled")).toBeGreaterThanOrEqual(2);
  });
});

describe("one workspace never reaches another's batches", () => {
  it("can't read, preview, change, approve, pause, resume, cancel or copy a batch it doesn't own, and lists only its own", async () => {
    const a = await reputationShop("Isolation A");
    const b = await reputationShop("Isolation B");
    await setBatches(a.m.org.id, true);
    await setBatches(b.m.org.id, true);
    await attend(a, await shopCustomer(a));
    await attend(b, await shopCustomer(b));
    const mine = await createBatch(a.owner, batchInput(a, { name: "A's batch" }));
    const theirs = await createBatch(b.owner, batchInput(b, { name: "B's batch" }));
    const pa = await previewBatch(a.owner, mine.id);
    await approveBatch(a.owner, mine.id, { fingerprint: pa.fingerprint! });

    expect((await listBatches(a.owner)).map((x) => x.name)).toEqual(expect.arrayContaining(["A's batch"]));
    expect((await listBatches(a.owner)).map((x) => x.name)).not.toContain("B's batch");
    expect((await listBatches(b.owner)).map((x) => x.name)).not.toContain("A's batch");
    for (const call of [
      () => getBatch(b.owner, mine.id), () => previewBatch(b.owner, mine.id), () => listBatchPeople(b.owner, mine.id), () => updateBatch(b.owner, mine.id, batchInput(b)),
      () => requestBatchApproval(b.owner, mine.id, { fingerprint: pa.fingerprint! }), () => approveBatch(b.owner, mine.id, { fingerprint: pa.fingerprint! }),
      () => returnBatch(b.owner, mine.id, "x"), () => pauseBatch(b.owner, mine.id), () => resumeBatch(b.owner, mine.id), () => cancelBatch(b.owner, mine.id), () => duplicateBatch(b.owner, mine.id),
    ]) await expectError(call(), "not_found", /Batch not found/);
    // Nothing of A's changed.
    expect(await batchRow(mine.id)).toMatchObject({ status: "approved" });
    expect(await batchRow(theirs.id)).toMatchObject({ status: "draft" });
    // A batch can't be pointed at a foreign template, contact or request: the composite keys refuse it.
    await expect(withSystem((db) => db.query("update review_request_batches set template_id = $2 where id = $1", [mine.id, b.smsTemplate.id]))).rejects.toThrow(/foreign key|violates/);
    const foreignContact = (await one<{ id: string }>("select id from contacts where org_id = $1 limit 1", [b.m.org.id])).id;
    await expect(withSystem((db) => db.query("insert into review_request_batch_items (org_id, batch_id, contact_id) values ($1, $2, $3)", [a.m.org.id, mine.id, foreignContact]))).rejects.toThrow(/foreign key|violates/);
  });
});

describe("the people list of a batch", () => {
  it("is empty before it starts, and refuses a page of someone else's", async () => {
    const u = await reputationShop("People Shop");
    await setBatches(u.m.org.id, true);
    await attend(u, await shopCustomer(u));
    const { id } = await createBatch(u.owner, batchInput(u));
    expect(await listBatchPeople(u.viewer, id)).toMatchObject({ rows: [], total: 0, page: 1 });
    expect(await all("select 1 from review_request_batch_items where batch_id = $1", [id])).toEqual([]);
  });
});
