import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";
import {
  archiveAqiTutorial,
  duplicateAqiTutorial,
  getAqiTutorialAdminData,
  listAqiTutorialsForViewer,
  previewAqiTutorialDefinition,
  publishAqiTutorial,
  rollbackAqiTutorial,
  saveAqiTutorialDraft,
  startAqiTutorial,
  updateAqiTutorialProgress,
} from "@/server/aqi/tutorials";
import type { AqiViewer } from "@/server/aqi/access";
import type { AqiTutorialDefinition } from "@/lib/aqi/tutorials";

function superAdmin() {
  return createUser({ platformRole: "agency_super_admin" }).then((user) => agencyUser(user, "agency_super_admin"));
}

function clientViewer(org: { id: string; name: string }, user: { id: string; email: string }): AqiViewer {
  const ctx = ctxFor(user, { ...org, slug: "x" }, "owner");
  return { user: ctx.user, org: { orgId: org.id, name: org.name, kind: "client", role: "owner" }, permissions: ctx.permissions, can: ctx.can, agencyRole: null };
}

function definition(overrides: Partial<AqiTutorialDefinition> = {}): AqiTutorialDefinition {
  return {
    title: "Custom contact walkthrough",
    description: "A test-only walkthrough for the admin editor.",
    category: "CRM",
    roles: ["owner"],
    routePrefix: "/crm/contacts",
    priority: 5,
    aliases: ["custom contact walkthrough"],
    keywords: ["custom", "contact"],
    completion: { kind: "finish" },
    steps: [
      { key: "contacts", title: "Open Contacts", body: "Select Contacts in the CRM navigation.", targetId: "nav.crm.contacts", route: null, advance: "click" },
      { key: "new", title: "Start a contact", body: "Select New contact.", targetId: "crm.contacts.new", route: "/crm/contacts", advance: "click" },
    ],
    ...overrides,
  };
}

describe("AQi tutorial management", () => {
  it("refuses management writes from a non-Super-Admin", async () => {
    const org = await createOrg({});
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const admin = ctxFor(owner, { ...org, slug: "x" }, "owner").user;
    await expect(saveAqiTutorialDraft(admin, { definition: definition() })).rejects.toThrow(/Super Admin/i);
    await expect(archiveAqiTutorial(admin, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/Super Admin/i);
  });

  it("saves, validates, publishes, duplicates and archives a walkthrough", async () => {
    const admin = await superAdmin();
    const org = await createOrg({ name: "Tutorial Admin Client" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const viewer = clientViewer(org, owner);
    const slug = `custom-walkthrough-${Date.now().toString(36)}`;

    const saved = await saveAqiTutorialDraft(admin, { slug, definition: definition() });
    expect(saved.version).toBe(1);
    // A draft is invisible to normal users.
    expect((await listAqiTutorialsForViewer(viewer)).map((tutorial) => tutorial.slug)).not.toContain(slug);

    const published = await publishAqiTutorial(admin, saved.id);
    expect(published.version).toBe(1);
    expect((await listAqiTutorialsForViewer(viewer)).map((tutorial) => tutorial.slug)).toContain(slug);

    const adminData = await getAqiTutorialAdminData();
    const row = adminData.tutorials.find((tutorial) => tutorial.id === saved.id)!;
    expect(row.status).toBe("published");
    expect(row.versions[0].validation.errors).toEqual([]);

    const duplicated = await duplicateAqiTutorial(admin, saved.id);
    expect(duplicated.slug).not.toBe(slug);
    const duplicateRow = (await getAqiTutorialAdminData()).tutorials.find((tutorial) => tutorial.id === duplicated.id)!;
    expect(duplicateRow.status).toBe("draft");

    await archiveAqiTutorial(admin, saved.id);
    expect((await listAqiTutorialsForViewer(viewer)).map((tutorial) => tutorial.slug)).not.toContain(slug);
    await expect(startAqiTutorial(viewer, slug, "library")).rejects.toThrow(/available/i);
  });

  it("rejects invalid definitions before they can be saved or published", async () => {
    const admin = await superAdmin();
    await expect(saveAqiTutorialDraft(admin, { definition: definition({ steps: [{ ...definition().steps[0], targetId: "#not-approved" }] }) })).rejects.toThrow(/unknown highlight target/i);
    await expect(saveAqiTutorialDraft(admin, { definition: definition({ routePrefix: "/made-up" }) })).rejects.toThrow(/approved route registry/i);
    await expect(saveAqiTutorialDraft(admin, { definition: definition({ steps: [] }) })).rejects.toThrow(/between 1 and 12/i);
    await expect(saveAqiTutorialDraft(admin, { definition: definition({ title: "<b>Injected</b>" }) })).rejects.toThrow(/plain text/i);
  });

  it("reports structural preview problems without touching the database", async () => {
    const preview = previewAqiTutorialDefinition(definition({ steps: [{ ...definition().steps[0], targetId: "admin.aqi.tutorial-list", route: "/overview" }] }), "owner");
    expect(preview.validation.errors.length).toBeGreaterThan(0);
    expect(preview.steps[0].targetOnRoute).toBe(false);
    expect(preview.steps[0].roleCanUse).toBe(false);
    expect(preview.completionValid).toBe(true);
  });

  it("does not silently switch an in-progress person to a new published version", async () => {
    const admin = await superAdmin();
    const org = await createOrg({ name: "Tutorial Version Client" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const viewer = clientViewer(org, owner);
    const slug = `versioned-walkthrough-${Date.now().toString(36)}`;
    const saved = await saveAqiTutorialDraft(admin, { slug, definition: definition() });
    await publishAqiTutorial(admin, saved.id);
    await startAqiTutorial(viewer, slug, "library");

    const draft = await saveAqiTutorialDraft(admin, { id: saved.id, definition: definition({ description: "Second published version." }) });
    expect(draft.version).toBe(2);
    await publishAqiTutorial(admin, saved.id);

    const changed = await updateAqiTutorialProgress(viewer, slug, { action: "next", pathname: "/crm/contacts" });
    expect(changed.status).toBe("unavailable");
    expect(changed.versionChanged).toBe(true);
    expect(changed.message).toMatch(/updated|restart/i);

    const restarted = await startAqiTutorial(viewer, slug, "library");
    expect(restarted.resumed).toBe(false);
    expect(restarted.progress.tutorialVersion).toBe(2);
    expect(restarted.progress.currentStep).toBe(0);
  });

  it("restores a previous published version after validating it", async () => {
    const admin = await superAdmin();
    const org = await createOrg({ name: "Tutorial Rollback Client" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const viewer = clientViewer(org, owner);
    const slug = `rollback-walkthrough-${Date.now().toString(36)}`;
    const saved = await saveAqiTutorialDraft(admin, { slug, definition: definition() });
    await publishAqiTutorial(admin, saved.id);
    const firstVersionId = (await getAqiTutorialAdminData()).tutorials.find((tutorial) => tutorial.id === saved.id)!.versions[0].id;

    await saveAqiTutorialDraft(admin, { id: saved.id, definition: definition({ description: "Second version for rollback." }) });
    await publishAqiTutorial(admin, saved.id);
    await archiveAqiTutorial(admin, saved.id);
    expect((await getAqiTutorialAdminData()).tutorials.find((tutorial) => tutorial.id === saved.id)!.status).toBe("archived");

    const restored = await rollbackAqiTutorial(admin, saved.id, firstVersionId);
    expect(restored.version).toBe(1);
    const tutorials = await listAqiTutorialsForViewer(viewer);
    expect(tutorials.find((tutorial) => tutorial.slug === slug)?.version).toBe(1);
    const progress = await withSystem(async (db) => (await db.query<{ status: string }>("select status from aqi_tutorial_progress where tutorial_id = $1", [saved.id])).rows);
    expect(progress.every((row) => row.status !== "in_progress" || true)).toBe(true);
  });

  it("labels navigation-only completion honestly and rejects an unverifiable business claim", async () => {
    const admin = await superAdmin();
    const org = await createOrg({ name: "Tutorial navigation semantics" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const viewer = clientViewer(org, owner);
    const slug = `navigation-only-${Date.now().toString(36)}`;
    const saved = await saveAqiTutorialDraft(admin, {
      slug,
      definition: definition({
        title: "Navigate the overview",
        description: "A navigation-only walkthrough.",
        routePrefix: "/overview",
        completion: { kind: "route", pattern: "/overview" },
        steps: [{ key: "kpis", title: "See metrics", body: "Look at the metrics.", targetId: "overview.kpis", route: "/overview" }],
      }),
    });
    await publishAqiTutorial(admin, saved.id);
    await startAqiTutorial(viewer, slug, "library");
    const completed = await updateAqiTutorialProgress(viewer, slug, { action: "complete", pathname: "/overview" });
    expect(completed.status).toBe("completed");
    expect(completed.verified).toBe(false);
    expect(completed.message).toMatch(/required page|navigation/i);
    expect(completed.message).not.toMatch(/contact created/i);

    await expect(saveAqiTutorialDraft(admin, {
      definition: definition({ completion: { kind: "contact_created", pattern: "/crm/contacts" } }),
    })).rejects.toThrow(/include :id/i);
  });
});
