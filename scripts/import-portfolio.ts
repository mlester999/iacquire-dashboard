/**
 * Loads the verified founder-portfolio content (content/founder-portfolio.json) into the iAcquire content
 * system. New projects arrive hidden and "pending review": nothing reaches clients until a super admin
 * reviews each one in Admin → Portfolio and confirms public disclosure is permitted.
 *
 *   npm run portfolio:import
 *
 * Safe to re-run: pending projects are refreshed, approved projects are never overwritten.
 */
import { closeDb, withSystem } from "../src/server/db/index";
import { importFounderPortfolio } from "../src/server/portfolio/import";

async function main() {
  const result = await withSystem((db) => importFounderPortfolio(db, null));
  console.log(
    `Portfolio import: ${result.created} created, ${result.refreshed} refreshed, ${result.untouched} already approved (untouched); ${result.assetsAdded} image references and ${result.linksAdded} service links added.`,
  );
  await closeDb();
}

main().catch(async (err) => {
  console.error("Portfolio import failed:", err instanceof Error ? err.message : err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
