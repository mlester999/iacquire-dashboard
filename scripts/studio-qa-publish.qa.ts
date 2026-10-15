/**
 * Publishes a few real sites in the isolated local database, so the published runtime (a visitor's page, not the preview or the editor) can be driven in
 * a browser. Run only while the isolated embedded QA server is stopped (npm run studio:qa:publish-seed); the sites answer on
 * http://{subdomain}.sites.localhost:3210 once `npm run studio:qa` is started again.
 *
 * It goes through the same service calls as the product: onboarding, create a website from a template, save the draft, publish as the owner with the
 * claims acknowledged. The one thing it does for the fixture is remove the galleries, collages, team and testimonial sections, because the publish check
 * rightly refuses starter photographs there (a client replaces them with their own). Nothing hosted is touched; the live check is "unchecked" locally.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { eachElement } from "../src/lib/website/doc";
import { removeNode } from "../src/lib/website/ops";
import { saveOnboardingStep } from "../src/server/onboarding/service";
import { createWebsite, getDraft, publishWebsite, saveDraft } from "../src/server/websites/service";
import { addMember, createOrg, createUser, ctxFor } from "../tests/support/fixtures";

const QA_DIR = path.resolve(".data/studio-premium-qa");
const SITES = [
  { name: "Studio QA Published Maison", template: "luxe.maison", industry: "real_estate" },
  { name: "Studio QA Published Skyline", template: "meridian.skyline", industry: "real_estate" },
  { name: "Studio QA Published Works", template: "agency.works", industry: "professional_services" },
] as const;
const PROOF = new Set(["gallery", "collage", "team", "testimonials"]);

it("publishes isolated fixture sites through the real service calls", async () => {
  const configuration = env();
  if (configuration.NODE_ENV === "production" || configuration.AUTH_PROVIDER !== "local" || configuration.DATABASE_DRIVER !== "pglite" || path.resolve(configuration.PGLITE_DATA_DIR) !== path.join(QA_DIR, "database")) {
    throw new Error("Refusing to publish outside .data/studio-premium-qa using local auth and embedded PGLite.");
  }
  try {
    const published: Array<{ name: string; template: string; subdomain: string; host: string; number: number }> = [];
    for (const site of SITES) {
      const existing = await withSystem(async (db) => (await db.query<{ subdomain: string; number: number }>(
        "select w.subdomain, p.number from organizations o join websites w on w.org_id = o.id join website_publications p on p.id = w.published_publication_id where o.name = $1", [site.name])).rows[0]);
      if (existing) {
        published.push({ name: site.name, template: site.template, subdomain: existing.subdomain, host: `${existing.subdomain}.${configuration.SITES_BASE_DOMAIN}`, number: Number(existing.number) });
        continue;
      }
      const email = `studio-qa-published-${site.template.replace(".", "-")}@example.test`;
      const owner = await createUser({ email, name: `Studio QA published owner (${site.template})`, platformRole: "none" });
      const org = await createOrg({ name: site.name });
      await withSystem((db) => db.query("update organizations set is_demo = true, onboarding_completed_at = coalesce(onboarding_completed_at, now()), timezone = 'Asia/Singapore' where id = $1", [org.id]));
      await addMember(org.id, owner.id, "owner");
      const ctx = ctxFor(owner, org, "owner");
      await saveOnboardingStep(ctx, { answers: {
        "a.business_name": { value: site.name }, "a.industry": { value: site.industry }, "a.business_model": { value: "local" },
        "a.description": { value: `${site.name} is a fictional local QA business. No customer records or external integrations are used.` },
        "a.contact_phone": { value: "+6565550123" }, "a.contact_email": { value: email }, "a.territories": { value: "Singapore" },
        "b.services": { value: "Consultation, Planning, Delivery" },
      } });
      const created = await createWebsite(ctx, { templateKey: site.template });
      const draft = (await getDraft(ctx))!;
      let content = draft.content;
      const proof: string[] = [];
      eachElement(content, (e) => { if (PROOF.has(e.type)) proof.push(e.id); });
      for (const id of proof) content = removeNode(content, id);
      await saveDraft(ctx, { content, expectedRevision: draft.revision });
      const outcome = await publishWebsite(ctx, { acknowledgeClaims: true, note: "Local QA fixture" });
      published.push({ name: site.name, template: site.template, subdomain: created.subdomain, host: outcome.host, number: outcome.number });
    }
    expect(published).toHaveLength(SITES.length);
    await fs.writeFile(path.join(QA_DIR, "published.json"), JSON.stringify({ baseUrl: "http://localhost:3210", scope: "Isolated local QA only; never hosted", createdAt: new Date().toISOString(), sites: published }, null, 2));
  } finally {
    await closeDb();
  }
}, 180000);
