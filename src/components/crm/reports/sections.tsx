"use client";

import * as React from "react";
import Link from "next/link";
import { Ban, CheckCircle2, Clock, HelpCircle, XCircle } from "lucide-react";
import { AreaChart, HBarList, StatusSplit } from "@/components/charts";
import { Badge } from "@/components/ui/primitives";
import { Segmented, Tooltip } from "@/components/ui/overlays";
import { CHANNEL_LABELS, type ReportChannel } from "@/components/crm/reports/spec";
import { count, dayLabel, fillDays, moneyText, percent, share, usd } from "@/components/crm/reports/format";
import type { AppointmentRow, CrmReport, SectionPayloads } from "@/components/crm/reports/types";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

// The body of each CRM report section. Every figure on screen is one the server counted from this workspace's rows; tables sit next to (or
// behind a toggle on) every chart so the numbers can be read without the picture.

export interface SectionContext {
  base: string;
  timezone: string;
  period: CrmReport["period"];
  /** Whether a link to a screen behind a number should be shown (the viewer can open it). */
  can: (p: string) => boolean;
  agency: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  ghl: "GoHighLevel", resend: "Resend", twilio: "Twilio", meta_whatsapp: "WhatsApp Cloud API", google: "Google Calendar", microsoft: "Microsoft Outlook", vapi: "Vapi", retell: "Retell",
  hermes: "Hermes", ghl_calendar: "GoHighLevel calendar", n8n: "n8n", slack: "Slack", email: "Email", llm: "AI model", database: "Database", unknown: "Not recorded",
};
const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? p.replace(/_/g, " ");
const channelLabel = (c: string) => CHANNEL_LABELS[c as ReportChannel] ?? c;
const words = (s: string) => s.replace(/_/g, " ");

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export function Stat({ label, value, hint, definition, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; definition?: string; tone?: "danger" | "warning" | "success" }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2/70 p-3.5">
      <p className="flex items-center gap-1 text-[12px] font-medium text-muted">
        <span className="min-w-0 truncate">{label}</span>
        {definition && (
          <Tooltip content={definition}>
            <button type="button" aria-label={`About ${label}`} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:text-muted">
              <HelpCircle className="size-3" aria-hidden />
            </button>
          </Tooltip>
        )}
      </p>
      <p className={cn("mt-0.5 truncate text-[20px] font-semibold tracking-[-0.02em] tabular-nums", tone === "danger" ? "text-danger-ink" : tone === "warning" ? "text-warning-ink" : tone === "success" ? "text-success-ink" : "text-ink")}>{value}</p>
      {hint && <p className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</p>}
    </div>
  );
}

export function StatGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-2.5 @md:grid-cols-3 @3xl:grid-cols-6", className)}>{children}</div>;
}

function Block({ title, description, children, className }: { title: string; description?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

interface TableProps {
  caption: string;
  head: string[];
  rows: Array<{ key: string; cells: React.ReactNode[] }>;
  empty?: string;
  /** Columns after the first are numbers (right-aligned) unless listed here. */
  textColumns?: number[];
  minWidth?: string;
}

/** A plain data table: the first column names the row (a row header), the rest are values. */
export function DataTable({ caption, head, rows, empty = "No data yet.", textColumns = [], minWidth = "min-w-[28rem]" }: TableProps) {
  if (!rows.length) return <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[14px] text-muted">{empty}</p>;
  const align = (i: number) => (i === 0 || textColumns.includes(i) ? "text-left" : "text-right tabular-nums");
  return (
    <div role="region" aria-label={`${caption} table`} tabIndex={0} className="scrollbar-thin overflow-x-auto rounded-xl border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
      <table className={cn("w-full text-[14px]", minWidth)}>
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-2/70 text-[12px] text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={cn("px-3 py-2 font-medium", align(i))}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="max-w-[16rem] px-3 py-2 text-left font-medium text-ink-2">{c}</th>
                ) : (
                  <td key={i} className={cn("px-3 py-2 text-ink", align(i))}>{c}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TraceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="text-[13px] font-medium text-primary hover:underline">{children}</Link>;
}

function DayTrend({ ctx, rows, unit, label }: { ctx: SectionContext; rows: Array<{ day: string; n: number }>; unit: string; label: string }) {
  if (!ctx.period.dated || ctx.period.days < 2) return null;
  const data = fillDays(rows, ctx.period.from, ctx.period.to, (r) => r.n);
  return <AreaChart data={data} label={label} unit={unit} formatX={(x) => dayLabel(x)} height={200} />;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function LeadsBody({ data: d, ctx }: { data: SectionPayloads["leads"]; ctx: SectionContext }) {
  const qualifiedShare = share(d.qualifiedNow, d.newContacts);
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="New contacts" value={count(d.newContacts)} definition="Contacts created in the period (deleted contacts are not counted)." />
        <Stat label="Qualified now" value={count(d.qualifiedNow)} hint={qualifiedShare !== null ? `${percent(qualifiedShare)} of new contacts` : undefined} definition="Of the contacts created in the period, how many have the lead status Qualified or Customer today." />
        <Stat label="Form submissions" value={count(d.forms.total)} definition="Every submission received in the period, including spam and ones still waiting to be processed." />
        <Stat label="Lead sources" value={count(d.byCreatedVia.length)} hint="Ways contacts arrived" />
      </StatGrid>
      {d.newContacts > 0 && <DayTrend ctx={ctx} rows={d.byDay} unit="contacts" label="New contacts per day" />}
      <div className="grid gap-5 @2xl:grid-cols-2">
        <Block title="How they arrived" description="How each contact was created, and how many are qualified now.">
          <DataTable
            caption="New contacts by how they arrived"
            head={["Arrived via", "Contacts", "Qualified now"]}
            rows={d.byCreatedVia.map((r) => ({ key: r.key, cells: [r.label, count(r.count), count(r.qualified)] }))}
            minWidth="min-w-[18rem]"
          />
        </Block>
        <Block title="Lead source" description="The lead source recorded on each new contact.">
          <HBarList unit="contacts" rows={d.bySource.map((r) => ({ key: r.key, label: r.label, value: r.count }))} emptyLabel="No contacts in this period." />
        </Block>
      </div>
      {d.byStatus.length > 0 && (
        <Block title="Lead status now" description="Where the new contacts stand today.">
          <div className="flex flex-wrap gap-2">
            {d.byStatus.map((s) => (
              <Badge key={s.key} tone="neutral">{s.label} <span className="font-semibold tabular-nums text-ink">{count(s.count)}</span></Badge>
            ))}
          </div>
        </Block>
      )}
      <Block
        title="Forms"
        description={d.forms.unfiltered.length ? "Form submissions aren't tied to a team member or a contact's lead source, so those filters don't narrow this table." : "Submissions by form, and what happened to them."}
      >
        <DataTable
          caption="Form submissions by form"
          head={["Form", "Submissions", "Processed", "Spam", "Failed", "Waiting", "Contacts", "Deals"]}
          rows={d.forms.rows.map((f) => ({
            key: f.key,
            cells: [f.name, count(f.total), count(f.processed), count(f.spam), f.failed ? <span className="text-danger-ink">{count(f.failed)}</span> : "0", count(f.pending), count(f.contacts), f.opportunities === null ? <span title="The built-in website form doesn't create deals">—</span> : count(f.opportunities)],
          }))}
          empty="No form submissions in this period."
          minWidth="min-w-[40rem]"
        />
      </Block>
      {d.forms.utm.length > 0 && (
        <Block title="Campaign tracking (UTM)" description="UTM values exactly as they arrived with a submission. Spam is left out; nothing is guessed from a referrer.">
          <DataTable
            caption="Form submissions by UTM source, medium and campaign"
            head={["Source", "Medium", "Campaign", "Submissions"]}
            textColumns={[1, 2]}
            rows={d.forms.utm.map((u, i) => ({ key: `${i}`, cells: [u.source || <span className="text-muted">No UTM recorded</span>, u.medium || "—", u.campaign || "—", count(u.count)] }))}
          />
        </Block>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {ctx.can("contacts.view") && <TraceLink href={`${ctx.base}/contacts`}>Open contacts</TraceLink>}
      </div>
    </div>
  );
}

const APPT_DIMENSIONS = [
  { value: "type", label: "Type" },
  { value: "calendar", label: "Calendar" },
  { value: "host", label: "Host" },
  { value: "via", label: "Booked via" },
] as const;

export function AppointmentsBody({ data: d, ctx }: { data: SectionPayloads["appointments"]; ctx: SectionContext }) {
  const [dim, setDim] = React.useState<(typeof APPT_DIMENSIONS)[number]["value"]>("type");
  const rows: AppointmentRow[] = dim === "type" ? d.byType : dim === "calendar" ? d.byCalendar : dim === "host" ? d.byHost : d.byBookedVia;
  const noShowRate = share(d.noShows, d.completed + d.noShows);
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="Booked" value={count(d.booked)} definition="Appointments created during the period, whenever they take place." />
        <Stat label="Scheduled" value={count(d.scheduled)} definition="Appointments whose start time falls in the period (cancelled ones included)." />
        <Stat label="Completed" value={count(d.completed)} tone={d.completed ? "success" : undefined} definition="Appointments marked as showed." />
        <Stat label="No-shows" value={count(d.noShows)} tone={d.noShows ? "warning" : undefined} hint={noShowRate !== null ? `${percent(noShowRate)} of attended or missed` : undefined} />
        <Stat label="Cancelled" value={count(d.cancelled)} hint={d.lateCancellations ? `${count(d.lateCancellations)} late` : undefined} definition="Cancelled appointments; late ones were cancelled inside the type's notice period." />
        <Stat label="Show rate" value={percent(d.showRate)} definition="Completed ÷ (completed + no-shows). Upcoming and unrecorded appointments are left out." />
      </StatGrid>
      {d.scheduled > 0 && (
        <Block title="What happened to scheduled appointments">
          <StatusSplit
            segments={[
              { label: "Completed", value: d.completed, color: "var(--status-good)", icon: <CheckCircle2 className="size-3.5 text-success" aria-hidden /> },
              { label: "No-show", value: d.noShows, color: "var(--status-warning)", icon: <Ban className="size-3.5 text-warning" aria-hidden /> },
              { label: "Cancelled", value: d.cancelled, color: "var(--status-critical)", icon: <XCircle className="size-3.5 text-danger" aria-hidden /> },
              { label: "Upcoming", value: d.upcoming, color: "var(--series-1)", icon: <Clock className="size-3.5 text-primary" aria-hidden /> },
              { label: "Not recorded yet", value: d.unmarked, color: "var(--line-strong)", icon: <HelpCircle className="size-3.5 text-muted" aria-hidden /> },
            ]}
          />
          {d.unmarked > 0 && <p className="mt-2 text-[13px] text-muted">{count(d.unmarked)} appointment{d.unmarked === 1 ? " has" : "s have"} passed without anyone recording whether it happened, so the show rate leaves {d.unmarked === 1 ? "it" : "them"} out.</p>}
        </Block>
      )}
      <Block title="Breakdown" description="Appointments scheduled in the period. A collective appointment counts once for each host.">
        <div className="mb-3">
          <Segmented id="appt-dim" ariaLabel="Break appointments down by" size="sm" value={dim} onChange={setDim} options={APPT_DIMENSIONS.map((o) => ({ value: o.value, label: o.label }))} />
        </div>
        <DataTable
          caption={`Appointments by ${APPT_DIMENSIONS.find((o) => o.value === dim)?.label.toLowerCase()}`}
          head={[APPT_DIMENSIONS.find((o) => o.value === dim)?.label ?? "", "Scheduled", "Completed", "No-shows", "Cancelled", "Upcoming", "Not recorded"]}
          rows={rows.map((r) => ({ key: r.key, cells: [r.label, count(r.scheduled), count(r.completed), count(r.noShows), count(r.cancelled), count(r.upcoming), count(r.unmarked)] }))}
          empty="No appointments scheduled in this period."
          minWidth="min-w-[36rem]"
        />
      </Block>
      {d.bookedVia.length > 0 && (
        <Block title="How appointments were booked" description="Appointments created in the period.">
          <HBarList unit="appointments" rows={d.bookedVia.map((r) => ({ key: r.key, label: r.label, value: r.count }))} />
        </Block>
      )}
      {ctx.can("appointments.view") && <TraceLink href={`${ctx.base}/appointments`}>Open appointments</TraceLink>}
    </div>
  );
}

export function DealsBody({ data: d, ctx }: { data: SectionPayloads["deals"]; ctx: SectionContext }) {
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="Created" value={count(d.created)} hint={moneyText(d.createdValue) ?? "No values recorded"} />
        <Stat label="Won" value={count(d.won)} tone={d.won ? "success" : undefined} hint={moneyText(d.wonValue) ?? (d.won ? "No values recorded" : undefined)} definition="Deals won in the period, by the date they closed. Values are the amounts recorded on each deal, per currency." />
        <Stat label="Lost" value={count(d.lost)} hint={moneyText(d.lostValue) ?? undefined} />
        <Stat label="Win rate" value={percent(d.winRate)} definition="Won ÷ (won + lost) for deals closed in the period." />
        <Stat label="Open now" value={count(d.openNow)} hint={moneyText(d.openValueNow) ?? undefined} definition="Open deals right now (not limited to the period)." />
      </StatGrid>
      {d.wonWithoutValue > 0 && <p className="text-[13px] text-muted">{count(d.wonWithoutValue)} won deal{d.wonWithoutValue === 1 ? " has" : "s have"} no value recorded, so {d.wonWithoutValue === 1 ? "it isn't" : "they aren't"} in the won value.</p>}
      <Block title="By owner" description="Deals created, won and lost in the period by the person who owns them.">
        <DataTable
          caption="Deals by owner"
          head={["Owner", "Created", "Won", "Lost", "Won value"]}
          rows={d.byOwner.map((o) => ({ key: o.key, cells: [o.label, count(o.created), count(o.won), count(o.lost), moneyText(o.wonValue) ?? "—"] }))}
          empty="No deals created or closed in this period."
          minWidth="min-w-[30rem]"
        />
      </Block>
      <div className="grid gap-5 @2xl:grid-cols-2">
        <Block title="How deals were created">
          <DataTable caption="Deals by how they were created" head={["Created via", "Created", "Won"]} rows={d.byCreatedVia.map((v) => ({ key: v.key, cells: [v.label, count(v.created), count(v.won)] }))} minWidth="min-w-[16rem]" />
        </Block>
        <Block title="Why deals were lost">
          <HBarList unit="deals" rows={d.lostReasons.map((r) => ({ key: r.key, label: r.label, value: r.count }))} emptyLabel="No deals lost in this period." />
        </Block>
      </div>
      {ctx.can("sales.view") && <TraceLink href={`${ctx.base}/opportunities`}>Open opportunities</TraceLink>}
    </div>
  );
}

export function PipelineBody({ data: d, ctx }: { data: SectionPayloads["pipeline"]; ctx: SectionContext }) {
  return (
    <div className="space-y-6">
      {d.pipelines.map((p) => (
        <div key={p.id} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">{p.name}{p.isDefault && <Badge tone="neutral">Default</Badge>}</h3>
            {ctx.can("sales.view") && <TraceLink href={`${ctx.base}/pipelines?p=${p.id}`}>Open board</TraceLink>}
          </div>
          <StatGrid>
            <Stat label="Created" value={count(p.created)} />
            <Stat label="Won" value={count(p.won)} hint={moneyText(p.wonValue) ?? undefined} />
            <Stat label="Lost" value={count(p.lost)} />
            <Stat label="Win rate" value={percent(p.winRate)} definition="Won ÷ (won + lost) for deals that closed in the period." />
            <Stat label="Open value now" value={moneyText(p.openValue) ?? "—"} />
            <Stat
              label="Weighted forecast"
              value={moneyText(p.weightedForecast) ?? "—"}
              hint={p.dealsWithoutProbability ? `${count(p.dealsWithoutProbability)} deal${p.dealsWithoutProbability === 1 ? "" : "s"} without a stage probability left out` : undefined}
              definition="Each open deal's value × its stage's win probability, per currency."
            />
          </StatGrid>
          <HBarList unit="open deals" rows={p.stages.filter((s) => s.kind === "open").map((s) => ({ key: s.id, label: s.name, value: s.open }))} emptyLabel="No open deals in this pipeline." />
          <DataTable
            caption={`${p.name}: stages`}
            head={["Stage", "Open deals", "Open value", "Win probability", "Average days in stage"]}
            rows={p.stages.map((s) => ({
              key: s.id,
              cells: [
                <span key="n" className="inline-flex items-center gap-1.5">{s.name}{s.kind !== "open" && <Badge tone={s.kind === "won" ? "success" : "neutral"}>{s.kind === "won" ? "Won" : "Lost"}</Badge>}</span>,
                s.kind === "open" ? count(s.open) : "—",
                s.kind === "open" ? (moneyText(s.value) ?? "—") : "—",
                s.probability === null ? "—" : `${s.probability}%`,
                s.avgDaysInStage === null ? "—" : s.avgDaysInStage.toLocaleString("en-US", { maximumFractionDigits: 1 }),
              ],
            }))}
            minWidth="min-w-[34rem]"
          />
        </div>
      ))}
      {d.more > 0 && <p className="text-[13px] text-muted">{count(d.more)} more pipeline{d.more === 1 ? "" : "s"} not shown. Choose one with the pipeline filter to see it.</p>}
      <p className="text-[12px] text-muted">Average days in stage comes from recorded stage changes in the period: how long deals stayed in a stage before they moved on.</p>
    </div>
  );
}

export function MessagingBody({ data: d, ctx }: { data: SectionPayloads["messaging"]; ctx: SectionContext }) {
  const [series, setSeries] = React.useState<"received" | "sent">("received");
  const deliveredShare = share(d.delivered, d.sent);
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="Received" value={count(d.received)} />
        <Stat label="Sent" value={count(d.sent)} definition="Outgoing messages a provider accepted (sent, delivered or read)." />
        <Stat label="Delivered" value={count(d.delivered)} hint={deliveredShare !== null ? `${percent(deliveredShare)} of sent` : undefined} definition="Sent messages the provider confirmed as delivered or read. Some providers never confirm delivery." />
        <Stat label="Failed" value={count(d.failed)} tone={d.failed ? "danger" : undefined} />
        <Stat label="Blocked" value={count(d.blocked)} tone={d.blocked ? "warning" : undefined} definition="Held back before sending, for example no consent, quiet hours or no credits." />
        <Stat label="Waiting to send" value={count(d.pending)} />
      </StatGrid>
      {d.byDay.length > 0 && ctx.period.days > 1 && (
        <div className="space-y-2">
          <Segmented id="msg-series" ariaLabel="Messages per day" size="sm" value={series} onChange={setSeries} options={[{ value: "received", label: "Received" }, { value: "sent", label: "Sent" }]} />
          <AreaChart
            data={fillDays(d.byDay, ctx.period.from, ctx.period.to, (r) => r[series])}
            label={series === "received" ? "Messages received per day" : "Messages sent per day"}
            unit="messages"
            formatX={(x) => dayLabel(x)}
            height={200}
          />
        </div>
      )}
      <Block title="By channel and provider">
        <DataTable
          caption="Messages by channel and provider"
          head={["Channel", "Provider", "Received", "Sent", "Delivered", "Failed", "Blocked"]}
          textColumns={[1]}
          rows={d.byChannel.map((r) => ({ key: `${r.channel}:${r.provider}`, cells: [channelLabel(r.channel), providerLabel(r.provider), count(r.received), count(r.sent), count(r.delivered), count(r.failed), count(r.blocked)] }))}
          empty="No messages in this period."
          minWidth="min-w-[36rem]"
        />
      </Block>
      <div className="grid gap-5 @2xl:grid-cols-2">
        <Block title="Delivery failures reported by providers" description="Failure and non-delivery reports received in the period.">
          <DataTable
            caption="Delivery failures by provider and status"
            head={["Provider", "Report", "Count"]}
            textColumns={[1]}
            rows={d.deliveryFailures.map((f) => ({ key: `${f.provider}:${f.status}`, cells: [providerLabel(f.provider), f.status === "undelivered" ? "Not delivered" : "Failed", count(f.count)] }))}
            empty="No delivery failures reported."
            minWidth="min-w-[16rem]"
          />
        </Block>
        <Block title="Why messages were blocked">
          <HBarList unit="messages" rows={d.blockedReasons.map((r) => ({ key: r.key, label: r.label, value: r.count }))} emptyLabel="No messages were blocked." />
        </Block>
      </div>
      {d.campaigns && (
        <Block title="Campaigns" description="Campaigns started (or created) in the period and their recipients, one by one as recorded.">
          <DataTable
            caption="Campaign recipients"
            head={["Campaign", "Channel", "Status", "Recipients", "Sent", "Delivered", "Failed", "Left out"]}
            textColumns={[1, 2]}
            rows={d.campaigns.map((c) => ({
              key: c.id,
              cells: [c.name, channelLabel(c.channel), words(c.status), count(c.recipients), count((c.byStatus.sent ?? 0) + (c.byStatus.delivered ?? 0)), count(c.byStatus.delivered ?? 0), count((c.byStatus.failed ?? 0) + (c.byStatus.bounced ?? 0)), count(c.byStatus.excluded ?? 0)],
            }))}
            empty="No campaigns in this period."
            minWidth="min-w-[40rem]"
          />
        </Block>
      )}
      {!ctx.agency && ctx.can("inbox.view") && <TraceLink href="/inbox">Open the inbox</TraceLink>}
    </div>
  );
}

export function FollowUpsBody({ data: d, ctx }: { data: SectionPayloads["followups"]; ctx: SectionContext }) {
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="Started" value={count(d.started)} />
        <Stat label="Active now" value={count(d.activeNow)} />
        <Stat label="Completed" value={count(d.completed)} definition="Sequences that sent every step and ended in the period." />
        <Stat label="Stopped" value={count(d.stopped)} definition="Sequences that ended early in the period, for the reasons below." />
        <Stat label="Replied" value={count(d.replied)} hint={d.replyRate !== null ? `${percent(d.replyRate)} of ended sequences` : undefined} tone={d.replied ? "success" : undefined} />
        <Stat label="Messages sent" value={count(d.messagesSent)} hint={d.stepsBlocked ? `${count(d.stepsBlocked)} step${d.stepsBlocked === 1 ? "" : "s"} blocked` : undefined} />
      </StatGrid>
      <Block title="Why sequences stopped">
        <HBarList unit="sequences" rows={d.stoppedBy.map((r) => ({ key: r.key, label: r.label, value: r.count }))} emptyLabel="No sequences stopped in this period." />
      </Block>
      {d.booked > 0 && <p className="text-[13px] text-muted">{count(d.booked)} sequence{d.booked === 1 ? "" : "s"} stopped because the customer booked.</p>}
      {ctx.can("inbox.view") && <TraceLink href={`${ctx.base}/follow-ups`}>Open follow-up sequences</TraceLink>}
    </div>
  );
}

export function WorkloadBody({ data: d, ctx }: { data: SectionPayloads["workload"]; ctx: SectionContext }) {
  const showConversations = d.members.some((m) => m.conversations !== null);
  const showDeals = d.members.some((m) => m.openDeals !== null);
  const showContacts = d.members.some((m) => m.contacts !== null);
  const head = ["Team member", "Role", "Open tasks", "Overdue", "Completed in period", ...(showConversations ? ["Conversations"] : []), ...(showDeals ? ["Open deals"] : []), ...(showContacts ? ["Contacts"] : [])];
  return (
    <div className="space-y-4">
      <DataTable
        caption="Workload by team member"
        head={head}
        textColumns={[1]}
        rows={[
          ...d.members.map((m) => ({
            key: m.userId,
            cells: [
              m.name, m.role, count(m.openTasks), m.overdueTasks ? <span className="font-medium text-danger-ink">{count(m.overdueTasks)}</span> : "0", count(m.completedTasks),
              ...(showConversations ? [count(m.conversations)] : []), ...(showDeals ? [count(m.openDeals)] : []), ...(showContacts ? [count(m.contacts)] : []),
            ],
          })),
          ...(d.unassignedOpenTasks
            ? [{ key: "unassigned", cells: [<span key="u" className="text-muted">Nobody assigned</span>, "—", count(d.unassignedOpenTasks), count(d.unassignedOverdueTasks), "—", ...(showConversations ? ["—"] : []), ...(showDeals ? ["—"] : []), ...(showContacts ? ["—"] : [])] }]
            : []),
        ]}
        minWidth="min-w-[40rem]"
      />
      <p className="text-[12px] text-muted">Open, overdue and owned counts are as of now; completed tasks are the ones finished in the period.</p>
      {ctx.can("crm.view") && <TraceLink href={`${ctx.base}/tasks`}>Open tasks</TraceLink>}
    </div>
  );
}

export function AiBody({ data: d, ctx }: { data: SectionPayloads["ai"]; ctx: SectionContext }) {
  const a = d.approvals;
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="CRM tool calls" value={count(d.toolCalls)} definition="Every CRM tool an AI employee called in the period, whatever the result." />
        <Stat label="Approvals requested" value={count(a.requested)} />
        <Stat label="Approved" value={count(a.approved)} />
        <Stat label="Rejected" value={count(a.rejected)} />
        <Stat label="Waiting" value={count(a.pending)} tone={a.pending ? "warning" : undefined} />
        <Stat label="Carried out" value={count(a.executed)} hint={a.failed || a.held ? `${count(a.failed)} failed · ${count(a.held)} held` : undefined} definition="Approved actions that ran. Held means it was approved but its integration is off, so nothing ran." />
      </StatGrid>
      <div className="grid gap-5 @2xl:grid-cols-3">
        <Block title="By result"><HBarList unit="calls" rows={d.byOutcome.map((r) => ({ key: r.key, label: r.label, value: r.count }))} emptyLabel="No tool calls in this period." /></Block>
        <Block title="By tool"><HBarList unit="calls" rows={d.byTool.map((r) => ({ key: r.key, label: r.label, value: r.count }))} emptyLabel="No tool calls in this period." /></Block>
        <Block title="By AI employee"><HBarList unit="calls" rows={d.byEmployee.map((r) => ({ key: r.key, label: r.label, value: r.count }))} emptyLabel="No tool calls in this period." /></Block>
      </div>
      {d.approvalsByKind.length > 0 && (
        <Block title="Approvals by kind">
          <DataTable caption="Approval requests by kind" head={["Kind", "Requested"]} rows={d.approvalsByKind.map((k) => ({ key: k.key, cells: [k.label, count(k.count)] }))} minWidth="min-w-[16rem]" />
        </Block>
      )}
      {ctx.can("activity.view") && <TraceLink href={`${ctx.base}/settings/ai-tools`}>Open AI employee tools</TraceLink>}
    </div>
  );
}

export function WorkflowsBody({ data: d, ctx }: { data: SectionPayloads["workflows"]; ctx: SectionContext }) {
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="Runs" value={count(d.runs)} definition="Runs started in the period. Test runs perform nothing and are counted separately." />
        <Stat label="Completed" value={count(d.completed)} tone={d.completed ? "success" : undefined} />
        <Stat label="Failed" value={count(d.failed)} tone={d.failed ? "danger" : undefined} />
        <Stat label="Gave up" value={count(d.dead)} tone={d.dead ? "danger" : undefined} definition="Runs that stopped after their retries ran out." />
        <Stat label="In progress" value={count(d.running)} hint={d.cancelled ? `${count(d.cancelled)} cancelled` : undefined} />
        <Stat label="Test runs" value={count(d.testRuns)} />
      </StatGrid>
      {d.runs > 0 && (
        <StatusSplit
          segments={[
            { label: "Completed", value: d.completed, color: "var(--status-good)", icon: <CheckCircle2 className="size-3.5 text-success" aria-hidden /> },
            { label: "Failed", value: d.failed + d.dead, color: "var(--status-critical)", icon: <XCircle className="size-3.5 text-danger" aria-hidden /> },
            { label: "In progress", value: d.running, color: "var(--series-1)", icon: <Clock className="size-3.5 text-primary" aria-hidden /> },
            { label: "Cancelled", value: d.cancelled, color: "var(--line-strong)", icon: <Ban className="size-3.5 text-muted" aria-hidden /> },
          ]}
        />
      )}
      <Block title="By workflow" description="Workflows with failures first.">
        <DataTable
          caption="Workflow runs by workflow"
          head={["Workflow", "Runs", "Completed", "Failed", "Gave up"]}
          rows={d.byWorkflow.map((w) => ({
            key: w.id,
            cells: [ctx.can("workflows.view") ? <Link key="l" href={`${ctx.base}/workflows/${w.id}`} className="hover:text-primary hover:underline">{w.name}</Link> : w.name, count(w.runs), count(w.completed), w.failed ? <span className="text-danger-ink">{count(w.failed)}</span> : "0", w.dead ? <span className="text-danger-ink">{count(w.dead)}</span> : "0"],
          }))}
          empty="No workflow runs in this period."
          minWidth="min-w-[28rem]"
        />
      </Block>
      {ctx.can("workflows.view") && <TraceLink href={`${ctx.base}/workflows/activity`}>Open workflow activity</TraceLink>}
    </div>
  );
}

const CHANNEL_STATE: Record<SectionPayloads["integrations"]["channels"][number]["state"], { label: string; tone: "success" | "danger" | "warning" | "neutral" }> = {
  ready: { label: "Ready", tone: "success" },
  test_failed: { label: "Last test failed", tone: "danger" },
  not_tested: { label: "Not tested", tone: "warning" },
  off: { label: "Off", tone: "neutral" },
};
const statusTone = (s: string): "success" | "danger" | "warning" | "neutral" => (["connected", "ok"].includes(s) ? "success" : ["error", "needs_reauth", "failed"].includes(s) ? "danger" : ["degraded", "pending", "credentials_saved"].includes(s) ? "warning" : "neutral");
const STATUS_WORDS: Record<string, string> = { credentials_saved: "Credentials saved · not verified", needs_reauth: "Needs reconnecting", not_configured: "Not set up" };

export function IntegrationsBody({ data: d, ctx }: { data: SectionPayloads["integrations"]; ctx: SectionContext }) {
  const when = (iso: string | null) => (iso ? <time dateTime={iso} title={formatDateTime(iso, ctx.timezone)} suppressHydrationWarning>{relativeTime(iso)}</time> : "Never");
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="Webhooks on" value={count(d.webhooks.active)} hint={d.webhooks.disabled ? `${count(d.webhooks.disabled)} turned off` : undefined} />
        <Stat label="Webhook failures" value={count(d.webhooks.failedDeliveries)} tone={d.webhooks.failedDeliveries ? "warning" : undefined} hint="Last 7 days, still retrying" />
        <Stat label="Webhooks given up" value={count(d.webhooks.deadDeliveries)} tone={d.webhooks.deadDeliveries ? "danger" : undefined} hint="Last 7 days" />
        <Stat label="Calendar sync failures" value={count(d.calendarSyncFailures)} tone={d.calendarSyncFailures ? "danger" : undefined} hint="Last 7 days" />
      </StatGrid>
      <Block title="Messaging channels" description="A channel counts as ready only after its provider passed a capability test, never because credentials were saved.">
        <DataTable
          caption="Messaging channels"
          head={["Channel", "Provider", "State", "Last tested", "Registration"]}
          textColumns={[1, 2, 3, 4]}
          rows={d.channels.map((c) => ({ key: c.channel, cells: [channelLabel(c.channel), providerLabel(c.provider), <Badge key="s" tone={CHANNEL_STATE[c.state].tone}>{CHANNEL_STATE[c.state].label}</Badge>, when(c.testedAt), words(c.registration)] }))}
          empty="No messaging channels set up."
          minWidth="min-w-[36rem]"
        />
      </Block>
      <div className="grid gap-5 @2xl:grid-cols-2">
        <Block title="Calendar connections">
          <DataTable
            caption="Calendar connections by provider and status"
            head={["Provider", "Status", "Connections"]}
            textColumns={[1]}
            rows={d.calendarConnections.map((c) => ({ key: `${c.provider}:${c.status}`, cells: [providerLabel(c.provider), <Badge key="s" tone={statusTone(c.status)}>{STATUS_WORDS[c.status] ?? words(c.status)}</Badge>, count(c.count)] }))}
            empty="No calendars connected."
            minWidth="min-w-[18rem]"
          />
        </Block>
        <Block title="Voice providers">
          <DataTable
            caption="Voice provider connections"
            head={["Provider", "Status", "Last call event"]}
            textColumns={[1, 2]}
            rows={d.voice.map((v) => ({ key: v.provider, cells: [providerLabel(v.provider), <Badge key="s" tone={statusTone(v.status)}>{STATUS_WORDS[v.status] ?? words(v.status)}</Badge>, when(v.lastEventAt)] }))}
            empty="No voice provider connected."
            minWidth="min-w-[18rem]"
          />
        </Block>
      </div>
      {d.checks.length > 0 && (
        <Block title="Connection checks" description="The latest recorded check for each connection iAcquire manages.">
          <DataTable
            caption="Recorded connection checks"
            head={["Connection", "Status", "Checked"]}
            textColumns={[1, 2]}
            rows={d.checks.map((c) => ({ key: c.provider, cells: [providerLabel(c.provider), <Badge key="s" tone={statusTone(c.status)}>{STATUS_WORDS[c.status] ?? words(c.status)}</Badge>, when(c.checkedAt)] }))}
            minWidth="min-w-[18rem]"
          />
        </Block>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {ctx.can("inbox.view") && <TraceLink href={`${ctx.base}/settings/communications`}>Communication settings</TraceLink>}
        {ctx.can("appointments.view") && <TraceLink href={`${ctx.base}/calendar-connections`}>Calendar connections</TraceLink>}
        {ctx.can("crm.api.manage") && <TraceLink href={`${ctx.base}/settings/api`}>API &amp; webhooks</TraceLink>}
      </div>
    </div>
  );
}

export function UsageBody({ data: d, ctx }: { data: SectionPayloads["usage"]; ctx: SectionContext }) {
  return (
    <div className="space-y-5">
      <StatGrid>
        <Stat label="Charged" value={usd(d.charged)} definition="What the billing ledger charged for metered usage in the period (USD)." />
        <Stat label="Not collected" value={usd(d.uncollected)} tone={d.uncollected ? "warning" : undefined} definition="Usage that happened but couldn't be charged, for example because credits ran out." />
        <Stat label="Metered events" value={count(d.events)} />
      </StatGrid>
      <DataTable
        caption="Metered usage by unit"
        head={["Unit", "Events", "Quantity", "Charged", "Not collected"]}
        rows={d.byUnit.map((u) => ({ key: u.key, cells: [u.label, count(u.events), u.quantity.toLocaleString("en-US", { maximumFractionDigits: 3 }), usd(u.charged), usd(u.uncollected)] }))}
        minWidth="min-w-[30rem]"
      />
      {!ctx.agency && ctx.can("usage.view") && <TraceLink href="/settings/billing">Open billing</TraceLink>}
    </div>
  );
}
