/**
 * The fictional proposals used for isolated local browser QA and for the test that proves this script works: a price book, an approved template and eighteen proposals in every
 * state a customer or the team can meet. It writes through the application's own services and contacts NO ONE: the code emails are captured in the outbox (EMAIL_PROVIDER=capture),
 * nothing is sent to a real signing service (the signing stories use the stand-in that lives inside the server), and every name, address and price is made up. The prices are not a price list: they exist so the totals have something
 * to add up. The one AI-written draft is written by a FIXED stand-in answer that includes sentences the checks must drop; no language model is called.
 *
 * It is a plain module (no vitest, no database setup) so that both scripts/ui-qa-proposals-seed.qa.ts and tests/proposals-qa-seed.test.ts can run it.
 */
import crypto from "node:crypto";
import { withSystem } from "../src/server/db/index";
import type { CrmActor } from "../src/server/crm/actor";
import { createContact, setContactConsent } from "../src/server/crm/contacts";
import { saveCredential } from "../src/server/security/credentials";
import { adjustCredits, getBalance } from "../src/server/billing/ledger";
import { draftProposalWithAi } from "../src/server/proposals/ai";
import { createCatalogItem, createTaxRate, listCatalogItems, type CatalogItemView } from "../src/server/proposals/catalog";
import { connectSimulated, getConnection as getSigningConnection } from "../src/server/esign/connections";
import { openCredentials } from "../src/server/esign/credentials";
import { simulatedEsign } from "../src/server/esign/providers/simulated";
import { requestSignature } from "../src/server/esign/requests";
import { runEsignSync } from "../src/server/esign/maintenance";
import { tokenForStoredConnection } from "../src/server/esign/webhook-token";
import { handleEsignWebhook } from "../src/server/esign/webhook";
import { processDueRequests } from "../src/server/esign/worker";
import { clearFeatureCache } from "../src/server/proposals/features";
import { expireDueProposals } from "../src/server/proposals/jobs";
import { createProposal, decideProposal, recordOfflineDecision, sendProposal, submitForApproval, withdrawProposal, type CreateInput } from "../src/server/proposals/proposals";
import { decideOnProposal, loadPublicProposal, recordProposalView, requestEmailCode, verifyEmailCode } from "../src/server/proposals/public";
import { getShareUrl } from "../src/server/proposals/share";
import { saveProposalSettings } from "../src/server/proposals/settings";
import { approveTemplate, createTemplate } from "../src/server/proposals/templates";
import type { LineInput } from "../src/server/proposals/doc-build";

export interface ProposalWorldActors {
  /** The business owner: sets the price book up and answers nothing for the customer. */
  owner: CrmActor;
  /** A manager: approves. */
  manager: CrmActor;
  /** A salesperson: writes and sends. */
  sales: CrmActor;
}

export interface WorldRow {
  number: string;
  title: string;
  /** What state the story leaves it in, in a few words. */
  state: string;
  /** The customer's address, while the link is active. */
  url: string | null;
  /** Where the code email goes (it is captured in the outbox, readable at /dev/mailbox in development). */
  email: string | null;
}

const DAY = 86_400_000;
const CUSTOMER_IP = "198.51.100.77";

export async function seedProposalWorld(a: ProposalWorldActors, opts: { now?: Date } = {}): Promise<WorldRow[]> {
  const now = opts.now ?? new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const day = (offset: number) => new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);
  const orgId = a.owner.orgId;
  await withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, 'proposals', true) on conflict (org_id, feature) do update set enabled = true", [orgId]));
  clearFeatureCache(orgId);

  await saveProposalSettings(a.owner, { approvalMode: "ai_and_discounts", discountNeedsApproval: true, aiDraftsEnabled: true }, 0);
  const tax = await createTaxRate(a.owner, { name: "Sales tax (QA)", rateBps: 825 });
  const item = async (name: string, description: string, unitLabel: string, unitPriceMinor: number, billing: "one_time" | "monthly" | "yearly" = "one_time") =>
    createCatalogItem(a.owner, { name, description, unitLabel, unitPriceMinor, currency: "USD", billing, taxRateId: tax.id });
  const tuneup = await item("Seasonal tune-up", "A full check of the heating or cooling system, with a written report.", "visit", 18_900);
  const callout = await item("Emergency call-out", "A technician at the door within the hour, any time of day.", "call", 12_000);
  const heater = await item("Water heater replacement", "Remove the old unit and fit a new 50-gallon tank, with a one-year labour guarantee.", "unit", 145_000);
  const plan = await item("Maintenance plan", "Two scheduled visits a year and priority booking.", "month", 4_900, "monthly");
  const filters = await item("Filter subscription", "A set of filters, posted to you each year.", "set", 6_000, "yearly");
  const line = (i: CatalogItemView, quantityMilli = 1000, over: Partial<LineInput> = {}): LineInput => ({ catalogItemId: i.id, quantityMilli, ...over });

  const contacts = async (first: string, last: string, email: string) => (await createContact(a.owner, { firstName: first, lastName: last, email })).id;
  const rows: WorldRow[] = [];
  const terms = "Payment is due within 14 days of the work being finished.\nParts are guaranteed for twelve months. Labour is guaranteed for ninety days.";
  const make = async (title: string, who: CrmActor, input: CreateInput, at: Date = now) => {
    const created = await createProposal(who, { title, validUntil: day(21), ...input, doc: { terms, ...(input.doc ?? {}) } }, { now: at });
    return created;
  };
  // A discount needs the manager's permission to give and a second look to send, so those proposals are written and approved by the manager and then sent by sales.
  const approve = async (id: string, at: Date = now) => {
    const pending = await submitForApproval(a.manager, id, { now: at });
    await decideProposal(a.manager, pending.id, { decision: "approve", version: pending.version }, { now: at });
  };
  const send = async (id: string, at: Date = now) => {
    const sent = await sendProposal(a.sales, id, {}, { now: at });
    const link = await getShareUrl(a.sales, id, { now: at });
    return { sent, url: link.url, token: link.url.split("/proposal/")[1] };
  };
  const note = async (p: { number: string; title: string }, state: string, url: string | null, email: string | null) => rows.push({ number: p.number, title: p.title, state, url, email });
  const customer = (token: string, sessionToken?: string | null) => ({ ip: CUSTOMER_IP, sessionToken: sessionToken ?? null, now });
  const codeFor = async (email: string) => {
    const r = await withSystem((db) => db.query<{ body_text: string }>("select body_text from email_outbox where template = 'proposal_code' and to_email = $1 order by created_at desc limit 1", [email]));
    return /Code: (\d{6})/.exec(r.rows[0]?.body_text ?? "")?.[1] ?? "";
  };
  const verify = async (token: string, email: string) => {
    await requestEmailCode(token, customer(token));
    const v = await verifyEmailCode(token, await codeFor(email), customer(token));
    if (!v.sessionToken) throw new Error(`The QA customer could not be verified (${v.outcome}).`);
    return v.sessionToken;
  };

  // 1. Sent, nobody has opened the link. The way to try the whole customer flow by hand: open the address, ask for a code, read it at /dev/mailbox, enter it, answer.
  const emailAlvarez = "elena.alvarez@example.test";
  const p1 = await make("Spring tune-up for the Alvarez household", a.sales, {
    contactId: await contacts("Elena", "Alvarez", emailAlvarez), clientName: "Elena Alvarez", clientEmail: emailAlvarez,
    doc: { sections: [{ heading: "Hello {{client.first_name}}", body: "Thank you for asking us to look after your heating and cooling. Here is what we **propose**.\n\n- A full tune-up of both systems\n- A written report afterwards" }], lines: [line(tuneup, 2000), line(callout, 1000)] },
  });
  const s1 = await send(p1.id);
  await note(p1, "Sent. Never opened. Try the customer flow here.", s1.url, emailAlvarez);

  // 2. Opened and then viewed in a browser (the beacon), so the team sees the second level of "seen".
  const emailBrooks = "marcus.brooks@example.test";
  const p2 = await make("Water heater replacement for Marcus Brooks", a.manager, { contactId: await contacts("Marcus", "Brooks", emailBrooks), clientName: "Marcus Brooks", clientEmail: emailBrooks, doc: { lines: [line(heater), line(callout, 1000, { discount: { kind: "percent", bps: 1000 } })] } });
  await approve(p2.id);
  const s2 = await send(p2.id);
  await loadPublicProposal(s2.token, customer(s2.token));
  await recordProposalView(s2.token, customer(s2.token));
  await note(p2, "Sent. Opened, and viewed in a browser (not verified).", s2.url, emailBrooks);

  // 3. The customer entered the emailed code (the third level) but has not answered.
  const emailChen = "dr.chen@example.test";
  const p3 = await make("Annual maintenance plan for Chen Dental", a.sales, { contactId: await contacts("Wei", "Chen", emailChen), clientName: "Wei Chen", clientCompany: "Chen Dental", clientEmail: emailChen, doc: { lines: [line(plan), line(filters)] } });
  const s3 = await send(p3.id);
  await verify(s3.token, emailChen);
  await note(p3, "Sent. The customer entered the code but has not answered.", s3.url, emailChen);

  // 4. Accepted by the customer with the tick box and the code.
  const emailOkafor = "grace.okafor@example.test";
  const p4 = await make("Duct inspection for Grace Okafor", a.sales, { contactId: await contacts("Grace", "Okafor", emailOkafor), clientName: "Grace Okafor", clientEmail: emailOkafor, doc: { lines: [line(tuneup)] } });
  const s4 = await send(p4.id);
  const session4 = await verify(s4.token, emailOkafor);
  await decideOnProposal(s4.token, { decision: "accept", acknowledged: "1" }, customer(s4.token, session4));
  await note(p4, "Accepted by the customer (a recorded answer, not an electronic signature).", s4.url, emailOkafor);

  // 5. Declined, with a note.
  const emailSilva = "tom.silva@example.test";
  const p5 = await make("Furnace repair for Tom Silva", a.sales, { contactId: await contacts("Tom", "Silva", emailSilva), clientName: "Tom Silva", clientEmail: emailSilva, doc: { lines: [line(callout, 1500)] } });
  const s5 = await send(p5.id);
  const session5 = await verify(s5.token, emailSilva);
  await decideOnProposal(s5.token, { decision: "decline", note: "We found someone closer to us." }, customer(s5.token, session5));
  await note(p5, "Declined by the customer, with a note.", s5.url, emailSilva);

  // 6. Past its date: sent forty days ago, valid until thirty days ago; the expiry job closed it.
  const emailPatel = "ravi.patel@example.test";
  const sentAt = ago(40);
  const p6 = await make("Office HVAC service for Patel & Co", a.sales, { contactId: await contacts("Ravi", "Patel", emailPatel), clientName: "Ravi Patel", clientCompany: "Patel & Co", clientEmail: emailPatel, validUntil: day(-30), doc: { lines: [line(tuneup, 4000)] } }, sentAt);
  const s6 = await send(p6.id, sentAt);
  await expireDueProposals({ now });
  await note(p6, "Expired: the date passed without an answer.", s6.url, emailPatel);

  // 7. A long one for the layout: many lines, discounts, one-time and monthly amounts, long wording. Its PDF runs over several pages.
  const emailNguyen = "linh.nguyen@example.test";
  const many: LineInput[] = [];
  for (let n = 1; n <= 22; n += 1) many.push(line([tuneup, callout, heater][n % 3], 1000 + (n % 4) * 500, n % 5 === 0 ? { discount: { kind: "percent", bps: 750 } } : n % 7 === 0 ? { discount: { kind: "fixed", minor: 2_500 } } : {}));
  many.push(line(plan, 1000), line(filters, 2000));
  const p7 = await make("Whole-home system for the Nguyen family", a.manager, {
    contactId: await contacts("Linh", "Nguyen", emailNguyen), clientName: "Linh Nguyen", clientEmail: emailNguyen,
    doc: {
      sections: [
        { heading: "Scope", body: "We will survey every room, then replace the tired parts of the system in the order that gives you the most comfort for the least disruption. ".repeat(6) },
        { heading: "How we work", body: "1. A survey visit\n2. A written plan you can read at your own pace\n3. The work, one room at a time\n4. A walk-through with you at the end" },
      ],
      lines: many,
      terms: `${terms}\n\n${"A longer set of terms, written out in full so the page and the PDF have something to wrap and break across pages. ".repeat(18)}`,
    },
  });
  await approve(p7.id);
  const s7 = await send(p7.id);
  await note(p7, "Sent. Many lines, discounts and a monthly plan: the long layout and the multi-page PDF.", s7.url, emailNguyen);

  // 8. Needs a signature. Sending one is refused until a signing service is connected (the stand-in is connected at the end of this story, for the last three proposals), so this
  // one was sent and then flagged, to see how the page treats it. Once the stand-in is connected it can be asked for a signature from its Signature tab like the others.
  const emailReyes = "ines.reyes@example.test";
  const p8 = await make("Boiler installation for Ines Reyes", a.sales, { contactId: await contacts("Ines", "Reyes", emailReyes), clientName: "Ines Reyes", clientEmail: emailReyes, doc: { lines: [line(heater, 2000)] } });
  const s8 = await send(p8.id);
  await withSystem((db) => db.query("update proposals set requires_signature = true where id = $1", [p8.id]));
  await note(p8, "Sent. Flagged as needing a signature: the page offers no Accept.", s8.url, emailReyes);

  // 9. Withdrawn by the team after it was sent.
  const emailKhan = "amir.khan@example.test";
  const p9 = await make("Drain clearing for Amir Khan", a.sales, { contactId: await contacts("Amir", "Khan", emailKhan), clientName: "Amir Khan", clientEmail: emailKhan, doc: { lines: [line(callout)] } });
  const s9 = await send(p9.id);
  await withdrawProposal(a.sales, p9.id, { now });
  await note(p9, "Withdrawn after sending. The link says it is no longer active.", s9.url, emailKhan);

  // 10. The link ran out: sent a hundred days ago with no end date.
  const emailMoore = "jo.moore@example.test";
  const old = ago(100);
  const p10 = await make("Seasonal tune-up for Jo Moore", a.sales, { contactId: await contacts("Jo", "Moore", emailMoore), clientName: "Jo Moore", clientEmail: emailMoore, validUntil: null, doc: { lines: [line(tuneup)] } }, old);
  const s10 = await send(p10.id, old);
  await note(p10, "Sent a hundred days ago. The link itself has run out.", s10.url, emailMoore);

  // 11. Waiting for approval (it gives a discount; nobody has looked at it yet), and 12. a draft, for the team's side.
  const p11 = await make("Maintenance plan for the Dubois family", a.manager, { clientName: "Claire Dubois", clientEmail: "claire.dubois@example.test", doc: { lines: [line(plan, 1000, { discount: { kind: "percent", bps: 1500 } })] } });
  await submitForApproval(a.manager, p11.id, { now });
  await note(p11, "Waiting for approval (it gives a discount).", null, null);
  const p12 = await make("Draft for Ben Hall", a.sales, { clientName: "Ben Hall", clientEmail: "ben.hall@example.test", doc: { lines: [line(tuneup)] } });
  await note(p12, "A draft.", null, null);

  // The team can also record an answer given outside the product: here, a phone call that accepted the Moore proposal's replacement.
  const p13 = await make("Seasonal tune-up for Jo Moore (new quote)", a.sales, { clientName: "Jo Moore", clientEmail: emailMoore, doc: { lines: [line(tuneup)] } });
  await send(p13.id);
  await recordOfflineDecision(a.owner, p13.id, { decision: "accepted", note: "Said yes on the phone on the day we sent it." }, { now });
  await note(p13, "Accepted by phone, recorded by the owner (not verified by the customer).", null, emailMoore);

  // 14. An AI-written first draft. The model here is a fixed stand-in whose answer includes an invented price, a claim and an item that does not exist, so the draft's notice shows
  // what the checks left out. It is a draft: it has to be read, edited, sent for approval and approved by a person before it can go anywhere.
  const balance = await withSystem((db) => getBalance(db, orgId));
  if (balance.availableMicros <= 0) {
    await withSystem((db) => adjustCredits(db, { orgId, deltaMicros: 5_000_000, reason: "QA credit for AI drafting (isolated QA database)", userId: a.owner.userId as string }));
  }
  const emailWhitfield = "dana.whitfield@example.test";
  const standIn = async () => ({
    ok: true as const,
    usage: { inputTokens: 900, outputTokens: 310 },
    text: JSON.stringify({
      intro: "Thank you for the chance to help. Our award-winning team has served 500 happy customers. We would be glad to look after your system.",
      scopeSummary: "We will carry out a full tune-up and keep an emergency call-out available. The tune-up costs $49 this week only. The report is written for you to keep.",
      items: [{ catalogItemId: tuneup.id, quantity: 1, note: "" }, { catalogItemId: callout.id, quantity: 1, note: "Guaranteed to arrive within the hour." }, { catalogItemId: "00000000-0000-4000-8000-000000000000", quantity: 1, note: "" }],
      assumptions: ["Someone is home for the visit.", "Parts are quoted separately.", "Work is finished within 14 days."],
      nextSteps: ["Read this draft carefully.", "Send it for approval."],
    }),
  });
  const aiDraft = await draftProposalWithAi(a.sales, { contactId: await contacts("Dana", "Whitfield", emailWhitfield), brief: "A tune-up and an emergency call-out for the Whitfield house." }, { complete: standIn as never, config: async () => ({ baseUrl: "https://llm.example.test/v1", format: "openai", model: "qa-stand-in", apiKey: "qa-stand-in", source: "environment" as const }), now });
  await note(aiDraft.proposal, "An AI-written first draft, with the sentences and items the checks left out listed in its notice. Not sent for approval.", null, emailWhitfield);

  // 15. A reviewer asked for changes.
  const p15 = await make("Filter subscription for the Reyes household", a.manager, { clientName: "Pablo Reyes", clientEmail: "pablo.reyes@example.test", doc: { lines: [line(filters, 1000, { discount: { kind: "percent", bps: 500 } })] } });
  const waiting = await submitForApproval(a.manager, p15.id, { now });
  await decideProposal(a.owner, waiting.id, { decision: "request_changes", version: waiting.version, note: "Please add the maintenance plan as well, and drop the discount." }, { now });
  await note(p15, "A reviewer asked for changes.", null, null);

  // An approved template, so the new-proposal form has one to offer.
  const tpl = await createTemplate(a.owner, { name: "Standard service proposal (QA)", doc: { sections: [{ heading: "About us", body: "{{business.name}} looks after heating and cooling systems for homes and small offices." }], lines: [{ catalogItemId: tuneup.id, quantityMilli: 1000 }], terms } });
  await approveTemplate(a.owner, tpl.id, 1);

  // 16 to 18. Electronic signing, through the stand-in service.
  rows.push(...(await seedSigningWorld(a, { now })));

  return rows;
}

/**
 * Makes some of the world's sent proposals sendable to their customers from the Delivery tab, for browser QA of "Send it to the customer". It contacts NO ONE: the workspace's email
 * goes through a native Resend channel with a made-up credential, and the QA environment keeps RESEND_WRITES_ENABLED off, so a message that is confirmed is queued and then
 * blocked by the dispatcher ("Sending through this channel's provider is not switched on") instead of leaving. The workspace is given credits and a published email rate, and these
 * customers have the service consent for email that a business would have recorded:
 *
 *   - P-0001 Elena Alvarez, P-0002 Marcus Brooks and P-0007 Linh Nguyen: consent on record, so the preview is ready and a confirmed message is queued;
 *   - P-0003 Wei Chen: no consent on record, so the preview says the send chain would refuse it.
 *
 * It replaces the workspace's email channel with the native one (one email channel per workspace), so it is separate from seedProposalWorld and runs only when asked for.
 */
export async function seedDeliveryWorld(a: ProposalWorldActors): Promise<{ ready: string[]; refused: string[] }> {
  const orgId = a.owner.orgId;
  const ownerId = a.owner.userId as string;
  await withSystem(async (db) => {
    // Only an agency Super Admin may store a credential. The throwaway QA database has one from the other seeds, or gets one here.
    const admin = (await db.query<{ id: string }>("select id from users where platform_role = 'agency_super_admin' order by created_at limit 1")).rows[0]
      ?? (await db.query<{ id: string }>("insert into users (email, full_name, email_verified_at, platform_role) values ('qa-delivery-admin@example.test', 'QA Super Admin', now(), 'agency_super_admin') returning id")).rows[0];
    const saved = await saveCredential(db, { orgId, provider: "resend", label: "Resend (made up, for QA)", secret: `qa-made-up-${crypto.randomBytes(12).toString("hex")}`, actorId: admin.id });
    await db.query(
      `insert into messaging_channels (org_id, channel, provider, enabled, sender_identity, sender_verified_at, registration_status, provider_sender_id, credential_id, capability_test, capability_tested_at)
       values ($1, 'email', 'resend', true, 'Harbor Home Services <hello@harbor.example.test>', now(), 'not_required', $2, $3, $4::jsonb, now())
       on conflict (org_id, channel) do update set provider = 'resend', enabled = true, sender_identity = excluded.sender_identity, sender_verified_at = now(), registration_status = 'not_required',
         provider_sender_id = excluded.provider_sender_id, provider_account_id = null, credential_id = excluded.credential_id, capability_test = excluded.capability_test, capability_tested_at = now()`,
      [orgId, crypto.randomUUID(), saved.id, JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), checks: [{ label: "Made up for QA", ok: true, detail: "Nothing was checked with the provider." }] })],
    );
    const version = (await db.query<{ id: string }>("select id from usage_rate_versions order by version desc limit 1")).rows[0];
    if (!version) throw new Error("No usage rate version exists, so an email cannot be priced.");
    await db.query(
      "insert into usage_unit_rates (rate_version_id, provider, unit_type, unit_label, wholesale_micros_per_unit, client_micros_per_unit) values ($1, 'resend', 'email_send', 'email_send', 900, 1170) on conflict do nothing",
      [version.id],
    );
  });
  const balance = await withSystem((db) => getBalance(db, orgId));
  if (balance.availableMicros < 5_000_000) {
    await withSystem((db) => adjustCredits(db, { orgId, deltaMicros: 5_000_000, reason: "QA credit for sending messages (isolated QA database)", userId: ownerId }));
  }
  const contactOf = async (email: string) => (await withSystem((db) => db.query<{ id: string }>("select id from contacts where org_id = $1 and email = $2 and deleted_at is null", [orgId, email]))).rows[0]?.id;
  const ready: string[] = [];
  for (const email of ["elena.alvarez@example.test", "marcus.brooks@example.test", "linh.nguyen@example.test"]) {
    const id = await contactOf(email);
    if (!id) throw new Error(`The QA customer ${email} does not exist: seed the proposals world first.`);
    await setContactConsent(a.owner, id, { channel: "email", purpose: "service", status: "granted", evidence: "Agreed to messages about their work on the intake form (QA data)" });
    ready.push(email);
  }
  return { ready, refused: ["dr.chen@example.test"] };
}

/**
 * Three proposals that ask for a signature, with the stand-in signing service connected (a stand-in that lives inside the server: it sends nothing to anyone and signs nothing).
 * Can be added to a workspace that already has the other fifteen. Nothing here is a real signature; the one that looks signed says so everywhere it is shown.
 *
 *   - signed through the stand-in, end to end in this process: accepted, with the signed copy and certificate stored;
 *   - needs a signature and nothing has been asked yet: ask for it on the proposal's Signature tab;
 *   - asked, waiting to be handed to the service: use "Hand it over now" and play the signer with the buttons under the request.
 */
export async function seedSigningWorld(a: ProposalWorldActors, opts: { now?: Date } = {}): Promise<WorldRow[]> {
  const now = opts.now ?? new Date();
  const orgId = a.owner.orgId;
  await withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, 'proposals', true), ($1, 'esign', true) on conflict (org_id, feature) do update set enabled = true", [orgId]));
  clearFeatureCache(orgId);
  if (!(await getSigningConnection(a.owner))) await connectSimulated(a.owner, { label: "Simulated signing service (QA)" });
  let item = (await listCatalogItems(a.owner))[0];
  if (!item) {
    const tax = await createTaxRate(a.owner, { name: "Sales tax (QA)", rateBps: 825 });
    item = await createCatalogItem(a.owner, { name: "Seasonal tune-up", description: "A full check of the heating or cooling system, with a written report.", unitLabel: "visit", unitPriceMinor: 18_900, currency: "USD", billing: "one_time", taxRateId: tax.id });
  }
  const rows: WorldRow[] = [];
  const terms = "Payment is due within 14 days of the work being finished.";
  const day = (offset: number) => new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);
  const story = async (title: string, first: string, last: string, email: string) => {
    const contact = await createContact(a.owner, { firstName: first, lastName: last, email });
    const draft = await createProposal(a.sales, { title, contactId: contact.id, clientName: `${first} ${last}`, clientEmail: email, validUntil: day(30), requiresSignature: true, doc: { terms, lines: [{ catalogItemId: item.id, quantityMilli: 1000 }] } }, { now });
    await sendProposal(a.sales, draft.id, {}, { now });
    const link = await getShareUrl(a.sales, draft.id, { now });
    return { draft, url: link.url, email };
  };

  // The signed one goes first: handing a request to the stand-in works through every request that is due, and the other two must stay as they are for the person trying them.
  const emailDiaz = "rosa.diaz@example.test";
  const signed = await story("Annual service agreement for Rosa Diaz", "Rosa", "Diaz", emailDiaz);
  const { requestId } = await requestSignature(a.sales, signed.draft.id, {}, { now });
  await processDueRequests({ orgId, now: () => now, jitter: () => 0 });
  const req = (await withSystem((db) => db.query<{ provider_document_id: string | null }>("select provider_document_id from signature_requests where id = $1", [requestId]))).rows[0];
  const conn = (await withSystem((db) => db.query<{ id: string; credentials: string; webhook_token_hash: string }>("select id, credentials, webhook_token_hash from esign_connections where org_id = $1 and status = 'connected'", [orgId]))).rows[0];
  const creds = openCredentials(conn?.credentials ?? null);
  const token = conn ? tokenForStoredConnection(conn.id, conn.webhook_token_hash) : null;
  if (!req?.provider_document_id || !creds || !token) throw new Error("The stand-in signing service could not be reached to make the signed example.");
  simulatedEsign.signerAction(req.provider_document_id, "complete");
  const d = simulatedEsign.delivery(req.provider_document_id, creds.webhookKey);
  const answered = await handleEsignWebhook({ token, rawBody: d.rawBody, headers: d.headers, query: d.query, ip: CUSTOMER_IP, now });
  if (answered.status !== 200) throw new Error(`The stand-in's notice was not accepted (${answered.body.reason ?? answered.status}).`);
  await runEsignSync({ orgId, now: () => now, jitter: () => 0 });
  rows.push({ number: signed.draft.number, title: signed.draft.title, state: "Signed through the stand-in signing service (simulated: nothing real was signed). Accepted, with the signed copy and its certificate stored.", url: signed.url, email: emailDiaz });

  const emailMori = "kenji.mori@example.test";
  const notAsked = await story("Duct replacement for Kenji Mori", "Kenji", "Mori", emailMori);
  rows.push({ number: notAsked.draft.number, title: notAsked.draft.title, state: "Sent. Needs a signature and none has been asked for yet: use its Signature tab.", url: notAsked.url, email: emailMori });

  // The stand-in's documents live in this process only, so a request is left waiting: it is handed over, and played, by the server the person is using.
  const emailHaddad = "omar.haddad@example.test";
  const asked = await story("Boiler service agreement for Omar Haddad", "Omar", "Haddad", emailHaddad);
  await requestSignature(a.sales, asked.draft.id, {}, { now });
  rows.push({ number: asked.draft.number, title: asked.draft.title, state: "Sent. A signature was asked for and is waiting to be handed to the stand-in service: use 'Hand it over now' on its Signature tab, then play the signer.", url: asked.url, email: emailHaddad });
  return rows;
}
