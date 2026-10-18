import { API_SCOPE_IDS } from "@/server/crm/api-keys";
import { apiHandler } from "../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/crm/me: which workspace and permissions the key has. Any valid key may call it; useful to test a new key. */
export async function GET(req: Request) {
  return apiHandler(req, [...API_SCOPE_IDS], async ({ key }) => ({
    body: { data: { workspace: { id: key.orgId, name: key.orgName, timezone: key.timezone }, key: { name: key.name, prefix: key.prefix, scopes: key.scopes } } },
  }));
}
