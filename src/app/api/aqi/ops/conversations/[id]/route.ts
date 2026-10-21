import { z } from "zod";
import { deleteOpsConversation, getOpsConversation, renameOpsConversation } from "@/server/aqi/ops/conversations";
import { opsError, opsJson, requireOpsAdmin, UUID } from "@/server/aqi/ops/http";

export const dynamic = "force-dynamic";

const notFound = () => opsJson({ error: "Conversation not found.", code: "not_found" }, { status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOpsAdmin();
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const before = new URL(request.url).searchParams.get("before");
    return opsJson(await getOpsConversation(user, id, before && !Number.isNaN(Date.parse(before)) ? before : null));
  } catch (err) {
    return opsError(err);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOpsAdmin({ mutating: true });
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const parsed = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return opsJson({ error: "Give the conversation a name under 120 characters.", code: "invalid_input" }, { status: 400 });
    return opsJson({ ok: true, title: await renameOpsConversation(user, id, parsed.data.title) });
  } catch (err) {
    return opsError(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireOpsAdmin({ mutating: true });
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    await deleteOpsConversation(user, id);
    return opsJson({ ok: true });
  } catch (err) {
    return opsError(err);
  }
}
