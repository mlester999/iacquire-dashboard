// Plays one evaluation scenario through the real builder service with the model replaced by scripted answers (no model, no network). Used by the
// held-out set's harness test; the tuned set's test (tests/automation-builder-eval.test.ts) has its own copy of the same loop.
import { withSystem } from "@/server/db";
import { getStudioState, startStudioWorkflow } from "@/server/automation-studio/studio";
import { runBuilderTurn, type LlmPort } from "@/server/automation-studio/builder/service";
import { loadBuilderOptions } from "@/server/crm/workflows/context";
import { validateDefinition, validationContextFrom, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { LlmConfig, LlmResolution, LlmStreamEvent } from "@/server/llm/client";
import type { BuilderEvent } from "@/lib/automation-studio/types";
import { meetsExpectation, type EvalScenario, type Outcome } from "./builder-eval";
import { studioWorkspace, type StudioWorkspace } from "./studio-workspace";

export const FENCE = "```";
export const block = (reply: string, operations: unknown[]) => `${reply}\n${FENCE}operations\n${JSON.stringify(operations)}\n${FENCE}`;

const config: LlmConfig = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "scripted", apiKey: "never-shown", source: "environment" };
const ready: LlmResolution = { config, reason: "ready", connectionStatus: "connected", provider: "scripted", model: "scripted", host: "llm.example.test" };

/** A model that gives the same text to every call (a correction repeats it, which is what a model that cannot do better would do). */
export function scriptedModel(text: string): LlmPort {
  return {
    resolve: async () => ready,
    async *stream(): AsyncGenerator<LlmStreamEvent> {
      yield { type: "delta", text };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
    },
  };
}

export interface Played { passed: boolean; problems: string[]; outcomes: Outcome[] }

const canonical = (d: WorkflowDefinition) => JSON.stringify({ t: d.trigger, s: d.steps.map(({ ui: _ui, ...x }) => x) });

export async function playScenario(scenario: EvalScenario & { timezone?: string }, answers: (ws: StudioWorkspace) => string[]): Promise<Played> {
  const ws = await studioWorkspace({ injected: scenario.injected, connections: scenario.connections, timezone: scenario.timezone, name: `Check ${scenario.id}` });
  const actor = ws.o.actor("owner");
  const initial = scenario.initial?.(ws);
  const { id } = await startStudioWorkflow(actor, { name: scenario.title, ...(initial ? { definition: initial } : {}), label: "Evaluation fixture" });
  if (scenario.failedRun) {
    await withSystem(async (db) => {
      const v = await db.query<{ id: string }>("insert into crm_workflow_versions (org_id, workflow_id, version, trigger_config, steps, content_hash) values ($1, $2, 1, '{\"type\":\"contact.created\"}', '[]', $3) returning id", [ws.o.org.id, id, "c".repeat(64)]);
      await db.query("insert into crm_workflow_runs (org_id, workflow_id, version_id, started_via, status, current_step, last_error, finished_at) values ($1, $2, $3, 'event', 'failed', $4, $5, now())", [ws.o.org.id, id, v.rows[0].id, scenario.failedRun!.step, scenario.failedRun!.error]);
    });
  }
  const replies = answers(ws);
  const problems: string[] = [];
  const outcomes: Outcome[] = [];
  let finalDef = (await getStudioState(actor, id)).workflow.draft;
  for (const [i, turn] of scenario.turns.entries()) {
    const before = (await getStudioState(actor, id)).workflow.draft;
    const selectedKey = turn.select ? before.steps.find((s) => s.kind === turn.select)?.key ?? null : null;
    const reply = replies[Math.min(i, replies.length - 1)];
    const events: BuilderEvent[] = [];
    for await (const ev of runBuilderTurn(actor, id, { message: turn.say, selectedKey }, scriptedModel(reply))) events.push(ev);
    const done = [...events].reverse().find((e) => e.type === "done") as Extract<BuilderEvent, { type: "done" }> | undefined;
    const outcome: Outcome = events.some((e) => e.type === "applied") ? "applied" : events.some((e) => e.type === "refused") ? "refused" : events.some((e) => e.type === "error") ? "error"
      : done?.message.status === "clarification" ? "clarification" : "answered";
    const text = done?.message.content ?? "";
    const after = (await getStudioState(actor, id)).workflow.draft;
    finalDef = after;
    outcomes.push(outcome);
    const expectation = meetsExpectation(turn.expect, outcome, canonical(after) !== canonical(before));
    if (expectation) problems.push(expectation);
    const checked = turn.check?.({ def: after, before, ws, reply: text, outcome });
    if (checked) problems.push(checked);
  }
  const finalProblem = scenario.final?.({ def: finalDef, ws });
  if (finalProblem) problems.push(finalProblem);
  const options = await withSystem((db) => loadBuilderOptions(db, ws.o.org.id));
  const invalid = validateDefinition(finalDef, validationContextFrom(options)).filter((i) => i.level === "error" && !scenario.initial);
  if (invalid.length && outcomes.includes("applied")) problems.push(`left ${invalid.length} validation error(s)`);
  return { passed: problems.length === 0, problems, outcomes };
}
