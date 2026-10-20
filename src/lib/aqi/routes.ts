import type { Permission } from "@/lib/permissions";

/**
 * The only routes AQi may describe or offer as navigation. It is intentionally curated: an AI answer
 * can never invent a destination, and the server still checks the signed-in person's permission.
 */
export interface AqiRoute {
  path: string;
  label: string;
  description: string;
  permission?: Permission;
  agency?: "staff" | "super_admin";
}

export const AQI_ROUTES: AqiRoute[] = [
  { path: "/overview", label: "Overview", description: "Your workspace dashboard and current status.", permission: "workspace.view" },
  { path: "/employees", label: "AI Employees", description: "See your AI employees, their status and chat with them.", permission: "agents.use" },
  { path: "/knowledge", label: "Knowledge Center", description: "Company knowledge and reference documents.", permission: "knowledge.view" },
  { path: "/chat", label: "AI employee chat", description: "Conversations with your AI employees.", permission: "agents.use" },
  { path: "/leads", label: "Leads", description: "Leads, research and review queues.", permission: "leads.view" },
  { path: "/appointments", label: "Appointments", description: "Calendar availability and bookings.", permission: "appointments.view" },
  { path: "/sales", label: "Sales", description: "Sales activity and follow-up.", permission: "sales.view" },
  { path: "/crm", label: "CRM", description: "Contacts, companies, pipelines and deals.", permission: "crm.view" },
  { path: "/crm/contacts", label: "Contacts", description: "The people and companies you work with.", permission: "contacts.view" },
  { path: "/crm/pipelines", label: "Pipelines", description: "Deals moving through your sales stages.", permission: "sales.view" },
  { path: "/crm/tasks", label: "CRM Tasks", description: "Follow-ups, assignments and completed work.", permission: "crm.view" },
  { path: "/crm/workflows", label: "Workflows", description: "Automations that run when something happens in the CRM.", permission: "workflows.view" },
  { path: "/crm/calendar", label: "Calendar", description: "Bookings and availability.", permission: "appointments.view" },
  { path: "/inbox", label: "Inbox", description: "Conversations with your contacts.", permission: "inbox.view" },
  { path: "/analytics", label: "Analytics", description: "Workspace reporting and performance.", permission: "analytics.view" },
  { path: "/approvals", label: "Approvals", description: "Actions waiting for a person's decision.", permission: "approvals.view" },
  { path: "/activity", label: "Activity", description: "What has happened in the workspace.", permission: "activity.view" },
  { path: "/settings", label: "Settings", description: "Workspace, account and integration settings.", permission: "workspace.view" },
  { path: "/settings/integrations", label: "Integrations", description: "Connect and review external services.", permission: "integrations.view" },
  { path: "/settings/team", label: "Team", description: "Invite people and manage their roles.", permission: "team.view" },
  { path: "/settings/usage", label: "Usage", description: "Workspace usage and limits.", permission: "usage.view" },
  { path: "/billing", label: "Billing", description: "Plan, payment and usage billing.", permission: "billing.view" },
  { path: "/setup", label: "Setup Center", description: "The work needed to activate the workspace.", permission: "setup.view" },
  { path: "/support", label: "Get Support", description: "Ask the iAcquire team for help.", permission: "support.use" },
  { path: "/support/report-issue", label: "Report an Issue", description: "Tell the iAcquire team about something that isn't working.", permission: "support.use" },
  { path: "/support/feedback", label: "Provide Feedback", description: "Share a suggestion or comment with the iAcquire team.", permission: "support.use" },
  { path: "/support/requests", label: "My Requests", description: "Follow your support requests, issue reports and feedback.", permission: "support.use" },
  { path: "/projects", label: "Projects", description: "Custom projects, quotes and deliverables.", permission: "projects.view" },
  { path: "/website", label: "Website", description: "Your website and publishing status.", permission: "website.view" },
  { path: "/admin", label: "Admin overview", description: "The iAcquire agency dashboard.", agency: "staff" },
  { path: "/admin/employees", label: "Internal Workforce", description: "The iAcquire internal AI workforce.", agency: "super_admin" },
  { path: "/admin/employees/clients", label: "Client Workforces", description: "Client AI workforce readiness.", agency: "staff", permission: "agency.workforce.view" },
  { path: "/admin/employees/policies", label: "Hermes tool policies", description: "Review Hermes tool boundaries.", agency: "staff", permission: "agency.tool_policies.view" },
  { path: "/admin/clients", label: "Clients", description: "Client workspaces and onboarding.", agency: "staff" },
  { path: "/admin/integrations", label: "Integrations", description: "Provider credentials and connections.", agency: "staff", permission: "agency.integrations.health" },
  { path: "/admin/health", label: "Health", description: "Platform health and incidents.", agency: "staff", permission: "agency.security.manage" },
  { path: "/admin/usage", label: "Usage", description: "Platform usage and limits.", agency: "staff" },
  { path: "/admin/support", label: "Requests", description: "Client support requests, issue reports and feedback.", agency: "staff" },
  { path: "/admin/aqi", label: "AQi Management", description: "Configure AQi, its knowledge and publishing.", agency: "super_admin" },
];

/** Longest-prefix match, so /settings/team resolves before /settings. */
export function matchAqiRoute(pathname: string | null | undefined): AqiRoute | null {
  if (!pathname || !pathname.startsWith("/")) return null;
  const clean = pathname.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  return [...AQI_ROUTES].sort((a, b) => b.path.length - a.path.length).find((route) => clean === route.path || clean.startsWith(`${route.path}/`)) ?? null;
}

export function pageFor(pathname: string | null | undefined): { path: string; label: string; description: string } | null {
  const route = matchAqiRoute(pathname);
  return route ? { path: route.path, label: route.label, description: route.description } : null;
}

export interface AqiAccess {
  can: (permission: Permission) => boolean;
  agencyRole: "agency_staff" | "agency_manager" | "agency_super_admin" | null;
}

export function canOpenAqiRoute(route: AqiRoute, access: AqiAccess): boolean {
  if (route.agency) {
    if (!access.agencyRole) return false;
    if (route.agency === "super_admin" && access.agencyRole !== "agency_super_admin") return false;
    // Agency pages use the same permission matrix as the rest of the portal. A role alone is not
    // enough: managers and staff may lack the specific agency permission the page enforces.
    return route.permission ? access.can(route.permission) : true;
  }
  return route.permission ? access.can(route.permission) : false;
}

/** Returns the route only when it is curated and the signed-in person can actually open it. */
export function safeAqiHref(href: string, access: AqiAccess): AqiRoute | null {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  const route = matchAqiRoute(href);
  if (!route || !canOpenAqiRoute(route, access)) return null;
  return route;
}
