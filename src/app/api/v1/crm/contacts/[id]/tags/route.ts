import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { assertNativeOwner } from "@/server/crm/workspace";
import { applyContactTags, ensureTagsByName, removeContactTags } from "@/server/crm/tags";
import { apiHandler, readJson, uuidParam } from "../../../_lib/http";
import { contactOr404 } from "../../../_lib/resources";
import { tagChangeSchema } from "../../../_lib/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/crm/contacts/{id}/tags: { "add": [...], "remove": [...] }. Each item is a tag id or a tag name. Names that don't exist yet
 * are created when adding and ignored when removing. Adding a tag the contact already has, or removing one it doesn't, changes nothing.
 * Each real change is recorded on the contact's timeline and can start workflows and webhooks. The answer carries the whole contact only
 * for a key that may read contacts; a tags-only key gets the contact's id and tags, so tagging never becomes a way to read contact details.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiHandler(req, ["tags.write"], async (ctx) => {
    const contactId = uuidParam(id, "Contact");
    const body = await readJson(req, tagChangeSchema);
    const { actor } = ctx;
    const result = await withSystem(async (db) => {
      await assertNativeOwner(db, actor.orgId, "contacts");
      const c = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null for update", [contactId, actor.orgId]);
      if (!c.rows.length) throw new AppError("not_found", "Contact not found.");
      const resolve = async (items: string[], create: boolean): Promise<string[]> => {
        const ids = items.filter((s) => UUID.test(s)).map((s) => s.toLowerCase());
        const names = items.filter((s) => !UUID.test(s));
        if (ids.length) {
          const found = await db.query<{ id: string }>("select id from crm_tags where org_id = $1 and id = any($2::uuid[])", [actor.orgId, ids]);
          if (found.rows.length !== new Set(ids).size) throw new AppError("not_found", "One of these tag ids doesn't exist in this workspace.");
        }
        let byName: string[] = [];
        if (names.length) {
          byName = create
            ? await ensureTagsByName(db, actor, names)
            : (await db.query<{ id: string }>("select id from crm_tags where org_id = $1 and lower(name::text) = any($2::text[])", [actor.orgId, names.map((n) => n.replace(/\s+/g, " ").trim().toLowerCase())])).rows.map((r) => r.id);
        }
        return [...new Set([...ids, ...byName])];
      };
      const addIds = await resolve(body.add ?? [], true);
      const removeIds = (await resolve(body.remove ?? [], false)).filter((t) => !addIds.includes(t));
      const added = await applyContactTags(db, actor, [contactId], addIds, "api");
      const removed = await removeContactTags(db, actor, [contactId], removeIds);
      if (added || removed) {
        await recordAudit({ orgId: actor.orgId, actorKind: "system", action: "crm.contact_tags_changed", targetType: "contact", targetId: contactId, result: "success", metadata: { via: "api", keyRef: ctx.key.prefix, added, removed, requestId: ctx.requestId } }, db);
      }
      const readable = ctx.key.scopes.includes("contacts.read") || ctx.key.scopes.includes("contacts.write");
      if (readable) return { added, removed, contact: await contactOr404(db, actor.orgId, contactId) as unknown };
      const tags = await db.query<{ id: string; name: string }>(
        "select t.id, t.name::text as name from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id where ct.org_id = $1 and ct.contact_id = $2 order by lower(t.name::text)",
        [actor.orgId, contactId],
      );
      return { added, removed, contact: { id: contactId, tags: tags.rows } as unknown };
    });
    return { body: { data: result.contact, added: result.added, removed: result.removed } };
  });
}
