// The CRM's template checks on a template of a Blueprint, and the package's configuration values as the token picker knows them. Pure.
import { validateTemplate, type CustomValueTokenDef, type TemplateValidation } from "@/lib/messaging/tokens";
import type { BlueprintContent, MessageTemplateAsset } from "@/lib/crm/blueprints/types";

/** The package's configuration values as the token picker and the checks know them. */
export function valueTokenDefs(content: BlueprintContent): CustomValueTokenDef[] {
  return content.assets.customValues.map((v) => ({ key: v.key, label: v.label, required: v.required, group: v.groupName, value: v.value }));
}

/**
 * The template checks the CRM makes, on a template of this Blueprint. A {{custom_values.<key>}} this Blueprint doesn't define is not an error
 * here: a client that already has that value can still use the template, so it is a note to check.
 */
export function blueprintTemplateCheck(t: MessageTemplateAsset, content: BlueprintContent): TemplateValidation {
  const check = validateTemplate(t.body, t.subject, t.channel, { purpose: t.purpose, kind: t.kind, customValues: valueTokenDefs(content) });
  const unknown = check.errors.filter((i) => i.code === "unknown_custom_value");
  if (!unknown.length) return check;
  const errors = check.errors.filter((i) => i.code !== "unknown_custom_value");
  const warnings = [
    ...unknown.map((i) => ({ ...i, level: "warning" as const, message: `${i.token ?? "A configuration value"} isn't one of this Blueprint's configuration values, so each client must already have it. Add it under Configuration values to bring it along.` })),
    ...check.warnings,
  ];
  return { ...check, ok: errors.length === 0, errors, warnings };
}
