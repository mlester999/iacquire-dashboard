import { NextResponse } from "next/server";
import { setupRealtimeToken } from "@/server/setup/realtime";
import { toPublicError } from "@/server/errors";
export const dynamic="force-dynamic";
export async function GET(req:Request) {
  const headers={"Cache-Control":"private, no-store, max-age=0","Vary":"Cookie","X-Content-Type-Options":"nosniff"};
  try {
    return NextResponse.json(await setupRealtimeToken(new URL(req.url).searchParams.get("orgId")??""),{headers});
  } catch(error) {
    const e=toPublicError(error);return NextResponse.json({error:e.message},{status:e.status,headers});
  }
}
