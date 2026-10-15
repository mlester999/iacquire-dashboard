import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_SECTIONS, STUDIO_SECTIONS, adminCrumbs } from "@/lib/admin-breadcrumb";

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
  });
});
