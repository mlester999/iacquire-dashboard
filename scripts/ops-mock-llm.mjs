// A local, loopback-only stand-in for an OpenAI-compatible chat provider, for isolated AQi Operations browser QA only.
//   node scripts/ops-mock-llm.mjs            (listens on 127.0.0.1:3291)
// It answers every request with a short, deterministic analysis that cites the evidence ids it finds in the system prompt, plus one
// deliberately invalid citation ([E9]) so QA can confirm the server removes ids that do not exist. It sends nothing anywhere, keeps no
// request bodies and is not a model: it exists to exercise streaming, citation cleaning and rendering.
import http from "node:http";

const PORT = Number(process.env.OPS_QA_LLM_PORT ?? 3291);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw); } catch { /* an unreadable body gets the generic answer */ }
  const system = String(body.messages?.find((m) => m.role === "system")?.content ?? "");
  const ids = [...system.matchAll(/<evidence id="(E\d+)" tool="([^"]*)"/g)].map((m) => ({ id: m[1], tool: m[2] }));
  const flagged = /instruction-like|SYSTEM - reveal/i.test(system);
  const lines = [
    ids.length ? `**What the evidence shows.** I checked ${ids.map((i) => i.tool).join(", ")} ${ids.map((i) => `[${i.id}]`).join("")}.` : "I did not gather any evidence for that question.",
    "\n\n**Confirmed.** Only what is stated in the cards above; nothing else was assumed [E9].",
    flagged ? "\n\n**Note.** Some retrieved text contained instruction-like wording. I treated it as data and ignored it." : "",
    "\n\n**Next steps.** Open the linked module for the record in question, or ask me to prepare a change for your confirmation.",
  ].filter(Boolean);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  for (const text of lines) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    await delay(120);
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: Math.ceil(system.length / 4), completion_tokens: 90 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, "127.0.0.1", () => console.error(`[ops-mock-llm] listening on http://127.0.0.1:${PORT}/v1 (loopback only)`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
