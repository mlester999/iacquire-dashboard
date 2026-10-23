// The business's own payment account on embedded Postgres: only the owner connects it, after accepting recorded wording; a key the provider does not accept is never
// saved; the keys are sealed and come back nowhere; going live needs a confirmed test payment, the owner's say and both switches; and disconnecting deletes the keys.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { CURRENT_AUTHORIZATION_VERSION } from "@/lib/invoices/connection-rules";
import { confirmLive, connectProvider, listConnections, PROVIDER_CALLS_OFF, recheckConnection, replaceCredentials, revokeConnection, revokeWorkspaceConnections, saveWebhookSecret, setConnectionPaused } from "@/server/customer-payments/connections";
import { credentialVault } from "@/server/customer-payments/credentials";
import { createPaymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import { ProviderCallError } from "@/server/customer-payments/providers/types";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { invoiceOrg, issuedInvoice, providerPayment, rows } from "./support/invoices";
import { AUTHORIZATION, attempt, connect, deliver, fakePaymongo, paymongoPaid, q } from "./support/customer-payments";

const TEST_KEY = "sk_test_AbCdEfGh90abcdef";
const LIVE_KEY = "sk_live_ZyXwVuTs21zyxwvu";
const WH = "whsk_0123456789abcdef01234567";
const OK_LIST = { status: 200, json: { data: [] } };

const stored = (id: string) => q<{ credentials: string | null; status: string; mode: string; live_confirmed_at: string | null; last_error: string | null; supported_currencies: string[]; authorization_text_version: string | null; authorized_by: string | null }>(
  "select credentials, status, mode, live_confirmed_at, last_error, supported_currencies, authorization_text_version, authorized_by from customer_payment_connections where id = $1", [id],
).then((r) => r[0]);

describe("who may manage the connection", () => {
  it("is the owner alone: every other role, an agency workspace and a workspace invoicing is not switched on for are each refused with the true reason", async () => {
    const io = await invoiceOrg();
    for (const who of ["manager", "sales", "viewer", "support", "member"] as const) {
      await expect(listConnections(io.ctx(who)), who).rejects.toThrow(/Only the business owner can manage the payment connection/);
      await expect(connectProvider(io.ctx(who), { provider: "simulated", authorization: AUTHORIZATION }), who).rejects.toThrow(/Only the business owner/);
    }
    const agency = io.ctx("owner");
    await expect(listConnections({ ...agency, org: { ...agency.org, kind: "agency" } })).rejects.toThrow(/belong to a client's own workspace/);
    const off = await invoiceOrg({ enabled: false });
    await expect(connectProvider(off.ctx("owner"), { provider: "simulated", authorization: AUTHORIZATION })).rejects.toThrow(/not switched on for this workspace/);
    expect(await q("select id from customer_payment_connections where org_id = any($1::uuid[])", [[io.orgId, off.orgId]])).toEqual([]);
  });

  it("will not touch another workspace's connection, however its id is obtained", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    const view = await connectProvider(a.ctx("owner"), { provider: "simulated", authorization: AUTHORIZATION });
    for (const act of [
      () => saveWebhookSecret(b.ctx("owner"), view.id, { webhookSecret: WH }),
      () => recheckConnection(b.ctx("owner"), view.id),
      () => confirmLive(b.ctx("owner"), view.id),
      () => setConnectionPaused(b.ctx("owner"), view.id, true),
      () => revokeConnection(b.ctx("owner"), view.id),
      () => replaceCredentials(b.ctx("owner"), view.id, { apiKey: TEST_KEY, authorization: AUTHORIZATION }),
    ]) await expect(act()).rejects.toThrow(/was not found/);
    expect(await listConnections(b.ctx("owner"))).toEqual([]);
    expect((await stored(view.id)).status).toBe("connected");
  });
});

describe("connecting the simulated provider", () => {
  it("makes its own keys, seals them, records who authorized which wording, and gives back nothing secret", async () => {
    const io = await invoiceOrg();
    const view = await connectProvider(io.ctx("owner"), { provider: "simulated", accountLabel: "  Test till  ", authorization: AUTHORIZATION });
    expect(view).toMatchObject({
      provider: "simulated", mode: "test", status: "connected", accountLabel: "Test till", webhookSecretSaved: true, credentialsReadable: true, authorizationVersion: CURRENT_AUTHORIZATION_VERSION,
      liveConfirmedAt: null, hasConfirmedTestPayment: false, lastEventAt: null, teamCheckoutBlock: null, customerCheckoutBlock: null,
    });
    expect(view.webhookUrl).toMatch(/\/api\/webhooks\/customer-payments\/simulated\/cpk_[a-z0-9]{20}$/);
    expect(view.supportedCurrencies).toContain("PHP");
    const row = await stored(view.id);
    expect(row).toMatchObject({ status: "connected", mode: "test", authorization_text_version: CURRENT_AUTHORIZATION_VERSION, authorized_by: io.c.people.owner.id });
    const opened = credentialVault.open(row.credentials)!;
    expect(opened.apiKey).toMatch(/^sim_/);
    expect(opened.webhookSecret).toHaveLength(32);
    // Sealed: neither the key nor the signing secret is in the column as text, and nothing the owner is given contains them.
    expect(row.credentials).toMatch(/^v1\./);
    expect(row.credentials).not.toContain(opened.apiKey);
    expect(JSON.stringify(view)).not.toContain(opened.apiKey);
    expect(JSON.stringify(view)).not.toContain(opened.webhookSecret as string);
    for (const table of ["audit_logs", "notifications", "customer_invoice_events"]) {
      const text = JSON.stringify(await q(`select * from ${table} where org_id = $1`, [io.orgId]));
      expect(text, table).not.toContain(opened.apiKey);
      expect(text, table).not.toContain(opened.webhookSecret as string);
    }
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'payments.connection_created'", [io.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ provider: "simulated", mode: "test", wordingVersion: CURRENT_AUTHORIZATION_VERSION, webhookReady: true });
    // The application role cannot read the column at all.
    const err = await withUser(io.c.people.owner.id, (db) => db.query("select credentials from customer_payment_connections")).catch((e: unknown) => e);
    expect(String(err)).toMatch(/permission denied/);
  });

  it("needs the current wording accepted, only one account per provider, and honestly refuses PayPal", async () => {
    const io = await invoiceOrg();
    await expect(connectProvider(io.ctx("owner"), { provider: "simulated", authorization: { accepted: false, version: CURRENT_AUTHORIZATION_VERSION } })).rejects.toThrow();
    await expect(connectProvider(io.ctx("owner"), { provider: "simulated", authorization: { accepted: true, version: "draft-1999" } })).rejects.toThrow();
    await connectProvider(io.ctx("owner"), { provider: "simulated", authorization: AUTHORIZATION });
    await expect(connectProvider(io.ctx("owner"), { provider: "simulated", authorization: AUTHORIZATION })).rejects.toThrow(/already connected/);
    await expect(connectProvider(io.ctx("owner"), { provider: "paypal", authorization: AUTHORIZATION })).rejects.toThrow(/PayPal is not available in this release/);
    expect(await q("select id from customer_payment_connections where org_id = $1", [io.orgId])).toHaveLength(1);
  });
});

describe("connecting PayMongo", () => {
  const f = fakePaymongo();
  beforeAll(() => {
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });
  afterAll(() => {
    setAdapterForTests("paymongo", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
  });
  const accept = () => f.on(() => true, OK_LIST);

  it("checks the key with a read-only call before saving anything, reads the mode from the key, and waits for the signing secret", async () => {
    const io = await invoiceOrg();
    accept();
    const before = f.calls.length;
    const view = await connectProvider(io.ctx("owner"), { provider: "paymongo", apiKey: `  ${TEST_KEY} `, accountLabel: "Santos Plumbing", authorization: AUTHORIZATION });
    expect(f.calls.slice(before)).toMatchObject([{ method: "GET", path: "/v1/webhooks", apiKey: TEST_KEY }]);
    expect(view).toMatchObject({ provider: "paymongo", mode: "test", status: "pending_verification", webhookSecretSaved: false, supportedCurrencies: ["PHP"], accountLabel: "Santos Plumbing" });
    expect(view.teamCheckoutBlock?.code).toBe("not_ready");
    expect(view.statusExplain).toMatch(/webhook signing secret has not been saved/);
    expect(view.webhookUrl).toMatch(/\/api\/webhooks\/customer-payments\/paymongo\/cpk_/);
    expect(credentialVault.open((await stored(view.id)).credentials)).toMatchObject({ apiKey: TEST_KEY, webhookSecret: null });
    // Until the secret is saved, no delivery is believed.
    const conn = { id: view.id, orgId: io.orgId, publicKey: view.webhookUrl.split("/").pop()!, provider: "paymongo" as const, mode: "test" as const, apiKey: TEST_KEY, webhookSecret: WH };
    expect((await deliver(conn, paymongoPaid({ checkoutId: "cs_1", reference: "CP-0123456789abcdef0123456789abcdef", amount: 1000 }))).status).toBe(403);

    const saved = await saveWebhookSecret(io.ctx("owner"), view.id, { webhookSecret: ` ${WH} ` });
    expect(saved).toMatchObject({ status: "connected", webhookSecretSaved: true });
    expect(credentialVault.open((await stored(view.id)).credentials)).toMatchObject({ apiKey: TEST_KEY, webhookSecret: WH });
    expect(JSON.stringify(saved)).not.toContain(WH);
    await expect(saveWebhookSecret(io.ctx("owner"), view.id, { webhookSecret: "x" })).rejects.toThrow(/exactly as PayMongo shows it/);
    // Both secrets stay out of every record.
    for (const table of ["audit_logs", "notifications"]) {
      const text = JSON.stringify(await q(`select * from ${table} where org_id = $1`, [io.orgId]));
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain(WH);
    }
  });

  it("can take the signing secret at the same time, and then is connected at once", async () => {
    const io = await invoiceOrg();
    accept();
    const view = await connectProvider(io.ctx("owner"), { provider: "paymongo", apiKey: TEST_KEY, webhookSecret: WH, authorization: AUTHORIZATION });
    expect(view).toMatchObject({ status: "connected", webhookSecretSaved: true });
  });

  it("saves nothing when the key is the wrong kind, is refused by the provider, or the provider cannot be reached", async () => {
    const io = await invoiceOrg();
    const attemptWith = (apiKey: string | undefined) => connectProvider(io.ctx("owner"), { provider: "paymongo", apiKey, authorization: AUTHORIZATION });
    const before = f.calls.length;
    await expect(attemptWith("pk_test_AbCdEfGh90abcdef")).rejects.toThrow(/public key/);
    await expect(attemptWith("hello")).rejects.toThrow(/does not look like a PayMongo secret key/);
    await expect(attemptWith(undefined)).rejects.toThrow(/Paste your PayMongo secret key/);
    // A key of the wrong kind never leaves the building.
    expect(f.calls.length).toBe(before);
    f.on(() => true, { status: 401, json: { errors: [{ code: "authentication_failed" }] } });
    const rejected = await attemptWith(TEST_KEY).catch((e: Error) => e);
    expect(rejected).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/did not accept this key.*Nothing was saved/) });
    expect(String((rejected as Error).message)).not.toContain(TEST_KEY);
    f.on(() => true, { status: 503, json: null });
    await expect(attemptWith(TEST_KEY)).rejects.toMatchObject({ code: "upstream_error", message: expect.stringMatching(/busy or having trouble.*Nothing was saved/) });
    f.throwNext(new ProviderCallError("unreachable", "PayMongo could not be reached, or took too long to answer."));
    f.on(() => true, OK_LIST);
    await expect(attemptWith(TEST_KEY)).rejects.toThrow(/could not be reached/);
    expect(await q("select id from customer_payment_connections where org_id = $1", [io.orgId])).toEqual([]);
  });

  it("rotates the keys without losing the signing secret, checks them first, and never carries a live confirmation to a new key", async () => {
    const io = await invoiceOrg();
    accept();
    const view = await connectProvider(io.ctx("owner"), { provider: "paymongo", apiKey: TEST_KEY, webhookSecret: WH, authorization: AUTHORIZATION });
    const live = await replaceCredentials(io.ctx("owner"), view.id, { apiKey: LIVE_KEY, authorization: AUTHORIZATION });
    expect(live).toMatchObject({ mode: "live", status: "connected", webhookSecretSaved: true, liveConfirmedAt: null });
    expect(credentialVault.open((await stored(view.id)).credentials)).toMatchObject({ apiKey: LIVE_KEY, webhookSecret: WH });
    // A key the provider refuses leaves the saved one exactly as it was.
    f.on(() => true, { status: 401, json: null });
    await expect(replaceCredentials(io.ctx("owner"), view.id, { apiKey: "sk_live_Nope000000000000", authorization: AUTHORIZATION })).rejects.toThrow(/did not accept this key/);
    expect(credentialVault.open((await stored(view.id)).credentials)?.apiKey).toBe(LIVE_KEY);
    // A confirmed live connection is not confirmed any more once its key is replaced.
    accept();
    await withSystem((db) => db.query("update customer_payment_connections set live_confirmed_at = now(), live_confirmed_by = $2 where id = $1", [view.id, io.c.people.owner.id]));
    const again = await replaceCredentials(io.ctx("owner"), view.id, { apiKey: "sk_live_Another000000000", authorization: AUTHORIZATION });
    expect(again.liveConfirmedAt).toBeNull();
    expect((await stored(view.id)).live_confirmed_at).toBeNull();
    await expect(replaceCredentials(io.ctx("owner"), view.id, { apiKey: LIVE_KEY, authorization: { accepted: false, version: CURRENT_AUTHORIZATION_VERSION } })).rejects.toThrow();
  });

  it("checks a saved key again on request: a refused key stops new payments with the reason, an unreachable provider changes only the note, and a good answer clears it", async () => {
    const io = await invoiceOrg();
    accept();
    const view = await connectProvider(io.ctx("owner"), { provider: "paymongo", apiKey: TEST_KEY, webhookSecret: WH, authorization: AUTHORIZATION });
    f.on(() => true, { status: 401, json: null });
    const bad = await recheckConnection(io.ctx("owner"), view.id);
    expect(bad).toMatchObject({ status: "needs_attention", lastError: expect.stringMatching(/did not accept this key/) });
    expect(bad.teamCheckoutBlock?.code).toBe("needs_attention");
    f.on(() => true, { status: 502, json: null });
    expect(await recheckConnection(io.ctx("owner"), view.id)).toMatchObject({ status: "needs_attention", lastError: expect.stringMatching(/busy or having trouble/) });
    accept();
    expect(await recheckConnection(io.ctx("owner"), view.id)).toMatchObject({ status: "connected", lastError: null });
    f.on(() => true, { status: 502, json: null });
    expect(await recheckConnection(io.ctx("owner"), view.id)).toMatchObject({ status: "connected", lastError: expect.stringMatching(/busy/) });
  });

  it("opens live only for a confirmed test payment, live keys, a connected account and both switches, and records who decided", async () => {
    const io = await invoiceOrg();
    accept();
    const view = await connectProvider(io.ctx("owner"), { provider: "paymongo", apiKey: TEST_KEY, webhookSecret: WH, authorization: AUTHORIZATION });
    await expect(confirmLive(io.ctx("owner"), view.id)).rejects.toThrow(/test keys/);
    // A test payment the provider confirmed, recorded the way a webhook records it.
    const inv = (await issuedInvoice(io)).invoice;
    await providerPayment(io, inv.id, view.id, 50_000, { provider: "paymongo", livemode: false });
    const live = await replaceCredentials(io.ctx("owner"), view.id, { apiKey: LIVE_KEY, authorization: AUTHORIZATION });
    expect(live).toMatchObject({ mode: "live", hasConfirmedTestPayment: true, customerCheckoutBlock: { code: "live_off" } });
    expect(live.liveConfirmBlock).toMatch(/whole service/);
    await expect(confirmLive(io.ctx("owner"), view.id)).rejects.toThrow(/Live payments are switched off for the whole service/);
    expect((await stored(view.id)).live_confirmed_at).toBeNull();

    process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED = "true";
    resetEnvCache();
    try {
      for (const who of ["manager", "sales", "member"] as const) await expect(confirmLive(io.ctx(who), view.id), who).rejects.toThrow(/Only the business owner/);
      const confirmed = await confirmLive(io.ctx("owner"), view.id);
      expect(confirmed.liveConfirmedAt).not.toBeNull();
      expect(confirmed.customerCheckoutBlock).toBeNull();
      expect(await q("select live_confirmed_by from customer_payment_connections where id = $1", [view.id])).toEqual([{ live_confirmed_by: io.c.people.owner.id }]);
      expect(await rows("select id from audit_logs where org_id = $1 and action = 'payments.live_confirmed'", [io.orgId])).toHaveLength(1);
      // The kill switch closes it again at once, for everyone, without anyone touching the connection.
      delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
      resetEnvCache();
      expect((await listConnections(io.ctx("owner")))[0].customerCheckoutBlock?.code).toBe("live_off");
    } finally {
      delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
      resetEnvCache();
    }
  });

  it("does not count a test payment of the simulated provider, or a payment somebody recorded by hand, as the proof needed to go live", async () => {
    const io = await invoiceOrg();
    accept();
    const view = await connectProvider(io.ctx("owner"), { provider: "paymongo", apiKey: LIVE_KEY, webhookSecret: WH, authorization: AUTHORIZATION });
    const inv = (await issuedInvoice(io)).invoice;
    const sim = await connect(io, { provider: "simulated" });
    await providerPayment(io, inv.id, sim.id, 1000, { provider: "simulated", livemode: false });
    expect((await listConnections(io.ctx("owner")))[0].hasConfirmedTestPayment).toBe(false);
    await providerPayment(io, inv.id, view.id, 1000, { provider: "paymongo", livemode: true });
    expect((await listConnections(io.ctx("owner")))[0].hasConfirmedTestPayment).toBe(false);
  });
});

describe("with the environment's calls switch off", () => {
  it("does not ask a real provider anything, saves nothing, and says why", async () => {
    const io = await invoiceOrg();
    const f = fakePaymongo();
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
    try {
      await expect(connectProvider(io.ctx("owner"), { provider: "paymongo", apiKey: TEST_KEY, authorization: AUTHORIZATION })).rejects.toThrow(PROVIDER_CALLS_OFF);
      expect(f.calls).toHaveLength(0);
      expect(await q("select id from customer_payment_connections where org_id = $1", [io.orgId])).toEqual([]);
      const conn = await connect(io);
      await expect(recheckConnection(io.ctx("owner"), conn.id)).rejects.toThrow(PROVIDER_CALLS_OFF);
      await expect(replaceCredentials(io.ctx("owner"), conn.id, { apiKey: LIVE_KEY, authorization: AUTHORIZATION })).rejects.toThrow(PROVIDER_CALLS_OFF);
      expect(f.calls).toHaveLength(0);
      // The simulated provider reaches nothing, so it works.
      const sim = await invoiceOrg();
      expect((await connectProvider(sim.ctx("owner"), { provider: "simulated", authorization: AUTHORIZATION })).status).toBe("connected");
    } finally {
      setAdapterForTests("paymongo", null);
    }
  });
});

describe("pausing, resuming and disconnecting", () => {
  it("pauses new payments without disconnecting, still records what arrives, and resumes to connected", async () => {
    const io = await invoiceOrg();
    const view = await connectProvider(io.ctx("owner"), { provider: "simulated", authorization: AUTHORIZATION });
    const paused = await setConnectionPaused(io.ctx("owner"), view.id, true);
    expect(paused).toMatchObject({ status: "disabled", teamCheckoutBlock: { code: "paused" } });
    expect(paused.statusExplain).toMatch(/payments already in progress are still recorded/);
    expect((await setConnectionPaused(io.ctx("owner"), view.id, true)).status).toBe("disabled");
    expect((await setConnectionPaused(io.ctx("owner"), view.id, false)).status).toBe("connected");
    expect(await rows("select action from audit_logs where org_id = $1 and action in ('payments.connection_paused', 'payments.connection_resumed') order by created_at", [io.orgId])).toEqual([{ action: "payments.connection_paused" }, { action: "payments.connection_resumed" }]);
  });

  it("deletes the keys, clears the confirmation, cancels waiting checkouts, stops believing the provider, and can be done by the owner even after invoicing is switched off", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const conn = await connect(io, { liveConfirmed: false });
    const open = await attempt(inv.id, conn, { status: "redirected" });
    const body = paymongoPaid({ checkoutId: open.checkoutId!, reference: open.reference, amount: open.amountMinor });
    await setInvoicesEnabled(io.superAdmin, io.orgId, false);
    for (const who of ["manager", "sales", "member"] as const) await expect(revokeConnection(io.ctx(who), conn.id), who).rejects.toThrow(/Only the business owner/);
    expect(await revokeConnection(io.ctx("owner"), conn.id)).toEqual({ cancelledCheckouts: 1 });
    expect(await stored(conn.id)).toMatchObject({ status: "revoked", credentials: null, live_confirmed_at: null });
    expect((await q<{ status: string }>("select status from customer_payment_attempts where id = $1", [open.id]))[0].status).toBe("cancelled");
    expect(await deliver(conn, body)).toMatchObject({ status: 403 });
    await expect(revokeConnection(io.ctx("owner"), conn.id)).rejects.toThrow(/was not found/);
    await setInvoicesEnabled(io.superAdmin, io.orgId, true);
    expect(await listConnections(io.ctx("owner"))).toEqual([]);
    // A new connection is possible afterwards.
    expect((await connectProvider(io.ctx("owner"), { provider: "simulated", authorization: AUTHORIZATION })).status).toBe("connected");
  });

  it("disconnects every account of a workspace that is closing, as its owner would, and reports the count", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const a = await connect(io, { provider: "paymongo" });
    const b = await connect(io, { provider: "simulated" });
    await attempt(inv.id, a, { status: "created" });
    const other = await invoiceOrg();
    const untouched = await connect(other);
    const out = await revokeWorkspaceConnections(io.orgId, io.c.people.owner.id);
    expect(out).toEqual({ revoked: 2, cancelledCheckouts: 1, failed: [] });
    for (const c of [a, b]) expect(await stored(c.id)).toMatchObject({ status: "revoked", credentials: null });
    expect((await stored(untouched.id)).status).toBe("connected");
    expect(await revokeWorkspaceConnections(io.orgId, io.c.people.owner.id)).toEqual({ revoked: 0, cancelledCheckouts: 0, failed: [] });
    const audit = await rows<{ actor_kind: string; metadata: { reason: string } }>("select actor_kind, metadata from audit_logs where org_id = $1 and action = 'payments.connection_revoked'", [io.orgId]);
    expect(audit).toHaveLength(2);
    expect(audit.every((r) => r.actor_kind === "agency" && r.metadata.reason === "offboarding")).toBe(true);
    simulatedPlatform.reset();
  });
});
