import { z } from "zod";
import { AppError } from "@/server/errors";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { createOpsRun } from "@/server/aqi/ops/executor";
import { findReadTool } from "@/server/aqi/ops/registry";
import { opsScopeRequestSchema, resolveOpsScope } from "@/server/aqi/ops/scope";
import { opsError, opsJson, requireOpsAdmin } from "@/server/aqi/ops/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  toolId: z.string().min(3).max(60),
  args: z.record(z.string(), z.unknown()).default({}),
  scope: opsScopeRequestSchema.optional(),
}).strict();

/**
 * Re-runs one READ tool so a card can show current data. Only read tools exist on this path; the tool
 * id, arguments and scope go through exactly the same registry, schema and authorization checks as a
 * chat turn, and the run is audited the same way.
 */
export async function POST(request: Request) {
  try {
    const user = await requireOpsAdmin({ mutating: true });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return opsJson({ error: "That refresh request was not valid.", code: "invalid_input" }, { status: 400 });
    const tool = findReadTool(parsed.data.toolId);
    if (!tool) return opsJson({ error: "That check cannot be refreshed.", code: "not_found" }, { status: 404 });
    const limit = await consumeRateLimit(RATE_LIMITS.aqiOpsRefreshByUser, user.id);
    if (!limit.allowed) throw new AppError("rate_limited", "You're refreshing quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
    const scope = await resolveOpsScope(user, parsed.data.scope ?? { type: "platform" });
    const run = await createOpsRun({ user, scope, signal: request.signal, plannedToolIds: [tool.id] });
    const outcome = await run.runTool(tool.id, parsed.data.args);
    await run.flushAudit();
    return opsJson({ run: outcome.run, cards: outcome.cards, summary: outcome.summary, unavailable: outcome.unavailable });
  } catch (err) {
    return opsError(err);
  }
}
