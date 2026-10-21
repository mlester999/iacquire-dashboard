import { z } from "zod";
import { cancelOpsAction, confirmOpsAction, getOpsAction } from "@/server/aqi/ops/actions";
import { opsError, opsJson, requireOpsAdmin, UUID } from "@/server/aqi/ops/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  op: z.enum(["confirm", "cancel"]),
  phrase: z.string().max(120).optional(),
  reason: z.string().max(500).optional(),
}).strict();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOpsAdmin();
    const { id } = await params;
    if (!UUID.test(id)) return opsJson({ error: "That action was not found.", code: "not_found" }, { status: 404 });
    return opsJson(await getOpsAction(user, id));
  } catch (err) {
    return opsError(err);
  }
}

/**
 * Confirm or cancel a proposal. Only the administrator who asked can confirm it; confirmation asks
 * the auth server whether the account is still valid, re-checks the role, scope and target state,
 * and reports success only after the change is read back from the system.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOpsAdmin({ mutating: true, fresh: true });
    const { id } = await params;
    if (!UUID.test(id)) return opsJson({ error: "That action was not found.", code: "not_found" }, { status: 404 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return opsJson({ error: "Check the confirmation details and try again.", code: "invalid_input" }, { status: 400 });
    const { op, ...details } = parsed.data;
    return opsJson(op === "cancel" ? await cancelOpsAction(user, id) : await confirmOpsAction(user, id, details));
  } catch (err) {
    return opsError(err);
  }
}
