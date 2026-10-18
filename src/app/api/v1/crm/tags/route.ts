import { listTags } from "@/server/crm/tags";
import { apiHandler } from "../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/crm/tags: every tag in the workspace, alphabetically. ?search= narrows by name. */
export async function GET(req: Request) {
  return apiHandler(req, ["tags.read", "tags.write"], async ({ actor }) => {
    const search = new URL(req.url).searchParams.get("search")?.slice(0, 60) || undefined;
    const tags = await listTags(actor, { search });
    return { body: { data: tags.map((t) => ({ id: t.id, name: t.name, color: t.color, description: t.description, contactCount: t.contactCount, createdAt: t.createdAt })) } };
  });
}
