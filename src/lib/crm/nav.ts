// The CRM workspace's own navigation, shared by the client portal (/crm) and the agency's view of one client (/admin/clients/[id]/crm).
// An item is listed only when its screen is real. Links that leave the CRM (the inbox, the AI workforce) are client-only.
import type { Permission } from "@/lib/permissions";
import type { CrmCapability } from "@/lib/crm/types";

export interface CrmNavItem {
  /** Path below the CRM base, or an absolute portal path when `external`. */
  path: string;
  label: string;
  icon: string;
  permission: Permission;
  /** The capability that owns the data behind this section, when it maps directly to one. */
  capability?: CrmCapability;
  external?: boolean;
  /** Exact match only (the overview), so it isn't highlighted on every page. */
  exact?: boolean;
}

export interface CrmNavSection {
  key: string;
  label: string;
  items: CrmNavItem[];
}

export const CRM_NAV: CrmNavSection[] = [
  {
    key: "crm",
    label: "CRM",
    items: [
      { path: "", label: "Overview", icon: "layout-dashboard", permission: "crm.view", exact: true },
      { path: "/setup", label: "Setup guide", icon: "rocket", permission: "crm.view" },
      { path: "/contacts", label: "Contacts", icon: "users", permission: "contacts.view", capability: "contacts" },
      { path: "/companies", label: "Companies", icon: "building-2", permission: "companies.view", capability: "companies" },
      { path: "/smart-lists", label: "Smart Lists", icon: "list-filter", permission: "contacts.view", capability: "contacts" },
      { path: "/tags", label: "Tags & Segments", icon: "tags", permission: "crm.view", capability: "tags" },
      { path: "/fields", label: "Custom Fields", icon: "text-cursor-input", permission: "crm.view", capability: "custom_fields" },
      { path: "/reports", label: "Reports", icon: "bar-chart-3", permission: "analytics.view", capability: "reporting" },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    items: [
      { path: "/pipelines", label: "Pipelines", icon: "kanban-square", permission: "sales.view", capability: "pipelines" },
      { path: "/opportunities", label: "Opportunities", icon: "handshake", permission: "sales.view", capability: "opportunities" },
      { path: "/tasks", label: "Tasks", icon: "list-checks", permission: "crm.view" },
    ],
  },
  {
    key: "scheduling",
    label: "Scheduling",
    items: [
      { path: "/calendar", label: "Calendar", icon: "calendar-days", permission: "appointments.view", capability: "appointments" },
      { path: "/appointments", label: "Appointments", icon: "calendar-check", permission: "appointments.view", capability: "appointments" },
      { path: "/booking-pages", label: "Booking Pages", icon: "link-2", permission: "appointments.view", capability: "calendars" },
      { path: "/availability", label: "Availability", icon: "clock", permission: "appointments.view", capability: "calendars" },
      { path: "/calendars", label: "Calendars & Types", icon: "calendar-cog", permission: "appointments.view", capability: "calendars" },
      { path: "/calendar-connections", label: "Calendar Connections", icon: "calendar-sync", permission: "appointments.view", capability: "calendars" },
    ],
  },
  {
    key: "communications",
    label: "Communications",
    items: [
      { path: "/inbox", label: "Unified Inbox", icon: "inbox", permission: "inbox.view", external: true, capability: "conversations" },
      { path: "/templates", label: "Templates", icon: "file-text", permission: "inbox.view", capability: "conversations" },
      { path: "/settings/communications", label: "Communication Settings", icon: "sliders-horizontal", permission: "inbox.view", capability: "conversations" },
    ],
  },
  {
    key: "growth",
    label: "Growth",
    items: [
      { path: "/forms", label: "Forms & Surveys", icon: "clipboard-list", permission: "crm.view" },
      { path: "/campaigns", label: "Campaigns", icon: "megaphone", permission: "campaigns.manage" },
      { path: "/reviews", label: "Reviews", icon: "star", permission: "contacts.view" },
      { path: "/calls", label: "Calls", icon: "phone", permission: "calls.view" },
    ],
  },
  {
    key: "automation",
    label: "Automation",
    items: [
      { path: "/workflows", label: "Workflows", icon: "workflow", permission: "workflows.view", capability: "workflows" },
      { path: "/workflows/activity", label: "Workflow Activity", icon: "activity", permission: "workflows.view", capability: "workflows" },
      { path: "/follow-ups", label: "Follow-up Sequences", icon: "repeat", permission: "inbox.view", capability: "conversations" },
      { path: "/employees", label: "AI Employees", icon: "sparkles", permission: "agents.use", external: true },
      { path: "/settings/ai-tools", label: "AI Employee Tools", icon: "shield-check", permission: "activity.view" },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    items: [
      { path: "/settings/provider", label: "CRM Provider", icon: "plug", permission: "crm.view" },
      { path: "/settings/permissions", label: "Team & Permissions", icon: "shield-check", permission: "team.view" },
      { path: "/settings/assignment", label: "Lead Assignment", icon: "route", permission: "contacts.assign" },
      { path: "/settings/lead-scoring", label: "Lead Scoring", icon: "gauge", permission: "contacts.view" },
      { path: "/settings/values", label: "Configuration Values", icon: "braces", permission: "crm.view" },
      { path: "/settings/blueprints", label: "Blueprints & setup", icon: "list-checks", permission: "crm.view" },
      { path: "/settings/data", label: "Imports & Exports", icon: "database", permission: "crm.view" },
      { path: "/settings/api", label: "API & Webhooks", icon: "webhook", permission: "crm.api.manage" },
      { path: "/settings/access", label: "Support Access", icon: "eye", permission: "activity.view" },
    ],
  },
];

export function navFor(permissions: ReadonlySet<Permission> | ((p: Permission) => boolean), mode: "client" | "agency"): CrmNavSection[] {
  const can = typeof permissions === "function" ? permissions : (p: Permission) => permissions.has(p);
  return CRM_NAV.map((s) => ({ ...s, items: s.items.filter((i) => can(i.permission) && !(mode === "agency" && i.external)) })).filter((s) => s.items.length);
}
