import "server-only";
import { z } from "zod";
import { CONTACT_FILTER_FIELDS, OPS_BY_KIND } from "@/lib/crm/filters";
import { EVENT_TRIGGER_TYPES, OTHER_TRIGGER_TYPES, STEP_KINDS, STEP_KIND_LIST, TRIGGERS, TRIGGER_FILTER_KEYS, WORKFLOW_LIMITS, type StepKind } from "@/lib/crm/workflow/spec";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS } from "@/lib/agents";
import { TOKEN_KEYS } from "@/lib/messaging/tokens";
import { LIMIT_LABELS } from "@/lib/automation-studio/plan";

/**
 * What the AI Automation Builder is told it can build with, generated from the same definitions the validator and the engine use. Nothing here is
 * written by hand twice: a step kind added to the contract appears in the builder's catalogue with its real settings, and one that is removed
 * disappears from it. The builder is told what exists; the server still validates everything it proposes.
 */

const compact = (value: unknown) => JSON.stringify(value);

function configSchema(kind: StepKind): string {
  try {
    const js = z.toJSONSchema(STEP_KINDS[kind].schema as z.ZodType, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
    delete js.$schema;
    return compact(js);
  } catch {
    return "{}";
  }
}

/** One line per step kind: what it does, what it can do outside the CRM, and its settings as JSON Schema. */
export function stepCatalog(): string {
  return STEP_KIND_LIST.map((kind) => {
    const spec = STEP_KINDS[kind];
    const notes = [
      spec.branches ? "has two paths: connect \"yes\" and \"no\"" : spec.terminal ? "ends the workflow" : "continues to one next step",
      spec.approvable ? "can set requireApproval" : null,
      spec.external ? "calls a system outside iAcquire" : null,
    ].filter(Boolean).join("; ");
    return `- ${kind} (${spec.label}): ${spec.description} [${notes}]\n  config: ${configSchema(kind)}`;
  }).join("\n");
}

export function triggerCatalog(): string {
  const groups = new Map<string, string[]>();
  for (const type of [...EVENT_TRIGGER_TYPES, ...OTHER_TRIGGER_TYPES]) {
    const t = TRIGGERS[type];
    const filters = t.filters.length ? ` (filters: ${t.filters.join(", ")})` : "";
    groups.set(t.group, [...(groups.get(t.group) ?? []), `${type}: ${t.label}${filters}`]);
  }
  return [...groups].map(([group, items]) => `${group}:\n${items.map((i) => `  - ${i}`).join("\n")}`).join("\n")
    + `\nTrigger shape: {"type": <one of the above>, "filters": {<only the listed filter keys>}, "reentry": "always"|"once"|"not_while_active", "contactFilter": <condition group, optional>, "schedule": {"frequency":"daily"|"weekly","time":"HH:MM","weekdays":[0-6]} (schedule only)}.`
    + `\nAll filter keys that exist: ${TRIGGER_FILTER_KEYS.join(", ")}. To start a workflow from another system's webhook set only {"type":"inbound_webhook"}: the address, how the caller is matched to a contact and whether a contact is created are set by the person in the workflow's settings after the server generates the address, so never write an "inbound" setting; tell the person what to set there.`;
}

/** The condition language of an if / else step and of a trigger's contact filter. */
export function conditionCatalog(): string {
  const fields = CONTACT_FILTER_FIELDS.map((f) => {
    const options = f.options?.length ? ` values: ${f.options.map((o) => o.value).join("|")}` : "";
    return `  - ${f.key} (${f.kind}) ops: ${OPS_BY_KIND[f.kind].join(", ")}${options}`;
  }).join("\n");
  return `Condition group: {"op":"and"|"or","conditions":[{"field":<key>,"op":<operator>,"value":<value>}, ...nested groups allowed]}.\n`
    + `Examples: {"field":"lead_status","op":"in","value":["new"]}, {"field":"tags","op":"has_any","value":[<tag id>]}, {"field":"lead_score","op":"gt","value":50}.\n`
    + `Contact fields:\n${fields}\nA custom field is written "cf:<field id>". An if / else on a deal (subject "opportunity") can test status, pipeline, stage, value, owner, tags, source, created_at, expected_close_date.`;
}

export function employeeCatalog(): string {
  return AGENT_ROLE_KEYS.map((k) => `  - ${k}: ${AGENT_BY_KEY[k].name}: ${AGENT_BY_KEY[k].tagline}`).join("\n");
}

export function limitsNote(): string {
  return `A workflow has at most ${WORKFLOW_LIMITS.maxSteps} steps; a loop must pass through a wait step; a wait is at most ${WORKFLOW_LIMITS.maxWaitDays} days. Workspace limits that apply: ${Object.values(LIMIT_LABELS).join(", ")}.`;
}

/** Placeholders a task title, note, notification or deal name may contain; the engine fills them from the contact when the step runs. */
export function tokenNote(): string {
  return `Placeholders usable in the text of tasks, notes, notifications and deal names (write them exactly like this): ${TOKEN_KEYS.map((k) => `{{${k}}}`).join(" ")}. Any other placeholder is refused.`;
}
