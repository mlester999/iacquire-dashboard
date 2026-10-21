import "server-only";
import type { WorkflowBuilderOptions } from "@/server/crm/workflows/context";
import type { ValidationIssue, WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { OPERATION_FORMAT_NOTES } from "@/server/automation-studio/builder/operations-notes";
import { conditionCatalog, employeeCatalog, limitsNote, stepCatalog, tokenNote, triggerCatalog } from "@/server/automation-studio/builder/catalog";

/**
 * The AI Automation Builder's instructions and the context of one turn. The builder is not AQi (navigation and help) and not an AI employee: it
 * is a specialist that changes ONE workflow, and only by proposing the validated operations of src/lib/crm/workflow/operations.ts. The server
 * applies them in strict mode; nothing the model writes is ever executed.
 */

export interface RunProblem {
  status: string;
  step: string | null;
  error: string | null;
  at: string;
}

export interface TurnHistory {
  role: "user" | "assistant";
  content: string;
}

export interface BuilderContext {
  workflowName: string;
  workflowStatus: string;
  definition: WorkflowDefinition;
  issues: ValidationIssue[];
  options: WorkflowBuilderOptions;
  recentProblems: RunProblem[];
  selectedKey: string | null;
  /** The org's timezone (for times of day). */
  timezone: string;
}

const MAX_JSON = 24_000;

function clip(text: string, max = MAX_JSON): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[shortened]`;
}

/** The definition as the model should see it: no editor layout, so a dragged node never looks like a change of meaning. */
export function definitionForModel(def: WorkflowDefinition): string {
  return JSON.stringify({ trigger: def.trigger, steps: def.steps.map(({ ui: _ui, ...s }) => s) });
}

/** What the workspace has, by name and id: the only things a step may refer to. No contact, message or customer data is ever included. */
export function workspaceForModel(o: WorkflowBuilderOptions): string {
  const list = (items: unknown[]) => (items.length ? JSON.stringify(items) : "none");
  return [
    `tags: ${list(o.tags.map((t) => ({ id: t.id, name: t.name })))}`,
    `team members who can own records: ${list(o.users.map((u) => ({ id: u.id, name: u.name, role: u.role })))}`,
    `pipelines: ${list(o.pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })) })))}`,
    `custom fields: ${list(o.fields.map((f) => ({ id: f.id, label: f.label, entity: f.entity, type: f.type, options: f.options.length ? f.options.map((x) => x.value) : undefined })))}`,
    `approved message templates (the ONLY messages a workflow may send; copy templateId, contentHash and channel exactly): ${list(o.templates.map((t) => ({ templateId: t.id, name: t.name, channel: t.channel, purpose: t.purpose, contentHash: t.contentHash })))}`,
    `AI employees in this workspace: ${list(o.agents.map((a) => ({ roleKey: a.roleKey, name: a.name, mode: a.mode, readyToChat: a.ready })))}`,
    `verified n8n automations: ${list(o.n8nMappings.map((m) => ({ mappingId: m.id, label: m.label, problem: m.problem ?? undefined })))}`,
    `outbound webhook endpoints: ${list(o.webhookSubscriptions.map((w) => ({ subscriptionId: w.id, name: w.name, host: w.host })))}`,
    `calendars: ${list(o.calendars.map((c) => ({ id: c.id, name: c.name })))}; appointment types: ${list(o.appointmentTypes.map((t) => ({ id: t.id, name: t.name, calendarId: t.calendarId })))}`,
    `forms: ${list((o.forms ?? []).map((f) => ({ id: f.id, name: f.name })))}`,
    `assignment rules: ${list(o.assignmentRules.map((r) => ({ id: r.id, name: r.name, entity: r.entity })))}`,
    `configuration values usable as {{custom_values.<key>}}: ${list((o.customValues ?? []).map((v) => v.key))}`,
  ].join("\n");
}

export function buildSystemPrompt(ctx: BuilderContext): string {
  const problems = ctx.issues.filter((i) => i.level === "error").slice(0, 12).map((i) => `- ${i.stepKey ? `[${i.stepKey}] ` : ""}${i.message}`);
  const warnings = ctx.issues.filter((i) => i.level === "warning").slice(0, 6).map((i) => `- ${i.stepKey ? `[${i.stepKey}] ` : ""}${i.message}`);
  const runs = ctx.recentProblems.length
    ? ctx.recentProblems.map((r) => `- ${r.at}: ${r.status}${r.step ? ` at step "${r.step}"` : ""}${r.error ? `: ${r.error}` : ""}`).join("\n")
    : "none recently";
  return clip(`You are the AI Automation Builder inside iAcquire Automation Studio. You help a business owner build and change ONE automation (a workflow) in their own workspace. You are a specialist for this job: you are not the help assistant (AQi) and you are not one of their AI employees.

HOW YOU WORK
- You change the workflow ONLY by proposing "operations" (below). The server checks every operation against the workspace and refuses anything invalid, so never guess an id: use only ids from the workspace lists. You never write or run code, and you cannot send messages, call outside systems or switch the automation on; you only edit its draft.
- Always edit the EXISTING workflow shown below. Never rebuild it from scratch or duplicate it. Keep everything the person did not ask you to change, including their manual edits and step names.
- Ask a question only when you truly cannot proceed (for example the workspace has no suitable approved message template, or two different tags could both be meant). Prefer a sensible default and say what you chose. At most one question at a time.
- If a step needs something the workspace doesn't have (an approved message template, a tag, a pipeline), say so plainly and tell the person where to add it, instead of inventing it. Never put raw message text into a step: messages are sent only from approved templates.
- Anything that messages customers, calls an outside system or asks an AI employee needs the business owner's approval of the exact published version before it runs. Mention this once when you add such a step. Never say a message was sent or an automation ran: you only edit the draft.
- If asked why something failed, use the recent run problems below and explain in plain words what happened and what would fix it. Do not blame the person.
- Reply in short, friendly, plain language. No jargon, no emojis, no markdown headings. A few short sentences, or a short list when there are several changes. Describe what you changed, not what you are about to do.
- If the person's message names or refers to "this", "that step" or "it" and a step is selected, they mean the selected step.

OUTPUT FORMAT (exactly)
First write your reply to the person. If you are changing the workflow, then on a new line write a fenced block starting with three backticks and the word operations, containing ONE JSON array of operations, and close the fence. If you are not changing anything (a question, an explanation), write no block. Write nothing after the closing fence.

${OPERATION_FORMAT_NOTES}

WHAT STARTS A WORKFLOW
${triggerCatalog()}

CONDITIONS
${conditionCatalog()}

STEP KINDS (config is JSON Schema; "key" values you choose must be lower-case letters, numbers, - and _)
${stepCatalog()}

AI EMPLOYEES (roleKey values)
${employeeCatalog()}
Asking an employee to do something ("ai_task") uses its own mode and permissions; a workflow never gives an employee more access than it already has.

LIMITS
${limitsNote()}
${tokenNote()}

THIS WORKSPACE (timezone ${ctx.timezone})
${workspaceForModel(ctx.options)}

THE WORKFLOW "${ctx.workflowName}" (status: ${ctx.workflowStatus}; the first step in the list runs first)
${definitionForModel(ctx.definition)}
${ctx.selectedKey ? `SELECTED STEP: "${ctx.selectedKey}"` : "No step is selected."}
Problems that stop it being published now:
${problems.length ? problems.join("\n") : "none"}
${warnings.length ? `Things to be aware of:\n${warnings.join("\n")}` : ""}
Recent run problems:
${runs}`, 60_000);
}

export function buildMessages(history: TurnHistory[], message: string, selectedKey: string | null): Array<{ role: "user" | "assistant"; content: string }> {
  const turns = history.slice(-12).map((m) => ({ role: m.role, content: clip(m.content, 2000) }));
  // The model API wants the conversation to start with the person and alternate; merge neighbours of the same role.
  const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${t.content}`;
    else merged.push({ ...t });
  }
  while (merged.length && merged[0].role === "assistant") merged.shift();
  const note = selectedKey ? `\n\n(The person has the step "${selectedKey}" selected.)` : "";
  const current = `${clip(message, 4000)}${note}`;
  const last = merged[merged.length - 1];
  if (last && last.role === "user") last.content += `\n\n${current}`;
  else merged.push({ role: "user", content: current });
  return merged;
}

/** What goes back to the model when its proposal was refused, so it can correct itself once or twice. */
export function repairMessage(reason: string): string {
  return `The server refused your operations: ${reason}\nNothing was changed. If a correction is possible, write a short reply and a corrected operations block (only the corrected change, applied to the workflow as it is now). If it is not possible, explain to the person what is missing and do not write an operations block.`;
}
