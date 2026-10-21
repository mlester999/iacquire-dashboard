/** Accurate capability boundary for the internal iAcquire Operations Manager profile. */
export const INTERNAL_OPERATIONS_MANAGER_RUNTIME_NOTICE =
  "When authorized and ready, each internal Operations Manager chat run receives a tenant-scoped, read-only snapshot of agency tasks, pending approvals, blocked approvals and persisted employee run activity. It can draft a grounded summary from that snapshot. This is not a callable Hermes tool: it cannot refresh records mid-run, create or decide approvals, change tasks, send messages or save summaries.";

export function operationsManagerRuntimeNotice(roleKey: string, orgKind: string): string | null {
  return roleKey === "operations_manager" && orgKind === "agency"
    ? INTERNAL_OPERATIONS_MANAGER_RUNTIME_NOTICE
    : null;
}
