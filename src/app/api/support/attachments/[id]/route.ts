import { NextResponse } from "next/server";
import { requireUserOrThrow } from "@/server/auth/session";
import { supportAttachmentDownload } from "@/server/support/attachments";
import { toPublicError } from "@/server/errors";
export const dynamic="force-dynamic";
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}) {
  try {
    const user=await requireUserOrThrow();const {id}=await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({error:"Attachment not found."},{status:404});
    const url=await supportAttachmentDownload(user.id,id);
    const response=NextResponse.redirect(new URL(url,req.url));
    response.headers.set("Cache-Control","private, no-store");return response;
  } catch(error) {
    const e=toPublicError(error);return NextResponse.json({error:e.message},{status:e.status});
  }
}
