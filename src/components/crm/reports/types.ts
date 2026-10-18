// The shape of a computed CRM report, as the server returns it and the screen renders it. Every number is a count or a sum of real rows in
// this workspace; nothing here is estimated. Money is always kept per currency.
import type { FilterKey, ReportFilters, ReportSection } from "@/components/crm/reports/spec";

export interface Money {
  currency: string;
  value: number;
}

export interface LabelledCount {
  key: string;
  label: string;
  count: number;
}

export interface DayCount {
  day: string;
  n: number;
}

export interface LeadsReport {
  newContacts: number;
  /** Of the contacts created in the period, how many are qualified or customers now. */
  qualifiedNow: number;
  byDay: DayCount[];
  byCreatedVia: Array<LabelledCount & { qualified: number }>;
  /** The free-text lead source on each contact (top 15). */
  bySource: LabelledCount[];
  /** The current lead status of the contacts created in the period. */
  byStatus: LabelledCount[];
  forms: {
    total: number;
    rows: Array<{ key: string; name: string; kind: "native" | "website"; total: number; processed: number; spam: number; failed: number; pending: number; contacts: number; opportunities: number | null }>;
    /** UTM values that were actually present on a submission. Submissions without any are counted as "No UTM recorded". */
    utm: Array<{ source: string; medium: string; campaign: string; count: number }>;
    /** Form submissions aren't tied to a team member or lead source, so those filters don't narrow them. */
    unfiltered: FilterKey[];
  };
}

export interface AppointmentRow {
  key: string;
  label: string;
  scheduled: number;
  completed: number;
  noShows: number;
  cancelled: number;
  upcoming: number;
  unmarked: number;
}

export interface AppointmentsReport {
  /** Appointments created (booked) during the period, whenever they take place. */
  booked: number;
  bookedVia: LabelledCount[];
  /** Appointments whose start time falls in the period, by what happened. */
  scheduled: number;
  completed: number;
  noShows: number;
  cancelled: number;
  upcoming: number;
  /** Start time has passed but nobody recorded whether it happened. */
  unmarked: number;
  lateCancellations: number;
  /** completed ÷ (completed + no-shows), or null when neither happened. */
  showRate: number | null;
  byType: AppointmentRow[];
  byCalendar: AppointmentRow[];
  byHost: AppointmentRow[];
  byBookedVia: AppointmentRow[];
}

export interface DealsReport {
  created: number;
  won: number;
  lost: number;
  /** won ÷ (won + lost) as a percentage with one decimal, or null. */
  winRate: number | null;
  wonValue: Money[];
  lostValue: Money[];
  createdValue: Money[];
  openNow: number;
  openValueNow: Money[];
  wonWithoutValue: number;
  byOwner: Array<{ key: string; label: string; created: number; won: number; lost: number; wonValue: Money[] }>;
  byCreatedVia: Array<{ key: string; label: string; created: number; won: number }>;
  lostReasons: LabelledCount[];
}

export interface PipelineReport {
  pipelines: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    created: number;
    won: number;
    lost: number;
    winRate: number | null;
    wonValue: Money[];
    openValue: Money[];
    weightedForecast: Money[];
    dealsWithoutProbability: number;
    stages: Array<{ id: string; name: string; kind: "open" | "won" | "lost"; open: number; value: Money[]; probability: number | null; avgDaysInStage: number | null }>;
  }>;
  /** Pipelines beyond the ones shown (only the first few are computed when no pipeline is chosen). */
  more: number;
}

export interface ChannelRow {
  channel: string;
  provider: string;
  received: number;
  sent: number;
  delivered: number;
  failed: number;
  blocked: number;
  pending: number;
}

export interface MessagingReport {
  received: number;
  sent: number;
  delivered: number;
  failed: number;
  blocked: number;
  pending: number;
  byChannel: ChannelRow[];
  /** Provider delivery events reporting a failure or non-delivery during the period. */
  deliveryFailures: Array<{ provider: string; status: string; count: number }>;
  blockedReasons: LabelledCount[];
  byDay: Array<{ day: string; received: number; sent: number }>;
  /** Null when the person can't see campaigns. */
  campaigns: Array<{ id: string; name: string; channel: string; status: string; recipients: number; byStatus: Record<string, number> }> | null;
}

export interface FollowUpsReport {
  started: number;
  activeNow: number;
  completed: number;
  stopped: number;
  replied: number;
  booked: number;
  stoppedBy: LabelledCount[];
  messagesSent: number;
  stepsBlocked: number;
  /** replied ÷ plans closed in the period, or null. */
  replyRate: number | null;
}

export interface WorkloadRow {
  userId: string;
  name: string;
  role: string;
  openTasks: number;
  overdueTasks: number;
  completedTasks: number;
  /** Null when the viewer can't see every conversation. */
  conversations: number | null;
  /** Null when the viewer can't see deals. */
  openDeals: number | null;
  /** Null when the viewer can't see contacts. */
  contacts: number | null;
}

export interface WorkloadReport {
  members: WorkloadRow[];
  unassignedOpenTasks: number;
  unassignedOverdueTasks: number;
}

export interface AiReport {
  toolCalls: number;
  byOutcome: LabelledCount[];
  byTool: LabelledCount[];
  byEmployee: LabelledCount[];
  approvals: { requested: number; approved: number; rejected: number; expired: number; pending: number; executed: number; failed: number; held: number };
  approvalsByKind: LabelledCount[];
}

export interface WorkflowsReport {
  runs: number;
  completed: number;
  failed: number;
  dead: number;
  running: number;
  cancelled: number;
  testRuns: number;
  byWorkflow: Array<{ id: string; name: string; runs: number; completed: number; failed: number; dead: number }>;
  byStatus: LabelledCount[];
}

export interface IntegrationsReport {
  channels: Array<{ channel: string; provider: string; enabled: boolean; state: "ready" | "test_failed" | "not_tested" | "off"; testedAt: string | null; registration: string }>;
  calendarConnections: Array<{ provider: string; status: string; count: number }>;
  voice: Array<{ provider: string; status: string; lastEventAt: string | null }>;
  webhooks: { active: number; disabled: number; failedDeliveries: number; deadDeliveries: number };
  checks: Array<{ provider: string; status: string; checkedAt: string | null }>;
  calendarSyncFailures: number;
}

export interface UsageReport {
  /** All amounts are USD micro-units as billed by the ledger, converted to dollars. */
  currency: "USD";
  charged: number;
  uncollected: number;
  events: number;
  byUnit: Array<{ key: string; label: string; events: number; quantity: number; charged: number; uncollected: number }>;
}

export interface SectionPayloads {
  leads: LeadsReport;
  appointments: AppointmentsReport;
  deals: DealsReport;
  pipeline: PipelineReport;
  messaging: MessagingReport;
  followups: FollowUpsReport;
  workload: WorkloadReport;
  ai: AiReport;
  workflows: WorkflowsReport;
  integrations: IntegrationsReport;
  usage: UsageReport;
}

export interface SectionResult<S extends ReportSection = ReportSection> {
  section: S;
  data: SectionPayloads[S];
  /** True when the section has no rows at all for the period and filters, so the screen says "no data yet". */
  empty: boolean;
  /** Active filters this section does not apply. */
  ignored: FilterKey[];
  /** Plain statements about scope, e.g. a capability GoHighLevel still owns. */
  notes: string[];
}

export interface CrmReport {
  generatedAt: string;
  timezone: string;
  period: { from: string; to: string; days: number; label: string; startsAt: string; endsAt: string; dated: boolean };
  filters: ReportFilters;
  /** Readable names for the filter values in use. */
  filterLabels: Partial<Record<FilterKey, string>>;
  sections: Array<{ [S in ReportSection]: SectionResult<S> }[ReportSection]>;
  /** Sections asked for that this person can't see, and why. */
  hidden: Array<{ section: ReportSection; reason: string }>;
  /** Filters that couldn't be used (an id that isn't in this workspace) and were dropped. */
  notices: string[];
}

export interface ReportOptions {
  members: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string }>;
  campaigns: Array<{ id: string; name: string; channel: string }>;
}

export interface SavedReportView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  report: string;
  config: { filters: ReportFilters; sections: ReportSection[] };
  visibility: "private" | "team";
  pinned: boolean;
  ownerName: string | null;
  mine: boolean;
  /** Whether this person may rename, re-save, pin or archive it. */
  editable: boolean;
  updatedAt: string;
}
