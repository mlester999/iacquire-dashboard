// One place that names the agency's screens, so the sidebar, the Studio tabs, the breadcrumb and the page titles can never disagree.

export interface Crumb { label: string; href?: string }

/** The sections of the Website Studio, in tab order. The tabs, the breadcrumb and each page's own heading use these names. */
export const STUDIO_SECTIONS = [
  { href: "/admin/website-studio", label: "Overview", exact: true },
  { href: "/admin/website-studio/websites", label: "Client Websites" },
  { href: "/admin/website-studio/templates", label: "Template Library" },
  { href: "/admin/website-studio/shared-sections", label: "Shared Sections" },
  { href: "/admin/website-studio/reviews", label: "Reviews & Publishing" },
  { href: "/admin/website-studio/domains", label: "Domains & Hosting" },
  { href: "/admin/website-studio/media", label: "Media Library" },
] as const;

/**
 * The sections of CRM Blueprints, in tab order. The tabs, the breadcrumb and each page's own heading use these names. A Blueprint's own pages
 * (/admin/crm-blueprints/<id>, its editor and its apply flow) belong to the Library.
 */
export const BLUEPRINT_SECTIONS = [
  { href: "/admin/crm-blueprints", label: "Library", exact: true },
  { href: "/admin/crm-blueprints/import", label: "Import" },
  { href: "/admin/crm-blueprints/imports", label: "Import history" },
  { href: "/admin/crm-blueprints/applications", label: "Applications" },
] as const;

/** Top-level agency screens. The sidebar shows the same names. */
export const ADMIN_SECTIONS: Record<string, string> = {
  clients: "Clients", crm: "Client CRMs", "crm-blueprints": "CRM Blueprints", employees: "AI Employees", support: "Requests", notifications: "Notifications", "website-studio": "Website Studio", projects: "Custom projects",
  maintenance: "Maintenance", services: "Service catalog", portfolio: "Portfolio", "setup-templates": "Setup templates", integrations: "Integrations", aqi: "AQi Management", operations: "AQi Operations",
  health: "System health", billing: "Billing & finance", usage: "Usage & costs", requests: "Access requests", team: "Agency team", audit: "Audit log",
};

/**
 * Whether a navigation entry is the current page. An exact entry matches only its own address; any other entry matches its address and the
 * pages under it, never a sibling that merely shares a prefix (/admin/crm is not active on /admin/crm-blueprints).
 */
export function isNavActive(pathname: string, href: string, exact?: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The CRM Blueprints tab a page belongs to: the most specific section whose address the page is at or under. A Blueprint's own pages
 * (/admin/crm-blueprints/<id>, its editor, its apply flow) belong to the Library.
 */
export function blueprintSectionFor(pathname: string): (typeof BLUEPRINT_SECTIONS)[number]["href"] | null {
  if (!isNavActive(pathname, BLUEPRINT_SECTIONS[0].href)) return null;
  const deeper = BLUEPRINT_SECTIONS.slice(1).find((s) => isNavActive(pathname, s.href));
  return deeper ? deeper.href : BLUEPRINT_SECTIONS[0].href;
}

const CLIENT_PAGES: Record<string, string> = { crm: "CRM", setup: "Setup", integrations: "Integrations", activation: "Activation", provisioning: "Provisioning", offboarding: "Offboarding", website: "Website" };
const STUDIO_LABEL = Object.fromEntries(STUDIO_SECTIONS.map((s) => [s.href.split("/")[3] ?? "", s.label])) as Record<string, string>;
const BLUEPRINT_LABEL = Object.fromEntries(BLUEPRINT_SECTIONS.map((s) => [s.href.split("/")[3] ?? "", s.label])) as Record<string, string>;

/**
 * Where an agency page sits, as a trail after the leading "Agency" link. Every ancestor links back to its own screen and the last crumb is the
 * page itself. Each label comes from the route, never from a guess about what the page might be.
 */
export function adminCrumbs(pathname: string): Crumb[] {
  const [area, a, b, c] = pathname.replace(/^\/admin\/?/, "").split("/").filter(Boolean);
  const trail: Crumb[] = [];
  const base = `/admin/${area}`;
  if (!area) trail.push({ label: "Dashboard" });
  else if (area === "website-studio") {
    trail.push({ label: ADMIN_SECTIONS["website-studio"], href: base });
    if (a === "websites") {
      trail.push({ label: STUDIO_LABEL.websites, href: `${base}/websites` });
      if (b) trail.push({ label: "Client Website", href: `${base}/websites/${b}` });
      if (b && c === "edit") trail.push({ label: "Website Editor" });
    } else if (a === "templates") {
      trail.push({ label: STUDIO_LABEL.templates, href: `${base}/templates` });
      if (b) trail.push({ label: "Template Designer" });
    } else if (a) trail.push({ label: STUDIO_LABEL[a] ?? a.replace(/-/g, " ") });
  } else if (area === "crm-blueprints") {
    trail.push({ label: ADMIN_SECTIONS["crm-blueprints"], href: base });
    if (a === "import") trail.push({ label: BLUEPRINT_LABEL.import });
    else if (a === "imports") {
      trail.push({ label: BLUEPRINT_LABEL.imports, href: `${base}/imports` });
      if (b) trail.push({ label: "Conversion preview" });
    } else if (a === "applications") {
      trail.push({ label: BLUEPRINT_LABEL.applications, href: `${base}/applications` });
      if (b && c) trail.push({ label: "Application" });
    } else if (a) {
      trail.push({ label: "Blueprint", href: `${base}/${a}` });
      if (b === "edit") trail.push({ label: "Blueprint Editor" });
      else if (b === "apply") trail.push({ label: "Apply to client" });
    }
  } else {
    trail.push({ label: ADMIN_SECTIONS[area] ?? area.replace(/-/g, " "), href: base });
    if (area === "clients" && a) {
      trail.push({ label: "Client workspace", href: `${base}/${a}` });
      if (b === "crm") trail.push({ label: "CRM", href: `${base}/${a}/crm` });
      else if (b) trail.push({ label: CLIENT_PAGES[b] ?? b.replace(/-/g, " ") });
    } else if (area === "crm" && a === "reports") trail.push({ label: "CRM operations" });
    else if (area === "projects" && a) trail.push({ label: "Project" });
    else if (area === "support" && a) trail.push({ label: a === "analytics" ? "Analytics" : a === "settings" ? "Settings" : "Request" });
  }
  // The last crumb is where the reader is, so it is not a link.
  return trail.map((crumb, i) => (i === trail.length - 1 ? { label: crumb.label } : crumb));
}
