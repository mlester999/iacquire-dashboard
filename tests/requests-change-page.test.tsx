import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/server/tenancy/context";

// The Request a Change page and its entries in the navigation: dormant until switched on, the project the person came from, the registries that name the page, and the files
// that must not be read by the browser. Embedded Postgres, synthetic people.

const state = vi.hoisted(() => ({ ctx: null as null | OrgContext }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }), redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));
vi.mock("@/server/tenancy/context", async (original) => {
  const actual = await original<typeof import("@/server/tenancy/context")>();
  return { ...actual, requireOrgContext: async () => {
    if (!state.ctx) throw new Error("not signed in");
    return state.ctx;
  } };
});

import { SupportFormPage } from "@/components/support/form-page";
import RequestChangePage from "@/app/(portal)/support/change/page";
import { setRequestChangesEnabled } from "@/server/support/change-feature";
import { AQI_ROUTES, matchAqiRoute } from "@/lib/aqi/routes";
import { titleFor } from "@/components/shell/titles";
import { NOTIFICATION_GROUPS } from "@/lib/notification-groups";
import { projectsWorld, approvedProject, type ProjectsWorld } from "./support/projects-world";
import { resetRateLimits } from "./support/support-world";

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
});
beforeEach(resetRateLimits);
afterEach(async () => {
  state.ctx = null;
  await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, false);
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("the page", () => {
  it("says it is not switched on, and shows no form, until a Super Admin switches it on for the workspace", async () => {
    state.ctx = w.ctx.owner;
    const html = renderToStaticMarkup(await SupportFormPage({ kind: "change", searchParams: {} }));
    expect(text(html)).toContain("Request a Change isn't switched on for your workspace yet");
    expect(html).not.toContain("<form");
    expect(text(html)).toContain("Get support");
  });

  it("shows the form once it is on, with the heading that promises nothing and no project question until a project is the subject", async () => {
    await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
    state.ctx = w.ctx.owner;
    // The route is the shared page with the change kind.
    const element = (await RequestChangePage({ searchParams: Promise.resolve({ project: "6f1f0d9e-0000-4000-8000-0000000000a1" }) })) as React.ReactElement<{ kind: string; searchParams: { project?: string } }>;
    expect(element.type).toBe(SupportFormPage);
    expect(element.props).toMatchObject({ kind: "change", searchParams: { project: "6f1f0d9e-0000-4000-8000-0000000000a1" } });
    const html = renderToStaticMarkup(await SupportFormPage({ kind: "change", searchParams: {} }));
    const t = text(html);
    expect(html).toContain("<form");
    expect(t).toContain("What would you like changed?");
    // Honest about what happens: nothing is charged without an accepted price, and nothing says the team will wait for a yes before it does work that costs nothing.
    expect(t).toContain("Nothing is charged until you accept a price");
    expect(t).toContain("Nothing is charged without that");
    expect(t).not.toMatch(/never start on a guess|Nothing is done or charged until you agree/);
    expect(t).toContain("The team decides");
    expect(html).not.toContain("Which project?");
    // The other request pages point at it now that it is on.
    const support = text(renderToStaticMarkup(await SupportFormPage({ kind: "support", searchParams: {} })));
    expect(support).toContain("Request a change");
  });

  it("does not point the other request pages at it while it is off", async () => {
    state.ctx = w.ctx.owner;
    const support = text(renderToStaticMarkup(await SupportFormPage({ kind: "support", searchParams: {} })));
    expect(support).not.toContain("Request a change");
  });

  it("starts on the project the person came from when it is theirs, offers the filing as a change to an owner and not to a member, and ignores anyone else's project", async () => {
    await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
    const { id } = await approvedProject(w, "Page project", { start: true });
    state.ctx = w.ctx.owner;
    const owner = renderToStaticMarkup(await SupportFormPage({ kind: "change", searchParams: { project: id } }));
    expect(owner).toContain("Which project?");
    expect(owner).toContain("Page project");
    expect(owner).toContain("This changes what we agreed");
    state.ctx = w.ctx.member;
    const member = renderToStaticMarkup(await SupportFormPage({ kind: "change", searchParams: { project: id } }));
    expect(member).toContain("Which project?");
    expect(member).not.toContain("This changes what we agreed");
    // A project of another workspace, or a made-up one, is dropped; the page still renders.
    state.ctx = w.ctx.outsider;
    await setRequestChangesEnabled(w.agency.superAdmin, w.otherOrg.id, true);
    try {
      const other = renderToStaticMarkup(await SupportFormPage({ kind: "change", searchParams: { project: id } }));
      expect(other).not.toContain("Page project");
      const bogus = renderToStaticMarkup(await SupportFormPage({ kind: "change", searchParams: { project: "not-an-id" } }));
      expect(bogus).toContain("<form");
    } finally {
      await setRequestChangesEnabled(w.agency.superAdmin, w.otherOrg.id, false);
    }
  });

  it("files an issue or feedback against the project it was opened from, only when it is the workspace's own", async () => {
    const { id } = await approvedProject(w, "Issue page project", { start: true });
    state.ctx = w.ctx.owner;
    const html = text(renderToStaticMarkup(await SupportFormPage({ kind: "issue", searchParams: { project: id } })));
    expect(html).toContain("About the project");
    expect(html).toContain("Issue page project");
    state.ctx = w.ctx.outsider;
    const other = text(renderToStaticMarkup(await SupportFormPage({ kind: "issue", searchParams: { project: id } })));
    expect(other).not.toContain("About the project");
  });
});

describe("where it is named", () => {
  it("is in the Requests menu behind the workspace switch, the assistant's route list and the notification wording", () => {
    const sidebar = read("src/components/shell/sidebar.tsx");
    expect(sidebar).toMatch(/\{ href: "\/support\/change", label: "Request a Change", icon: PencilRuler, permission: "support\.use", feature: "request_changes" \}/);
    expect(sidebar).toContain("const requestItems = REQUESTS.filter((i) => can(i.permission) && !(i.feature && !(shell.features ?? []).includes(i.feature)))");
    expect(sidebar).not.toContain("REQUESTS.filter((i) => can(i.permission))");
    expect(AQI_ROUTES.find((r) => r.path === "/support/change")).toMatchObject({ label: "Request a Change", permission: "support.use" });
    expect(matchAqiRoute("/support/change")?.path).toBe("/support/change");
    expect(matchAqiRoute("/support/12345678-1234-1234-1234-123456789012")?.path).toBe("/support");
    expect(titleFor("/support/change")).toBe("Support");
    const projects = NOTIFICATION_GROUPS.find((g) => g.key === "projects")!;
    expect(projects.kinds).toContain("project_prerequisite");
    expect(projects.kinds).not.toContain("project_change_order");
    expect(projects.description).toMatch(/change quotes and your decisions always notify you/i);
  });

  it("keeps the browser away from anything that reads the server: no new client file exports a value a server file calls", () => {
    for (const file of ["src/components/projects/change-requests.tsx", "src/components/admin/admin-change-panel.tsx"]) {
      const source = read(file);
      expect(source.startsWith('"use client";'), file).toBe(true);
      expect([...source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]).sort(), file).toEqual(
        file.endsWith("change-requests.tsx") ? ["ChangeRequestsSection"] : ["AdminChangePanel", "AdminPrerequisitesPanel", "AdminTermsCard"],
      );
      expect(source, file).not.toMatch(/from "node:|from "@\/server\/(?!projects\/shared"|projects\/agency")/);
    }
    // The pure rules live in plain library files the browser may import.
    for (const file of ["src/lib/project-change-orders.ts", "src/lib/project-prerequisites.ts", "src/lib/support/change.ts"]) {
      expect(read(file), file).not.toMatch(/from "node:|from "@\/server\/|import "server-only"/);
    }
  });
});
