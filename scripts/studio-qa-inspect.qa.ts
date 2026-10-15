/**
 * Read-only look at the isolated local database, for facts a browser cannot show: which template version each website started from and whether that is the
 * version the agency had approved at the time, and which templates are Featured. Writes nothing. Run only while the isolated embedded QA server is stopped
 * (npm run studio:qa:inspect), because PGLite is single-process.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";

const QA_DIR = path.resolve(".data/studio-premium-qa");

it("reports the isolated database's template origins and Featured flags", async () => {
  const configuration = env();
  if (configuration.NODE_ENV === "production" || configuration.DATABASE_DRIVER !== "pglite" || path.resolve(configuration.PGLITE_DATA_DIR) !== path.join(QA_DIR, "database")) {
    throw new Error("Refusing to inspect anything but the isolated .data/studio-premium-qa database.");
  }
  try {
    const sites = await withSystem(async (db) => (await db.query<{ org: string; template_key: string; created_at: string; origin: unknown; published: boolean }>(
      `select o.name as org, w.template_key, w.created_at, w.draft_content->'origin' as origin, (w.published_publication_id is not null) as published
         from websites w join organizations o on o.id = w.org_id order by w.created_at`, [])).rows);
    const templates = await withSystem(async (db) => (await db.query<{ key: string; kind: string; status: string; featured: boolean; version: number; published_at: string | null }>(
      "select key, kind, status, featured, version, published_at from website_templates order by key", [])).rows);
    const report = sites.map((s) => {
      const origin = s.origin as { key?: string; templateId?: string | null; version?: number; revision?: number } | null;
      const template = templates.find((t) => t.key === s.template_key);
      return { org: s.org, startedFrom: s.template_key, origin, template: template ? { kind: template.kind, status: template.status, version: template.version } : "built-in, not overridden by the agency", published: s.published };
    });
    console.log(JSON.stringify({ websites: report, featuredTemplates: templates.filter((t) => t.featured).map((t) => t.key), agencyTemplateRows: templates.length }, null, 2));
    await fs.mkdir(path.join(".data", "studio-qa"), { recursive: true });
    await fs.writeFile(path.join(".data", "studio-qa", "origin-inspection.json"), JSON.stringify({ ranAt: new Date().toISOString(), websites: report, featuredTemplates: templates.filter((t) => t.featured).map((t) => t.key) }, null, 2));
    expect(sites.length).toBeGreaterThan(0);
  } finally {
    await closeDb();
  }
}, 120000);
