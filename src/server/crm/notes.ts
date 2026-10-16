import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import type { Permission } from "@/lib/permissions";

export type NoteRecordType = "contact" | "company" | "opportunity";

export interface NoteView {
  id: string;
  body: string;
  pinned: boolean;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string | null;
  mine: boolean;
}

const VIEW: Record<NoteRecordType, Permission> = { contact: "contacts.view", company: "companies.view", opportunity: "sales.view" };

async function assertRecord(db: Queryable, orgId: string, type: NoteRecordType, id: string) {
  const sql =
    type === "contact"
      ? "select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null"
      : type === "company"
        ? "select 1 from crm_companies where id = $1 and org_id = $2 and deleted_at is null"
        : "select 1 from crm_opportunities where id = $1 and org_id = $2 and archived_at is null";
  const r = await db.query(sql, [id, orgId]);
  if (!r.rows.length) throw new AppError("not_found", "Record not found.");
}

export async function listNotes(actor: CrmActor, type: NoteRecordType, recordId: string): Promise<NoteView[]> {
  assertCan(actor, VIEW[type]);
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; body: string; pinned: boolean; author_id: string | null; author_name: string | null; created_at: Date; updated_at: Date | null }>(
      `select n.id, n.body, n.pinned, n.author_id, nullif(u.full_name, '') as author_name, n.created_at, n.updated_at from record_notes n left join users u on u.id = n.author_id
       where n.org_id = $1 and n.record_type = $2 and n.record_id = $3 and n.deleted_at is null order by n.pinned desc, n.created_at desc limit 200`,
      [actor.orgId, type, recordId],
    );
    return rows.map((r) => ({ id: r.id, body: r.body, pinned: r.pinned, authorId: r.author_id, authorName: r.author_name, createdAt: new Date(r.created_at).toISOString(), updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null, mine: r.author_id === actor.userId }));
  });
}

export async function addNote(actor: CrmActor, type: NoteRecordType, recordId: string, body: string): Promise<{ id: string }> {
  assertCan(actor, VIEW[type]);
  assertCan(actor, "notes.write");
  const text = body.trim();
  if (!text || text.length > 4000) throw new AppError("invalid_input", "Notes are 1 to 4000 characters.");
  return crmWrite(actor, async (db) => {
    await assertRecord(db, actor.orgId, type, recordId);
    const { rows } = await db.query<{ id: string }>("insert into record_notes (org_id, record_type, record_id, body, author_id) values ($1, $2, $3, $4, $5) returning id", [actor.orgId, type, recordId, text, actor.userId]);
    // The timeline shows that a note was added, never its text (notes can be long and private to the team).
    await recordActivity(db, actor, {
      kind: "note.added", summary: "Note added",
      contactId: type === "contact" ? recordId : null, companyId: type === "company" ? recordId : null, opportunityId: type === "opportunity" ? recordId : null, refType: "note", refId: rows[0].id,
    });
    await emitEvent(db, actor, { type: "note.added", entityType: type, entityId: recordId, contactId: type === "contact" ? recordId : null, payload: { noteId: rows[0].id }, dedupeKey: `note.added:${rows[0].id}` });
    return { id: rows[0].id };
  });
}

/** People edit and delete their own notes; owners and managers can tidy anyone's. */
async function authorizeNoteChange(db: Queryable, actor: CrmActor, id: string) {
  const { rows } = await db.query<{ author_id: string | null; record_type: NoteRecordType }>("select author_id, record_type from record_notes where id = $1 and org_id = $2 and deleted_at is null for update", [id, actor.orgId]);
  const n = rows[0];
  if (!n || !["contact", "company", "opportunity"].includes(n.record_type)) throw new AppError("not_found", "Note not found.");
  if (n.author_id !== actor.userId) assertCan(actor, "contacts.delete", "You can change only your own notes.");
  else assertCan(actor, "notes.write");
  return n;
}

export async function editNote(actor: CrmActor, id: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text || text.length > 4000) throw new AppError("invalid_input", "Notes are 1 to 4000 characters.");
  await crmWrite(actor, async (db) => {
    await authorizeNoteChange(db, actor, id);
    await db.query("update record_notes set body = $3, updated_at = now() where id = $1 and org_id = $2", [id, actor.orgId, text]);
  });
}

export async function deleteNote(actor: CrmActor, id: string): Promise<void> {
  await crmWrite(actor, async (db) => {
    await authorizeNoteChange(db, actor, id);
    await db.query("update record_notes set deleted_at = now() where id = $1 and org_id = $2", [id, actor.orgId]);
  });
}

export async function pinNote(actor: CrmActor, id: string, pinned: boolean): Promise<void> {
  assertCan(actor, "notes.write");
  await crmWrite(actor, async (db) => {
    const res = await db.query("update record_notes set pinned = $3 where id = $1 and org_id = $2 and deleted_at is null and record_type in ('contact', 'company', 'opportunity')", [id, actor.orgId, pinned]);
    if (!res.rowCount) throw new AppError("not_found", "Note not found.");
  });
}
