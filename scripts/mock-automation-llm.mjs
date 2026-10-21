// SCRIPTED STAND-IN for the AI model, for isolated browser QA of Automation Studio only (scripts/automation-qa-env.mjs points the QA server at it).
// It is NOT a model and does no reasoning: it recognises a few kinds of request in the last message and answers with fixed operations in the
// builder's real output format (a short reply, then one fenced operations block). The server still validates every operation exactly as it
// does for a real model, so this exercises the real path: validation, saving, streaming, the canvas replay. It listens on the loopback address only,
// ignores the key, stores nothing and contacts nothing.
//   node scripts/mock-automation-llm.mjs        (AUTOMATION_QA_LLM_PORT overrides the port, default 3263)
import http from "node:http";
import { AUTOMATION_QA_LLM_PORT } from "./automation-qa-env.mjs";

const FENCE = "```";
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const block = (ops) => `\n${FENCE}operations\n${JSON.stringify(ops)}\n${FENCE}`;

/** The workflow the server put in the system prompt: the JSON line after 'THE WORKFLOW "…"'. */
function currentWorkflow(system) {
  const at = system.indexOf("THE WORKFLOW \"");
  if (at < 0) return { trigger: null, steps: [] };
  const lines = system.slice(at).split("\n");
  try {
    // The workflow is one line of JSON inside a fenced data block ([[data:…]] … [[/data:…]]): the fence lines are skipped.
    return JSON.parse(lines.slice(1).find((l) => l.trim().startsWith("{")) ?? "");
  } catch {
    return { trigger: null, steps: [] };
  }
}

const WELCOME_FLOW = [
  { op: "set_trigger", trigger: { type: "contact.created" } },
  { op: "add_step", kind: "create_task", key: "welcome", name: "Welcome the lead", config: { title: "Welcome {{contact.full_name}}", priority: "high", assignee: "contact_owner" }, at: { after: null } },
  { op: "add_step", kind: "wait", key: "wait_2d", name: "Wait 2 days", config: { mode: "duration", amount: 2, unit: "days" }, at: { after: "welcome", via: "next" } },
  { op: "add_step", kind: "branch", key: "replied", name: "Did they reply?", config: { subject: "contact", filter: { op: "and", conditions: [] }, reply: "replied" }, at: { after: "wait_2d", via: "next" } },
  { op: "add_step", kind: "end", key: "done", name: "Nothing more to do", config: {}, at: { after: "replied", via: "yes" } },
  { op: "add_step", kind: "notify_team", key: "remind", name: "Remind the team", config: { roles: ["owner", "admin"], title: "No reply yet: call {{contact.full_name}}" }, at: { after: "replied", via: "no" } },
];

/** What the stand-in says and does for one request. */
export function answer({ system, message }) {
  const wf = currentWorkflow(system);
  const text = message.toLowerCase();
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  if (steps.length === 0 && /\b(build|create|make|automate|when|every|welcome|follow|lead|remind|new)\b/.test(text)) {
    return {
      reply: "Done. Each new lead gets a welcome task. Two days later, if they haven't replied, your team is reminded to call them. Nothing goes out until you publish it.",
      ops: WELCOME_FLOW,
    };
  }
  const wait = steps.find((s) => s.kind === "wait");
  const days = /(\d+)\s*days?/.exec(text)?.[1] ?? Object.entries(NUMBERS).find(([w]) => new RegExp(`\\b${w}\\s+days?\\b`).test(text))?.[1];
  if (wait && days && Number(days) >= 1) {
    return { reply: `Done. The wait is now ${days} day${Number(days) === 1 ? "" : "s"}.`, ops: [{ op: "update_step", key: wait.key, name: `Wait ${days} day${Number(days) === 1 ? "" : "s"}`, config: { amount: Number(days) } }] };
  }
  const notify = steps.find((s) => s.kind === "notify_team");
  if (notify && /\b(remove|delete|drop|get rid)\b/.test(text)) {
    return { reply: "Done. I removed the team reminder.", ops: [{ op: "remove_step", key: notify.key }] };
  }
  if (/\b(why|fail|wrong|broke)/.test(text)) return { reply: "I don't see any recent problems with this automation's runs. If something looks off, tell me which step and what you expected.", ops: null };
  return {
    reply: "This is the scripted stand-in used for testing, not a real model. It can build a welcome-and-follow-up automation from an empty canvas, change the wait to a number of days, or remove the team reminder.",
    ops: null,
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.includes("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "automation-qa-scripted-stand-in" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = String(messages.find((m) => m.role === "system")?.content ?? "");
    const last = [...messages].reverse().find((m) => m.role === "user");
    // The repair message the server sends after a refusal is not a new request: answer it with nothing to change.
    const repairing = String(last?.content ?? "").startsWith("The server refused your operations:");
    const { reply, ops } = repairing ? { reply: "I couldn't make that change safely, so I left the automation as it was.", ops: null } : answer({ system, message: String(last?.content ?? "") });
    console.log(`[automation-qa-llm] SCRIPTED STAND-IN request: ${raw.length} bytes -> ${ops ? `${ops.length} operations` : "no operations"}`);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    res.write(": scripted stand-in\n\n");
    const out = reply + (ops ? block(ops) : "");
    await sleep(350);
    for (let i = 0; i < out.length; i += 7) {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out.slice(i, i + 7) } }] })}\n\n`);
      await sleep(22);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: Math.ceil(out.length / 4) } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href || process.argv[1]?.endsWith("mock-automation-llm.mjs")) {
  server.listen(AUTOMATION_QA_LLM_PORT, "127.0.0.1", () => console.log(`[automation-qa-llm] SCRIPTED STAND-IN (not a model) listening on http://127.0.0.1:${AUTOMATION_QA_LLM_PORT}/v1`));
}
