// CRM reports (client and agency), saved report definitions, the CSV export, and the native-aware dashboard and analytics. Synthetic
// workspaces only: every number asserted here comes from rows these tests insert, and nothing contacts a provider.
import crypto from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ actor: null as null | import("@/server/crm/actor").CrmActor }));
// The actions and the export route resolve their actor from the session; here the test chooses who is acting, and the permission check runs.
vi.mock("@/server/crm/request", async () => {
  const { assertCan } = await import("@/server/crm/actor");
  return {
    resolveCrmActor: async (_orgId: string | null, permission: import("@/lib/permissions").Permission) => {
      if (!who.actor) throw new Error("No actor chosen for this test.");
      assertCan(who.actor, permission);
      return who.actor;
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The screens are rendered to HTML below without a running app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/crm/reports",
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));

import { withSystem, withUser } from "@/server/db";
import { agencyActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import { createContact } from "@/server/crm/contacts";
import { closeOpportunity, createOpportunity } from "@/server/crm/opportunities";
import { createPipeline } from "@/server/crm/pipelines";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { getCrmReport, getReportOptions } from "@/server/crm/reports/service";
import { archiveSavedReport, createSavedReport, getSavedReport, listSavedReports, setSavedReportPinned, updateSavedReport } from "@/server/crm/reports/definitions";
import { REPORT_EXPORT_LIMIT, exportCrmReport, reportToCsv } from "@/server/crm/reports/export";
import { resolveReportRequest } from "@/server/crm/reports/params";
import { agencyCrmOperations } from "@/server/crm/reports/agency";
import { archiveReportAction, pinReportAction, saveReportAction, updateReportAction } from "@/app/actions/crm-reports";
import { GET as exportRoute } from "@/app/api/crm/reports/export/route";
import { getDashboard, nativeCrmOwners, sourceAvailability } from "@/server/queries/dashboard";
import { getAnalytics } from "@/server/queries/analytics";
import { crmDeliveryHealth, getSystemHealth } from "@/server/admin/health";
import {
  REPORT_SECTIONS, addDays, customRangeIssue, ignoredFilters, parseReportParams, reportSearch, resolveDates, todayIn, visibleSections, type ReportFilters,
} from "@/components/crm/reports/spec";
import { fillDays, moneyText, periodText } from "@/components/crm/reports/format";
import type { CrmReport, SectionPayloads } from "@/components/crm/reports/types";
import { CRM_NAV, navFor } from "@/lib/crm/nav";
import { PERMISSION_MATRIX, type Permission } from "@/lib/permissions";
import { ReportsWorkspace } from "@/components/crm/reports/reports-workspace";
import { AgencyOpsReport } from "@/components/crm/agency-reports/agency-ops-report";
import { CrmDeliveryHealthSection } from "@/components/crm/agency-reports/crm-delivery-health";
import type { CrmScope } from "@/server/crm/page";
import { TooltipProvider } from "@/components/ui/overlays";

/** Renders a screen as the app does, inside the tooltip provider the portal layout supplies. */
const html = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(TooltipProvider, null, el));
import { adminCrumbs } from "@/lib/admin-breadcrumb";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { createUser, ctxFor } from "./support/fixtures";

const TZ = "Asia/Manila";
const TODAY = todayIn(TZ);
// A finished period in the recent past, so every seeded event is history whatever the clock says.
const FROM = addDays(TODAY, -20);
const TO = addDays(TODAY, -6);
const RANGE: ReportFilters = { range: "custom", from: FROM, to: TO };
const day = (n: number) => addDays(FROM, n);
/** A wall-clock time in Manila (UTC+8, no daylight saving). */
const mnl = (d: string, hms = "12:00:00") => new Date(`${d}T${hms}+08:00`);
const hex = (n: number) => crypto.randomBytes(n).toString("hex");

const section = <S extends keyof SectionPayloads>(r: CrmReport, s: S) => {
  const found = r.sections.find((x) => x.section === s);
  if (!found) throw new Error(`section ${s} missing`);
  return found as { section: S; data: SectionPayloads[S]; empty: boolean; ignored: string[]; notes: string[] };
};
const run = (actor: CrmActor, filters: ReportFilters = RANGE, sections: Array<keyof SectionPayloads> | null = null) => getCrmReport(actor, { filters, sections });

let a: CrmOrg;
let b: CrmOrg;
let ids: {
  contacts: Record<string, string>;
  calendarId: string;
  typeId: string;
  secondPipelineId: string;
  conversationId: string;
};

async function contact(c: CrmOrg, name: string, over: { createdAt: Date; via?: string; source?: string | null; status?: string; owner?: string | null }) {
  const r = await createContact(c.actor("owner"), { firstName: name, lastName: "Person", email: `${name.toLowerCase()}-${hex(3)}@example.test` });
  await withSystem((db) =>
    db.query("update contacts set created_at = $2, created_via = $3, source = coalesce($4, source), lead_status = $5, assigned_user_id = $6 where id = $1", [
      r.id, over.createdAt, over.via ?? "manual", over.source ?? null, over.status ?? "new", over.owner ?? null,
    ]),
  );
  return r.id;
}

async function seedA() {
  const c = a;
  const sales = c.people.sales.id;
  const owner = c.people.owner.id;
  const contacts: Record<string, string> = {};
  // Leads, with both edges of the period in Manila time.
  contacts.beforeStart = await contact(c, "Before", { createdAt: mnl(addDays(FROM, -1), "23:59:59") });
  contacts.atStart = await contact(c, "Start", { createdAt: mnl(FROM, "00:00:00"), via: "booking" });
  contacts.qualified = await contact(c, "Qualified", { createdAt: mnl(day(3), "09:00:00"), via: "website_form", source: "Google Ads", status: "qualified", owner: sales });
  contacts.atEnd = await contact(c, "End", { createdAt: mnl(TO, "23:59:59"), via: "website_form", source: "Google Ads", status: "customer" });
  contacts.afterEnd = await contact(c, "After", { createdAt: mnl(addDays(TO, 1), "00:00:00") });
  contacts.deleted = await contact(c, "Deleted", { createdAt: mnl(day(2)) });
  await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [contacts.deleted]));

  // Native form submissions (one form), with UTM where it was really present.
  await withSystem(async (db) => {
    const f = await db.query<{ id: string }>("insert into crm_forms (org_id, key, name, status) values ($1, 'quote', 'Quote request', 'draft') returning id", [c.org.id]);
    const v = await db.query<{ id: string }>("insert into crm_form_versions (org_id, form_id, version, fields, content_hash) values ($1, $2, 1, '[]'::jsonb, $3) returning id", [c.org.id, f.rows[0].id, hex(32)]);
    const sub = (status: string, at: Date, attribution: Record<string, unknown>, contactId: string | null) =>
      db.query(
        "insert into crm_form_submissions (org_id, form_id, version_id, source, answers, attribution, dedupe_key, status, contact_id, created_at) values ($1, $2, $3, 'hosted', '{}'::jsonb, $4::jsonb, $5, $6, $7, $8)",
        [c.org.id, f.rows[0].id, v.rows[0].id, JSON.stringify(attribution), `dedupe-${hex(6)}`, status, contactId, at],
      );
    await sub("processed", mnl(day(3)), { utm_source: "google", utm_medium: "cpc", utm_campaign: "spring" }, contacts.qualified);
    await sub("processed", mnl(day(4)), {}, contacts.atEnd);
    await sub("spam", mnl(day(4)), { utm_source: "spam-source" }, null);
    await sub("failed", mnl(day(5)), {}, null);
    await sub("processed", mnl(addDays(TO, 2)), {}, null); // after the period
  });

  // Appointments on iAcquire's calendar, one GoHighLevel copy, one invalid row.
  await setHostAvailability(c.actor("owner"), owner, { timezone: TZ, rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })) });
  const cal = await createCalendar(c.actor("owner"), { name: "Consults", public: true, members: [{ userId: owner }] });
  const type = await createAppointmentType(c.actor("owner"), cal.id, { name: "Site visit", durationMinutes: 60 });
  await withSystem(async (db) => {
    const appt = (status: string, start: Date, over: { via?: string; created?: Date; late?: boolean; host?: string | null; provider?: string } = {}) =>
      over.provider === "ghl"
        ? db.query<{ id: string }>(
            "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, created_at) values ($1, $2, 'cal_x', 'GHL', $3, $4, $5, $6) returning id",
            [c.org.id, `ghl_${hex(4)}`, status, start, new Date(start.getTime() + 3_600_000), over.created ?? start],
          )
        : db.query<{ id: string }>(
            `insert into appointment_refs (org_id, provider, calendar_ref, appointment_type_id, title, status, start_at, end_at, created_at, booked_via, late_cancellation, assigned_user_id)
             values ($1, 'native', $2, $3, 'Visit', $4, $5, $6, $7, $8, $9, $10) returning id`,
            [c.org.id, cal.id, type.id, status, start, new Date(start.getTime() + 3_600_000), over.created ?? mnl(day(1)), over.via ?? "booking_page", over.late ?? false, over.host === undefined ? owner : over.host],
          );
    await appt("showed", mnl(day(5), "10:00:00"));
    const noshow = await appt("noshow", mnl(day(6), "10:00:00"), { via: "staff" });
    await db.query("insert into crm_appointment_hosts (org_id, appointment_id, user_id) values ($1, $2, $3)", [c.org.id, noshow.rows[0].id, sales]);
    await appt("cancelled", mnl(day(7), "10:00:00"), { late: true });
    await appt("confirmed", mnl(day(8), "10:00:00"));
    await appt("confirmed", mnl(addDays(TODAY, 30), "10:00:00"), { created: mnl(day(9)), via: "website" }); // booked in the period, takes place later
    await appt("invalid", mnl(day(8), "11:00:00"));
    await appt("confirmed", mnl(day(8), "12:00:00"), { provider: "ghl" });
  });

  // Deals: one won in dollars, one won in pesos, one lost, one open, an archived one, a GoHighLevel copy, and one in a second pipeline.
  const usd = await createOpportunity(c.actor("owner"), { name: "Dollar deal", value: 1000, currency: "USD", contactId: contacts.qualified, ownerId: sales });
  const php = await createOpportunity(c.actor("owner"), { name: "Peso deal", value: 50000, currency: "PHP" });
  const lost = await createOpportunity(c.actor("owner"), { name: "Lost deal", value: 300, currency: "USD" });
  const open = await createOpportunity(c.actor("owner"), { name: "Open deal", value: 700, currency: "USD" });
  const archived = await createOpportunity(c.actor("owner"), { name: "Archived deal", value: 999, currency: "USD" });
  await closeOpportunity(c.actor("owner"), usd.id, "won");
  await closeOpportunity(c.actor("owner"), php.id, "won");
  await closeOpportunity(c.actor("owner"), lost.id, "lost", { lostReason: "=Price too high" });
  await closeOpportunity(c.actor("owner"), archived.id, "won");
  const second = await createPipeline(c.actor("owner"), { name: "Renovations", stages: [{ name: "Inquiry" }, { name: "Signed", kind: "won" }, { name: "Gone", kind: "lost" }] });
  const reno = await createOpportunity(c.actor("owner"), { name: "Reno deal", value: 2500, currency: "USD", pipelineId: second.id });
  await withSystem(async (db) => {
    for (const id of [usd.id, php.id, lost.id, open.id, archived.id, reno.id]) await db.query("update crm_opportunities set created_at = $2 where id = $1", [id, mnl(day(2))]);
    for (const id of [usd.id, php.id, lost.id, archived.id]) await db.query("update crm_opportunities set closed_at = $2 where id = $1", [id, mnl(day(10))]);
    await db.query("update crm_opportunities set archived_at = now() where id = $1", [archived.id]);
    await db.query("insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, monetary_value, provider, synced_at) values ($1, $2, 'GHL copy', 'won', 9999, 'ghl', $3)", [c.org.id, `ghl_${hex(4)}`, mnl(day(10))]);
  });

  // Messaging: one SMS conversation owned by the sales rep.
  const conversationId = await withSystem(async (db) => {
    const cv = await db.query<{ id: string }>(
      "insert into conversations (org_id, contact_id, channel, owner_kind, owner_user_id) values ($1, $2, 'sms', 'human', $3) returning id",
      [c.org.id, contacts.qualified, sales],
    );
    const id = cv.rows[0].id;
    const msg = (direction: string, status: string, at: Date, over: { provider?: string; blocked?: string; author?: string; step?: string } = {}) =>
      db.query<{ id: string }>(
        `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, provider, blocked_reason, created_at, sent_at, followup_step_id)
         values ($1, $2, $3, $4, 'Synthetic message body', $5, $6, $7, $8, $9, $10) returning id`,
        [c.org.id, id, direction, over.author ?? (direction === "inbound" ? "contact" : direction === "internal" ? "human" : "ai"), status, over.provider ?? null, over.blocked ?? null, at,
          ["sent", "delivered", "read"].includes(status) ? at : null, over.step ?? null],
      );
    await msg("inbound", "received", mnl(day(3)));
    await msg("inbound", "received", mnl(day(4)));
    await msg("outbound", "sent", mnl(day(4)), { provider: "twilio" });
    await msg("outbound", "delivered", mnl(day(4)), { provider: "twilio" });
    const failed = await msg("outbound", "failed", mnl(day(5)), { provider: "twilio" });
    await msg("outbound", "blocked", mnl(day(5)), { blocked: "no_consent" });
    await msg("internal", "note", mnl(day(5)));
    await msg("inbound", "received", mnl(addDays(TO, 1), "08:30:00")); // after the period
    await db.query("insert into message_delivery_events (org_id, message_id, provider, provider_event_id, status, occurred_at) values ($1, $2, 'twilio', $3, 'failed', $4)", [c.org.id, failed.rows[0].id, `ev_${hex(6)}`, mnl(day(5))]);

    // Follow-ups: one stopped by a reply, one completed, one still running.
    const plan = (status: string, created: Date, closed: Date | null, reason: string | null, contactId: string) =>
      db.query<{ id: string }>(
        "insert into follow_up_plans (org_id, contact_id, conversation_id, preset, status, cancel_reason, max_attempts, created_at, closed_at) values ($1, $2, $3, 'balanced', $4, $5, 3, $6, $7) returning id",
        [c.org.id, contactId, id, status, reason, created, closed],
      );
    const replied = await plan("cancelled", mnl(day(1)), mnl(day(4)), "customer_replied", contacts.qualified);
    await plan("completed", mnl(day(2)), mnl(day(9)), null, contacts.qualified);
    await plan("active", mnl(day(3)), null, null, contacts.qualified);
    const step = await db.query<{ id: string }>(
      "insert into follow_up_steps (org_id, plan_id, contact_id, step_number, channel, due_at, status) values ($1, $2, $3, 1, 'sms', $4, 'sent') returning id",
      [c.org.id, replied.rows[0].id, contacts.qualified, mnl(day(2))],
    );
    await msg("outbound", "sent", mnl(day(2)), { provider: "twilio", step: step.rows[0].id });

    // Tasks: the sales rep has two open (one overdue) and finished one in the period; one open task has nobody assigned.
    const task = (title: string, status: string, assignee: string | null, due: Date | null, completed: Date | null) =>
      db.query("insert into tasks (org_id, title, category, status, assigned_user_id, due_at, completed_at) values ($1, $2, 'crm', $3, $4, $5, $6)", [c.org.id, title, status, assignee, due, completed]);
    await task("Call back", "open", sales, new Date(Date.now() - 86_400_000), null);
    await task("Send quote", "open", sales, new Date(Date.now() + 5 * 86_400_000), null);
    await task("Done thing", "done", sales, null, mnl(day(6)));
    await task("Done long ago", "done", sales, null, mnl(addDays(FROM, -30)));
    await task("Nobody's", "open", null, null, null);

    // AI employee tool calls (audit log) and approvals.
    const agent = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 order by role_key limit 1", [c.org.id]);
    for (const [tool, outcome] of [["create_task", "done"], ["create_task", "done"], ["send_message", "pending_approval"]]) {
      await db.query(
        "insert into audit_logs (org_id, actor_kind, agent_instance_id, action, result, metadata, created_at) values ($1, 'agent', $2, $3, 'success', $4::jsonb, $5)",
        [c.org.id, agent.rows[0].id, `crm.agent_tool.${tool}`, JSON.stringify({ tool, outcome }), mnl(day(4))],
      );
    }
    await db.query("insert into approval_requests (org_id, kind, title, status, execution_status, created_at) values ($1, 'crm_update', 'Change a deal', 'approved', 'succeeded', $2)", [c.org.id, mnl(day(4))]);
    await db.query("insert into approval_requests (org_id, kind, title, status, created_at) values ($1, 'outreach', 'Send a message', 'pending', $2)", [c.org.id, mnl(day(5))]);

    // Workflow runs: completed, failed, gave up, and a test run.
    const wf = await db.query<{ id: string }>("insert into crm_workflows (org_id, key, name) values ($1, 'welcome', 'Welcome') returning id", [c.org.id]);
    const ver = await db.query<{ id: string }>(
      "insert into crm_workflow_versions (org_id, workflow_id, version, trigger_config, steps, content_hash) values ($1, $2, 1, '{}'::jsonb, '[]'::jsonb, $3) returning id",
      [c.org.id, wf.rows[0].id, hex(32)],
    );
    for (const [status, via] of [["completed", "event"], ["failed", "event"], ["dead", "event"], ["completed", "test"]]) {
      await db.query("insert into crm_workflow_runs (org_id, workflow_id, version_id, started_via, status, created_at) values ($1, $2, $3, $4, $5, $6)", [c.org.id, wf.rows[0].id, ver.rows[0].id, via, status, mnl(day(6))]);
    }

    // Integration health: a native SMS channel whose capability test failed, an erroring connection check, a webhook that gave up.
    await db.query(
      `insert into messaging_channels (org_id, channel, provider, enabled, sender_identity, registration_status, capability_test, capability_tested_at)
       values ($1, 'sms', 'twilio', false, '+15550001234', 'approved', '{"ok": false}'::jsonb, now())`,
      [c.org.id],
    );
    await db.query("insert into integration_status (org_id, provider, status, detail, last_checked_at) values ($1, 'email', 'error', 'Synthetic failure', now())", [c.org.id]);
    const hook = await db.query<{ id: string }>(
      "insert into crm_webhook_subscriptions (org_id, name, url, event_types, secret_ciphertext, secret_hint) values ($1, 'Zapier', 'https://example.test/hook', array['contact.created'], 'cipher', 'abcd') returning id",
      [c.org.id],
    );
    const ev = await db.query<{ id: string }>(
      "insert into crm_events (org_id, type, entity_type, dedupe_key, actor_kind, dispatched_at, dispatch_attempts, dispatch_error) values ($1, 'contact.created', 'contact', $2, 'system', now(), 5, 'Gave up after 5 attempts: synthetic') returning id",
      [c.org.id, `dead-${hex(4)}`],
    );
    await db.query("insert into crm_webhook_deliveries (org_id, subscription_id, event_id, status, attempts) values ($1, $2, $3, 'dead', 8)", [c.org.id, hook.rows[0].id, ev.rows[0].id]);
    // An event still waiting for the dispatcher, for an hour.
    await db.query("insert into crm_events (org_id, type, entity_type, dedupe_key, actor_kind, occurred_at) values ($1, 'contact.updated', 'contact', $2, 'system', now() - interval '1 hour')", [c.org.id, `pending-${hex(4)}`]);

    // Metered usage from the billing ledger.
    const rate = await db.query<{ id: string }>("select id from usage_rate_versions order by version limit 1");
    const usage = (unit: string, qty: number, client: number, charged: number, at: Date) =>
      db.query(
        `insert into metered_usage_events (org_id, provider, unit_type, quantity, wholesale_micros, rate_version_id, markup_bps, client_micros, charged_micros, uncollected_micros, occurred_at, provider_reference)
         values ($1, 'twilio', $2, $3, $4, $5, 13000, $6, $7, $8, $9, $10)`,
        [c.org.id, unit, qty, Math.round(client / 1.3), rate.rows[0].id, client, charged, client - charged, at, `ref-${hex(6)}`],
      );
    await usage("sms_segment", 2, 1_300_000, 1_300_000, mnl(day(4)));
    await usage("sms_segment", 1, 650_000, 150_000, mnl(day(5)));
    await usage("email_send", 3, 3_900, 3_900, mnl(addDays(TO, 3)));
    return id;
  });

  ids = { contacts, calendarId: cal.id, typeId: type.id, secondPipelineId: second.id, conversationId };
}

beforeAll(async () => {
  a = await crmOrg({ name: "Reports A", timezone: TZ });
  b = await crmOrg({ name: "Reports B", timezone: TZ });
  await seedA();
  // Another workspace with its own records, which must never appear in A's numbers.
  await contact(b, "Other", { createdAt: mnl(day(3)), via: "website_form" });
  const deal = await createOpportunity(b.actor("owner"), { name: "Other deal", value: 5, currency: "USD" });
  await closeOpportunity(b.actor("owner"), deal.id, "won");
  await withSystem((db) => db.query("update crm_opportunities set closed_at = $2 where id = $1", [deal.id, mnl(day(10))]));
}, 120_000);

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("report periods and the address bar", () => {
  it("counts days in the workspace's zone and resolves every preset", () => {
    const now = new Date("2026-10-16T16:30:00Z");
    expect(todayIn("Asia/Manila", now)).toBe("2026-10-17");
    expect(todayIn("UTC", now)).toBe("2026-10-16");
    expect(todayIn("Not/AZone", now)).toBe("2026-10-16");
    expect(resolveDates({ range: "7d" }, "2026-10-17")).toMatchObject({ from: "2026-10-11", to: "2026-10-17", days: 7 });
    expect(resolveDates({ range: "30d" }, "2026-10-17")).toMatchObject({ from: "2026-09-18", days: 30 });
    expect(resolveDates({ range: "mtd" }, "2026-10-17")).toMatchObject({ from: "2026-10-01", to: "2026-10-17" });
    expect(resolveDates({ range: "last_month" }, "2026-01-15")).toMatchObject({ from: "2025-12-01", to: "2025-12-31", days: 31 });
    expect(resolveDates({ range: "last_month" }, "2024-03-31")).toMatchObject({ from: "2024-02-01", to: "2024-02-29", days: 29 });
    expect(resolveDates({ range: "qtd" }, "2026-11-02")).toMatchObject({ from: "2026-10-01" });
    expect(resolveDates({ range: "ytd" }, "2026-10-17")).toMatchObject({ from: "2026-01-01" });
    expect(customRangeIssue("2026-10-05", "2026-10-01", "2026-10-17")).toMatch(/on or before/);
    expect(customRangeIssue("2026-10-01", "2026-10-18", "2026-10-17")).toMatch(/future/);
    expect(customRangeIssue("2024-01-01", "2026-01-01", "2026-10-17")).toMatch(/at most 366/);
    expect(customRangeIssue("2026-02-30", "2026-03-01", "2026-10-17")).toMatch(/start and an end/);
    expect(() => resolveDates({ range: "custom", from: "2026-10-05", to: "2026-10-01" }, "2026-10-17")).toThrow(RangeError);
  });

  it("drops what it can't use with a notice, and writes back what it read", () => {
    const p = parseReportParams({ range: "custom", from: "2026-10-01", to: "2027-01-01", member: "not-a-uuid", source: "carrier_pigeon", channel: "fax", sections: "usage,leads,nope" }, "2026-10-17");
    expect(p.filters).toEqual({ range: "30d" });
    expect(p.sections).toEqual(["leads", "usage"]);
    expect(p.notice).toMatch(/future/);
    expect(p.notice).toMatch(/team member filter/);
    expect(p.notice).toMatch(/lead source/);
    expect(p.notice).toMatch(/channel/);
    const f: ReportFilters = { range: "custom", from: "2026-10-01", to: "2026-10-10", member: crypto.randomUUID(), source: "website_form", channel: "sms" };
    const back = parseReportParams(Object.fromEntries(new URLSearchParams(reportSearch(f, { sections: ["deals"], savedId: null }))), "2026-10-17");
    expect(back.filters).toEqual(f);
    expect(back.sections).toEqual(["deals"]);
    expect(reportSearch({ range: "30d" })).toBe("");
    expect(ignoredFilters("ai", { range: "30d", member: crypto.randomUUID() })).toEqual(["member"]);
    expect(ignoredFilters("deals", { range: "30d", member: crypto.randomUUID(), pipeline: crypto.randomUUID() })).toEqual([]);
  });

  it("formats days, periods and money without mixing currencies", () => {
    expect(fillDays([{ day: "2026-10-02", n: 3 }], "2026-10-01", "2026-10-03", (r) => r.n)).toEqual([{ x: "2026-10-01", y: 0 }, { x: "2026-10-02", y: 3 }, { x: "2026-10-03", y: 0 }]);
    expect(periodText("2026-10-01", "2026-10-15")).toBe("Oct 1 – Oct 15, 2026");
    expect(moneyText([{ currency: "PHP", value: 50000 }, { currency: "USD", value: 1000 }])).toBe("₱50,000 · $1,000");
    expect(moneyText([])).toBeNull();
  });

  it("lists Reports in the CRM navigation for people who can see reports, in the client portal and the agency view", () => {
    const item = CRM_NAV.find((s) => s.key === "crm")!.items.find((i) => i.path === "/reports");
    expect(item).toMatchObject({ permission: "analytics.view", icon: "bar-chart-3" });
    expect(navFor((p) => p === "crm.view", "client").flatMap((s) => s.items).some((i) => i.path === "/reports")).toBe(false);
    expect(navFor((p) => p === "crm.view" || p === "analytics.view", "agency").flatMap((s) => s.items).some((i) => i.path === "/reports")).toBe(true);
    expect(adminCrumbs("/admin/crm/reports")).toEqual([{ label: "Client CRMs", href: "/admin/crm" }, { label: "CRM operations" }]);
  });
});

// ---------------------------------------------------------------------------
// Sections, each against the rows seeded above
// ---------------------------------------------------------------------------

describe("client report sections", () => {
  it("counts leads in the workspace's own days, both ends included, by how they arrived, source and status", async () => {
    const r = await run(a.actor("owner"), RANGE, ["leads"]);
    expect(r.timezone).toBe(TZ);
    expect(r.period).toMatchObject({ from: FROM, to: TO, dated: true });
    // Midnight Manila is 16:00 UTC the day before.
    expect(r.period.startsAt).toBe(new Date(`${addDays(FROM, -1)}T16:00:00.000Z`).toISOString());
    const s = section(r, "leads");
    expect(s.data.newContacts).toBe(3);
    expect(s.data.qualifiedNow).toBe(2);
    expect(s.data.byDay.map((d) => d.day)).toEqual([FROM, day(3), TO]);
    expect(s.data.byCreatedVia).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "website_form", count: 2, qualified: 2, label: "Website form" }),
      expect.objectContaining({ key: "booking", count: 1, qualified: 0 }),
    ]));
    expect(s.data.bySource.find((x) => x.label === "Google Ads")?.count).toBe(2);
    expect(s.data.byStatus.map((x) => [x.key, x.count])).toEqual([["new", 1], ["qualified", 1], ["customer", 1]]);
    // Forms: four submissions in the period; UTM only where it was present, spam left out.
    expect(s.data.forms.total).toBe(4);
    expect(s.data.forms.rows[0]).toMatchObject({ name: "Quote request", kind: "native", total: 4, processed: 2, spam: 1, failed: 1, pending: 0, contacts: 2 });
    expect(s.data.forms.utm).toEqual(expect.arrayContaining([{ source: "google", medium: "cpc", campaign: "spring", count: 1 }, { source: "", medium: "", campaign: "", count: 2 }]));
    expect(s.data.forms.utm.some((u) => u.source === "spam-source")).toBe(false);
    expect(s.empty).toBe(false);
  });

  it("follows daylight saving: a spring-forward day in New York is 23 hours long, and its last minutes still count", async () => {
    const ny = await crmOrg({ timezone: "America/New_York" });
    await contact(ny, "Late", { createdAt: new Date("2026-03-09T03:30:00Z") }); // 23:30 EDT on March 8
    await contact(ny, "Next", { createdAt: new Date("2026-03-09T04:30:00Z") }); // 00:30 EDT on March 9
    await contact(ny, "Early", { createdAt: new Date("2026-03-08T04:59:59Z") }); // 23:59:59 EST on March 7
    const r = await run(ny.actor("owner"), { range: "custom", from: "2026-03-08", to: "2026-03-08" }, ["leads"]);
    expect(r.period.startsAt).toBe("2026-03-08T05:00:00.000Z");
    expect(r.period.endsAt).toBe("2026-03-09T04:00:00.000Z");
    const s = section(r, "leads");
    expect(s.data.newContacts).toBe(1);
    expect(s.data.byDay).toEqual([{ day: "2026-03-08", n: 1 }]);
  });

  it("applies the team member and lead source filters to contacts, and says form submissions aren't narrowed by them", async () => {
    const byMember = section(await run(a.actor("owner"), { ...RANGE, member: a.people.sales.id }, ["leads"]), "leads");
    expect(byMember.data.newContacts).toBe(1);
    expect(byMember.data.forms.unfiltered).toEqual(["member"]);
    const bySource = section(await run(a.actor("owner"), { ...RANGE, source: "booking" }, ["leads"]), "leads");
    expect(bySource.data.newContacts).toBe(1);
    expect(bySource.data.byCreatedVia.map((x) => x.key)).toEqual(["booking"]);
  });

  it("reports native appointments by outcome, type, calendar, host and booking path, leaving GoHighLevel copies and invalid rows out", async () => {
    const s = section(await run(a.actor("owner"), RANGE, ["appointments"]), "appointments");
    expect(s.data).toMatchObject({ scheduled: 4, completed: 1, noShows: 1, cancelled: 1, lateCancellations: 1, upcoming: 0, unmarked: 1, showRate: 50 });
    // Created in the period: the four above, the invalid row is never counted, and the one that takes place next month.
    expect(s.data.booked).toBe(5);
    expect(s.data.bookedVia).toEqual(expect.arrayContaining([expect.objectContaining({ key: "website", count: 1, label: "Website" }), expect.objectContaining({ key: "staff", count: 1 })]));
    expect(s.data.byType).toEqual([expect.objectContaining({ label: "Site visit", scheduled: 4 })]);
    expect(s.data.byCalendar).toEqual([expect.objectContaining({ label: "Consults", scheduled: 4 })]);
    // The no-show lists the sales rep as its host; the others fall back to the assigned owner.
    expect(s.data.byHost.find((h) => h.key === a.people.sales.id)).toMatchObject({ scheduled: 1, noShows: 1 });
    expect(s.data.byHost.find((h) => h.key === a.people.owner.id)).toMatchObject({ scheduled: 3, completed: 1 });
    const mine = section(await run(a.actor("owner"), { ...RANGE, member: a.people.sales.id }, ["appointments"]), "appointments");
    expect(mine.data.scheduled).toBe(1);
  });

  it("keeps deal values per currency, dates wins by when they closed, and counts native deals only", async () => {
    const s = section(await run(a.actor("owner"), RANGE, ["deals"]), "deals");
    expect(s.data.created).toBe(5);
    expect(s.data.won).toBe(2);
    expect(s.data.lost).toBe(1);
    expect(s.data.winRate).toBe(66.7);
    expect(s.data.wonValue).toEqual([{ currency: "PHP", value: 50000 }, { currency: "USD", value: 1000 }]);
    expect(s.data.createdValue).toEqual([{ currency: "PHP", value: 50000 }, { currency: "USD", value: 4500 }]);
    expect(s.data.openNow).toBe(2);
    expect(s.data.openValueNow).toEqual([{ currency: "USD", value: 3200 }]);
    expect(s.data.lostReasons).toEqual([{ key: "=Price too high", label: "=Price too high", count: 1 }]);
    expect(s.data.byOwner.find((o) => o.key === a.people.sales.id)).toMatchObject({ won: 1, wonValue: [{ currency: "USD", value: 1000 }] });
    // The second pipeline alone.
    const reno = section(await run(a.actor("owner"), { ...RANGE, pipeline: ids.secondPipelineId }, ["deals"]), "deals");
    expect(reno.data).toMatchObject({ created: 1, won: 0, openNow: 1, openValueNow: [{ currency: "USD", value: 2500 }] });
    // A closed period with nothing in it says so.
    const nothing = section(await run(a.actor("owner"), { range: "custom", from: addDays(FROM, -60), to: addDays(FROM, -50) }, ["deals"]), "deals");
    expect(nothing.data.created).toBe(0);
    expect(nothing.empty).toBe(false); // open deals exist right now
  });

  it("computes pipeline conversion with the pipeline screens' own metrics", async () => {
    const s = section(await run(a.actor("owner"), RANGE, ["pipeline"]), "pipeline");
    expect(s.data.pipelines.map((p) => p.name)).toEqual(expect.arrayContaining(["Renovations"]));
    const main = s.data.pipelines.find((p) => p.isDefault)!;
    expect(main.won).toBe(2);
    expect(main.lost).toBe(1);
    expect(main.wonValue).toEqual([{ currency: "PHP", value: 50000 }, { currency: "USD", value: 1000 }]);
    expect(main.stages.some((st) => st.kind === "open" && st.open === 1)).toBe(true);
    const only = section(await run(a.actor("owner"), { ...RANGE, pipeline: ids.secondPipelineId }, ["pipeline"]), "pipeline");
    expect(only.data.pipelines.map((p) => p.name)).toEqual(["Renovations"]);
  });

  it("counts messages by channel and provider, provider failure reports and block reasons, leaving notes out", async () => {
    const s = section(await run(a.actor("owner"), RANGE, ["messaging"]), "messaging");
    expect(s.data).toMatchObject({ received: 2, sent: 3, delivered: 1, failed: 1, blocked: 1, pending: 0 });
    expect(s.data.byChannel).toEqual(expect.arrayContaining([expect.objectContaining({ channel: "sms", provider: "twilio", sent: 3, failed: 1 })]));
    expect(s.data.deliveryFailures).toEqual([{ provider: "twilio", status: "failed", count: 1 }]);
    expect(s.data.blockedReasons).toEqual([expect.objectContaining({ key: "no_consent", count: 1 })]);
    expect(s.data.campaigns).toEqual([]);
    const email = section(await run(a.actor("owner"), { ...RANGE, channel: "email" }, ["messaging"]), "messaging");
    expect(email.data.sent).toBe(0);
    expect(email.empty).toBe(true);
    const bySales = section(await run(a.actor("owner"), { ...RANGE, member: a.people.sales.id }, ["messaging"]), "messaging");
    expect(bySales.data.received).toBe(2);
    const byOwner = section(await run(a.actor("owner"), { ...RANGE, member: a.people.owner.id }, ["messaging"]), "messaging");
    expect(byOwner.data.received).toBe(0);
  });

  it("reports follow-up sequences, why they stopped and the messages they sent", async () => {
    const s = section(await run(a.actor("owner"), RANGE, ["followups"]), "followups");
    expect(s.data).toMatchObject({ started: 3, activeNow: 1, completed: 1, stopped: 1, replied: 1, booked: 0, messagesSent: 1, replyRate: 50 });
    expect(s.data.stoppedBy).toEqual([{ key: "customer_replied", label: "Customer replied", count: 1 }]);
  });

  it("shows each person's workload, with unassigned tasks counted apart", async () => {
    const s = section(await run(a.actor("owner"), RANGE, ["workload"]), "workload");
    const rep = s.data.members.find((m) => m.userId === a.people.sales.id)!;
    expect(rep).toMatchObject({ openTasks: 2, overdueTasks: 1, completedTasks: 1, conversations: 1, openDeals: 0 });
    expect(s.data.unassignedOpenTasks).toBe(1);
    const one = section(await run(a.actor("owner"), { ...RANGE, member: a.people.sales.id }, ["workload"]), "workload");
    expect(one.data.members.map((m) => m.userId)).toEqual([a.people.sales.id]);
  });

  it("counts AI employee tool calls and approvals, workflow runs (tests apart), integration health and metered usage", async () => {
    const r = await run(a.actor("owner"), RANGE, ["ai", "workflows", "integrations", "usage"]);
    const ai = section(r, "ai");
    expect(ai.data.toolCalls).toBe(3);
    expect(ai.data.byOutcome).toEqual(expect.arrayContaining([expect.objectContaining({ key: "done", count: 2 }), expect.objectContaining({ key: "pending_approval", count: 1 })]));
    expect(ai.data.approvals).toMatchObject({ requested: 2, approved: 1, pending: 1, executed: 1 });
    const wf = section(r, "workflows");
    expect(wf.data).toMatchObject({ runs: 3, completed: 1, failed: 1, dead: 1, testRuns: 1 });
    expect(wf.data.byWorkflow).toEqual([expect.objectContaining({ name: "Welcome", runs: 3, dead: 1 })]);
    const integ = section(r, "integrations");
    expect(integ.data.channels).toEqual([expect.objectContaining({ channel: "sms", provider: "twilio", state: "test_failed" })]);
    expect(integ.data.checks).toEqual([expect.objectContaining({ provider: "email", status: "error" })]);
    expect(integ.data.webhooks).toMatchObject({ active: 1, deadDeliveries: 1 });
    const usage = section(r, "usage");
    expect(usage.data).toMatchObject({ currency: "USD", events: 2, charged: 1.45, uncollected: 0.5 });
    expect(usage.data.byUnit).toEqual([expect.objectContaining({ key: "sms_segment", events: 2, quantity: 3 })]);
  });

  it("never mixes in another workspace's rows", async () => {
    const r = await run(b.actor("owner"), RANGE, ["leads", "deals"]);
    expect(section(r, "leads").data.newContacts).toBe(1);
    expect(section(r, "deals").data.wonValue).toEqual([{ currency: "USD", value: 5 }]);
    expect(section(r, "deals").data.lostReasons).toEqual([]);
  });

  it("says 'no data yet' rather than showing zeros for a period with no records", async () => {
    const c = await crmOrg({ timezone: TZ });
    const r = await run(c.actor("owner"), { range: "7d" });
    for (const s of ["leads", "appointments", "deals", "messaging", "followups", "ai", "workflows", "usage"] as const) expect(section(r, s).empty).toBe(true);
  });
});

describe("who sees which section, and the filters themselves", () => {
  it("leaves out sections someone can't see, naming the permission, and never shows them as zeros", async () => {
    const r = await run(a.actor("sales"), RANGE);
    const shown = r.sections.map((s) => s.section);
    expect(shown).toEqual(expect.arrayContaining(["leads", "appointments", "deals", "pipeline", "workload"]));
    for (const s of ["messaging", "followups", "ai", "workflows", "integrations", "usage"]) expect(shown).not.toContain(s);
    expect(r.hidden.find((h) => h.section === "messaging")?.reason).toMatch(/permission/);
    expect(visibleSections((p) => a.actor("sales").can(p))).toEqual(shown);
    // Workload hides counts the viewer can't see.
    const rep = section(r, "workload").data.members.find((m) => m.userId === a.people.sales.id)!;
    expect(rep.conversations).toBeNull();
  });

  it("needs the reporting permission", async () => {
    const owner = a.actor("owner");
    const noReports: CrmActor = { ...owner, can: (p) => p !== "analytics.view" && owner.can(p) };
    await expect(run(noReports)).rejects.toThrow(/reporting permission/);
    await expect(getReportOptions(noReports)).rejects.toThrow();
  });

  it("drops filters that don't belong to this workspace, with a notice, and lists the filters a section ignores", async () => {
    const outsider = b.people.owner.id;
    const r = await run(a.actor("owner"), { ...RANGE, member: outsider, pipeline: crypto.randomUUID(), campaign: crypto.randomUUID() }, ["leads"]);
    expect(r.filters.member).toBeUndefined();
    expect(r.filters.pipeline).toBeUndefined();
    expect(r.notices.join(" ")).toMatch(/team member/);
    expect(r.notices.join(" ")).toMatch(/pipeline/);
    expect(r.notices.join(" ")).toMatch(/campaign/);
    const withPipeline = await run(a.actor("owner"), { ...RANGE, pipeline: ids.secondPipelineId }, ["leads", "deals"]);
    expect(withPipeline.filterLabels.pipeline).toBe("Renovations");
    expect(section(withPipeline, "leads").ignored).toEqual(["pipeline"]);
    expect(section(withPipeline, "deals").ignored).toEqual([]);
    await expect(run(a.actor("owner"), { range: "custom", from: TO, to: FROM })).rejects.toThrow(/on or before/);
  });

  it("offers the workspace's members and pipelines as filter choices", async () => {
    const o = await getReportOptions(a.actor("owner"));
    expect(o.members.map((m) => m.id)).toEqual(expect.arrayContaining([a.people.owner.id, a.people.sales.id]));
    expect(o.members.some((m) => m.id === b.people.owner.id)).toBe(false);
    expect(o.pipelines.map((p) => p.name)).toEqual(expect.arrayContaining(["Renovations"]));
    expect(o.campaigns).toEqual([]);
  });

  it("lets an agency support session read reports, without workspace-only sections, saving or exporting", async () => {
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, a.org.id, { mode: "read", reason: "Checking the monthly report" });
    const agency = await agencyActor(superAdmin, a.org.id);
    const r = await run(agency, RANGE);
    expect(section(r, "deals").data.won).toBe(2);
    expect(r.hidden.map((h) => h.section)).toEqual(expect.arrayContaining(["ai", "integrations", "usage"]));
    expect(r.hidden.every((h) => h.reason === "Not part of a support session.")).toBe(true);
    await expect(exportCrmReport(agency, { filters: RANGE })).rejects.toThrow(/read-only|Export reports/);
    await expect(createSavedReport(agency, { name: "Agency", config: { filters: RANGE, sections: ["deals"] } })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Saved report definitions
// ---------------------------------------------------------------------------

describe("saved reports", () => {
  it("keeps private reports private, shares team reports, and only lets permitted people change them", async () => {
    const owner = a.actor("owner");
    const manager = a.actor("manager");
    const sales = a.actor("sales");
    const team = await createSavedReport(owner, { name: "Monthly review", description: "For the team meeting", config: { filters: { range: "last_month" }, sections: ["leads", "deals"] }, visibility: "team" });
    const mine = await createSavedReport(sales, { name: "My pipeline", config: { filters: { range: "30d", member: a.people.sales.id }, sections: ["deals"] } });
    await expect(createSavedReport(sales, { name: "Team one", config: { filters: { range: "30d" }, sections: ["deals"] }, visibility: "team" })).rejects.toThrow(/Export reports/);
    expect(team.key).toBe("monthly-review");

    const salesList = await listSavedReports(sales);
    expect(salesList.map((r) => r.id)).toEqual(expect.arrayContaining([team.id, mine.id]));
    expect(salesList.find((r) => r.id === team.id)).toMatchObject({ editable: false, mine: false, visibility: "team" });
    expect(salesList.find((r) => r.id === mine.id)).toMatchObject({ editable: true, mine: true, visibility: "private" });
    const ownerList = await listSavedReports(owner);
    expect(ownerList.some((r) => r.id === mine.id)).toBe(false);
    expect(await getSavedReport(owner, mine.id)).toBeNull();
    // Row-level security agrees: the owner's own database session can't read the rep's private report.
    const rls = await withUser(a.people.owner.id, (db) => db.query("select id from crm_report_definitions where id = $1", [mine.id]));
    expect(rls.rows).toHaveLength(0);
    // Another workspace never sees either.
    expect((await listSavedReports(b.actor("owner"))).some((r) => r.id === team.id)).toBe(false);

    await expect(updateSavedReport(sales, team.id, { name: "Hijacked" })).rejects.toThrow(/Only the person who saved/);
    await expect(setSavedReportPinned(sales, team.id, true)).rejects.toThrow();
    await expect(archiveSavedReport(owner, mine.id)).rejects.toThrow(/not found/);
    await updateSavedReport(manager, team.id, { name: "Monthly review (all)", config: { filters: { range: "mtd" }, sections: ["deals"] } });
    await expect(updateSavedReport(manager, team.id, { visibility: "private" })).rejects.toThrow(/Only the person who saved a team report/);
    await setSavedReportPinned(manager, team.id, true);
    const reread = await getSavedReport(sales, team.id);
    expect(reread).toMatchObject({ name: "Monthly review (all)", key: "monthly-review-all", pinned: true, report: "deals", config: { filters: { range: "mtd" }, sections: ["deals"] } });
    expect((await listSavedReports(sales))[0].id).toBe(team.id);

    // Archiving frees the key.
    await archiveSavedReport(sales, mine.id);
    expect(await getSavedReport(sales, mine.id)).toBeNull();
    const again = await createSavedReport(sales, { name: "My pipeline", config: { filters: { range: "30d" }, sections: ["deals"] } });
    expect(again.key).toBe("my-pipeline");
    const twin = await createSavedReport(sales, { name: "My pipeline", config: { filters: { range: "30d" }, sections: ["deals"] } });
    expect(twin.key).toBe("my-pipeline-2");

    const audit = await withSystem((db) => db.query<{ action: string }>("select action from audit_logs where org_id = $1 and target_id = $2 order by created_at", [a.org.id, team.id]));
    expect(audit.rows.map((r) => r.action)).toEqual(["crm.report_saved", "crm.report_updated", "crm.report_pinned"]);
  });

  it("validates what a report remembers, and opens a saved report from its link", async () => {
    const owner = a.actor("owner");
    await expect(createSavedReport(owner, { name: " ", config: { filters: { range: "30d" }, sections: ["deals"] } })).rejects.toThrow(/Name the report/);
    await expect(createSavedReport(owner, { name: "No sections", config: { filters: { range: "30d" }, sections: [] } })).rejects.toThrow(/at least one section/);
    await expect(createSavedReport(owner, { name: "Future", config: { filters: { range: "custom", from: TODAY, to: addDays(TODAY, 3) }, sections: ["deals"] } })).rejects.toThrow(/future/);
    await expect(createSavedReport(owner, { name: "Bad", config: { filters: { range: "forever" }, sections: ["deals"] } as never })).rejects.toThrow(/reporting period/);
    // Preset periods move with time, so stray dates aren't kept.
    const s = await createSavedReport(owner, { name: "Rolling", config: { filters: { range: "7d", from: "2026-01-01", to: "2026-01-02" }, sections: ["usage", "leads"] } });
    expect((await getSavedReport(owner, s.id))?.config).toEqual({ filters: { range: "7d" }, sections: ["leads", "usage"] });

    const opened = await resolveReportRequest(owner, { report: s.id });
    expect(opened.active?.id).toBe(s.id);
    expect(opened.filters).toEqual({ range: "7d" });
    expect(opened.sections).toEqual(["leads", "usage"]);
    const adjusted = await resolveReportRequest(owner, { report: s.id, range: "90d" });
    expect(adjusted.filters).toEqual({ range: "90d" });
    expect(adjusted.sections).toBeNull();
    const missing = await resolveReportRequest(owner, { report: crypto.randomUUID() });
    expect(missing.active).toBeNull();
    expect(missing.notices.join(" ")).toMatch(/isn't available/);
  });

  it("saves, renames, pins and archives through the server actions", async () => {
    who.actor = a.actor("owner");
    const saved = await saveReportAction(null, { name: "From the screen", config: { filters: RANGE, sections: ["deals", "leads"] }, visibility: "team" });
    expect(saved.ok).toBe(true);
    const id = saved.ok ? saved.data.id : "";
    expect((await updateReportAction(null, id, { name: "Renamed", description: "  " })).ok).toBe(true);
    expect((await pinReportAction(null, id, true)).ok).toBe(true);
    expect(await getSavedReport(a.actor("owner"), id)).toMatchObject({ name: "Renamed", description: null, pinned: true, config: { filters: RANGE, sections: ["leads", "deals"] } });
    who.actor = a.actor("sales");
    const denied = await archiveReportAction(null, id);
    expect(denied).toMatchObject({ ok: false, code: "forbidden" });
    const bad = await saveReportAction(null, { name: "x", config: { filters: { range: "30d" }, sections: ["nope"] } });
    expect(bad.ok).toBe(false);
    who.actor = a.actor("owner");
    expect((await archiveReportAction(null, id)).ok).toBe(true);
    expect((await archiveReportAction(null, "not-a-uuid")).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("report export", () => {
  it("needs the export permission, writes one value per row with currencies apart, defuses formulas, and is audited", async () => {
    await expect(exportCrmReport(a.actor("sales"), { filters: RANGE })).rejects.toThrow(/Export reports/);
    const { filename, csv } = await exportCrmReport(a.actor("owner"), { filters: RANGE, sections: ["leads", "deals", "integrations"] });
    expect(filename).toMatch(new RegExp(`^crm-report-reports-a-${FROM}-to-${TO}\\.csv$`));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Section,Measure,Breakdown,Item,Value,Currency");
    expect(lines).toContain(`Report,Time zone,,${TZ},,`);
    expect(lines).toContain("Leads & sources,New contacts,,,3,");
    expect(lines).toContain("Deals and deal value,Won value,,,50000,PHP");
    expect(lines).toContain("Deals and deal value,Won value,,,1000,USD");
    expect(lines).toContain("Deals and deal value,Lost,Lost reason,'=Price too high,1,");
    expect(lines).toContain("Integration health,Scope,,Current state (not limited to the period),,");
    expect(csv).not.toMatch(/Synthetic message body|@example\.test/);
    const audit = await withSystem((db) =>
      db.query<{ actor_user_id: string; metadata: { sections: string[]; from: string; to: string; filters: string[] } }>(
        "select actor_user_id, metadata from audit_logs where org_id = $1 and action = 'crm.report_exported' order by created_at desc limit 1",
        [a.org.id],
      ),
    );
    expect(audit.rows[0]).toMatchObject({ actor_user_id: a.people.owner.id, metadata: { sections: ["leads", "deals", "integrations"], from: FROM, to: TO, filters: [] } });
  });

  it("says plainly when a section has nothing, instead of listing zeros", () => {
    const report: CrmReport = {
      generatedAt: new Date().toISOString(), timezone: "UTC", period: { from: "2026-10-01", to: "2026-10-07", days: 7, label: "Last 7 days", startsAt: "", endsAt: "", dated: true },
      filters: { range: "7d" }, filterLabels: {}, notices: [], hidden: [{ section: "usage", reason: "Needs the “x” permission." }],
      sections: [{ section: "deals", data: {} as SectionPayloads["deals"], empty: true, ignored: [], notes: [] }],
    };
    const csv = reportToCsv(report, "Acme");
    expect(csv).toContain("Deals and deal value,No data yet,,No records for this period and these filters.,,");
    expect(csv).toContain("Report,Not included,,Usage costs: Needs the “x” permission.,,");
  });

  it("serves the CSV from the export route for people who may export, and refuses everyone else", async () => {
    who.actor = a.actor("owner");
    const ok = await exportRoute(new Request(`http://localhost/api/crm/reports/export?range=custom&from=${FROM}&to=${TO}&sections=deals`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/csv/);
    expect(ok.headers.get("content-disposition")).toMatch(/attachment; filename="crm-report-/);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await ok.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // a byte order mark, so spreadsheets read UTF-8
    const body = await ok.text();
    expect(body).toContain("Deals and deal value,Won,,,2,");
    expect(body).not.toContain("Leads & sources");
    who.actor = a.actor("sales");
    const denied = await exportRoute(new Request("http://localhost/api/crm/reports/export?range=30d"));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/Export reports/);
  });

  it("limits how often one person can download reports", async () => {
    const c = await crmOrg({ timezone: TZ });
    const owner = c.actor("owner");
    const windowMs = REPORT_EXPORT_LIMIT.windowSeconds * 1000;
    const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    await withSystem((db) =>
      db.query("insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, $3)", [`${REPORT_EXPORT_LIMIT.name}:${c.org.id}:${owner.userId}`, start.toISOString(), REPORT_EXPORT_LIMIT.limit]),
    );
    await expect(exportCrmReport(owner, { filters: { range: "7d" } })).rejects.toMatchObject({ code: "rate_limited" });
    // Someone else in the same workspace has their own allowance.
    await expect(exportCrmReport(c.actor("manager"), { filters: { range: "7d" } })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Agency operational summary and system health
// ---------------------------------------------------------------------------

describe("agency CRM operations", () => {
  it("counts failures, waiting work, billing and support per client, with no personal details, and scopes staff to their clients", async () => {
    const { superAdmin, staff } = await agencyPeople();
    await withSystem(async (db) => {
      // A credit balance at the client's low-balance line, and an open urgent escalation.
      await db.query("insert into credit_accounts (org_id, balance_micros) values ($1, 4000000) on conflict (org_id) do update set balance_micros = 4000000, reserved_micros = 0", [a.org.id]);
      await db.query("insert into billing_settings (org_id, low_balance_micros) values ($1, 5000000) on conflict (org_id) do update set low_balance_micros = 5000000", [a.org.id]);
      await db.query(
        "insert into human_escalations (org_id, conversation_id, contact_id, category, urgency, summary, status) values ($1, $2, $3, 'complaint', 'urgent', 'Synthetic complaint summary', 'open')",
        [a.org.id, ids.conversationId, ids.contacts.qualified],
      );
      await db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [a.org.id, staff.id]);
    });
    const all = await agencyCrmOperations(superAdmin);
    const row = all.rows.find((r) => r.orgId === a.org.id)!;
    expect(row).toMatchObject({
      name: "Reports A", mode: "native", ghlCapabilities: 0,
      integrations: { checks: 1, channels: 1, calendars: 0, voice: 0, total: 2 },
      automation: { deadRuns: 1, failedRuns: 1, deadLetters: 1, deadWebhooks: 1 },
      formFailures: 1,
      billing: { lowBalance: true, exhausted: false },
      support: { openEscalations: 1, urgentEscalations: 1 },
      attention: true,
    });
    // The services above emitted events nobody dispatched in these tests, plus the one seeded an hour ago.
    expect(row.automation.backlog).toBeGreaterThanOrEqual(2);
    expect(row.automation.oldestPendingMinutes).toBeGreaterThanOrEqual(59);
    expect(all.rows.some((r) => r.orgId === b.org.id)).toBe(true);
    expect(all.totals.clients).toBe(all.rows.length);
    // Counts only: none of the seeded people, addresses, message text or summaries.
    const text = JSON.stringify(all);
    for (const leak of ["Qualified", "@example.test", "Synthetic message body", "Synthetic complaint summary", "Dollar deal", "+15550001234"]) expect(text).not.toContain(leak);

    const mine = await agencyCrmOperations(staff);
    expect(mine.rows.map((r) => r.orgId)).toEqual([a.org.id]);
    const outsider = await createUser();
    await expect(agencyCrmOperations({ id: outsider.id, platformRole: "none" })).rejects.toThrow(/Agency access/);
  });

  it("reports how many clients use each CRM mode, and GoHighLevel-owned capabilities in hybrid mode", async () => {
    const { superAdmin } = await agencyPeople();
    const h = await crmOrg({ name: "Hybrid Reports" });
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [h.org.id]);
      await db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'appointments', 'ghl'), ($1, 'calendars', 'ghl')", [h.org.id]);
    });
    const s = await agencyCrmOperations(superAdmin);
    expect(s.rows.find((r) => r.orgId === h.org.id)).toMatchObject({ mode: "hybrid", ghlCapabilities: 2 });
    expect(s.totals.byMode.hybrid).toBeGreaterThanOrEqual(1);
  });

  it("adds CRM background work to system health, as counts", async () => {
    const h = await withSystem((db) => crmDeliveryHealth(db));
    expect(h.events.backlog).toBeGreaterThanOrEqual(1);
    expect(h.events.oldestPendingMinutes).toBeGreaterThanOrEqual(59);
    expect(h.events.deadLetters24h).toBeGreaterThanOrEqual(1);
    expect(h.webhooks.dead24h).toBeGreaterThanOrEqual(1);
    expect(h.forms.failed24h).toBeGreaterThanOrEqual(0);
    const full = await getSystemHealth();
    expect(full.crm.events.backlog).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Dashboard and analytics
// ---------------------------------------------------------------------------

describe("native-aware dashboard and analytics", () => {
  it("counts native deals and appointments for an iAcquire CRM workspace, and leaves GoHighLevel workspaces exactly as before", async () => {
    const c = await crmOrg();
    const ctx = ctxFor(c.people.owner, c.org, "owner");
    const won = await createOpportunity(c.actor("owner"), { name: "Won this week", value: 100, currency: "EUR" });
    await closeOpportunity(c.actor("owner"), won.id, "won");
    await createOpportunity(c.actor("owner"), { name: "Still open", value: 10, currency: "USD" });
    const old = await createOpportunity(c.actor("owner"), { name: "Won long ago", value: 1, currency: "USD" });
    await closeOpportunity(c.actor("owner"), old.id, "won");
    await withSystem(async (db) => {
      await db.query("update crm_opportunities set closed_at = now() - interval '45 days' where id = $1", [old.id]);
      // A GoHighLevel copy kept from before the switch: open, recently synced. Native counts leave it out.
      await db.query("insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, synced_at) values ($1, $2, 'GHL copy', 'open', 'ghl', now())", [c.org.id, `ghl_${hex(4)}`]);
      await db.query("insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, synced_at) values ($1, $2, 'GHL won', 'won', 'ghl', now())", [c.org.id, `ghl_${hex(4)}`]);
      await db.query("insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at) values ($1, $2, 'cal', 'GHL', 'confirmed', now() + interval '1 day', now() + interval '25 hours')", [c.org.id, `ghl_${hex(4)}`]);
    });
    expect(await withUser(c.people.viewer.id, (db) => nativeCrmOwners(db, c.org.id))).toEqual({ opportunities: true, appointments: true });
    const native = await getDashboard(ctx);
    expect(native.sources).toMatchObject({ crm: true, calendar: true, crmDetail: "iAcquire CRM", native: { opportunities: true, appointments: true } });
    expect(native.kpis.activeOpportunities).toEqual({ value: 1, available: true });
    expect(native.kpis.wonDeals).toEqual({ value: 1, available: true });
    expect(native.kpis.upcomingMeetings).toEqual({ value: 0, available: true });
    expect(native.setup.find((s) => s.key === "crm")).toMatchObject({ label: "iAcquire CRM ready", done: true });

    const range = { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(), days: 30 };
    const analytics = await getAnalytics(ctx, range);
    expect(analytics.sales).toMatchObject({ won: 1, lost: 0, wonValue: 100, wonValues: [{ currency: "EUR", value: 100 }] });
    expect(analytics.sales?.stages.reduce((n, s) => n + s.n, 0)).toBe(1);
    expect(analytics.appointments).toMatchObject({ booked: 0 });

    // The same workspace on GoHighLevel: nothing counts until the connection is verified, then every synced row counts as it always did.
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    const ghl = await getDashboard(ctx);
    expect(ghl.sources).toMatchObject({ crm: false, calendar: false, native: { opportunities: false, appointments: false } });
    expect(ghl.kpis.activeOpportunities).toEqual({ value: null, available: false, reason: "CRM not connected" });
    expect(ghl.setup.find((s) => s.key === "crm")).toMatchObject({ label: "CRM connected by iAcquire", done: false });
    await withSystem((db) => db.query("insert into integration_status (org_id, provider, status) values ($1, 'ghl', 'connected'), ($1, 'ghl_calendar', 'connected')", [c.org.id]));
    const connected = await getDashboard(ctx);
    expect(connected.kpis.activeOpportunities).toEqual({ value: 2, available: true });
    expect(connected.kpis.upcomingMeetings).toEqual({ value: 1, available: true });
    const ghlAnalytics = await getAnalytics(ctx, range);
    expect(ghlAnalytics.sales).not.toHaveProperty("wonValues");
    expect((await withUser(c.people.owner.id, (db) => sourceAvailability(db, c.org.id, false))).crm).toBe(true);

    // Hybrid: each capability follows its own owner.
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [c.org.id]);
      await db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'appointments', 'ghl')", [c.org.id]);
    });
    expect(await withUser(c.people.viewer.id, (db) => nativeCrmOwners(db, c.org.id))).toEqual({ opportunities: true, appointments: false });
    const hybrid = await getDashboard(ctx);
    expect(hybrid.kpis.activeOpportunities).toEqual({ value: 1, available: true });
    expect(hybrid.kpis.upcomingMeetings).toEqual({ value: 1, available: true });
  });

  it("treats a person who can't see the workspace's CRM settings, or a workspace with none, as not native", async () => {
    const c = await crmOrg();
    const stranger = await crmOrg();
    expect(await withUser(stranger.people.owner.id, (db) => nativeCrmOwners(db, c.org.id))).toEqual({ opportunities: false, appointments: false });
    await withSystem((db) => db.query("delete from crm_workspaces where org_id = $1", [c.org.id]));
    expect(await withUser(c.people.owner.id, (db) => nativeCrmOwners(db, c.org.id))).toEqual({ opportunities: false, appointments: false });
  });
});

// The full report runs every section without error for every client role (a smoke test of the SQL under row-level security).
describe("every role", () => {
  it("can open the report", async () => {
    for (const r of ["owner", "manager", "sales", "setter", "support", "viewer"] as const) {
      const rep = await run(a.actor(r), { range: "30d" });
      expect(rep.sections.length + rep.hidden.length).toBe(REPORT_SECTIONS.length);
    }
  });
});

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

function scopeOf(actor: CrmActor, base = "/crm"): CrmScope {
  const can: Partial<Record<Permission, true>> = {};
  for (const p of Object.keys(PERMISSION_MATRIX) as Permission[]) if (actor.can(p)) can[p] = true;
  return { base, orgId: actor.kind === "agency" ? actor.orgId : null, agency: actor.kind === "agency", readOnly: actor.kind === "agency" && actor.supportMode === "read", userId: actor.userId, timezone: actor.timezone, currency: "USD", can };
}

describe("report screens", () => {
  it("renders every section with its numbers, tables, sources and the export and save controls for an owner", async () => {
    const owner = a.actor("owner");
    const report = await run(owner, RANGE);
    const out = html(React.createElement(ReportsWorkspace, {
      scope: scopeOf(owner), report, options: await getReportOptions(owner), saved: await listSavedReports(owner), active: null, requested: null,
      available: visibleSections((p) => owner.can(p)), notices: [], canExport: true, canShare: true, canSave: true,
    }));
    for (const s of REPORT_SECTIONS) expect(out).toContain(`id="report-${s}"`);
    expect(out).toContain("Export CSV");
    expect(out).toContain(`/api/crm/reports/export?range=custom&amp;from=${FROM}&amp;to=${TO}`);
    // A plain browser download: with `download` on the anchor the app router leaves the click alone, so the export runs once per click
    // (Next's client navigation would fetch it, then fetch it again as a page).
    const exportAnchor = /<a [^>]*href="\/api\/crm\/reports\/export[^"]*"[^>]*>/.exec(out)?.[0] ?? "";
    expect(exportAnchor).toMatch(/\sdownload(=""|\s|>)/);
    expect(out).toContain("Save report");
    expect(out).toContain("₱50,000 · $1,000");
    expect(out).toContain("Quote request");
    expect(out).toContain("Counted from:");
    expect(out).toContain("<caption class=\"sr-only\">Deals by owner</caption>");
    expect(out).toContain("Current state");
    expect(out).not.toContain("Synthetic message body");
  });

  it("shows 'no data yet', what isn't included and why, and no save or export controls for an agency session", async () => {
    const { superAdmin } = await agencyPeople();
    const c = await crmOrg({ timezone: TZ });
    await startSupportSession(superAdmin, c.org.id, { mode: "read", reason: "Looking at an empty report" });
    const agency = await agencyActor(superAdmin, c.org.id);
    const report = await run(agency, { range: "7d" });
    const out = html(React.createElement(ReportsWorkspace, {
      scope: scopeOf(agency, `/admin/clients/${c.org.id}/crm`), report, options: await getReportOptions(agency), saved: [], active: null, requested: null,
      available: visibleSections((p) => agency.can(p)), notices: ["A notice for the reader."], canExport: false, canShare: false, canSave: false,
    }));
    expect(out).toContain("No data yet");
    expect(out).toContain("Not included");
    expect(out).toContain("Not part of a support session.");
    expect(out).toContain("A notice for the reader.");
    expect(out).toContain("support session");
    expect(out).not.toContain("Export CSV");
    expect(out).not.toContain("Save report");
  });

  it("renders the agency operations report and the system health section with counts only", async () => {
    const { superAdmin } = await agencyPeople();
    const summary = await agencyCrmOperations(superAdmin);
    const out = html(React.createElement(AgencyOpsReport, { summary, superAdmin: true }));
    expect(out).toContain("CRM operations");
    expect(out).toContain("Reports A");
    expect(out).toContain(`/admin/clients/${a.org.id}/crm`);
    expect(out).not.toContain("@example.test");
    const health = html(React.createElement(CrmDeliveryHealthSection, { h: await withSystem((db) => crmDeliveryHealth(db)) }));
    expect(health).toContain("CRM background work");
    expect(health).toContain("Events waiting");
  });
});
