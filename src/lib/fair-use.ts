// Fair use: what is measured for each workspace, how a measurement is judged against a threshold, and how it is described to people.
// No limit is shipped. A threshold with no value is "unset", and says so, until the agency has measured real provider costs.

export const FAIR_USE_METRICS = ["storage_bytes", "site_bandwidth_bytes_30d", "site_requests_30d", "ai_runs_30d", "research_calls_30d", "stored_messages"] as const;
export type FairUseMetric = (typeof FAIR_USE_METRICS)[number];
export type FairUseState = "unset" | "ok" | "warning" | "over";

interface MetricInfo {
  label: string;
  unit: "bytes" | "count";
  window: string;
  /** What it covers, and what the agency can do when it is exceeded, in the client's words. */
  explain: string;
  /** Only new storage can ever be blocked. Everything else is measured and reported, never switched off. */
  canBlock: boolean;
}

export const METRIC_INFO: Record<FairUseMetric, MetricInfo> = {
  storage_bytes: { label: "File storage", unit: "bytes", window: "now", explain: "Documents, images, attachments and website pictures kept for your workspace.", canBlock: true },
  site_bandwidth_bytes_30d: { label: "Website bandwidth", unit: "bytes", window: "last 30 days", explain: "Data sent to visitors of your hosted website. Your site is never taken offline for this; if it runs high we talk to you first.", canBlock: false },
  site_requests_30d: { label: "Website requests", unit: "count", window: "last 30 days", explain: "Page and file requests to your hosted website.", canBlock: false },
  ai_runs_30d: { label: "AI employee runs", unit: "count", window: "last 30 days", explain: "Conversations and tasks your AI employees ran. Messaging and model usage are charged separately from your credits.", canBlock: false },
  research_calls_30d: { label: "Lead research requests", unit: "count", window: "last 30 days", explain: "Research requests your Lead Hunter made.", canBlock: false },
  stored_messages: { label: "Stored messages", unit: "count", window: "now", explain: "Customer messages kept in your inbox. Nothing is deleted automatically.", canBlock: false },
};

export const metricLabel = (m: FairUseMetric) => METRIC_INFO[m].label;

export function formatMetricValue(metric: FairUseMetric, value: number): string {
  if (METRIC_INFO[metric].unit === "count") return value.toLocaleString("en-US");
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Judges one measurement. "over" means at or above the limit; "warning" means at or above the warning level (or at 80% of a limit that has
 * no separate warning level). With neither number set the answer is "unset": the platform is honest that nothing is limited yet.
 */
export function evaluateFairUse(value: number, warn: number | null, limit: number | null): FairUseState {
  if (warn === null && limit === null) return "unset";
  if (limit !== null && value >= limit) return "over";
  const warnAt = warn ?? (limit !== null ? Math.floor(limit * 0.8) : null);
  if (warnAt !== null && value >= warnAt) return "warning";
  return "ok";
}

export const STATE_LABEL: Record<FairUseState, string> = { unset: "No limit set", ok: "Within allowance", warning: "Approaching allowance", over: "Over allowance" };
