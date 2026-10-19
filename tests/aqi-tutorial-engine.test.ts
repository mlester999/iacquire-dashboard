import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { AqiViewer } from "@/server/aqi/access";
import {
  getAqiTutorialForViewer,
  getAqiTutorialState,
  listAqiTutorialsForViewer,
  matchAqiTutorialOffer,
  startAqiTutorial,
  updateAqiTutorialProgress,
} from "@/server/aqi/tutorials";
import { matchAqiTutorialIntent, STARTER_TUTORIALS, validateTutorialDefinition, type AqiTutorialSummary } from "@/lib/aqi/tutorials";
import { AQI_TARGETS } from "@/lib/aqi/targets";

function viewerFor(org: { id: string; name: string }, user: { id: string; email: string }, role: "owner" | "admin" | "member" | "viewer" | "support" = "owner"): AqiViewer {
  const ctx = ctxFor(user, { ...org, slug: "x" }, role);
  return {
    user: ctx.user,
    org: { orgId: org.id, name: org.name, kind: "client", role },
    permissions: ctx.permissions,
    can: ctx.can,
    agencyRole: null,
  };
}

async function fixture(role: "owner" | "admin" | "member" | "viewer" | "support" = "owner") {
  const org = await createOrg({ name: `Tutorial ${Math.random().toString(16).slice(2)}` });
  const user = await createUser();
  await addMember(org.id, user.id, role);
  return { org, user, viewer: viewerFor(org, user, role) };
}

describe("AQi starter tutorial library", () => {
  it("validates every starter definition against the approved route and target registries", () => {
    expect(STARTER_TUTORIALS.length).toBeGreaterThanOrEqual(12);
    for (const tutorial of STARTER_TUTORIALS) {
      const validation = validateTutorialDefinition(tutorial.definition);
      expect({ slug: tutorial.slug, errors: validation.errors }).toEqual({ slug: tutorial.slug, errors: [] });
      for (const step of tutorial.definition.steps) {
        if (!step.targetId) continue;
        expect(AQI_TARGETS.some((target) => target.id === step.targetId), `${tutorial.slug} references ${step.targetId}`).toBe(true);
      }
    }
  });

  it("rejects an unknown highlight target, an unknown route and executable markup", () => {
    const base = STARTER_TUTORIALS.find((tutorial) => tutorial.slug === "getting-started")!.definition;
    const unknownTarget = validateTutorialDefinition({ ...base, steps: [{ ...base.steps[0], targetId: "[data-hack]" }] });
    expect(unknownTarget.errors.join(" ")).toMatch(/unknown highlight target/i);
    const unknownRoute = validateTutorialDefinition({ ...base, routePrefix: "/not-a-real-page" });
    expect(unknownRoute.errors.join(" ")).toMatch(/approved route registry/i);
    const script = validateTutorialDefinition({ ...base, description: "<script>alert(1)</script>" });
    expect(script.errors.join(" ")).toMatch(/plain text/i);
    const mismatch = validateTutorialDefinition({ ...base, steps: [{ ...base.steps[0], targetId: "crm.contacts.new", route: "/overview" }] });
    expect(mismatch.errors.join(" ")).toMatch(/not available on/i);
  });

  it("matches real tutorial intent but never a greeting, thanks or unrelated question", () => {
    const summaries: AqiTutorialSummary[] = STARTER_TUTORIALS.map((tutorial, index) => ({
      id: `id-${index}`,
      slug: tutorial.slug,
      title: tutorial.definition.title,
      description: tutorial.definition.description,
      category: tutorial.definition.category,
      routePrefix: tutorial.definition.routePrefix,
      roles: tutorial.definition.roles,
      priority: tutorial.definition.priority,
      version: 1,
      versionId: `v-${index}`,
      stepCount: tutorial.definition.steps.length,
      estimatedMinutes: 3,
      requiresCrm: tutorial.definition.requiresCrm,
      aliases: tutorial.definition.aliases,
      keywords: tutorial.definition.keywords,
    }));
    expect(matchAqiTutorialIntent("How do I add a contact?", summaries)?.slug).toBe("create-contact");
    expect(matchAqiTutorialIntent("Show me how to create a contact", summaries)?.slug).toBe("create-contact");
    expect(matchAqiTutorialIntent("Can you guide me through inviting a team member?", summaries)?.slug).toBe("invite-team-member");
    expect(matchAqiTutorialIntent("hey", summaries)).toBeNull();
    expect(matchAqiTutorialIntent("thanks!", summaries)).toBeNull();
    expect(matchAqiTutorialIntent("What is my billing plan?", summaries)).toBeNull();
    expect(matchAqiTutorialIntent("Show me how to add a contact", summaries, { pathname: "/overview" })?.slug).toBe("create-contact");
  });
});

describe("AQi tutorial eligibility and progress", () => {
  it("offers only walkthroughs the signed-in role can actually use", async () => {
    const owner = await fixture("owner");
    const ownerTutorials = await listAqiTutorialsForViewer(owner.viewer);
    expect(ownerTutorials.map((tutorial) => tutorial.slug)).toContain("create-contact");
    expect(ownerTutorials.map((tutorial) => tutorial.slug)).toContain("getting-started");

    const viewer = await fixture("viewer");
    const viewerTutorials = await listAqiTutorialsForViewer(viewer.viewer);
    expect(viewerTutorials.map((tutorial) => tutorial.slug)).not.toContain("create-contact");
    expect(viewerTutorials.map((tutorial) => tutorial.slug)).not.toContain("invite-team-member");
    // A read-only viewer cannot use the workforce or support steps of the full tour, so AQi offers
    // the dashboard walkthrough it can actually complete instead of pretending.
    expect(viewerTutorials.map((tutorial) => tutorial.slug)).toContain("navigate-dashboard");
    expect(viewerTutorials.map((tutorial) => tutorial.slug)).not.toContain("getting-started");
    expect(await getAqiTutorialForViewer(viewer.viewer, "create-contact")).toBeNull();
    expect(await matchAqiTutorialOffer(viewer.viewer, "How do I add a contact?", "/overview")).toBeNull();
  });

  it("offers the new feature tours only to roles that can complete their steps", async () => {
    const owner = await fixture("owner");
    const ownerTutorials = (await listAqiTutorialsForViewer(owner.viewer)).map((tutorial) => tutorial.slug);
    expect(ownerTutorials).toEqual(expect.arrayContaining([
      "setup-workspace", "ask-aqi", "manage-tasks", "build-workflow", "manage-website", "read-analytics",
    ]));

    const viewer = await fixture("viewer");
    const viewerTutorials = (await listAqiTutorialsForViewer(viewer.viewer)).map((tutorial) => tutorial.slug);
    expect(viewerTutorials).toEqual(expect.arrayContaining(["setup-workspace", "ask-aqi", "read-analytics"]));
    for (const slug of ["manage-tasks", "build-workflow", "manage-website"]) {
      expect(viewerTutorials, slug).not.toContain(slug);
      expect(await getAqiTutorialForViewer(viewer.viewer, slug), slug).toBeNull();
    }
    expect(await matchAqiTutorialOffer(viewer.viewer, "How do I build a workflow?", "/crm/workflows")).toBeNull();
  });

  it("excludes native-CRM walkthroughs from a workspace whose CRM is owned elsewhere", async () => {
    const { org, viewer } = await fixture("owner");
    await withSystem((db) => db.query("insert into crm_workspaces (org_id, mode) values ($1, 'ghl') on conflict (org_id) do update set mode = 'ghl'", [org.id]));
    const tutorials = await listAqiTutorialsForViewer(viewer);
    expect(tutorials.map((tutorial) => tutorial.slug)).not.toContain("create-contact");
    expect(tutorials.map((tutorial) => tutorial.slug)).toContain("manage-appointments-external");
  });

  it("persists progress, resumes without restarting and records idempotent events", async () => {
    const { org, user, viewer } = await fixture("owner");
    const started = await startAqiTutorial(viewer, "create-contact", "chat");
    expect(started.resumed).toBe(false);
    expect(started.progress.currentStep).toBe(0);
    expect(started.tutorial.steps.length).toBe(4);

    const resumed = await startAqiTutorial(viewer, "create-contact", "chat");
    expect(resumed.resumed).toBe(true);
    const state = await getAqiTutorialState(viewer);
    expect(state.active[0]?.slug).toBe("create-contact");

    const next = await updateAqiTutorialProgress(viewer, "create-contact", { action: "next", pathname: "/crm/contacts", eventId: "11111111-1111-4111-8111-111111111111" });
    expect(next.status).toBe("in_progress");
    expect(next.progress.currentStep).toBe(1);
    const back = await updateAqiTutorialProgress(viewer, "create-contact", { action: "previous", pathname: "/crm/contacts" });
    expect(back.progress.currentStep).toBe(0);

    const paused = await updateAqiTutorialProgress(viewer, "create-contact", { action: "pause", pathname: "/crm/contacts" });
    expect(paused.status).toBe("paused");
    const resumedAgain = await updateAqiTutorialProgress(viewer, "create-contact", { action: "resume", pathname: "/crm/contacts" });
    expect(resumedAgain.status).toBe("in_progress");

    const events = await withSystem(async (db) => (await db.query<{ kind: string }>("select kind from aqi_tutorial_events where user_id = $1 and tutorial_id = $2", [user.id, started.tutorial.id])).rows);
    expect(events.filter((event) => event.kind === "started")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "resumed")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "step_viewed").length).toBeGreaterThan(0);
    expect(org.id).toBeTruthy();
  });

  it("never claims a contact was created from navigation alone", async () => {
    const { org, user, viewer } = await fixture("owner");
    const started = await startAqiTutorial(viewer, "create-contact", "chat");
    for (let i = 0; i < 3; i += 1) await updateAqiTutorialProgress(viewer, "create-contact", { action: "next", pathname: "/crm/contacts" });

    const wrongPage = await updateAqiTutorialProgress(viewer, "create-contact", { action: "complete", pathname: "/overview" });
    expect(wrongPage.status).toBe("in_progress");
    expect(wrongPage.verified).toBe(false);
    expect(wrongPage.message).toMatch(/specific page/i);

    const contactId = "58f2c43c-3a9f-4bc0-9a48-1f2e8d9b1234";
    const unconfirmed = await updateAqiTutorialProgress(viewer, "create-contact", { action: "complete", pathname: `/crm/contacts/${contactId}` });
    expect(unconfirmed.status).toBe("in_progress");
    expect(unconfirmed.verified).toBe(false);
    expect(unconfirmed.message).toMatch(/hasn't confirmed|not confirmed/i);
    const noEvents = await withSystem(async (db) => (await db.query<{ n: number }>("select count(*)::int as n from aqi_tutorial_events where user_id = $1 and tutorial_id = $2 and kind = 'completed'", [user.id, started.tutorial.id])).rows[0].n);
    expect(noEvents).toBe(0);

    // Authoritative proof: the CRM owns a contact in this workspace created during the attempt.
    await withSystem((db) => db.query(
      "insert into contacts (id, org_id, display_name, source) values ($1, $2, 'AQi completion proof', 'aqi_test')",
      [contactId, org.id],
    ));
    const completed = await updateAqiTutorialProgress(viewer, "create-contact", { action: "complete", pathname: `/crm/contacts/${contactId}` });
    expect(completed.status).toBe("completed");
    expect(completed.verified).toBe(true);
    expect(completed.message).toMatch(/Contact created/i);
    const completedEvents = await withSystem(async (db) => (await db.query<{ n: number }>("select count(*)::int as n from aqi_tutorial_events where user_id = $1 and tutorial_id = $2 and kind = 'completed'", [user.id, started.tutorial.id])).rows[0].n);
    expect(completedEvents).toBe(1);
  });

  it("marks a finished walkthrough as finished, never as a verified business action", async () => {
    const { viewer } = await fixture("owner");
    const started = await startAqiTutorial(viewer, "navigate-dashboard", "library");
    for (let i = 0; i < started.tutorial.steps.length - 1; i += 1) {
      await updateAqiTutorialProgress(viewer, "navigate-dashboard", { action: "next", pathname: "/overview" });
    }
    const completed = await updateAqiTutorialProgress(viewer, "navigate-dashboard", { action: "complete", pathname: "/overview" });
    expect(completed.status).toBe("completed");
    expect(completed.verified).toBe(false);
    expect(completed.message).toMatch(/Walkthrough finished|No business action/i);
  });

  it("supports optional-step skipping only when the step is optional", async () => {
    const { viewer } = await fixture("owner");
    const started = await startAqiTutorial(viewer, "find-integrations", "library");
    // Find the optional final step and advance to the step before it.
    const optionalIndex = started.tutorial.steps.findIndex((step) => step.optional);
    expect(optionalIndex).toBeGreaterThan(0);
    while ((await getAqiTutorialState(viewer)).active[0].currentStep < optionalIndex) {
      await updateAqiTutorialProgress(viewer, "find-integrations", { action: "next", pathname: "/settings/integrations" });
    }
    const skipped = await updateAqiTutorialProgress(viewer, "find-integrations", { action: "skip", pathname: "/settings/integrations" });
    expect(skipped.status).toBe("completed");
    expect(skipped.verified).toBe(false);
    const atFirst = await startAqiTutorial(viewer, "find-integrations", "library");
    expect(atFirst.progress.currentStep).toBe(0);
    await expect(updateAqiTutorialProgress(viewer, "find-integrations", { action: "skip", pathname: "/settings" })).rejects.toThrow(/required/i);
  });

  it("records a missing target without advancing, clicking or exiting", async () => {
    const { user, viewer } = await fixture("owner");
    const started = await startAqiTutorial(viewer, "getting-started", "library");
    const missing = await updateAqiTutorialProgress(viewer, "getting-started", { action: "target_missing", pathname: "/overview", reason: "target_not_found" });
    expect(missing.status).toBe("in_progress");
    expect(missing.progress.currentStep).toBe(0);
    expect(missing.message).toMatch(/Nothing was clicked|retry/i);
    const events = await withSystem(async (db) => (await db.query<{ kind: string }>("select kind from aqi_tutorial_events where user_id = $1 and tutorial_id = $2 and kind = 'target_missing'", [user.id, started.tutorial.id])).rows);
    expect(events).toHaveLength(1);
  });

  it("isolates progress between people and rejects an unavailable tutorial", async () => {
    const first = await fixture("owner");
    const second = await fixture("owner");
    await startAqiTutorial(first.viewer, "getting-started", "chat");
    const secondState = await getAqiTutorialState(second.viewer);
    expect(secondState.active).toHaveLength(0);
    await expect(startAqiTutorial(second.viewer, "not-a-published-tutorial", "chat")).rejects.toThrow(/available/i);
  });
});
