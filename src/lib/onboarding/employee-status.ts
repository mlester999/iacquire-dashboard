// What a client's employee card says while the employee is not working yet. "Setup required" has two very different reasons (the setup payment is not confirmed, or no Hermes
// profile is connected yet) and the card says which one. Pure: the gallery renders what this returns and the tests read it without a screen.
import { setupRequiredLine, SETUP_REQUIRED_LABEL, type AgentStatus } from "@/lib/agents";
import type { EmployeeReadiness } from "@/lib/workforce-readiness";

export interface EmployeeCardStatus {
  /** The pill. */
  label: string;
  /** The line under it. */
  line: string;
}

/** Stages that already say something more specific than "Setup required": a change waiting for review, or an employee that is switched off. */
const KEEPS_OWN_WORDING: ReadonlySet<EmployeeReadiness["stage"]> = new Set(["review", "disabled", "suspended", "degraded", "incomplete"]);

export function employeeCardStatus(
  readiness: Pick<EmployeeReadiness, "label" | "title" | "stage" | "chatAvailable">,
  input: { status: AgentStatus; enabled: boolean; paymentCleared?: boolean | null },
): EmployeeCardStatus {
  const own = { label: readiness.label, line: readiness.title };
  if (readiness.chatAvailable || KEEPS_OWN_WORDING.has(readiness.stage)) return own;
  const line = setupRequiredLine(input);
  return line ? { label: SETUP_REQUIRED_LABEL, line } : own;
}
