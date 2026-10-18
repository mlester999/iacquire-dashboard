import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_SECTIONS, BLUEPRINT_SECTIONS, STUDIO_SECTIONS, adminCrumbs, blueprintSectionFor, isNavActive } from "@/lib/admin-breadcrumb";

const labels = (p: string) => adminCrumbs(p).map((c) => c.label);

describe("agency breadcrumbs follow the route", () => {
  it("names Website Studio screens by what they are, never as a client page", () => {
    expect(labels("/admin/website-studio")).toEqual(["Website Studio"]);
    expect(labels("/admin/website-studio/templates")).toEqual(["Website Studio", "Template Library"]);
    expect(labels("/admin/website-studio/templates/abc")).toEqual(["Website Studio", "Template Library", "Template Designer"]);
    expect(labels("/admin/website-studio/websites")).toEqual(["Website Studio", "Client Websites"]);
    expect(labels("/admin/website-studio/websites/org1")).toEqual(["Website Studio", "Client Websites", "Client Website"]);
    expect(labels("/admin/website-studio/websites/org1/edit")).toEqual(["Website Studio", "Client Websites", "Client Website", "Website Editor"]);
    expect(labels("/admin/website-studio/shared-sections")).toEqual(["Website Studio", "Shared Sections"]);
    expect(labels("/admin/website-studio/reviews")).toEqual(["Website Studio", "Reviews & Publishing"]);
    expect(labels("/admin/website-studio/domains")).toEqual(["Website Studio", "Domains & Hosting"]);
    expect(labels("/admin/website-studio/media")).toEqual(["Website Studio", "Media Library"]);
    for (const p of ["templates", "websites/x", "reviews", "domains", "media", "shared-sections"]) expect(labels(`/admin/website-studio/${p}`)).not.toContain("Client detail");
  });

  it("no longer calls every deep admin route a client page", () => {
    expect(labels("/admin/projects/p1")).toEqual(["Custom projects", "Project"]);
    expect(labels("/admin/support/s1")).toEqual(["Support inbox", "Request"]);
    expect(labels("/admin/clients/c1")).toEqual(["Clients", "Client workspace"]);
    expect(labels("/admin/clients/c1/website")).toEqual(["Clients", "Client workspace", "Website"]);
    expect(labels("/admin/clients/c1/offboarding")).toEqual(["Clients", "Client workspace", "Offboarding"]);
    for (const p of ["/admin/projects/p1", "/admin/support/s1", "/admin/website-studio/templates"]) expect(labels(p)).not.toContain("Client detail");
  });

  it("names top-level screens and the dashboard", () => {
    expect(labels("/admin")).toEqual(["Dashboard"]);
    expect(labels("/admin/health")).toEqual(["System health"]);
    expect(labels("/admin/setup-templates")).toEqual(["Setup templates"]);
    expect(labels("/admin/crm")).toEqual(["Client CRMs"]);
    expect(labels("/admin/crm/reports")).toEqual(["Client CRMs", "CRM operations"]);
    expect(adminCrumbs("/admin/crm/reports")[0].href).toBe("/admin/crm");
  });

  it("links every ancestor to its own screen and leaves the current page unlinked", () => {
    const trail = adminCrumbs("/admin/website-studio/websites/org1/edit");
    expect(trail.map((c) => c.href)).toEqual(["/admin/website-studio", "/admin/website-studio/websites", "/admin/website-studio/websites/org1", undefined]);
    expect(adminCrumbs("/admin")[0].href).toBeUndefined();
  });

  it("keeps the Studio tabs and the sidebar using the same names", () => {
    expect(STUDIO_SECTIONS.map((s) => s.label)).toEqual(["Overview", "Client Websites", "Template Library", "Shared Sections", "Reviews & Publishing", "Domains & Hosting", "Media Library"]);
    const shell = fs.readFileSync(path.resolve("src/components/admin/admin-shell.tsx"), "utf8");
    const nav = [...shell.matchAll(/\{ href: "\/admin\/([a-z-]+)", label: "([^"]+)"/g)].map((m) => [m[1], m[2]] as const);
    expect(nav.length).toBeGreaterThan(10);
    for (const [area, label] of nav) expect(ADMIN_SECTIONS[area], area).toBe(label);
    // Deeper entries (CRM operations under Client CRMs) carry the label their page's breadcrumb ends with.
    const nested = [...shell.matchAll(/\{ href: "(\/admin\/[a-z-]+\/[a-z-/]+)", label: "([^"]+)"/g)].map((m) => [m[1], m[2]] as const);
    expect(nested).toContainEqual(["/admin/crm/reports", "CRM operations"]);
    for (const [href, label] of nested) expect(adminCrumbs(href).at(-1)?.label, href).toBe(label);
    // A section's own entry isn't also highlighted on a deeper entry's page.
    expect(shell).toMatch(/\{ href: "\/admin\/crm", label: "Client CRMs", icon: Contact, exact: true/);
  });
});

describe("CRM Blueprints navigation", () => {
  const id = "9b2f6a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
  const org = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

  it("names every Blueprint screen by what it is", () => {
    expect(labels("/admin/crm-blueprints")).toEqual(["CRM Blueprints"]);
    expect(labels("/admin/crm-blueprints/import")).toEqual(["CRM Blueprints", "Import"]);
    expect(labels("/admin/crm-blueprints/imports")).toEqual(["CRM Blueprints", "Import history"]);
    expect(labels(`/admin/crm-blueprints/imports/${id}`)).toEqual(["CRM Blueprints", "Import history", "Conversion preview"]);
    expect(labels("/admin/crm-blueprints/applications")).toEqual(["CRM Blueprints", "Applications"]);
    expect(labels(`/admin/crm-blueprints/applications/${org}/${id}`)).toEqual(["CRM Blueprints", "Applications", "Application"]);
    expect(labels(`/admin/crm-blueprints/${id}`)).toEqual(["CRM Blueprints", "Blueprint"]);
    expect(labels(`/admin/crm-blueprints/${id}/edit`)).toEqual(["CRM Blueprints", "Blueprint", "Blueprint Editor"]);
    expect(labels(`/admin/crm-blueprints/${id}/apply`)).toEqual(["CRM Blueprints", "Blueprint", "Apply to client"]);
    // Never mistaken for the Client CRMs area it shares a prefix with.
    for (const p of ["/admin/crm-blueprints", `/admin/crm-blueprints/${id}`]) expect(labels(p)).not.toContain("Client CRMs");
  });

  it("links each ancestor back to its own screen", () => {
    expect(adminCrumbs(`/admin/crm-blueprints/${id}/apply`).map((c) => c.href)).toEqual(["/admin/crm-blueprints", `/admin/crm-blueprints/${id}`, undefined]);
    expect(adminCrumbs(`/admin/crm-blueprints/imports/${id}`).map((c) => c.href)).toEqual(["/admin/crm-blueprints", "/admin/crm-blueprints/imports", undefined]);
    expect(adminCrumbs(`/admin/crm-blueprints/applications/${org}/${id}`).map((c) => c.href)).toEqual(["/admin/crm-blueprints", "/admin/crm-blueprints/applications", undefined]);
  });

  it("highlights one sidebar entry and one tab, never a sibling with the same prefix", () => {
    expect(isNavActive("/admin/crm-blueprints", "/admin/crm", true)).toBe(false);
    expect(isNavActive("/admin/crm-blueprints", "/admin/crm-blueprints")).toBe(true);
    expect(isNavActive(`/admin/crm-blueprints/${id}`, "/admin/crm-blueprints")).toBe(true);
    expect(isNavActive("/admin/crm-blueprints-old", "/admin/crm-blueprints")).toBe(false);
    expect(isNavActive("/admin/crm/reports", "/admin/crm/reports")).toBe(true);
    expect(isNavActive("/admin/clients/c1", "/admin/clients")).toBe(true);
    expect(BLUEPRINT_SECTIONS.map((s) => s.label)).toEqual(["Library", "Import", "Import history", "Applications"]);
    expect(blueprintSectionFor("/admin/crm-blueprints")).toBe("/admin/crm-blueprints");
    expect(blueprintSectionFor(`/admin/crm-blueprints/${id}/edit`)).toBe("/admin/crm-blueprints");
    expect(blueprintSectionFor("/admin/crm-blueprints/import")).toBe("/admin/crm-blueprints/import");
    expect(blueprintSectionFor("/admin/crm-blueprints/imports")).toBe("/admin/crm-blueprints/imports");
    expect(blueprintSectionFor(`/admin/crm-blueprints/imports/${id}`)).toBe("/admin/crm-blueprints/imports");
    expect(blueprintSectionFor(`/admin/crm-blueprints/applications/${org}/${id}`)).toBe("/admin/crm-blueprints/applications");
    expect(blueprintSectionFor("/admin/crm")).toBeNull();
    const shell = fs.readFileSync(path.resolve("src/components/admin/admin-shell.tsx"), "utf8");
    expect(shell).toMatch(/\{ href: "\/admin\/crm-blueprints", label: "CRM Blueprints", icon: Layers, group: "Operations" \}/);
    expect(shell).toContain("isNavActive(pathname, n.href, n.exact)");
  });
});
