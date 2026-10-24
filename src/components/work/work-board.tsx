"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Activity, AlertTriangle, CalendarClock, CheckCircle2, ListChecks, Loader2, Play, ShieldCheck, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { Switch } from "@/components/ui/overlays";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { Panel } from "@/components/overview/panel";
import { ProactiveWatch } from "@/components/work/proactive-reports";
import { WorkBoardKanban } from "@/components/work/work-board-kanban";
import { deleteScheduleAction, deleteTriggerAction, saveScheduleAction, saveTriggerAction, setScheduleEnabledAction, setTriggerEnabledAction, startReviewAction } from "@/app/actions/work";
import { TRIGGER_EVENT_LABELS, TRIGGER_EVENT_TYPES } from "@/lib/workforce-triggers";
import type { BusinessHours, Weekday } from "@/lib/messaging";
import { formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
import type { AgentRoleKey } from "@/lib/agents";
import type { ScheduleView } from "@/server/workforce/schedules";
import type { TriggerView } from "@/server/workforce/triggers";
import type { MonitoringStatus, ProactiveReportView } from "@/server/workforce/reports";
import type { WorkBoardCapabilityAction } from "@/lib/workforce-capabilities";
import type { WorkBoardJob, WorkBoardSummary, WorkBoardFilter } from "@/server/workforce/work-board";

const DAY_LABEL: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const WEEKDAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function WorkBoard({
  jobs,
  summary,
  filter,
  reviewActions,
  schedules,
  canManageSchedules,
  scheduleOperatorEnabled,
  triggers,
  canManageTriggers,
  triggerOperatorEnabled,
  timeZone,
  focusJobId,
  reports = [],
  monitoring = null,
  focusReportId = null,
  scheduleActions,
  employeeNames,
  referenceTime,
}: {
  jobs: WorkBoardJob[];
  summary: WorkBoardSummary;
  filter: WorkBoardFilter;
  reviewActions: WorkBoardCapabilityAction[];
  /** Capabilities that may be scheduled. Includes Lead Hunter research, which is not startable from the review selector. */
  scheduleActions?: WorkBoardCapabilityAction[];
  schedules: ScheduleView[];
  canManageSchedules: boolean;
  scheduleOperatorEnabled: boolean;
  triggers: TriggerView[];
  canManageTriggers: boolean;
  triggerOperatorEnabled: boolean;
  timeZone: string;
  focusJobId: string | null;
  reports?: ProactiveReportView[];
  monitoring?: MonitoringStatus | null;
  focusReportId?: string | null;
  employeeNames?: Partial<Record<AgentRoleKey, string>>;
  referenceTime: string;
}) {
  const router = useRouter();
  const [starting, setStarting] = React.useState(false);
  const [selectedCapability, setSelectedCapability] = React.useState<string>(() => {
    return reviewActions.find((action) => action.available)?.capability ?? reviewActions[0]?.capability ?? "";
  });
  const selected = reviewActions.find((action) => action.capability === selectedCapability) ?? reviewActions[0] ?? null;
  const scheduleOptions = scheduleActions ?? reviewActions;
  const [scheduleCapability, setScheduleCapability] = React.useState<string>(() => scheduleOptions.find((action) => action.capability !== "lead_research")?.capability ?? scheduleOptions[0]?.capability ?? "");
  const [leadResearchPrompt, setLeadResearchPrompt] = React.useState("");
  const [scheduleCadence, setScheduleCadence] = React.useState<"hourly" | "daily" | "weekly">("daily");
  const [restrictHours, setRestrictHours] = React.useState(false);
  const [businessStart, setBusinessStart] = React.useState("09:00");
  const [businessEnd, setBusinessEnd] = React.useState("17:00");
  const [businessDays, setBusinessDays] = React.useState<Weekday[]>(["mon", "tue", "wed", "thu", "fri"]);
  const [scheduleBusy, setScheduleBusy] = React.useState<string | null>(null);
  const businessHours: BusinessHours = restrictHours && businessDays.length
    ? Object.fromEntries(businessDays.map((day) => [day, [[businessStart, businessEnd]]])) as BusinessHours
    : {};
  const businessHoursValid = !restrictHours || (businessDays.length > 0 && businessStart < businessEnd);
  const selectedScheduleAction = scheduleOptions.find((action) => action.capability === scheduleCapability) ?? scheduleOptions[0] ?? null;
  const schedulingLeadResearch = selectedScheduleAction?.capability === "lead_research";
  const schedulePayload = schedulingLeadResearch ? { prompt: leadResearchPrompt.trim() } : undefined;
  const schedulePayloadValid = !schedulingLeadResearch || leadResearchPrompt.trim().length >= 10;

  const saveSchedule = async () => {
    if (!scheduleCapability || scheduleBusy) return;
    if (!businessHoursValid) return toast.error("Choose at least one day and an end time after the start time.");
    if (!schedulePayloadValid) return toast.error("Describe who to research, where and how many. The schedule runs only that assignment.");
    setScheduleBusy("save");
    const res = await saveScheduleAction(scheduleCapability, scheduleCadence, businessHours, schedulePayload);
    setScheduleBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Schedule saved paused", { description: "Enable it when you are ready. It still only runs when the operator switch is on." });
    router.refresh();
  };

  const toggleSchedule = async (id: string, enabled: boolean) => {
    if (scheduleBusy) return;
    setScheduleBusy(id);
    const res = await setScheduleEnabledAction(id, enabled);
    setScheduleBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(enabled ? "Schedule enabled" : "Schedule paused", {
      description: enabled && !scheduleOperatorEnabled
        ? "It will not run until the operator enables AI workforce schedules."
        : "The change is recorded in the audit trail.",
    });
    router.refresh();
  };

  const removeSchedule = async (id: string) => {
    if (scheduleBusy) return;
    if (typeof window !== "undefined" && !window.confirm("Delete this schedule? It will stop creating new reviews. Existing jobs and evidence are kept.")) return;
    setScheduleBusy(id);
    const res = await deleteScheduleAction(id);
    setScheduleBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Schedule deleted");
    router.refresh();
  };

  const [triggerEvent, setTriggerEvent] = React.useState<string>(() => TRIGGER_EVENT_TYPES[0] ?? "");
  const [triggerBusy, setTriggerBusy] = React.useState<string | null>(null);

  const saveTrigger = async () => {
    if (!triggerEvent || triggerBusy) return;
    setTriggerBusy("save");
    const res = await saveTriggerAction(triggerEvent);
    setTriggerBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Event trigger saved paused", { description: "Enable it when you are ready. It still only runs when the operator switch is on." });
    router.refresh();
  };

  const toggleTrigger = async (id: string, enabled: boolean) => {
    if (triggerBusy) return;
    setTriggerBusy(id);
    const res = await setTriggerEnabledAction(id, enabled);
    setTriggerBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(enabled ? "Event trigger enabled" : "Event trigger paused", {
      description: enabled && !triggerOperatorEnabled
        ? "It will not run until the operator enables AI workforce triggers."
        : "The change is recorded in the audit trail.",
    });
    router.refresh();
  };

  const removeTrigger = async (id: string) => {
    if (triggerBusy) return;
    if (typeof window !== "undefined" && !window.confirm("Delete this event trigger? Existing jobs and evidence are kept.")) return;
    setTriggerBusy(id);
    const res = await deleteTriggerAction(id);
    setTriggerBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Event trigger deleted");
    router.refresh();
  };

  const startReview = async () => {
    if (!selected?.available || starting) return;
    setStarting(true);
    const res = await startReviewAction(selected.capability);
    setStarting(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${selected.label} started`, { description: "The employee reads only persisted records and records its findings. No record is changed." });
    router.refresh();
  };

  return (
    <div className="module-stack space-y-6">
      <PageHero
        tone="dark"
        eyebrow="AI Work Board"
        title="See the work, not a spinner."
        description="Persisted jobs keep their recorded status, stage and activity. Future schedule occurrences stay separate as plans, never jobs; nothing is marked completed without execution evidence."
        icon={<ListChecks />}
        aside={
          <div className="space-y-2">
            {reviewActions.length > 0 ? (
              <>
                <label htmlFor="work-review" className="block text-[11.5px] font-semibold uppercase tracking-[.08em] text-muted">Review to run</label>
                <Select id="work-review" value={selected?.capability ?? ""} onChange={(event) => setSelectedCapability(event.target.value)} className="min-w-[16rem]">
                  {reviewActions.map((action) => (
                    <option key={action.capability} value={action.capability}>{action.label} · {action.employeeName}</option>
                  ))}
                </Select>
                <Button variant="brand" onClick={startReview} loading={starting} disabled={!selected?.available || starting}>
                  {starting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
                  Start review
                </Button>
                <p className="max-w-[28rem] text-[12px] leading-relaxed text-muted">
                  {selected?.reason ?? selected?.description ?? "Choose a read-only review to run."} It does not change records, contact a provider or create a schedule.
                </p>
              </>
            ) : (
              <p className="max-w-[28rem] text-[12px] leading-relaxed text-muted">No reviewed review capability is available for your role in this workspace.</p>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Running now" value={summary.active} detail="Jobs with an active worker lease" icon={<Activity />} tone="violet" />
        <MetricCard label="Waiting for approval" value={summary.waiting} detail="A person must decide" icon={<ShieldCheck />} tone="amber" />
        <MetricCard label="Needs attention" value={summary.needsAttention} detail="Failed, blocked or awaiting recovery" icon={<AlertTriangle />} tone="amber" />
        <MetricCard label="Completed today" value={summary.completedToday} detail="In this workspace's time zone" icon={<CheckCircle2 />} tone="green" />
      </div>

      {monitoring && (
        <ProactiveWatch
          reports={reports}
          monitoring={monitoring}
          timeZone={timeZone}
          focusReportId={focusReportId}
          canManageSchedules={canManageSchedules}
        />
      )}

      <WorkBoardKanban
        jobs={jobs}
        schedules={schedules}
        filter={filter}
        scheduleOperatorEnabled={scheduleOperatorEnabled}
        timeZone={timeZone}
        focusJobId={focusJobId}
        employeeNames={employeeNames}
        referenceTime={referenceTime}
      />

      {canManageSchedules && (
        <div id="scheduled-work" className="scroll-mt-24">
        <Panel
          icon={<CalendarClock />}
          tone="neutral"
          title="Scheduled work"
          description="A read-only review or one explicitly approved Lead Hunter research assignment. It only runs when both the row and the operator switch are enabled."
          action={
            <StatusPill tone={scheduleOperatorEnabled ? "success" : "warning"} size="sm">
              {scheduleOperatorEnabled ? "Operator switch on" : "Operator switch off"}
            </StatusPill>
          }
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="block min-w-[15rem] flex-1 text-[12px] font-medium text-ink-2">
                Work
                <Select className="mt-1" value={scheduleCapability} onChange={(event) => setScheduleCapability(event.target.value)} disabled={!scheduleOptions.length}>
                  {scheduleOptions.map((action) => (
                    <option key={action.capability} value={action.capability}>{action.label} · {action.employeeName}</option>
                  ))}
                </Select>
              </label>
              <label className="block text-[12px] font-medium text-ink-2">
                Cadence
                <Select className="mt-1" value={scheduleCadence} onChange={(event) => setScheduleCadence(event.target.value as "hourly" | "daily" | "weekly")}>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </Select>
              </label>
              <Button variant="secondary" onClick={saveSchedule} loading={scheduleBusy === "save"} disabled={!scheduleCapability || scheduleBusy !== null || !businessHoursValid || !schedulePayloadValid || Boolean(selectedScheduleAction && !selectedScheduleAction.available)}>
                Save paused schedule
              </Button>
            </div>
            {schedulingLeadResearch && (
              <div className="rounded-xl border border-line bg-surface-2/30 p-3">
                <label className="block text-[12px] font-medium text-ink-2" htmlFor="lead-research-assignment">
                  Approved research assignment
                </label>
                <Textarea
                  id="lead-research-assignment"
                  className="mt-1"
                  rows={2}
                  value={leadResearchPrompt}
                  onChange={(event) => setLeadResearchPrompt(event.target.value)}
                  placeholder="Find 20 independent dental clinics in Singapore"
                  aria-describedby="lead-research-assignment-hint"
                />
                <p id="lead-research-assignment-hint" className="mt-1 text-[11.5px] leading-relaxed text-muted">
                  The Lead Hunter will run exactly this assignment on the cadence, using public sources and the existing research gate. It never contacts a prospect. The schedule is saved paused, and the operator switch and the Lead Hunter&apos;s readiness are still required.
                </p>
                {!selectedScheduleAction?.available && <p className="mt-1 text-[11.5px] text-warning-ink">{selectedScheduleAction?.reason}</p>}
              </div>
            )}
            <div className="rounded-xl border border-line bg-surface-2/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                  <Switch checked={restrictHours} aria-label="Only run during business hours" onCheckedChange={setRestrictHours} />
                  Only run during business hours
                </label>
                <span className="text-[11px] text-muted">Evaluated in {timeZone}</span>
              </div>
              {restrictHours && (
                <div className="mt-3 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="font-medium text-ink-2">From</span>
                    <input type="time" aria-label="Business hours start" value={businessStart} onChange={(event) => setBusinessStart(event.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px]" />
                    <span className="font-medium text-ink-2">to</span>
                    <input type="time" aria-label="Business hours end" value={businessEnd} onChange={(event) => setBusinessEnd(event.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px]" />
                  </div>
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Business days">
                    {WEEKDAY_ORDER.map((day) => {
                      const active = businessDays.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setBusinessDays((current) => active ? current.filter((item) => item !== day) : [...current, day])}
                          className={active ? "min-h-8 rounded-lg bg-primary-soft px-2.5 text-[11.5px] font-semibold text-primary-ink ring-1 ring-inset ring-primary/20" : "min-h-8 rounded-lg border border-line px-2.5 text-[11.5px] font-medium text-muted hover:bg-surface-2"}
                        >
                          {DAY_LABEL[day]}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">Outside these hours a due schedule is postponed to the next opening; it does not create a job in the middle of the night.</p>
                </div>
              )}
            </div>
            {!scheduleOperatorEnabled && (
              <p role="status" className="rounded-xl border border-warning/25 bg-warning-soft/40 px-3 py-2 text-[12px] leading-relaxed text-warning-ink">
                The operator switch is off (<code className="font-mono text-[11px]">WORKFORCE_SCHEDULES_ENABLED</code>), so no schedule creates work even when its row is enabled. This is deliberate.
              </p>
            )}
            {schedules.length === 0 ? (
              <p className="text-[12.5px] text-muted">No schedules yet. Saving one is always paused first.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {schedules.map((schedule) => (
                  <li key={schedule.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    <Switch
                      checked={schedule.enabled}
                      disabled={scheduleBusy !== null}
                      onCheckedChange={(next) => toggleSchedule(schedule.id, next)}
                      aria-label={`${schedule.enabled ? "Pause" : "Enable"} ${schedule.capabilityLabel} schedule`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-semibold text-ink">{schedule.capabilityLabel} · {schedule.employeeName}</p>
                      {schedule.payload.prompt && <p className="mt-0.5 truncate text-[11.5px] text-ink-2" title={schedule.payload.prompt}>{schedule.payload.prompt}</p>}
                      <p className="mt-0.5 text-[11.5px] text-muted" suppressHydrationWarning>
                        {sentenceCase(schedule.cadence)} · next {formatDateTime(schedule.nextRunAt, timeZone)}
                        {schedule.lastRunAt ? ` · last ran ${relativeTime(schedule.lastRunAt)}` : " · not run yet"}
                        {Object.keys(schedule.businessHours).length ? " · business hours only" : " · any time"}
                        {schedule.lastSkippedReason === "outside_business_hours" ? " · waiting for opening" : ""}
                        {schedule.enabled && !scheduleOperatorEnabled ? " · paused by operator" : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSchedule(schedule.id)}
                      disabled={scheduleBusy !== null}
                      className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink disabled:opacity-50"
                      aria-label={`Delete ${schedule.capabilityLabel} schedule`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
        </div>
      )}

      {canManageTriggers && (
        <Panel
          icon={<Zap />}
          tone="neutral"
          title="Event triggers"
          description="A reviewed exceptional event can start one read-only review. It only runs when both the row and the operator switch are enabled."
          action={
            <StatusPill tone={triggerOperatorEnabled ? "success" : "warning"} size="sm">
              {triggerOperatorEnabled ? "Operator switch on" : "Operator switch off"}
            </StatusPill>
          }
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="block min-w-[15rem] flex-1 text-[12px] font-medium text-ink-2">
                Event
                <Select className="mt-1" value={triggerEvent} onChange={(event) => setTriggerEvent(event.target.value)} disabled={!TRIGGER_EVENT_TYPES.length}>
                  {TRIGGER_EVENT_TYPES.map((eventType) => (
                    <option key={eventType} value={eventType}>{TRIGGER_EVENT_LABELS[eventType] ?? eventType}</option>
                  ))}
                </Select>
              </label>
              <Button variant="secondary" onClick={saveTrigger} loading={triggerBusy === "save"} disabled={!triggerEvent || triggerBusy !== null}>
                Save paused trigger
              </Button>
            </div>
            {!triggerOperatorEnabled && (
              <p role="status" className="rounded-xl border border-warning/25 bg-warning-soft/40 px-3 py-2 text-[12px] leading-relaxed text-warning-ink">
                The operator switch is off (<code className="font-mono text-[11px]">WORKFORCE_TRIGGERS_ENABLED</code>), so no event creates work even when its trigger is enabled. This is deliberate.
              </p>
            )}
            {triggers.length === 0 ? (
              <p className="text-[12.5px] text-muted">No event triggers yet. Saving one is always paused first.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {triggers.map((trigger) => (
                  <li key={trigger.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    <Switch
                      checked={trigger.enabled}
                      disabled={triggerBusy !== null}
                      onCheckedChange={(next) => toggleTrigger(trigger.id, next)}
                      aria-label={`${trigger.enabled ? "Pause" : "Enable"} ${TRIGGER_EVENT_LABELS[trigger.eventType] ?? trigger.eventType} trigger`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-semibold text-ink">{TRIGGER_EVENT_LABELS[trigger.eventType] ?? trigger.eventType}</p>
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        {trigger.capabilityLabel} · {trigger.employeeName} · last event #{trigger.lastEventId}
                        {trigger.enabled && !triggerOperatorEnabled ? " · paused by operator" : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeTrigger(trigger.id)}
                      disabled={triggerBusy !== null}
                      className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink disabled:opacity-50"
                      aria-label={`Delete ${TRIGGER_EVENT_LABELS[trigger.eventType] ?? trigger.eventType} trigger`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      )}

    </div>
  );
}
