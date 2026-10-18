// Mirrors the role_permissions seed in supabase/migrations. tests/workforce-config.test.ts compares this
// matrix with the migrated database and fails if the two drift apart.
// The UI uses this only to decide what to show; the server and database enforce access.
//
// Client roles: owner = Business Owner, admin = Manager, member = Team member (earlier, general role),
// sales_rep, support, viewer, appointment_setter. Agency roles are a separate access model and never appear as a client role.
// Individual members can additionally be granted or refused delegable CRM permissions (member_permission_overrides).

export const ORG_ROLES = ["owner", "admin", "member", "sales_rep", "support", "viewer", "appointment_setter"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export type PlatformRole = "none" | "agency_staff" | "agency_manager" | "agency_super_admin";
export type EffectiveRole = OrgRole | "agency_staff" | "agency_manager" | "agency_super_admin";

const row = (...roles: EffectiveRole[]): readonly EffectiveRole[] => roles;
const CLIENT = ["owner", "admin", "member", "sales_rep", "support", "viewer", "appointment_setter"] as const;
/** Everyone who works conversations and records, as opposed to read-only viewers. */
const WORKING = ["owner", "admin", "member", "sales_rep", "support", "appointment_setter"] as const;
const OWNER_ADMIN = ["owner", "admin"] as const;
const STAFF = ["agency_staff", "agency_manager", "agency_super_admin"] as const;

export const PERMISSION_MATRIX = {
  "workspace.view": row(...CLIENT, ...STAFF),
  "workspace.manage_profile": row(...OWNER_ADMIN, ...STAFF),
  "team.view": row(...CLIENT, ...STAFF),
  "team.manage": row(...OWNER_ADMIN, "agency_super_admin"),
  "agents.use": row(...WORKING),
  "agents.configure": row(...OWNER_ADMIN),
  "knowledge.view": row(...CLIENT, ...STAFF),
  "knowledge.edit": row(...OWNER_ADMIN, ...STAFF),
  "leads.view": row(...CLIENT, ...STAFF),
  "leads.research": row(...OWNER_ADMIN),
  "leads.review": row(...OWNER_ADMIN),
  "leads.export": row(...OWNER_ADMIN),
  "appointments.view": row(...CLIENT, ...STAFF),
  // Booking policy, the event ledger and approving AI bookings are the owner's and managers'; anyone who works with customers can book for them.
  "appointments.manage": row(...OWNER_ADMIN, "agency_manager"),
  "appointments.book": row(...WORKING, "agency_manager"),
  "sales.view": row(...CLIENT, ...STAFF),
  "notes.write": row(...WORKING),
  "tasks.manage": row(...WORKING),
  "retention.view": row(...CLIENT, ...STAFF),
  "retention.edit": row(...OWNER_ADMIN),
  // Switching a customer program on records the owner's approval of its exact wording, so only the owner can do it. Managers can edit and switch off.
  "retention.activate": row("owner"),
  "analytics.view": row(...CLIENT, ...STAFF),
  "analytics.export": row(...OWNER_ADMIN),
  "approvals.view": row(...CLIENT, ...STAFF),
  "approvals.decide": row(...OWNER_ADMIN),
  "approvals.decide_high": row("owner"),
  "activity.view": row(...OWNER_ADMIN, ...STAFF),
  "integrations.view": row(...OWNER_ADMIN, ...STAFF),
  "usage.view": row(...OWNER_ADMIN, ...STAFF),
  "billing.view": row("owner", ...STAFF),
  "support.use": row(...WORKING),
  "setup.view": row(...CLIENT, ...STAFF),
  "setup.respond": row(...OWNER_ADMIN),
  "setup.manage": row(...STAFF),
  "setup.activate": row("agency_super_admin"),
  "projects.view": row(...CLIENT, ...STAFF),
  "projects.request": row(...OWNER_ADMIN),
  "projects.approve_quote": row("owner"),
  "projects.manage": row(...STAFF),
  "quotes.manage": row(...STAFF),
  "catalog.manage": row("agency_super_admin"),
  "portfolio.manage": row("agency_super_admin"),
  "maintenance.view": row(...OWNER_ADMIN, ...STAFF),
  "maintenance.request": row(...OWNER_ADMIN),
  "maintenance.manage_plan": row("owner"),
  "maintenance.manage": row(...STAFF),
  "automation.pause": row(...OWNER_ADMIN),
  "automation.go_autonomous": row("owner"),
  // Customer conversations belong to the client. Agency staff reach them only through audited support tooling.
  "inbox.view": row(...CLIENT, "agency_staff", "agency_manager"),
  "inbox.view_all": row(...OWNER_ADMIN, "agency_staff", "agency_manager"),
  "inbox.reply": row(...WORKING),
  "inbox.assign": row(...OWNER_ADMIN),
  "inbox.notes": row(...WORKING),
  "inbox.resume_ai": row("owner", "admin", "sales_rep", "support", "appointment_setter"),
  "escalations.respond": row("owner", "admin", "sales_rep", "support", "appointment_setter"),
  "escalations.configure": row(...OWNER_ADMIN),
  "contacts.view": row(...CLIENT, "agency_staff", "agency_manager"),
  "contacts.create": row(...WORKING, "agency_manager"),
  "contacts.edit": row(...WORKING, "agency_manager"),
  "contacts.merge": row(...OWNER_ADMIN),
  "messaging.configure": row(...OWNER_ADMIN),
  "consent.manage": row(...OWNER_ADMIN),
  "staff.availability": row(...WORKING),
  "credits.topup": row(...OWNER_ADMIN),
  "billing.configure": row(...OWNER_ADMIN),
  "billing.agency_view": row(...STAFF),
  "billing.agency_manage": row("agency_super_admin"),
  // Website Studio. Anyone on the team can see the site; editing and domains are owner/manager (agency staff help build);
  // approval remains the client's owner's; Managers and Super Admins may publish only after that exact draft is approved.
  "website.view": row(...CLIENT, ...STAFF),
  "website.create": row(...OWNER_ADMIN, ...STAFF),
  "website.edit": row(...OWNER_ADMIN, ...STAFF),
  "website.domains": row(...OWNER_ADMIN, ...STAFF),
  "website.approve": row("owner"),
  "website.publish": row("owner", "agency_manager", "agency_super_admin"),
  "website.archive": row("owner", "agency_super_admin"),
  // Designing and maintaining the agency template library, publishing a template to clients, and reviewing a client's site and leaving comments on it.
  "website.templates.design": row(...STAFF),
  "website.templates.publish": row("agency_super_admin"),
  "website.review": row(...STAFF),
  // Service incidents. Clients see only the ones marked client-visible; agency staff acknowledge, annotate and close them.
  "incidents.view": row(...OWNER_ADMIN, ...STAFF),
  "incidents.manage": row(...STAFF),
  // Leaving iAcquire. The owner can see the status, ask to leave and take their data; agency super admins run the shutdown and the deletion.
  "offboarding.view": row("owner", ...STAFF),
  "offboarding.request": row("owner"),
  "offboarding.manage": row("agency_super_admin"),
  "data.export": row("owner", "agency_super_admin"),
  "finance.manage": row("agency_super_admin"),
  // Native CRM. Agency staff never appear here: they reach a client's CRM only through an audited, time-limited support session
  // (src/server/crm/actor.ts), so row-level security never widens for them. Delegable permissions can also be granted or withdrawn
  // per person (member_permission_overrides, see DELEGABLE_PERMISSIONS).
  "crm.view": row(...CLIENT, "agency_staff", "agency_manager"),
  "contacts.assign": row(...OWNER_ADMIN),
  "contacts.delete": row(...OWNER_ADMIN),
  "contacts.import": row(...OWNER_ADMIN),
  "contacts.export": row(...OWNER_ADMIN),
  "contacts.bulk": row(...OWNER_ADMIN),
  "companies.view": row(...CLIENT, "agency_staff", "agency_manager"),
  "companies.create": row(...WORKING, "agency_manager"),
  "companies.edit": row(...WORKING, "agency_manager"),
  "companies.delete": row(...OWNER_ADMIN),
  "tags.manage": row(...OWNER_ADMIN),
  "fields.manage": row(...OWNER_ADMIN),
  "smartlists.share": row(...OWNER_ADMIN),
  "pipelines.manage": row(...OWNER_ADMIN),
  "opportunities.edit": row("owner", "admin", "member", "sales_rep", "appointment_setter", "agency_manager"),
  "opportunities.create": row("owner", "admin", "member", "sales_rep", "appointment_setter", "agency_manager"),
  "opportunities.reopen": row(...OWNER_ADMIN),
  "opportunities.delete": row(...OWNER_ADMIN),
  "calendars.manage": row(...OWNER_ADMIN, "agency_manager"),
  "calendars.connect": row(...WORKING),
  "workflows.view": row(...OWNER_ADMIN, "agency_staff", "agency_manager"),
  "workflows.manage": row(...OWNER_ADMIN),
  "templates.manage": row(...OWNER_ADMIN),
  "campaigns.manage": row(...OWNER_ADMIN),
  // Sending a campaign to many people at once is the owner's decision.
  "campaigns.send": row("owner"),
  "forms.manage": row(...OWNER_ADMIN),
  "reviews.manage": row(...OWNER_ADMIN),
  // Call records can include recordings and transcripts, so read-only viewers do not see them.
  "calls.view": row(...WORKING, "agency_staff", "agency_manager"),
  // Switching between iAcquire Native CRM and GoHighLevel moves the record of truth, so only the owner can start it.
  "crm.provider.manage": row("owner"),
  "crm.api.manage": row(...OWNER_ADMIN),
  "crm.permissions.manage": row(...OWNER_ADMIN),
  "crm.blueprints.view": row(...STAFF),
  "crm.blueprints.design": row(...STAFF),
  "crm.blueprints.publish": row("agency_super_admin"),
  "crm.blueprints.apply": row("agency_super_admin"),
  // Agency permissions are enforced independently from client membership permissions.
  // A manager's client scope is checked separately by app.staff_assigned/app.can_access_org.
  "agency.clients.create": row("agency_manager", "agency_super_admin"),
  "agency.clients.invite_users": row("agency_manager", "agency_super_admin"),
  "agency.team.manage": row("agency_super_admin"),
  "agency.tool_policies.view": row("agency_manager", "agency_super_admin"),
  "agency.tool_policies.manage": row("agency_super_admin"),
  "agency.integrations.health": row("agency_manager", "agency_super_admin"),
  "agency.integrations.manage": row("agency_super_admin"),
  "agency.workforce.view": row(...STAFF),
  "agency.workforce.manage": row("agency_manager", "agency_super_admin"),
  "agency.crm.read": row(...STAFF),
  "agency.crm.manage": row("agency_manager", "agency_super_admin"),
  "agency.support.view": row(...STAFF),
  "agency.support.manage": row(...STAFF),
  "agency.security.manage": row("agency_super_admin"),
  "agency.billing.manage": row("agency_super_admin"),
  "agency.settings.manage": row("agency_super_admin"),
  "agency.audit.view": row("agency_super_admin"),
  "agency.workforce.full_capabilities.acknowledge": row("agency_super_admin"),
} as const satisfies Record<string, readonly EffectiveRole[]>;

export type Permission = keyof typeof PERMISSION_MATRIX;

export function roleHasPermission(role: EffectiveRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return PERMISSION_MATRIX[permission].includes(role);
}

export function permissionsFor(role: EffectiveRole | null | undefined): Permission[] {
  if (!role) return [];
  return (Object.keys(PERMISSION_MATRIX) as Permission[]).filter((p) => roleHasPermission(role, p));
}

export const ROLE_LABELS: Record<EffectiveRole, string> = {
  owner: "Business Owner",
  admin: "Manager",
  member: "Team member",
  sales_rep: "Sales Representative",
  support: "Customer Support",
  viewer: "Viewer",
  appointment_setter: "Appointment Setter",
  agency_staff: "Agency Staff",
  agency_manager: "Agency Manager",
  agency_super_admin: "Agency Super Admin",
};

export const AGENCY_PERMISSION_INFO = {
  "agency.clients.create": { label: "Create client workspaces", group: "Clients", delegable: true },
  "agency.clients.invite_users": { label: "Invite client users", group: "Clients", delegable: true },
  "agency.team.manage": { label: "Manage agency team and permissions", group: "Agency security", delegable: false },
  "agency.tool_policies.view": { label: "View Hermes tool policies", group: "AI workforce", delegable: false },
  "agency.tool_policies.manage": { label: "Edit Hermes tool policies", group: "AI workforce", delegable: false },
  "agency.integrations.health": { label: "View integration health", group: "Integrations", delegable: false },
  "agency.integrations.manage": { label: "Manage integrations and credentials", group: "Integrations", delegable: false },
  "agency.workforce.view": { label: "View assigned client AI workforce", group: "Client operations", delegable: true },
  "agency.workforce.manage": { label: "Manage assigned client AI workforce", group: "Client operations", delegable: true },
  "agency.crm.read": { label: "Read assigned client CRM records", group: "Client operations", delegable: true },
  "agency.crm.manage": { label: "Update assigned client CRM records", group: "Client operations", delegable: true },
  "agency.support.view": { label: "Read assigned client support tickets", group: "Client operations", delegable: true },
  "agency.support.manage": { label: "Reply to and update assigned client support tickets", group: "Client operations", delegable: true },
  "agency.security.manage": { label: "Change agency security settings", group: "Agency security", delegable: false },
  "agency.billing.manage": { label: "Manage agency billing and pricing", group: "Agency security", delegable: false },
  "agency.settings.manage": { label: "Change agency-wide settings", group: "Agency security", delegable: false },
  "agency.audit.view": { label: "Review agency audit history", group: "Agency security", delegable: false },
  "agency.workforce.full_capabilities.acknowledge": { label: "Authorize full capabilities for internal Hermes profiles", group: "AI workforce", delegable: false },
} as const satisfies Record<Extract<Permission, `agency.${string}`>, { label: string; group: string; delegable: boolean }>;

export type AgencyPermission = keyof typeof AGENCY_PERMISSION_INFO;
export const AGENCY_DELEGABLE_PERMISSIONS = [
  "agency.clients.create",
  "agency.clients.invite_users",
  "agency.workforce.view",
  "agency.workforce.manage",
  "agency.crm.read",
  "agency.crm.manage",
  "agency.support.view",
  "agency.support.manage",
] as const satisfies readonly AgencyPermission[];

/** Client actions that Agency Managers and Staff can have individually customized. */
export const AGENCY_TEAM_OPERATIONAL_PERMISSIONS = [
  "contacts.view", "contacts.create", "contacts.edit", "contacts.assign", "contacts.merge", "contacts.delete", "contacts.import", "contacts.export", "contacts.bulk",
  "companies.view", "companies.create", "companies.edit", "companies.delete", "tags.manage", "fields.manage", "smartlists.share",
  "sales.view", "pipelines.manage", "opportunities.create", "opportunities.edit", "opportunities.reopen", "opportunities.delete",
  "appointments.view", "appointments.book", "appointments.manage", "calendars.manage",
  "tasks.manage", "notes.write", "inbox.view", "inbox.view_all", "inbox.reply", "inbox.notes", "inbox.assign",
  "workflows.view", "workflows.manage", "templates.manage", "campaigns.manage", "forms.manage", "reviews.manage", "calls.view", "analytics.export",
] as const satisfies readonly Permission[];

/** Module view grants are parent gates for related agency actions. */
export const AGENCY_TEAM_PERMISSION_VIEW_PARENT: Partial<Record<Permission, "projects.view" | "website.view">> = {
  "projects.manage": "projects.view",
  "quotes.manage": "projects.view",
  "website.create": "website.view",
  "website.edit": "website.view",
  "website.domains": "website.view",
  "website.review": "website.view",
  "website.publish": "website.view",
  "website.archive": "website.view",
};

export const ROLE_DESCRIPTIONS: Record<OrgRole, string> = {
  owner: "Full control, including billing, autonomous mode and the final say on escalations.",
  admin: "Runs the workspace day to day: team, AI settings, inbox and approvals.",
  member: "General teammate: works with the AI team, notes and tasks. Earlier role, kept for existing members.",
  sales_rep: "Takes sales conversations and ready-to-close leads.",
  support: "Handles customer questions, complaints and service requests.",
  viewer: "Read-only access to leads, appointments, reports and conversations assigned to them.",
  appointment_setter: "Works new enquiries, books and reschedules appointments, and keeps contact details current.",
};

/** Roles offered in the invite picker. The earlier general role stays valid for existing members and API callers. */
export const INVITABLE_ROLES: readonly OrgRole[] = ["admin", "sales_rep", "appointment_setter", "support", "viewer"];

/**
 * Permissions an owner or manager may grant to, or withdraw from, one person on top of their role. Mirrors the check constraint on
 * member_permission_overrides. Billing, whole-workspace export, provider switching, offboarding, publishing and autonomous AI are never
 * delegable: they always follow the role.
 */
export const DELEGABLE_PERMISSIONS = [
  "contacts.view", "contacts.create", "contacts.edit", "contacts.assign", "contacts.merge", "contacts.delete", "contacts.import", "contacts.export", "contacts.bulk",
  "companies.view", "companies.create", "companies.edit", "companies.delete", "tags.manage", "fields.manage", "smartlists.share",
  "sales.view", "pipelines.manage", "opportunities.create", "opportunities.edit", "opportunities.reopen", "opportunities.delete",
  "appointments.view", "appointments.book", "appointments.manage", "calendars.manage", "calendars.connect",
  "tasks.manage", "notes.write", "inbox.view", "inbox.view_all", "inbox.reply", "inbox.notes", "inbox.assign",
  "workflows.view", "workflows.manage", "templates.manage", "campaigns.manage", "forms.manage", "reviews.manage", "calls.view", "analytics.export",
] as const satisfies readonly Permission[];
export type DelegablePermission = (typeof DELEGABLE_PERMISSIONS)[number];
/** Plain-language names for the permissions that can be adjusted per person, grouped as the Team & Permissions screen shows them. */
export const DELEGABLE_PERMISSION_INFO: Record<DelegablePermission, { label: string; group: "Contacts" | "Sales" | "Calendar" | "Work" | "Messaging" | "Automation" | "Reporting" }> = {
  "contacts.view": { label: "See contacts", group: "Contacts" },
  "contacts.create": { label: "Create contacts", group: "Contacts" },
  "contacts.edit": { label: "Edit contacts", group: "Contacts" },
  "contacts.assign": { label: "Assign contacts and deals to others", group: "Contacts" },
  "contacts.merge": { label: "Merge duplicate contacts", group: "Contacts" },
  "contacts.delete": { label: "Archive and delete contacts", group: "Contacts" },
  "contacts.import": { label: "Import spreadsheets", group: "Contacts" },
  "contacts.export": { label: "Export contacts", group: "Contacts" },
  "contacts.bulk": { label: "Change many records at once", group: "Contacts" },
  "companies.view": { label: "See companies", group: "Contacts" },
  "companies.create": { label: "Create companies", group: "Contacts" },
  "companies.edit": { label: "Edit companies", group: "Contacts" },
  "companies.delete": { label: "Archive and delete companies", group: "Contacts" },
  "tags.manage": { label: "Create, rename and merge tags", group: "Contacts" },
  "fields.manage": { label: "Manage custom fields", group: "Contacts" },
  "smartlists.share": { label: "Share Smart Lists with the team", group: "Contacts" },
  "sales.view": { label: "See pipelines and deals", group: "Sales" },
  "pipelines.manage": { label: "Change pipelines and stages", group: "Sales" },
  "opportunities.create": { label: "Create deals", group: "Sales" },
  "opportunities.edit": { label: "Edit and move deals", group: "Sales" },
  "opportunities.reopen": { label: "Reopen closed deals", group: "Sales" },
  "opportunities.delete": { label: "Archive deals", group: "Sales" },
  "appointments.view": { label: "See appointments", group: "Calendar" },
  "appointments.book": { label: "Book appointments", group: "Calendar" },
  "appointments.manage": { label: "Reschedule and cancel appointments", group: "Calendar" },
  "calendars.manage": { label: "Set up calendars and booking pages", group: "Calendar" },
  "calendars.connect": { label: "Connect a personal calendar", group: "Calendar" },
  "tasks.manage": { label: "Create and complete tasks", group: "Work" },
  "notes.write": { label: "Write notes", group: "Work" },
  "inbox.view_all": { label: "See every conversation", group: "Messaging" },
  "inbox.view": { label: "See assigned conversations", group: "Messaging" },
  "inbox.reply": { label: "Reply to conversations", group: "Messaging" },
  "inbox.notes": { label: "Add internal conversation notes", group: "Messaging" },
  "inbox.assign": { label: "Assign conversations", group: "Messaging" },
  "workflows.view": { label: "See automations", group: "Automation" },
  "workflows.manage": { label: "Build and change automations", group: "Automation" },
  "templates.manage": { label: "Manage message templates", group: "Automation" },
  "campaigns.manage": { label: "Prepare campaigns", group: "Automation" },
  "forms.manage": { label: "Build forms", group: "Automation" },
  "reviews.manage": { label: "Manage review requests", group: "Automation" },
  "calls.view": { label: "See call records", group: "Reporting" },
  "analytics.export": { label: "Export reports", group: "Reporting" },
};

/**
 * Action permissions the agency Super Admin may customize for a Manager or Staff account.
 * This deliberately excludes owner/security, billing, credential, Hermes policy, bulk-send and
 * provider-switch controls. Every entry is backed by a database or server authorization check.
 */
export const AGENCY_TEAM_MANAGED_PERMISSIONS = [
  ...AGENCY_DELEGABLE_PERMISSIONS,
  ...AGENCY_TEAM_OPERATIONAL_PERMISSIONS,
  "crm.view",
  "setup.manage",
  "projects.view",
  "projects.manage",
  "quotes.manage",
  "website.view",
  "website.publish",
  "website.create",
  "website.edit",
  "website.domains",
  "website.review",
  "website.archive",
] as const satisfies readonly Permission[];

export type AgencyTeamPermission = (typeof AGENCY_TEAM_MANAGED_PERMISSIONS)[number];

const AGENCY_TEAM_EXTRA_PERMISSION_INFO = {
  "crm.view": { label: "Open Native CRM", group: "Native CRM", note: "CRM access requires an active, audited support session and client scope." },
  "setup.manage": { label: "Manage Setup Center operations", group: "Setup Center" },
  "projects.view": { label: "View client projects", group: "Projects and quotes" },
  "projects.manage": { label: "Manage client projects and updates", group: "Projects and quotes" },
  "quotes.manage": { label: "Prepare and manage client quotes", group: "Projects and quotes" },
  "website.view": { label: "View Website Studio", group: "Website Studio" },
  "website.publish": { label: "Publish client websites", group: "Website Studio", note: "Website Studio's client review and publishing checks still apply." },
  "website.create": { label: "Create client websites", group: "Website Studio", note: "Creates a private first draft; client scope and template availability still apply." },
  "website.edit": { label: "Edit client websites", group: "Website Studio", note: "Client scope and website resource checks still apply." },
  "website.domains": { label: "Manage client website domains", group: "Website Studio", note: "Client scope and domain verification checks still apply." },
  "website.review": { label: "Review client websites", group: "Website Studio", note: "Client scope and website review workflow checks still apply." },
  "website.archive": { label: "Archive and restore client websites", group: "Website Studio", note: "Archiving takes a site offline; it is reversible and does not delete content." },
} as const satisfies Record<
  Exclude<AgencyTeamPermission, AgencyPermission | DelegablePermission>,
  { label: string; group: string; note?: string }
>;

export const AGENCY_TEAM_PERMISSION_INFO = {
  ...AGENCY_PERMISSION_INFO,
  ...DELEGABLE_PERMISSION_INFO,
  ...AGENCY_TEAM_EXTRA_PERMISSION_INFO,
} as const satisfies Record<AgencyTeamPermission, { label: string; group: string; note?: string }>;

export type AgencyTeamProtectedPermission = Exclude<Permission, AgencyTeamPermission>;

/** Permissions shown on agency member details but intentionally controlled by role or client-level policy. */
export const AGENCY_TEAM_PROTECTED_PERMISSION_INFO = {
  "workspace.view": { label: "View client workspace", group: "Workspace", note: "Client scope and resource access still apply." },
  "workspace.manage_profile": { label: "Edit client workspace profile", group: "Workspace", note: "Client owner or agency role control." },
  "team.view": { label: "View client team", group: "Team and access", note: "Client scope and resource access still apply." },
  "team.manage": { label: "Manage client users and roles", group: "Team and access", note: "Client owner or agency role control." },
  "agents.use": { label: "Use client AI agents", group: "AI workforce", note: "Agent availability and client policy still apply." },
  "agents.configure": { label: "Configure client AI agents", group: "AI workforce", note: "Client owner control." },
  "knowledge.view": { label: "View shared knowledge", group: "Knowledge", note: "Client scope and resource access still apply." },
  "knowledge.edit": { label: "Edit shared knowledge", group: "Knowledge", note: "Client owner or agency role control." },
  "leads.view": { label: "View leads", group: "Leads", note: "Client scope and resource access still apply." },
  "leads.research": { label: "Research leads", group: "Leads", note: "Client owner control." },
  "leads.review": { label: "Review leads", group: "Leads", note: "Client owner control." },
  "leads.export": { label: "Export leads", group: "Leads", note: "Client owner control." },
  "retention.view": { label: "View retention programs", group: "Retention", note: "Client scope and resource access still apply." },
  "retention.edit": { label: "Edit retention programs", group: "Retention", note: "Client owner or agency role control." },
  "retention.activate": { label: "Activate retention programs", group: "Retention", note: "Requires client owner approval." },
  "analytics.view": { label: "View analytics", group: "Reports", note: "Client scope and resource access still apply." },
  "approvals.view": { label: "View approvals", group: "Approvals", note: "Client scope and resource access still apply." },
  "approvals.decide": { label: "Review and decide approvals", group: "Approvals", note: "Client owner or agency role control." },
  "approvals.decide_high": { label: "Approve high impact actions", group: "Approvals", note: "Reserved for the client owner." },
  "activity.view": { label: "View client activity log", group: "Security and activity", note: "Client scope and resource access still apply." },
  "integrations.view": { label: "View client integrations", group: "Integrations", note: "Client scope and resource access still apply." },
  "usage.view": { label: "View client usage", group: "Usage and billing", note: "Client scope and resource access still apply." },
  "billing.view": { label: "View client billing", group: "Usage and billing", note: "Client billing rules still apply." },
  "support.use": { label: "Use client support tools", group: "Support", note: "Client scope and support workflow rules still apply." },
  "setup.view": { label: "View setup tasks", group: "Setup Center", note: "Client scope and resource access still apply." },
  "setup.respond": { label: "Respond to setup requests", group: "Setup Center", note: "Client owner or agency role control." },
  "setup.activate": { label: "Activate completed setup", group: "Setup Center", note: "Super Admin approval is required." },
  "projects.request": { label: "Request client work", group: "Projects and quotes", note: "Client owner or agency role control." },
  "projects.approve_quote": { label: "Approve client quotes", group: "Projects and quotes", note: "Reserved for the client owner." },
  "catalog.manage": { label: "Manage service catalog", group: "Agency operations", note: "Super Admin only." },
  "portfolio.manage": { label: "Manage agency portfolio", group: "Agency operations", note: "Super Admin only." },
  "maintenance.view": { label: "View maintenance plans", group: "Maintenance", note: "Client scope and resource access still apply." },
  "maintenance.request": { label: "Request maintenance", group: "Maintenance", note: "Client owner or agency role control." },
  "maintenance.manage_plan": { label: "Manage maintenance plan", group: "Maintenance", note: "Reserved for the client owner." },
  "maintenance.manage": { label: "Operate maintenance service", group: "Maintenance", note: "Client scope and agency role control." },
  "automation.pause": { label: "Pause client automation", group: "Automation", note: "Client owner or agency role control." },
  "automation.go_autonomous": { label: "Enable autonomous AI actions", group: "Automation", note: "Reserved for the client owner." },
  "inbox.resume_ai": { label: "Resume AI replies", group: "Inbox and messaging", note: "Client inbox rules and conversation access still apply." },
  "escalations.respond": { label: "Respond to escalations", group: "Escalations", note: "Client escalation policy still applies." },
  "escalations.configure": { label: "Configure escalation rules", group: "Escalations", note: "Client owner or agency role control." },
  "messaging.configure": { label: "Configure messaging", group: "Messaging", note: "Client owner or agency role control." },
  "consent.manage": { label: "Manage contact consent", group: "Privacy and consent", note: "Client owner or agency role control." },
  "staff.availability": { label: "Manage staff availability", group: "Team and access", note: "Client team membership rules still apply." },
  "credits.topup": { label: "Add client credits", group: "Usage and billing", note: "Client owner or agency role control." },
  "billing.configure": { label: "Configure client billing", group: "Usage and billing", note: "Client owner or agency role control." },
  "billing.agency_view": { label: "View agency billing", group: "Agency security", note: "Agency role control." },
  "billing.agency_manage": { label: "Manage agency billing", group: "Agency security", note: "Super Admin only." },
  "calendars.connect": { label: "Connect a personal calendar", group: "Calendar", note: "This connection is not available through agency support access; use the person's client workspace account." },
  "website.approve": { label: "Approve website changes", group: "Website Studio", note: "Reserved for the client owner." },
  "website.templates.design": { label: "Design shared Website Studio templates", group: "Website Studio", note: "Agency role default; shared templates remain agency-controlled." },
  "website.templates.publish": { label: "Publish shared Website Studio templates", group: "Website Studio", note: "Super Admin only." },
  "incidents.view": { label: "View service incidents", group: "Incidents", note: "Client scope and incident visibility still apply." },
  "incidents.manage": { label: "Manage service incidents", group: "Incidents", note: "Agency role and client scope still apply." },
  "offboarding.view": { label: "View offboarding status", group: "Offboarding", note: "Client owner or agency role control." },
  "offboarding.request": { label: "Request client offboarding", group: "Offboarding", note: "Reserved for the client owner." },
  "offboarding.manage": { label: "Manage client offboarding", group: "Offboarding", note: "Super Admin only." },
  "data.export": { label: "Export all client data", group: "Data and security", note: "Client owner or Super Admin control." },
  "finance.manage": { label: "Manage agency finance", group: "Agency security", note: "Super Admin only." },
  "campaigns.send": { label: "Send bulk campaigns", group: "Campaigns and messaging", note: "Reserved for the client owner." },
  "crm.provider.manage": { label: "Switch client CRM provider", group: "Native CRM", note: "Reserved for the client owner." },
  "crm.api.manage": { label: "Manage client CRM API connection", group: "Native CRM", note: "Client owner or agency role control." },
  "crm.permissions.manage": { label: "Manage client CRM roles", group: "Native CRM", note: "Client owner or agency role control." },
  "crm.blueprints.view": { label: "View CRM Blueprints", group: "Native CRM", note: "Agency role control." },
  "crm.blueprints.design": { label: "Design CRM Blueprints", group: "Native CRM", note: "Agency role control." },
  "crm.blueprints.publish": { label: "Publish CRM Blueprints", group: "Native CRM", note: "Super Admin only." },
  "crm.blueprints.apply": { label: "Apply CRM Blueprints to clients", group: "Native CRM", note: "Super Admin only." },
  "agency.team.manage": { label: "Manage agency team and permissions", group: "Agency security", note: "Super Admin only." },
  "agency.tool_policies.view": { label: "View Hermes tool policies", group: "AI workforce", note: "Agency role control." },
  "agency.tool_policies.manage": { label: "Edit Hermes tool policies", group: "AI workforce", note: "Super Admin only." },
  "agency.integrations.health": { label: "View integration health", group: "Integrations", note: "Agency role control." },
  "agency.integrations.manage": { label: "Manage integrations and credentials", group: "Integrations", note: "Super Admin only." },
  "agency.security.manage": { label: "Change agency security settings", group: "Agency security", note: "Super Admin only." },
  "agency.billing.manage": { label: "Manage agency billing and pricing", group: "Agency security", note: "Super Admin only." },
  "agency.settings.manage": { label: "Change agency-wide settings", group: "Agency security", note: "Super Admin only." },
  "agency.audit.view": { label: "Review agency audit history", group: "Agency security", note: "Super Admin only." },
  "agency.workforce.full_capabilities.acknowledge": { label: "Authorize full capabilities for internal Hermes profiles", group: "AI workforce", note: "Super Admin only." },
} as const satisfies Record<AgencyTeamProtectedPermission, { label: string; group: string; note: string }>;

export const AGENCY_TEAM_PROTECTED_PERMISSIONS = Object.keys(AGENCY_TEAM_PROTECTED_PERMISSION_INFO) as AgencyTeamProtectedPermission[];

export type AgencyPermissionOverrides = Partial<Record<AgencyTeamPermission, "allow" | "deny">>;

/** Client CRM defaults available only inside an active, audited agency support session. */
export const AGENCY_SUPPORT_SESSION_ROLE_DEFAULTS = {
  agency_staff: ["crm.view", "contacts.view", "companies.view", "inbox.view", "inbox.view_all", "workflows.view", "calls.view"],
  agency_manager: ["crm.view", "contacts.view", "companies.view", "inbox.view", "inbox.view_all", "workflows.view", "calls.view"],
} as const satisfies Record<"agency_staff" | "agency_manager", readonly Permission[]>;

export const isAgencyTeamPermission = (p: unknown): p is AgencyTeamPermission =>
  typeof p === "string" && (AGENCY_TEAM_MANAGED_PERMISSIONS as readonly string[]).includes(p);

/** Agency overrides are separate from client member overrides and can never modify a Super Admin. */
export function effectiveAgencyTeamPermission(
  role: PlatformRole | null | undefined,
  permission: AgencyTeamPermission,
  overrides?: AgencyPermissionOverrides,
): boolean {
  if (!role || role === "none") return false;
  if (role === "agency_super_admin") return roleHasPermission(role, permission);
  const override = overrides?.[permission];
  if (override) return override === "allow";
  return roleHasPermission(role, permission);
}

export const isDelegablePermission = (p: unknown): p is DelegablePermission => typeof p === "string" && (DELEGABLE_PERMISSIONS as readonly string[]).includes(p);

/** Plain-language explanation for a disabled control protected by a delegable permission. */
export function permissionNeeded(action: string, permission: DelegablePermission): string {
  return `${action} needs the “${DELEGABLE_PERMISSION_INFO[permission].label}” permission, which the ${ROLE_LABELS.owner.toLowerCase()} or a ${ROLE_LABELS.admin.toLowerCase()} can give you.`;
}

export type PermissionOverrides = Partial<Record<Permission, "grant" | "revoke">>;

/** A member's effective permissions: the role's, adjusted by any per-person overrides. Owners are never overridden. */
export function effectivePermission(role: EffectiveRole | null | undefined, permission: Permission, overrides?: PermissionOverrides): boolean {
  if (!role) return false;
  const override = role === "owner" ? undefined : overrides?.[permission];
  if (override && isDelegablePermission(permission)) return override === "grant";
  return roleHasPermission(role, permission);
}

/** Default agency-role permission, excluding per-user overrides (which are server-resolved). */
export function agencyRoleHasPermission(role: PlatformRole, permission: AgencyPermission): boolean {
  return role !== "none" && roleHasPermission(role, permission);
}

/** Which tenant roles a person with `actor` role may grant to others. */
export function grantableRoles(actor: EffectiveRole): OrgRole[] {
  if (actor === "owner" || actor === "agency_super_admin") return [...ORG_ROLES];
  if (actor === "admin") return ORG_ROLES.filter((role) => role !== "owner");
  return [];
}

export const isOrgRole = (value: unknown): value is OrgRole => typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
