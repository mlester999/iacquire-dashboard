import "server-only";
import { env } from "@/server/env";

export interface N8nStatus {
  configured: boolean;
  reachable: boolean | null;
  detail: string;
  appointmentProcessor: { found: boolean; active: boolean | null; name: string | null } | null;
}

const PROCESSOR_NAME = /iacquire.*appointment.*event.*processor/i;

/**
 * Read-only n8n status. Uses the public /healthz probe and, when an API key is configured, the
 * public API's workflow list to report whether the appointment processor exists and is active.
 * This module never activates, edits or executes workflows.
 */
export async function getN8nStatus(): Promise<N8nStatus> {
  const e = env();
  if (!e.N8N_BASE_URL) {
    return { configured: false, reachable: null, detail: "N8N_BASE_URL is not configured.", appointmentProcessor: null };
  }
  const base = e.N8N_BASE_URL.replace(/\/+$/, "");
  let reachable = false;
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(6000), cache: "no-store", redirect: "error" });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) return { configured: true, reachable: false, detail: "n8n health probe failed.", appointmentProcessor: null };
  if (!e.N8N_API_KEY) {
    return { configured: true, reachable: true, detail: "Reachable. Add a read-only N8N_API_KEY to report workflow state.", appointmentProcessor: null };
  }
  try {
    const res = await fetch(`${base}/api/v1/workflows?limit=250`, {
      headers: { "X-N8N-API-KEY": e.N8N_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "error",
    });
    if (!res.ok) return { configured: true, reachable: true, detail: `Workflow API returned ${res.status}.`, appointmentProcessor: null };
    const json = (await res.json()) as { data?: Array<{ name?: string; active?: boolean }> };
    const wf = (json.data ?? []).find((w) => PROCESSOR_NAME.test(w.name ?? ""));
    return {
      configured: true,
      reachable: true,
      detail: wf ? `Appointment processor found (${wf.active ? "active" : "inactive"}).` : "Appointment processor not found in n8n.",
      appointmentProcessor: { found: Boolean(wf), active: wf ? Boolean(wf.active) : null, name: wf?.name ?? null },
    };
  } catch {
    return { configured: true, reachable: true, detail: "Workflow API request failed.", appointmentProcessor: null };
  }
}
