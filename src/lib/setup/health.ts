// Agency fleet health. A Native CRM workspace is not "disconnected" just because it has no GoHighLevel location:
// its own CRM records or an activated setup are the evidence that it is configured. GoHighLevel workspaces keep the
// previous rule (a verified location plus calendar and n8n) so existing clients read the same as before.
import type { CrmMode } from "@/lib/crm/types";

export type FleetHealthLevel = "healthy" | "partial" | "not_connected" | "issue";

export interface FleetHealthFacts {
  agentsOnline: number;
  agentsEnabled: number;
  failedChecks: number;
  failingAgents: number;
  ghl: string | null;
  calendar: string | null;
  n8n: string | null;
  /** Null means the workspace has no CRM settings row yet, which reads as iAcquire CRM. */
  crmMode: CrmMode | null;
  setupState: string | null;
  /** Contacts, native pipelines and active native calendars that prove the CRM has real data. */
  nativeRecords: number;
}

const unhealthy = (status: string | null) => ["error", "disconnected", "needs_attention", "failed"].includes(status ?? "");

export function fleetHealth(facts: FleetHealthFacts): FleetHealthLevel {
  const externalReady = facts.ghl === "connected" && facts.calendar === "connected" && facts.n8n === "connected";
  const nativeReady = facts.setupState === "activated" || facts.nativeRecords > 0;
  const agentsReady = facts.agentsEnabled > 0 && facts.agentsOnline === facts.agentsEnabled;
  const failing = facts.failedChecks > 0 || facts.failingAgents > 0 || unhealthy(facts.ghl) || unhealthy(facts.calendar) || unhealthy(facts.n8n);
  if (failing) return "issue";
  const mode = facts.crmMode ?? "native";
  const ready = mode === "native" ? nativeReady : mode === "hybrid" ? nativeReady || externalReady : externalReady;
  if (ready && agentsReady) return "healthy";
  if (facts.agentsOnline === 0 && !nativeReady && !externalReady) return "not_connected";
  return "partial";
}
