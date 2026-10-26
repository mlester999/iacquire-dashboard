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

// The social media manager's two prompts (ideas and captions). SIMULATED: fixed, generic, evergreen text that makes no claim about the business, so what the
// product's own checks do with a model's answer can be seen without a model. It builds the topic into the wording and nothing else.
function socialAnswer(user) {
  const topic = (/about: ([^\n]{3,160}?)(?:\. Allowed kinds|\n|$)/i.exec(String(user))?.[1] ?? "seasonal maintenance").replace(/[.?!]$/, "").slice(0, 80);
  if (/"ideas"/.test(user)) {
    return JSON.stringify({ ideas: [
      { title: `A friendly reminder about ${topic}`, angle: "A short seasonal nudge that invites people to get in touch.", kind: "text", callToAction: "Send us a message." },
      { title: `Behind the scenes: ${topic}`, angle: "A photo of the team at work, with a sentence on what the job involves.", kind: "image", callToAction: "Ask us a question." },
      { title: "Three things to check this season", angle: "A simple checklist that is useful whether or not they hire anyone.", kind: "text", callToAction: "Save this for later." },
    ] });
  }
  return JSON.stringify({ options: [
    { caption: `Thinking about ${topic}? A little attention now saves trouble later. Message us and we will point you in the right direction.`, hashtags: ["maintenance", "homecare"] },
    { caption: `${topic[0].toUpperCase()}${topic.slice(1)} is easier than it sounds. Ask us anything and we will explain.`, hashtags: ["tips"] },
    { caption: "Our team is happy to answer questions. Send us a message any time.", hashtags: [] },
  ] });
}

function answer(system, user) {
  if (/write social media posts/.test(system)) return socialAnswer(user);
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
