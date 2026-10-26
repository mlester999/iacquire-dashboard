// A stand-in for PayPal, for the isolated QA app ONLY: node scripts/paypal-sim.mjs (127.0.0.1:3282). It answers the calls the application makes (OAuth token, Orders v2 create / read /
// capture, the webhook check, the maintenance plan's Billing Plan and Subscriptions calls), shows the page where a person plays the buyer ("Approve", "Cancel"), and then does what
// PayPal would: sends the application webhook notices, signed in the only way the application checks (by ASKING this simulator, exactly as it asks PayPal). A small control page
// (/control) sends a refund, a dispute, a failed or successful monthly charge, a suspension, a cancellation or a replay, so those paths can be driven in a browser.
//
// Nothing here is PayPal, and nothing leaves this machine: it listens on loopback only, the application refuses its address everywhere but development and test (src/server/env.ts),
// and the keys are made up. What it proves is the application's handling of PayPal-shaped answers and notices; it proves nothing about PayPal's real behaviour, whose payload shapes
// were written from its documentation and have never been seen from a PayPal account.
//
// The approval links point at https://www.sandbox.paypal.com (the application's own link check and the database's https check both run unchanged). A browser run reaches this
// simulator's buyer pages by intercepting those requests (scripts/wave3-paypal-qa.mjs): "/checkoutnow?token=<order>" is answered with "/approve/<order>" here, and
// "/webapps/billing/subscriptions?ba_token=<subscription>" with "/subscribe/<subscription>".
//
//   CRM_QA_PAYPAL_SIM=1 node scripts/inbox-qa.mjs     (the app, with the simulator's keys and address)
//   node scripts/paypal-sim.mjs                        (this)
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PAYPAL_SIM_PORT ?? 3282);
const APP = (process.env.PAYPAL_SIM_APP ?? "http://127.0.0.1:3270").replace(/\/$/, "");
const SELF = `http://127.0.0.1:${PORT}`;
const SIM_PAYPAL = { clientId: "qa-sim-paypal-client-id", clientSecret: "qa-sim-paypal-client-secret", webhookId: "QA-SIM-WEBHOOK-ID", planId: "P-QASIM000001", base: SELF };
const CERT_URL = "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-QA-SIMULATED";
// The approval links the simulator hands out are ordinary PayPal sandbox addresses, so the application's own checks (https, a paypal.com host) are exercised unchanged. The BROWSER
// run intercepts requests to this address and answers them from the simulator (/approve/<order> and /subscribe/<subscription>, below); no request reaches the real PayPal.
const PAYPAL_PAGES = "https://www.sandbox.paypal.com";
const PLAN_PRICE = "299.00";

const orders = new Map();
const subs = new Map();
const tokens = new Set();
const requestIds = new Map();
const log = [];
const note = (line) => { log.unshift(`${new Date().toLocaleTimeString()}  ${line}`); log.length = Math.min(log.length, 60); console.log(line); };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rand = (n) => crypto.randomBytes(n).toString("hex").toUpperCase();
const iso = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const money = (minor) => (minor / 100).toFixed(2);
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#111}h1{font-size:20px}.box{border:1px solid #ccd;border-radius:12px;padding:16px;margin:16px 0}button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #223;background:#223;color:#fff;cursor:pointer;margin:0 8px 8px 0}button.alt{background:#fff;color:#223}code{background:#eef;padding:1px 4px;border-radius:4px}.warn{background:#fff7d6;border:1px solid #e6c84a;padding:10px;border-radius:10px;font-size:13px}</style></head><body>${body}</body></html>`;
const read = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); });
const send = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers }); res.end(body); };
const json = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const redirect = (res, to) => { res.writeHead(303, { Location: to }); res.end(); };
const fail = (res, status, name, message, details) => json(res, status, { name, message, ...(details ? { details } : {}) });

// ---------------------------------------------------------------------------
// The webhook: signed the way this simulator will later be ASKED about it
// ---------------------------------------------------------------------------

const signatureOf = (id, time, webhookId, eventText) => crypto.createHmac("sha256", SIM_PAYPAL.clientSecret).update(`${id}|${time}|${webhookId}|${eventText}`).digest("hex");

async function deliver(eventType, resource, extra = {}) {
  const event = { id: `WH-SIM-${rand(8)}`, event_version: "1.0", create_time: iso(), resource_type: extra.resourceType ?? "capture", event_type: eventType, summary: eventType, resource };
  const body = JSON.stringify(event);
  const id = `TX-SIM-${rand(6)}`;
  const time = iso();
  try {
    const res = await fetch(`${APP}/api/webhooks/paypal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYPAL-AUTH-ALGO": "SHA256withRSA", "PAYPAL-CERT-URL": CERT_URL, "PAYPAL-TRANSMISSION-ID": id, "PAYPAL-TRANSMISSION-SIG": signatureOf(id, time, SIM_PAYPAL.webhookId, body), "PAYPAL-TRANSMISSION-TIME": time },
      body,
    });
    return { event, answer: `${res.status} ${(await res.text()).slice(0, 140)}` };
  } catch (error) {
    return { event, answer: `could not reach the app: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// Orders (the purchase checkout)
// ---------------------------------------------------------------------------

const orderJson = (o) => ({
  id: o.id, status: o.status, intent: "CAPTURE",
  purchase_units: [{
    custom_id: o.reference, description: o.description, amount: { currency_code: o.currency, value: o.value },
    ...(o.captures.length ? { payments: { captures: o.captures.map((c) => ({ id: c.id, status: c.status, amount: { currency_code: o.currency, value: o.value }, custom_id: o.reference, seller_receivable_breakdown: { paypal_fee: { currency_code: o.currency, value: c.fee } } })) } } : {}),
  }],
  links: [{ rel: "self", href: `${SELF}/v2/checkout/orders/${o.id}`, method: "GET" }, ...(o.status === "PAYER_ACTION_REQUIRED" ? [{ rel: "payer-action", href: `${PAYPAL_PAGES}/checkoutnow?token=${o.id}`, method: "GET" }] : [])],
});

const captureResource = (o, c, status = "COMPLETED") => ({
  id: c.id, status, amount: { currency_code: o.currency, value: o.value }, custom_id: o.reference, create_time: iso(),
  seller_receivable_breakdown: { paypal_fee: { currency_code: o.currency, value: c.fee } }, supplementary_data: { related_ids: { order_id: o.id } },
});

// ---------------------------------------------------------------------------
// Subscriptions (the maintenance plan)
// ---------------------------------------------------------------------------

const nextMonth = (d) => { const n = new Date(d); n.setUTCMonth(n.getUTCMonth() + 1); return n; };
const subJson = (s) => ({
  id: s.id, plan_id: SIM_PAYPAL.planId, status: s.status, status_update_time: s.statusAt, custom_id: s.reference, start_time: s.startTime,
  billing_info: { next_billing_time: s.next ? iso(s.next) : undefined, failed_payments_count: s.failed },
  links: s.status === "APPROVAL_PENDING" ? [{ rel: "approve", href: `${PAYPAL_PAGES}/webapps/billing/subscriptions?ba_token=${s.id}`, method: "GET" }] : [{ rel: "self", href: `${SELF}/v1/billing/subscriptions/${s.id}`, method: "GET" }],
});
const setSub = (s, status) => { s.status = status; s.statusAt = iso(); };
const saleResource = (s, c, state = "completed") => ({
  id: c.id, state, amount: { total: PLAN_PRICE, currency: "USD" }, transaction_fee: { value: "8.97", currency: "USD" }, billing_agreement_id: s.id, create_time: c.at, sale_id: c.id,
});

async function charge(s, ok = true) {
  if (ok) {
    const c = { id: `SALE-SIM-${rand(6)}`, at: iso(), status: "COMPLETED" };
    s.charges.push(c);
    s.failed = 0;
    s.next = nextMonth(new Date());
    return deliver("PAYMENT.SALE.COMPLETED", saleResource(s, c), { resourceType: "sale" });
  }
  s.failed += 1;
  // The plan's payment_failure_threshold is 3: PayPal suspends the subscription then and tells the merchant with a second notice.
  const suspend = s.failed >= 3 && s.status !== "SUSPENDED";
  if (suspend) setSub(s, "SUSPENDED");
  const failure = await deliver("BILLING.SUBSCRIPTION.PAYMENT.FAILED", subJson(s), { resourceType: "subscription" });
  if (suspend) await deliver("BILLING.SUBSCRIPTION.SUSPENDED", subJson(s), { resourceType: "subscription" });
  return failure;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const authed = (req) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  return Boolean(m && tokens.has(m[1]));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, SELF);
  const p = url.pathname;
  try {
    // ---- OAuth ----
    if (req.method === "POST" && p === "/v1/oauth2/token") {
      const want = `Basic ${Buffer.from(`${SIM_PAYPAL.clientId}:${SIM_PAYPAL.clientSecret}`).toString("base64")}`;
      if (req.headers.authorization !== want) return json(res, 401, { error: "invalid_client", error_description: "Client Authentication failed" });
      const token = `A21-SIM-${rand(12)}`;
      tokens.add(token);
      return json(res, 200, { access_token: token, token_type: "Bearer", expires_in: 32400, app_id: "APP-QA-SIM" });
    }
    if (p.startsWith("/v1/") || p.startsWith("/v2/")) {
      if (!authed(req)) return fail(res, 401, "AUTHENTICATION_FAILURE", "Authentication failed due to invalid authentication credentials or a missing Authorization header.");
    }
    if (req.method === "GET" && p === "/v1/notifications/webhooks") {
      return json(res, 200, { webhooks: [{ id: SIM_PAYPAL.webhookId, url: `${APP}/api/webhooks/paypal`, event_types: [] }] });
    }
    if (req.method === "POST" && p === "/v1/notifications/verify-webhook-signature") {
      const raw = await read(req);
      let body;
      try { body = JSON.parse(raw); } catch { return fail(res, 400, "INVALID_REQUEST", "Malformed body"); }
      // The application puts the event in exactly as it received it; re-writing the parsed event gives the same text for anything this simulator signed.
      const eventText = JSON.stringify(body.webhook_event);
      const ok = body.webhook_id === SIM_PAYPAL.webhookId && body.auth_algo === "SHA256withRSA" && body.transmission_sig === signatureOf(body.transmission_id, body.transmission_time, body.webhook_id, eventText);
      note(`verify ${body.transmission_id}: ${ok ? "SUCCESS" : "FAILURE"}`);
      return json(res, 200, { verification_status: ok ? "SUCCESS" : "FAILURE" });
    }

    // ---- Orders v2 ----
    if (req.method === "POST" && p === "/v2/checkout/orders") {
      const body = JSON.parse((await read(req)) || "{}");
      const unit = body?.purchase_units?.[0];
      const ctx = body?.payment_source?.paypal?.experience_context ?? {};
      if (body.intent !== "CAPTURE" || !unit?.custom_id || !unit?.amount?.value || !unit?.amount?.currency_code || !ctx.return_url || !ctx.cancel_url) return fail(res, 422, "INVALID_REQUEST", "Request is not well-formed.");
      const reqId = req.headers["paypal-request-id"];
      if (reqId && requestIds.has(`order:${reqId}`)) return json(res, 201, orderJson(orders.get(requestIds.get(`order:${reqId}`))));
      const o = { id: `ORDSIM${rand(7)}`, status: "PAYER_ACTION_REQUIRED", reference: unit.custom_id, description: unit.description ?? "", currency: unit.amount.currency_code, value: unit.amount.value, returnUrl: ctx.return_url, cancelUrl: ctx.cancel_url, captures: [] };
      orders.set(o.id, o);
      if (reqId) requestIds.set(`order:${reqId}`, o.id);
      note(`order ${o.id} for ${o.reference}: ${o.currency} ${o.value}`);
      return json(res, 201, orderJson(o));
    }
    let m = /^\/v2\/checkout\/orders\/([A-Za-z0-9_-]+)(\/capture)?$/.exec(p);
    if (m) {
      const o = orders.get(m[1]);
      if (!o) return fail(res, 404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
      if (req.method === "GET" && !m[2]) return json(res, 200, orderJson(o));
      if (req.method === "POST" && m[2]) {
        if (o.status === "COMPLETED") return fail(res, 422, "UNPROCESSABLE_ENTITY", "The requested action could not be performed.", [{ issue: "ORDER_ALREADY_CAPTURED" }]);
        if (o.status !== "APPROVED") return fail(res, 422, "UNPROCESSABLE_ENTITY", "The requested action could not be performed.", [{ issue: "ORDER_NOT_APPROVED" }]);
        const c = { id: `CAPSIM${rand(6)}`, status: "COMPLETED", fee: money(Math.round(Number(o.value) * 100 * 0.044)) };
        o.captures.push(c);
        o.status = "COMPLETED";
        note(`captured ${o.id} as ${c.id}`);
        // PayPal tells the merchant after the capture (the webhook), a moment later.
        setTimeout(() => { void deliver("PAYMENT.CAPTURE.COMPLETED", captureResource(o, c)).then((r) => note(`PAYMENT.CAPTURE.COMPLETED ${c.id} -> ${r.answer}`)); }, 400);
        return json(res, 201, orderJson(o));
      }
    }

    // ---- Billing plan and subscriptions ----
    m = /^\/v1\/billing\/plans\/([A-Za-z0-9_-]+)$/.exec(p);
    if (m && req.method === "GET") {
      if (m[1] !== SIM_PAYPAL.planId) return fail(res, 404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
      return json(res, 200, {
        id: SIM_PAYPAL.planId, status: "ACTIVE", name: "Fully Managed Maintenance (simulated)",
        billing_cycles: [{ tenure_type: "REGULAR", sequence: 1, total_cycles: 0, frequency: { interval_unit: "MONTH", interval_count: 1 }, pricing_scheme: { fixed_price: { currency_code: "USD", value: PLAN_PRICE } } }],
        payment_preferences: { auto_bill_outstanding: true, setup_fee: { currency_code: "USD", value: "0" }, payment_failure_threshold: 3 },
      });
    }
    if (req.method === "POST" && p === "/v1/billing/subscriptions") {
      const body = JSON.parse((await read(req)) || "{}");
      const ctx = body.application_context ?? {};
      if (body.plan_id !== SIM_PAYPAL.planId || !body.custom_id || !ctx.return_url || !ctx.cancel_url) return fail(res, 422, "INVALID_REQUEST", "Request is not well-formed.");
      const reqId = req.headers["paypal-request-id"];
      if (reqId && requestIds.has(`sub:${reqId}`)) return json(res, 201, subJson(subs.get(requestIds.get(`sub:${reqId}`))));
      const s = { id: `I-SIM${rand(6)}`, reference: body.custom_id, status: "APPROVAL_PENDING", statusAt: iso(), startTime: body.start_time ?? iso(), returnUrl: ctx.return_url, cancelUrl: ctx.cancel_url, failed: 0, next: null, charges: [] };
      subs.set(s.id, s);
      if (reqId) requestIds.set(`sub:${reqId}`, s.id);
      note(`subscription ${s.id} for ${s.reference}`);
      return json(res, 201, subJson(s));
    }
    m = /^\/v1\/billing\/subscriptions\/([A-Za-z0-9_-]+)(?:\/(transactions|cancel))?$/.exec(p);
    if (m) {
      const s = subs.get(m[1]);
      if (!s) return fail(res, 404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
      if (req.method === "GET" && !m[2]) return json(res, 200, subJson(s));
      if (req.method === "GET" && m[2] === "transactions") {
        const from = Date.parse(url.searchParams.get("start_time") ?? "") || 0;
        const to = Date.parse(url.searchParams.get("end_time") ?? "") || Date.now() + 86_400_000;
        const list = s.charges.filter((c) => Date.parse(c.at) >= from && Date.parse(c.at) <= to).map((c) => ({ id: c.id, status: c.status, time: c.at, amount_with_breakdown: { gross_amount: { currency_code: "USD", value: PLAN_PRICE }, fee_amount: { currency_code: "USD", value: "8.97" } } }));
        return json(res, 200, { transactions: list, total_items: list.length });
      }
      if (req.method === "POST" && m[2] === "cancel") {
        if (s.status === "CANCELLED" || s.status === "EXPIRED") return fail(res, 422, "UNPROCESSABLE_ENTITY", "Subscription status invalid.", [{ issue: "SUBSCRIPTION_STATUS_INVALID" }]);
        setSub(s, "CANCELLED");
        s.next = null;
        note(`cancelled ${s.id} by the application`);
        void deliver("BILLING.SUBSCRIPTION.CANCELLED", subJson(s), { resourceType: "subscription" });
        res.writeHead(204); return res.end();
      }
    }

    // ---- The buyer's pages ----
    m = /^\/approve\/(ORDSIM[A-F0-9]+)(?:\/(approve|cancel))?$/.exec(p);
    if (m) {
      const o = orders.get(m[1]);
      if (!o) return send(res, 404, page("Not found", "<h1>Unknown simulated order</h1>"));
      if (req.method === "GET" && !m[2]) {
        return send(res, 200, page("Simulated PayPal", `<p class="warn"><strong>Simulated PayPal.</strong> A stand-in for QA on this machine. No money moves and no account is asked for.</p>
<h1>Pay iAcquire</h1><div class="box"><p>Amount: <strong>${esc(o.currency)} ${esc(o.value)}</strong></p><p>For: ${esc(o.description || "an iAcquire payment")}</p><p>Reference: <code>${esc(o.reference)}</code></p><p>Status: ${esc(o.status)}</p></div>
${o.status === "PAYER_ACTION_REQUIRED" ? `<form method="post" action="/approve/${o.id}/approve" style="display:inline"><button type="submit">Approve and continue (simulated)</button></form><form method="post" action="/approve/${o.id}/cancel" style="display:inline"><button class="alt" type="submit">Cancel and return to the merchant</button></form>` : `<p>This order is already ${esc(o.status)}.</p>`}`));
      }
      if (req.method === "POST" && m[2] === "approve" && o.status === "PAYER_ACTION_REQUIRED") {
        // Approval does not take the money: the merchant captures after the buyer returns.
        o.status = "APPROVED";
        note(`approved ${o.id}`);
        const back = new URL(o.returnUrl);
        back.searchParams.set("token", o.id);
        back.searchParams.set("PayerID", "SIMPAYER");
        return redirect(res, back.toString());
      }
      if (req.method === "POST" && m[2] === "cancel") { note(`cancelled ${o.id}`); return redirect(res, o.cancelUrl); }
      return send(res, 409, page("Closed", "<h1>This order is closed.</h1>"));
    }
    m = /^\/subscribe\/(I-SIM[A-F0-9]+)(?:\/(approve|cancel))?$/.exec(p);
    if (m) {
      const s = subs.get(m[1]);
      if (!s) return send(res, 404, page("Not found", "<h1>Unknown simulated subscription</h1>"));
      if (req.method === "GET" && !m[2]) {
        return send(res, 200, page("Simulated PayPal", `<p class="warn"><strong>Simulated PayPal.</strong> A stand-in for QA on this machine. No money moves and no account is asked for.</p>
<h1>Subscribe to Fully Managed Maintenance</h1><div class="box"><p>US$${PLAN_PRICE} every month until you cancel.</p><p>Reference: <code>${esc(s.reference)}</code></p><p>Status: ${esc(s.status)}</p></div>
${s.status === "APPROVAL_PENDING" ? `<form method="post" action="/subscribe/${s.id}/approve" style="display:inline"><button type="submit">Agree and subscribe (simulated)</button></form><form method="post" action="/subscribe/${s.id}/cancel" style="display:inline"><button class="alt" type="submit">Cancel and return to the merchant</button></form>` : `<p>This subscription is already ${esc(s.status)}.</p>`}`));
      }
      if (req.method === "POST" && m[2] === "approve" && s.status === "APPROVAL_PENDING") {
        setSub(s, "ACTIVE");
        note(`approved ${s.id}`);
        // PayPal charges the first month when the buyer agrees, and tells the merchant.
        const first = await deliver("BILLING.SUBSCRIPTION.ACTIVATED", subJson(s), { resourceType: "subscription" });
        const paid = await charge(s, true);
        note(`ACTIVATED -> ${first.answer}; first sale -> ${paid.answer}`);
        const back = new URL(s.returnUrl);
        back.searchParams.set("subscription_id", s.id);
        back.searchParams.set("ba_token", `BA-SIM-${rand(4)}`);
        return redirect(res, back.toString());
      }
      if (req.method === "POST" && m[2] === "cancel") { note(`buyer cancelled ${s.id}`); return redirect(res, s.cancelUrl); }
      return send(res, 409, page("Closed", "<h1>This subscription is closed.</h1>"));
    }

    // ---- Control ----
    if (p === "/control" && req.method === "GET") {
      const orderRows = [...orders.values()].map((o) => `<div class="box" data-order="${o.id}"><p><code>${esc(o.reference)}</code> · ${esc(o.id)} · <span data-status>${esc(o.status)}</span> · ${esc(o.currency)} ${esc(o.value)}</p>${o.captures.length ? ["refund", "dispute", "replay"].map((k) => `<form method="post" action="/control/order/${o.id}/${k}" style="display:inline"><button class="alt">${k === "refund" ? "Send a refund notice" : k === "dispute" ? "Send a dispute notice" : "Replay the paid notice"}</button></form>`).join("") : ""}</div>`).join("");
      const subRows = [...subs.values()].map((s) => `<div class="box" data-sub="${s.id}"><p><code>${esc(s.reference)}</code> · ${esc(s.id)} · <span data-status>${esc(s.status)}</span> · failed ${s.failed} · charges ${s.charges.length}</p>${s.status === "ACTIVE" || s.status === "SUSPENDED" ? ["charge", "fail", "suspend", "reactivate", "refund", "dispute", "replay", "cancel"].map((k) => `<form method="post" action="/control/sub/${s.id}/${k}" style="display:inline"><button class="alt">${{ charge: "Collect this month", fail: "Fail this month", suspend: "Suspend", reactivate: "Re-activate", refund: "Refund the last charge", dispute: "Dispute the last charge", replay: "Replay the last charge notice", cancel: "Cancel at PayPal" }[k]}</button></form>`).join("") : ""}</div>`).join("");
      return send(res, 200, page("Simulated PayPal", `<p class="warn"><strong>Simulated PayPal control page.</strong> QA only.</p><h1>Orders</h1>${orderRows || "<p>None yet.</p>"}<h1>Subscriptions</h1>${subRows || "<p>None yet.</p>"}<h2>Log</h2><pre>${esc(log.join("\n"))}</pre>`));
    }
    m = /^\/control\/order\/(ORDSIM[A-F0-9]+)\/(refund|dispute|replay)$/.exec(p);
    if (m && req.method === "POST") {
      const o = orders.get(m[1]);
      const c = o?.captures[0];
      if (!o || !c) return send(res, 404, page("Not found", "<h1>Unknown</h1>"));
      let out;
      if (m[2] === "replay") out = await deliver("PAYMENT.CAPTURE.COMPLETED", captureResource(o, c));
      else if (m[2] === "refund") out = await deliver("PAYMENT.CAPTURE.REFUNDED", { id: `REFSIM${rand(5)}`, status: "COMPLETED", amount: { currency_code: o.currency, value: o.value }, note_to_payer: "Refunded at PayPal (simulated)", create_time: iso(), links: [{ rel: "up", href: `${SELF}/v2/payments/captures/${c.id}`, method: "GET" }] });
      else out = await deliver("CUSTOMER.DISPUTE.CREATED", { dispute_id: `PP-D-SIM-${rand(4)}`, disputed_transactions: [{ seller_transaction_id: c.id }], status: "OPEN" }, { resourceType: "dispute" });
      note(`${m[2]} notice for ${o.id} -> ${out.answer}`);
      return redirect(res, "/control");
    }
    m = /^\/control\/sub\/(I-SIM[A-F0-9]+)\/(charge|fail|suspend|reactivate|refund|dispute|replay|cancel)$/.exec(p);
    if (m && req.method === "POST") {
      const s = subs.get(m[1]);
      if (!s) return send(res, 404, page("Not found", "<h1>Unknown</h1>"));
      const last = s.charges[s.charges.length - 1];
      let out;
      switch (m[2]) {
        case "charge": out = await charge(s, true); break;
        case "fail": out = await charge(s, false); break;
        case "suspend": setSub(s, "SUSPENDED"); out = await deliver("BILLING.SUBSCRIPTION.SUSPENDED", subJson(s), { resourceType: "subscription" }); break;
        case "reactivate": setSub(s, "ACTIVE"); s.failed = 0; out = await deliver("BILLING.SUBSCRIPTION.RE-ACTIVATED", subJson(s), { resourceType: "subscription" }); break;
        case "cancel": setSub(s, "CANCELLED"); s.next = null; out = await deliver("BILLING.SUBSCRIPTION.CANCELLED", subJson(s), { resourceType: "subscription" }); break;
        case "refund": if (last) { last.status = "REFUNDED"; out = await deliver("PAYMENT.SALE.REFUNDED", { id: `REFSIM${rand(5)}`, state: "completed", amount: { total: PLAN_PRICE, currency: "USD" }, sale_id: last.id, create_time: iso() }, { resourceType: "refund" }); } break;
        case "dispute": if (last) out = await deliver("PAYMENT.SALE.REVERSED", { id: `REVSIM${rand(5)}`, sale_id: last.id, state: "reversed", create_time: iso() }, { resourceType: "sale" }); break;
        case "replay": if (last) out = await deliver("PAYMENT.SALE.COMPLETED", saleResource(s, last), { resourceType: "sale" }); break;
      }
      note(`${m[2]} for ${s.id} -> ${out?.answer ?? "nothing to send"}`);
      return redirect(res, "/control");
    }
    return send(res, 404, page("Not found", "<h1>Not found</h1>"));
  } catch (error) {
    note(`error: ${error.message}`);
    return json(res, 500, { name: "INTERNAL_SERVER_ERROR", message: "simulator error" });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Simulated PayPal on ${SELF} (app ${APP}). Control page: /control`));
