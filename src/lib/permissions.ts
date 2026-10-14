// Mirrors the role_permissions seed in supabase/migrations. tests/workforce-config.test.ts compares this
// matrix with the migrated database and fails if the two drift apart.
// The UI uses this only to decide what to show; the server and database enforce access.
//
// Client roles: owner = Business Owner, admin = Manager, member = Team member (earlier, general role),
// sales_rep, support, viewer. Agency roles are a separate access model and never appear as a client role.

export const ORG_ROLES = ["owner", "admin", "member", "sales_rep", "support", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export type PlatformRole = "none" | "agency_staff" | "agency_super_admin";
export type EffectiveRole = OrgRole | "agency_staff" | "agency_super_admin";

const row = (...roles: EffectiveRole[]): readonly EffectiveRole[] => roles;
const CLIENT = ["owner", "admin", "member", "sales_rep", "support", "viewer"] as const;
/** Everyone who works conversations and records, as opposed to read-only viewers. */
const WORKING = ["owner", "admin", "member", "sales_rep", "support"] as const;
const OWNER_ADMIN = ["owner", "admin"] as const;
const STAFF = ["agency_staff", "agency_super_admin"] as const;

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
  "appointments.manage": row(...OWNER_ADMIN),
  "appointments.book": row(...WORKING),
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
  "inbox.view": row(...CLIENT),
  "inbox.view_all": row(...OWNER_ADMIN),
  "inbox.reply": row(...WORKING),
  "inbox.assign": row(...OWNER_ADMIN),
  "inbox.notes": row(...WORKING),
  "inbox.resume_ai": row("owner", "admin", "sales_rep", "support"),
  "escalations.respond": row("owner", "admin", "sales_rep", "support"),
  "escalations.configure": row(...OWNER_ADMIN),
  "contacts.view": row(...CLIENT),
  "contacts.edit": row(...WORKING),
  "contacts.merge": row(...OWNER_ADMIN),
  "messaging.configure": row(...OWNER_ADMIN),
  "consent.manage": row(...OWNER_ADMIN),
  "staff.availability": row(...WORKING),
  "credits.topup": row(...OWNER_ADMIN),
  "billing.configure": row(...OWNER_ADMIN),
  "billing.agency_view": row(...STAFF),
  "billing.agency_manage": row("agency_super_admin"),
  // Website Studio. Anyone on the team can see the site; editing and domains are owner/manager (agency staff help build);
  // approval is the owner's; publishing is the owner's or a super admin acting for a managed client.
  "website.view": row(...CLIENT, ...STAFF),
  "website.edit": row(...OWNER_ADMIN, ...STAFF),
  "website.domains": row(...OWNER_ADMIN, ...STAFF),
  "website.approve": row("owner"),
  "website.publish": row("owner", "agency_super_admin"),
  // Service incidents. Clients see only the ones marked client-visible; agency staff acknowledge, annotate and close them.
  "incidents.view": row(...OWNER_ADMIN, ...STAFF),
  "incidents.manage": row(...STAFF),
  // Leaving iAcquire. The owner can see the status, ask to leave and take their data; agency super admins run the shutdown and the deletion.
  "offboarding.view": row("owner", ...STAFF),
  "offboarding.request": row("owner"),
  "offboarding.manage": row("agency_super_admin"),
  "data.export": row("owner", "agency_super_admin"),
  "finance.manage": row("agency_super_admin"),
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
  agency_staff: "Agency Staff",
  agency_super_admin: "Agency Super Admin",
};

export const ROLE_DESCRIPTIONS: Record<OrgRole, string> = {
  owner: "Full control, including billing, autonomous mode and the final say on escalations.",
  admin: "Runs the workspace day to day: team, AI settings, inbox and approvals.",
  member: "General teammate: works with the AI team, notes and tasks. Earlier role, kept for existing members.",
  sales_rep: "Takes sales conversations and ready-to-close leads.",
  support: "Handles customer questions, complaints and service requests.",
  viewer: "Read-only access to leads, appointments, reports and conversations assigned to them.",
};

/** Roles offered in the invite picker. The earlier general role stays valid for existing members and API callers. */
export const INVITABLE_ROLES: readonly OrgRole[] = ["admin", "sales_rep", "support", "viewer"];

/** Which tenant roles a person with `actor` role may grant to others. */
export function grantableRoles(actor: EffectiveRole): OrgRole[] {
  if (actor === "owner" || actor === "agency_super_admin") return [...ORG_ROLES];
  if (actor === "admin") return ORG_ROLES.filter((role) => role !== "owner");
  return [];
}

export const isOrgRole = (value: unknown): value is OrgRole => typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
