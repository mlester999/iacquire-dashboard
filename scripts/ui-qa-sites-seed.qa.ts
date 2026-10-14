/**
 * Synthetic published websites for local visual QA of the public site runtime. It writes through the application's own
 * services into the isolated embedded QA database and sends nothing anywhere. Run it while the QA server is stopped:
 *
 *   $env:...  (see scripts/sites-qa-env.mjs)   or:   node scripts/run-sites-qa-seed.mjs
 */
import { it } from "vitest";
import sharp from "sharp";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { createAsset } from "../src/server/assets/service";
import { saveOnboardingStep } from "../src/server/onboarding/service";
import { createWebsite, getDraft, publishWebsite, saveDraft } from "../src/server/websites/service";
import { addMember, createOrg, createUser, ctxFor } from "../tests/support/fixtures";

const SITES = [
  { name: "Brightside Roofing", industry: "home_services", template: "forge.torque", phone: "+15125550100", email: "hello@brightside.test", services: "Roof inspections, Storm damage repair, Gutter replacement, Roof replacement", areas: "Austin, Round Rock, Cedar Park", custom: "brightside.localhost" },
  { name: "Haven Dental", industry: "healthcare", template: "haven.calm", phone: "+15125550111", email: "smile@haven.test", services: "Check-ups and cleaning, Whitening, Emergency appointments, Children's dentistry", areas: "Georgetown", custom: null },
  { name: "Meridian Homes", industry: "real_estate", template: "meridian.skyline", phone: "+15125550122", email: "agents@meridian.test", services: "Buying a home, Selling your property, Rentals", areas: "Downtown Austin, Westlake", custom: null },
] as const;

async function seed() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER === "postgres") throw new Error("Refusing to seed outside the isolated local QA database.");
  for (const s of SITES) {
    const existing = await withSystem((db) => db.query("select 1 from organizations where name = $1", [s.name]));
    if (existing.rows.length) continue;
    const org = await createOrg({ name: s.name });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const ctx = ctxFor(owner, org, "owner");
    await saveOnboardingStep(ctx, {
      answers: {
        "a.business_name": { value: s.name }, "a.industry": { value: s.industry }, "a.business_model": { value: "local" }, "a.description": { value: `${s.name} helps local customers with friendly, reliable service.` },
        "a.contact_phone": { value: s.phone }, "a.contact_email": { value: s.email }, "a.territories": { value: s.areas }, "b.services": { value: s.services },
        "a.hours": { value: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] } },
      },
    });
    await createWebsite(ctx, { templateKey: s.template });
    const logo = await createAsset(ctx, { kind: "logo", bytes: await sharp({ create: { width: 320, height: 120, channels: 3, background: "#ffffff" } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect x="10" y="20" width="80" height="80" rx="16" fill="#2c5bff"/><text x="105" y="75" font-family="Arial" font-size="34" font-weight="700" fill="#101828">${s.name.split(" ")[0]}</text></svg>`) }]).jpeg().toBuffer(), filename: "logo.jpg", altText: `${s.name} logo` });
    const d = (await getDraft(ctx))!;
    const c = structuredClone(d.content);
    c.brand.logoAssetId = logo.id;
    c.brand.logoVariant = logo.hasProcessed ? "processed" : "original";
    await saveDraft(ctx, { content: c, expectedRevision: d.revision });
    const live = async () => (await withSystem((db) => db.query<{ id: string }>("select published_publication_id as id from websites where org_id = $1", [org.id]))).rows[0].id;
    await publishWebsite(ctx, { acknowledgeClaims: true }, { probe: async () => ({ status: 200, body: `<i data-site-publication="${await live()}"></i>` }) });
    if (s.custom) {
      await withSystem((db) =>
        db.query(
          `insert into website_domains (org_id, website_id, hostname, kind, status, verification_token, verified_at, acquisition)
           select $1, w.id, $2, 'custom', 'verified', repeat('b', 32), now(), 'existing' from websites w where w.org_id = $1`,
          [org.id, s.custom],
        ),
      );
    }
  }
}

it("seeds published QA websites", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 180000);
