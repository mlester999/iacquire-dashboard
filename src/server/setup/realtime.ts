import "server-only";
import { withUser } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { requireFreshUserOrThrow } from "@/server/auth/session";
import { createSupabaseAdminClient,createSupabaseServerClient } from "@/server/supabase/clients";
import { requireSupabasePublic } from "@/server/supabase/config";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verified user access JWT for private Realtime. No service key or refresh token is returned. */
export async function setupRealtimeToken(orgId:string) {
  if (env().AUTH_PROVIDER!=="supabase") throw new AppError("not_found","Supabase Realtime is not enabled in local demo mode.");
  if (!UUID.test(orgId)) throw new AppError("invalid_input","Invalid setup organization.");
  const user=await requireFreshUserOrThrow();
  const allowed=await withUser(user.id,async(db)=>(await db.query<{allowed:boolean}>("select app.has_permission($1,'setup.view') as allowed",[orgId])).rows[0]?.allowed);
  if (!allowed) throw new AppError("forbidden","You don't have access to this setup.");
  const client=await createSupabaseServerClient();
  const verified=await client.auth.getClaims();
  if (verified.error || !verified.data?.claims?.sub) throw new AppError("unauthenticated","Your session has ended.");
  const claims=verified.data.claims;
  // A session is read only after claims and an active mapped account have both been validated.
  const result=await client.auth.getSession();
  const session=result.data.session;
  if (result.error || !session || session.user.id!==claims.sub || !session.access_token || !session.expires_at || session.expires_at<=Math.floor(Date.now()/1000)) {
    throw new AppError("unauthenticated","Your session has ended.");
  }
  const config=requireSupabasePublic();
  return {url:config.url,publishableKey:config.publishableKey,accessToken:session.access_token,expiresAt:session.expires_at,channel:`setup:${orgId}`};
}

/** Only revision signals are published, after commit. Snapshots remain server-authorized. */
export async function publishSetupRevision(orgId:string,revision:number): Promise<boolean> {
  if (env().AUTH_PROVIDER!=="supabase" || !UUID.test(orgId) || !Number.isSafeInteger(revision) || revision<1) return false;
  let client: ReturnType<typeof createSupabaseAdminClient>|undefined;
  let channel: ReturnType<ReturnType<typeof createSupabaseAdminClient>["channel"]>|undefined;
  try {
    client=createSupabaseAdminClient();
    channel=client.channel(`setup:${orgId}`,{config:{private:true}});
    const result=await channel.httpSend("revision",{revision},{timeout:3000});
    return result.success;
  } catch { return false; } // Old/unavailable Realtime servers keep the existing SSE/polling fallback.
  finally {if(client&&channel)await client.removeChannel(channel).catch(()=>undefined);}
}
