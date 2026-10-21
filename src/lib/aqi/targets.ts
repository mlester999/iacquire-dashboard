import type { Permission } from "@/lib/permissions";
import { matchAqiRoute, type AqiRoute } from "@/lib/aqi/routes";

/**
 * The approved visual-guidance target registry.
 *
 * AQi can only highlight an element that is listed here. A model, a Super Admin or a tutorial
 * definition can never supply a CSS selector, a JavaScript expression or a DOM path: they reference
 * a stable id, and the browser looks up `[data-aqi-target="<id>"]`. Adding a target is a deliberate
 * code change that also adds the attribute to the real component.
 *
 * `routes` are the only pages where the element is expected to exist. `permission` is checked on
 * the server before a tutorial is offered and again on the client before highlighting, so a
 * target can never reveal a control the person cannot use.
 */
export interface AqiTarget {
  id: string;
  label: string;
  description: string;
  routes: string[];
  permission?: Permission;
  agency?: "staff" | "super_admin";
  /** Navigation targets are always present in the shell, so a tutorial may use them from any page. */
  navigation?: boolean;
}

export const AQI_TARGETS: AqiTarget[] = [
  // Client shell navigation.
  { id: "nav.overview", label: "Overview", description: "Overview in the main navigation.", routes: ["*"], permission: "workspace.view", navigation: true },
  { id: "nav.inbox", label: "Inbox", description: "Inbox in the main navigation.", routes: ["*"], permission: "inbox.view", navigation: true },
  { id: "nav.leads", label: "Leads", description: "Leads in the main navigation.", routes: ["*"], permission: "leads.view", navigation: true },
  { id: "nav.appointments", label: "Appointments", description: "Appointments in the main navigation.", routes: ["*"], permission: "appointments.view", navigation: true },
  { id: "nav.sales", label: "Sales Pipeline", description: "Sales Pipeline in the main navigation.", routes: ["*"], permission: "sales.view", navigation: true },
  { id: "nav.crm.contacts", label: "Contacts", description: "Contacts in the CRM navigation.", routes: ["*"], permission: "contacts.view", navigation: true },
  { id: "nav.crm.pipelines", label: "Pipelines", description: "Pipelines in the CRM navigation.", routes: ["*"], permission: "sales.view", navigation: true },
  { id: "nav.crm.calendar", label: "Calendar", description: "Calendar in the CRM navigation.", routes: ["*"], permission: "appointments.view", navigation: true },
  { id: "nav.crm.tasks", label: "Tasks", description: "Tasks in the CRM navigation.", routes: ["*"], permission: "crm.view", navigation: true },
  { id: "nav.crm", label: "All CRM tools", description: "All CRM tools in the CRM navigation.", routes: ["*"], permission: "crm.view", navigation: true },
  { id: "nav.automation-studio", label: "Automation Studio", description: "Automation Studio in the main navigation.", routes: ["*"], permission: "workflows.view", navigation: true },
  { id: "nav.approvals", label: "Approvals", description: "Approvals in the main navigation.", routes: ["*"], permission: "approvals.view", navigation: true },
  { id: "nav.knowledge", label: "Knowledge Center", description: "Knowledge Center in the main navigation.", routes: ["*"], permission: "knowledge.view", navigation: true },
  { id: "nav.workforce", label: "AI Employees", description: "AI Employees in the main navigation.", routes: ["*"], permission: "agents.use", navigation: true },
  { id: "nav.settings", label: "Settings", description: "Settings in the main navigation.", routes: ["*"], permission: "workspace.view", navigation: true },
  { id: "nav.website", label: "Website", description: "Website in the main navigation.", routes: ["*"], permission: "website.view", navigation: true },
  { id: "nav.support", label: "Support", description: "Support in the main navigation.", routes: ["*"], permission: "support.use", navigation: true },
  { id: "nav.analytics", label: "Analytics", description: "Analytics in the main navigation.", routes: ["*"], permission: "analytics.view", navigation: true },
  // Agency shell navigation.
  { id: "nav.agency.dashboard", label: "Agency dashboard", description: "Agency dashboard in the agency navigation.", routes: ["*"], agency: "staff", navigation: true },
  { id: "nav.agency.aqi", label: "AQi Management", description: "AQi Management in the agency navigation.", routes: ["*"], agency: "super_admin", navigation: true },
  { id: "nav.agency.clients", label: "Clients", description: "Clients in the agency navigation.", routes: ["*"], agency: "staff", navigation: true },
  { id: "nav.agency.workforce", label: "Internal AI Employees", description: "Internal AI Employees in the agency navigation.", routes: ["*"], agency: "super_admin", navigation: true },
  { id: "nav.agency.integrations", label: "Agency Integrations", description: "Agency Integrations in the agency navigation.", routes: ["*"], agency: "staff", permission: "agency.integrations.health", navigation: true },

  // Overview.
  { id: "overview.hero", label: "Workspace overview", description: "The overview welcome panel.", routes: ["/overview"] },
  { id: "overview.kpis", label: "Key metrics", description: "The real workspace metrics.", routes: ["/overview"] },
  { id: "overview.next-actions", label: "What needs attention", description: "Suggested next actions.", routes: ["/overview"] },
  { id: "overview.ai-team", label: "Your AI team", description: "The AI employees available in this workspace.", routes: ["/overview"] },

  // CRM contacts.
  { id: "crm.contacts.search", label: "Search contacts", description: "Search across contacts.", routes: ["/crm/contacts"], permission: "contacts.view" },
  { id: "crm.contacts.new", label: "New contact", description: "The button that opens the new-contact form.", routes: ["/crm/contacts"], permission: "contacts.edit" },
  { id: "crm.contacts.table", label: "Contacts list", description: "The contacts list and its rows.", routes: ["/crm/contacts"], permission: "contacts.view" },
  { id: "crm.contact.form", label: "New contact form", description: "The contact form dialog.", routes: ["/crm/contacts"], permission: "contacts.edit" },
  { id: "crm.contact.first-name", label: "First name field", description: "The contact's first name.", routes: ["/crm/contacts"], permission: "contacts.edit" },
  { id: "crm.contact.save", label: "Add contact", description: "The form's Add contact button. AQi never presses it.", routes: ["/crm/contacts"], permission: "contacts.edit" },

  // CRM pipelines and calendar.
  { id: "crm.pipelines.board", label: "Pipeline board", description: "The pipeline stages and deals.", routes: ["/crm/pipelines"], permission: "sales.view" },
  { id: "crm.pipelines.new-deal", label: "New deal", description: "Create a deal in this pipeline.", routes: ["/crm/pipelines"], permission: "opportunities.create" },
  { id: "crm.calendar.grid", label: "Calendar view", description: "The appointment calendar.", routes: ["/crm/calendar"], permission: "appointments.view" },
  { id: "crm.calendar.new-appointment", label: "New appointment", description: "Book an appointment.", routes: ["/crm/calendar"], permission: "appointments.book" },

  // CRM tasks and workflows.
  { id: "crm.tasks.header", label: "Task queue", description: "The Tasks page header and its actions.", routes: ["/crm/tasks"], permission: "crm.view" },
  { id: "crm.tasks.views", label: "Task views", description: "Mine, team, overdue, upcoming and completed views.", routes: ["/crm/tasks"], permission: "crm.view" },
  { id: "crm.tasks.new", label: "New task", description: "Open the task form.", routes: ["/crm/tasks"], permission: "tasks.manage" },
  { id: "crm.workflows.header", label: "Workflows", description: "The Workflows page header and its actions.", routes: ["/crm/workflows"], permission: "workflows.view" },
  { id: "crm.workflows.list", label: "Workflow list", description: "Every automation, its trigger, status and last run.", routes: ["/crm/workflows"], permission: "workflows.view" },
  { id: "crm.workflows.new", label: "New workflow", description: "Start a workflow from a template or blank.", routes: ["/crm/workflows"], permission: "workflows.manage" },

  // Website, analytics and setup.
  { id: "website.hero", label: "Website overview", description: "The website status and starting point.", routes: ["/website"], permission: "website.view" },
  { id: "website.edit", label: "Edit website", description: "Open the private draft editor.", routes: ["/website"], permission: "website.edit" },
  { id: "website.start", label: "Choose a style", description: "Start a website from a design.", routes: ["/website"], permission: "website.create" },
  { id: "analytics.range", label: "Reporting window", description: "Choose the date range and export the records.", routes: ["/analytics"], permission: "analytics.view" },
  { id: "analytics.report", label: "Analytics report", description: "Recorded lead, execution and CRM results.", routes: ["/analytics"], permission: "analytics.view" },
  { id: "setup.hero", label: "Setup Center", description: "Setup progress and what needs your attention.", routes: ["/setup"], permission: "setup.view" },
  { id: "setup.journey", label: "Setup journey", description: "The three setup stages: preparation, your input and final review.", routes: ["/setup"], permission: "setup.view" },
  { id: "aqi.launcher", label: "Open AQi", description: "The AQi assistant launcher.", routes: ["*"], navigation: true },

  // Legacy GoHighLevel appointment view (still used by externally owned calendars).
  { id: "appointments.hero", label: "Appointments overview", description: "The appointments page header.", routes: ["/appointments"], permission: "appointments.view" },
  { id: "appointments.book", label: "Book appointment", description: "Opens the booking form.", routes: ["/appointments"], permission: "appointments.book" },
  { id: "appointments.calendar", label: "Appointment calendar", description: "The month calendar of recorded meetings.", routes: ["/appointments"], permission: "appointments.view" },

  // Leads.
  { id: "leads.tabs", label: "Lead views", description: "Review, researching and history tabs.", routes: ["/leads"], permission: "leads.view" },
  { id: "leads.review-table", label: "Lead review table", description: "Leads waiting for review.", routes: ["/leads"], permission: "leads.view" },
  { id: "leads.research", label: "New research request", description: "Ask the Lead Hunter for new prospects.", routes: ["/leads"], permission: "leads.research" },

  // Workforce.
  { id: "workforce.hero", label: "AI Employees", description: "The AI employees page header.", routes: ["/employees"], permission: "agents.use" },
  { id: "workforce.gallery", label: "Employee gallery", description: "The AI employees in this workspace.", routes: ["/employees"], permission: "agents.use" },
  { id: "workforce.employee", label: "AI employee", description: "An employee card with chat and configuration actions.", routes: ["/employees"], permission: "agents.use" },
  { id: "workforce.employee.hero", label: "Employee profile", description: "The selected AI employee's identity, readiness and primary actions.", routes: ["/employees"], permission: "agents.use" },
  { id: "workforce.employee.configure", label: "Guided configuration", description: "The employee's grouped, guided configuration form.", routes: ["/employees"], permission: "agents.configure" },
  { id: "workforce.employee.history", label: "Version history", description: "Saved configuration versions, decisions and review status.", routes: ["/employees"], permission: "agents.configure" },

  // Chat.
  { id: "chat.rail", label: "Chat sidebar", description: "The iAcquire chat sidebar with specialists and conversation history.", routes: ["/chat"], permission: "agents.use" },
  { id: "chat.employee", label: "Selected employee", description: "The AI employee selected for this conversation.", routes: ["/chat"], permission: "agents.use" },
  { id: "chat.composer", label: "Message box", description: "Where the person writes a message to the AI employee.", routes: ["/chat"], permission: "agents.use" },

  // Notifications.
  { id: "notifications.bell", label: "Notification bell", description: "The saved notification feed for the signed-in person.", routes: ["*"], navigation: true },

  // Settings, integrations, team, knowledge, support.
  { id: "settings.integrations.list", label: "Integration status", description: "The services connected to this workspace.", routes: ["/settings/integrations"], permission: "integrations.view" },
  { id: "settings.integrations.nav", label: "Integrations (settings)", description: "Integrations in the settings navigation.", routes: ["/settings"], permission: "integrations.view" },
  { id: "settings.integrations.request", label: "Request a connection", description: "Ask iAcquire to connect a service.", routes: ["/settings/integrations"], permission: "integrations.view" },
  { id: "settings.team.nav", label: "Team (settings)", description: "Team in the settings navigation.", routes: ["/settings"], permission: "team.view" },
  { id: "settings.team.invite", label: "Invite a teammate", description: "The invite panel.", routes: ["/settings/team"], permission: "team.manage" },
  { id: "settings.team.email", label: "Invite email", description: "The teammate's email field.", routes: ["/settings/team"], permission: "team.manage" },
  { id: "settings.team.submit", label: "Invite", description: "Send the invitation. AQi never presses it.", routes: ["/settings/team"], permission: "team.manage" },
  { id: "knowledge.list", label: "Knowledge Center", description: "Company knowledge entries and documents.", routes: ["/knowledge"], permission: "knowledge.view" },
  { id: "knowledge.upload", label: "Add knowledge", description: "Upload or write knowledge.", routes: ["/knowledge"], permission: "knowledge.edit" },
  { id: "support.new-ticket", label: "New request", description: "Start a support request.", routes: ["/support"], permission: "support.use" },
  { id: "support.ticket-list", label: "Support conversations", description: "Existing support requests.", routes: ["/support"], permission: "support.use" },

  // Agency.
  { id: "admin.hero", label: "Agency dashboard", description: "The agency dashboard header.", routes: ["/admin"], agency: "staff" },
  { id: "admin.clients.table", label: "Client list", description: "Assigned client workspaces.", routes: ["/admin/clients"], agency: "staff" },
  { id: "admin.clients.new", label: "New client", description: "Create a client workspace.", routes: ["/admin/clients"], agency: "staff", permission: "agency.clients.create" },

  // AQi Management.
  { id: "admin.aqi.tabs", label: "AQi management sections", description: "The AQi management tabs.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.tutorials-tab", label: "Tutorials tab", description: "Open Tutorials to manage walkthroughs.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.knowledge-tab", label: "Platform knowledge tab", description: "Open Platform knowledge.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.insights-link", label: "AQi Insights", description: "Open the AQi Insights dashboard.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.save-draft", label: "Save draft", description: "Save configuration changes as a draft.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.tutorial-list", label: "Tutorial library", description: "Published, draft and archived walkthroughs.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.tutorial-new", label: "New tutorial", description: "Create a walkthrough.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.tutorial-publish", label: "Publish tutorial", description: "Publish the selected draft after validation.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.knowledge-document", label: "Upload knowledge document", description: "Upload a PDF, DOCX or TXT for platform knowledge.", routes: ["/admin/aqi"], agency: "super_admin" },
  { id: "admin.aqi.insights.cards", label: "Insights metrics", description: "Real AQi usage, performance and tutorial metrics.", routes: ["/admin/aqi/insights"], agency: "super_admin" },
  { id: "admin.aqi.insights.filters", label: "Insights filters", description: "Date range and organization filters.", routes: ["/admin/aqi/insights"], agency: "super_admin" },
];

const BY_ID = new Map(AQI_TARGETS.map((target) => [target.id, target]));

export function getAqiTarget(id: string | null | undefined): AqiTarget | null {
  return id ? BY_ID.get(id) ?? null : null;
}

export function isAqiTargetId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

/** Stable attribute name used by the browser. Selectors are built only here, never by a model. */
export function aqiTargetSelector(id: string): string {
  return `[data-aqi-target="${id.replace(/["\\]/g, "")}"]`;
}

export function targetAvailableOnRoute(target: AqiTarget, pathname: string | null | undefined): boolean {
  if (target.routes.includes("*")) return true;
  if (!pathname) return false;
  const clean = pathname.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  return target.routes.some((route) => clean === route || clean.startsWith(`${route}/`));
}

/** Maps a real navigation href to its approved target id, so the sidebars do not hand-write selectors. */
export function aqiNavTarget(href: string, area: "client" | "agency" = "client"): string | null {
  const map: Record<string, string> = area === "agency"
    ? {
        "/admin": "nav.agency.dashboard",
        "/admin/aqi": "nav.agency.aqi",
        "/admin/clients": "nav.agency.clients",
        "/admin/employees": "nav.agency.workforce",
        "/admin/integrations": "nav.agency.integrations",
      }
    : {
        "/overview": "nav.overview",
        "/inbox": "nav.inbox",
        "/leads": "nav.leads",
        "/appointments": "nav.appointments",
        "/sales": "nav.sales",
        "/crm/contacts": "nav.crm.contacts",
        "/crm/pipelines": "nav.crm.pipelines",
        "/crm/calendar": "nav.crm.calendar",
        "/crm/tasks": "nav.crm.tasks",
        "/crm": "nav.crm",
        "/automation-studio": "nav.automation-studio",
        "/approvals": "nav.approvals",
        "/knowledge": "nav.knowledge",
        "/employees": "nav.workforce",
        "/website": "nav.website",
        "/settings": "nav.settings",
        "/support": "nav.support",
        "/analytics": "nav.analytics",
      };
  return map[href] ?? null;
}

/** A route a tutorial step may navigate to. Uses the curated AQi route registry, not raw input. */
export function approvedTutorialRoute(path: string): AqiRoute | null {
  return matchAqiRoute(path);
}

export function routeInTarget(target: AqiTarget, path: string | null): boolean {
  if (!path) return target.navigation === true;
  return target.routes.includes("*") || target.routes.some((route) => path === route || path.startsWith(`${route}/`));
}

export function targetListForDocumentation(): Array<Pick<AqiTarget, "id" | "label" | "routes" | "permission">> {
  return AQI_TARGETS.map(({ id, label, routes, permission }) => ({ id, label, routes, permission }));
}
