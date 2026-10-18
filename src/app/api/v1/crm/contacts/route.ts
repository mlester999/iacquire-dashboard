import { withSystem } from "@/server/db";
import { assertCan } from "@/server/crm/actor";
import { createContactInTx } from "@/server/crm/contacts";
import { ensureTagsByName } from "@/server/crm/tags";
import { apiHandler, createOnce, dateParam, decodeCursor, pageLimit, readJson, requireScope } from "../_lib/http";
import { contactOr404, listContactsPage } from "../_lib/resources";
import { contactCreateSchema, toContactInput } from "../_lib/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/crm/contacts: newest first. ?search= (name, email or phone), ?updated_since=, ?include_archived=true, ?limit=, ?cursor=. */
export async function GET(req: Request) {
  return apiHandler(req, ["contacts.read", "contacts.write"], async ({ actor }) => {
    assertCan(actor, "contacts.view");
    const url = new URL(req.url);
    const page = await withSystem((db) =>
      listContactsPage(db, actor, {
        limit: pageLimit(url), cursor: decodeCursor(url), search: url.searchParams.get("search")?.slice(0, 120) || undefined, updatedSince: dateParam(url, "updated_since"),
        includeArchived: url.searchParams.get("include_archived") === "true",
      }),
    );
    return { body: page };
  });
}

/**
 * POST /api/v1/crm/contacts: creates a contact with the same normalization and duplicate rules as the Contacts screen. An email or phone
 * that already belongs to a contact is refused with 409 duplicate_contact and that contact's id. Supports Idempotency-Key.
 */
export async function POST(req: Request) {
  return apiHandler(req, ["contacts.write"], async (ctx) => {
    assertCan(ctx.actor, "contacts.edit");
    const body = await readJson(req, contactCreateSchema);
    if (body.tags?.length) requireScope(ctx, "tags.write", "Tagging a new contact");
    const created = await createOnce(ctx, {
      auditAction: "crm.contact_created",
      targetType: "contact",
      body,
      create: async (db) => {
        const tagIds = body.tags?.length ? await ensureTagsByName(db, ctx.actor, body.tags) : [];
        return createContactInTx(db, ctx.actor, toContactInput(body, tagIds), { via: "api", onDuplicate: "error", tagSource: "api" });
      },
    });
    const contact = await withSystem((db) => contactOr404(db, ctx.actor.orgId, created.id));
    return { status: 201, body: { data: contact }, headers: created.replayed ? { "Idempotent-Replayed": "true" } : undefined };
  });
}
