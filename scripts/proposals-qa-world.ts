/**
 * The fictional proposals used for isolated local browser QA and for the test that proves this script works: a price book, an approved template and fifteen proposals in every
 * state a customer or the team can meet. It writes through the application's own services and contacts NO ONE: the code emails are captured in the outbox (EMAIL_PROVIDER=capture),
 * nothing is sent to a signing service (none exists yet), and every name, address and price is made up. The prices are not a price list: they exist so the totals have something
 * to add up. The one AI-written draft is written by a FIXED stand-in answer that includes sentences the checks must drop; no language model is called.
 *
 * It is a plain module (no vitest, no database setup) so that both scripts/ui-qa-proposals-seed.qa.ts and tests/proposals-qa-seed.test.ts can run it.
 */
import { withSystem } from "../src/server/db/index";
import type { CrmActor } from "../src/server/crm/actor";
import { createContact } from "../src/server/crm/contacts";
import { adjustCredits, getBalance } from "../src/server/billing/ledger";
import { draftProposalWithAi } from "../src/server/proposals/ai";
import { createCatalogItem, createTaxRate, type CatalogItemView } from "../src/server/proposals/catalog";
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

  // 8. Needs a signature. Sending one is refused until a signing service exists, so this one was sent and then flagged, to see how the page treats it.
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

  return rows;
}
