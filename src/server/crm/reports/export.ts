import "server-only";
import { recordAudit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { assertCan, auditActor, type CrmActor } from "@/server/crm/actor";
import { getCrmReport } from "@/server/crm/reports/service";
import { csvLine } from "@/lib/crm/csv";
import { CHANNEL_LABELS, FILTER_KEYS, FILTER_LABELS, SECTION_INFO, activeFilters, type ReportFilters, type ReportSection } from "@/components/crm/reports/spec";
import type { CrmReport, Money, SectionPayloads } from "@/components/crm/reports/types";
import { BOOKED_VIA_LABELS } from "@/server/crm/reports/appointments";
import { PROVIDER_LABELS } from "@/server/crm/reports/messaging";

/** Report downloads per person per hour. Each one recomputes the whole report, so the limit protects the database, not the data. */
export const REPORT_EXPORT_LIMIT = { name: "crm-reports:export", limit: 20, windowSeconds: 3600 } as const;

const HEADER = ["Section", "Measure", "Breakdown", "Item", "Value", "Currency"];

type Line = [section: string, measure: string, breakdown: string, item: string, value: string | number | null, currency?: string];

/**
 * A computed report as CSV, one value per row (section, measure, breakdown, item, value, currency), so every figure can be filtered and
 * traced. Money stays one row per currency; nothing is converted or added across currencies. A section with no rows says so instead of
 * listing zeros.
 */
export function reportToCsv(report: CrmReport, workspace: string): string {
  const out: Line[] = [];
  const meta = (measure: string, item: string) => out.push(["Report", measure, "", item, null]);
  meta("Workspace", workspace);
  meta("Period", report.period.dated ? `${report.period.from} to ${report.period.to} (${report.period.label})` : "Current state");
  meta("Time zone", report.timezone);
  meta("Generated", report.generatedAt);
  for (const k of activeFilters(report.filters)) meta(`Filter: ${FILTER_LABELS[k]}`, report.filterLabels[k] ?? String(report.filters[k]));
  for (const n of report.notices) meta("Notice", n);
  for (const h of report.hidden) meta("Not included", `${SECTION_INFO[h.section].label}: ${h.reason}`);

  for (const s of report.sections) {
    const label = SECTION_INFO[s.section].label;
    const add = (measure: string, value: number | null, breakdown = "", item = "") => out.push([label, measure, breakdown, item, value]);
    const money = (measure: string, values: Money[], breakdown = "", item = "") => {
      for (const m of values) out.push([label, measure, breakdown, item, m.value, m.currency]);
    };
    const rows = (breakdown: string, list: Array<{ label: string; count: number }>, measure = "Count") => {
      for (const r of list) add(measure, r.count, breakdown, r.label);
    };
    if (!SECTION_INFO[s.section].dated) out.push([label, "Scope", "", "Current state (not limited to the period)", null]);
    for (const k of s.ignored) out.push([label, "Filter not applied", "", FILTER_LABELS[k], null]);
    for (const n of s.notes) out.push([label, "Note", "", n, null]);
    if (s.empty) {
      out.push([label, "No data yet", "", "No records for this period and these filters.", null]);
      continue;
    }
    writeSection(s.section, s.data as SectionPayloads[ReportSection], { add, money, rows });
  }
  return [csvLine(HEADER), ...out.map(([a, b, c, d, v, cur]) => csvLine([a, b, c, d, v ?? "", cur ?? ""]))].join("");
}

interface Writers {
  add: (measure: string, value: number | null, breakdown?: string, item?: string) => void;
  money: (measure: string, values: Money[], breakdown?: string, item?: string) => void;
  rows: (breakdown: string, list: Array<{ label: string; count: number }>, measure?: string) => void;
}

function writeSection(section: ReportSection, data: SectionPayloads[ReportSection], w: Writers) {
  const { add, money, rows } = w;
  switch (section) {
    case "leads": {
      const d = data as SectionPayloads["leads"];
      add("New contacts", d.newContacts);
      add("Qualified or customer now", d.qualifiedNow);
      for (const r of d.byDay) add("New contacts", r.n, "Day", r.day);
      for (const r of d.byCreatedVia) {
        add("New contacts", r.count, "Created via", r.label);
        add("Qualified or customer now", r.qualified, "Created via", r.label);
      }
      rows("Lead source", d.bySource, "New contacts");
      rows("Lead status now", d.byStatus, "New contacts");
      add("Form submissions", d.forms.total);
      for (const f of d.forms.rows) {
        add("Form submissions", f.total, "Form", f.name);
        add("Processed", f.processed, "Form", f.name);
        add("Spam", f.spam, "Form", f.name);
        add("Failed", f.failed, "Form", f.name);
        add("Waiting to process", f.pending, "Form", f.name);
        add("Contacts", f.contacts, "Form", f.name);
        if (f.opportunities !== null) add("Opportunities", f.opportunities, "Form", f.name);
      }
      for (const u of d.forms.utm) add("Form submissions", u.count, "UTM source / medium / campaign", [u.source || "(none)", u.medium || "(none)", u.campaign || "(none)"].join(" / "));
      return;
    }
    case "appointments": {
      const d = data as SectionPayloads["appointments"];
      add("Booked in period", d.booked);
      rows("Booked via", d.bookedVia, "Booked in period");
      add("Scheduled in period", d.scheduled);
      add("Completed (showed)", d.completed);
      add("No-shows", d.noShows);
      add("Cancelled", d.cancelled);
      add("Late cancellations", d.lateCancellations);
      add("Upcoming", d.upcoming);
      add("Outcome not recorded", d.unmarked);
      add("Show rate %", d.showRate);
      const table = (breakdown: string, list: SectionPayloads["appointments"]["byType"]) => {
        for (const r of list) {
          const item = breakdown === "Booked via" ? (BOOKED_VIA_LABELS[r.key] ?? r.label) : r.label;
          add("Scheduled", r.scheduled, breakdown, item);
          add("Completed (showed)", r.completed, breakdown, item);
          add("No-shows", r.noShows, breakdown, item);
          add("Cancelled", r.cancelled, breakdown, item);
        }
      };
      table("Appointment type", d.byType);
      table("Calendar", d.byCalendar);
      table("Host", d.byHost);
      table("Booked via", d.byBookedVia);
      return;
    }
    case "deals": {
      const d = data as SectionPayloads["deals"];
      add("Created", d.created);
      money("Created value", d.createdValue);
      add("Won", d.won);
      money("Won value", d.wonValue);
      add("Won without a recorded value", d.wonWithoutValue);
      add("Lost", d.lost);
      money("Lost value", d.lostValue);
      add("Win rate %", d.winRate);
      add("Open now", d.openNow);
      money("Open value now", d.openValueNow);
      for (const o of d.byOwner) {
        add("Created", o.created, "Owner", o.label);
        add("Won", o.won, "Owner", o.label);
        add("Lost", o.lost, "Owner", o.label);
        money("Won value", o.wonValue, "Owner", o.label);
      }
      for (const v of d.byCreatedVia) {
        add("Created", v.created, "Created via", v.label);
        add("Won", v.won, "Created via", v.label);
      }
      rows("Lost reason", d.lostReasons, "Lost");
      return;
    }
    case "pipeline": {
      const d = data as SectionPayloads["pipeline"];
      for (const p of d.pipelines) {
        add("Created", p.created, "Pipeline", p.name);
        add("Won", p.won, "Pipeline", p.name);
        add("Lost", p.lost, "Pipeline", p.name);
        add("Win rate %", p.winRate, "Pipeline", p.name);
        money("Won value", p.wonValue, "Pipeline", p.name);
        money("Open value now", p.openValue, "Pipeline", p.name);
        money("Weighted forecast", p.weightedForecast, "Pipeline", p.name);
        for (const s of p.stages) {
          const item = `${p.name} › ${s.name}`;
          add("Open deals now", s.open, "Stage", item);
          money("Open value now", s.value, "Stage", item);
          add("Average days in stage", s.avgDaysInStage, "Stage", item);
        }
      }
      if (d.more) add("Pipelines not shown (choose one with the pipeline filter)", d.more);
      return;
    }
    case "messaging": {
      const d = data as SectionPayloads["messaging"];
      add("Received", d.received);
      add("Sent", d.sent);
      add("Delivered", d.delivered);
      add("Failed", d.failed);
      add("Blocked before sending", d.blocked);
      add("Waiting to send", d.pending);
      for (const r of d.byChannel) {
        const item = `${CHANNEL_LABELS[r.channel as keyof typeof CHANNEL_LABELS] ?? r.channel} · ${PROVIDER_LABELS[r.provider] ?? r.provider}`;
        add("Received", r.received, "Channel · provider", item);
        add("Sent", r.sent, "Channel · provider", item);
        add("Delivered", r.delivered, "Channel · provider", item);
        add("Failed", r.failed, "Channel · provider", item);
        add("Blocked before sending", r.blocked, "Channel · provider", item);
      }
      for (const f of d.deliveryFailures) add("Provider failure reports", f.count, "Provider · status", `${PROVIDER_LABELS[f.provider] ?? f.provider} · ${f.status}`);
      rows("Blocked reason", d.blockedReasons, "Blocked before sending");
      for (const day of d.byDay) {
        add("Received", day.received, "Day", day.day);
        add("Sent", day.sent, "Day", day.day);
      }
      for (const c of d.campaigns ?? []) {
        add("Campaign recipients", c.recipients, "Campaign", c.name);
        for (const [status, n] of Object.entries(c.byStatus)) add(`Campaign recipients: ${status}`, n, "Campaign", c.name);
      }
      return;
    }
    case "followups": {
      const d = data as SectionPayloads["followups"];
      add("Started", d.started);
      add("Active now", d.activeNow);
      add("Completed", d.completed);
      add("Stopped", d.stopped);
      add("Stopped: customer replied", d.replied);
      add("Stopped: customer booked", d.booked);
      add("Reply rate %", d.replyRate);
      add("Follow-up messages sent", d.messagesSent);
      add("Steps blocked", d.stepsBlocked);
      rows("Stop reason", d.stoppedBy, "Stopped");
      return;
    }
    case "workload": {
      const d = data as SectionPayloads["workload"];
      for (const m of d.members) {
        add("Open tasks now", m.openTasks, "Team member", m.name);
        add("Overdue tasks now", m.overdueTasks, "Team member", m.name);
        add("Tasks completed", m.completedTasks, "Team member", m.name);
        if (m.conversations !== null) add("Open conversations owned", m.conversations, "Team member", m.name);
        if (m.openDeals !== null) add("Open deals owned", m.openDeals, "Team member", m.name);
        if (m.contacts !== null) add("Contacts owned", m.contacts, "Team member", m.name);
      }
      add("Unassigned open tasks", d.unassignedOpenTasks);
      add("Unassigned overdue tasks", d.unassignedOverdueTasks);
      return;
    }
    case "ai": {
      const d = data as SectionPayloads["ai"];
      add("CRM tool calls", d.toolCalls);
      rows("Outcome", d.byOutcome, "CRM tool calls");
      rows("Tool", d.byTool, "CRM tool calls");
      rows("AI employee", d.byEmployee, "CRM tool calls");
      const a = d.approvals;
      add("Approvals requested", a.requested);
      add("Approved", a.approved);
      add("Rejected", a.rejected);
      add("Expired", a.expired);
      add("Waiting for a decision", a.pending);
      add("Carried out", a.executed);
      add("Failed when carried out", a.failed);
      add("Held (integration off)", a.held);
      rows("Approval kind", d.approvalsByKind, "Approvals requested");
      return;
    }
    case "workflows": {
      const d = data as SectionPayloads["workflows"];
      add("Runs", d.runs);
      add("Completed", d.completed);
      add("Failed", d.failed);
      add("Gave up after retries", d.dead);
      add("In progress", d.running);
      add("Cancelled", d.cancelled);
      add("Test runs (not counted above)", d.testRuns);
      for (const r of d.byWorkflow) {
        add("Runs", r.runs, "Workflow", r.name);
        add("Completed", r.completed, "Workflow", r.name);
        add("Failed", r.failed, "Workflow", r.name);
        add("Gave up after retries", r.dead, "Workflow", r.name);
      }
      return;
    }
    case "integrations": {
      const d = data as SectionPayloads["integrations"];
      for (const c of d.channels) add(`Channel state: ${c.state.replace(/_/g, " ")}`, 1, "Channel · provider", `${CHANNEL_LABELS[c.channel as keyof typeof CHANNEL_LABELS] ?? c.channel} · ${PROVIDER_LABELS[c.provider] ?? c.provider}`);
      for (const c of d.calendarConnections) add(`Calendar connections: ${c.status.replace(/_/g, " ")}`, c.count, "Provider", c.provider);
      for (const v of d.voice) add(`Voice connection: ${v.status.replace(/_/g, " ")}`, 1, "Provider", v.provider);
      for (const c of d.checks) add(`Connection check: ${c.status.replace(/_/g, " ")}`, 1, "Provider", c.provider);
      add("Webhooks active", d.webhooks.active);
      add("Webhooks turned off", d.webhooks.disabled);
      add("Webhook deliveries failed (7 days)", d.webhooks.failedDeliveries);
      add("Webhook deliveries given up (7 days)", d.webhooks.deadDeliveries);
      add("Calendar sync failures (7 days)", d.calendarSyncFailures);
      return;
    }
    case "usage": {
      const d = data as SectionPayloads["usage"];
      add("Metered events", d.events);
      money("Charged", [{ currency: d.currency, value: d.charged }]);
      money("Not collected", [{ currency: d.currency, value: d.uncollected }]);
      for (const u of d.byUnit) {
        add("Metered events", u.events, "Unit", u.label);
        add("Quantity", u.quantity, "Unit", u.label);
        money("Charged", [{ currency: d.currency, value: u.charged }], "Unit", u.label);
        money("Not collected", [{ currency: d.currency, value: u.uncollected }], "Unit", u.label);
      }
      return;
    }
  }
}

/**
 * Exports a report as CSV for someone with "Export reports". Agency support sessions never carry that permission. Each download is rate
 * limited per person and recorded in the audit log with the period, sections and which filters were used (not their values).
 */
export async function exportCrmReport(
  actor: CrmActor,
  input: { filters: ReportFilters; sections?: ReportSection[] | null; savedId?: string | null },
  now: Date = new Date(),
): Promise<{ filename: string; csv: string }> {
  assertCan(actor, "analytics.export", "Exporting reports needs the “Export reports” permission. Ask a workspace owner for access.");
  const limit = await consumeRateLimit(REPORT_EXPORT_LIMIT, `${actor.orgId}:${actor.userId ?? actor.kind}`);
  if (!limit.allowed) throw new AppError("rate_limited", "That's a lot of report downloads in a short time. Please wait a little and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
  const report = await getCrmReport(actor, input, now);
  const csv = reportToCsv(report, actor.orgName);
  await recordAudit({
    orgId: actor.orgId, ...auditActor(actor), action: "crm.report_exported", targetType: input.savedId ? "crm_report_definition" : "crm_report", targetId: input.savedId ?? undefined, result: "success",
    metadata: {
      sections: report.sections.map((s) => s.section), hidden: report.hidden.map((h) => h.section), range: report.filters.range, from: report.period.from, to: report.period.to,
      filters: FILTER_KEYS.filter((k) => report.filters[k] !== undefined),
    },
  });
  const slug = actor.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  return { filename: `crm-report-${slug}-${report.period.from}-to-${report.period.to}.csv`, csv };
}
