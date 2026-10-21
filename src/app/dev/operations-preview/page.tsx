import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { PreviewTheme } from "@/components/projects/preview-theme";
import { IncidentsPanel } from "@/components/admin/incidents-panel";
import { ServiceNotices } from "@/components/overview/service-notices";
import { AppointmentsView } from "@/components/appointments/appointments-view";
import { NotificationPrefsForm } from "@/components/settings/settings-forms";
import { RetentionAutomation } from "@/components/retention/programs-panel";
import { DEFAULT_PROGRAMS } from "@/lib/retention";
import { FinanceWorkspace } from "@/components/admin/finance-workspace";
import { OffboardingPanel } from "@/components/admin/offboarding-panel";
import { FairUseAdmin } from "@/components/admin/fair-use-admin";
import { FairUseCard } from "@/components/fairuse/fair-use-card";
import { DataPanel } from "@/components/offboarding/data-panel";
import { resolvePeriod } from "@/lib/finance";
import type { FinancialReport } from "@/server/billing/finance";
import type { AgencyBillingOverview } from "@/server/billing/service";
import type { UnitRateRow } from "@/server/billing/rates";
import type { LifecycleOverview, ProgramView, RetentionActivityRow } from "@/server/retention/service";
import { NOTIFICATION_GROUPS } from "@/lib/notification-groups";
import { DEFAULT_PROACTIVE_PREFS } from "@/lib/proactive";
import type { IncidentRow } from "@/server/ops/incidents";
import type { PendingBookingRow } from "@/server/appointments/overview";
import type { PolicyView } from "@/server/appointments/settings";
import type { OffboardingView } from "@/server/offboarding/service";
import type { FairUseRow, FleetRow, PolicyRow } from "@/server/fairuse/service";
import type { ReviewRow } from "@/server/inactivity/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Operations design preview" };

const VIEWS = ["incidents", "notices", "appointments", "notifications", "retention", "finance", "offboarding", "yourdata", "fairuse"] as const;
type View = (typeof VIEWS)[number];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysFromNow = (d: number, hour = 10) => {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + d);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};

const incident = (over: Partial<IncidentRow>): IncidentRow => ({
  id: crypto.randomUUID(), orgId: null, orgName: null, source: "scheduler", sourceLabel: "Scheduled jobs", subject: "", severity: "warning", status: "open", title: "Sample incident", detail: null,
  safeActions: [], recoveryGuidance: null, clientVisible: false, detectedAt: hoursAgo(2), lastSeenAt: hoursAgo(0.1), occurrences: 1, acknowledgedAt: null, resolvedAt: null, resolution: null, recoveryEvidence: null, ...over,
});

const SAMPLE_INCIDENTS: IncidentRow[] = [
  incident({ severity: "critical", source: "scheduler", sourceLabel: "Scheduled jobs", title: "Scheduled jobs have stopped running", detail: "The scheduler last completed a run 47 minutes ago (it should run at least every 20).", occurrences: 4, safeActions: ["Replies are not sent, follow-ups are not prepared and credit reservations are not released while the scheduler is stopped."], recoveryGuidance: "Check the scheduler that calls /api/internal/tick (Supabase cron, hosting cron or n8n) and that CRON_SECRET still matches." }),
  incident({ severity: "critical", source: "ghl", sourceLabel: "GoHighLevel", orgId: "o1", orgName: "Brightside Realty (sample)", clientVisible: true, title: "GoHighLevel connection has failed (Brightside Realty (sample))", detail: "The token was rejected.", occurrences: 12, safeActions: ["Anything that needs this connection will not go out until a check succeeds again."], recoveryGuidance: "Open Settings → Connected services and reconnect. Nothing is lost while it is disconnected.", acknowledgedAt: hoursAgo(1), status: "acknowledged" }),
  incident({ severity: "warning", source: "queue", sourceLabel: "Work queue", orgId: "o2", orgName: "Sunrise Dental (sample)", title: "3 website enquiries have not been turned into leads (Sunrise Dental (sample))", detail: "Enquiries are saved but not yet processed into contacts.", recoveryGuidance: "The saved enquiries are safe and appear under Website → Enquiries." }),
  incident({ severity: "warning", source: "domain", sourceLabel: "Domain", orgId: "o1", orgName: "Brightside Realty (sample)", clientVisible: true, title: "brightsiderealty.example needs attention", detail: "This address has a problem: its security certificate has a problem.", status: "resolved", resolvedAt: hoursAgo(5), resolution: "verified_recovery", recoveryEvidence: "The domain check ran at 2026-10-14 09:15 UTC and no longer reports this problem." }),
  incident({ severity: "warning", source: "payments", sourceLabel: "Payments", title: "1 payment notification failed to process in the last 24 hours", detail: "A paying client may not have received credits.", status: "resolved", resolvedAt: hoursAgo(20), resolution: "manual", recoveryEvidence: "Matched the checkout in PayMongo and posted the credit adjustment by hand." }),
];

const SAMPLE_APPTS = [
  { id: "a1", title: "Property viewing — 12 Harbor St", status: "confirmed", start_at: daysFromNow(1, 2), end_at: daysFromNow(1, 3), timezone: null, meeting_type: "In person", meeting_link: null, contact_label: "Maria Santos", synced_at: hoursAgo(1), late_cancellation: false, reschedule_count: 1, previous_start_at: daysFromNow(2, 2), conflict: false, origin: "portal_ai" as const, cancelled_at: null },
  { id: "a2", title: "Discovery call", status: "confirmed", start_at: daysFromNow(2, 5), end_at: daysFromNow(2, 6), timezone: null, meeting_type: "Video", meeting_link: "https://meet.example.com/abc", contact_label: "Jon Reyes", synced_at: hoursAgo(1), late_cancellation: false, reschedule_count: 0, previous_start_at: null, conflict: true, origin: "webhook" as const, cancelled_at: null },
  { id: "a3", title: "Discovery call (overlap)", status: "new", start_at: daysFromNow(2, 5), end_at: daysFromNow(2, 6), timezone: null, meeting_type: "Video", meeting_link: null, contact_label: "Ana Cruz", synced_at: hoursAgo(1), late_cancellation: false, reschedule_count: 0, previous_start_at: null, conflict: true, origin: "webhook" as const, cancelled_at: null },
  { id: "a4", title: "Consultation", status: "cancelled", start_at: daysFromNow(3, 3), end_at: daysFromNow(3, 4), timezone: null, meeting_type: null, meeting_link: null, contact_label: "Lee Park", synced_at: hoursAgo(1), late_cancellation: true, reschedule_count: 0, previous_start_at: null, conflict: false, origin: "sync" as const, cancelled_at: hoursAgo(3) },
  { id: "a5", title: "Follow-up viewing", status: "showed", start_at: daysFromNow(-2, 4), end_at: daysFromNow(-2, 5), timezone: null, meeting_type: "In person", meeting_link: null, contact_label: "Dee Lim", synced_at: hoursAgo(1), late_cancellation: false, reschedule_count: 0, previous_start_at: null, conflict: false, origin: "sync" as const, cancelled_at: null },
];

const SAMPLE_PENDING: PendingBookingRow[] = [
  { id: "b1", contactName: "Rina Torres", startAt: daysFromNow(4, 3), label: "Friday, October 23 at 11:00 AM GMT+8", status: "awaiting_approval", requestedBy: "ai", reason: null, approvalId: "x", createdAt: hoursAgo(1) },
  { id: "b2", contactName: "Paolo Diaz", startAt: daysFromNow(5, 6), label: "Saturday, October 24 at 2:00 PM GMT+8", status: "needs_manual", requestedBy: "staff", reason: "Booking through GoHighLevel is switched off for this environment.", approvalId: null, createdAt: hoursAgo(3) },
];

const SAMPLE_POLICY: PolicyView = {
  defaultCalendarId: "cal_main_0001", slotMinutes: 30, minNoticeMinutes: 120, maxDaysAhead: 30, lateCancelHours: 24, aiBookingEnabled: false, remindersEnabled: true, reminderOffsetsMinutes: [1440, 120],
  remindersApprovalId: "x", calendars: ["cal_main_0001", "cal_second_0002"], remindersAuthorization: "active", remindersAuthorizedUntil: daysFromNow(60),
};

const SAMPLE_PROGRAMS: ProgramView[] = DEFAULT_PROGRAMS.map((d, i) => ({
  id: `p${i}`, kind: d.kind, name: d.name, description: d.description, audience: d.audience, trigger: d.trigger, purpose: d.purpose, steps: d.steps, businessHoursOnly: d.businessHoursOnly, inactiveDays: d.inactiveDays,
  enabled: i < 3, state: i === 0 ? "on" : i === 1 ? "needs_approval" : i === 2 ? "lapsed" : "off", approvedAt: i < 3 ? hoursAgo(72) : null, authorizedUntil: i < 3 ? daysFromNow(i === 2 ? -2 : 80) : null,
  stats: { enrolled30d: i === 0 ? 14 : 0, sent30d: i === 0 ? 12 : 0, delivered30d: i === 0 ? 11 : 0, held30d: i === 0 ? 2 : 0, stopped30d: i === 0 ? 3 : 0, replied30d: i === 0 ? 3 : 0 },
}));
const SAMPLE_LIFECYCLE: LifecycleOverview = {
  stages: [["lead_captured", "Lead captured", 18], ["validated", "Validated", 9], ["qualified", "Qualified", 7], ["follow_up", "Follow-up", 5], ["appointment", "Appointment", 4], ["human_sales", "With sales", 3], ["won", "Won", 2], ["lost", "Lost", 6], ["customer", "Customer", 14], ["retention", "Retention", 3]].map(([stage, label, count]) => ({ stage: stage as string, label: label as string, count: count as number })),
  customers: [
    { id: "c1", name: "Maria Santos", stage: "customer", since: hoursAgo(30), paused: false, activePrograms: 2 },
    { id: "c2", name: "Jon Reyes", stage: "customer", since: hoursAgo(900), paused: true, activePrograms: 0 },
    { id: "c3", name: "Ana Cruz", stage: "retention", since: hoursAgo(3000), paused: false, activePrograms: 0 },
  ],
};
const SAMPLE_ACTIVITY: RetentionActivityRow[] = [
  { id: "r1", program: "Welcome new customers", contactName: "Maria Santos", step: "welcome", status: "sent", delivery: "delivered", reason: null, at: hoursAgo(2) },
  { id: "r2", program: "Check in after they start", contactName: "Lee Park", step: "checkin_3", status: "blocked", delivery: null, reason: "suppressed", at: hoursAgo(6) },
  { id: "r3", program: "Welcome new customers", contactName: "Dee Lim", step: "welcome", status: "cancelled", delivery: null, reason: "customer_replied", at: hoursAgo(9) },
  { id: "r4", program: "Check in after they start", contactName: "Rina Torres", step: "checkin_3", status: "queued", delivery: "queued", reason: null, at: hoursAgo(1) },
];

const M = (usd: number) => Math.round(usd * 1_000_000);
const SAMPLE_REPORT: FinancialReport = {
  period: resolvePeriod("this_month"), scope: "agency",
  received: { setupMicros: M(2998), maintenanceMicros: M(299), projectsMicros: M(500), domainsMicros: 0, otherMicros: 0, grossMicros: M(3797), refundedMicros: M(100), netMicros: M(3697) },
  prepaid: { topUpsMicros: M(300), heldForClientsMicros: M(412.5) },
  usage: { chargedMicros: M(260), providerCostMicros: M(200), grossMarkupContributionMicros: M(60), uncollectedMicros: M(13) },
  fees: { knownMicros: M(42.86), paymentsCounted: 3, paymentsWithoutFee: 2 },
  costs: { directMicros: M(20), overheadMicros: M(150) },
  tax: { configuredBps: 2000, setAsideMicros: M(300), suggestedMicros: M(660) },
  reserve: { setupPayments: 2, perSetupUsd: 200, recommendedMicros: M(400), setAsideInPeriodMicros: M(200), setAsideMicros: M(600), usedMicros: M(120), balanceMicros: M(480) },
  distributable: { resultBeforeSetAsidesMicros: M(3344.14), unfundedReserveMicros: M(200), unfundedTaxMicros: M(360), estimateMicros: M(2284.14) },
  clients: [
    { orgId: "a", name: "Brightside Realty (sample)", receivedMicros: M(1798), refundedMicros: M(100), usageChargedMicros: M(130), providerCostMicros: M(100), paymentFeesMicros: M(20), directCostsMicros: M(20), contributionMicros: M(1688) },
    { orgId: "b", name: "Sunrise Dental (sample)", receivedMicros: M(1499), refundedMicros: 0, usageChargedMicros: M(130), providerCostMicros: M(100), paymentFeesMicros: M(22.86), directCostsMicros: 0, contributionMicros: M(1506.14) },
  ],
  entries: [
    { id: "e1", kind: "overhead", category: "Hosting", description: "Servers and databases (sample)", amountMicros: M(150), periodOn: "2026-10-03", orgId: null, orgName: null, createdAt: hoursAgo(50), voided: false, voidReason: null },
    { id: "e2", kind: "direct_cost", category: "Domain", description: "brightside.example registered in the client's name (sample)", amountMicros: M(20), periodOn: "2026-10-04", orgId: "a", orgName: "Brightside Realty (sample)", createdAt: hoursAgo(40), voided: false, voidReason: null },
    { id: "e3", kind: "overhead", category: "Software", description: "Entered twice (sample)", amountMicros: M(49), periodOn: "2026-10-05", orgId: null, orgName: null, createdAt: hoursAgo(30), voided: true, voidReason: "Duplicate entry" },
  ],
  reconciliationErrors: 0,
  caveats: ["2 payments have no processing fee recorded yet, so fees are understated.", "Some usage could not be collected because credits ran out. It is shown above but is not income until collected."],
};
const SAMPLE_OVERVIEW = { paymongo: { configured: true, webhookConfigured: true, livemode: false, paymentMethods: ["card"], problems: [] }, fx: { usdPhpRate: 56.2, source: "BSP reference rate (sample)", updatedAt: hoursAgo(30) }, liveReviewConfirmedAt: null, markupBps: 13000, totals: {} as never, clients: [], reconciliationErrors: [], unmatchedEvents: [{ id: "u1", eventType: "payment.paid", outcome: "error", detail: "Amount did not match the checkout (sample)", receivedAt: hoursAgo(5) }] } as unknown as AgencyBillingOverview;
const SAMPLE_RATES: UnitRateRow[] = [
  { provider: "ghl", unitType: "sms_segment", label: "SMS segment", wholesaleMicrosPerUnit: 8000, clientMicrosPerUnit: 10400, markupBps: 13000, version: 1, publishedAt: hoursAgo(100) },
  { provider: "ghl", unitType: "email_send", label: "Email send", wholesaleMicrosPerUnit: 1000, clientMicrosPerUnit: 1300, markupBps: 13000, version: 1, publishedAt: hoursAgo(100) },
];

const SAMPLE_OFFBOARDING: OffboardingView = {
  id: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", status: "retention", requestedAt: hoursAgo(24 * 20), requestedByKind: "client", reason: "Closing the clinic at the end of the month.",
  retentionDays: 90, websitePlan: "keep_until_deletion", deleteAfter: daysFromNow(70), exportDownloadedAt: null, billingClosedAt: null, shutdownAt: hoursAgo(24 * 20), creditBalanceMicros: 4_250_000,
  steps: [
    { key: "automation", ok: true, text: "Automation switched off and the emergency stop set." },
    { key: "messaging", ok: true, text: "Queued messages cancelled; none will be sent." },
    { key: "access", ok: true, text: "Staff access removed. The owner can still sign in to download data." },
    { key: "website", ok: false, text: "The website could not be checked. Review it by hand." },
  ],
  timeline: [{ kind: "requested", detail: "Requested by the owner.", at: hoursAgo(24 * 21) }, { kind: "shutdown", detail: "Workspace shut down by the agency.", at: hoursAgo(24 * 20) }],
};
const SAMPLE_REVIEW: ReviewRow = { id: "33333333-3333-4333-8333-333333333333", orgId: "22222222-2222-4222-8222-222222222222", orgName: "Maple Dental (sample)", status: "open", inactiveDays: 214, noticesSent: 2, openedAt: hoursAgo(24 * 12), closedAt: null, closedNote: null };
const SAMPLE_FLEET: FleetRow[] = [
  { orgId: "22222222-2222-4222-8222-222222222222", name: "Maple Dental (sample)", metrics: [{ metric: "storage_bytes", valueText: "1.2 GB", state: "warning" }, { metric: "site_requests_30d", valueText: "48,210", state: "unset" }, { metric: "ai_runs_30d", valueText: "932", state: "ok" }] },
  { orgId: "44444444-4444-4444-8444-444444444444", name: "Harbour Realty (sample)", metrics: [{ metric: "storage_bytes", valueText: "3.9 GB", state: "over" }, { metric: "stored_messages", valueText: "12,044", state: "unset" }] },
];
const SAMPLE_POLICIES: PolicyRow[] = [
  { id: "p1", orgId: null, orgName: null, metric: "storage_bytes", label: "File storage", warn: 1 * 1024 ** 3, limit: 2 * 1024 ** 3, enforcement: "report_only", note: "Based on the sample storage price" },
  { id: "p2", orgId: "44444444-4444-4444-8444-444444444444", orgName: "Harbour Realty (sample)", metric: "storage_bytes", label: "File storage", warn: null, limit: 4 * 1024 ** 3, enforcement: "block_new", note: null },
];
const SAMPLE_FAIR_USE: FairUseRow[] = [
  { metric: "storage_bytes", label: "File storage", window: "now", explain: "Documents, images, attachments and website pictures kept for your workspace.", value: 1.2 * 1024 ** 3, valueText: "1.2 GB", state: "warning", warn: 1024 ** 3, limit: 2 * 1024 ** 3, limitText: "2.0 GB", enforcement: "report_only", measuredAt: hoursAgo(1) },
  { metric: "site_requests_30d", label: "Website requests", window: "last 30 days", explain: "Page and file requests to your hosted website.", value: 48210, valueText: "48,210", state: "unset", warn: null, limit: null, limitText: null, enforcement: "report_only", measuredAt: hoursAgo(1) },
  { metric: "ai_runs_30d", label: "AI employee runs", window: "last 30 days", explain: "Conversations and tasks your AI employees ran.", value: 932, valueText: "932", state: "ok", warn: 5000, limit: 10000, limitText: "10,000", enforcement: "report_only", measuredAt: hoursAgo(1) },
];

export default async function OperationsPreview({ searchParams }: { searchParams: Promise<{ view?: string; expired?: string; tab?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(q.view ?? "") ? (q.view as View) : "incidents";
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <PreviewTheme />
      <div role="note" className="rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-2.5 text-[12.5px] text-muted">
        Design preview with <strong>sample data</strong>. Nothing here is real, saved or sent. Views: <span className="inline-flex flex-wrap gap-x-3">{VIEWS.map((v) => <a key={v} href={`?view=${v}`} className="font-medium text-primary underline">{v}</a>)}</span>
      </div>
      {view === "incidents" && <IncidentsPanel incidents={SAMPLE_INCIDENTS} timeZone="UTC" canManage />}
      {view === "notices" && <ServiceNotices incidents={SAMPLE_INCIDENTS.filter((i) => i.clientVisible)} />}
      {view === "appointments" && (
        <AppointmentsView
          appointments={SAMPLE_APPTS}
          timeZone="Asia/Manila"
          lastSync={hoursAgo(1)}
          canRefresh={false}
          setterReady
          pending={SAMPLE_PENDING}
          policy={q.expired ? { ...SAMPLE_POLICY, remindersAuthorization: "expired" } : SAMPLE_POLICY}
          canBook
          canManage
          canGoAutonomous
        />
      )}
      {view === "finance" && <FinanceWorkspace report={SAMPLE_REPORT} overview={SAMPLE_OVERVIEW} rates={SAMPLE_RATES} canManage tab={(["statement", "entries", "rates", "clients"].includes(q.tab ?? "") ? q.tab : "statement") as "statement"} period="this_month" />}
      {view === "offboarding" && <OffboardingPanel orgId={SAMPLE_OFFBOARDING.orgId} orgName="Maple Dental (sample)" view={SAMPLE_OFFBOARDING} review={SAMPLE_REVIEW} purgeEnabled={false} canManage />}
      {view === "yourdata" && <DataPanel orgName="Maple Dental (sample)" view={q.tab === "none" ? null : SAMPLE_OFFBOARDING} canRequest canExport />}
      {view === "fairuse" && (
        <div className="space-y-10">
          <FairUseCard rows={SAMPLE_FAIR_USE} />
          <FairUseAdmin fleet={SAMPLE_FLEET} policies={SAMPLE_POLICIES} reviews={[SAMPLE_REVIEW]} clients={SAMPLE_FLEET.map((f) => ({ id: f.orgId, name: f.name }))} canManage />
        </div>
      )}
      {view === "retention" && <RetentionAutomation programs={SAMPLE_PROGRAMS} lifecycle={SAMPLE_LIFECYCLE} activity={SAMPLE_ACTIVITY} canEdit canActivate canEditContacts />}
      {view === "notifications" && (
        <NotificationPrefsForm
          groups={NOTIFICATION_GROUPS.map(({ key, label, description }) => ({ key, label, description }))}
          prefs={{ groups: Object.fromEntries(NOTIFICATION_GROUPS.map((g) => [g.key, true])), setupEmails: false, email: "important", proactive: DEFAULT_PROACTIVE_PREFS }}
          emailAvailable
        />
      )}
    </div>
  );
}
