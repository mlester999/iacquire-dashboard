// Synthetic fixtures for the messaging tests. Nothing here contacts a provider.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { adjustCredits } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { ingestInbound, type InboundInput } from "@/server/messaging/ingest";
import type { ChannelProvider, ProviderResult, ProviderSendRequest } from "@/server/messaging/provider";
import type { OrgRole } from "@/lib/permissions";
import { addMember, agencyUser, createOrg, createUser, ctxFor, uid } from "./fixtures";

export type Person = { id: string; email: string };

export interface MessagingOrg {
  org: Awaited<ReturnType<typeof createOrg>>;
  people: Record<"owner" | "manager" | "sales" | "support" | "viewer", Person>;
  superAdmin: ReturnType<typeof agencyUser>;
  salesAgentId: string;
  ctx: (who: keyof MessagingOrg["people"]) => ReturnType<typeof ctxFor>;
}

const ROLE: Record<keyof MessagingOrg["people"], OrgRole> = { owner: "owner", manager: "admin", sales: "sales_rep", support: "support", viewer: "viewer" };

/**
 * A workspace that is ready to message: five roles, a verified and enabled SMS/WhatsApp/email setup, published usage rates,
 * credits, and a Sales Assistant that passed its connection check and works autonomously with automatic replies switched on.
 * Quiet hours are disabled in the shared policy so ordinary tests do not depend on the time of day.
 */
export async function messagingOrg(opts: { name?: string; credits?: number; autonomous?: boolean; autoReply?: boolean } = {}): Promise<MessagingOrg> {
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

  await withSystem(async (db) => {
    await db.query("update organizations set timezone = 'UTC' where id = $1", [org.id]);
    await db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
    await db.query(
      "update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = $2 where id = $1",
      [salesAgentId, opts.autonomous === false ? "approval_required" : "autonomous"],
    );
    await db.query(
      "insert into messaging_settings (org_id, auto_reply_enabled) values ($1, $2) on conflict (org_id) do update set auto_reply_enabled = excluded.auto_reply_enabled",
      [org.id, opts.autoReply !== false],
    );
    for (const channel of ["sms", "whatsapp", "email"] as const) {
      await db.query(
        `insert into messaging_channels (org_id, channel, enabled, sender_identity, sender_verified_at, registration_status)
         values ($1, $2, true, $3, now(), $4)`,
        [org.id, channel, channel === "email" ? "hello@example.test" : "+15550001111", channel === "email" ? "not_required" : "approved"],
      );
    }
    await db.query("insert into whatsapp_templates (org_id, template_id, name, status) values ($1, 'tmpl_followup', 'Follow up', 'approved'), ($1, 'tmpl_pending', 'Pending', 'pending')", [org.id]);
    const credit = Math.round((opts.credits ?? 20) * 1_000_000);
    if (credit > 0) await adjustCredits(db, { orgId: org.id, deltaMicros: credit, reason: "seed credit for tests", userId: people.owner.id });
  });
  await publishUnitRate(superAdmin, { provider: "ghl", unitType: "sms_segment", wholesaleMicrosPerUnit: 8000 });
  await publishUnitRate(superAdmin, { provider: "ghl", unitType: "whatsapp_message", wholesaleMicrosPerUnit: 5000 });
  await publishUnitRate(superAdmin, { provider: "ghl", unitType: "email_send", wholesaleMicrosPerUnit: 1000 });

  return { org, people, superAdmin, salesAgentId, ctx: (who) => ctxFor(people[who], org, ROLE[who]) };
}

let counter = 0;
export const phone = () => `+6391${String(70000000 + ++counter + Math.floor(Math.random() * 1000) * 1000).padStart(8, "0")}`;

export async function inbound(orgId: string, over: Partial<InboundInput> = {}) {
  const address = over.address ?? phone();
  const id = over.providerMessageId ?? `m_${crypto.randomBytes(6).toString("hex")}`;
  const result = await withSystem((db) =>
    ingestInbound(db, { orgId, provider: "ghl", channel: "sms", address, body: "Hi, do you have availability this week?", providerMessageId: id, ghlContactId: over.ghlContactId ?? `ghl_${address.replace(/\W/g, "")}`, name: over.name ?? "Maria Santos", ...over }),
  );
  return { ...result, address };
}

/** Records every send attempt and answers with whatever the test asks for. */
export function recordingProvider(reply: (req: ProviderSendRequest, call: number) => ProviderResult = (_r, n) => ({ ok: true, providerMessageId: `pm_${n}_${crypto.randomBytes(4).toString("hex")}` })) {
  const calls: ProviderSendRequest[] = [];
  const provider: ChannelProvider = {
    name: "ghl",
    async send(req) {
      calls.push(req);
      return reply(req, calls.length);
    },
  };
  return { provider, calls };
}

export async function messageRow(id: string) {
  const { rows } = await withSystem((db) => db.query<Record<string, unknown>>("select * from conversation_messages where id = $1", [id]));
  return rows[0];
}
