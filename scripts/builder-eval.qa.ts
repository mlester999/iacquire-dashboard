/**
 * Runs the AI Automation Builder evaluation (tests/support/builder-eval.ts) through the real builder service against a real model, on an isolated
 * in-memory database seeded with fictional workspaces. Nothing here reads or writes a hosted database or contacts a customer: the only outside call is
 * to the model endpoint given by EVAL_LLM_BASE_URL / EVAL_LLM_API_KEY / EVAL_LLM_MODEL, carrying synthetic prompts and a synthetic workspace.
 *
 *   node scripts/run-builder-eval.mjs [--only <scenario id>]... [--repeat N]
 *
 * Results: .data/builder-eval/<model>-<time>.json and a summary on stdout. Failures are reported as they are; a scenario is never retried to look better.
 */
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { withSystem } from "../src/server/db/index";
import { getStudioState, startStudioWorkflow } from "../src/server/automation-studio/studio";
import { runBuilderTurn, type LlmPort } from "../src/server/automation-studio/builder/service";
import { llmStream, type LlmConfig, type LlmStreamEvent, type LlmStreamInput } from "../src/server/llm/client";
import { loadBuilderOptions } from "../src/server/crm/workflows/context";
import { validateDefinition, validationContextFrom, type WorkflowDefinition } from "../src/lib/crm/workflow/spec";
import type { BuilderEvent } from "../src/lib/automation-studio/types";
import { studioWorkspace } from "../tests/support/studio-workspace";
import { SCENARIOS, meetsExpectation, summarise, type EvalScenario, type Outcome } from "../tests/support/builder-eval";
import { HELDOUT_SCENARIOS, type HeldOutScenario } from "../tests/support/builder-eval-heldout";
import { HELDOUT_B } from "../tests/support/builder-eval-heldout-b";

const baseUrl = process.env.EVAL_LLM_BASE_URL ?? "";
const apiKey = process.env.EVAL_LLM_API_KEY ?? "";
const model = process.env.EVAL_LLM_MODEL ?? "";
/** EVAL_SET: "tuned" (the default, the set the prompt was developed against), "heldout" (everything in builder-eval-heldout.ts), or "heldout-A" / "heldout-B". */
const evalSet = process.env.EVAL_SET ?? "tuned";
const pool: Array<EvalScenario & { timezone?: string }> = evalSet === "tuned" ? SCENARIOS : ([...HELDOUT_SCENARIOS, ...HELDOUT_B] as HeldOutScenario[]).filter((s) => evalSet === "heldout" || evalSet === `heldout-${s.set}`);
const only = (process.env.EVAL_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const repeat = Math.max(1, Math.min(5, Number(process.env.EVAL_REPEAT ?? 1) || 1));
const OUT = path.resolve(".data/builder-eval");

interface CallRecord {
  ms: number;
  firstDeltaMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  outputChars: number;
  failed: boolean;
  /** What the model wrote (kept short), for turns that did not pass. */
  text: string;
  /** The last message the model was sent: for a correction call, why the server refused the call before it. */
  lastSent: string;
}

function instrumented(config: LlmConfig) {
  const calls: CallRecord[] = [];
  const port: LlmPort = {
    resolve: async () => ({ config, reason: "ready", connectionStatus: "connected", provider: "eval", model: config.model, host: new URL(config.baseUrl).host }),
    async *stream(c: LlmConfig, input: LlmStreamInput, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent> {
      const rec: CallRecord = { ms: 0, firstDeltaMs: null, inputTokens: null, outputTokens: null, outputChars: 0, failed: false, text: "", lastSent: (input.messages[input.messages.length - 1]?.content ?? "").slice(0, 900) };
      const t0 = performance.now();
      calls.push(rec);
      try {
        for await (const ev of llmStream(c, input, signal)) {
          if (ev.type === "delta") {
            rec.firstDeltaMs ??= Math.round(performance.now() - t0);
            rec.outputChars += ev.text.length;
            if (rec.text.length < 5000) rec.text += ev.text;
          } else {
            if (ev.inputTokens !== undefined) rec.inputTokens = ev.inputTokens;
            if (ev.outputTokens !== undefined) rec.outputTokens = ev.outputTokens;
          }
          yield ev;
        }
      } catch (err) {
        rec.failed = true;
        throw err;
      } finally {
        rec.ms = Math.round(performance.now() - t0);
      }
    },
  };
  return { port, calls };
}

const canonical = (d: WorkflowDefinition) => JSON.stringify({ t: d.trigger, s: d.steps.map(({ ui: _ui, ...x }) => x) });

interface TurnResult {
  say: string;
  outcome: Outcome;
  reply: string;
  changed: boolean;
  passed: boolean;
  problems: string[];
  providerCalls: number;
  repairs: number;
  latencyMs: number;
  firstDeltaMs: number | null;
  inputTokens: number;
  outputTokens: number;
  tokensEstimated: boolean;
  validationErrorsAfter: number;
  /** What the builder applied, as proposed and validated (empty when nothing changed). */
  operations: unknown[];
  /** What the model wrote on each call, only for a turn that did not pass. */
  rawOutputs?: string[];
}

it("evaluates the AI Automation Builder against the configured model", async () => {
  if (!baseUrl || !apiKey || !model) throw new Error("EVAL_LLM_BASE_URL, EVAL_LLM_API_KEY and EVAL_LLM_MODEL are required (scripts/run-builder-eval.mjs sets them).");
  const config: LlmConfig = { baseUrl, apiKey, model, format: "openai", source: "environment" };
  const results: Array<{ id: string; category: string; title: string; run: number; passed: boolean; turns: TurnResult[]; finalProblem: string | null }> = [];

  for (let run = 1; run <= repeat; run++) {
    for (const scenario of pool.filter((s) => !only.length || only.includes(s.id))) {
     try {
      const ws = await studioWorkspace({ injected: scenario.injected, connections: scenario.connections, timezone: scenario.timezone, name: `Eval ${scenario.id} ${run}` });
      const actor = ws.o.actor("owner");
      const initial = scenario.initial?.(ws);
      const { id } = await startStudioWorkflow(actor, { name: scenario.title, ...(initial ? { definition: initial } : {}), label: "Evaluation fixture" });
      if (scenario.failedRun) {
        await withSystem(async (db) => {
          const v = await db.query<{ id: string }>("insert into crm_workflow_versions (org_id, workflow_id, version, trigger_config, steps, content_hash) values ($1, $2, 1, '{\"type\":\"contact.created\"}', '[]', $3) returning id", [ws.o.org.id, id, "c".repeat(64)]);
          await db.query("insert into crm_workflow_runs (org_id, workflow_id, version_id, started_via, status, current_step, last_error, finished_at) values ($1, $2, $3, 'event', 'failed', $4, $5, now())", [ws.o.org.id, id, v.rows[0].id, scenario.failedRun!.step, scenario.failedRun!.error]);
        });
      }
      const turns: TurnResult[] = [];
      const { port, calls } = instrumented(config);
      let finalDef: WorkflowDefinition = (await getStudioState(actor, id)).workflow.draft;
      for (const turn of scenario.turns) {
        const before = (await getStudioState(actor, id)).workflow.draft;
        const selectedKey = turn.select ? before.steps.find((s) => s.kind === turn.select)?.key ?? null : null;
        const firstCall = calls.length;
        const events: BuilderEvent[] = [];
        const t0 = performance.now();
        try {
          for await (const ev of runBuilderTurn(actor, id, { message: turn.say, selectedKey }, port)) events.push(ev);
        } catch (err) {
          events.push({ type: "error", code: "thrown", message: err instanceof Error ? err.message.slice(0, 200) : "threw" });
        }
        const latencyMs = Math.round(performance.now() - t0);
        const mine = calls.slice(firstCall);
        const done = [...events].reverse().find((e) => e.type === "done") as Extract<BuilderEvent, { type: "done" }> | undefined;
        const outcome: Outcome = events.some((e) => e.type === "applied") ? "applied" : events.some((e) => e.type === "refused") ? "refused" : events.some((e) => e.type === "error") ? "error"
          : done?.message.status === "clarification" ? "clarification" : "answered";
        const reply = done?.message.content ?? (events.find((e) => e.type === "error") as { message?: string } | undefined)?.message ?? "";
        const after = (await getStudioState(actor, id)).workflow.draft;
        finalDef = after;
        const changed = canonical(after) !== canonical(before);
        const problems: string[] = [];
        const expectation = meetsExpectation(turn.expect, outcome, changed);
        if (expectation) problems.push(expectation);
        const checked = turn.check?.({ def: after, before, ws, reply, outcome });
        if (checked) problems.push(checked);
        const options = await withSystem((db) => loadBuilderOptions(db, ws.o.org.id));
        const errors = validateDefinition(after, validationContextFrom(options)).filter((i) => i.level === "error").length;
        const estimated = mine.some((c) => c.inputTokens === null || c.outputTokens === null);
        const appliedEvent = events.find((e) => e.type === "applied") as Extract<BuilderEvent, { type: "applied" }> | undefined;
        turns.push({
          operations: appliedEvent?.operations ?? [],
          rawOutputs: problems.length ? mine.map((c, i) => (i > 0 ? `[sent to the model: ${c.lastSent}]
` : "") + c.text) : undefined,
          say: turn.say, outcome, reply: reply.slice(0, 600), changed, passed: problems.length === 0, problems, providerCalls: mine.length, repairs: Math.max(0, mine.length - 1), latencyMs,
          firstDeltaMs: mine[0]?.firstDeltaMs ?? null,
          inputTokens: mine.reduce((n, c) => n + (c.inputTokens ?? 0), 0), outputTokens: mine.reduce((n, c) => n + (c.outputTokens ?? Math.ceil(c.outputChars / 4)), 0), tokensEstimated: estimated,
          validationErrorsAfter: errors,
        });
        console.log(`${problems.length ? "FAIL" : "PASS"}  ${scenario.id} (run ${run}) turn ${turns.length}: ${outcome}, ${latencyMs} ms, ${mine.length} call(s)${problems.length ? ` -> ${problems.join("; ")}` : ""}`);
      }
      const finalProblem = scenario.final?.({ def: finalDef, ws }) ?? null;
      if (finalProblem) console.log(`FAIL  ${scenario.id} (run ${run}) final: ${finalProblem}`);
      results.push({ id: scenario.id, category: scenario.category, title: scenario.title, run, passed: turns.every((t) => t.passed) && !finalProblem, turns, finalProblem });
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, "partial.json"), JSON.stringify({ model, results }, null, 2));
     } catch (err) {
      // A scenario the harness itself could not run is recorded as a failure with its cause, and the rest still run.
      const message = err instanceof Error ? err.message.slice(0, 300) : "unknown";
      console.log(`FAIL  ${scenario.id} (run ${run}) harness: ${message}`);
      results.push({ id: scenario.id, category: scenario.category, title: scenario.title, run, passed: false, turns: [], finalProblem: `harness error: ${message}` });
     }
    }
  }

  const allTurns = results.flatMap((r) => r.turns);
  const applied = allTurns.filter((t) => t.outcome === "applied");
  const byCategory = Object.fromEntries([...new Set(results.map((r) => r.category))].map((c) => {
    const rs = results.filter((r) => r.category === c);
    return [c, { scenarios: rs.length, passed: rs.filter((r) => r.passed).length }];
  }));
  const summary = {
    set: evalSet, model, endpointHost: new URL(baseUrl).host, finishedAt: new Date().toISOString(), repeat,
    scenarios: results.length, scenariosPassed: results.filter((r) => r.passed).length,
    turns: allTurns.length, turnsPassed: allTurns.filter((t) => t.passed).length,
    appliedTurns: applied.length, appliedFirstTry: applied.filter((t) => t.providerCalls === 1).length, appliedWithRepair: applied.filter((t) => t.providerCalls > 1).length,
    refusedTurns: allTurns.filter((t) => t.outcome === "refused").length, errorTurns: allTurns.filter((t) => t.outcome === "error").length,
    leftInvalid: applied.filter((t) => t.validationErrorsAfter > 0).length,
    providerCalls: allTurns.reduce((n, t) => n + t.providerCalls, 0),
    latencyMs: summarise(allTurns.map((t) => t.latencyMs)), firstDeltaMs: summarise(allTurns.flatMap((t) => (t.firstDeltaMs === null ? [] : [t.firstDeltaMs]))),
    inputTokens: allTurns.reduce((n, t) => n + t.inputTokens, 0), outputTokens: allTurns.reduce((n, t) => n + t.outputTokens, 0), tokensEstimatedTurns: allTurns.filter((t) => t.tokensEstimated).length,
    byCategory,
  };
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${model.replace(/[^a-z0-9._-]+/gi, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nSUMMARY ${JSON.stringify(summary, null, 2)}\nWritten to ${path.relative(process.cwd(), file)}`);
}, 3 * 60 * 60_000);
