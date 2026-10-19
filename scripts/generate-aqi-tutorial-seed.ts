/**
 * Emits the starter tutorial seed JSON used by migration 0061. Run after changing
 * src/lib/aqi/tutorials.ts:
 *
 *   node --import tsx scripts/generate-aqi-tutorial-seed.ts
 *
 * The validation pass is intentional: a broken starter definition must fail here rather than in
 * production. The output is pasted into the `$seed$...$seed$` blocks of the migration.
 */
import { STARTER_TUTORIALS, validateTutorialDefinition } from "../src/lib/aqi/tutorials";

const rows = STARTER_TUTORIALS.map((tutorial) => {
  const validation = validateTutorialDefinition(tutorial.definition);
  if (validation.errors.length) {
    throw new Error(`${tutorial.slug}: ${validation.errors.join("; ")}`);
  }
  return {
    slug: tutorial.slug,
    title: tutorial.definition.title,
    description: tutorial.definition.description,
    category: tutorial.definition.category,
    audience: tutorial.definition.roles,
    route_prefix: tutorial.definition.routePrefix,
    priority: tutorial.definition.priority,
    definition: tutorial.definition,
  };
});

process.stdout.write(JSON.stringify(rows));
