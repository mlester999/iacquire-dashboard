/** A completed job that only produced work waiting on a decision or delivery. */
export function isPreparedOnlyWork(
  status: string,
  evidence: { class?: string } | null | undefined,
  capability?: string,
): boolean {
  // A CRM import is the persisted action itself. Other approved writes, such as queued follow-up drafts, are still waiting for delivery.
  if (capability === "crm_lead_import") return false;
  return status === "completed" && (evidence?.class === "proposed_change" || evidence?.class === "approved_write");
}

/** Keep the completed filter and KPI aligned with the board's Completed lane. */
export function isCompletedWork(
  status: string,
  evidence: { class?: string } | null | undefined,
  capability?: string,
): boolean {
  return status === "completed" && !isPreparedOnlyWork(status, evidence, capability);
}
