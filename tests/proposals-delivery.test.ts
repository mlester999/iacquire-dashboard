// Sending a sent proposal's link to the customer through the real consent-gated send chain (message scope "delivery"), on embedded Postgres: what the sender is shown, what the
// chain says, every way it refuses, what stops a message that has not gone out, a double click, a new version, and a customer's link that is never stored. Every provider is a
// recording stand-in; nothing leaves the process.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { agentActor } from "@/server/crm/actor";
import { setContactConsent } from "@/server/crm/contacts";
import { redactContact, suppressAddress } from "@/server/messaging/contacts";
import { deliveryConversation } from "@/server/messaging/delivery";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { setRetentionPaused } from "@/server/retention/service";
import { deliveriesFor, previewDelivery, proposalLinkForMessage, sendDelivery, type DeliveryPreview, type SendDeliveryResult } from "@/server/proposals/delivery";
import { expireDueProposals } from "@/server/proposals/jobs";
import { decideOnProposal, loadPublicProposal } from "@/server/proposals/public";
import { decideProposal, getProposal, recordOfflineDecision, reviseProposal, sendProposal, submitForApproval, withdrawProposal } from "@/server/proposals/proposals";
import { getShareUrl, renewShareLink } from "@/server/proposals/share";
import { CRM_ROLES } from "./support/crm";
import { ctxFor } from "./support/fixtures";
import { recordingProvider } from "./support/messaging";
import { addDeliveryMessaging, customerFor, freshIp, NOW, proposalOrg, rows, sentTo, setFeature, verifiedSession, type Customer, type ProposalOrg } from "./support/proposals";

const ACCEPT = { decision: "accept", acknowledged: "1" } as const;
const TOKEN_RE = /\/proposal\/([A-Za-z0-9_-]{43})/;

interface Shop {
  p: ProposalOrg;
  c: Customer;
  id: string;
  /** The customer's address for the link, as the team would copy it. */
  url: string;
  token: string;
}

async function shop(opts: { channels?: Array<"email" | "sms" | "whatsapp">; consent?: Array<"email" | "sms" | "whatsapp">; credits?: number; timezone?: string; over?: Parameters<typeof sentTo>[2] } = {}): Promise<Shop> {
  const p = await proposalOrg({ timezone: opts.timezone });
  await addDeliveryMessaging(p, { credits: opts.credits, channels: opts.channels });
  const c = await customerFor(p, { consent: opts.consent });
  const sent = await sentTo(p, c, opts.over);
  return { p, c, id: sent.proposal.id, url: sent.url, token: sent.token };
}

async function read(s: Shop, channel: "email" | "sms" | "whatsapp" = "email", who: "sales" | "owner" | "manager" = "sales", now = NOW): Promise<DeliveryPreview> {
  const r = await previewDelivery(s.p.actor(who), s.id, channel, { now });
  if (!r.available) throw new Error(`not available: ${r.text}`);
  return r;
}

/** Reads the message and confirms exactly what was read, as the sales rep. */
async function send(s: Shop, channel: "email" | "sms" | "whatsapp" = "email", now = NOW): Promise<SendDeliveryResult> {
  const pre = await read(s, channel, "sales", now);
  return sendDelivery(s.p.actor("sales"), s.id, { channel, version: pre.version, wordingHash: pre.wordingHash }, { now });
}

const deliveries = (id: string) => rows<{ id: string; version: number; channel: string; message_id: string | null; link_id: string; wording_version: string; wording_hash: string; address_mask: string | null; requested_by: string | null; withdrawn_at: Date | null; withdrawn_reason: string | null }>(
  "select id, version, channel, message_id, link_id, wording_version, wording_hash, address_mask, requested_by, withdrawn_at, withdrawn_reason from proposal_deliveries where proposal_id = $1 order by created_at, id", [id],
);
const message = async (id: string) => (await rows<{ id: string; status: string; scope: string; purpose: string; body: string; author_kind: string; author_user_id: string | null; dedupe_key: string | null; blocked_reason: string | null; status_detail: string | null; send_after: Date; reservation_id: string | null; channel: string; thread_key: string; subject: string | null; owner_kind: string }>(
  `select m.id, m.status, m.scope, m.purpose, m.body, m.author_kind, m.author_user_id, m.dedupe_key, m.blocked_reason, m.status_detail, m.send_after, m.reservation_id, c.channel, c.thread_key, c.subject, c.owner_kind
   from conversation_messages m join conversations c on c.id = m.conversation_id where m.id = $1`, [id],
))[0];
const onlyMessage = async (proposalId: string, n = 0) => {
  const d = await deliveries(proposalId);
  if (!d[n]?.message_id) throw new Error(`no delivery message #${n}`);
  return message(d[n].message_id as string);
};
const reservation = async (id: string | null) => (id ? (await rows<{ status: string }>("select status from usage_reservations where id = $1", [id]))[0]?.status : undefined);
const eventKinds = async (id: string) => (await rows<{ kind: string }>("select kind from proposal_events where proposal_id = $1 order by id", [id])).map((e) => e.kind);
const messageCount = async (orgId: string) => Number((await rows<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1", [orgId]))[0].n);

async function withQuietHours<T>(start: string, end: string, run: () => Promise<T>): Promise<T> {
  await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = $1, quiet_hours_end = $2", [start, end]));
  try {
    return await run();
  } finally {
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
  }
}

/** A message that is queued and waiting for sending hours (quiet hours 11:00 to 14:00 around the fixed clock), so the things that stop it can be tried. */
async function waiting(s: Shop, channel: "email" | "sms" = "email") {
  const r = await withQuietHours("11:00", "14:00", () => send(s, channel));
  if (r.status !== "queued") throw new Error(`not queued: ${JSON.stringify(r)}`);
  expect(r.waitingUntil).not.toBeNull();
  return r;
}

const spies: Array<ReturnType<typeof vi.spyOn>> = [];
function captureLogs(): string[] {
  const seen: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void seen.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    spies.push(spy);
  }
  return seen;
}
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("what the sender is shown before anything is sent", () => {
  it("is the exact message with the customer's link as words, where it would go (masked), and what the chain says, and it writes nothing", async () => {
    const s = await shop();
    const before = await messageCount(s.p.org.id);
    const pre = await read(s);
    expect(pre).toMatchObject({ available: true, version: 1, channel: "email", channelLabel: "Email", usesCredits: false, wordingIsDraft: true, standing: null, remaining: 6, notes: [] });
    expect(pre.subject).toMatch(/^Proposal P-\d{4} from /);
    expect(pre.body).toContain("Hi Maria,");
    expect(pre.body).toContain("[the customer's own link to the proposal]");
    expect(pre.body).not.toContain("{{");
    expect(pre.body).not.toContain(s.token);
    expect(pre.addressMask).toBe(`${s.c.email[0]}***${s.c.email.slice(s.c.email.lastIndexOf("@"))}`);
    expect(pre.addressMask).not.toContain(s.c.email);
    expect(pre.verdict).toMatchObject({ kind: "ready", reason: null });
    expect(pre.verdict.text).toContain("Nothing is sent until you confirm");
    expect(pre.wordingHash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing was made: no message, no conversation, no delivery, no history line.
    expect(await messageCount(s.p.org.id)).toBe(before);
    expect(await rows("select 1 from conversations where org_id = $1", [s.p.org.id])).toHaveLength(0);
    expect(await deliveries(s.id)).toHaveLength(0);
    expect(await eventKinds(s.id)).not.toContain("delivery_queued");
  });

  it("marks a text message as using prepaid credits, and shows no subject", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    const pre = await read(s, "sms");
    expect(pre).toMatchObject({ available: true, channel: "sms", subject: null, usesCredits: true });
    expect(pre.addressMask).toBe(`***${s.c.phone?.slice(-4)}`);
    expect(pre.body).not.toContain("\n");
  });

  it("is for people who can send proposals only", async () => {
    const s = await shop();
    for (const who of ["owner", "manager", "sales"] as const) await expect(previewDelivery(s.p.actor(who), s.id, "email", { now: NOW }), who).resolves.toMatchObject({ available: true });
    for (const who of ["setter", "support", "viewer"] as const) await expect(previewDelivery(s.p.actor(who), s.id, "email", { now: NOW }), who).rejects.toMatchObject({ code: "forbidden" });
    await expect(previewDelivery(s.p.member, s.id, "email", { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    // The AI, the API and the system never send a customer anything from here.
    const agent = agentActor({ id: s.p.org.id, name: "Test workspace", timezone: "UTC" }, { id: "00000000-0000-4000-8000-000000000001", displayName: "Sales Assistant" }, ["proposals.send"]);
    await expect(previewDelivery(agent, s.id, "email")).rejects.toMatchObject({ code: "forbidden", message: "Only a signed-in member of the workspace can do this." });
    await expect(previewDelivery(s.p.system, s.id, "email")).rejects.toThrow();
    await expect(previewDelivery(s.p.actor("sales"), s.id, "carrier_pigeon")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("says why a message cannot be offered at all, in words, without throwing", async () => {
    const s = await shop();
    // A proposal that has not been sent.
    const q = await shop();
    await withdrawProposal(q.p.actor("sales"), q.id, { now: NOW });
    expect(await previewDelivery(q.p.actor("sales"), q.id, "email", { now: NOW })).toMatchObject({ available: false, reason: "not_sent", text: "Only a proposal that has been sent and not answered can be sent to the customer." });
    // A link that no longer works.
    await withSystem((db) => db.query("update proposal_share_links set revoked_at = now() where proposal_id = $1", [s.id]));
    expect(await previewDelivery(s.p.actor("sales"), s.id, "email", { now: NOW })).toMatchObject({ available: false, reason: "no_link" });
  });

  it("will not offer a proposal with no customer record, a removed one, or one whose email is not the record's", async () => {
    const p = await proposalOrg();
    await addDeliveryMessaging(p);
    const c = await customerFor(p);
    const noCustomer = await sentTo(p, c, { contactId: null });
    expect(await previewDelivery(p.actor("sales"), noCustomer.proposal.id, "email", { now: NOW })).toMatchObject({ available: false, reason: "no_customer" });
    const gone = await sentTo(p, await customerFor(p));
    await withSystem((db) => db.query("update contacts set archived_at = now() where id = (select contact_id from proposals where id = $1)", [gone.proposal.id]));
    expect(await previewDelivery(p.actor("sales"), gone.proposal.id, "email", { now: NOW })).toMatchObject({ available: false, reason: "contact_unreachable" });
    // The emailed code goes to the address on the proposal; the link would go to a different mailbox.
    const differs = await sentTo(p, await customerFor(p), { clientEmail: "someone.else@example.test" });
    const r = await previewDelivery(p.actor("sales"), differs.proposal.id, "email", { now: NOW });
    expect(r).toMatchObject({ available: false, reason: "address_differs" });
    expect((r as { text: string }).text).toContain("s***@example.test");
  });

  it("will not offer one whose last day has passed, even before the job that closes it has run", async () => {
    const s = await shop({ over: { validUntil: "2026-10-30" } });
    expect(await previewDelivery(s.p.actor("sales"), s.id, "email", { now: new Date("2026-10-31T09:00:00Z") })).toMatchObject({ available: false, reason: "proposal_expired" });
    expect(await previewDelivery(s.p.actor("sales"), s.id, "email", { now: new Date("2026-10-30T09:00:00Z") })).toMatchObject({ available: true });
  });

  it("warns when the proposal has no email address, because the customer could then read it but not answer it", async () => {
    const s = await shop({ over: { clientEmail: null } });
    const pre = await read(s);
    expect(pre.notes).toEqual(["There is no email address on the proposal, so the customer can read it but cannot answer it online."]);
  });

  it("tells a waiting message from a refused one", async () => {
    const s = await shop();
    const pre = await withQuietHours("11:00", "14:00", () => read(s));
    expect(pre.verdict).toMatchObject({ kind: "waiting", reason: "quiet_hours", waitingUntil: "2026-10-23T14:00:00.000Z" });
    expect(pre.verdict.text).toContain("Nothing is sent until you confirm");
  });
});

describe("what the send chain says no to, and that nothing is left behind", () => {
  const refusal = async (s: Shop, channel: "email" | "sms" | "whatsapp", reason: string) => {
    const pre = await read(s, channel);
    expect(pre.verdict, `preview ${reason}`).toMatchObject({ kind: "refused", reason });
    expect(pre.verdict.text).toMatch(/so it can't be sent\.$|can't be sent/);
    const r = await sendDelivery(s.p.actor("sales"), s.id, { channel, version: 1, wordingHash: pre.wordingHash }, { now: NOW });
    expect(r, `send ${reason}`).toMatchObject({ status: "refused", reason });
    // No half-made message, conversation, credit hold or delivery; one audit line.
    expect(await messageCount(s.p.org.id)).toBe(0);
    expect(await rows("select 1 from conversations where org_id = $1", [s.p.org.id])).toHaveLength(0);
    expect(await deliveries(s.id)).toHaveLength(0);
    expect(await rows("select 1 from usage_reservations where org_id = $1 and status = 'held'", [s.p.org.id])).toHaveLength(0);
    const audit = await rows<{ result: string; metadata: Record<string, unknown> }>("select result, metadata from audit_logs where org_id = $1 and action = 'proposals.delivery_refused' order by created_at desc limit 1", [s.p.org.id]);
    expect(audit[0]).toMatchObject({ result: "denied", metadata: { version: 1, channel, reason } });
    return r as Extract<SendDeliveryResult, { status: "refused" }>;
  };

  it("refuses a customer who has not agreed to messages on the channel, and sends once they have", async () => {
    const s = await shop({ consent: [] });
    const r = await refusal(s, "email", "no_consent");
    expect(r.text).toContain("There is no consent on record");
    await setContactConsent(s.p.actor("owner"), s.c.contactId, { channel: "email", purpose: "service", status: "granted", evidence: "Signed intake form on file, 12 Oct" });
    expect(await send(s)).toMatchObject({ status: "queued" });
  });

  it("keeps the channels apart: consent to email is not consent to text messages", async () => {
    const s = await shop({ consent: ["email"] });
    await refusal(s, "sms", "no_consent");
    expect(await send(s, "email")).toMatchObject({ status: "queued" });
  });

  it("refuses a customer who withdrew consent, and an address that opted out or bounced", async () => {
    const s = await shop();
    await setContactConsent(s.p.actor("owner"), s.c.contactId, { channel: "email", purpose: "service", status: "revoked", evidence: "Asked to stop, 20 Oct" });
    await refusal(s, "email", "no_consent");
    const t = await shop();
    await withSystem((db) => suppressAddress(db, { orgId: t.p.org.id, channel: "email", address: t.c.email, reason: "opt_out", source: "test" }));
    await refusal(t, "email", "suppressed");
  });

  it("refuses a channel the workspace has not set up, and a customer with no address on it", async () => {
    const s = await shop({ consent: ["email", "sms"], channels: ["email", "sms"] });
    await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'sms'", [s.p.org.id]));
    await refusal(s, "sms", "channel_not_ready");
    const t = await shop({ consent: ["email", "sms"] });
    await withSystem((db) => db.query("delete from contact_identities where org_id = $1 and contact_id = $2 and kind <> 'email'", [t.p.org.id, t.c.contactId]));
    await refusal(t, "sms", "contact_unreachable");
  });

  it("refuses WhatsApp until the customer has written first, as the chain does for every free-form message", async () => {
    const s = await shop({ channels: ["email", "whatsapp"], consent: ["email", "whatsapp"] });
    await refusal(s, "whatsapp", "whatsapp_window_closed");
  });

  it("refuses when the workspace has no service credits", async () => {
    const s = await shop({ credits: 0 });
    await refusal(s, "email", "credits");
  });

  it("refuses an address a website visitor typed and nobody has confirmed, as it does for every automatic message", async () => {
    const s = await shop();
    await withSystem((db) => db.query("update contact_identities set typed_by_visitor = true, verified = false where org_id = $1 and contact_id = $2", [s.p.org.id, s.c.contactId]));
    const r = await refusal(s, "email", "identity_unverified");
    expect(r.text).toContain("typed this address or number into the website chat and nobody has confirmed it");
  });

  it("refuses a customer a person on the team excluded from automatic messages", async () => {
    const s = await shop();
    await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [s.c.contactId]));
    const r = await refusal(s, "email", "held_by_person");
    expect(r.text).toContain("A person on your team excluded this customer from automatic messages");
  });

  it("refuses while customer messaging is paused, and for a suspended workspace", async () => {
    const s = await shop();
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason) values ($1, 'messaging', true, 'Reviewing replies')", [s.p.org.id]));
    await refusal(s, "email", "automation_paused");
    const t = await shop();
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [t.p.org.id]));
    await refusal(t, "email", "org_inactive");
  });

  it("does not turn a final refusal into a wait just because quiet hours are on", async () => {
    const s = await shop({ consent: [] });
    await withQuietHours("11:00", "14:00", async () => {
      const pre = await read(s);
      expect(pre.verdict.kind).toBe("refused");
    });
  });
});

describe("sending", () => {
  it("queues the message the person read, as the chain's own record, with the link as words", async () => {
    const s = await shop();
    const pre = await read(s);
    const r = await sendDelivery(s.p.actor("sales"), s.id, { channel: "email", version: 1, wordingHash: pre.wordingHash }, { now: NOW });
    expect(r).toMatchObject({ status: "queued", waitingUntil: null, delivery: { channel: "email", state: "queued", label: "Queued", ended: false, version: 1, addressMask: pre.addressMask } });

    const [d] = await deliveries(s.id);
    expect(d).toMatchObject({ version: 1, channel: "email", wording_version: pre.wordingVersion, wording_hash: pre.wordingHash, address_mask: pre.addressMask, requested_by: s.p.people.sales.id, withdrawn_at: null });
    const m = await message(d.message_id as string);
    expect(m).toMatchObject({
      status: "queued", scope: "delivery", purpose: "service", author_kind: "system", author_user_id: s.p.people.sales.id, channel: "email", owner_kind: "unassigned",
      dedupe_key: `proposal-delivery:${s.id}:1:email`, thread_key: `proposal:${s.id}`, subject: pre.subject,
    });
    expect(m.body).toContain("{{proposal.link}}");
    expect(m.body).not.toContain(s.token);
    expect(m.body).not.toMatch(/https?:/);
    expect(m.reservation_id).not.toBeNull();
    expect(await reservation(m.reservation_id)).toBe("held");
    expect(await eventKinds(s.id)).toContain("delivery_queued");
    const audit = await rows<{ actor_user_id: string; result: string; metadata: Record<string, unknown> }>("select actor_user_id, result, metadata from audit_logs where org_id = $1 and action = 'proposals.delivery_queued'", [s.p.org.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: s.p.people.sales.id, result: "success", metadata: { version: 1, channel: "email", deliveryId: d.id, wordingVersion: pre.wordingVersion } });
    // Where it went is kept on the delivery only, which a privacy request can clear; the history and the audit line, which stay, do not carry any part of the address.
    const history = await rows<{ detail: Record<string, unknown> }>("select detail from proposal_events where proposal_id = $1 and kind = 'delivery_queued'", [s.id]);
    expect(history).toHaveLength(1);
    expect(history[0].detail).toEqual({ channel: "email", deliveryId: d.id, waitingUntil: null });
    for (const stored of [JSON.stringify(audit), JSON.stringify(history)]) {
      expect(stored).not.toContain("***");
      expect(stored).not.toContain(s.c.email);
      expect(stored).not.toContain(s.c.email.slice(s.c.email.lastIndexOf("@")));
    }
  });

  it("hands the provider the real link, once, to the customer's address, and keeps it out of everything else", async () => {
    const logs = captureLogs();
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: NOW })).status).toBe("sent");
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].to).toBe(s.c.email);
    expect(rec.calls[0].channel).toBe("email");
    expect(rec.calls[0].subject).toMatch(/^Proposal P-\d{4}/);
    const link = TOKEN_RE.exec(rec.calls[0].body);
    expect(link, rec.calls[0].body).not.toBeNull();
    expect(rec.calls[0].body.match(/\/proposal\//g)).toHaveLength(1);
    expect(rec.calls[0].body).not.toContain("{{");
    // It is the very link the team would copy, and it opens the proposal.
    expect(link![1]).toBe(s.token);
    expect(rec.calls[0].body).toContain((await getShareUrl(s.p.actor("sales"), s.id, { now: NOW })).url);
    expect(await loadPublicProposal(s.token, { ip: freshIp(), now: NOW })).toMatchObject({ state: "open" });

    // The stored message is unchanged and the conversation's preview is masked.
    const after = await message(m.id);
    expect(after.status).toBe("sent");
    expect(after.body).toContain("{{proposal.link}}");
    expect(after.body).not.toContain(s.token);
    const preview = (await rows<{ last_message_preview: string }>("select last_message_preview from conversations where id = (select conversation_id from conversation_messages where id = $1)", [m.id]))[0].last_message_preview;
    expect(preview).toContain("[customer proposal link]");
    expect(preview).not.toContain(s.token);

    // The token is in no table at all, in no log line, and not in the client's own export.
    const tables = ["conversation_messages", "conversations", "proposal_events", "proposal_deliveries", "proposal_share_links", "proposals", "proposal_versions", "audit_logs", "notifications", "crm_events", "crm_activities",
      "metered_usage_events", "usage_reservations", "credit_ledger_entries", "email_outbox"];
    for (const table of tables) {
      const hit = await rows<{ n: string }>(`select count(*)::text as n from ${table} t where t::text like $1`, [`%${s.token}%`]);
      expect(Number(hit[0].n), `${table} holds the customer's link`).toBe(0);
    }
    const files = readZip((await buildExport(s.p.org.id)).bytes);
    expect(files.find((f) => f.name === "conversations/messages.json")!.data.toString("utf8")).toContain("[customer proposal link]");
    expect(files.some((f) => f.name === "proposals/deliveries.json")).toBe(true);
    for (const f of files) {
      const text = f.data.toString("utf8");
      expect(text, f.name).not.toContain(s.token);
      expect(text, f.name).not.toContain("{{proposal.link}}");
    }
    expect(logs.join("\n")).not.toContain(s.token);
  });

  it("says 'sent' only once the provider has taken the message, and never delivered or read, whatever the provider says later", async () => {
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    let detail = await getProposal(s.p.actor("sales"), s.id);
    expect(detail.deliveries[0]).toMatchObject({ state: "queued", label: "Queued" });
    expect((await dispatchMessage(m.id, { transport: recordingProvider("resend").transport, now: NOW })).status).toBe("sent");
    detail = await getProposal(s.p.actor("sales"), s.id);
    expect(detail.deliveries[0]).toMatchObject({ state: "sent", label: "Sent by email", tone: "success", channelLabel: "Email", requestedByName: expect.any(String) });
    // A provider's later report of delivery or reading changes what the chain holds, and the team is still told only that the provider accepted it.
    for (const status of ["delivered", "read"]) {
      await withSystem((db) => db.query("update conversation_messages set status = $2 where id = $1", [m.id, status]));
      detail = await getProposal(s.p.actor("sales"), s.id);
      expect(`${detail.deliveries[0].label} ${detail.deliveries[0].explain}`).not.toMatch(/\b(delivered|read|received|opened|seen)\b/i);
      expect(detail.deliveries[0].label).toBe("Sent by email");
    }
  });

  it("tells a failure from a refusal, and lets the same channel try again once a message has ended without reaching the customer", async () => {
    const s = await shop();
    await send(s);
    const first = await onlyMessage(s.id);
    // The provider refuses it outright.
    const refusing = recordingProvider("resend", () => ({ ok: false, retryable: false, error: "The address was refused." }));
    expect((await dispatchMessage(first.id, { transport: refusing.transport, now: NOW })).status).toBe("failed");
    let view = (await getProposal(s.p.actor("sales"), s.id)).deliveries[0];
    expect(view).toMatchObject({ state: "failed", label: "Not sent", ended: true });
    expect(view.explain).toContain("The email provider refused the message: The address was refused. Nothing reached the customer.");
    // The same channel may be tried again; the failed message's key is spent, so the new one takes the next number.
    expect(await send(s)).toMatchObject({ status: "queued" });
    const second = await message((await deliveries(s.id))[1].message_id as string);
    expect(second.dedupe_key).toBe(`proposal-delivery:${s.id}:1:email:1`);
    expect((await dispatchMessage(second.id, { transport: recordingProvider("resend").transport, now: NOW })).status).toBe("sent");
    // A provider that took a message and reported a failure later is not described as having refused it.
    await withSystem((db) => db.query("update conversation_messages set status = 'failed', failure_kind = 'rejected', status_detail = 'The mailbox is full.' where id = $1", [second.id]));
    view = (await getProposal(s.p.actor("sales"), s.id)).deliveries[0];
    expect(view).toMatchObject({ state: "failed", label: "Failed after it was sent", ended: true });
    expect(view.explain).toContain("took the message");
    expect(view.explain).not.toContain("Nothing reached the customer");
    // A provider that never answered leaves the outcome open, and says to check with the customer before sending again.
    const third = await shop();
    await send(third);
    const silent = recordingProvider("resend", () => ({ ok: false, retryable: false, error: "Resend did not confirm the send. The message was not confirmed sent." }));
    expect((await dispatchMessage((await onlyMessage(third.id)).id, { transport: silent.transport, now: NOW })).status).toBe("failed");
    expect((await getProposal(third.p.actor("sales"), third.id)).deliveries[0]).toMatchObject({ state: "failed", label: "Not confirmed", ended: true });
  });

  it("sends a text message to the customer's phone in one line, through the carrier that carries the workspace's texts", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    expect(await send(s, "sms")).toMatchObject({ status: "queued", delivery: { channel: "sms" } });
    const m = await onlyMessage(s.id);
    expect(m).toMatchObject({ channel: "sms", dedupe_key: `proposal-delivery:${s.id}:1:sms`, scope: "delivery" });
    const rec = recordingProvider("twilio");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: NOW })).status).toBe("sent");
    expect(rec.calls[0].to).toBe(s.c.phone);
    expect(rec.calls[0].body).toContain(s.url);
    expect(rec.calls[0].body).not.toContain("\n");
    expect((await deliveries(s.id))[0].address_mask).toBe(`***${s.c.phone?.slice(-4)}`);
  });

  it("records where the message really went, masked, at the moment it was sent", async () => {
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    const other = "new.address@example.test";
    await withSystem((db) => db.query("update contact_identities set value = $3 where org_id = $1 and contact_id = $2 and kind = 'email'", [s.p.org.id, s.c.contactId, other]));
    const rec = recordingProvider("resend");
    await dispatchMessage(m.id, { transport: rec.transport, now: NOW });
    expect(rec.calls[0].to).toBe(other);
    expect((await deliveries(s.id))[0].address_mask).toBe("n***@example.test");
  });

  it("sends a double click once, and a second person's click returns the first message", async () => {
    const s = await shop();
    const pre = await read(s);
    const input = { channel: "email" as const, version: 1, wordingHash: pre.wordingHash };
    const [a, b] = await Promise.all([sendDelivery(s.p.actor("sales"), s.id, input, { now: NOW }), sendDelivery(s.p.actor("manager"), s.id, input, { now: NOW })]);
    expect([a.status, b.status].sort()).toEqual(["already", "queued"]);
    expect(await deliveries(s.id)).toHaveLength(1);
    expect(await rows("select 1 from conversation_messages where org_id = $1 and scope = 'delivery'", [s.p.org.id])).toHaveLength(1);
    const again = await sendDelivery(s.p.actor("sales"), s.id, input, { now: NOW });
    expect(again).toMatchObject({ status: "already", delivery: { channel: "email", state: "queued" } });
    // After the provider took it, a request still sends nothing new.
    await dispatchMessage((await onlyMessage(s.id)).id, { transport: recordingProvider("resend").transport, now: NOW });
    const afterSent = await sendDelivery(s.p.actor("sales"), s.id, input, { now: NOW });
    expect(afterSent).toMatchObject({ status: "already", delivery: { state: "sent", label: "Sent by email" } });
    expect(await deliveries(s.id)).toHaveLength(1);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'proposals.delivery_queued'", [s.p.org.id])).toHaveLength(1);
    expect(await eventKinds(s.id).then((k) => k.filter((x) => x === "delivery_queued"))).toHaveLength(1);
  });

  it("allows the same version a message on another channel, and not the same one twice", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    expect(await send(s, "email")).toMatchObject({ status: "queued" });
    expect(await send(s, "sms")).toMatchObject({ status: "queued" });
    expect(await send(s, "email")).toMatchObject({ status: "already" });
    expect((await deliveries(s.id)).map((d) => d.channel)).toEqual(["email", "sms"]);
  });

  it("refuses a message that is not the one the person read, and a version that is not the one they looked at", async () => {
    const s = await shop();
    const pre = await read(s);
    const base = { channel: "email" as const, version: 1, wordingHash: pre.wordingHash };
    await expect(sendDelivery(s.p.actor("sales"), s.id, { ...base, wordingHash: "0".repeat(64) }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    await expect(sendDelivery(s.p.actor("sales"), s.id, { ...base, channel: "sms" }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    await expect(sendDelivery(s.p.actor("sales"), s.id, { ...base, version: 2 }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    await expect(sendDelivery(s.p.actor("sales"), s.id, { ...base, wordingHash: "not a hash" }, { now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(sendDelivery(s.p.actor("sales"), s.id, { ...base, version: 0 }, { now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(sendDelivery(s.p.actor("sales"), s.id, { ...base, channel: "fax" }, { now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await deliveries(s.id)).toHaveLength(0);
    // The wording changes if the proposal's number or the business name does: what was read is then stale.
    await withSystem((db) => db.query("update organizations set name = 'Renamed Dental' where id = $1", [s.p.org.id]));
    await expect(sendDelivery(s.p.actor("sales"), s.id, base, { now: NOW })).rejects.toThrow(/changed since you read it/);
  });

  it("is for people who can send proposals only, and only for this workspace's proposals", async () => {
    const s = await shop();
    const pre = await read(s);
    const input = { channel: "email" as const, version: 1, wordingHash: pre.wordingHash };
    for (const who of ["setter", "support", "viewer"] as const) await expect(sendDelivery(s.p.actor(who), s.id, input, { now: NOW }), who).rejects.toMatchObject({ code: "forbidden" });
    await expect(sendDelivery(s.p.member, s.id, input, { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(sendDelivery(s.p.system, s.id, input, { now: NOW })).rejects.toThrow();
    // Another workspace's owner cannot read, preview or send for it, nor see its messages.
    const other = await shop();
    await expect(previewDelivery(other.p.actor("owner"), s.id, "email", { now: NOW })).rejects.toMatchObject({ code: "not_found" });
    await expect(sendDelivery(other.p.actor("owner"), s.id, input, { now: NOW })).rejects.toMatchObject({ code: "not_found" });
    await expect(getProposal(other.p.actor("owner"), s.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await withSystem((db) => deliveriesFor(db, other.p.org.id, s.id))).toEqual([]);
    expect(await deliveries(s.id)).toHaveLength(0);
    expect(await messageCount(s.p.org.id)).toBe(0);
  });

  it("does nothing for a workspace a Super Admin has not switched proposals on for", async () => {
    const s = await shop();
    await setFeature(s.p.org.id, false);
    await expect(previewDelivery(s.p.actor("sales"), s.id, "email", { now: NOW })).rejects.toMatchObject({ code: "not_enabled" });
    await expect(sendDelivery(s.p.actor("sales"), s.id, { channel: "email", version: 1, wordingHash: "a".repeat(64) }, { now: NOW })).rejects.toMatchObject({ code: "not_enabled" });
  });

  it("lets someone who can only look at proposals see what became of each message, and nothing about how to send", async () => {
    const s = await shop();
    await send(s);
    await dispatchMessage((await onlyMessage(s.id)).id, { transport: recordingProvider("resend").transport, now: NOW });
    const seen = await getProposal(s.p.actor("viewer"), s.id);
    expect(seen.deliveries).toHaveLength(1);
    expect(seen.deliveries[0]).toMatchObject({ state: "sent", label: "Sent by email" });
    expect(JSON.stringify(seen)).not.toContain(s.token);
  });
});

describe("a message that waits for sending hours", () => {
  it("is queued with its due time, is not sent early, and goes once the hours open", async () => {
    const s = await shop();
    const r = await waiting(s);
    expect(r.delivery).toMatchObject({ state: "waiting", label: "Waiting for sending hours", sendAfter: "2026-10-23T14:00:00.000Z" });
    expect(r.waitingUntil).toBe("2026-10-23T14:00:00.000Z");
    const m = await onlyMessage(s.id);
    expect(m.status).toBe("queued");
    const rec = recordingProvider("resend");
    await withQuietHours("11:00", "14:00", async () => {
      expect((await dispatchMessage(m.id, { transport: rec.transport, now: NOW })).status).toBe("skipped");
      expect(rec.calls).toHaveLength(0);
      expect((await dispatchMessage(m.id, { transport: rec.transport, now: new Date("2026-10-23T14:30:00Z") })).status).toBe("sent");
    });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].body).toContain(s.url);
  });

  it("is sent in the customer's quiet hours only after they end, whatever the workspace's own clock says", async () => {
    const s = await shop({ timezone: "Asia/Manila" });
    await withQuietHours("20:00", "23:00", async () => {
      // 12:00 UTC is 20:00 in Manila: inside the quiet hours.
      const r = await send(s);
      expect(r).toMatchObject({ status: "queued", delivery: { state: "waiting" } });
      expect(new Date((r as { waitingUntil: string }).waitingUntil).toISOString()).toBe("2026-10-23T15:00:00.000Z");
    });
  });
});

describe("stopping a message that has not gone out", () => {
  const stopped = async (s: Shop, reason: string, text: RegExp) => {
    const [d] = await deliveries(s.id);
    expect(d.withdrawn_at, "delivery withdrawn").not.toBeNull();
    expect(d.withdrawn_reason).toBe(reason);
    const m = await message(d.message_id as string);
    expect(m).toMatchObject({ status: "blocked", blocked_reason: reason });
    expect(await reservation(m.reservation_id)).toBe("released");
    const detail = await getProposal(s.p.actor("sales"), s.id);
    expect(detail.deliveries[0]).toMatchObject({ state: "withdrawn", label: "Stopped before it was sent", ended: true });
    expect(detail.deliveries[0].explain).toMatch(text);
    expect(await eventKinds(s.id)).toContain("delivery_withdrawn");
    // The dispatcher no longer sees it.
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: new Date("2026-10-23T15:00:00Z") })).status).toBe("skipped");
    expect(rec.calls).toHaveLength(0);
  };

  it("when the proposal is withdrawn", async () => {
    const s = await shop();
    await waiting(s);
    await withdrawProposal(s.p.actor("sales"), s.id, { now: NOW });
    await stopped(s, "proposal_withdrawn", /withdrawn before the message went out/);
  });

  it("when it is revised, and the new version needs a new send with a new link", async () => {
    const s = await shop();
    await waiting(s);
    await reviseProposal(s.p.actor("sales"), s.id, { now: NOW });
    await stopped(s, "proposal_revised", /revised, so the message about the earlier version was stopped/);
    // The history line belongs to the version the message was about, not the draft the revision started.
    expect((await rows<{ version: number }>("select version from proposal_events where proposal_id = $1 and kind = 'delivery_withdrawn'", [s.id]))[0].version).toBe(1);
    // Version 2 is a draft until it is approved and sent again; then it has its own link and nothing carries over from version 1.
    await submitForApproval(s.p.member, s.id, { now: NOW });
    await decideProposal(s.p.actor("manager"), s.id, { decision: "approve", version: 2 }, { now: NOW });
    await sendProposal(s.p.actor("sales"), s.id, { version: 2 }, { now: NOW });
    const pre = await read(s);
    // The count of messages is per version: the new one starts from the beginning.
    expect(pre).toMatchObject({ version: 2, standing: null, remaining: 6 });
    const r = await sendDelivery(s.p.actor("sales"), s.id, { channel: "email", version: 2, wordingHash: pre.wordingHash }, { now: NOW });
    expect(r).toMatchObject({ status: "queued", delivery: { version: 2 } });
    const d = await deliveries(s.id);
    expect(d.map((x) => x.version)).toEqual([1, 2]);
    expect(d[0].link_id).not.toBe(d[1].link_id);
    // The earlier version's key is spent: the second message has its own.
    expect((await message(d[1].message_id as string)).dedupe_key).toBe(`proposal-delivery:${s.id}:2:email`);
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(d[1].message_id as string, { transport: rec.transport, now: NOW })).status).toBe("sent");
    const newToken = TOKEN_RE.exec(rec.calls[0].body)![1];
    expect(newToken).not.toBe(s.token);
    expect(await loadPublicProposal(newToken, { ip: freshIp(), now: NOW })).toMatchObject({ state: "open" });
    // The old link no longer opens.
    expect(await loadPublicProposal(s.token, { ip: freshIp(), now: NOW })).toMatchObject({ state: "withdrawn" });
  });

  it("when a person records the customer's answer", async () => {
    const s = await shop();
    await waiting(s);
    await recordOfflineDecision(s.p.actor("owner"), s.id, { decision: "accepted", version: 1 }, { now: NOW });
    await stopped(s, "proposal_answered", /answered before the message went out/);
  });

  it("when the customer answers on the page", async () => {
    const s = await shop();
    await waiting(s);
    const session = await verifiedSession(s.token, s.c.email);
    expect(await decideOnProposal(s.token, ACCEPT, { ip: freshIp(), now: NOW, sessionToken: session })).toEqual({ outcome: "accepted" });
    await stopped(s, "proposal_answered", /answered/);
  });

  it("when the link is replaced, so a link that would not open is never sent; a new send then carries the new link", async () => {
    const s = await shop();
    await waiting(s);
    const renewed = await renewShareLink(s.p.actor("sales"), s.id, { now: NOW });
    await stopped(s, "proposal_link_renewed", /link was replaced before the message went out/);
    const r = await send(s);
    expect(r).toMatchObject({ status: "queued" });
    const d = await deliveries(s.id);
    expect(d).toHaveLength(2);
    // The first message's key is spent, so the second takes the next number.
    expect((await message(d[1].message_id as string)).dedupe_key).toBe(`proposal-delivery:${s.id}:1:email:1`);
    const rec = recordingProvider("resend");
    await dispatchMessage(d[1].message_id as string, { transport: rec.transport, now: NOW });
    expect(rec.calls[0].body).toContain(renewed.url);
    expect(rec.calls[0].body).not.toContain(s.token);
  });

  it("when the proposal expires", async () => {
    const s = await shop({ over: { validUntil: "2026-10-30" } });
    await waiting(s);
    const run = await expireDueProposals({ now: new Date("2026-10-31T12:00:00Z") });
    expect(run.expired).toBeGreaterThanOrEqual(1);
    await stopped(s, "proposal_expired", /expired before the message went out/);
  });

  it("when the customer asks for their data to be erased, which also removes the masked address and the text", async () => {
    const s = await shop();
    await waiting(s);
    await redactContact(s.p.actor("owner"), s.c.contactId, "Customer asked for erasure by email, 22 Oct");
    const [d] = await deliveries(s.id);
    expect(d).toMatchObject({ withdrawn_reason: "privacy_request", address_mask: null });
    const m = await message(d.message_id as string);
    expect(m).toMatchObject({ status: "blocked", blocked_reason: "privacy_request", body: "[removed on request]" });
    expect(await reservation(m.reservation_id)).toBe("released");
  });

  it("when a person puts a hold on the customer, and says so in the history of the hold", async () => {
    const s = await shop();
    await waiting(s);
    await setRetentionPaused(ctxFor(s.p.people.owner, s.p.org, CRM_ROLES.owner), s.c.contactId, true, "In a dispute");
    const m = await onlyMessage(s.id);
    expect(m).toMatchObject({ status: "blocked", blocked_reason: "held_by_person" });
    expect(await reservation(m.reservation_id)).toBe("released");
    const detail = await getProposal(s.p.actor("sales"), s.id);
    expect(detail.deliveries[0]).toMatchObject({ state: "blocked", label: "Not sent", ended: true });
    expect(detail.deliveries[0].explain).toContain("excluded this customer from automatic messages");
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'contact.retention_paused'", [s.p.org.id]);
    expect(audit[0].metadata).toMatchObject({ withdrawnDeliveries: 1 });
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: new Date("2026-10-23T15:00:00Z") })).status).toBe("skipped");
    expect(rec.calls).toHaveLength(0);
  });

  it("leaves a message that is already on its way, or that the provider took, as it is", async () => {
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    await dispatchMessage(m.id, { transport: recordingProvider("resend").transport, now: NOW });
    await withdrawProposal(s.p.actor("sales"), s.id, { now: NOW });
    const [d] = await deliveries(s.id);
    expect(d.withdrawn_at).toBeNull();
    expect((await message(m.id)).status).toBe("sent");
    expect((await getProposal(s.p.actor("sales"), s.id)).deliveries[0]).toMatchObject({ state: "sent", label: "Sent by email" });
    expect(await eventKinds(s.id)).not.toContain("delivery_withdrawn");
  });

  it("limits what any one version can send, counting messages that ended, and then points at copying the link", async () => {
    const s = await shop();
    for (let i = 0; i < 6; i += 1) {
      expect(await waiting(s)).toMatchObject({ status: "queued" });
      await renewShareLink(s.p.actor("sales"), s.id, { now: NOW });
    }
    const pre = await read(s);
    expect(pre.remaining).toBe(0);
    const r = await sendDelivery(s.p.actor("sales"), s.id, { channel: "email", version: 1, wordingHash: pre.wordingHash }, { now: NOW });
    expect(r).toMatchObject({ status: "refused", reason: "too_many" });
    expect((await deliveries(s.id))).toHaveLength(6);
    expect((await deliveries(s.id)).map((d) => d.withdrawn_reason)).toEqual(Array(6).fill("proposal_link_renewed"));
    const keys = (await rows<{ dedupe_key: string }>("select dedupe_key from conversation_messages where org_id = $1 order by created_at", [s.p.org.id])).map((k) => k.dedupe_key);
    expect(keys).toEqual([0, 1, 2, 3, 4, 5].map((n) => (n === 0 ? `proposal-delivery:${s.id}:1:email` : `proposal-delivery:${s.id}:1:email:${n}`)));
  });
});

describe("checked again right before it leaves", () => {
  const dispatchBlocked = async (s: Shop, reason: string) => {
    const m = await onlyMessage(s.id);
    const rec = recordingProvider("resend");
    expect((await dispatchMessage(m.id, { transport: rec.transport, now: NOW })).status).toBe("blocked");
    expect(rec.calls).toHaveLength(0);
    const after = await message(m.id);
    expect(after).toMatchObject({ status: "blocked", blocked_reason: reason });
    expect(await reservation(after.reservation_id)).toBe("released");
    // Read with trusted code: a suspended workspace, or one with proposals switched off, is not one a member's own read can open.
    return (await withSystem((db) => deliveriesFor(db, s.p.org.id, s.id, NOW)))[0];
  };

  it("stops it when a person's hold was set without the hold's own withdrawal reaching it", async () => {
    const s = await shop();
    await send(s);
    await withSystem((db) => db.query("update contacts set retention_paused = true where id = $1", [s.c.contactId]));
    const view = await dispatchBlocked(s, "held_by_person");
    expect(view).toMatchObject({ state: "blocked", label: "Not sent" });
  });

  it("stops it when customer messaging was paused, and when the workspace was suspended, after it was queued", async () => {
    const s = await shop();
    await send(s);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason) values ($1, 'outbound', true, 'Reviewing')", [s.p.org.id]));
    expect((await dispatchBlocked(s, "automation_paused")).explain).toContain("Customer messaging");
    const t = await shop();
    await send(t);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [t.p.org.id]));
    await dispatchBlocked(t, "org_inactive");
  });

  it("stops it when the customer withdrew consent or the address opted out after it was queued", async () => {
    const s = await shop();
    await send(s);
    await withSystem((db) => suppressAddress(db, { orgId: s.p.org.id, channel: "email", address: s.c.email, reason: "opt_out", source: "test" }));
    expect((await dispatchBlocked(s, "suppressed")).explain).toContain("opted out");
  });

  it("does not send a link that has stopped working, whatever stopped it and whether or not anything withdrew the message", async () => {
    const cases: Array<[string, string]> = [
      ["the proposal was withdrawn behind the module's back", "update proposals set status = 'withdrawn', closed_at = now() where id = $1"],
      ["the proposal was answered", "update proposals set status = 'declined', closed_at = now() where id = $1"],
      ["the version moved on", "update proposals set version = version + 1, status = 'draft', approved_version = null, approved_by = null, approved_at = null where id = $1"],
      ["the link was closed", "update proposal_share_links set revoked_at = now() where proposal_id = $1"],
      ["the link ran out", "update proposal_share_links set expires_at = now() - interval '1 day' where proposal_id = $1"],
      ["the last day passed", "update proposals set valid_until = '2026-10-01' where id = $1"],
    ];
    for (const [what, sql] of cases) {
      const s = await shop();
      await send(s);
      // Written straight to the rows, the way a fault in some other code path could leave them: the dispatcher reads the facts, not the history of how they came about.
      await withSystem((db) => db.query(sql, [s.id]));
      const view = await dispatchBlocked(s, "proposal_link_unavailable");
      expect(view.explain, what).toContain("link had stopped working");
    }
  });

  it("does not send a link for a workspace whose proposals were switched off", async () => {
    const s = await shop();
    await send(s);
    await setFeature(s.p.org.id, false);
    await dispatchBlocked(s, "proposal_link_unavailable");
  });

  it("gives a link for a message only to the workspace that owns it, and only for the channel it was made for", async () => {
    const s = await shop();
    await send(s);
    const m = await onlyMessage(s.id);
    const other = await shop();
    const { link, wrongOrg, wrongChannel, nonsense } = await withSystem(async (db) => ({
      link: await proposalLinkForMessage(db, s.p.org.id, m.id, s.c.email, "email", NOW),
      wrongOrg: await proposalLinkForMessage(db, other.p.org.id, m.id, s.c.email, "email", NOW),
      wrongChannel: await proposalLinkForMessage(db, s.p.org.id, m.id, s.c.email, "sms", NOW),
      nonsense: await proposalLinkForMessage(db, s.p.org.id, "00000000-0000-4000-8000-000000000000", s.c.email, "email", NOW),
    }));
    expect(link).toBe(s.url);
    expect([wrongOrg, wrongChannel, nonsense]).toEqual([null, null, null]);
  });

  it("never fills the link into any other message, whoever wrote it, and sends nothing", async () => {
    const s = await shop();
    const typed = "Here you go: {{proposal.link}}";
    const queue = async (scope: "human" | "reply" | "reminder" | "delivery", actor: Parameters<typeof queueOutbound>[1]["actor"]) => {
      const queued = await withSystem(async (db) => {
        const conversationId = await deliveryConversation(db, { orgId: s.p.org.id, contactId: s.c.contactId, channel: "email", threadKey: `stray:${scope}`, subject: "Hello" });
        return queueOutbound(db, { orgId: s.p.org.id, conversationId, scope, actor, body: typed, now: NOW, businessHoursOnly: false });
      });
      expect(queued.status, scope).toBe("queued");
      const rec = recordingProvider("resend");
      expect((await dispatchMessage(queued.messageId, { transport: rec.transport, now: NOW })).status, scope).toBe("blocked");
      expect(rec.calls, scope).toHaveLength(0);
      expect((await message(queued.messageId)).blocked_reason, scope).toBe("proposal_link_unavailable");
    };
    await queue("human", { kind: "human", userId: s.p.people.sales.id });
    // A delivery-scope message with no proposal delivery behind it (an invoice's, say) is not given a proposal's link either.
    await queue("delivery", { kind: "system", userId: s.p.people.sales.id });
  });
});

describe("the words on the tab", () => {
  it("lists each message newest first with its channel, version, who asked and what became of it", async () => {
    const s = await shop({ consent: ["email", "sms"] });
    await send(s, "email");
    await send(s, "sms");
    const detail = await getProposal(s.p.actor("owner"), s.id);
    expect(detail.deliveries.map((d) => d.channel)).toEqual(["sms", "email"]);
    expect(detail.deliveries.every((d) => d.version === 1 && d.requestedByName && d.state === "queued")).toBe(true);
    expect(JSON.stringify(detail.deliveries)).not.toMatch(/https?:|\{\{|proposal\//);
    const kinds = detail.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "delivery_queued")).toHaveLength(2);
  });

  it("shows nothing for a proposal that was never sent from here, including the copy-link route", async () => {
    const s = await shop();
    expect((await getProposal(s.p.actor("sales"), s.id)).deliveries).toEqual([]);
    expect(await withSystem((db) => deliveriesFor(db, s.p.org.id, s.id))).toEqual([]);
  });

  it("keeps the copy-link route working alongside, and makes copying the link send nothing", async () => {
    const s = await shop();
    const before = await messageCount(s.p.org.id);
    expect((await getShareUrl(s.p.actor("sales"), s.id, { now: NOW })).url).toBe(s.url);
    expect(await messageCount(s.p.org.id)).toBe(before);
  });
});
