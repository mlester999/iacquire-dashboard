import type { AgentSettings } from "@/lib/agent-settings";

export const EMPLOYEE_GENERATED_FIELDS = [
  ["personality", "Personality"],
  ["characterTraits", "Traits"],
  ["communicationStyle", "Communication style"],
  ["responseBehavior", "Response behavior"],
  ["responsibilities", "Responsibilities"],
  ["goals", "Goals"],
  ["operatingProcedures", "Operating procedures"],
  ["proactiveResponsibilities", "Proactive work"],
  ["reportingBehavior", "Reporting"],
] as const satisfies ReadonlyArray<readonly [keyof Pick<AgentSettings,
  "personality" | "characterTraits" | "communicationStyle" | "responseBehavior" |
  "operatingProcedures" | "proactiveResponsibilities" | "reportingBehavior" | "responsibilities" | "goals"
>, string]>;

export type EmployeeGeneratedFields = Pick<AgentSettings,
  "personality" | "characterTraits" | "communicationStyle" | "responseBehavior" |
  "operatingProcedures" | "proactiveResponsibilities" | "reportingBehavior" | "responsibilities" | "goals"
>;

type GeneratedField = (typeof EMPLOYEE_GENERATED_FIELDS)[number][0];

/** Apply suggestions to empty fields, and optionally replace untouched role-template defaults
 * while preparing a brand-new internal config. Existing non-default text is always preserved. */
export function mergeGeneratedEmployeeFields(
  current: AgentSettings,
  generated: EmployeeGeneratedFields,
  replaceableDefaults?: Pick<AgentSettings, GeneratedField>,
): { settings: AgentSettings; applied: GeneratedField[]; preserved: GeneratedField[] } {
  const settings = { ...current };
  const applied: GeneratedField[] = [];
  const preserved: GeneratedField[] = [];

  for (const [field] of EMPLOYEE_GENERATED_FIELDS) {
    const existing = current[field];
    const isBlank = existing.trim().length === 0;
    const isUntouchedDefault = replaceableDefaults !== undefined && existing === replaceableDefaults[field];
    if (!isBlank && !isUntouchedDefault) {
      preserved.push(field);
      continue;
    }
    settings[field] = generated[field];
    if (settings[field] !== existing) applied.push(field);
  }

  return { settings, applied, preserved };
}
