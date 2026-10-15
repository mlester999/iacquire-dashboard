/**
 * Adds one more single-use fresh client to the isolated local database: a client who has finished onboarding but has no website yet, so "choose a design
 * and start a website" can be driven for real again (a client who has made a website is sent straight to it). Run only while the isolated embedded QA
 * server is stopped (npm run studio:qa:fresh-seed); the account is recorded in .data/studio-premium-qa/fresh-clients.json, which the library QA reads.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { createSession, validateSessionToken } from "../src/server/auth/service";
import { saveOnboardingStep } from "../src/server/onboarding/service";
import { addMember, createOrg, createUser, ctxFor } from "../tests/support/fixtures";

const QA_DIR = path.resolve(".data/studio-premium-qa");
const FILE = path.join(QA_DIR, "fresh-clients.json");

it("adds a fresh client with no website to the isolated database", async () => {
  const configuration = env();
  if (configuration.NODE_ENV === "production" || configuration.AUTH_PROVIDER !== "local" || configuration.DATABASE_DRIVER !== "pglite" || path.resolve(configuration.PGLITE_DATA_DIR) !== path.join(QA_DIR, "database")) {
    throw new Error("Refusing to seed outside .data/studio-premium-qa using local auth and embedded PGLite.");
  }
  try {
    let existing: { clients: Array<Record<string, unknown>> } = { clients: [] };
    try { existing = JSON.parse(await fs.readFile(FILE, "utf8")); } catch { /* first run */ }
    const n = existing.clients.length + 2; // the original fixture is number 1
    const name = `Studio QA Fresh Client ${n}`;
    const email = `studio-qa-fresh-${n}@example.test`;
    const user = await createUser({ email, name: `Studio QA fresh owner ${n}`, platformRole: "none" });
    const org = await createOrg({ name });
    await withSystem((db) => db.query("update organizations set is_demo = true, onboarding_completed_at = coalesce(onboarding_completed_at, now()), timezone = 'Asia/Singapore' where id = $1", [org.id]));
    await addMember(org.id, user.id, "owner");
    await saveOnboardingStep(ctxFor(user, org, "owner"), { answers: {
      "a.business_name": { value: name }, "a.industry": { value: "real_estate" }, "a.business_model": { value: "local" },
      "a.description": { value: `${name} is a fictional local QA business with no website yet.` },
      "a.contact_phone": { value: "+6565550101" }, "a.contact_email": { value: email }, "a.territories": { value: "Singapore" },
      "b.services": { value: "Property search, Viewings, Moving support" },
    } });
    const token = await createSession(user.id, { ip: "127.0.0.1", userAgent: "Website Studio isolated local QA" });
    expect(await validateSessionToken(token)).toBeTruthy();
    existing.clients.push({ number: n, organizationId: org.id, name, email, sessionToken: token, createdAt: new Date().toISOString() });
    await fs.writeFile(FILE, JSON.stringify({ scope: "Isolated local QA only; never hosted", ...existing }, null, 2));
  } finally {
    await closeDb();
  }
}, 120000);
