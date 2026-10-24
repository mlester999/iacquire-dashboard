// Fixtures for iAcquire's own billing tests: a workspace whose setup fee is cleared, a signed PayMongo delivery, a client ready to be provisioned. Nothing here talks to a
// provider; the PayMongo bodies are written by hand (see src/server/billing/paymongo.ts: the contract was never exercised against a live or test account).
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser, ctxFor } from "./fixtures";

export const WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";

/** Clears the setup fee the way a Super Admin's waiver leaves it (status and a reason), for tests that are about something else. */
export async function clearSetupPayment(orgId: string, reason = "Test fixture: setup payment cleared") {
  await withSystem((db) => db.query(
    `insert into billing_accounts (org_id, setup_payment_status, waiver_reason, waived_at) values ($1, 'waived', $2, now())
     on conflict (org_id) do update set setup_payment_status = 'waived', waiver_reason = excluded.waiver_reason, waived_at = now()`,
    [orgId, reason],
  ));
}

export async function setupStatus(orgId: string) {
  const { rows } = await withSystem((db) => db.query<{ setup_payment_status: string; verified_payment_id: string | null; waiver_reason: string | null; waived_by: string | null }>(
    "select setup_payment_status, verified_payment_id, waiver_reason, waived_by from billing_accounts where org_id = $1", [orgId],
  ));
  return rows[0];
}

export async function provisioningJobs(orgId: string) {
  const { rows } = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_provisioning_jobs where org_id = $1", [orgId]));
  return rows[0].n;
}

/** A client that has finished onboarding with a verified owner: everything but the setup payment that provisioning needs. */
export async function onboardedClient(opts: { name?: string } = {}) {
  const org = await createOrg({ name: opts.name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]));
  return { org, owner };
}

/** A setup activation that has been approved, written directly (the activation flow has its own tests). */
export async function markActivated(orgId: string) {
  await withSystem((db) => db.query(
    `insert into client_setup_instances (org_id, state, activated_at) values ($1, 'activated', now())
     on conflict (org_id) do update set state = 'activated', activated_at = now()`, [orgId],
  ));
}

/**
 * Runs the real questionnaire to its end for a new client (the same answers as tests/client-onboarding-acceptance.test.ts) and submits it, so what the submission does
 * with provisioning is the product's own code. The workspace has a verified owner and an unpaid setup fee unless the caller clears it first.
 */
export async function submitRealOnboarding(opts: { name: string; clearPayment?: boolean }) {
  const { saveOnboardingStep, submitOnboarding } = await import("@/server/onboarding/service");
  const org = await createOrg({ name: opts.name });
  if (opts.clearPayment) await clearSetupPayment(org.id);
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, org, "owner");
  const answers = {
    "a.business_name": opts.name,
    "a.industry": "home_services",
    "a.business_model": "local",
    "a.description": "We repair residential roofs after storm damage.",
    "a.timezone": "America/Chicago",
    "a.contact_email": owner.email,
    "a.territories": "Austin, Texas",
    "a.target_customers": "Austin homeowners",
    "b.goals": ["more_leads", "more_appointments"],
    "b.services": "Roof repair and inspection",
    "b.ideal_customer": "Austin homeowners",
    "b.appointments": true,
    "b.website_need": "have",
    "d.pricing_policy": "never",
    "f.review": true,
  };
  const saved = await saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])), currentQuestionId: "f.review" });
  if (Object.keys(saved.rejected).length) throw new Error(`The test questionnaire was rejected: ${JSON.stringify(saved.rejected)}`);
  const result = await submitOnboarding(ctx);
  return { org, owner, ctx, result };
}

export const evt = () => `evt_${crypto.randomBytes(8).toString("hex")}`;

export function signPaymongo(body: string, opts: { live?: boolean; t?: number; secret?: string } = {}) {
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", opts.secret ?? WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},te=${opts.live ? "" : sig},li=${opts.live ? sig : ""}`;
}

export function paymongoPaidEvent(o: { eventId?: string; checkoutId: string; reference: string; amount: number; currency?: string; livemode?: boolean; paymentId?: string }) {
  return JSON.stringify({
    data: {
      id: o.eventId ?? evt(),
      type: "event",
      attributes: {
        type: "checkout_session.payment.paid",
        livemode: o.livemode ?? false,
        created_at: 1700000000,
        updated_at: 1700000000,
        data: {
          id: o.checkoutId,
          type: "checkout_session",
          attributes: {
            reference_number: o.reference,
            status: "active",
            metadata: {},
            payment_intent: { id: "pi_x", type: "payment_intent", attributes: { amount: o.amount, currency: o.currency ?? "PHP", status: "succeeded" } },
            payments: [{ id: o.paymentId ?? `pay_${crypto.randomBytes(6).toString("hex")}`, type: "payment", attributes: { amount: o.amount, fee: 250, net_amount: o.amount - 250, currency: o.currency ?? "PHP", status: "paid" } }],
          },
        },
      },
    },
  });
}

/** A stand-in for PayMongo's checkout creation: answers with the given checkout id and records what was asked. */
export function mockCheckoutFetch(checkoutId: string) {
  const calls: Array<{ url: string; body: { data: { attributes: Record<string, unknown> } } }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ data: { id: checkoutId, attributes: { checkout_url: `https://checkout.paymongo.com/${checkoutId}_client_abc` } } }), { status: 200 });
  };
  return { impl, calls };
}
