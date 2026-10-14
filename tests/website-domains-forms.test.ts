import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSiteRuntime, withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { clearSiteCache, resolveSite } from "@/server/sites/runtime";
import {
  MAX_DOMAINS_PER_SITE, addCustomDomain, approveDomainPurchase, changeSubdomain, checkLive, checkRouting, checkSsl, dnsInstructions, listDomains, normalizeCustomHostname,
  quoteDomainPurchase, recordDomainPurchase, removeDomain, requestDomainPurchase, sendRenewalReminders, setPrimaryDomain, verifyDomain, verifyRecordValue, type DnsResolver,
} from "@/server/websites/domains";
import { listSubmissions, markSubmissionSpam, processSubmissions } from "@/server/websites/forms";
import { createWebsite, getWebsite, publishWebsite } from "@/server/websites/service";
import type { ProbeFetcher } from "@/server/websites/probe";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

type Person = { id: string; email: string };
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let owner: Person, manager: Person, rep: Person, viewer: Person, rival: Person, staff: Person;
const as = (p: Person, o = org, role: "owner" | "admin" | "sales_rep" | "viewer" = "owner") => ctxFor(p, o, role);

const resolver = (records: { txt?: Record<string, string[][]>; cname?: Record<string, string[]>; a?: Record<string, string[]> } = {}): DnsResolver => ({
  resolveTxt: async (n) => records.txt?.[n] ?? Promise.reject(new Error("ENODATA")),
  resolveCname: async (n) => records.cname?.[n] ?? Promise.reject(new Error("ENODATA")),
  resolve4: async (n) => records.a?.[n] ?? Promise.reject(new Error("ENODATA")),
  resolve6: async () => Promise.reject(new Error("ENODATA")),
});
/** A runtime that answers with whichever publication the database says is live for this organization, as the real site does. */
const serving = (): ProbeFetcher => async () => {
  const { rows } = await withSystem((db) => db.query<{ id: string | null }>("select published_publication_id as id from websites where org_id = $1", [org.id]));
  return { status: 200, body: `<div data-site-publication="${rows[0]?.id}"></div>` };
};

beforeAll(async () => {
  process.env.SITES_PROBE_ORIGIN = "http://127.0.0.1:9";
  process.env.SITES_BASE_DOMAIN = "sites.test.example";
  process.env.SITES_CNAME_TARGET = "cname.sites.test.example";
  resetEnvCache();
  org = await createOrg({ name: "Domain Co" });
  other = await createOrg({ name: "Rival Co" });
  [owner, manager, rep, viewer, rival] = await Promise.all([createUser(), createUser(), createUser(), createUser(), createUser()]);
  staff = await createUser({ platformRole: "agency_super_admin" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, manager.id, "admin");
  await addMember(org.id, rep.id, "sales_rep");
  await addMember(org.id, viewer.id, "viewer");
  await addMember(other.id, rival.id, "owner");
  await saveOnboardingStep(as(owner), { answers: { "a.business_name": { value: "Domain Co" }, "a.industry": { value: "other" }, "a.contact_email": { value: "hi@domain.test" }, "b.services": { value: "Widgets, gadgets" } } });
  await createWebsite(as(owner), { templateKey: "summit.peak" });
  await saveOnboardingStep(as(rival, other), { answers: { "a.business_name": { value: "Rival Co" }, "a.industry": { value: "other" }, "a.contact_email": { value: "hi@rival.test" } } });
  await createWebsite(as(rival, other), { templateKey: "summit.peak" });
});
afterAll(() => {
  delete process.env.SITES_PROBE_ORIGIN;
  delete process.env.SITES_BASE_DOMAIN;
  delete process.env.SITES_CNAME_TARGET;
  resetEnvCache();
});

describe("hostnames", () => {
  it("normalizes what people type and refuses what can't be a public website address", () => {
    expect(normalizeCustomHostname("https://WWW.Example.COM/about?x=1")).toEqual({ ok: true, hostname: "www.example.com" });
    expect(normalizeCustomHostname("example.com.")).toEqual({ ok: true, hostname: "example.com" });
    expect(normalizeCustomHostname("example.com:8443")).toEqual({ ok: true, hostname: "example.com" });
    expect(normalizeCustomHostname("bücher.de")).toEqual({ ok: true, hostname: "xn--bcher-kva.de" });
    for (const bad of ["", "localhost", "intranet", "10.0.0.1", "192.168.1.5", "a b.com", "user@x.com", "x.local", "x.internal", "-bad-.com", "a..b.com", "x.sites.test.example", "sites.test.example", "app.iacquire.com", "iacquire.com", "x.test", "a_b.com"]) {
      expect(normalizeCustomHostname(bad).ok, bad).toBe(false);
    }
  });

  it("explains the DNS records plainly, with a routing record only when the platform has a target", () => {
    const d = { hostname: "www.example.com", verificationToken: "a".repeat(32), kind: "custom" as const };
    const i = dnsInstructions(d);
    expect(i.verifyRecord).toEqual({ type: "TXT", name: "_iacquire-verify.www.example.com", value: `iacquire-site-verification=${"a".repeat(32)}` });
    expect(i.routing).toMatchObject({ type: "CNAME", value: "cname.sites.test.example" });
    expect(dnsInstructions({ ...d, hostname: "example.com" }).routing?.type).toBe("ALIAS"); // a bare domain can't be a CNAME
    expect(i.notes.join(" ")).toMatch(/registered in your name/);
  });
});

describe("connecting a domain", () => {
  let domainId = "";
  const TOKEN = () => withSystem((db) => db.query<{ verification_token: string }>("select verification_token from website_domains where id = $1", [domainId])).then((r) => r.rows[0].verification_token);

  it("starts unverified, is limited to people who manage domains, and never reveals who else owns a domain", async () => {
    await expect(addCustomDomain(as(rep, org, "sales_rep"), { hostname: "www.domainco.test.org" })).rejects.toThrow(/Only owners and managers/);
    await expect(addCustomDomain(as(viewer, org, "viewer"), { hostname: "www.domainco.test.org" })).rejects.toThrow(/Only owners and managers/);
    const d = await addCustomDomain(as(manager, org, "admin"), { hostname: "WWW.DomainCo.test.org" });
    domainId = d.id;
    expect(d).toMatchObject({ hostname: "www.domainco.test.org", kind: "custom", status: "pending_dns", isPrimary: false, acquisition: "existing" });
    expect(d.verificationToken).toMatch(/^[0-9a-f]{32}$/);
    await expect(addCustomDomain(as(rival, other), { hostname: "www.domainco.test.org" })).rejects.toThrow(/already connected to a website/);
    await expect(addCustomDomain(as(owner), { hostname: "www.domainco.test.org" })).rejects.toThrow(/already connected to a website/);
    clearSiteCache();
    expect(await resolveSite("www.domainco.test.org")).toBeNull(); // never serves before it's verified
  });

  it("proves ownership only with the exact record, and explains what it found", async () => {
    const token = await TOKEN();
    let d = await verifyDomain(as(owner), domainId, { resolver: resolver() });
    expect(d.status).toBe("pending_dns");
    expect(d.dnsDetail).toMatch(/couldn't find the verification record/);
    d = await verifyDomain(as(owner), domainId, { resolver: resolver({ txt: { "_iacquire-verify.www.domainco.test.org": [["iacquire-site-verification=wrongwrongwrong"]] } }) });
    expect(d.status).toBe("pending_dns");
    expect(d.dnsDetail).toMatch(/doesn't match/);
    // Someone else's record on a similar name proves nothing.
    d = await verifyDomain(as(owner), domainId, { resolver: resolver({ txt: { "_iacquire-verify.other.example": [[verifyRecordValue(token)]] } }) });
    expect(d.status).toBe("pending_dns");
    // A long TXT value is delivered in pieces; it must still match once joined.
    const half = verifyRecordValue(token).length / 2;
    d = await verifyDomain(as(owner), domainId, { resolver: resolver({ txt: { "_iacquire-verify.www.domainco.test.org": [[verifyRecordValue(token).slice(0, half), verifyRecordValue(token).slice(half)]] } }) });
    expect(d.status).toBe("verified");
    expect(d.verifiedAt).toBeTruthy();
    expect(d.dnsDetail).toMatch(/Ownership confirmed/);
    expect(d.routingOk).toBe(false); // verified, but not pointing at the platform yet
  });

  it("checks routing separately from ownership", async () => {
    expect((await checkRouting("www.domainco.test.org", resolver({ cname: { "www.domainco.test.org": ["cname.sites.test.example."] } }))).ok).toBe(true);
    expect((await checkRouting("www.domainco.test.org", resolver({ a: { "www.domainco.test.org": ["203.0.113.5"], "cname.sites.test.example": ["203.0.113.5"] } }))).ok).toBe(true);
    const wrong = await checkRouting("www.domainco.test.org", resolver({ cname: { "www.domainco.test.org": ["elsewhere.example."] } }));
    expect(wrong).toMatchObject({ ok: false });
    expect(wrong.detail).toMatch(/elsewhere\.example/);
    expect((await checkRouting("nothing.example.org", resolver())).ok).toBe(false);
  });

  it("serves a verified host once the site is published, and calls it active only when the certificate and a real response agree", async () => {
    const token = await TOKEN();
    // Not published yet: nothing to be live.
    await expect(checkLive(as(owner), domainId, { probe: serving() })).rejects.toThrow(/Publish your website first/);
    await publishWebsite(as(owner), { acknowledgeClaims: true }, { probe: serving() });
    clearSiteCache();
    expect((await resolveSite("www.domainco.test.org"))?.orgId).toBe(org.id);

    // Certificate not ready: reachable but not active.
    let d = await checkSsl(as(owner), domainId, { cert: async () => ({ authorized: false, error: "self signed certificate", covers: false }) });
    expect(d.sslStatus).toBe("error");
    d = await checkLive(as(owner), domainId, { probe: serving() });
    expect(d).toMatchObject({ liveOk: true, status: "verified" });

    d = await checkSsl(as(owner), domainId, { cert: async () => ({ authorized: true, covers: true, validTo: new Date("2027-01-01") }) });
    expect(d.sslStatus).toBe("ready");
    expect(d.sslDetail).toMatch(/until 2027-01-01/);
    d = await checkLive(as(owner), domainId, { probe: async () => ({ status: 502, body: "" }) });
    expect(d).toMatchObject({ liveOk: false, status: "verified" });
    d = await checkLive(as(owner), domainId, { probe: serving() });
    expect(d).toMatchObject({ liveOk: true, status: "active" });
    // If it later stops answering, it is not called active any more.
    d = await checkLive(as(owner), domainId, { probe: async () => ({ status: 502, body: "" }) });
    expect(d.status).toBe("verified");
    void token;
  });

  it("only accepts a verified address as the main one, and falls back to the included address when it is removed", async () => {
    const pending = await addCustomDomain(as(owner), { hostname: "pending.domainco.test.org" });
    await expect(setPrimaryDomain(as(owner), pending.id)).rejects.toThrow(/Only a verified address/);
    await setPrimaryDomain(as(owner), domainId);
    let domains = await listDomains(as(owner));
    expect(domains.filter((x) => x.isPrimary).map((x) => x.hostname)).toEqual(["www.domainco.test.org"]);
    clearSiteCache();
    expect((await resolveSite("domain-co.sites.test.example"))?.canonicalHost).toBe("www.domainco.test.org");
    await removeDomain(as(owner), domainId);
    domains = await listDomains(as(owner));
    expect(domains.map((x) => x.hostname)).not.toContain("www.domainco.test.org");
    expect(domains.find((x) => x.isPrimary)?.kind).toBe("platform");
    clearSiteCache();
    expect(await resolveSite("www.domainco.test.org")).toBeNull();
    const platform = domains.find((x) => x.kind === "platform")!;
    await expect(removeDomain(as(owner), platform.id)).rejects.toThrow(/can't be removed/);
    await removeDomain(as(owner), pending.id);
  });

  it("limits how many addresses a site may have", async () => {
    const existing = (await listDomains(as(owner))).length;
    for (let i = 0; i < MAX_DOMAINS_PER_SITE - existing; i += 1) await addCustomDomain(as(owner), { hostname: `filler${i}.domainco.test.org` });
    await expect(addCustomDomain(as(owner), { hostname: "one-too-many.domainco.test.org" })).rejects.toThrow(/up to/);
    for (const d of await listDomains(as(owner))) if (d.kind === "custom") await removeDomain(as(owner), d.id);
  });

  it("lets the owner rename the included address, which is checked for validity and uniqueness", async () => {
    await expect(changeSubdomain(as(owner), { subdomain: "www" })).rejects.toThrow(/isn't available/);
    await expect(changeSubdomain(as(owner), { subdomain: "ab" })).rejects.toThrow(/3 to 42/);
    await expect(changeSubdomain(as(owner), { subdomain: "Bad Name" })).rejects.toThrow(/3 to 42/);
    await expect(changeSubdomain(as(rep, org, "sales_rep"), { subdomain: "fine-name" })).rejects.toThrow(/Only owners and managers/);
    const rival2 = (await getWebsite(as(rival, other)))!.subdomain;
    await expect(changeSubdomain(as(owner), { subdomain: rival2 })).rejects.toThrow(/taken/);
    const res = await changeSubdomain(as(owner), { subdomain: "domain-co-new" });
    expect(res.hostname).toBe("domain-co-new.sites.test.example");
    clearSiteCache();
    expect(await resolveSite("domain-co.sites.test.example")).toBeNull(); // the old address stops working at once
    expect((await resolveSite("domain-co-new.sites.test.example"))?.orgId).toBe(org.id);
  });
});

describe("buying a domain needs the owner's approval, and nothing is bought automatically", () => {
  let id = "";
  it("moves request → quote → owner approval → registered in the customer's name", async () => {
    const req = await requestDomainPurchase(as(manager, org, "admin"), { hostname: "domainco-shop.com" });
    id = req.id;
    expect(req.acquisition).toBe("purchase_requested");
    await expect(approveDomainPurchase(as(owner), id)).rejects.toThrow(/haven't priced/);
    await quoteDomainPurchase(staff.id, { orgId: org.id, domainId: id, costUsd: 14.99, renewsAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
    const quote = await withSystem((db) => db.query("select kind, title from notifications where org_id = $1 and title like 'Approve domainco-shop.com%'", [org.id]));
    expect(quote.rows.length).toBeGreaterThan(0);
    await expect(approveDomainPurchase(as(manager, org, "admin"), id)).rejects.toThrow(/Only the business owner/);
    await expect(recordDomainPurchase(staff.id, { orgId: org.id, domainId: id, registrar: "Namecheap", renewsAt: new Date().toISOString() })).rejects.toThrow(/hasn't approved/);
    await approveDomainPurchase(as(owner), id);
    const fee = await withSystem((db) => db.query<{ kind: string; amount_micros: string; status: string; recurrence: string }>("select kind, amount_micros, status, recurrence from provider_fees where org_id = $1 and description like '%domainco-shop.com'", [org.id]));
    expect(fee.rows[0]).toMatchObject({ kind: "domain", status: "approved", recurrence: "annual" });
    expect(Number(fee.rows[0].amount_micros)).toBe(14_990_000); // at cost: no markup
    await recordDomainPurchase(staff.id, { orgId: org.id, domainId: id, registrar: "Namecheap (customer account)", renewsAt: "2027-10-14T00:00:00Z" });
    const d = (await listDomains(as(owner))).find((x) => x.id === id)!;
    expect(d).toMatchObject({ acquisition: "purchased", registrar: "Namecheap (customer account)", status: "pending_dns" });
    await expect(approveDomainPurchase(as(owner), id)).rejects.toThrow(/isn't waiting/);
  });

  it("reminds the owner before a domain renews, once per window", async () => {
    const soon = new Date(Date.now() + 5 * 86400_000).toISOString();
    await withSystem((db) => db.query("update website_domains set renews_at = $2 where id = $1", [id, soon]));
    expect(await sendRenewalReminders()).toBeGreaterThanOrEqual(1);
    await sendRenewalReminders();
    const n = await withSystem((db) => db.query("select count(*) as c from notifications where org_id = $1 and kind = 'domain_renewal_due' and user_id = $2", [org.id, owner.id]));
    expect(Number(n.rows[0].c)).toBe(1);
    await withSystem((db) => db.query("update website_domains set renews_at = null where id = $1", [id]));
  });
});

describe("website enquiries", () => {
  const submit = (host: string, o: Partial<{ name: string; email: string; phone: string; message: string; consentText: string; marketing: boolean; dedupe: string }> = {}) =>
    withSiteRuntime((db) =>
      db.query<{ r: { status: string } }>("select app.submit_site_form($1, 'contact', $2, $3, $4, '', $5, true, $6, $7, 'h', '{\"utm_source\":\"google\"}'::jsonb, '', $8) as r", [
        host, o.name ?? "Pat Lee", o.email ?? "", o.phone ?? "", o.message ?? "Hello", o.marketing ?? false, o.consentText ?? "I agree to be contacted about my enquiry.", o.dedupe ?? `dedupe-${Math.random().toString(36).slice(2, 12)}`,
      ]),
    ).then((x) => x.rows[0].r.status);

  it("turns an enquiry into a contact with consent recorded exactly as far as the form's words went", async () => {
    await publishWebsite(as(owner), { acknowledgeClaims: true }, { probe: serving() });
    clearSiteCache();
    const host = "domain-co-new.sites.test.example";
    expect(await submit(host, { name: "Pat Lee", email: "Pat@Lee.test", phone: "+15125550123", message: "Quote for a roof, please.", marketing: true })).toBe("ok");
    expect(await submit(host, { name: "Quinn Rae", email: "", phone: "+15125550124", consentText: "Text me about my enquiry.", message: "Call me" })).toBe("ok");
    const out = await processSubmissions();
    expect(out).toEqual({ processed: 2, spam: 0, failed: 0 });

    const pat = (await withSystem((db) => db.query<{ id: string; display_name: string; email: string; lifecycle_stage: string; source: string }>("select c.id, c.display_name, c.email::text as email, c.lifecycle_stage, c.source from contacts c join contact_identities i on i.contact_id = c.id and i.kind = 'email' and i.value = 'pat@lee.test' where c.org_id = $1", [org.id]))).rows[0];
    expect(pat).toMatchObject({ display_name: "Pat Lee", email: "pat@lee.test", lifecycle_stage: "lead_captured", source: "website_form" });
    const ids = await withSystem((db) => db.query<{ kind: string; verified: boolean }>("select kind, verified from contact_identities where contact_id = $1 order by kind", [pat.id]));
    expect(ids.rows).toEqual([{ kind: "email", verified: false }, { kind: "phone", verified: false }]); // a web form proves nothing about who typed it
    const consent = await withSystem((db) => db.query<{ channel: string; purpose: string; status: string; evidence: string }>("select channel, purpose, status, evidence from contact_consent_events where contact_id = $1 order by id", [pat.id]));
    expect(consent.rows.map((r) => `${r.channel}/${r.purpose}/${r.status}`)).toEqual(["email/service/granted", "email/marketing/granted"]); // wording didn't mention texting: no SMS consent
    expect(consent.rows[0].evidence).toContain("I agree to be contacted about my enquiry.");

    const quinn = (await withSystem((db) => db.query<{ id: string }>("select c.id from contacts c join contact_identities i on i.contact_id = c.id and i.value = '+15125550124' where c.org_id = $1", [org.id]))).rows[0];
    const qc = await withSystem((db) => db.query<{ channel: string; purpose: string }>("select channel, purpose from contact_consent_events where contact_id = $1", [quinn.id]));
    expect(qc.rows).toEqual([{ channel: "sms", purpose: "service" }]); // "Text me" does cover texting
    // The team can see it, and nothing was sent to the customer.
    const msgs = await withSystem((db) => db.query<{ direction: string; status: string; body: string }>("select m.direction, m.status, m.body from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1", [pat.id]));
    expect(msgs.rows).toHaveLength(1);
    expect(msgs.rows[0]).toMatchObject({ direction: "internal", status: "note" });
    expect(msgs.rows[0].body).toContain("Quote for a roof, please.");
    const sent = await withSystem((db) => db.query("select 1 from conversation_messages where org_id = $1 and direction = 'outbound'", [org.id]));
    expect(sent.rows).toEqual([]);
    const note = await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and title like 'New website enquiry from Pat Lee'", [org.id]));
    expect(note.rows.length).toBeGreaterThan(0);

    const list = await listSubmissions(as(owner));
    expect(list.map((s) => s.status)).toEqual(expect.arrayContaining(["processed"]));
    expect(list[0].utm).toEqual({ utm_source: "google" });
    expect(await processSubmissions()).toEqual({ processed: 0, spam: 0, failed: 0 }); // nothing is processed twice
  });

  it("matches a returning visitor by their exact address, never by name", async () => {
    const host = "domain-co-new.sites.test.example";
    await submit(host, { name: "Someone Else", email: "pat@lee.test", message: "A second enquiry" });
    await submit(host, { name: "Pat Lee", email: "different@lee.test", message: "Same name, different address" });
    await processSubmissions();
    const rows = await withSystem((db) => db.query<{ n: string }>("select count(*) as n from contacts where org_id = $1 and deleted_at is null and display_name in ('Pat Lee', 'Someone Else')", [org.id]));
    expect(Number(rows.rows[0].n)).toBe(2); // the first enquiry's contact, plus a separate Pat Lee; the repeat address was matched, not duplicated
    const conv = await withSystem((db) => db.query<{ unread_count: number }>("select c.unread_count from conversations c join contact_identities i on i.contact_id = c.contact_id and i.value = 'pat@lee.test' where c.org_id = $1", [org.id]));
    expect(conv.rows[0].unread_count).toBe(2);
  });

  it("drops link-spam, flags unusable contact details, and lets the team mark spam", async () => {
    const host = "domain-co-new.sites.test.example";
    await submit(host, { name: "Spammer", email: "spam@bad.test", message: "Visit https://a.test https://b.test https://c.test now" });
    await submit(host, { name: "No Contact", email: "", phone: "12345", message: "Hi" });
    const out = await processSubmissions();
    expect(out).toMatchObject({ spam: 1, failed: 1 });
    const list = await listSubmissions(as(owner));
    const failed = list.find((s) => s.name === "No Contact")!;
    expect(failed.status).toBe("failed");
    const spam = list.find((s) => s.name === "Spammer")!;
    expect(spam.status).toBe("spam");
    const spamContact = await withSystem((db) => db.query("select 1 from contact_identities where org_id = $1 and value = 'spam@bad.test'", [org.id]));
    expect(spamContact.rows).toEqual([]);
    const real = list.find((s) => s.name === "Pat Lee")!;
    await markSubmissionSpam(as(manager, org, "admin"), real.id);
    expect((await listSubmissions(as(owner))).find((s) => s.id === real.id)?.status).toBe("spam");
    await expect(markSubmissionSpam(as(viewer, org, "viewer"), real.id)).rejects.toThrow(/can't change enquiries/);
  });

  it("keeps enquiries private to the people who may see contacts, and to their own workspace", async () => {
    expect((await listSubmissions(as(viewer, org, "viewer"))).length).toBeGreaterThan(0); // viewers may see contacts
    expect(await listSubmissions(as(rival, other))).toEqual([]);
    await expect(listSubmissions(ctxFor(rival, other, "owner"))).resolves.toEqual([]);
  });
});
