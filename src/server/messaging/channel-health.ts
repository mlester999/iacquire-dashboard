import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { isTransportName, transportWritesEnabled } from "@/server/messaging/transports";
import { TRANSPORT_LABELS, type TransportName } from "@/server/messaging/transports/types";
import { CHANNELS, CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import type { ChannelState } from "@/lib/inbox";
import type { OrgContext } from "@/server/tenancy/context";

// What the inbox says about each channel. "Connected" is claimed only when the database says a verified sender is switched on AND the
// environment lets this provider send; a channel that is verified but held back, or whose recent sends mostly fail, says exactly that.
// Nothing here calls a provider: it reads what the channel setup (src/server/messaging/channels.ts) and the send path already recorded.

export interface ChannelHealth {
  /** The inbox channel: sms, whatsapp, email, or the two that are not message channels. */
  key: Channel | "web_chat" | "phone";
  label: string;
  state: ChannelState;
  provider: string | null;
  /** One honest sentence for the person, never a raw provider payload. */
  detail: string;
  /** Messages this workspace received on it in the last 7 days, and the last time one arrived (what the inbox actually saw, not a promise). */
  inbound7d: number;
  lastInboundAt: string | null;
  /** Of the messages sent on it in the last 24 hours, how many failed or were held back by the provider. */
  sent24h: number;
  failed24h: number;
}

interface ChannelRow {
  channel: Channel;
  provider: string;
  enabled: boolean;
  sender_verified_at: Date | null;
  registration_status: string;
  detail: string | null;
  capability_tested_at: Date | null;
}

/** Fewer sends than this in a day is too little to call a pattern; a single failure is shown on the message, not on the channel. */
const MIN_SAMPLE = 3;

export function describeChannel(row: ChannelRow | undefined, stats: { sent24h: number; failed24h: number }, writesEnabled: boolean): { state: ChannelState; detail: string } {
  if (!row || !row.sender_verified_at) return { state: "not_connected", detail: "No sender has been verified for this channel yet, so nothing is sent or received through it." };
  if (!row.enabled) return { state: "paused", detail: "Set up and verified, but switched off. Messages are not sent until it is switched on." };
  if (!writesEnabled) return { state: "needs_attention", detail: "Sending is switched off in this environment. Messages are held and nothing reaches customers." };
  if (stats.sent24h >= MIN_SAMPLE && stats.failed24h * 2 > stats.sent24h) {
    return { state: "needs_attention", detail: `${stats.failed24h} of the last ${stats.sent24h} messages sent today failed. Check the provider connection.` };
  }
  return { state: "connected", detail: row.capability_tested_at ? "Verified and switched on." : "Switched on." };
}

export async function getChannelHealth(ctx: OrgContext): Promise<ChannelHealth[]> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  const { channels, inbound, outbound } = await withUser(ctx.user.id, async (db) => ({
    channels: (await db.query<ChannelRow>("select channel, provider, enabled, sender_verified_at, registration_status, detail, capability_tested_at from messaging_channels where org_id = $1", [ctx.org.orgId])).rows,
    inbound: (await db.query<{ channel: Channel; n: string; last: Date | null }>(
      `select c.channel, count(*)::text as n, max(m.created_at) as last from conversation_messages m join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
       where m.org_id = $1 and m.direction = 'inbound' and m.created_at > now() - interval '7 days' group by c.channel`,
      [ctx.org.orgId],
    )).rows,
    outbound: (await db.query<{ channel: Channel; sent: string; failed: string }>(
      `select c.channel, count(*) filter (where m.status in ('sent', 'delivered', 'read', 'failed'))::text as sent, count(*) filter (where m.status = 'failed')::text as failed
       from conversation_messages m join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
       where m.org_id = $1 and m.direction = 'outbound' and m.created_at > now() - interval '24 hours' group by c.channel`,
      [ctx.org.orgId],
    )).rows,
  }));

  const out: ChannelHealth[] = CHANNELS.map((channel) => {
    const row = channels.find((c) => c.channel === channel);
    const provider: TransportName = row && isTransportName(row.provider) ? row.provider : "ghl";
    const o = outbound.find((r) => r.channel === channel);
    const i = inbound.find((r) => r.channel === channel);
    const stats = { sent24h: Number(o?.sent ?? 0), failed24h: Number(o?.failed ?? 0) };
    const { state, detail } = describeChannel(row, stats, row ? transportWritesEnabled(provider) : true);
    return {
      key: channel,
      label: CHANNEL_LABELS[channel],
      state,
      provider: row ? TRANSPORT_LABELS[provider] : null,
      detail,
      inbound7d: Number(i?.n ?? 0),
      lastInboundAt: i?.last ? new Date(i.last).toISOString() : null,
      ...stats,
    };
  });

  // Not message channels of this inbox. Said plainly, so nobody waits for a message that cannot arrive.
  out.push({ key: "web_chat", label: "Website chat", state: "not_available", provider: null, detail: "Live chat on your website isn't available yet. Website forms do land here as enquiries.", inbound7d: 0, lastInboundAt: null, sent24h: 0, failed24h: 0 });
  out.push({ key: "phone", label: "Phone calls", state: "not_available", provider: null, detail: "Calls are listed on the customer's record. Replying by phone is not part of the inbox.", inbound7d: 0, lastInboundAt: null, sent24h: 0, failed24h: 0 });
  return out;
}
