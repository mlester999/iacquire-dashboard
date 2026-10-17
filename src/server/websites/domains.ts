import "server-only";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import tls from "node:tls";
import { domainToASCII } from "node:url";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { safeLookup } from "@/server/onboarding/website";
import { probeSite, type ProbeFetcher } from "@/server/websites/probe";
import { DOMAIN_COLUMNS, mapDomain, platformHost, type DomainView } from "@/server/websites/service";
import type { OrgContext } from "@/server/tenancy/context";

export const MAX_DOMAINS_PER_SITE = 6;
export const VERIFY_RECORD_PREFIX = "_iacquire-verify";
export const verifyRecordValue = (token: string) => `iacquire-site-verification=${token}`;

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

async function requireAgencyDomainAccess(db: Queryable, userId: string, orgId: string) {
  const { rows } = await db.query<{ allowed: boolean }>(
    `select coalesce(app.user_can_access_org($1,$2),false)
       and coalesce(app.user_has_agency_permission($1,'website.domains'),false) as allowed`,
    [userId, orgId],
  );
  if (rows[0]?.allowed !== true) throw new AppError("forbidden", "Your role or client scope does not allow domain management.");
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BLOCKED_SUFFIX = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".test", ".invalid", ".example", ".onion"];

/** A clean, lower-case ASCII hostname, or an explanation of why it can't be used. */
export function normalizeCustomHostname(raw: string): { ok: true; hostname: string } | { ok: false; error: string } {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (!v) return { ok: false, error: "Enter the domain, like www.yourbusiness.com." };
  if (/[\s@]/.test(v)) return { ok: false, error: "Enter just the domain name, without spaces or an @." };
  const ascii = domainToASCII(v);
  if (!ascii) return { ok: false, error: "That doesn't look like a valid domain name." };
  const labels = ascii.split(".");
  if (labels.length < 2 || ascii.length > 253 || labels.some((l) => !LABEL.test(l))) return { ok: false, error: "That doesn't look like a valid domain name." };
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, error: "Use a domain name, not an IP address." };
  if (BLOCKED_SUFFIX.some((s) => ascii.endsWith(s))) return { ok: false, error: "That domain can't be used on the public internet." };
  const base = env().SITES_BASE_DOMAIN.toLowerCase();
  if (ascii === base || ascii.endsWith(`.${base}`)) return { ok: false, error: "Your included address is already set up. Enter a domain you own." };
  if (/(^|\.)iacquire\.com$/.test(ascii)) return { ok: false, error: "That domain belongs to iAcquire and can't be connected." };
  return { ok: true, hostname: ascii };
}

export const isApex = (hostname: string) => hostname.split(".").length <= 2;

export interface DnsInstructions {
  verifyRecord: { type: "TXT"; name: string; value: string };
  /** Where the domain should point once ownership is proven. Null until the platform's routing target is configured. */
  routing: { type: "CNAME" | "ALIAS"; name: string; value: string; note: string } | null;
  notes: string[];
}

export function dnsInstructions(d: Pick<DomainView, "hostname" | "verificationToken" | "kind">): DnsInstructions {
  const target = env().SITES_CNAME_TARGET;
  const apex = isApex(d.hostname);
  return {
    verifyRecord: { type: "TXT", name: `${VERIFY_RECORD_PREFIX}.${d.hostname}`, value: verifyRecordValue(d.verificationToken) },
    routing: target
      ? { type: apex ? "ALIAS" : "CNAME", name: d.hostname, value: target, note: apex ? "Use an ALIAS or ANAME record (some providers call it CNAME flattening) because a bare domain can't be a CNAME. If your provider doesn't offer one, use a www address instead." : "Add this CNAME record." }
      : null,
    notes: [
      "DNS changes can take anywhere from a few minutes to a few hours to spread.",
      "Add the TXT record first; it proves you own the domain. The routing record sends visitors to your site.",
      "Your domain stays registered in your name, with your registrar. We never transfer or hold it.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function requireWebsite(db: Queryable, ctx: OrgContext) {
  const { rows } = await db.query<{ id: string; subdomain: string; published_publication_id: string | null }>(
    "select id, subdomain, published_publication_id from websites where org_id = $1 and kind = 'website' for update", [ctx.org.orgId]);
  if (!rows[0]) throw new AppError("not_found", "Create your website first.");
  return rows[0];
}
function requireDomains(ctx: OrgContext) {
  if (!ctx.can("website.domains")) throw new AppError("forbidden", "Only owners and managers can manage domains.");
}

export async function listDomains(ctx: OrgContext): Promise<DomainView[]> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  return withUser(ctx.user.id, async (db) =>
    (await db.query<Record<string, unknown>>(`select ${DOMAIN_COLUMNS} from website_domains where org_id = $1 and removed_at is null order by is_primary desc, created_at`, [ctx.org.orgId])).rows.map(mapDomain),
  );
}

export async function addCustomDomain(ctx: OrgContext, input: { hostname: string }): Promise<DomainView> {
  requireDomains(ctx);
  const n = normalizeCustomHostname(input.hostname);
  if (!n.ok) throw new AppError("invalid_input", n.error);
  return withSystem(async (db) => {
    const site = await requireWebsite(db, ctx);
    const count = await db.query<{ n: string }>("select count(*) as n from website_domains where website_id = $1 and removed_at is null", [site.id]);
    if (Number(count.rows[0].n) >= MAX_DOMAINS_PER_SITE) throw new AppError("usage_limit", `A website can have up to ${MAX_DOMAINS_PER_SITE} addresses.`);
    try {
      const { rows } = await db.query<Record<string, unknown>>(
        `insert into website_domains (org_id, website_id, hostname, kind, status, verification_token, acquisition, created_by) values ($1, $2, $3, 'custom', 'pending_dns', $4, 'existing', $5) returning ${DOMAIN_COLUMNS}`,
        [ctx.org.orgId, site.id, n.hostname, crypto.randomBytes(16).toString("hex"), ctx.user.id],
      );
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.domain_added", targetType: "website_domain", targetId: rows[0].id as string, result: "success", metadata: { hostname: n.hostname } }, db);
      return mapDomain(rows[0]);
    } catch (err) {
      if (err instanceof Error && /website_domains_host_unique|duplicate key/.test(err.message)) {
        // Deliberately vague: it must not reveal who else has connected this domain.
        throw new AppError("conflict", "That domain is already connected to a website. If you own it and need it moved, contact support.");
      }
      throw err;
    }
  });
}

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}
const systemResolver: DnsResolver = { resolveTxt: dns.resolveTxt, resolveCname: dns.resolveCname, resolve4: dns.resolve4, resolve6: dns.resolve6 };
const safe = async <T>(fn: () => Promise<T[]>): Promise<T[]> => {
  try {
    return await fn();
  } catch {
    return [];
  }
};

/** Whether a host's DNS currently reaches our routing target, by CNAME or by resolving to the same addresses. */
export async function checkRouting(hostname: string, resolver: DnsResolver = systemResolver): Promise<{ ok: boolean | null; detail: string }> {
  const target = env().SITES_CNAME_TARGET?.toLowerCase();
  if (!target) return { ok: null, detail: "The platform's routing address isn't configured yet, so routing can't be checked." };
  const cnames = (await safe(() => resolver.resolveCname(hostname))).map((c) => c.toLowerCase().replace(/\.$/, ""));
  if (cnames.includes(target)) return { ok: true, detail: `Points to ${target}.` };
  const [mine4, theirs4, mine6, theirs6] = await Promise.all([
    safe(() => resolver.resolve4(hostname)), safe(() => resolver.resolve4(target)), safe(() => resolver.resolve6(hostname)), safe(() => resolver.resolve6(target)),
  ]);
  const same = mine4.some((a) => theirs4.includes(a)) || mine6.some((a) => theirs6.includes(a));
  if (same) return { ok: true, detail: `Resolves to the same address as ${target}.` };
  if (cnames.length) return { ok: false, detail: `It currently points to ${cnames[0]}, not ${target}.` };
  if (mine4.length || mine6.length) return { ok: false, detail: `It resolves, but not to ${target}. Check the routing record.` };
  return { ok: false, detail: "No DNS records were found for this address yet." };
}

export async function verifyDomain(ctx: OrgContext, domainId: string, deps: { resolver?: DnsResolver } = {}): Promise<DomainView> {
  requireDomains(ctx);
  const resolver = deps.resolver ?? systemResolver;
  const domain = await withUser(ctx.user.id, async (db) => (await db.query<{ id: string; hostname: string; kind: string; verification_token: string; status: string }>(
    "select id, hostname, kind, verification_token, status from website_domains where id = $1 and org_id = $2 and removed_at is null", [domainId, ctx.org.orgId])).rows[0]);
  if (!domain) throw new AppError("not_found", "Domain not found.");
  if (domain.kind === "platform") throw new AppError("invalid_input", "Your included address doesn't need verifying.");

  const records = (await safe(() => resolver.resolveTxt(`${VERIFY_RECORD_PREFIX}.${domain.hostname}`))).map((parts) => parts.join(""));
  const owned = records.includes(verifyRecordValue(domain.verification_token));
  const routing = owned ? await checkRouting(domain.hostname, resolver) : { ok: null as boolean | null, detail: "" };
  const detail = owned
    ? routing.ok === true ? "Ownership confirmed, and it points to your site." : `Ownership confirmed. ${routing.detail}`
    : records.length
      ? "A verification record was found, but its value doesn't match. Copy the value exactly as shown."
      : "We couldn't find the verification record yet. DNS changes can take a few hours to spread.";
  return withSystem(async (db) => {
    const { rows } = await db.query<Record<string, unknown>>(
      `update website_domains set dns_checked_at = now(), dns_detail = $2, routing_ok = $3,
         status = case when $4 and status = 'pending_dns' then 'verified' when not $4 and status in ('verified', 'active') and kind = 'custom' then 'pending_dns' else status end,
         verified_at = case when $4 then coalesce(verified_at, now()) else null end
       where id = $1 and org_id = $5 returning ${DOMAIN_COLUMNS}`,
      [domain.id, detail.slice(0, 300), owned ? routing.ok : null, owned, ctx.org.orgId],
    );
    if (owned && domain.status === "pending_dns") {
      await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], { kind: "domain_verified", severity: "success", title: `${domain.hostname} is verified`, body: "You can make it your main address once it's serving your site.", link: "/website/domains", dedupeKey: `domain-verified:${domain.id}` });
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.domain_verified", targetType: "website_domain", targetId: domain.id, result: "success" }, db);
    }
    return mapDomain(rows[0]);
  });
}

export type CertificateProbe = (hostname: string) => Promise<{ authorized: boolean; error?: string; validTo?: Date; covers: boolean }>;
const defaultCertProbe: CertificateProbe = (hostname) =>
  new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 8000, lookup: safeLookup as never }, () => {
      const cert = socket.getPeerCertificate();
      const covers = tls.checkServerIdentity(hostname, cert) === undefined;
      resolve({ authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : undefined, validTo: cert?.valid_to ? new Date(cert.valid_to) : undefined, covers });
      socket.end();
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ authorized: false, error: "timeout", covers: false });
    });
    socket.on("error", (e) => resolve({ authorized: false, error: e.message, covers: false }));
  });

/** Checks that the domain presents a valid certificate that covers it. Certificates themselves are issued by the hosting platform. */
export async function checkSsl(ctx: OrgContext, domainId: string, deps: { cert?: CertificateProbe } = {}): Promise<DomainView> {
  requireDomains(ctx);
  const d = await withUser(ctx.user.id, async (db) => (await db.query<{ id: string; hostname: string; status: string }>("select id, hostname, status from website_domains where id = $1 and org_id = $2 and removed_at is null", [domainId, ctx.org.orgId])).rows[0]);
  if (!d) throw new AppError("not_found", "Domain not found.");
  if (d.status === "pending_dns") throw new AppError("conflict", "Verify ownership of the domain first.");
  const res = await (deps.cert ?? defaultCertProbe)(d.hostname);
  const status = res.authorized && res.covers ? "ready" : res.error === "timeout" ? "pending" : "error";
  const detail = status === "ready" ? `Valid certificate${res.validTo ? ` until ${res.validTo.toISOString().slice(0, 10)}` : ""}.` : status === "pending" ? "No HTTPS answer yet. Certificates can take a few minutes after the routing record is in place." : `The certificate isn't valid for this address yet${res.error ? ` (${res.error.slice(0, 120)})` : ""}.`;
  return withSystem(async (db) =>
    mapDomain((await db.query<Record<string, unknown>>(`update website_domains set ssl_status = $2, ssl_detail = $3, ssl_checked_at = now() where id = $1 and org_id = $4 returning ${DOMAIN_COLUMNS}`, [d.id, status, detail.slice(0, 300), ctx.org.orgId])).rows[0]),
  );
}

/** Requests the site the way a visitor would and confirms the live publication answers. Only then is a domain called active. */
export async function checkLive(ctx: OrgContext, domainId: string, deps: { probe?: ProbeFetcher } = {}): Promise<DomainView> {
  requireDomains(ctx);
  const d = await withUser(ctx.user.id, async (db) => (await db.query<{ id: string; hostname: string; status: string; ssl_status: string; kind: string; pub: string | null }>(
    `select d.id, d.hostname, d.status, d.ssl_status, d.kind, w.published_publication_id as pub from website_domains d join websites w on w.id = d.website_id and w.org_id = d.org_id
     where d.id = $1 and d.org_id = $2 and d.removed_at is null`, [domainId, ctx.org.orgId])).rows[0]);
  if (!d) throw new AppError("not_found", "Domain not found.");
  if (d.status === "pending_dns") throw new AppError("conflict", "Verify ownership of the domain first.");
  if (!d.pub) throw new AppError("conflict", "Publish your website first, then check that it's live.");
  const result = await probeSite(d.hostname, d.pub, deps.probe);
  const live = result.state === "healthy";
  // A custom domain is "active" only when ownership, certificate and a real response all check out. The included address has no DNS or certificate of its own to verify here.
  const active = live && (d.kind === "platform" || d.ssl_status === "ready");
  return withSystem(async (db) => {
    const { rows } = await db.query<Record<string, unknown>>(
      `update website_domains set live_ok = $2, live_checked_at = now(), status = case when $3 then 'active' when status = 'active' and not $2 then 'verified' else status end
       where id = $1 and org_id = $4 returning ${DOMAIN_COLUMNS}`,
      [d.id, result.state === "unchecked" ? null : live, active, ctx.org.orgId],
    );
    return mapDomain(rows[0]);
  });
}

export async function setPrimaryDomain(ctx: OrgContext, domainId: string): Promise<void> {
  requireDomains(ctx);
  await withSystem(async (db) => {
    const site = await requireWebsite(db, ctx);
    const { rows } = await db.query<{ id: string; status: string }>("select id, status from website_domains where id = $1 and website_id = $2 and removed_at is null", [domainId, site.id]);
    if (!rows[0]) throw new AppError("not_found", "Domain not found.");
    if (!["verified", "active"].includes(rows[0].status)) throw new AppError("conflict", "Only a verified address can be your main address.");
    await db.query("update website_domains set is_primary = false where website_id = $1 and is_primary", [site.id]);
    await db.query("update website_domains set is_primary = true where id = $1", [domainId]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.domain_primary_set", targetType: "website_domain", targetId: domainId, result: "success" }, db);
  });
}

export async function removeDomain(ctx: OrgContext, domainId: string): Promise<void> {
  requireDomains(ctx);
  await withSystem(async (db) => {
    const site = await requireWebsite(db, ctx);
    const { rows } = await db.query<{ id: string; kind: string; is_primary: boolean }>("select id, kind, is_primary from website_domains where id = $1 and website_id = $2 and removed_at is null", [domainId, site.id]);
    const d = rows[0];
    if (!d) throw new AppError("not_found", "Domain not found.");
    if (d.kind === "platform") throw new AppError("invalid_input", "Your included address can't be removed.");
    await db.query("update website_domains set removed_at = now(), status = 'removed', is_primary = false where id = $1", [d.id]);
    // The included address takes over as the main one so the site never loses its canonical address.
    if (d.is_primary) await db.query("update website_domains set is_primary = true where website_id = $1 and kind = 'platform' and removed_at is null", [site.id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.domain_removed", targetType: "website_domain", targetId: d.id, result: "success" }, db);
  });
}

/** Changes the included address. Possible any time; the old address stops working immediately, so this is the owner's explicit choice. */
export async function changeSubdomain(ctx: OrgContext, input: { subdomain: string }): Promise<{ hostname: string }> {
  requireDomains(ctx);
  const sub = input.subdomain.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,40}[a-z0-9])$/.test(sub)) throw new AppError("invalid_input", "Use 3 to 42 letters, numbers or hyphens.");
  return withSystem(async (db) => {
    const site = await requireWebsite(db, ctx);
    try {
      await db.query("update websites set subdomain = $2 where id = $1", [site.id, sub]);
    } catch (err) {
      if (err instanceof Error && /websites_subdomain_key|duplicate key/.test(err.message)) throw new AppError("conflict", "That address is taken. Try another.");
      if (err instanceof Error && /check constraint/.test(err.message)) throw new AppError("invalid_input", "That address isn't available. Try another.");
      throw err;
    }
    const host = platformHost(sub);
    await db.query("update website_domains set hostname = $2, live_ok = null, live_checked_at = null where website_id = $1 and kind = 'platform' and removed_at is null", [site.id, host]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.subdomain_changed", targetType: "website", targetId: site.id, result: "success", metadata: { subdomain: sub } }, db);
    return { hostname: host };
  });
}

// ---------------------------------------------------------------------------
// Buying a domain: a request the owner approves. Nothing is ever purchased automatically.
// ---------------------------------------------------------------------------

export async function requestDomainPurchase(ctx: OrgContext, input: { hostname: string }): Promise<DomainView> {
  requireDomains(ctx);
  const n = normalizeCustomHostname(input.hostname);
  if (!n.ok) throw new AppError("invalid_input", n.error);
  return withSystem(async (db) => {
    const site = await requireWebsite(db, ctx);
    try {
      const { rows } = await db.query<Record<string, unknown>>(
        `insert into website_domains (org_id, website_id, hostname, kind, status, verification_token, acquisition, created_by) values ($1, $2, $3, 'custom', 'pending_dns', $4, 'purchase_requested', $5) returning ${DOMAIN_COLUMNS}`,
        [ctx.org.orgId, site.id, n.hostname, crypto.randomBytes(16).toString("hex"), ctx.user.id],
      );
      await notifyAgency(db, ctx.org.orgId, { kind: "system", severity: "info", title: `${ctx.org.name} asked us to get a domain: ${n.hostname}`, body: "Check availability, add a price, and send it to the client for approval. Do not buy until they approve.", link: `/admin/clients/${ctx.org.orgId}` });
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.domain_purchase_requested", targetType: "website_domain", targetId: rows[0].id as string, result: "success", metadata: { hostname: n.hostname } }, db);
      return mapDomain(rows[0]);
    } catch (err) {
      if (err instanceof Error && /duplicate key/.test(err.message)) throw new AppError("conflict", "That domain is already connected to a website.");
      throw err;
    }
  });
}

/** Agency staff record the price they found. The client sees it and decides; no money moves here. */
export async function quoteDomainPurchase(agencyUserId: string, input: { orgId: string; domainId: string; costUsd: number; renewsAt?: string }): Promise<void> {
  if (!(input.costUsd > 0 && input.costUsd <= 500)) throw new AppError("invalid_input", "Enter the first-year price in US dollars.");
  await withSystem(async (db) => {
    await requireAgencyDomainAccess(db, agencyUserId, input.orgId);
    const { rows } = await db.query<{ id: string; acquisition: string; hostname: string }>("select id, acquisition, hostname from website_domains where id = $1 and org_id = $2 and removed_at is null for update", [input.domainId, input.orgId]);
    if (!rows[0] || rows[0].acquisition !== "purchase_requested") throw new AppError("conflict", "That domain isn't waiting for a quote.");
    await db.query("update website_domains set purchase_cost_micros = $2, renews_at = $3 where id = $1", [input.domainId, Math.round(input.costUsd * 1_000_000), input.renewsAt ?? null]);
    await notifyOrgRoles(db, input.orgId, ["owner"], { kind: "approval_requested", severity: "info", title: `Approve ${rows[0].hostname}?`, body: `The first year costs $${input.costUsd.toFixed(2)}, billed at cost with no markup. Nothing is bought until you approve.`, link: "/website/domains", dedupeKey: `domain-quote:${input.domainId}` });
    await recordAudit({ orgId: input.orgId, actorUserId: agencyUserId, actorKind: "agency", action: "website.domain_quoted", targetType: "website_domain", targetId: input.domainId, result: "success", metadata: { costUsd: input.costUsd } }, db);
  });
}

export async function approveDomainPurchase(ctx: OrgContext, domainId: string): Promise<void> {
  if (!ctx.can("website.approve")) throw new AppError("forbidden", "Only the business owner can approve buying a domain.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; hostname: string; acquisition: string; purchase_cost_micros: string | null }>(
      "select id, hostname, acquisition, purchase_cost_micros from website_domains where id = $1 and org_id = $2 and removed_at is null for update", [domainId, ctx.org.orgId]);
    const d = rows[0];
    if (!d || d.acquisition !== "purchase_requested") throw new AppError("conflict", "That domain isn't waiting for approval.");
    if (!d.purchase_cost_micros) throw new AppError("conflict", "We haven't priced this domain yet.");
    await db.query("update website_domains set acquisition = 'purchase_approved', purchase_approved_by = $2, purchase_approved_at = now() where id = $1", [d.id, ctx.user.id]);
    // A fixed provider charge, disclosed and approved, billed at cost. It is never part of the metered usage markup.
    await db.query(
      `insert into provider_fees (org_id, provider, kind, description, amount_micros, recurrence, status, approved_by, approved_at, created_by)
       values ($1, 'registrar', 'domain', $2, $3, 'annual', 'approved', $4, now(), $4)`,
      [ctx.org.orgId, `Domain registration: ${d.hostname}`.slice(0, 200), d.purchase_cost_micros, ctx.user.id],
    );
    await notifyAgency(db, ctx.org.orgId, { kind: "system", severity: "info", title: `${ctx.org.name} approved buying ${d.hostname}`, body: "Register it in the client's own name, then record the purchase.", link: `/admin/clients/${ctx.org.orgId}` });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.domain_purchase_approved", targetType: "website_domain", targetId: d.id, result: "success" }, db);
  });
}

export async function recordDomainPurchase(agencyUserId: string, input: { orgId: string; domainId: string; registrar: string; renewsAt: string }): Promise<void> {
  if (!input.registrar.trim()) throw new AppError("invalid_input", "Record which registrar holds the domain.");
  await withSystem(async (db) => {
    await requireAgencyDomainAccess(db, agencyUserId, input.orgId);
    const { rows } = await db.query<{ id: string; acquisition: string; hostname: string }>("select id, acquisition, hostname from website_domains where id = $1 and org_id = $2 and removed_at is null for update", [input.domainId, input.orgId]);
    if (!rows[0] || rows[0].acquisition !== "purchase_approved") throw new AppError("conflict", "The owner hasn't approved buying this domain, so it can't be recorded as purchased.");
    await db.query("update website_domains set acquisition = 'purchased', registrar = $2, renews_at = $3 where id = $1", [input.domainId, input.registrar.trim().slice(0, 80), input.renewsAt]);
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], { kind: "domain_verified", severity: "success", title: `${rows[0].hostname} has been registered in your name`, body: "Add the verification record shown on the Domains page to connect it.", link: "/website/domains" });
    await recordAudit({ orgId: input.orgId, actorUserId: agencyUserId, actorKind: "agency", action: "website.domain_purchased", targetType: "website_domain", targetId: input.domainId, result: "success", metadata: { registrar: input.registrar.trim().slice(0, 80) } }, db);
  });
}

// ---------------------------------------------------------------------------
// Renewals
// ---------------------------------------------------------------------------

/** Reminds owners about domains renewing soon. Called from the scheduled worker; each reminder is sent once per window. */
export async function sendRenewalReminders(now = new Date()): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; hostname: string; renews_at: Date }>(
      "select id, org_id, hostname, renews_at from website_domains where removed_at is null and renews_at is not null and renews_at < $1::timestamptz + interval '31 days'", [now.toISOString()]);
    let sent = 0;
    for (const d of rows) {
      const days = Math.ceil((new Date(d.renews_at).getTime() - now.getTime()) / 86_400_000);
      const window = days <= 0 ? "overdue" : days <= 7 ? "7d" : "30d";
      await notifyOrgRoles(db, d.org_id, ["owner", "admin"], {
        kind: "domain_renewal_due", severity: days <= 7 ? "warning" : "info",
        title: days <= 0 ? `${d.hostname} is due for renewal now` : `${d.hostname} renews in ${days} day${days === 1 ? "" : "s"}`,
        body: "If the renewal lapses, your website address stops working.", link: "/website/domains", dedupeKey: `domain-renewal:${d.id}:${window}`,
      });
      sent += 1;
    }
    return sent;
  });
}

