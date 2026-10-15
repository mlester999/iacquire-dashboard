/** Real local Studio fixtures. Run only while the isolated embedded QA server is stopped. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { createSession, validateSessionToken, type SessionUser } from "../src/server/auth/service";
import { hashPassword } from "../src/server/security/crypto";
import { createAsset } from "../src/server/assets/service";
import { saveOnboardingStep } from "../src/server/onboarding/service";
import { agencyCanAccessOrg } from "../src/server/tenancy/context";
import { createWebsite, getDraft, listVersions, saveDraft, saveVersion } from "../src/server/websites/service";
import { createTemplate, getTemplateDraft, saveTemplateDraft, setTemplateStatus } from "../src/server/websites/templates";
import { eachElement, type ElementNode } from "../src/lib/website/doc";
import { setProp } from "../src/lib/website/ops";
import { addMember, createOrg, createUser, ctxFor } from "../tests/support/fixtures";

const QA_DIR = path.resolve(".data/studio-premium-qa");
const CREDENTIALS = path.join(QA_DIR, "credentials.json");
type AccountKey = "admin" | "owner" | "editor" | "staff" | "unassignedStaff" | "otherOwner" | "freshOwner";
type Account = { id: string; email: string; password: string; sessionToken: string; cookieHeader: string; user: SessionUser };

async function account(key: AccountKey, platformRole: "none" | "agency_staff" | "agency_super_admin", existing: Partial<Record<AccountKey, Account>>) {
  const email = `studio-qa-${key.toLowerCase()}@example.test`;
  const row = await withSystem(async (db) => (await db.query<{ id: string }>("select id from users where email = $1", [email])).rows[0]);
  const user = row ?? await createUser({ email, name: `Studio QA ${key}`, platformRole });
  const password = existing[key]?.password ?? `${crypto.randomBytes(18).toString("base64url")}-Qa1!`;
  if (!row || !existing[key]?.password) {
    const passwordHash = await hashPassword(password);
    await withSystem((db) => db.query("insert into auth_credentials (user_id, password_hash) values ($1, $2) on conflict (user_id) do update set password_hash = excluded.password_hash", [user.id, passwordHash]));
  }
  const sessionToken = await createSession(user.id, { ip: "127.0.0.1", userAgent: "Website Studio isolated local QA" });
  const session = await validateSessionToken(sessionToken);
  if (!session) throw new Error(`Local QA session validation failed for ${key}.`);
  return { id: user.id, email, password, sessionToken, cookieHeader: `iaq_session=${sessionToken}`, user: session } satisfies Account;
}

async function organization(name: string) {
  const row = await withSystem(async (db) => (await db.query<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where name = $1", [name])).rows[0]);
  const org = row ?? await createOrg({ name });
  await withSystem((db) => db.query("update organizations set is_demo = true, onboarding_completed_at = coalesce(onboarding_completed_at, now()), timezone = 'Asia/Singapore' where id = $1", [org.id]));
  return org;
}

async function member(orgId: string, userId: string, role: "owner" | "admin") {
  const exists = await withSystem((db) => db.query("select 1 from organization_memberships where org_id = $1 and user_id = $2", [orgId, userId]));
  if (!exists.rows.length) await addMember(orgId, userId, role);
}

it("seeds isolated real auth, tenant, draft, template and media fixtures", async () => {
  const configuration = env();
  if (configuration.NODE_ENV === "production" || configuration.AUTH_PROVIDER !== "local" || configuration.DATABASE_DRIVER !== "pglite" || path.resolve(configuration.PGLITE_DATA_DIR) !== path.join(QA_DIR, "database") || path.resolve(configuration.UPLOAD_DIR) !== path.join(QA_DIR, "uploads")) {
    throw new Error("Refusing to seed outside .data/studio-premium-qa using local auth and embedded PGLite.");
  }
  try {
    let previous: { accounts?: Partial<Record<AccountKey, Account>> } = {};
    try { previous = JSON.parse(await fs.readFile(CREDENTIALS, "utf8")); } catch { /* first run */ }
    const accounts = {} as Record<AccountKey, Account>;
    for (const [key, role] of [["admin", "agency_super_admin"], ["owner", "none"], ["editor", "none"], ["staff", "agency_staff"], ["unassignedStaff", "agency_staff"], ["otherOwner", "none"], ["freshOwner", "none"]] as const) {
      accounts[key] = await account(key, role, previous.accounts ?? {});
    }
    const main = await organization("Studio QA Maison Interiors");
    const other = await organization("Studio QA Harbor Homecare");
    // A client who has finished onboarding but has no website yet, so the "choose a design" flow can be driven for real.
    const fresh = await organization("Studio QA Fresh Start Co.");
    await member(main.id, accounts.owner.id, "owner");
    await member(main.id, accounts.editor.id, "admin");
    await member(other.id, accounts.otherOwner.id, "owner");
    await member(fresh.id, accounts.freshOwner.id, "owner");
    await saveOnboardingStep(ctxFor(accounts.freshOwner, fresh, "owner"), { answers: {
      "a.business_name": { value: fresh.name }, "a.industry": { value: "real_estate" }, "a.business_model": { value: "local" },
      "a.description": { value: `${fresh.name} is a fictional local QA business with no website yet.` },
      "a.contact_phone": { value: "+6565550101" }, "a.contact_email": { value: accounts.freshOwner.email }, "a.territories": { value: "Singapore" },
      "b.services": { value: "Property search, Viewings, Moving support" },
    } });
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2) on conflict do nothing", [main.id, accounts.staff.id]));
    accounts.owner.cookieHeader += `; iaq_org=${main.id}`;
    accounts.editor.cookieHeader += `; iaq_org=${main.id}`;
    accounts.otherOwner.cookieHeader += `; iaq_org=${other.id}`;
    accounts.freshOwner.cookieHeader += `; iaq_org=${fresh.id}`;

    const existingTemplate = await withSystem(async (db) => (await db.query<{ id: string; key: string }>("select id, key from website_templates where name = 'Studio QA Master' and kind = 'custom'", [])).rows[0]);
    const master = existingTemplate ?? await createTemplate(accounts.admin.user, { name: "Studio QA Master", description: "An isolated versioning fixture for local Website Studio verification.", from: { kind: "builtin", key: "meridian.estate" }, industries: ["real_estate"], tags: ["Editorial", "QA"] });
    if (!existingTemplate) await setTemplateStatus(accounts.admin.user, master.key, "published", "Local QA approved baseline");

    const fixtures = [];
    for (const [org, owner, templateKey, industry] of [[main, accounts.owner, master.key, "real_estate"], [other, accounts.otherOwner, "local.crew", "home_services"]] as const) {
      const ctx = ctxFor(owner, org, "owner");
      let draft = await getDraft(ctx);
      if (!draft) {
        await saveOnboardingStep(ctx, { answers: {
          "a.business_name": { value: org.name }, "a.industry": { value: industry }, "a.business_model": { value: "local" },
          "a.description": { value: `${org.name} is a fictional local QA business. No customer records or external integrations are used.` },
          "a.contact_phone": { value: "+6565550100" }, "a.contact_email": { value: owner.email }, "a.territories": { value: "Singapore" },
          "b.services": { value: industry === "real_estate" ? "Interior consultation, Room planning, Material selection" : "Home repairs, Property inspection, Scheduled maintenance" },
        } });
        await createWebsite(ctx, { templateKey });
        draft = (await getDraft(ctx))!;
        await saveVersion(ctx, { source: "checkpoint", note: "Local QA original client draft" });
      }
      const assets = await withSystem(async (db) => (await db.query<{ id: string; alt_text: string }>("select id, alt_text from org_assets where org_id = $1 and deleted_at is null order by created_at", [org.id])).rows);
      if (assets.length === 0) {
        for (const [label, color] of [["QA library replacement image", "#bd9474"], ["QA alternate composition", "#51756b"]]) {
          const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: color } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect x="100" y="90" width="440" height="620" fill="#e6ded2"/><circle cx="840" cy="370" r="185" fill="#263c39"/><text x="600" y="740" font-family="Arial" font-size="32" fill="#ffffff" text-anchor="middle">${label}</text></svg>`) }]).jpeg({ quality: 86 }).toBuffer();
          const created = await createAsset(ctx, { kind: "image", bytes, filename: `${label.toLowerCase().replaceAll(" ", "-")}.jpg`, altText: `${label} — ${org.name}` });
          assets.push({ id: created.id, alt_text: created.altText });
        }
      }
      fixtures.push({ organization: org, websiteId: draft.websiteId, templateKey: draft.templateKey, revision: draft.revision, pages: draft.content.pages.map(({ id, slug, title }) => ({ id, slug, title })), assets, versionCount: (await listVersions(ctx)).length });
    }

    // Exercise real service authorization and ownership checks while creating no
    // network traffic. These assertions also prove the seed's intended scope.
    expect(await agencyCanAccessOrg(accounts.staff.user, main.id)).toBe(true);
    expect(await agencyCanAccessOrg(accounts.staff.user, other.id)).toBe(false);
    expect(await agencyCanAccessOrg(accounts.unassignedStaff.user, main.id)).toBe(false);
    const ownerContext = ctxFor(accounts.owner, main, "owner");
    const editorContext = ctxFor(accounts.editor, main, "admin");
    expect(editorContext.can("website.edit")).toBe(true);
    expect(editorContext.can("website.publish")).toBe(false);
    const before = (await getDraft(ownerContext))!;
    const nodes: ElementNode[] = [];
    eachElement(before.content, (element) => nodes.push(element));
    const image = nodes.find((node) => node.type === "image");
    if (image) {
      const alienAsset = fixtures[1].assets[0].id;
      await expect(saveDraft(ownerContext, { content: setProp(before.content, image.id, "src", { kind: "asset", id: alienAsset }), expectedRevision: before.revision })).rejects.toMatchObject({ code: "invalid_input" });
    }
    if (!existingTemplate) {
      const current = await getTemplateDraft(accounts.admin.user, master.id);
      const content = structuredClone(current.content);
      content.business.tagline = "Unpublished local QA master change";
      await saveTemplateDraft(accounts.admin.user, master.id, { content, expectedRevision: current.revision });
    }
    expect((await getDraft(ownerContext))!.content).toEqual(before.content);

    await fs.mkdir(QA_DIR, { recursive: true });
    await fs.writeFile(CREDENTIALS, JSON.stringify({ baseUrl: "http://localhost:3210", createdAt: new Date().toISOString(), scope: "Isolated local QA only; never hosted", accounts, master, freshOrganization: fresh, fixtures, routes: { gallery: "/admin/website-studio/templates", templateEditor: `/admin/website-studio/templates/${master.id}`, clientEditor: "/website/edit", agencyEditor: `/admin/website-studio/websites/${main.id}/edit`, deniedAgencyEditor: `/admin/website-studio/websites/${other.id}/edit` } }, null, 2));
  } finally {
    await closeDb();
  }
}, 180000);
