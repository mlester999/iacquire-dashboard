import { z } from "zod";
import { opsScopeRequestSchema, resolveOpsScope, searchOpsScopes } from "@/server/aqi/ops/scope";
import { opsError, opsJson, requireOpsAdmin } from "@/server/aqi/ops/http";
import { OPS_SCOPE_TYPES, type OpsScopeType } from "@/lib/aqi/ops/types";

export const dynamic = "force-dynamic";

/** Typeahead for the investigation context picker. Results are limited to what this administrator may open. */
export async function GET(request: Request) {
  try {
    const user = await requireOpsAdmin();
    const params = new URL(request.url).searchParams;
    const types = (params.get("types") ?? "").split(",").filter((t): t is OpsScopeType => (OPS_SCOPE_TYPES as readonly string[]).includes(t));
    const options = await searchOpsScopes(user, { q: params.get("q") ?? "", types });
    return opsJson({ options });
  } catch (err) {
    return opsError(err);
  }
}

/** Validates one context server-side and returns its verified label and tenant. Selecting it grants nothing the tools do not re-check. */
export async function POST(request: Request) {
  try {
    const user = await requireOpsAdmin({ mutating: true });
    const parsed = z.object({ scope: opsScopeRequestSchema }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return opsJson({ error: "Choose a valid investigation context.", code: "invalid_input" }, { status: 400 });
    return opsJson({ scope: await resolveOpsScope(user, parsed.data.scope) });
  } catch (err) {
    return opsError(err);
  }
}
