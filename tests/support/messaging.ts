// Synthetic fixtures for the messaging tests. Nothing here contacts a provider.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { adjustCredits } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { saveCredential } from "@/server/security/credentials";
import { ingestInbound, type InboundInput } from "@/server/messaging/ingest";
import type { ChannelProvider, ProviderResult, ProviderSendRequest } from "@/server/messaging/provider";
import type { GhlTransportRequest } from "@/server/messaging/transports/ghl";
import type { ChannelTransport, TransportName, TransportSendRequest, TransportSender } from "@/server/messaging/transports/types";
import { CHANNELS, type Channel } from "@/lib/messaging";
import type { OrgRole } from "@/lib/permissions";
import { addMember, agencyUser, createOrg, createUser, ctxFor, uid } from "./fixtures";

export type Person = { id: string; email: string };

/** How a fixture channel sends: GoHighLevel (the default) or a native provider with a synthetic, already-tested setup. */
export interface FixtureChannel {
  provider: TransportName;
  identity: string;
  senderId: string | null;
  accountId: string | null;
  credentialId: string | null;
}

export interface MessagingOrg {
  org: Awaited<ReturnType<typeof createOrg>>;
  people: Record<"owner" | "manager" | "sales" | "support" | "viewer", Person>;
  superAdmin: ReturnType<typeof agencyUser>;
  salesAgentId: string;
  ctx: (who: keyof MessagingOrg["people"]) => ReturnType<typeof ctxFor>;
  channels: Record<Channel, FixtureChannel>;
}

const ROLE: Record<keyof MessagingOrg["people"], OrgRole> = { owner: "owner", manager: "admin", sales: "sales_rep", support: "support", viewer: "viewer" };
const NATIVE_FOR: Record<Channel, Exclude<TransportName, "ghl">> = { email: "resend", sms: "twilio", whatsapp: "meta_whatsapp" };

/** Wholesale rates (micro-dollars per unit) the fixtures publish. Native rates differ from GoHighLevel's so tests can tell them apart. */
export const FIXTURE_RATES = {
  ghl: { sms_segment: 8000, whatsapp_message: 5000, email_send: 1000 },
  twilio: { sms_segment: 7900 },
  meta_whatsapp: { whatsapp_message: 4200 },
  resend: { email_send: 900 },
} as const;

const hex = (n: number) => crypto.randomBytes(n).toString("hex");
const digits = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 1 + crypto.randomInt(9) : crypto.randomInt(10))).join("");

function providerFor(channel: Channel, opt: MessagingOrgOptions["provider"]): TransportName {
  if (!opt) return "ghl";
  const want = typeof opt === "string" ? opt : opt[channel];
  // A single native name only applies to the channel it can carry; the others stay on GoHighLevel.
  return want && (want === "ghl" || want === NATIVE_FOR[channel]) ? want : "ghl";
}

export interface MessagingOrgOptions {
  name?: string;
  credits?: number;
  autonomous?: boolean;
  autoReply?: boolean;
  /** One provider for every channel it can carry, or one per channel. Default: GoHighLevel everywhere, as before native transports. */
  provider?: TransportName | Partial<Record<Channel, TransportName>>;
  /** Publish usage rates for the native providers in use (default true). GoHighLevel's rates are always published. */
  publishNativeRates?: boolean;
  /** Switch the new inbox on for the workspace (default true; real workspaces start with it off). Pass false to test the previous inbox. */
  inboxRollout?: boolean;
}

/**
 * A workspace that is ready to message: five roles, a verified and enabled SMS/WhatsApp/email setup, published usage rates,
 * credits, and a Sales Assistant that passed its connection check and works autonomously with automatic replies switched on.
 * Quiet hours are disabled in the shared policy so ordinary tests do not depend on the time of day. A native channel gets a synthetic
 * credential in the test vault, a synthetic sender and a recorded passing capability test (no provider is called).
 */
export async function messagingOrg(opts: MessagingOrgOptions = {}): Promise<MessagingOrg> {
  const org = await createOrg({ name: opts.name ?? `Messaging ${uid()}` });
  const people = {
    owner: await createUser({ name: "Olivia Owner" }),
    manager: await createUser({ name: "Mia Manager" }),
    sales: await createUser({ name: "Sam Sales" }),
    support: await createUser({ name: "Sue Support" }),
    viewer: await createUser({ name: "Vic Viewer" }),
  };
  for (const [who, person] of Object.entries(people) as Array<[keyof typeof people, Person]>) await addMember(org.id, person.id, ROLE[who]);
  const superUser = await createUser({ platformRole: "agency_super_admin" });
  const superAdmin = agencyUser(superUser, "agency_super_admin");
  const agent = await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'sales_assistant'", [org.id]));
  const salesAgentId = agent.rows[0].id;
  const channels = {} as Record<Channel, FixtureChannel>;

  await withSystem(async (db) => {
    await db.query("update organizations set timezone = 'UTC' where id = $1", [org.id]);
    await db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
    if (opts.inboxRollout !== false) await db.query("insert into inbox_rollout (org_id, enabled, note, enabled_at) values ($1, true, 'Test fixture', now())", [org.id]);
    await db.query(
      "update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = $2 where id = $1",
      [salesAgentId, opts.autonomous === false ? "approval_required" : "autonomous"],
    );
    await db.query(
      "insert into messaging_settings (org_id, auto_reply_enabled) values ($1, $2) on conflict (org_id) do update set auto_reply_enabled = excluded.auto_reply_enabled",
      [org.id, opts.autoReply !== false],
    );
    for (const channel of ["sms", "whatsapp", "email"] as const) {
      const provider = providerFor(channel, opts.provider);
      const registration = channel === "email" ? "not_required" : "approved";
      if (provider === "ghl") {
        const identity = channel === "email" ? "hello@example.test" : "+15550001111";
        await db.query(
          `insert into messaging_channels (org_id, channel, enabled, sender_identity, sender_verified_at, registration_status)
           values ($1, $2, true, $3, now(), $4)`,
          [org.id, channel, identity, registration],
        );
        channels[channel] = { provider, identity, senderId: null, accountId: null, credentialId: null };
        continue;
      }
      const identity = channel === "email" ? `Messaging Fixture <hello-${hex(3)}@example.test>` : `+1555${digits(7)}`;
      const senderId = provider === "resend" ? crypto.randomUUID() : provider === "twilio" ? `MG${hex(16)}` : digits(15);
      const accountId = provider === "twilio" ? `AC${hex(16)}` : provider === "meta_whatsapp" ? digits(15) : null;
      const saved = await saveCredential(db, { orgId: org.id, provider, label: `${provider} (synthetic test)`, secret: `synthetic-${provider}-credential-${hex(12)}`, actorId: superUser.id });
      await db.query(
        `insert into messaging_channels (org_id, channel, provider, enabled, sender_identity, sender_verified_at, registration_status, provider_sender_id, provider_account_id,
           credential_id, capability_test, capability_tested_at)
         values ($1, $2, $3, true, $4, now(), $5, $6, $7, $8, $9::jsonb, now())`,
        [org.id, channel, provider, identity, registration, senderId, accountId, saved.id, JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), checks: [{ label: "Synthetic", ok: true, detail: "Test fixture." }] })],
      );
      channels[channel] = { provider, identity, senderId, accountId, credentialId: saved.id };
    }
    await db.query("insert into whatsapp_templates (org_id, template_id, name, status) values ($1, 'tmpl_followup', 'Follow up', 'approved'), ($1, 'tmpl_pending', 'Pending', 'pending')", [org.id]);
    const credit = Math.round((opts.credits ?? 20) * 1_000_000);
    if (credit > 0) await adjustCredits(db, { orgId: org.id, deltaMicros: credit, reason: "seed credit for tests", userId: people.owner.id });
  });
  await publishUnitRate(superAdmin, { provider: "ghl", unitType: "sms_segment", wholesaleMicrosPerUnit: FIXTURE_RATES.ghl.sms_segment });
  await publishUnitRate(superAdmin, { provider: "ghl", unitType: "whatsapp_message", wholesaleMicrosPerUnit: FIXTURE_RATES.ghl.whatsapp_message });
  await publishUnitRate(superAdmin, { provider: "ghl", unitType: "email_send", wholesaleMicrosPerUnit: FIXTURE_RATES.ghl.email_send });
  if (opts.publishNativeRates !== false) {
    for (const channel of CHANNELS) {
      const provider = channels[channel].provider;
      if (provider === "ghl") continue;
      for (const [unitType, wholesale] of Object.entries(FIXTURE_RATES[provider])) await publishUnitRate(superAdmin, { provider, unitType, wholesaleMicrosPerUnit: wholesale });
    }
  }

  return { org, people, superAdmin, salesAgentId, ctx: (who) => ctxFor(people[who], org, ROLE[who]), channels };
}

let counter = 0;
export const phone = () => `+6391${String(70000000 + ++counter + Math.floor(Math.random() * 1000) * 1000).padStart(8, "0")}`;

/** An inbound customer message. GoHighLevel by default (with a CRM contact id); pass provider for a native one, which has none. */
export async function inbound(orgId: string, over: Partial<InboundInput> = {}) {
  const address = over.address ?? phone();
  const id = over.providerMessageId ?? `m_${crypto.randomBytes(6).toString("hex")}`;
  const provider = over.provider ?? "ghl";
  const ghlContactId = "ghlContactId" in over ? over.ghlContactId : provider === "ghl" ? `ghl_${address.replace(/\W/g, "")}` : null;
  const result = await withSystem((db) =>
    ingestInbound(db, { orgId, provider, channel: "sms", address, body: "Hi, do you have availability this week?", providerMessageId: id, name: over.name ?? "Maria Santos", ...over, ghlContactId }),
  );
  return { ...result, address };
}

/**
 * One send a recorder saw, in the provider-neutral shape plus the GoHighLevel-only fields (from-identity, template id). contactRef is
 * the GoHighLevel contact id ("" when there is none, as the original contract had it); requestContactRef is exactly what was passed.
 */
export type RecordedSend = Omit<TransportSendRequest, "contactRef"> & { contactRef: string; requestContactRef: string | null; fromIdentity: string | null; templateId: string | null };
export type RecorderReply = (req: RecordedSend, call: number) => ProviderResult;

const defaultReply: RecorderReply = (_r, n) => ({ ok: true, providerMessageId: `pm_${n}_${crypto.randomBytes(4).toString("hex")}` });
const noSender: TransportSender = { identity: null, senderId: null, accountId: null, credentialId: null };

/**
 * Records every send attempt and answers with whatever the test asks for. Named "ghl" unless told otherwise:
 * recordingProvider(), recordingProvider(reply), recordingProvider("twilio"), recordingProvider("twilio", reply).
 * Pass `provider` (the original contract) or `transport` to dispatchMessage/dispatchDue; either replaces only the transport of its name.
 */
export function recordingProvider(nameOrReply: TransportName | RecorderReply = "ghl", maybeReply?: RecorderReply) {
  const name: TransportName = typeof nameOrReply === "string" ? nameOrReply : "ghl";
  const reply: RecorderReply = typeof nameOrReply === "function" ? nameOrReply : (maybeReply ?? defaultReply);
  const calls: RecordedSend[] = [];
  const provider: ChannelProvider = {
    name,
    async send(req: ProviderSendRequest) {
      const recorded: RecordedSend = {
        ...req,
        to: req.to ?? "",
        contactRef: req.contactRef,
        requestContactRef: req.contactRef || null,
        sender: req.sender ?? { ...noSender, identity: req.fromIdentity },
        fromIdentity: req.fromIdentity,
        templateId: req.templateId ?? null,
      };
      calls.push(recorded);
      return reply(recorded, calls.length);
    },
  };
  const transport: ChannelTransport = {
    name,
    channels: CHANNELS,
    requiresContactRef: name === "ghl",
    async send(req) {
      const recorded: RecordedSend = { ...req, contactRef: req.contactRef ?? "", requestContactRef: req.contactRef, fromIdentity: req.sender.identity, templateId: (req as GhlTransportRequest).templateId ?? null };
      calls.push(recorded);
      return reply(recorded, calls.length);
    },
  };
  return { provider, transport, calls };
}

export async function messageRow(id: string) {
  const { rows } = await withSystem((db) => db.query<Record<string, unknown>>("select * from conversation_messages where id = $1", [id]));
  return rows[0];
}
