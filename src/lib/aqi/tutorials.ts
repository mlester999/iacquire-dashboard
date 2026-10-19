import type { CrmCapability } from "@/lib/crm/types";
import { ORG_ROLES, ROLE_LABELS, roleHasPermission, type EffectiveRole, type Permission } from "@/lib/permissions";
import { classifyAqiIntent } from "@/lib/aqi/intent";
import { approvedTutorialRoute, getAqiTarget, routeInTarget } from "@/lib/aqi/targets";

export const AQI_TUTORIAL_STEP_LIMIT = 12;

export type AqiTutorialAdvance = "next" | "click";
/**
 * Completion semantics:
 * - `finish`: the person reached the end. This is a walkthrough completion, never a business action.
 * - `route`: the real destination was reached. This verifies navigation only.
 * - `contact_created`: the destination matched AND the server found a contact created during this
 *   attempt. Only this kind can set `verified` on progress.
 */
export type AqiTutorialCompletion =
  | { kind: "finish" }
  | { kind: "route"; pattern: string }
  | { kind: "contact_created"; pattern: string };

export interface AqiTutorialStep {
  key: string;
  title: string;
  body: string;
  targetId: string | null;
  route: string | null;
  advance?: AqiTutorialAdvance;
  optional?: boolean;
}

export interface AqiTutorialDefinition {
  title: string;
  description: string;
  category: string;
  roles: string[];
  routePrefix: string;
  priority: number;
  steps: AqiTutorialStep[];
  completion: AqiTutorialCompletion;
  aliases: string[];
  keywords: string[];
  requiresCrm?: { capability: CrmCapability; provider: "native" | "ghl" };
}

export interface AqiStarterTutorial {
  slug: string;
  definition: AqiTutorialDefinition;
}

export type AqiTutorialStatus = "draft" | "published" | "archived";
export type AqiProgressStatus = "in_progress" | "paused" | "completed" | "exited" | "unavailable";

export interface AqiTutorialSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  routePrefix: string;
  roles: string[];
  priority: number;
  version: number;
  versionId: string;
  stepCount: number;
  estimatedMinutes: number;
  requiresCrm?: { capability: CrmCapability; provider: "native" | "ghl" };
  aliases: string[];
  keywords: string[];
}

export interface AqiTutorialView extends AqiTutorialSummary {
  steps: AqiTutorialStep[];
  completion: AqiTutorialCompletion;
}

export interface AqiTutorialProgressView {
  tutorialId: string;
  slug: string;
  title: string;
  status: AqiProgressStatus;
  currentStep: number;
  stepCount: number;
  tutorialVersion: number;
  publishedVersion: number;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  verified: boolean;
  versionChanged: boolean;
}

const AGENCY_ROLES = ["agency_staff", "agency_manager", "agency_super_admin"] as const;
export const AQI_TUTORIAL_ROLES = [...ORG_ROLES, ...AGENCY_ROLES] as const;
export type AqiTutorialRole = (typeof AQI_TUTORIAL_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(AQI_TUTORIAL_ROLES);

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanPlainText(value: string): boolean {
  // Tutorial copy is plain text. It can never carry markup, a script or a selector.
  return !/[<>]/.test(value) && !/javascript:/i.test(value) && !/\bon[a-z]+\s*=/i.test(value);
}

/** Converts `/crm/contacts/:id` into an anchored matcher. Only path characters are accepted. */
export function compileCompletionPattern(pattern: string): RegExp | null {
  if (!/^\/[a-z0-9/:_-]*$/i.test(pattern) || pattern.includes("//")) return null;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:id/g, "[0-9a-f-]{8,}");
  return new RegExp(`^${escaped}/?$`, "i");
}

export function tutorialCompletionMatches(completion: AqiTutorialCompletion, pathname: string | null): boolean {
  if (completion.kind === "finish" || !pathname) return false;
  const matcher = compileCompletionPattern(completion.pattern);
  return Boolean(matcher && matcher.test(pathname.split("?")[0].split("#")[0]));
}

/** Extracts the `:id` segment of an approved completion pattern without trusting any other path text. */
export function completionIdFromPath(pattern: string, pathname: string | null): string | null {
  if (!pathname || !pattern.includes(":id")) return null;
  const clean = pathname.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const prefix = pattern.slice(0, pattern.indexOf(":id"));
  if (!clean.startsWith(prefix)) return null;
  const id = clean.slice(prefix.length).split("/")[0];
  return /^[0-9a-f-]{8,}$/i.test(id) ? id : null;
}

export interface TutorialValidation {
  errors: string[];
  warnings: string[];
}

function stepRouteValid(step: AqiTutorialStep): boolean {
  if (step.route === null) return true;
  return Boolean(approvedTutorialRoute(step.route));
}

/**
 * Server-side validation used before a draft can be published and when a seeded tutorial is loaded.
 * It never executes a selector: every target must exist in the code registry.
 */
export function validateTutorialDefinition(def: AqiTutorialDefinition): TutorialValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const title = text(def.title, 120);
  const description = text(def.description, 400);
  const category = text(def.category, 60);
  if (!title) errors.push("Give the tutorial a title.");
  if (!description) errors.push("Write a short description.");
  if (!category) errors.push("Choose a category.");
  if (!cleanPlainText(title) || !cleanPlainText(description)) errors.push("Title and description must be plain text.");
  if (!/^\/[a-z0-9/_-]*$/.test(def.routePrefix ?? "")) errors.push("The starting route must be an internal path such as /crm/contacts.");
  else if (!approvedTutorialRoute(def.routePrefix)) errors.push(`The starting route ${def.routePrefix} is not in the approved route registry.`);
  if (!Number.isInteger(def.priority) || def.priority < 0 || def.priority > 9999) errors.push("Priority must be a whole number between 0 and 9999.");
  if (!Array.isArray(def.roles) || def.roles.some((role) => !ROLE_SET.has(role))) errors.push("One or more selected roles are not valid iAcquireOS roles.");
  if (!Array.isArray(def.aliases) || def.aliases.length > 20 || def.aliases.some((alias) => typeof alias !== "string" || alias.length > 80 || !cleanPlainText(alias))) errors.push("Aliases must be up to 20 short plain-text phrases.");
  if (!Array.isArray(def.keywords) || def.keywords.length > 30 || def.keywords.some((word) => typeof word !== "string" || word.length > 40 || !cleanPlainText(word))) errors.push("Keywords must be up to 30 short plain-text words.");
  if (!Array.isArray(def.steps) || def.steps.length < 1 || def.steps.length > AQI_TUTORIAL_STEP_LIMIT) errors.push(`A tutorial needs between 1 and ${AQI_TUTORIAL_STEP_LIMIT} steps.`);
  if (def.completion?.kind !== "finish" && def.completion?.kind !== undefined && !compileCompletionPattern(def.completion.pattern)) {
    errors.push("The completion route pattern is invalid.");
  }
  if (def.completion?.kind === "contact_created") {
    if (!def.completion.pattern.includes(":id")) errors.push("A created-contact completion must include :id in its route pattern.");
    if (!def.completion.pattern.startsWith("/crm/contacts/")) errors.push("A created-contact completion must use a Contacts detail route.");
  }
  if (def.requiresCrm && (!(def.requiresCrm.capability in CRM_CAPABILITY_NAMES) || !["native", "ghl"].includes(def.requiresCrm.provider))) errors.push("The CRM requirement is invalid.");
  if (def.roles.some((role) => role.startsWith("agency_")) && def.roles.some((role) => !role.startsWith("agency_"))) {
    warnings.push("This tutorial mixes client and agency roles. Check that its routes work in both shells.");
  }

  const keys = new Set<string>();
  const targetUse = new Map<string, number>();
  for (const [index, step] of (def.steps ?? []).entries()) {
    const label = `Step ${index + 1}`;
    if (!step || typeof step !== "object") {
      errors.push(`${label} is invalid.`);
      continue;
    }
    if (!/^[a-z0-9-]{1,40}$/.test(step.key ?? "")) errors.push(`${label} needs a stable key (lowercase letters, numbers and dashes).`);
    if (keys.has(step.key)) errors.push(`${label} repeats the key “${step.key}”.`);
    keys.add(step.key);
    if (!text(step.title, 120)) errors.push(`${label} needs a title.`);
    if (!text(step.body, 600)) errors.push(`${label} needs instructions.`);
    if (!cleanPlainText(step.title ?? "") || !cleanPlainText(step.body ?? "")) errors.push(`${label} must be plain text without markup.`);
    if (step.advance && !["next", "click"].includes(step.advance)) errors.push(`${label} has an invalid advance mode.`);
    if (step.route !== null && !stepRouteValid(step)) errors.push(`${label} points at a route that is not in the approved registry.`);
    if (step.targetId) {
      const target = getAqiTarget(step.targetId);
      if (!target) {
        errors.push(`${label} references an unknown highlight target. Choose one from the approved target registry.`);
        continue;
      }
      targetUse.set(target.id, (targetUse.get(target.id) ?? 0) + 1);
      if (!routeInTarget(target, step.route)) errors.push(`${label} targets “${target.label}”, which is not available on ${step.route ?? "that route"}.`);
      if (target.permission) {
        const roles = def.roles.length ? def.roles : [...ORG_ROLES];
        const allowed = roles.some((role) => roleHasPermission(role as EffectiveRole, target.permission as Permission));
        if (!allowed) errors.push(`${label} needs the “${target.label}” control, but no selected role has ${target.permission}.`);
      }
      if (target.agency === "super_admin" && def.roles.length && def.roles.some((role) => !role.startsWith("agency_"))) {
        errors.push(`${label} targets a Super Admin-only control in a client tutorial.`);
      }
    } else if (!step.optional) {
      warnings.push(`${label} has no highlight target and will be shown as a centered instruction.`);
    }
  }
  for (const [targetId, count] of targetUse) {
    if (count > 1) warnings.push(`The target “${getAqiTarget(targetId)?.label ?? targetId}” is used in ${count} steps.`);
  }
  if (def.steps?.length && def.steps[def.steps.length - 1]?.optional) warnings.push("The final step is marked optional; users can finish without completing it.");

  const seenRoutes = new Set<string>();
  for (const step of def.steps ?? []) {
    if (step.route) seenRoutes.add(step.route);
  }
  if (seenRoutes.size > 1) {
    // Multi-page tutorials are supported; this is a reminder, not an error.
    warnings.push("This tutorial spans several pages. Each step will offer explicit navigation and wait for the real page.");
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

const CRM_CAPABILITY_NAMES: Record<string, true> = {
  contacts: true,
  companies: true,
  opportunities: true,
  appointments: true,
  inbox: true,
  workflows: true,
  calls: true,
  campaigns: true,
};

const CLIENT_WORKING = ["owner", "admin", "member", "sales_rep", "support", "appointment_setter"];

export const STARTER_TUTORIALS: AqiStarterTutorial[] = [
  {
    slug: "getting-started",
    definition: {
      title: "Getting started with iAcquireOS",
      description: "A short tour of the workspace, your AI team and where to get help.",
      category: "Getting started",
      roles: [],
      routePrefix: "/overview",
      priority: 10,
      aliases: ["get started", "getting started", "new to iacquireos", "quick tour", "platform tour", "show me around"],
      keywords: ["tour", "welcome", "overview", "dashboard", "start", "navigation"],
      steps: [
        { key: "overview", title: "This is your workspace", body: "Overview brings your pipeline, appointments and AI team together. Every number here comes from real workspace data.", targetId: "overview.hero", route: "/overview" },
        { key: "metrics", title: "The numbers that matter", body: "These tiles show what needs attention right now. Select a tile to open the page behind it.", targetId: "overview.kpis", route: "/overview" },
        { key: "workforce-nav", title: "Meet your AI team", body: "AI Workforce is where your employees live. Select it in the navigation to continue.", targetId: "nav.workforce", route: null, advance: "click" },
        { key: "gallery", title: "Your employees", body: "Each employee has a role, a status and its own knowledge. Open an employee to chat or review its configuration.", targetId: "workforce.gallery", route: "/workforce" },
        { key: "support-nav", title: "Help is always available", body: "Support is in the navigation. Select it to see how to reach the iAcquire team.", targetId: "nav.support", route: null, advance: "click" },
        { key: "support", title: "Start a real conversation", body: "This is the real Support page. A request is only created when you send it; AQi cannot create one for you.", targetId: "support.new-ticket", route: "/support" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "navigate-dashboard",
    definition: {
      title: "Navigating your dashboard",
      description: "Understand the overview tiles, next actions and AI team panel.",
      category: "Getting started",
      roles: [],
      routePrefix: "/overview",
      priority: 20,
      aliases: ["navigate the dashboard", "dashboard tour", "where is everything", "understand the dashboard"],
      keywords: ["dashboard", "overview", "metrics", "navigation", "tiles"],
      steps: [
        { key: "kpis", title: "Start with the tiles", body: "Each tile is a real count. A dash means the data source is not connected yet, not zero.", targetId: "overview.kpis", route: "/overview" },
        { key: "actions", title: "Then check next actions", body: "This panel lists the most useful next steps for this workspace right now.", targetId: "overview.next-actions", route: "/overview" },
        { key: "team", title: "Your AI team is one click away", body: "Open an employee to chat, or use Manage to review the whole workforce.", targetId: "overview.ai-team", route: "/overview" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "create-contact",
    definition: {
      title: "Adding your first contact",
      description: "Open Contacts, start a new contact and review the real form. AQi never submits it for you.",
      category: "CRM",
      roles: CLIENT_WORKING,
      routePrefix: "/crm/contacts",
      priority: 30,
      aliases: ["add a contact", "create a contact", "new contact", "adding a contact", "add contact"],
      keywords: ["contact", "contacts", "crm", "add", "create"],
      requiresCrm: { capability: "contacts", provider: "native" },
      steps: [
        { key: "contacts-nav", title: "Open Contacts", body: "Contacts is under CRM in the navigation. Select it to continue.", targetId: "nav.crm.contacts", route: null, advance: "click" },
        { key: "new-contact", title: "Start a new contact", body: "Select New contact. The form opens over the list without leaving the page.", targetId: "crm.contacts.new", route: "/crm/contacts", advance: "click" },
        { key: "first-name", title: "Enter the contact's details", body: "Start with a first name. Email and phone are optional, but a duplicate email or phone is flagged instead of creating a second record.", targetId: "crm.contact.first-name", route: "/crm/contacts" },
        { key: "save", title: "Save it yourself", body: "When you are ready, choose Add contact. AQi does not press this button or submit the form; the walkthrough completes only when the new contact page opens.", targetId: "crm.contact.save", route: "/crm/contacts" },
      ],
      completion: { kind: "contact_created", pattern: "/crm/contacts/:id" },
    },
  },
  {
    slug: "manage-leads",
    definition: {
      title: "Managing your leads",
      description: "Review researched leads, see their status and understand the review queue.",
      category: "CRM",
      roles: ["owner", "admin", "member", "sales_rep"],
      routePrefix: "/leads",
      priority: 40,
      aliases: ["manage leads", "review leads", "lead review", "where are my leads"],
      keywords: ["leads", "lead", "review", "research", "prospects"],
      steps: [
        { key: "leads-nav", title: "Open Leads", body: "Leads is in the main navigation. Select it to continue.", targetId: "nav.leads", route: null, advance: "click" },
        { key: "tabs", title: "Three lead views", body: "Review shows leads waiting for a decision, Researching shows requests in progress, and History keeps earlier decisions.", targetId: "leads.tabs", route: "/leads" },
        { key: "review", title: "Review queue", body: "Select a lead to see its evidence, approve it or reject it. Approving is a real decision and is recorded.", targetId: "leads.review-table", route: "/leads" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "use-pipelines",
    definition: {
      title: "Using pipelines and deals",
      description: "See how pipeline stages work and where a new deal starts.",
      category: "CRM",
      roles: ["owner", "admin", "member", "sales_rep", "appointment_setter"],
      routePrefix: "/crm/pipelines",
      priority: 50,
      aliases: ["create a pipeline", "use pipelines", "manage deals", "add a deal", "pipeline"],
      keywords: ["pipeline", "pipelines", "deal", "deals", "opportunity", "stage"],
      requiresCrm: { capability: "opportunities", provider: "native" },
      steps: [
        { key: "pipelines-nav", title: "Open Pipelines", body: "Pipelines is under CRM in the navigation. Select it to continue.", targetId: "nav.crm.pipelines", route: null, advance: "click" },
        { key: "board", title: "The board", body: "Each column is a stage. Cards can be moved only by people with deal permissions, and every move is recorded.", targetId: "crm.pipelines.board", route: "/crm/pipelines" },
        { key: "new-deal", title: "Start a deal", body: "New deal opens the deal form with the current pipeline selected. AQi will not create or move a deal for you.", targetId: "crm.pipelines.new-deal", route: "/crm/pipelines" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "manage-appointments-native",
    definition: {
      title: "Managing appointments",
      description: "Find the calendar, understand the views and where to book an appointment.",
      category: "Calendar",
      roles: CLIENT_WORKING,
      routePrefix: "/crm/calendar",
      priority: 60,
      aliases: ["manage appointments", "book an appointment", "appointments calendar", "schedule a meeting"],
      keywords: ["appointment", "appointments", "calendar", "booking", "schedule"],
      requiresCrm: { capability: "appointments", provider: "native" },
      steps: [
        { key: "calendar-nav", title: "Open the Calendar", body: "Calendar is under CRM in the navigation. Select it to continue.", targetId: "nav.crm.calendar", route: null, advance: "click" },
        { key: "grid", title: "Your real availability", body: "The calendar shows real bookings and busy time. AQi can explain a view but never changes an appointment.", targetId: "crm.calendar.grid", route: "/crm/calendar" },
        { key: "new", title: "Book only when you are ready", body: "New appointment opens the real booking form. AQi will not submit it.", targetId: "crm.calendar.new-appointment", route: "/crm/calendar" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "manage-appointments-external",
    definition: {
      title: "Managing connected appointments",
      description: "Find appointments that are managed by your connected calendar.",
      category: "Calendar",
      roles: CLIENT_WORKING,
      routePrefix: "/appointments",
      priority: 61,
      aliases: ["manage appointments", "appointments page", "book appointment"],
      keywords: ["appointment", "appointments", "calendar", "booking"],
      requiresCrm: { capability: "appointments", provider: "ghl" },
      steps: [
        { key: "appointments-nav", title: "Open Appointments", body: "Appointments is in the main navigation. Select it to continue.", targetId: "nav.appointments", route: null, advance: "click" },
        { key: "calendar", title: "Recorded meetings", body: "This calendar is driven by your connected calendar. A dash or empty month means no recorded meetings, not a hidden list.", targetId: "appointments.calendar", route: "/appointments" },
        { key: "book", title: "Book through iAcquire", body: "If you can book, this button opens the real booking form. Your Appointment Setter only offers availability your calendar reports.", targetId: "appointments.book", route: "/appointments" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "view-ai-employees",
    definition: {
      title: "Viewing your AI employees",
      description: "Meet the AI workforce, understand status and open an employee.",
      category: "AI workforce",
      roles: CLIENT_WORKING,
      routePrefix: "/workforce",
      priority: 70,
      aliases: ["view ai employees", "where are my ai employees", "ai workforce", "manage ai employees", "configure my ai employees"],
      keywords: ["ai", "employee", "employees", "workforce", "agent", "agents"],
      steps: [
        { key: "workforce-nav", title: "Open AI Workforce", body: "AI Workforce is in the main navigation. Select it to continue.", targetId: "nav.workforce", route: null, advance: "click" },
        { key: "gallery", title: "Six roles, real status", body: "Each card shows the employee's actual connection status. A paused or setup-required employee cannot chat.", targetId: "workforce.gallery", route: "/workforce" },
        { key: "employee", title: "Open an employee", body: "Select a card to chat, or use its configuration actions if your role allows it. AQi cannot change an employee for you.", targetId: "workforce.employee", route: "/workforce" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "find-integrations",
    definition: {
      title: "Finding your integrations",
      description: "See which services are connected and how to ask for a new connection.",
      category: "Account",
      roles: ["owner", "admin"],
      routePrefix: "/settings/integrations",
      priority: 80,
      aliases: ["manage integrations", "find integrations", "connect a service", "where are my integrations", "integration settings"],
      keywords: ["integration", "integrations", "connected", "connection", "service", "services"],
      steps: [
        { key: "settings-nav", title: "Open Settings", body: "Settings is in the navigation. Select it to continue.", targetId: "nav.settings", route: null, advance: "click" },
        { key: "integrations-nav", title: "Choose Integrations", body: "Integrations is in the settings navigation. Select it to see connection status.", targetId: "settings.integrations.nav", route: "/settings", advance: "click" },
        { key: "list", title: "What is connected", body: "Each card shows the real status and the last verification. A red or amber status means the connection needs attention.", targetId: "settings.integrations.list", route: "/settings/integrations" },
        { key: "request", title: "Need something connected?", body: "Use Request a connection to send the iAcquire team a real request. AQi cannot connect a service itself.", targetId: "settings.integrations.request", route: "/settings/integrations", optional: true },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "contact-support",
    definition: {
      title: "Contacting support",
      description: "Open Support, see existing conversations and start a real request.",
      category: "Support",
      roles: CLIENT_WORKING,
      routePrefix: "/support",
      priority: 90,
      aliases: ["contact support", "open support", "get help", "talk to a person", "raise a ticket"],
      keywords: ["support", "help", "ticket", "request", "team", "human"],
      steps: [
        { key: "support-nav", title: "Open Support", body: "Support is in the navigation. Select it to continue.", targetId: "nav.support", route: null, advance: "click" },
        { key: "list", title: "Your conversations", body: "Existing requests and their replies appear here. Select one to read the thread.", targetId: "support.ticket-list", route: "/support", optional: true },
        { key: "new", title: "Start a request", body: "New request opens the real form. AQi never claims a ticket exists until the Support system returns a reference.", targetId: "support.new-ticket", route: "/support" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "invite-team-member",
    definition: {
      title: "Inviting a team member",
      description: "Find the invite panel and understand what the invitation does.",
      category: "Account",
      roles: ["owner", "admin"],
      routePrefix: "/settings/team",
      priority: 100,
      aliases: ["invite a team member", "invite a teammate", "add a user", "invite someone"],
      keywords: ["invite", "team", "member", "teammate", "user", "role"],
      steps: [
        { key: "settings-nav", title: "Open Settings", body: "Settings is in the navigation. Select it to continue.", targetId: "nav.settings", route: null, advance: "click" },
        { key: "team-nav", title: "Choose Team", body: "Team is in the settings navigation. Select it to continue.", targetId: "settings.team.nav", route: "/settings", advance: "click" },
        { key: "invite", title: "The invite panel", body: "Enter the person's email and choose the role they should have. Roles control what the server allows.", targetId: "settings.team.invite", route: "/settings/team" },
        { key: "email", title: "Their email", body: "Use the address they will sign in with. Invitations expire after seven days.", targetId: "settings.team.email", route: "/settings/team" },
        { key: "submit", title: "Send it yourself", body: "Select Invite when you are ready. AQi does not send invitations or change roles.", targetId: "settings.team.submit", route: "/settings/team" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "agency-tools",
    definition: {
      title: "Navigating agency tools",
      description: "A tour of the agency dashboard, assigned clients and internal navigation.",
      category: "Agency",
      roles: ["agency_staff", "agency_manager", "agency_super_admin"],
      routePrefix: "/admin",
      priority: 110,
      aliases: ["agency tools", "navigate agency", "agency dashboard", "assigned clients"],
      keywords: ["agency", "clients", "admin", "assigned", "work"],
      steps: [
        { key: "agency-nav", title: "The agency navigation", body: "Agency modules are grouped in the left navigation. Only modules your role allows are shown.", targetId: "nav.agency.dashboard", route: null, advance: "click" },
        { key: "hero", title: "Agency dashboard", body: "This dashboard summarizes real client and agency operations. It never shows a client's contacts here.", targetId: "admin.hero", route: "/admin" },
        { key: "clients-nav", title: "Assigned clients", body: "Clients lists the workspaces you are assigned to. Select it to continue.", targetId: "nav.agency.clients", route: null, advance: "click" },
        { key: "clients", title: "Client workspaces", body: "Open a client to work within your assigned scope. Every client action remains audited.", targetId: "admin.clients.table", route: "/admin/clients" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "aqi-management",
    definition: {
      title: "Navigating AQi Management",
      description: "Find AQi configuration, tutorials and the Insights dashboard.",
      category: "AQi",
      roles: ["agency_super_admin"],
      routePrefix: "/admin/aqi",
      priority: 120,
      aliases: ["aqi management", "configure aqi", "manage aqi", "aqi settings"],
      keywords: ["aqi", "management", "configure", "insights", "tutorials"],
      steps: [
        { key: "aqi-nav", title: "Open AQi Management", body: "AQi Management is in the Platform group of the agency navigation. Select it to continue.", targetId: "nav.agency.aqi", route: null, advance: "click" },
        { key: "tabs", title: "Everything in one place", body: "These are the real AQi sections: configuration, knowledge, tutorials, usage and more.", targetId: "admin.aqi.tabs", route: "/admin/aqi" },
        { key: "tutorials", title: "Manage walkthroughs", body: "Tutorials is where you create, preview, publish and version guided walkthroughs.", targetId: "admin.aqi.tutorials-tab", route: "/admin/aqi", advance: "click" },
        { key: "insights", title: "Open AQi Insights", body: "Insights uses real event data only. Empty periods show an empty state, not fabricated charts.", targetId: "admin.aqi.insights-link", route: "/admin/aqi" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "aqi-knowledge",
    definition: {
      title: "Managing AQi knowledge",
      description: "Review platform knowledge, add a document and publish approved entries.",
      category: "AQi",
      roles: ["agency_super_admin"],
      routePrefix: "/admin/aqi",
      priority: 130,
      aliases: ["aqi knowledge", "update aqi knowledge", "manage aqi knowledge", "upload knowledge"],
      keywords: ["aqi", "knowledge", "document", "publish", "review"],
      steps: [
        { key: "aqi-nav", title: "Open AQi Management", body: "AQi Management is in the agency navigation. Select it to continue.", targetId: "nav.agency.aqi", route: null, advance: "click" },
        { key: "knowledge-tab", title: "Platform knowledge", body: "Open Platform knowledge to review entries, freshness and publishing state.", targetId: "admin.aqi.knowledge-tab", route: "/admin/aqi", advance: "click" },
        { key: "document", title: "Add a document", body: "Upload a PDF, DOCX or TXT. Extraction happens on the server; nothing is published until you review it and save it.", targetId: "admin.aqi.knowledge-document", route: "/admin/aqi" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "aqi-tutorials",
    definition: {
      title: "Managing tutorials",
      description: "Create, preview, publish and version AQi walkthroughs.",
      category: "AQi",
      roles: ["agency_super_admin"],
      routePrefix: "/admin/aqi",
      priority: 140,
      aliases: ["manage tutorials", "create a tutorial", "publish a tutorial", "tutorial editor"],
      keywords: ["tutorial", "tutorials", "walkthrough", "preview", "publish", "version"],
      steps: [
        { key: "aqi-nav", title: "Open AQi Management", body: "AQi Management is in the agency navigation. Select it to continue.", targetId: "nav.agency.aqi", route: null, advance: "click" },
        { key: "tutorials-tab", title: "Open Tutorials", body: "The Tutorials tab holds the walkthrough library and its draft versions.", targetId: "admin.aqi.tutorials-tab", route: "/admin/aqi", advance: "click" },
        { key: "list", title: "The tutorial library", body: "Published, draft and archived tutorials are listed with their versions. Drafts are never shown to normal users.", targetId: "admin.aqi.tutorial-list", route: "/admin/aqi" },
        { key: "new", title: "Create a tutorial", body: "New tutorial creates a draft. Every step must reference an approved highlight target before publishing.", targetId: "admin.aqi.tutorial-new", route: "/admin/aqi" },
        { key: "publish", title: "Validate before publishing", body: "Publishing runs server-side validation. Invalid routes or targets are refused, not guessed.", targetId: "admin.aqi.tutorial-publish", route: "/admin/aqi" },
      ],
      completion: { kind: "finish" },
    },
  },
  {
    slug: "aqi-insights",
    definition: {
      title: "Using AQi Insights",
      description: "Read real usage, performance, knowledge and tutorial metrics.",
      category: "AQi",
      roles: ["agency_super_admin"],
      routePrefix: "/admin/aqi/insights",
      priority: 150,
      aliases: ["aqi insights", "aqi analytics", "usage dashboard", "tutorial analytics"],
      keywords: ["insights", "analytics", "usage", "metrics", "performance", "dashboard"],
      steps: [
        { key: "insights-nav", title: "Open AQi Management", body: "AQi Management is in the agency navigation. Select it to continue.", targetId: "nav.agency.aqi", route: null, advance: "click" },
        { key: "link", title: "Open Insights", body: "Insights opens the dedicated analytics dashboard for AQi.", targetId: "admin.aqi.insights-link", route: "/admin/aqi", advance: "click" },
        { key: "filters", title: "Choose a period", body: "The date range and organization filters apply to every metric on the page. Empty periods are labelled honestly.", targetId: "admin.aqi.insights.filters", route: "/admin/aqi/insights" },
        { key: "cards", title: "Real metrics only", body: "Usage, provider health, knowledge gaps, tutorials and feedback come from recorded events. No chat text is shown here.", targetId: "admin.aqi.insights.cards", route: "/admin/aqi/insights" },
      ],
      completion: { kind: "finish" },
    },
  },
];

export function tutorialBySlug(slug: string): AqiStarterTutorial | null {
  return STARTER_TUTORIALS.find((tutorial) => tutorial.slug === slug) ?? null;
}

export function summaryFromDefinition(id: string, slug: string, version: number, versionId: string, definition: AqiTutorialDefinition): AqiTutorialSummary {
  return {
    id,
    slug,
    title: definition.title,
    description: definition.description,
    category: definition.category,
    routePrefix: definition.routePrefix,
    roles: definition.roles,
    priority: definition.priority,
    version,
    versionId,
    stepCount: definition.steps.length,
    estimatedMinutes: Math.max(1, Math.ceil(definition.steps.length * 0.6)),
    requiresCrm: definition.requiresCrm,
    aliases: definition.aliases,
    keywords: definition.keywords,
  };
}

const TUTORIAL_REQUEST = /\b(show me|walk me|guide me|step[- ]by[- ]step|how (?:do|can|should) i|where (?:do|can) i|teach me|walkthrough|tutorial)\b/i;
const NON_GUIDE_KINDS = new Set(["greeting", "smalltalk", "clarify", "out_of_scope"]);

/**
 * Detects a genuine tutorial request and chooses at most one approved tutorial. A greeting, a
 * thank-you or a general question never becomes a walkthrough. The server still checks eligibility.
 */
export function matchAqiTutorialIntent(
  raw: string,
  tutorials: AqiTutorialSummary[],
  context: { pathname?: string | null; hasHistory?: boolean } = {},
): AqiTutorialSummary | null {
  const text = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (text.length < 4) return null;
  const intent = classifyAqiIntent(raw, { hasHistory: context.hasHistory });
  if (NON_GUIDE_KINDS.has(intent.kind)) return null;
  const explicit = TUTORIAL_REQUEST.test(text);
  if (!explicit && !["how_to", "navigation"].includes(intent.kind)) return null;

  let best: { tutorial: AqiTutorialSummary; score: number } | null = null;
  for (const tutorial of tutorials) {
    const haystack = `${tutorial.title} ${tutorial.description}`.toLowerCase();
    let score = 0;
    for (const alias of tutorial.aliases) {
      if (alias.length >= 4 && text.includes(alias.toLowerCase())) score += 6;
    }
    if (tutorial.title.toLowerCase() === text) score += 10;
    for (const word of tutorial.keywords) {
      if (word.length >= 3 && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) score += 2;
    }
    for (const token of text.split(/[^a-z0-9]+/).filter((word) => word.length > 3)) {
      if (haystack.includes(token)) score += 1;
    }
    if (context.pathname && (context.pathname === tutorial.routePrefix || context.pathname.startsWith(`${tutorial.routePrefix}/`))) score += 2;
    if (score > (best?.score ?? 0)) best = { tutorial, score };
  }
  if (!best || best.score < 4) return null;
  return best.tutorial;
}

export function tutorialRoleLabel(role: string): string {
  return ROLE_LABELS[role as EffectiveRole] ?? role;
}
