/**
 * Fills the internal iAcquire agency company profile from the approved business facts.
 *
 * Dry run by default. Only empty fields are filled; a confirmed value is never overwritten. This is
 * intentionally an explicit operator command, not a migration, so no production tenant changes
 * without authorization.
 *
 *   node --env-file=.env.development --conditions=react-server --import tsx \
 *     scripts/apply-internal-business-profile.ts [--apply] [--authorized-production]
 */
import { closeDb, withSystem } from "@/server/db";
import { INTERNAL_BUSINESS, internalServicesText } from "@/lib/internal-business-profile";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const authorizedProduction = args.has("--authorized-production");

async function main() {
  if (process.env.NODE_ENV === "production" && apply && !authorizedProduction) {
    throw new Error("Refusing to write the production profile without --authorized-production. Use the guarded activation process.");
  }
  const result = await withSystem(async (db) => {
    const { rows: orgs } = await db.query<{ id: string; name: string; industry: string | null }>(
      "select id, name, industry from organizations where kind = 'agency' order by created_at limit 1",
    );
    const org = orgs[0];
    if (!org) throw new Error("No internal agency workspace was found.");
    const { rows: profiles } = await db.query<{
      description: string; services: string; ideal_customers: string; operating_area: string;
    }>(
      "select description, services, ideal_customers, operating_area from company_profiles where org_id = $1",
      [org.id],
    );
    const profile = profiles[0] ?? { description: "", services: "", ideal_customers: "", operating_area: "" };
    const desired = {
      description: profile.description.trim() || INTERNAL_BUSINESS.description,
      services: profile.services.trim() || internalServicesText(),
      ideal_customers: profile.ideal_customers.trim() || INTERNAL_BUSINESS.idealCustomers,
      operating_area: profile.operating_area.trim() || INTERNAL_BUSINESS.operatingArea,
      industry: org.industry?.trim() || INTERNAL_BUSINESS.industry,
    };
    const changes = {
      description: desired.description !== profile.description,
      services: desired.services !== profile.services,
      ideal_customers: desired.ideal_customers !== profile.ideal_customers,
      operating_area: desired.operating_area !== profile.operating_area,
      industry: desired.industry !== (org.industry ?? ""),
    };
    if (apply && Object.values(changes).some(Boolean)) {
      await db.query(
        `update company_profiles
            set description = $2, services = $3, ideal_customers = $4, operating_area = $5, updated_at = now()
          where org_id = $1`,
        [org.id, desired.description, desired.services, desired.ideal_customers, desired.operating_area],
      );
      await db.query("update organizations set industry = $2 where id = $1", [org.id, desired.industry]);
    }
    return {
      orgId: org.id,
      orgName: org.name,
      changed: Object.entries(changes).filter(([, changed]) => changed).map(([field]) => field),
      written: apply && Object.values(changes).some(Boolean),
      facts: {
        description: desired.description.length,
        services: desired.services.length,
        idealCustomers: desired.ideal_customers.length,
        operatingArea: desired.operating_area.length,
        industry: desired.industry,
      },
    };
  });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) console.log("Dry run. Re-run with --apply to write these empty fields.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
