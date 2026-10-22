import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { resolveLlmConfigDetailed } from "@/server/llm/client";
import { getBalance } from "@/server/billing/ledger";
import { inboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { sourceLabel } from "@/lib/attribution/model";
import { getWidgetByOrg } from "@/server/webchat/config";
import type { OrgContext } from "@/server/tenancy/context";

// What the website chat has done, counted from stored records, and whether it can work right now. Nothing here is estimated: a figure is a count of rows,
// a check says what it looked at, and a check that cannot be answered says so instead of guessing.

export interface ChatWindowStats {
  days: number;
  /** Chats that exist (a visitor wrote or sent their details). */
  chats: number;
  visitorMessages: number;
  assistantReplies: number;
  teamReplies: number;
  leads: number;
  qualified: number;
  handoffs: number;
  bookingsRequested: number;
  bySurface: { site: number; embed: number };
  topPages: Array<{ path: string; chats: number }>;
  topSources: Array<{ source: string; label: string; chats: number }>;
}

export interface ChatListItem {
  sessionId: string;
  conversationId: string | null;
  startedAt: string;
  lastSeenAt: string;
  host: string;
  surface: "site" | "embed";
  landingPath: string | null;
  messages: number;
  leadCaptured: boolean;
  qualified: boolean;
  handoffRequested: boolean;
  mode: "assistant" | "waiting" | "team";
  contactName: string | null;
}

export type HealthState = "ok" | "attention" | "off";
export interface HealthCheck {
  key: string;
  state: HealthState;
  label: string;
  detail: string;
  /** Where to fix it, when there is a place. */
  href?: string;
}

export interface ChatOverview {
  last7: ChatWindowStats;
  last30: ChatWindowStats;
  recent: ChatListItem[];
  health: HealthCheck[];
}

async function windowStats(db: Parameters<Parameters<typeof withUser>[1]>[0], orgId: string, days: number): Promise<ChatWindowStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const base = await db.query<{ chats: string; leads: string; qualified: string; handoffs: string; site: string; embed: string }>(
    `select count(*)::text as chats, count(*) filter (where lead_captured_at is not null)::text as leads, count(*) filter (where qualification_completed_at is not null)::text as qualified,
            count(*) filter (where handoff_requested_at is not null)::text as handoffs, count(*) filter (where surface = 'site')::text as site, count(*) filter (where surface = 'embed')::text as embed
     from web_chat_sessions where org_id = $1 and created_at >= $2 and (message_count > 0 or lead_captured_at is not null)`,
    [orgId, since],
  );
  const msgs = await db.query<{ visitor: string; ai: string; team: string }>(
    `select count(*) filter (where m.direction = 'inbound')::text as visitor,
            count(*) filter (where m.direction = 'outbound' and m.author_kind = 'ai' and m.status in ('sent', 'delivered', 'read'))::text as ai,
            count(*) filter (where m.direction = 'outbound' and m.author_kind = 'human' and m.status in ('sent', 'delivered', 'read'))::text as team
     from conversation_messages m join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
     where m.org_id = $1 and c.channel = 'web_chat' and m.created_at >= $2`,
    [orgId, since],
  );
  const bookings = await db.query<{ n: string }>(
    "select count(distinct b.id)::text as n from appointment_bookings b join conversations c on c.id = b.conversation_id and c.org_id = b.org_id where b.org_id = $1 and c.channel = 'web_chat' and b.created_at >= $2",
    [orgId, since],
  );
  const pages = await db.query<{ path: string; n: string }>(
    "select landing_path as path, count(*)::text as n from web_chat_sessions where org_id = $1 and created_at >= $2 and landing_path is not null and (message_count > 0 or lead_captured_at is not null) group by landing_path order by count(*) desc, landing_path limit 5",
    [orgId, since],
  );
  const sources = await db.query<{ source: string; n: string }>(
    "select source, count(*)::text as n from lead_touches where org_id = $1 and kind = 'website_chat' and occurred_at >= $2 group by source order by count(*) desc, source limit 5",
    [orgId, since],
  );
  const b = base.rows[0];
  return {
    days, chats: Number(b.chats), visitorMessages: Number(msgs.rows[0].visitor), assistantReplies: Number(msgs.rows[0].ai), teamReplies: Number(msgs.rows[0].team), leads: Number(b.leads), qualified: Number(b.qualified),
    handoffs: Number(b.handoffs), bookingsRequested: Number(bookings.rows[0].n), bySurface: { site: Number(b.site), embed: Number(b.embed) },
    topPages: pages.rows.map((r) => ({ path: r.path, chats: Number(r.n) })), topSources: sources.rows.map((r) => ({ source: r.source, label: sourceLabel(r.source), chats: Number(r.n) })),
  };
}

export async function chatOverview(ctx: OrgContext): Promise<ChatOverview> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  const orgId = ctx.org.orgId;
  // Counts and the list are read as the person (row-level security): someone who may not open the Inbox sees no chats.
  const data = await withUser(ctx.user.id, async (db) => {
    const [last7, last30] = [await windowStats(db, orgId, 7), await windowStats(db, orgId, 30)];
    const recent = await db.query<{
      id: string; conversation_id: string | null; created_at: Date; last_seen_at: Date; origin_host: string; surface: "site" | "embed"; landing_path: string | null; message_count: number;
      lead_captured_at: Date | null; qualification_completed_at: Date | null; handoff_requested_at: Date | null; owner_kind: string | null; waiting: boolean | null; display_name: string | null; ai_paused: boolean | null;
    }>(
      `select s.id, s.conversation_id, s.created_at, s.last_seen_at, s.origin_host, s.surface, s.landing_path, s.message_count, s.lead_captured_at, s.qualification_completed_at, s.handoff_requested_at,
              c.owner_kind, (c.ai_paused_at is not null) as ai_paused,
              exists (select 1 from human_escalations e where e.conversation_id = c.id and e.status in ('awaiting_owner', 'open')) as waiting, k.display_name
       from web_chat_sessions s left join conversations c on c.id = s.conversation_id and c.org_id = s.org_id left join contacts k on k.id = s.contact_id and k.org_id = s.org_id
       where s.org_id = $1 and (s.message_count > 0 or s.lead_captured_at is not null) order by s.last_seen_at desc limit 25`,
      [orgId],
    );
    return { last7, last30, recent: recent.rows };
  });
  const items: ChatListItem[] = data.recent.map((r) => ({
    sessionId: r.id, conversationId: r.conversation_id, startedAt: new Date(r.created_at).toISOString(), lastSeenAt: new Date(r.last_seen_at).toISOString(), host: r.origin_host, surface: r.surface,
    landingPath: r.landing_path, messages: r.message_count, leadCaptured: Boolean(r.lead_captured_at), qualified: Boolean(r.qualification_completed_at), handoffRequested: Boolean(r.handoff_requested_at),
    mode: r.owner_kind === "human" ? "team" : r.waiting || r.owner_kind === "unassigned" || r.ai_paused ? "waiting" : "assistant", contactName: r.display_name,
  }));
  return { last7: data.last7, last30: data.last30, recent: items, health: await chatHealth(ctx) };
}

/** Can the chat work right now, and if not, why not. Every line names what it looked at. */
export async function chatHealth(ctx: OrgContext): Promise<HealthCheck[]> {
  const orgId = ctx.org.orgId;
  const w = await withSystem((db) => getWidgetByOrg(db, orgId));
  const out: HealthCheck[] = [];
  if (!w) return [{ key: "widget", state: "off", label: "Website chat is not set up", detail: "Open this page as someone who can edit the website to set it up." }];
  out.push(w.enabled
    ? { key: "widget", state: "ok", label: "The chat is switched on", detail: "Visitors on an allowed website can open it." }
    : { key: "widget", state: "off", label: "The chat is switched off", detail: "Visitors do not see it. Switch it on when you are ready." });
  const siteHosts = await withSystem(async (db) => (await db.query<{ n: string }>("select count(*)::text as n from website_domains where org_id = $1 and removed_at is null", [orgId])).rows[0].n);
  const places = w.allowedOrigins.length + (w.autoInstallSites ? Number(siteHosts) : 0);
  out.push(places > 0
    ? { key: "sites", state: "ok", label: `${places} website address${places === 1 ? "" : "es"} may use the chat`, detail: w.autoInstallSites && Number(siteHosts) > 0 ? "Your Website Studio sites are included." : "Only the addresses you listed." }
    : { key: "sites", state: "attention", label: "No website can use the chat yet", detail: "Add the address of the website where you will install it, or turn on installation on your Website Studio site." });
  if (w.enabled) {
    const seen = w.lastSeenAt ? new Date(w.lastSeenAt) : null;
    out.push(seen
      ? { key: "seen", state: Date.now() - seen.getTime() < 7 * 86_400_000 ? "ok" : "attention", label: `Last loaded on ${w.lastSeenOrigin ?? "a website"}`, detail: `${seen.toISOString().slice(0, 10)}. This is the last time a visitor's page really loaded the chat.` }
      : { key: "seen", state: "attention", label: "Not seen on any website yet", detail: "Nobody's browser has loaded the chat from an allowed address. Check that the snippet is on the page and the address is listed." });
  }
  const agent = await withSystem((db) =>
    db.query<{ enabled: boolean; status: string; config: string | null }>("select enabled, status, active_config_version_id::text as config from agent_instances where org_id = $1 and role_key = $2", [orgId, w.aiRoleKey]),
  );
  const a = agent.rows[0];
  if (w.aiEnabled) {
    out.push(a?.enabled && a.config
      ? { key: "employee", state: "ok", label: "The AI employee that answers is set up", detail: "It owns each chat, so a person taking over or pausing it works the same as in your Inbox." }
      : { key: "employee", state: "attention", label: "The AI employee that answers is not ready", detail: "Chats will wait for a person until it is set up. Check its setup in AI Employees.", href: "/employees" });
    const llm = await resolveLlmConfigDetailed();
    out.push(llm.config
      ? { key: "model", state: "ok", label: "The AI language model is connected", detail: "The assistant can answer from the knowledge you chose." }
      : { key: "model", state: "attention", label: "The AI language model is not connected", detail: "Until it is, visitors are told a team member will follow up, and a person is asked to reply." });
    const bal = await withSystem((db) => getBalance(db, orgId));
    out.push(bal.availableMicros > 0
      ? { key: "credits", state: "ok", label: "Service credits are available", detail: "The assistant does not answer when credits run out; a person is asked to reply instead." }
      : { key: "credits", state: "attention", label: "No service credits left", detail: "The assistant is stopped until credits are added.", href: "/settings/billing" });
  } else {
    out.push({ key: "employee", state: "off", label: "The assistant is switched off", detail: "Chats go to your team." });
  }
  if (w.allowBooking && w.aiEnabled) {
    const cal = await withSystem((db) => db.query<{ n: string }>("select (select count(*) from ghl_location_mappings where org_id = $1 and status <> 'disabled') + (select count(*) from crm_calendars where org_id = $1) as n", [orgId]));
    out.push(Number(cal.rows[0].n) > 0
      ? { key: "calendar", state: "ok", label: "A calendar is connected for booking", detail: "The assistant offers only times your calendar says are free." }
      : { key: "calendar", state: "attention", label: "No calendar is connected", detail: "The assistant cannot offer times; it will say a team member will confirm one.", href: "/crm/calendars" });
  }
  const rollout = await withSystem((db) => inboxEnabledFor(orgId, db));
  out.push({ key: "inbox", state: "ok", label: rollout ? "Chats appear in your Unified Inbox" : "Chats appear in your Inbox", detail: "Each chat is a conversation you can open, take over or hand back." });
  return out;
}
