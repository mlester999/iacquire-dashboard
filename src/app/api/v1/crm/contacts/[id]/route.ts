import { withSystem } from "@/server/db";
import { assertCan } from "@/server/crm/actor";
import { updateContact } from "@/server/crm/contacts";
import { apiHandler, readJson, uuidParam } from "../../_lib/http";
import { contactOr404 } from "../../_lib/resources";
import { contactUpdateSchema, toContactPatch } from "../../_lib/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/crm/contacts/{id} */
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  return apiHandler(req, ["contacts.read", "contacts.write"], async ({ actor }) => {
    assertCan(actor, "contacts.view");
    const contactId = uuidParam(id, "Contact");
    return { body: { data: await withSystem((db) => contactOr404(db, actor.orgId, contactId)) } };
  });
}

/**
 * PATCH /api/v1/crm/contacts/{id}: changes only the fields sent (null clears one). With "version" (from a previous read), the change is
 * refused with 409 if someone changed the contact since, so neither edit is lost.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  return apiHandler(req, ["contacts.write"], async ({ actor }) => {
    const contactId = uuidParam(id, "Contact");
    const body = await readJson(req, contactUpdateSchema);
    const result = await updateContact(actor, contactId, toContactPatch(body), body.version);
    const contact = await withSystem((db) => contactOr404(db, actor.orgId, contactId));
    return { body: { data: contact, changed: result.changed } };
  });
}
