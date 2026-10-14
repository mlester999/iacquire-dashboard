import { NextResponse } from "next/server";
import { assertSameOrigin, requireUserOrThrow } from "@/server/auth/session";
import { attachSupportFile } from "@/server/support/attachments";
import { toPublicError } from "@/server/errors";
export const dynamic = "force-dynamic";
export async function POST(req:Request,{params}:{params:Promise<{ticketId:string}>}) {
  try {
    await assertSameOrigin();
    const user = await requireUserOrThrow();
    const {ticketId} = await params;
    if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return NextResponse.json({error:"Request not found."},{status:404});
    if (Number(req.headers.get("content-length")??0)>10*1024*1024+65536) return NextResponse.json({error:"Files can be up to 10 MB."},{status:413});
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size>10*1024*1024) return NextResponse.json({error:"Choose a supported file up to 10 MB."},{status:400});
    const saved = await attachSupportFile(user.id,ticketId,{name:file.name,bytes:Buffer.from(await file.arrayBuffer())},form.get("internal")==="true");
    return NextResponse.json(saved,{headers:{"Cache-Control":"private, no-store"}});
  } catch(error) {
    const e=toPublicError(error);return NextResponse.json({error:e.message},{status:e.status});
  }
}
