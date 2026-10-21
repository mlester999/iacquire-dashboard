// A stand-in AI provider for browser QA of the Unified Inbox's AI help. SIMULATED: it never calls a model. It answers the two prompts the inbox
// sends (summary and next steps, suggested reply) with fixed text built from the words of the conversation it was given, so the interface can
// be exercised end to end without any provider or key. Listens on loopback only.
//   node scripts/inbox-mock-llm.mjs            (port 3271)
//   OPS_QA_LLM_URL=http://127.0.0.1:3271/v1 node scripts/crm-qa.mjs
import http from "node:http";

const port = Number(process.env.INBOX_MOCK_LLM_PORT ?? 3271);

function lastCustomerLine(user) {
  const lines = String(user).split("\n").filter((l) => l.startsWith("CUSTOMER:"));
  return (lines.at(-1) ?? "CUSTOMER: (nothing)").replace(/^CUSTOMER:\s*/, "").slice(0, 160);
}

function answer(system, user) {
  const last = lastCustomerLine(user);
  if (/You brief a team member/.test(system)) {
    // Echoes any instruction-looking text only as data, which is what the real prompt guards against.
    return `SUMMARY:\n[Simulated summary] The customer's latest message was: "${last}". Nothing has been promised yet.\nNEXT STEPS:\n- Confirm what the customer needs\n- Offer a time to visit\nHUMAN REVIEW:\n${/refund|real person|lawyer|complain/i.test(user) ? "The customer asked for a person or mentioned a refund." : "NONE"}\nCONFIDENCE: medium`;
  }
  return `[Simulated draft] Thanks for your message. We'll look into "${last.slice(0, 80)}" and confirm the details with you shortly.`;
}

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "ops-qa-model" }] }));
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
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: answer(system, user) } }] }));
      } catch {
        res.writeHead(400).end();
      }
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`Simulated AI provider on http://127.0.0.1:${port}/v1 (no model is called)`));
