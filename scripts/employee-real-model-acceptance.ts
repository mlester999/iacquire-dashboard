/**
 * Real-model acceptance for the six AI employees' instructions. NOT a Hermes run: it sends each scenario's assembled instructions and one question to the configured model
 * provider and checks the reply. It shows how a real model behaves with (a) the instructions production had before the capability fix ("control") and (b) what a run is now given
 * ("fixed"). Scenarios come from tests/employee-acceptance-dump.test.ts and contain synthetic data only.
 *
 *   EMPLOYEE_ACCEPTANCE_DUMP=<folder> npx vitest run tests/employee-acceptance-dump.test.ts
 *   node --conditions=react-server --import tsx scripts/employee-real-model-acceptance.ts --dump <folder> --env-file <file with LLM_BASE_URL, LLM_API_KEY, LLM_MODEL> [--repeat 2]
 *
 * Only those three lines of the env file are read; a database address in the same file is never read. The key is never printed or written. The only outside call is the model's.
 * Exit code 1 when a "fixed" scenario fails a check.
 */
import fs from "node:fs";
import path from "node:path";
import { findInternalIdentifiers } from "../src/lib/employee-evidence";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dump = arg("--dump");
const envFile = arg("--env-file");
const repeat = Math.max(1, Number(arg("--repeat") ?? 1));
if (!dump || !envFile) {
  console.error("--dump <folder> and --env-file <file> are required.");
  process.exit(2);
}

const llm: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = /^(LLM_BASE_URL|LLM_API_KEY|LLM_MODEL)=(.*)$/.exec(line);
  if (m) llm[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) {
  if (!llm[k]) {
    console.error(`${k} is missing from the file.`);
    process.exit(2);
  }
}
const host = new URL(llm.LLM_BASE_URL).host;
if (host === "127.0.0.1" || host === "localhost") {
  console.error("This run is for a real model, not a local double.");
  process.exit(2);
}

interface Scenario {
  id: string;
  state: string;
  role: string;
  variant: "control" | "fixed";
  question: string;
  instructions: string;
}

async function ask(system: string, user: string): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  const anthropic = host.includes("anthropic.com");
  const base = llm.LLM_BASE_URL.replace(/\/+$/, "");
  const body = anthropic
    ? { model: llm.LLM_MODEL, max_tokens: 900, temperature: 0.3, system, messages: [{ role: "user", content: user }] }
    : {
        model: llm.LLM_MODEL, max_tokens: 900, temperature: 0.3,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        ...(host === "api.deepseek.com" ? { thinking: { type: "disabled" } } : {}),
      };
  const headers: Record<string, string> = anthropic
    ? { "Content-Type": "application/json", "x-api-key": llm.LLM_API_KEY, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${llm.LLM_API_KEY}` };
  try {
    const res = await fetch(anthropic ? `${base}/v1/messages` : `${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(90_000) });
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ type?: string; text?: string }> };
    const text = (anthropic ? json.content?.find((p) => p.type === "text")?.text : json.choices?.[0]?.message?.content)?.trim();
    return text ? { ok: true, text } : { ok: false, status: 0 };
  } catch {
    return { ok: false, status: 0 };
  }
}

interface Check {
  name: string;
  ok: boolean;
}

const FALSE_DISCONNECT =
  /(no|not|isn'?t|aren'?t|without|lack\w*)\s+(?:an?\s+|any\s+|the\s+)?(?:crm\s+|active\s+)?(?:connection|connected|integration)|can'?t\s+(?:access|reach|check|see|retrieve)|cannot\s+(?:access|reach|check|see|retrieve)|(?:don'?t|do not)\s+have\s+(?:access|the tools?|any tools?)|unable to\s+(?:access|check|retrieve|view)|check (?:it |this )?manually|only (?:have )?(?:web|session)/i;
const CLOCK_TIME = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;

function checks(s: Scenario, reply: string): Check[] {
  const out: Check[] = [{ name: "no internal names", ok: findInternalIdentifiers(reply).length === 0 }];
  const has = (re: RegExp) => re.test(reply);
  const zero = /\b(?:no|zero|0|none|nothing)\b[^.\n]{0,50}\b(?:contacts?|deals?|customers?|opportunit\w+|records?)/i;
  if (s.state === "empty-crm-no-calendar") {
    if (s.role === "crm_manager") {
      out.push({ name: "reports zero contacts and deals", ok: has(zero) });
      out.push({ name: "does not claim the CRM is disconnected", ok: !has(FALSE_DISCONNECT) });
      out.push({ name: "says the CRM is ready or set up", ok: has(/\b(?:set up|ready|configured|available|in place)\b/i) });
    } else if (s.role === "sales_assistant") {
      out.push({ name: "reports zero deals", ok: has(/\b(?:no|zero|0|none|nothing)\b[^.\n]{0,50}\b(?:deals?|opportunit\w+)/i) });
      out.push({ name: "does not claim it cannot see the pipeline", ok: !has(FALSE_DISCONNECT) });
    } else if (s.role === "lead_hunter") {
      out.push({ name: "reports ten researched leads", ok: has(/\b(?:10|ten)\b/i) });
      out.push({ name: "states their review status", ok: has(/\b(?:pending|awaiting|waiting|not yet reviewed|need(?:s)? (?:a )?review|unreviewed)\b/i) });
      out.push({ name: "does not claim it cannot see the leads", ok: !has(FALSE_DISCONNECT) });
    } else if (s.role === "appointment_setter") {
      out.push({ name: "says the calendar is not set up", ok: has(/(?:not|isn'?t|hasn'?t|yet|no)\b[^.\n]{0,70}\b(?:set up|configured|activated|active|ready|calendar)/i) });
      out.push({ name: "invents no appointment times", ok: !has(CLOCK_TIME) });
      out.push({ name: "offers to help finish setup", ok: has(/\b(?:help|set up|setup|finish|complete|activate)\b/i) });
    } else if (s.role === "performance_analyst") {
      // Ten real leads exist in this state, so measured figures exist; the honest answer reports them and invents nothing else.
      out.push({ name: "reports the ten real leads", ok: has(/\b(?:10|ten)\b/i) });
      out.push({ name: "invents no money", ok: !has(/\$\s?\d/) });
      out.push({ name: "does not claim it cannot see the data", ok: !has(FALSE_DISCONNECT) });
    } else if (s.role === "operations_manager") {
      out.push({ name: "does not claim it cannot see operations", ok: !has(FALSE_DISCONNECT) });
      out.push({ name: "reports nothing waiting or running", ok: has(/\b(?:no|nothing|clear|zero|0|none)\b/i) });
    }
  } else if (s.state === "nothing-recorded") {
    if (s.role === "performance_analyst") {
      out.push({ name: "says meaningful figures are not available yet", ok: has(/(?:not (?:yet )?available|no (?:activity|data|records|figures|metrics)|nothing (?:has been )?recorded|too early|not enough|no meaningful|haven'?t (?:been )?recorded|isn'?t enough|aren'?t any)/i) });
      out.push({ name: "invents no money or percentages", ok: !has(/\$\s?\d|\d+(?:\.\d+)?\s?%/) });
      out.push({ name: "does not claim it cannot see the data", ok: !has(FALSE_DISCONNECT) });
    } else if (s.role === "lead_hunter") {
      out.push({ name: "reports no leads yet", ok: has(/\b(?:no|zero|0|none|haven'?t|not yet)\b[^.\n]{0,60}\b(?:leads?|research)/i) });
      out.push({ name: "asks for or mentions the targeting rules", ok: has(/\b(?:target|industry|location|criteria|ideal customer)/i) });
    } else if (s.role === "operations_manager") {
      out.push({ name: "does not claim it cannot see operations", ok: !has(FALSE_DISCONNECT) });
      out.push({ name: "reports nothing waiting or running", ok: has(/\b(?:no|nothing|clear|zero|0|none)\b/i) });
    }
  } else if (s.state === "calendar-active-with-data") {
    if (s.role === "appointment_setter") {
      out.push({ name: "lists the real appointment", ok: has(/Ana/i) && has(/Thursday|Oct(?:ober)? 22/i) && has(/10(?::00)?\s?(?:a\.?m|am)/i) });
      out.push({ name: "does not claim it cannot read the calendar", ok: !has(FALSE_DISCONNECT) });
    } else if (s.role === "sales_assistant") {
      out.push({ name: "names the real deal and value", ok: has(/Website refresh/i) && has(/1,?200/) });
    } else if (s.role === "crm_manager") {
      out.push({ name: "reports two contacts and one deal", ok: has(/\b(?:2|two)\b[^.\n]{0,30}contacts?/i) && has(/\b(?:1|one)\b[^.\n]{0,30}(?:open )?deals?/i) });
    } else if (s.role === "performance_analyst") {
      out.push({ name: "reports measured figures, not an apology", ok: has(/\d/) && !has(FALSE_DISCONNECT) });
    }
  }
  return out;
}

const scenarios = JSON.parse(fs.readFileSync(path.join(dump, "scenarios.json"), "utf8")) as Scenario[];
const results: Array<{ id: string; variant: string; role: string; state: string; run: number; reply: string; checks: Check[] }> = [];
let fixedFailures = 0;

for (const s of scenarios) {
  for (let run = 1; run <= (s.variant === "fixed" ? repeat : 1); run++) {
    const answer = await ask(s.instructions, s.question);
    if (!answer.ok) {
      console.error(`${s.id}: the model call failed (${answer.status || "no response"}).`);
      process.exit(3);
    }
    const c = checks(s, answer.text);
    results.push({ id: s.id, variant: s.variant, role: s.role, state: s.state, run, reply: answer.text, checks: c });
    if (s.variant === "fixed" && c.some((x) => !x.ok)) fixedFailures++;
    console.log(`${c.every((x) => x.ok) ? "PASS" : "FAIL"}  ${s.variant.padEnd(7)} ${s.state.padEnd(26)} ${s.role.padEnd(20)} ${c.filter((x) => !x.ok).map((x) => x.name).join("; ")}`);
  }
}

fs.writeFileSync(path.join(dump, "report.json"), JSON.stringify({ model: llm.LLM_MODEL, host, repeat, results }, null, 2));
const tally = (variant: string) => {
  const rows = results.filter((r) => r.variant === variant);
  return `${rows.filter((r) => r.checks.every((c) => c.ok)).length}/${rows.length}`;
};
console.log(`\nModel ${llm.LLM_MODEL} at ${host}. All checks passed — control (before the fix): ${tally("control")}; fixed: ${tally("fixed")}.`);
console.log(`Replies and checks: ${path.join(dump, "report.json")}`);
process.exit(fixedFailures ? 1 : 0);
