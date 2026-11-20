const SKIP_REASON_COPY: Record<string, string> = {
  invalid_recurrence_rule: "Paused because the saved recurrence rule is invalid.",
  invalid_schedule_timezone: "Paused because the schedule time zone is invalid.",
  outside_business_hours: "Moved to the next allowed business-hours window.",
  previous_job_active: "Skipped because the previous scheduled job is still running.",
  employee_unavailable: "Skipped because the Growth Partner is not available for scheduled work.",
  automation_org_inactive: "Skipped because this workspace is inactive.",
  automation_agency_paused: "Skipped because iAcquire has paused automation for this workspace.",
  automation_agent_paused: "Skipped because the Growth Partner is paused.",
  automation_agent_disabled: "Skipped because the Growth Partner is disabled for this workspace.",
  automation_agent_not_ready: "Skipped because the Growth Partner has not passed its connection check.",
  automation_agent_missing: "Skipped because no Growth Partner is assigned to this workspace.",
  automation_messaging_paused: "Skipped because messaging automation is paused.",
  automation_outbound_paused: "Skipped because outbound automation is paused.",
  invalid_research_assignment: "Skipped because the saved research assignment is incomplete.",
  research_rate_limited: "Skipped because the workspace reached its research limit.",
  consecutive_failures: "Paused after three consecutive scheduled jobs failed or were blocked.",
};

/** Converts every persisted schedule skip code to copy suitable for the Work Board and calendar. */
export function workforceScheduleSkipReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return SKIP_REASON_COPY[reason] ?? "Skipped because a required schedule check did not pass.";
}
