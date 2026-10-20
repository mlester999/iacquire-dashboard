import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { parseTutorialDefinition } from "@/server/aqi/tutorials";
import { validateTutorialDefinition } from "@/lib/aqi/tutorials";

const NEW_SLUGS = ["setup-workspace", "ask-aqi", "manage-tasks", "build-workflow", "manage-website", "read-analytics"];

describe("migration 0064 feature tours", () => {
  it("publishes the six feature tours as valid version-1 definitions", async () => {
    const rows = await withSystem(async (db) => (await db.query<{ slug: string; status: string; version: number; definition: unknown; published_version_id: string | null; version_id: string }>(
      `select t.slug, t.status, v.version, v.definition, t.published_version_id, v.id as version_id
         from aqi_tutorials t join aqi_tutorial_versions v on v.tutorial_id = t.id
        where t.slug = any($1::text[]) order by t.priority`,
      [NEW_SLUGS],
    )).rows);
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.slug).sort()).toEqual([...NEW_SLUGS].sort());
    for (const row of rows) {
      expect(row.status).toBe("published");
      expect(row.version).toBe(1);
      expect(row.published_version_id).toBe(row.version_id);
      const definition = parseTutorialDefinition(row.definition);
      expect(validateTutorialDefinition(definition).errors, row.slug).toEqual([]);
      expect(definition.steps.length).toBeGreaterThanOrEqual(1);
      expect(definition.steps.length).toBeLessThanOrEqual(12);
    }
  });

  it("covers the previously missing product areas with real target ids", async () => {
    const rows = await withSystem(async (db) => (await db.query<{ slug: string; definition: unknown }>(
      `select t.slug, v.definition from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
        where t.slug = any($1::text[]) order by t.slug`,
      [NEW_SLUGS],
    )).rows);
    const targets = new Set<string>();
    for (const row of rows) {
      const definition = parseTutorialDefinition(row.definition);
      for (const step of definition.steps) if (step.targetId) targets.add(step.targetId);
      if (row.slug === "setup-workspace") expect(definition.routePrefix).toBe("/setup");
      if (row.slug === "ask-aqi") expect(definition.steps[0].targetId).toBe("aqi.launcher");
      if (row.slug === "manage-tasks") expect(definition.routePrefix).toBe("/crm/tasks");
      if (row.slug === "build-workflow") expect(definition.routePrefix).toBe("/crm/workflows");
      if (row.slug === "manage-website") expect(definition.routePrefix).toBe("/website");
      if (row.slug === "read-analytics") expect(definition.routePrefix).toBe("/analytics");
    }
    expect(targets.size).toBeGreaterThanOrEqual(10);
    for (const target of ["setup.hero", "aqi.launcher", "crm.tasks.views", "crm.workflows.new", "website.hero", "analytics.report"]) {
      expect(targets.has(target), target).toBe(true);
    }
  });

  it("adds contextual entry points for each new tour", async () => {
    const tips = await withSystem(async (db) => (await db.query<{ slug: string; tutorial_slug: string }>(
      `select slug, tutorial_slug from aqi_contextual_tips
        where slug in ('setup-help','aqi-help','tasks-help','workflows-help','website-help','analytics-help') order by priority`,
    )).rows);
    expect(tips.map((tip) => tip.tutorial_slug)).toEqual([
      "ask-aqi", "setup-workspace", "manage-tasks", "build-workflow", "manage-website", "read-analytics",
    ]);
  });
});
