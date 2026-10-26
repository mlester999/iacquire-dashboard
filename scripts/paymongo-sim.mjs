// A stand-in for PayMongo, for the isolated QA app ONLY: node scripts/paymongo-sim.mjs (127.0.0.1:3281). It answers the one call the application makes (create a hosted checkout), shows
// a page where a person plays the buyer ("Pay", "Cancel"), and then does what PayMongo would: sends the application a SIGNED webhook, with the same signature scheme the real
// one uses and a made-up secret. It also has a small control page (/control) to send a refund or a dispute notice for a session, so those paths can be driven in a browser.
//
// Nothing here is PayMongo, and nothing leaves this machine: it listens on loopback only, the application refuses its address everywhere but development and test (src/server/env.ts),
// and the keys are made up. What it proves is the application's handling of a correctly SIGNED notice; it proves nothing about PayMongo's real behaviour, whose payload shapes were
// written from its documentation and have never been seen from a PayMongo account.
//
//   CRM_QA_PAYMONGO_SIM=1 node scripts/inbox-qa.mjs     (the app, with the simulator's keys and address)
//   node scripts/paymongo-sim.mjs                        (this)
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PAYMONGO_SIM_PORT ?? 3281);
const APP = (process.env.PAYMONGO_SIM_APP ?? "http://127.0.0.1:3270").replace(/\/$/, "");
const KEY = "sk_test_qasimulatedprovider";
const SECRET = "whsec_qa_simulated_provider_secret";
const sessions = new Map();
const log = [];
const note = (line) => { log.unshift(`${new Date().toLocaleTimeString()}  ${line}`); log.length = Math.min(log.length, 40); console.log(line); };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rand = (n) => crypto.randomBytes(n).toString("hex");
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#111}h1{font-size:20px}.box{border:1px solid #ccd;border-radius:12px;padding:16px;margin:16px 0}button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #223;background:#223;color:#fff;cursor:pointer;margin-right:8px}button.alt{background:#fff;color:#223}code{background:#eef;padding:1px 4px;border-radius:4px}.warn{background:#fff7d6;border:1px solid #e6c84a;padding:10px;border-radius:10px;font-size:13px}</style></head><body>${body}</body></html>`;

const read = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); });
const send = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers }); res.end(body); };
const json = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const wrap = (type, resource, eventId = `evt_sim_${rand(8)}`) => JSON.stringify({ data: { id: eventId, type: "event", attributes: { type, livemode: false, created_at: Math.floor(Date.now() / 1000), updated_at: Math.floor(Date.now() / 1000), data: resource } } });

function paidBody(s) {
  return wrap("checkout_session.payment.paid", {
    id: s.id, type: "checkout_session",
    attributes: {
      reference_number: s.reference, status: "active", metadata: { reference: s.reference },
      payment_intent: { id: `pi_sim_${rand(5)}`, type: "payment_intent", attributes: { amount: s.amount, currency: s.currency, status: "succeeded" } },
      payments: [{ id: s.paymentId, type: "payment", attributes: { amount: s.amount, fee: Math.round(s.amount * 0.03), net_amount: s.amount - Math.round(s.amount * 0.03), currency: s.currency, status: "paid" } }],
    },
  });
}
const refundBody = (s, amount) => wrap("payment.refund.updated", { id: `ref_sim_${rand(5)}`, type: "refund", attributes: { payment_id: s.paymentId, amount: amount ?? s.amount, currency: s.currency, status: "succeeded" } });
const disputeBody = (s) => wrap("payment.dispute.created", { id: `dsp_sim_${rand(5)}`, type: "dispute", attributes: { payment_id: s.paymentId } });

async function deliver(body) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  try {
    const res = await fetch(`${APP}/api/webhooks/paymongo`, { method: "POST", headers: { "Content-Type": "application/json", "Paymongo-Signature": `t=${t},te=${sig},li=` }, body });
    return `${res.status} ${(await res.text()).slice(0, 120)}`;
  } catch (error) {
    return `could not reach the app: ${error.message}`;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "POST" && url.pathname === "/v2/checkout_sessions") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`) return json(res, 401, { errors: [{ code: "authentication_failed" }] });
      const body = JSON.parse(await read(req));
      const a = body?.data?.attributes ?? {};
      const item = a.line_items?.[0];
      if (!item || !Number.isInteger(item.amount) || !a.reference_number) return json(res, 400, { errors: [{ code: "parameter_invalid" }] });
      const id = `cs_sim_${rand(8)}`;
      sessions.set(id, { id, reference: a.reference_number, amount: item.amount, currency: item.currency, name: item.name, description: a.description ?? "", successUrl: a.success_url, cancelUrl: a.cancel_url, status: "open", paymentId: `pay_sim_${rand(6)}` });
      note(`created ${id} for ${a.reference_number}: ${item.currency} ${(item.amount / 100).toFixed(2)}`);
      return json(res, 200, { data: { id, type: "checkout_session", attributes: { checkout_url: `http://127.0.0.1:${PORT}/checkout/${id}`, reference_number: a.reference_number, status: "active" } } });
    }
    const m = /^\/checkout\/(cs_sim_[a-f0-9]+)(?:\/(pay|cancel))?$/.exec(url.pathname);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return send(res, 404, page("Not found", "<h1>Unknown simulated checkout</h1>"));
      if (req.method === "GET" && !m[2]) {
        return send(res, 200, page("Simulated PayMongo checkout", `<p class="warn"><strong>Simulated PayMongo.</strong> This is a stand-in for QA on this machine. No money moves and no card is asked for.</p>
<h1>${esc(s.name)}</h1><div class="box"><p>Amount: <strong>${esc(s.currency)} ${(s.amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}</strong></p><p>Reference: <code>${esc(s.reference)}</code></p><p>Status: ${esc(s.status)}</p></div>
${s.status === "open" ? `<form method="post" action="/checkout/${s.id}/pay" style="display:inline"><button type="submit">Pay (simulated)</button></form><form method="post" action="/checkout/${s.id}/cancel" style="display:inline"><button class="alt" type="submit">Cancel and go back</button></form>` : `<p>This checkout is already ${esc(s.status)}.</p>`}`));
      }
      if (req.method === "POST" && m[2] === "pay" && s.status === "open") {
        s.status = "paid";
        // PayMongo tells the merchant first (the webhook), then sends the buyer back; the buyer may arrive before the confirmation does, so the application's return page must wait.
        const out = await deliver(paidBody(s));
        note(`paid ${s.id} (${s.reference}) -> webhook answered ${out}`);
        res.writeHead(303, { Location: s.successUrl }); return res.end();
      }
      if (req.method === "POST" && m[2] === "cancel") { note(`cancelled ${s.id}`); res.writeHead(303, { Location: s.cancelUrl }); return res.end(); }
      return send(res, 409, page("Closed", "<h1>This checkout is closed.</h1>"));
    }
    if (url.pathname === "/control" && req.method === "GET") {
      const rows = [...sessions.values()].map((s) => `<div class="box"><p><code>${esc(s.reference)}</code> · ${esc(s.id)} · ${esc(s.status)} · ${esc(s.currency)} ${(s.amount / 100).toFixed(2)}</p>${s.status === "paid" ? `<form method="post" action="/control/${s.id}/refund" style="display:inline"><button class="alt">Send a refund notice</button></form><form method="post" action="/control/${s.id}/dispute" style="display:inline"><button class="alt">Send a dispute notice</button></form><form method="post" action="/control/${s.id}/replay" style="display:inline"><button class="alt">Replay the paid notice</button></form>` : ""}</div>`).join("");
      return send(res, 200, page("Simulated PayMongo", `<p class="warn"><strong>Simulated PayMongo control page.</strong> QA only.</p><h1>Sessions</h1>${rows || "<p>None yet.</p>"}<h2>Log</h2><pre>${esc(log.join("\n"))}</pre>`));
    }
    const c = /^\/control\/(cs_sim_[a-f0-9]+)\/(refund|dispute|replay)$/.exec(url.pathname);
    if (c && req.method === "POST") {
      const s = sessions.get(c[1]);
      if (!s) return send(res, 404, page("Not found", "<h1>Unknown</h1>"));
      const out = await deliver(c[2] === "refund" ? refundBody(s) : c[2] === "dispute" ? disputeBody(s) : paidBody(s));
      note(`${c[2]} notice for ${s.id} -> ${out}`);
      res.writeHead(303, { Location: "/control" }); return res.end();
    }
    return send(res, 404, page("Not found", "<h1>Not found</h1>"));
  } catch (error) {
    note(`error: ${error.message}`);
    return json(res, 500, { errors: [{ code: "simulator_error" }] });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Simulated PayMongo on http://127.0.0.1:${PORT} (app ${APP}). Control page: /control`));
