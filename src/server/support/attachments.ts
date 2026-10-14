import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { uploadPrivateFile, signPrivateFile, removePrivateFile } from "@/server/storage/private";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

export interface SupportAttachment { id:string; filename:string; mime_type:string; size_bytes:number; visibility:"client"|"internal"; created_at:Date }
export async function listSupportAttachments(userId:string,ticketId:string): Promise<SupportAttachment[]> {
  return withUser(userId,async (db) => (await db.query<SupportAttachment>(
    `select a.id,f.filename,f.mime_type,f.size_bytes,a.visibility,a.created_at from support_attachments a
     join private_files f on f.id=a.private_file_id where a.ticket_id=$1 order by a.created_at`, [ticketId],
  )).rows);
}
export async function attachSupportFile(userId:string,ticketId:string,file:{ name:string; bytes:Buffer },internal=false) {
  const ticket = await withUser(userId,async (db) => (await db.query<{org_id:string; status:string; staff:boolean}>(
    "select org_id,status,app.staff_assigned(org_id) as staff from support_tickets where id=$1",[ticketId],
  )).rows[0]);
  if (!ticket) throw new AppError("not_found","Support request not found.");
  if (ticket.status === "closed") throw new AppError("conflict","This request is closed.");
  if (internal && !ticket.staff) throw new AppError("forbidden","Internal attachments require assigned agency access.");
  const limit = await consumeRateLimit(RATE_LIMITS.uploadByUser,userId);
  if (!limit.allowed) throw new AppError("rate_limited","Upload limit reached. Try again later.");
  const filename = path.basename(file.name).replace(/[^\w.\- ()]+/g,"_").slice(0,200) || "attachment";
  const extension = filename.split(".").at(-1)?.toLowerCase();
  const mime = ({pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",txt:"text/plain"} as Record<string,string>)[extension ?? ""];
  if (!mime) throw new AppError("invalid_input","Choose a PDF, PNG, JPEG or text attachment.");
  const visibility = internal ? "internal" : "client";
  const stored = await uploadPrivateFile({userId,orgId:ticket.org_id,bucket:"support-attachments",path:`${ticket.org_id}/${crypto.randomUUID()}/${filename}`,bytes:file.bytes,contentType:mime,filename,visibility});
  try {
    return await withSystem(async (db) => {
      const inserted = await db.query<{id:string}>("insert into support_attachments(org_id,ticket_id,private_file_id,visibility,created_by) values($1,$2,$3,$4,$5) returning id",[ticket.org_id,ticketId,stored.id,visibility,userId]);
      await recordAudit({orgId:ticket.org_id,actorKind:ticket.staff?"agency":"user",actorUserId:userId,action:"support.attachment_added",targetType:"support_ticket",targetId:ticketId,result:"success",metadata:{visibility,size:file.bytes.length}},db);
      return {id:inserted.rows[0].id,filename};
    });
  } catch(error) {
    await removePrivateFile({userId,orgId:ticket.org_id,bucket:stored.bucket,path:stored.storageKey}).catch(()=>undefined);
    throw error;
  }
}
export async function supportAttachmentDownload(userId:string,id:string) {
  const file = await withUser(userId,async (db) => (await db.query<{org_id:string;storage_key:string}>(
    "select a.org_id,f.storage_key from support_attachments a join private_files f on f.id=a.private_file_id where a.id=$1",[id],
  )).rows[0]);
  if (!file) throw new AppError("not_found","Attachment not found.");
  return signPrivateFile({userId,orgId:file.org_id,bucket:"support-attachments",path:file.storage_key});
}
