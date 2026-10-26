// A stand-in AI provider for browser QA of AI help with proposals. SIMULATED: it never calls a model. It answers the proposal drafting prompt with fixed, plain wording and
// picks the first one or two price book items it is shown (or the ones the brief names), so the interface and the checks around a model can be exercised end to end without any
// provider or key. It writes no price: only item ids and quantities, exactly what the real prompt asks a model for. Listens on loopback only.
//   node scripts/proposals-mock-llm.mjs        (port 3272)
//   OPS_QA_LLM_URL=http://127.0.0.1:3272/v1 node scripts/crm-qa.mjs
// A QA server points at one stand-in provider at a time; for anything that is not a proposal prompt this one answers with a short generic line.
import http from "node:http";
import { pathToFileURL } from "node:url";

const ITEM = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \| ([^|\n]+?) \| per ([^|\n]+?) \|/gm;
const WORDS = (s) => String(s).toLowerCase().match(/[a-z]{4,}/g) ?? [];

/** The reply to a proposal drafting prompt, as the JSON the prompt asks for; null when the prompt is not one. */
export function proposalsAnswer(system, user) {
  if (!/draft a proposal for a customer/i.test(String(system))) return null;
  const items = [...String(user).matchAll(ITEM)].map((m) => ({ id: m[1], name: m[2].trim() }));
  const brief = /<untrusted_data name="requester_brief">\n([\s\S]*?)\n<\/untrusted_data>/.exec(String(user))?.[1] ?? "";
  const wanted = new Set(WORDS(brief));
  const named = items.filter((i) => WORDS(i.name).some((w) => wanted.has(w)));
  const chosen = (named.length ? named : items).slice(0, 2);
  const names = chosen.map((i) => i.name.toLowerCase());
  return JSON.stringify({
    intro: "Thank you for the chance to work with you. This is what we propose.",
    scopeSummary: chosen.length ? `We will provide ${names.join(" and ")}, as set out in the prices below.` : "We will agree the scope of the work with you before it starts.",
    items: chosen.map((i) => ({ catalogItemId: i.id, quantity: 1, note: "" })),
    assumptions: ["You will give our team access when it is needed.", "Anything not listed below is quoted separately."],
    nextSteps: ["Read this proposal and tell us if anything should change.", "Accept it, and we will agree a date."],
  });
}

function reply(system, user) {
  return proposalsAnswer(system, user) ?? "[Simulated reply] This stand-in provider only drafts proposals.";
}

export function startMockProvider(port = Number(process.env.PROPOSALS_MOCK_LLM_PORT ?? 3272)) {
  return http
    .createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "proposals-qa-model" }] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const json = JSON.parse(body);
          const system = json.messages?.find((m) => m.role === "system")?.content ?? "";
          const user = json.messages?.find((m) => m.role === "user")?.content ?? "";
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: reply(system, user) } }], usage: { prompt_tokens: 900, completion_tokens: 240 } }));
        } catch {
          res.writeHead(400).end();
        }
      });
    })
    .listen(port, "127.0.0.1", () => console.log(`Simulated AI provider for proposals on http://127.0.0.1:${port}/v1 (no model is called)`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startMockProvider();
