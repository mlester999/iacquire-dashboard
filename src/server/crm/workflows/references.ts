import "server-only";
import type { Queryable } from "@/server/db";

/**
 * Which switched-on workflows depend on a custom field (or on some of its choices), so the field settings can refuse a change that would
 * break them at run time. A published version refers to a field as "cf:<field id>" (filter conditions and "update field" steps) or by
 * "fieldId" (waits until a date in a field).
 */

function refersTo(node: unknown, fieldId: string, removedChoices: readonly string[] | null): boolean {
  if (Array.isArray(node)) return node.some((n) => refersTo(n, fieldId, removedChoices));
  if (!node || typeof node !== "object") return false;
  const o = node as Record<string, unknown>;
  if (o.field === `cf:${fieldId}`) {
    if (!removedChoices) return true;
    const values = Array.isArray(o.value) ? o.value : [o.value];
    if (values.some((v) => typeof v === "string" && removedChoices.includes(v))) return true;
  }
  if (!removedChoices && o.fieldId === fieldId) return true;
  return Object.values(o).some((v) => v && typeof v === "object" && refersTo(v, fieldId, removedChoices));
}

/**
 * Names of the active workflows whose published version uses the field (`removedChoices` null), or checks or sets one of those choices.
 * Runs in the caller's transaction.
 */
export async function activeWorkflowsUsingField(db: Queryable, orgId: string, fieldId: string, removedChoices: readonly string[] | null = null): Promise<string[]> {
  const { rows } = await db.query<{ name: string; trigger_config: unknown; steps: unknown }>(
    `select w.name, v.trigger_config, v.steps from crm_workflows w join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
     where w.org_id = $1 and w.status = 'active' and (v.trigger_config::text like $2 or v.steps::text like $2) order by lower(w.name) limit 50`,
    [orgId, `%${fieldId}%`],
  );
  return rows.filter((r) => refersTo([r.trigger_config, r.steps], fieldId, removedChoices)).map((r) => r.name);
}

/** "the workflow "A"" or "the workflows "A" and "B" (and 3 more)", for a refusal message. */
export function workflowNames(names: readonly string[]): string {
  const quoted = names.slice(0, 2).map((n) => `"${n}"`);
  const more = names.length > 2 ? ` (and ${names.length - 2} more)` : "";
  return names.length === 1 ? `the workflow ${quoted[0]}` : `the workflows ${quoted.join(" and ")}${more}`;
}
