import "server-only";
import type { Queryable } from "@/server/db";
import type { ConnectionFacts } from "@/lib/onboarding/engine";
import { installState } from "@/lib/webchat/rules";

/**
 * What the workspace is really connected to, read from its own rows, for the review at the end of the questionnaire. Nothing is inferred: a connection is reported only
 * when a row says so. Trusted code: the caller has authorized the person for `orgId`, and every query names it.
 *
 * On iAcquire CRM nothing is "linked": the CRM is set up once an industry Blueprint is applied, and a calendar counts once someone has a connected calendar or there is an
 * active iAcquire calendar with a host (a draft calendar made from the onboarding answers does not count: it takes no bookings). GoHighLevel (and hybrid) workspaces keep the
 * location facts. The optional facts (website address, website chat, social media) never decide whether anything can be approved.
 */
export async function connectionFacts(db: Queryable, orgId: string): Promise<ConnectionFacts> {
  const one = async (sql: string) => (await db.query<{ n: string }>(sql, [orgId])).rows[0]?.n ?? "0";
  const crm = Number(await one("select count(*) as n from ghl_location_mappings where org_id = $1 and status = 'connected' and verified_at is not null"));
  const online = Number(await one("select count(*) as n from agent_instances where org_id = $1 and enabled and status in ('online', 'busy')"));
  const total = Number(await one("select count(*) as n from agent_instances where org_id = $1 and enabled"));
  const mapped = Number(await one("select count(*) as n from automation_template_mappings where org_id = $1 and status = 'verified'"));
  const calendars = Number(await one("select coalesce(sum(cardinality(calendar_ids)), 0) as n from ghl_location_mappings where org_id = $1 and status = 'connected'"));
  const staff = Number(await one(
    `select (select count(*) from organization_memberships where org_id = $1 and status = 'active' and role <> 'owner')
          + (select count(*) from invitations where org_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()) as n`,
  ));
  const { rows: channels } = await db.query<{ channel: "sms" | "whatsapp" | "email"; enabled: boolean; registration_status: string }>(
    "select channel, enabled, registration_status from messaging_channels where org_id = $1",
    [orgId],
  );
  const channelMap: ConnectionFacts["channels"] = {
    sms: { enabled: false, registration: "not_started" },
    whatsapp: { enabled: false, registration: "not_started" },
    email: { enabled: false, registration: "not_started" },
  };
  for (const c of channels) channelMap[c.channel] = { enabled: c.enabled, registration: c.registration_status };

  // A website address counts once Website Studio has proved it is the workspace's own (verified) or is serving it (active).
  const websiteDomainVerified = Number(await one("select count(*) as n from website_domains where org_id = $1 and removed_at is null and status in ('verified', 'active')")) > 0;
  // Website chat: evidence only (the widget has loaded from an allowed website), as the chat settings screen reports it.
  const widget = (await db.query<{ enabled: boolean; allowed: number; auto_install_sites: boolean; last_seen_at: Date | null }>(
    "select enabled, cardinality(allowed_origins) as allowed, auto_install_sites, last_seen_at from web_chat_widgets where org_id = $1",
    [orgId],
  )).rows[0];
  const siteHosts = widget?.auto_install_sites ? Number(await one("select count(*) as n from website_domains where org_id = $1 and removed_at is null")) : 0;
  const chatWidget = installState({ enabled: widget?.enabled === true, allowedHostCount: widget?.allowed ?? 0, autoInstalledSites: siteHosts, lastSeenAt: widget?.last_seen_at ? new Date(widget.last_seen_at) : null });
  // Social media: a real connection only. A stand-in account (refused in production) and one that needs signing in again are not connected.
  const socialConnected = Number(await one("select count(*) as n from social_accounts where org_id = $1 and adapter = 'meta' and status = 'connected'")) > 0;

  const optional = { websiteDomainVerified, chatWidget, socialConnected };
  const mode = ((await db.query<{ mode: "native" | "ghl" | "hybrid" }>("select mode from crm_workspaces where org_id = $1", [orgId])).rows[0]?.mode ?? "native");
  if (mode === "native") {
    const blueprint = Number(await one("select count(*) as n from crm_blueprint_applications where org_id = $1 and status in ('applied', 'partially_applied')"));
    const calendar = Number(await one(
      `select (select count(*) from crm_calendar_connections where org_id = $1 and status = 'connected')
            + (select count(*) from crm_calendars c where c.org_id = $1 and c.status = 'active' and c.archived_at is null
                 and exists (select 1 from crm_calendar_members m where m.calendar_id = c.id and m.org_id = c.org_id and m.active)) as n`,
    ));
    return { crmMode: mode, crmLinked: blueprint > 0, aiEmployeesVerified: online, aiEmployeesTotal: total, automationMapped: mapped > 0, channels: channelMap, calendarConnected: calendar > 0, invitedStaff: staff, ...optional };
  }
  return { crmMode: mode, crmLinked: crm > 0, aiEmployeesVerified: online, aiEmployeesTotal: total, automationMapped: mapped > 0, channels: channelMap, calendarConnected: calendars > 0, invitedStaff: staff, ...optional };
}
