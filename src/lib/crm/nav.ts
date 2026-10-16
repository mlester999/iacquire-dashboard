// The CRM workspace's own navigation, shared by the client portal (/crm) and the agency's view of one client (/admin/clients/[id]/crm).
// An item is listed only when its screen is real. Links that leave the CRM (the inbox, the AI workforce) are client-only.
import type { Permission } from "@/lib/permissions";

export interface CrmNavItem {
  /** Path below the CRM base, or an absolute portal path when `external`. */
  path: string;
  label: string;
  icon: string;
  permission: Permission;
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
      { path: "/contacts", label: "Contacts", icon: "users", permission: "contacts.view" },
      { path: "/companies", label: "Companies", icon: "building-2", permission: "companies.view" },
      { path: "/smart-lists", label: "Smart Lists", icon: "list-filter", permission: "contacts.view" },
      { path: "/tags", label: "Tags & Segments", icon: "tags", permission: "crm.view" },
      { path: "/fields", label: "Custom Fields", icon: "text-cursor-input", permission: "crm.view" },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    items: [
      { path: "/pipelines", label: "Pipelines", icon: "kanban-square", permission: "sales.view" },
      { path: "/opportunities", label: "Opportunities", icon: "handshake", permission: "sales.view" },
      { path: "/tasks", label: "Tasks", icon: "list-checks", permission: "crm.view" },
    ],
  },
  {
    key: "communications",
    label: "Communications",
    items: [{ path: "/inbox", label: "Unified Inbox", icon: "inbox", permission: "inbox.view", external: true }],
  },
  {
    key: "automation",
    label: "Automation",
    items: [{ path: "/workforce", label: "AI Employees", icon: "sparkles", permission: "agents.use", external: true }],
  },
  {
    key: "settings",
    label: "Settings",
    items: [
      { path: "/settings/provider", label: "CRM Provider", icon: "plug", permission: "crm.view" },
      { path: "/settings/permissions", label: "Team & Permissions", icon: "shield-check", permission: "team.view" },
      { path: "/settings/data", label: "Imports & Exports", icon: "database", permission: "contacts.import" },
      { path: "/settings/access", label: "Support Access", icon: "eye", permission: "activity.view" },
    ],
  },
];

export function navFor(permissions: ReadonlySet<Permission> | ((p: Permission) => boolean), mode: "client" | "agency"): CrmNavSection[] {
  const can = typeof permissions === "function" ? permissions : (p: Permission) => permissions.has(p);
  return CRM_NAV.map((s) => ({ ...s, items: s.items.filter((i) => can(i.permission) && !(mode === "agency" && i.external)) })).filter((s) => s.items.length);
}
