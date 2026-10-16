import { NextResponse,type NextRequest } from "next/server";
import { z } from "zod";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { listIntegrationManager,saveIntegrationConnection,testIntegrationConnection,disconnectIntegration,integrationSaveSchema,mapAgencyWorkflows,syncGhlMetadata,mapGhlAssets,listLlmModels } from "@/server/integrations/manager";
import { AppError,toPublicError } from "@/server/errors";
import { INTEGRATION_PROVIDERS } from "@/lib/integrations";
import { env } from "@/server/env";
import { consumeRateLimit } from "@/server/security/rate-limit";

export const dynamic="force-dynamic";
export const runtime="nodejs";
function scope(req:NextRequest) {
  const id=req.nextUrl.searchParams.get("orgId");
  if(id && !z.string().uuid().safeParse(id).success)throw new AppError("invalid_input","Invalid client identifier.");
  return id || null;
}
const response=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{"Cache-Control":"private, no-store"}});
function failure(error:unknown) {
  if(error instanceof z.ZodError)return response({error:"Check the connection fields. Only approved read permissions and supported configuration fields are accepted."},400);
  const e=toPublicError(error);return response({error:e.message,code:e.code},e.status);
}
export async function GET(req:NextRequest) {
  try {const user=await requireAgencyOrThrow();return response(await listIntegrationManager(user,scope(req)));}catch(error){return failure(error);}
}
export async function POST(req:NextRequest) {
  try {
    const user=await requireAgencyOrThrow("super_admin");
    const origin=req.headers.get("origin");
    if(!origin || new URL(origin).origin!==new URL(env().APP_URL).origin)throw new AppError("forbidden","Connection changes must come from the portal.");
    if(env().NODE_ENV==="production" && !env().APP_URL.startsWith("https://"))throw new AppError("forbidden","Secure HTTPS submission is required.");
    if(Number(req.headers.get("content-length") ?? 0)>20_000)throw new AppError("invalid_input","Connection request is too large.");
    const limit=await consumeRateLimit({name:"integration-admin",limit:20,windowSeconds:60},user.id);
    if(!limit.allowed)throw new AppError("rate_limited","Wait a moment before testing another connection.");
    const body:unknown=await req.json();const action=z.object({action:z.enum(["save","test","disconnect","map_workflows","sync_metadata","map_ghl_assets","list_models"])}).passthrough().parse(body);
    const orgId=scope(req);
    if(action.action==="list_models"){const d=z.object({baseUrl:z.string().max(500),apiFormat:z.enum(["openai","anthropic"]),secret:z.string().trim().max(4096).optional()}).parse(body);return response({ok:true,models:await listLlmModels(user,d)});}
    if(action.action==="sync_metadata")return response({ok:true,result:await syncGhlMetadata(user,orgId)});
    if(action.action==="map_ghl_assets"){if(!orgId)throw new AppError("invalid_input","Select a client first.");const d=z.object({pipelineId:z.string().nullish(),calendarIds:z.array(z.string()).max(20).optional()}).parse(body);await mapGhlAssets(user,orgId,{pipelineId:d.pipelineId,calendarIds:d.calendarIds});return response({ok:true});}
    if(action.action==="map_workflows"){if(!orgId)throw new AppError("invalid_input","Select a client for workflow mapping.");const d=z.object({workflowIds:z.array(z.string())}).parse(body);await mapAgencyWorkflows(user,orgId,d.workflowIds);return response({ok:true});}
    if(action.action==="save") {const d=z.object({input:integrationSaveSchema}).parse(body);const gatewayId=await saveIntegrationConnection(user,orgId,d.input);return response({ok:true,...(typeof gatewayId==="string"?{gatewayId}:{})});}
    const d=z.object({provider:z.enum(INTEGRATION_PROVIDERS),gatewayId:z.string().uuid().optional()}).parse(body);
    if(action.action==="test")return response({ok:true,result:await testIntegrationConnection(user,orgId,d.provider,d.gatewayId)});
    await disconnectIntegration(user,orgId,d.provider,d.gatewayId);return response({ok:true});
  }catch(error){return failure(error);}
}
