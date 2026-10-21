import type { AqiNavRoute } from "@/lib/aqi/navigation-links";

/**
 * Pages AQi Operations may link to. Deep links to a specific record (a client, a request) come from
 * server tool output and are validated by `isSafeOpsHref`; the model is only ever allowed to use the
 * paths listed here or the links that a tool returned in this turn.
 */
export const OPS_LINKS: AqiNavRoute[] = [
  { path: "/admin/operations", label: "AQi Operations" },
  { path: "/admin", label: "Admin dashboard" },
  { path: "/admin/health", label: "System health" },
  { path: "/admin/clients", label: "Clients" },
  { path: "/admin/employees", label: "Internal Workforce" },
  { path: "/admin/employees/clients", label: "Client Workforces" },
  { path: "/admin/support", label: "Requests" },
  { path: "/admin/support/analytics", label: "Support analytics" },
  { path: "/admin/integrations", label: "Integrations" },
  { path: "/admin/usage", label: "Usage and costs" },
  { path: "/admin/billing", label: "Billing and finance" },
  { path: "/admin/audit", label: "Audit log" },
  { path: "/admin/team", label: "Agency team" },
  { path: "/admin/crm/reports", label: "CRM operations" },
  { path: "/admin/aqi", label: "AQi Management" },
  { path: "/admin/aqi/insights", label: "AQi Insights" },
];

const SAFE_PATH = /^\/(?:admin|employees)(?:\/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9_=&%.-]*)?$/;

/** Only internal admin paths of safe shape can be rendered as links from card data. */
export function isSafeOpsHref(href: unknown): href is string {
  return typeof href === "string" && href.length <= 240 && SAFE_PATH.test(href) && !href.includes("//") && !href.includes("..");
}
