import Link from "next/link";
import { CalendarClock, FileWarning, Inbox, Webhook, Workflow, Zap } from "lucide-react";
import { MetricCard, SectionLabel } from "@/components/ui/workspace";
import type { CrmDeliveryHealth } from "@/server/admin/health";

const n = (v: number) => v.toLocaleString("en-US");
const age = (m: number | null) => (m === null ? "none waiting" : m < 60 ? `oldest ${m} min` : m < 2880 ? `oldest ${Math.floor(m / 60)} h` : `oldest ${Math.floor(m / 1440)} days`);

/**
 * Native CRM background work across all clients, for System health: counts only. A small backlog is normal right after events happen; an
 * old one means the dispatcher isn't keeping up or isn't running.
 */
export function CrmDeliveryHealthSection({ h }: { h: CrmDeliveryHealth }) {
  const stuck = h.events.oldestPendingMinutes !== null && h.events.oldestPendingMinutes > 15;
  return (
    <section>
      <SectionLabel
        title="CRM background work"
        description="Event dispatch, workflows, forms, bookings, calendar sync and webhooks for every client. Counts only; per-client detail is on the CRM operations report."
        action={<Link href="/admin/crm/reports" className="inline-flex min-h-11 items-center text-xs font-medium text-primary-ink sm:min-h-8">CRM operations report</Link>}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Events waiting" value={n(h.events.backlog)} detail={<>{age(h.events.oldestPendingMinutes)}{h.events.retrying ? ` · ${n(h.events.retrying)} retrying` : ""}{h.events.deadLetters24h ? ` · ${n(h.events.deadLetters24h)} gave up (24h)` : ""}</>} icon={<Zap />} tone={stuck || h.events.deadLetters24h ? "amber" : "blue"} />
        <MetricCard label="Workflow runs · 24h" value={n(h.workflows.failed24h + h.workflows.dead24h)} detail={`${n(h.workflows.failed24h)} failed · ${n(h.workflows.dead24h)} gave up · ${n(h.workflows.waitingApproval)} waiting for approval`} icon={<Workflow />} tone={h.workflows.dead24h ? "amber" : "violet"} />
        <MetricCard label="Form submissions" value={n(h.forms.queued)} detail={`waiting · ${n(h.forms.retrying)} retrying · ${n(h.forms.failed24h)} failed (24h)`} icon={<Inbox />} tone={h.forms.failed24h ? "amber" : "blue"} />
        <MetricCard label="Booking calendar writes" value={n(h.bookings.calendarWritesFailing)} detail={`failing now · ${n(h.bookings.remindersBlocked24h)} reminders held (24h)`} icon={<FileWarning />} tone={h.bookings.calendarWritesFailing ? "amber" : "neutral"} />
        <MetricCard label="Calendar sync · 24h" value={n(h.calendarSync.failed24h)} detail={`failed runs · ${n(h.calendarSync.connectionsNeedingAttention)} connections need attention`} icon={<CalendarClock />} tone={h.calendarSync.failed24h || h.calendarSync.connectionsNeedingAttention ? "amber" : "neutral"} />
        <MetricCard label="Webhook deliveries · 24h" value={n(h.webhooks.failed24h + h.webhooks.dead24h)} detail={`${n(h.webhooks.failed24h)} retrying · ${n(h.webhooks.dead24h)} gave up · ${n(h.webhooks.pending)} pending`} icon={<Webhook />} tone={h.webhooks.dead24h ? "amber" : "neutral"} />
      </div>
    </section>
  );
}
