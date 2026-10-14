import "server-only";
import { z } from "zod";
import { withSystem,withUser,type Queryable } from "@/server/db";
import type { SessionUser } from "@/server/auth/service";
import { AppError } from "@/server/errors";
import { assertAgencyAccess } from "@/server/setup/core";
import { recordAudit } from "@/server/audit";
import { saveCredential,resolveCredential,revokeCredential,credentialStoreReady } from "@/server/security/credentials";
import { validateIntegrationEndpoint,validateLlmEndpoint } from "@/server/integrations/safety";
import { inspectGhl,inspectHermes,inspectN8n,inspectLlm,fetchLlmModels,GHL_READ_SCOPES,type Inspection } from "@/server/integrations/inspection";
import { assertAssignableLocation,setIntegrationStatus } from "@/server/admin/tenants";
import { isReservedProfile } from "@/server/workforce/service";
import { INTEGRATION_PROVIDERS,INTEGRATION_NAMES,LLM_PRESET_IDS,type IntegrationProvider,type IntegrationState,type IntegrationView } from "@/lib/integrations";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { env } from "@/server/env";
import { invalidateLlmConfig } from "@/server/llm/client";
import { supabaseConfigStatus } from "@/server/supabase/config";
import { createSupabaseAdminClient } from "@/server/supabase/clients";

const date=(v:Date|string|null)=>v?new Date(v).toISOString():null;
async function authorize(user:SessionUser,orgId:string|null,write=false) {
  const {rows}=await withSystem(db=>db.query<{platform_role:SessionUser["platformRole"]}>("select platform_role from users where id=$1 and status='active'",[user.id]));
  const role=rows[0]?.platform_role;
  if(!role || role==="none")throw new AppError("forbidden","Agency access is required.");
  if(write && role!=="agency_super_admin") throw new AppError("forbidden","Only agency super admins can configure, test or revoke service credentials.");
  if(orgId) await assertAgencyAccess({...user,platformRole:role},orgId,write?"super_admin":"staff");
  else if(role!=="agency_super_admin") throw new AppError("forbidden","Global infrastructure settings require agency super admin access.");
  return role;
}
type ConnectionRow={id:string;org_id:string|null;provider:IntegrationProvider;label:string;environment:string;config:Record<string,unknown>;credential_id:string|null;status:IntegrationState;last_success_at:Date|null;last_failure_at:Date|null;last_error:string|null;capabilities:Record<string,unknown>;revision:number;};

export const integrationSaveSchema=z.object({
  provider:z.enum(["hermes","ghl","n8n","llm"]),label:z.string().trim().min(2).max(120),environment:z.enum(["development","staging","production"]),
  secret:z.string().trim().min(16).max(4096).optional(),
  config:z.object({baseUrl:z.string().max(500).optional(),profile:z.string().regex(/^[a-z0-9][a-z0-9_-]{1,62}$/).optional(),roleKey:z.enum(AGENT_ROLE_KEYS).optional(),gatewayType:z.enum(["profile_gateway","single_profile"]).optional(),locationId:z.string().regex(/^[A-Za-z0-9]{10,40}$/).optional(),authMethod:z.enum(["bearer","private_integration","api_key"]).optional(),apiVersion:z.enum(["v3","2021-07-28"]).optional(),pipelineId:z.string().regex(/^[A-Za-z0-9]{10,40}$/).optional(),calendarIds:z.array(z.string().regex(/^[A-Za-z0-9]{10,40}$/)).max(20).optional(),scopes:z.array(z.enum(GHL_READ_SCOPES)).max(10).optional(),approvedWorkflowIds:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).max(40).optional(),declaredVersion:z.string().trim().max(80).optional(),declaredEdition:z.enum(["unknown","community","enterprise"]).optional(),llmPreset:z.enum(LLM_PRESET_IDS).optional(),apiFormat:z.enum(["openai","anthropic"]).optional(),model:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,119}$/,"Enter a valid model name.").optional()}).strict(),
}).strict();
export type IntegrationSaveInput=z.input<typeof integrationSaveSchema>;

export async function listIntegrationManager(user:SessionUser,orgId:string|null):Promise<{connections:IntegrationView[];secureStoreReady:boolean;agencyWorkflows:Array<{id:string;name:string}>;mappedWorkflowIds:string[]}> {
  const role=await authorize(user,orgId);
  const rows=await withUser(user.id,db=>db.query<ConnectionRow>("select * from integration_connections where org_id is not distinct from $1::uuid order by provider",[orgId])).then(r=>r.rows);
  const meta=await withSystem(db=>db.query<{id:string;fingerprint:string;rotated_at:Date|null;revoked_at:Date|null}>("select c.id,c.fingerprint,r.rotated_at,c.revoked_at from integration_credentials c left join credential_references r on r.id=c.credential_reference_id where c.org_id is not distinct from $1::uuid",[orgId]));
  const checks=await withUser(user.id,db=>db.query<{connection_id:string;status:string;detail:string;verification_mode:string;capabilities:Record<string,unknown>;checked_at:Date}>("select k.connection_id,k.status,k.detail,k.verification_mode,k.capabilities,k.checked_at from integration_connection_checks k join integration_connections c on c.id=k.connection_id where c.org_id is not distinct from $1::uuid order by checked_at desc limit 80",[orgId]));
  const secureStoreReady=await withSystem(credentialStoreReady);
  const mappedWorkflowIds=orgId ? (await withUser(user.id,db=>db.query<{workflow_id:string}>("select workflow_id from automation_template_mappings where org_id=$1",[orgId]))).rows.map(m=>m.workflow_id) : [];
  const agencyWorkflows=orgId && role==="agency_super_admin" ? await withSystem(async db=>{
    const global=(await db.query<ConnectionRow>("select * from integration_connections where org_id is null and provider='n8n' and status in('connected','permission_limited')")).rows[0];
    const w=global?.capabilities.approvedWorkflows;
    return Array.isArray(w) ? w.filter((v):v is {id:string;name:string}=>!!v && typeof v==="object" && typeof v.id==="string" && typeof v.name==="string").map(v=>({id:v.id,name:v.name})) : [];
  }) : [];
  const mappedN8n=orgId && mappedWorkflowIds.length ? (await withUser(user.id,db=>db.query<{status:string;detail:string|null;last_checked_at:Date|null}>("select status,detail,last_checked_at from integration_status where org_id=$1 and provider='n8n'",[orgId]))).rows[0] : null;
  return {secureStoreReady,agencyWorkflows,mappedWorkflowIds,connections:INTEGRATION_PROVIDERS.filter(p=>p!=="llm" || !orgId).map(provider=>{
    const r=rows.find(c=>c.provider===provider); const cred=meta.rows.find(c=>c.id===r?.credential_id);
    const mapped=provider==="n8n" && mappedN8n && !r;
    return {id:r?.id ?? null,provider,label:r?.label ?? INTEGRATION_NAMES[provider],environment:r?.environment ?? "development",status:r?.status ?? (mapped ? mappedN8n.status==="connected" ? "connected" : mappedN8n.status==="disabled" ? "disconnected" : mappedN8n.status==="error" ? "needs_attention" : "credentials_saved" : provider==="supabase" && !orgId && supabaseConfigStatus().configured ? "credentials_saved" : "not_configured"),config:r?.config ?? (mapped?{agencyManaged:true,approvedWorkflowIds:mappedWorkflowIds}:{}),capabilities:r?.capabilities ?? {},lastSuccessAt:date(r?.last_success_at ?? (mapped && mappedN8n.status==="connected"?mappedN8n.last_checked_at:null)),lastFailureAt:date(r?.last_failure_at ?? (mapped && mappedN8n.status==="error"?mappedN8n.last_checked_at:null)),lastError:r?.last_error ?? (mapped && ["error","disabled"].includes(mappedN8n.status)?mappedN8n.detail:null),fingerprint:cred?.fingerprint ?? null,rotatedAt:date(cred?.rotated_at ?? null),hasCredential:!!cred && !cred.revoked_at,checks:checks.rows.filter(c=>c.connection_id===r?.id).slice(0,8).map(c=>({status:c.status,detail:c.detail,mode:c.verification_mode,operation:typeof c.capabilities.verificationOperation==="string"?c.capabilities.verificationOperation:c.capabilities.verification==="one_token_completion"?"basic_model_response":c.capabilities.verification==="model_list"?"model_listing":undefined,at:date(c.checked_at)!}))};
  })};
}

async function existing(db:Queryable,orgId:string|null,provider:IntegrationProvider) {
  return (await db.query<ConnectionRow>("select * from integration_connections where org_id is not distinct from $1::uuid and provider=$2 for update",[orgId,provider])).rows[0];
}
async function refreshSetup(orgId:string|null) {
  const {reconcileSetupAutomation}=await import("@/server/setup/automation");
  if(orgId)await reconcileSetupAutomation(orgId);
  else {
    const {rows}=await withSystem(db=>db.query<{org_id:string}>("select distinct org_id from automation_template_mappings"));
    for(const row of rows)await reconcileSetupAutomation(row.org_id);
  }
}
export async function saveIntegrationConnection(user:SessionUser,orgId:string|null,input:IntegrationSaveInput) {
  await authorize(user,orgId,true);
  const d=integrationSaveSchema.parse(input); const config=d.config;
  if(d.provider==="llm") {
    if(orgId)throw new AppError("invalid_input","The AI model connection is agency-wide, not per client.");
    if(!config.baseUrl)throw new AppError("invalid_input","Enter the model provider base URL.");
    if(!config.model || !config.apiFormat)throw new AppError("invalid_input","Choose the model and API format.");
    config.baseUrl=validateLlmEndpoint(config.baseUrl);
  }
  else if(d.provider!=="ghl") {if(!config.baseUrl)throw new AppError("invalid_input","Enter the service endpoint."); config.baseUrl=validateIntegrationEndpoint(config.baseUrl);}
  if(d.provider==="hermes" && !config.profile)throw new AppError("invalid_input","Enter the intended gateway profile.");
  if(d.provider==="ghl" && (!orgId || !config.locationId))throw new AppError("invalid_input","Select a client and enter its GHL location identifier.");
  await withSystem(async db=>{
    const old=await existing(db,orgId,d.provider);let credentialId=old?.credential_id ?? null;
    let kind:"agency"|"client"="agency";
    if(orgId) {const {rows}=await db.query<{kind:"agency"|"client"}>("select kind from organizations where id=$1",[orgId]); if(!rows[0])throw new AppError("not_found","Client organization not found.");kind=rows[0].kind;}
    let agent:{id:string;credential_id:string|null}|undefined;
    if(d.provider==="hermes" && orgId) {
      if(kind==="client" && isReservedProfile(config.profile!))throw new AppError("forbidden","Clients require dedicated profiles. Agency profiles cannot be reused.");
      if(!config.roleKey)throw new AppError("invalid_input","Select the AI employee this profile belongs to.");
      agent=(await db.query<{id:string;credential_id:string|null}>("select id,credential_id from agent_instances where org_id=$1 and role_key=$2",[orgId,config.roleKey])).rows[0];
      if(!agent)throw new AppError("not_found","AI employee not found.");
      const dupe=await db.query("select 1 from agent_instances where hermes_base_url=$1 and hermes_profile=$2 and id<>$3",[config.baseUrl,config.profile,agent.id]);
      if(dupe.rows.length)throw new AppError("conflict","That profile already belongs to another employee.");
      credentialId=agent.credential_id;
    }
    if(d.provider==="ghl") {
      assertAssignableLocation(config.locationId!,kind);
      const {rows}=await db.query("select 1 from ghl_location_mappings where location_id=$1 and org_id<>$2",[config.locationId,orgId]);
      if(rows.length)throw new AppError("conflict","This GHL location is already assigned to another tenant.");
      const mapping=(await db.query<{credential_id:string|null}>("select credential_id from ghl_location_mappings where org_id=$1",[orgId])).rows[0];
      credentialId=mapping?.credential_id ?? credentialId;
    }
    if(d.secret)credentialId=(await saveCredential(db,{orgId,provider:d.provider,label:d.label,secret:d.secret,scopes:config.scopes,actorId:user.id,replaces:credentialId})).id;
    if(!credentialId)throw new AppError("invalid_input","Add a credential before saving the connection.");
    const credential=(await db.query<{active:boolean}>("select c.org_id is not distinct from $2::uuid and c.provider=$3 and c.revoked_at is null and (c.credential_reference_id is null or r.revoked_at is null) as active from integration_credentials c left join credential_references r on r.id=c.credential_reference_id where c.id=$1",[credentialId,orgId,d.provider])).rows[0];
    if(!credential?.active)throw new AppError("invalid_input","Add a new credential before reconnecting this service.");
    await db.query(`insert into integration_connections(org_id,provider,label,environment,config,credential_id,status,created_by)
      values($1,$2,$3,$4,$5,$6,'credentials_saved',$7)
      on conflict(coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid),provider) do update set label=excluded.label,environment=excluded.environment,config=excluded.config,credential_id=excluded.credential_id,status='credentials_saved',capabilities='{}',last_error=null,revision=integration_connections.revision+1`,[orgId,d.provider,d.label,d.environment,JSON.stringify(config),credentialId,user.id]);
    if(agent)await db.query("update agent_instances set hermes_base_url=$2,hermes_profile=$3,credential_id=$4,status='provisioning',last_health_ok=null,last_health_check_at=null,last_health_detail='Credentials saved. Live verification required.' where id=$1",[agent.id,config.baseUrl,config.profile,credentialId]);
    if(d.provider==="ghl")await db.query(`insert into ghl_location_mappings(org_id,location_id,pipeline_id,calendar_ids,credential_id,status,created_by) values($1,$2,$3,$4,$5,'pending',$6)
      on conflict(org_id) do update set location_id=excluded.location_id,pipeline_id=excluded.pipeline_id,calendar_ids=excluded.calendar_ids,credential_id=excluded.credential_id,status='pending',verified_at=null`,[orgId,config.locationId,config.pipelineId ?? null,config.calendarIds ?? [],credentialId,user.id]);
    await setIntegrationStatus(db,orgId,d.provider,"pending","Credentials saved. A real connection test is required.");
    if(d.provider==="n8n" && !orgId) {
      const global=await existing(db,null,"n8n");
      await invalidateMappedN8n(db,global.id,"pending","Agency connection changed. Client verification required.");
    }
    await recordAudit({orgId,actorUserId:user.id,actorKind:"agency",action:"integration.configuration_saved",result:"success",metadata:{provider:d.provider}},db);
  });
  invalidateLlmConfig();
  if(d.provider!=="llm")await refreshSetup(orgId);
}

export async function testIntegrationConnection(user:SessionUser,orgId:string|null,provider:IntegrationProvider):Promise<Inspection> {
  await authorize(user,orgId,true);
  if(provider==="n8n" && orgId) {
    const tenantConnection=await withSystem(db=>existing(db,orgId,provider));
    if(!tenantConnection)return testMappedN8nConnection(user,orgId);
  }
  if(provider==="supabase") {
    if(orgId || !supabaseConfigStatus().configured || env().DATABASE_DRIVER!=="postgres")throw new AppError("integration_unavailable","Configure the approved Supabase Auth project and PostgreSQL connection in secure server settings before testing.");
    await withSystem(db=>db.query("insert into integration_connections(org_id,provider,label,config,status,created_by) values(null,'supabase','Supabase foundation',$1,'credentials_saved',$2) on conflict(coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid),provider) do nothing",[JSON.stringify({endpoint:supabaseConfigStatus().url}),user.id]));
  }
  const r=await withSystem(async db=>{const r=await existing(db,orgId,provider);if(!r || (provider!=="supabase" && !r.credential_id) || r.status==="disconnected")throw new AppError("integration_unavailable","Save secure credentials before testing this connection.");if(r.status==="testing")throw new AppError("conflict","A connection test is already running. If the server was interrupted, save the configuration to reset the test.");await db.query("update integration_connections set status='testing' where id=$1",[r.id]);return r;});
  let result:Inspection;
  try {
    const secret=provider==="supabase" ? null : await withSystem(db=>resolveCredential(db,r.credential_id!,orgId,provider));
    if(provider!=="supabase" && !secret)throw new AppError("integration_unavailable","The stored credential is revoked or unavailable.");
    const cfg=r.config;
    if(provider==="supabase") {
      const {rows}=await withSystem(db=>db.query<{auth_user_id:string|null}>("select auth_user_id from users where id=$1",[user.id]));
      if(!rows[0]?.auth_user_id)throw new AppError("integration_unavailable","Your profile is not linked to Supabase Auth. Complete account migration before verifying the foundation.");
      const client=createSupabaseAdminClient();const auth=await client.auth.admin.getUserById(rows[0].auth_user_id);const storage=await client.storage.listBuckets();
      if(auth.error || auth.data.user?.id!==rows[0].auth_user_id || storage.error)throw new AppError("upstream_error","Supabase Auth or Storage could not be verified.");
      const required=["company-documents","support-attachments","project-files"];const buckets=storage.data ?? [];
      const privateBuckets=required.every(name=>buckets.some(b=>b.id===name && !b.public));
      result={status:privateBuckets ? "connected" : "needs_attention",detail:privateBuckets ? "Supabase Auth identity, PostgreSQL profile persistence and required private Storage buckets verified." : "Supabase Auth responds, but required private Storage buckets are missing or public.",capabilities:{authIdentityVerified:true,postgresqlReadVerified:true,privateBucketsVerified:privateBuckets,realtime:"independent_scoped_subscription_test_required"}};
    }
    else if(provider==="hermes")result=await inspectHermes({baseUrl:String(cfg.baseUrl),profile:String(cfg.profile),apiKey:secret!},!!orgId);
    else if(provider==="ghl")result=await inspectGhl({locationId:String(cfg.locationId),token:secret!,orgKind:"client",version:cfg.apiVersion==="v3" ? "v3" : "2021-07-28"},Array.isArray(cfg.scopes)?cfg.scopes as string[]:["locations.readonly","opportunities.readonly"]);
    else if(provider==="llm")result=await inspectLlm({baseUrl:String(cfg.baseUrl),model:String(cfg.model),format:cfg.apiFormat==="anthropic" ? "anthropic" : "openai",apiKey:secret!});
    else if(provider==="n8n")result=await inspectN8n({baseUrl:String(cfg.baseUrl),apiKey:secret!},Array.isArray(cfg.approvedWorkflowIds)?cfg.approvedWorkflowIds as string[]:[]);
    else throw new AppError("integration_unavailable","This provider requires a supported authorization or DNS verification connection.");
    // Even an upstream response reflecting its key must not reach persistence or browser output.
    if(secret)result=JSON.parse(JSON.stringify(result).split(secret).join("[redacted]")) as Inspection;
  } catch(error) {result={status:"error",detail:error instanceof AppError ? error.message : "The service could not be verified. Check its endpoint, credential and installed API compatibility.",capabilities:provider==="llm"?{verificationOperation:"model_listing",safeReadOnlyTest:true}:{}};}
  await withSystem(async db=>{
    const current=await existing(db,orgId,provider);
    if(!current || current.revision!==r.revision)throw new AppError("conflict","The configuration changed while this test was running. Test the current configuration again.");
    await db.query("insert into integration_connection_checks(connection_id,connection_revision,status,detail,capabilities,verification_mode,checked_by) values($1,$2,$3,$4,$5,$6,$7)",[r.id,r.revision,result.status,result.detail,JSON.stringify(result.capabilities),process.env.NODE_ENV==="test" ? "mock" : "live_read_only",user.id]);
    await db.query("update integration_connections set status=$2,capabilities=$3,last_success_at=case when $2='connected' then now() else last_success_at end,last_failure_at=case when $2<>'connected' then now() else last_failure_at end,last_error=case when $2='connected' then null else $4 end where id=$1",[r.id,result.status,JSON.stringify(result.capabilities),result.detail]);
    await setIntegrationStatus(db,orgId,provider==="supabase" ? "database" : provider,result.status==="connected" ? "connected" : result.status==="permission_limited" ? "degraded" : "error",result.detail);
    if(provider==="n8n" && !orgId && result.status!=="connected")await invalidateMappedN8n(db,r.id,"error","Agency connection verification requires attention.");
    if(provider==="ghl")await db.query("update ghl_location_mappings set status=$2,verified_at=case when $2='connected' then now() else null end where org_id=$1",[orgId,result.capabilities.locationIdentityVerified ? "connected" : "error"]);
    await recordAudit({orgId,actorUserId:user.id,actorKind:"agency",action:"integration.connection_tested",targetType:"integration",targetId:r.id,result:result.status==="connected" ? "success" : "failure",metadata:{provider,status:result.status,mode:process.env.NODE_ENV==="test" ? "mock" : result.capabilities.verificationOperation==="basic_model_response" ? "live_minimal_model_response" : "live_read_only",verificationOperation:result.capabilities.verificationOperation ?? "read_only"}},db);
  });
  invalidateLlmConfig();
  if(provider!=="llm")await refreshSetup(orgId);
  return result;
}

const GHL_VERIFIED=["connected","permission_limited"];
type GhlInventory=Record<string,Array<{id?:unknown}>>;
function ghlInventory(row:ConnectionRow|undefined):GhlInventory|null {
  const inv=row?.capabilities.inventory;
  return inv && typeof inv==="object" && !Array.isArray(inv) ? inv as GhlInventory : null;
}

/**
 * Re-reads reference metadata (ids and names only) with the already-verified read-only access, and
 * stamps when it happened. It repeats the real location-identity check, so it can never "sync"
 * through a location mismatch, and it is refused until a successful connection test exists.
 */
export async function syncGhlMetadata(user:SessionUser,orgId:string|null):Promise<Inspection&{syncedAt:string|null}> {
  if(!orgId)throw new AppError("invalid_input","Select a client before syncing CRM metadata.");
  await authorize(user,orgId,true);
  const current=await withSystem(db=>existing(db,orgId,"ghl"));
  if(!current?.credential_id || !GHL_VERIFIED.includes(current.status))throw new AppError("integration_unavailable","Run a successful read-only connection test before syncing CRM metadata.");
  const result=await testIntegrationConnection(user,orgId,"ghl");
  if(!GHL_VERIFIED.includes(result.status))return {...result,syncedAt:null};
  const syncedAt=new Date().toISOString();
  await withSystem(async db=>{
    await db.query("update integration_connections set capabilities=capabilities||jsonb_build_object('metadataSyncedAt',$2::text) where org_id=$1 and provider='ghl'",[orgId,syncedAt]);
    await recordAudit({orgId,actorUserId:user.id,actorKind:"agency",action:"integration.metadata_synced",targetType:"integration",targetId:current.id,result:"success",metadata:{provider:"ghl",permissions:result.capabilities.provenReadPermissions}},db);
  });
  return {...result,capabilities:{...result.capabilities,metadataSyncedAt:syncedAt},syncedAt};
}

/**
 * Saves the optional pipeline and calendar mapping. Only identifiers present in the verified
 * location inventory are accepted, so a typed or forged identifier cannot reach another location.
 * This records preparation only: it never writes to GoHighLevel.
 */
export async function mapGhlAssets(user:SessionUser,orgId:string,input:{pipelineId?:string|null;calendarIds?:string[]}) {
  await authorize(user,orgId,true);
  const idPattern=z.string().regex(/^[A-Za-z0-9]{10,40}$/);
  const d=z.object({pipelineId:idPattern.nullish(),calendarIds:z.array(idPattern).max(20).default([])}).strict().parse(input);
  await withSystem(async db=>{
    const r=await existing(db,orgId,"ghl");
    if(!r || !GHL_VERIFIED.includes(r.status))throw new AppError("integration_unavailable","Verify the connection before mapping CRM assets.");
    const inv=ghlInventory(r);
    if(!inv)throw new AppError("integration_unavailable","Sync CRM metadata before choosing a pipeline or calendars.");
    const has=(kind:string,id:string)=>(inv[kind] ?? []).some(x=>x.id===id);
    if(d.pipelineId && !has("pipelines",d.pipelineId))throw new AppError("invalid_input","That pipeline was not found in this location's verified metadata.");
    const missing=d.calendarIds.filter(id=>!has("calendars",id));
    if(missing.length)throw new AppError("invalid_input","A selected calendar was not found in this location's verified metadata.");
    const config:Record<string,unknown>={...r.config,calendarIds:d.calendarIds};
    if(d.pipelineId)config.pipelineId=d.pipelineId;else delete config.pipelineId;
    await db.query("update integration_connections set config=$2 where id=$1",[r.id,JSON.stringify(config)]);
    await db.query("update ghl_location_mappings set pipeline_id=$2,calendar_ids=$3 where org_id=$1",[orgId,d.pipelineId ?? null,d.calendarIds]);
    await recordAudit({orgId,actorUserId:user.id,actorKind:"agency",action:"integration.ghl_assets_mapped",targetType:"integration",targetId:r.id,result:"success",metadata:{pipeline:!!d.pipelineId,calendars:d.calendarIds.length}},db);
  });
  await refreshSetup(orgId);
}

export async function mapAgencyWorkflows(user:SessionUser,orgId:string,workflowIds:string[]) {
  await authorize(user,orgId,true);
  const ids=z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).max(40).parse(workflowIds);
  await withSystem(async db=>{
    const global=await existing(db,null,"n8n");
    if(!global || !["connected","permission_limited"].includes(global.status))throw new AppError("integration_unavailable","Verify the agency n8n connection and its approved inventory first.");
    const approved=Array.isArray(global.config.approvedWorkflowIds) ? global.config.approvedWorkflowIds as string[] : [];
    const inventory=Array.isArray(global.capabilities.approvedWorkflows) ? global.capabilities.approvedWorkflows as Array<{id:string}> : [];
    if(ids.some(id=>!approved.includes(id) || !inventory.some(w=>w.id===id)))throw new AppError("forbidden","Only workflows from the verified agency approval list can be mapped.");
    const taken=await db.query("select 1 from automation_template_mappings where global_connection_id=$1 and workflow_id=any($2::text[]) and org_id<>$3",[global.id,ids,orgId]);
    if(taken.rows.length)throw new AppError("conflict","A workflow already belongs to another client. Create a dedicated approved instance before mapping it.");
    await db.query("delete from automation_template_mappings where org_id=$1 and not(workflow_id=any($2::text[]))",[orgId,ids]);
    for(const id of ids)await db.query("insert into automation_template_mappings(org_id,global_connection_id,workflow_id,created_by) values($1,$2,$3,$4) on conflict(org_id,workflow_id) do update set status='unverified',last_verified_at=null,last_error=null",[orgId,global.id,id,user.id]);
    await setIntegrationStatus(db,orgId,"n8n",ids.length?"pending":"not_configured",ids.length?"Approved workflows mapped. Run client verification.":"No agency workflows mapped.");
    await recordAudit({orgId,actorUserId:user.id,actorKind:"agency",action:"integration.workflows_mapped",result:"success",metadata:{workflowIds:ids}},db);
  });await refreshSetup(orgId);
}
async function testMappedN8nConnection(user:SessionUser,orgId:string):Promise<Inspection> {
  const {global,ids}=await withSystem(async db=>{
    const global=await existing(db,null,"n8n"); const mappings=await db.query<{workflow_id:string}>("select workflow_id from automation_template_mappings where org_id=$1 and global_connection_id=$2",[orgId,global?.id ?? null]);
    if(!global?.credential_id || global.status==="disconnected" || !mappings.rows.length)throw new AppError("integration_unavailable","Map approved agency workflows before testing this client.");
    return {global,ids:mappings.rows.map(m=>m.workflow_id)};
  });
  let result:Inspection;
  try {
    const allowed=Array.isArray(global.config.approvedWorkflowIds)?global.config.approvedWorkflowIds as string[]:[];
    if(ids.some(id=>!allowed.includes(id)))throw new AppError("forbidden","A mapped workflow is no longer agency-approved.");
    const secret=await withSystem(db=>resolveCredential(db,global.credential_id!,null,"n8n"));
    if(!secret)throw new AppError("integration_unavailable","The agency credential is unavailable.");
    result=await inspectN8n({baseUrl:String(global.config.baseUrl),apiKey:secret},ids);
    result.capabilities.workflows=result.capabilities.approvedWorkflows;
    result=JSON.parse(JSON.stringify(result).split(secret).join("[redacted]")) as Inspection;
  }catch(error){result={status:"error",detail:error instanceof AppError?error.message:"Approved workflow verification failed.",capabilities:{}};}
  await withSystem(async db=>{
    const current=await existing(db,null,"n8n");if(current?.revision!==global.revision)throw new AppError("conflict","Agency credentials changed during the test. Run it again.");
    const mappings=await db.query<{workflow_id:string}>("select workflow_id from automation_template_mappings where org_id=$1 and global_connection_id=$2 for update",[orgId,global.id]);
    const currentIds=mappings.rows.map(m=>m.workflow_id).sort();
    if(JSON.stringify(currentIds)!==JSON.stringify([...ids].sort()))throw new AppError("conflict","Client workflow mappings changed during the test. Run verification again.");
    await db.query("update automation_template_mappings set status=$2,last_verified_at=case when $2='verified' then now() else null end,last_error=case when $2='verified' then null else $3 end where org_id=$1 and global_connection_id=$4 and workflow_id=any($5::text[])",[orgId,result.status==="connected"?"verified":"needs_attention",result.detail,global.id,ids]);
    await setIntegrationStatus(db,orgId,"n8n",result.status==="connected"?"connected":"error",result.detail);
    await recordAudit({orgId,actorUserId:user.id,actorKind:"agency",action:"integration.mapped_workflows_verified",result:result.status==="connected"?"success":"failure",metadata:{workflowIds:ids,status:result.status}},db);
  });await refreshSetup(orgId);return result;
}
export async function disconnectIntegration(user:SessionUser,orgId:string|null,provider:IntegrationProvider) {
  await authorize(user,orgId,true);
  await withSystem(async db=>{
    const r=await existing(db,orgId,provider);if(!r)throw new AppError("not_found","Connection not found.");
    if(r.credential_id)await revokeCredential(db,r.credential_id,orgId,provider,user.id);
    await db.query("update integration_connections set status='disconnected',credential_id=null,capabilities='{}',revision=revision+1 where id=$1",[r.id]);
    await setIntegrationStatus(db,orgId,provider,"disabled","Disconnected in the portal. Revoke the upstream token at the provider separately.");
    if(provider==="n8n" && !orgId)await invalidateMappedN8n(db,r.id,"disabled","Agency connection was disconnected.");
    if(provider==="ghl")await db.query("update ghl_location_mappings set status='disabled',verified_at=null where org_id=$1",[orgId]);
    if(provider==="hermes" && orgId)await db.query("update agent_instances set status='offline',last_health_ok=false,last_health_detail='Portal credential revoked' where org_id=$1 and credential_id=$2",[orgId,r.credential_id]);
    await recordAudit({orgId,actorUserId:user.id,actorKind:"agency",action:"integration.disconnected",targetType:"integration",targetId:r.id,result:"success",metadata:{provider}},db);
  });invalidateLlmConfig();if(provider!=="llm")await refreshSetup(orgId);
}

/** Invalidate both mapping evidence and cached client health when the shared connection changes. */
async function invalidateMappedN8n(db:Queryable,connectionId:string,status:"pending"|"error"|"disabled",detail:string) {
  const {rows}=await db.query<{org_id:string}>("update automation_template_mappings set status=$2,last_verified_at=null,last_error=$3 where global_connection_id=$1 returning org_id",[connectionId,status==="pending"?"unverified":"needs_attention",detail]);
  for(const orgId of new Set(rows.map(r=>r.org_id)))await setIntegrationStatus(db,orgId,"n8n",status,detail);
}

/**
 * Lists the models a provider offers so the admin can pick one. The key is either the one just typed
 * (never stored by this call) or the saved one; a saved key is only ever sent to the host it was saved for.
 */
export async function listLlmModels(user:SessionUser,input:{baseUrl:string;apiFormat:"openai"|"anthropic";secret?:string}):Promise<string[]> {
  await authorize(user,null,true);
  const baseUrl=validateLlmEndpoint(input.baseUrl);
  let apiKey=input.secret?.trim();
  if(!apiKey) {
    const saved=await withSystem(async db=>{
      const r=await existing(db,null,"llm");
      if(!r?.credential_id || r.status==="disconnected")return null;
      if(typeof r.config.baseUrl!=="string" || new URL(r.config.baseUrl).host!==new URL(baseUrl).host)throw new AppError("invalid_input","Enter the API key for this provider to load its models.");
      return resolveCredential(db,r.credential_id,null,"llm");
    });
    apiKey=saved ?? undefined;
  }
  if(!apiKey)throw new AppError("invalid_input","Enter the API key first, then load the models.");
  try {return await fetchLlmModels({baseUrl,format:input.apiFormat,apiKey});}
  catch(error) {throw error instanceof AppError ? error : new AppError("upstream_error","Could not load models from this provider.");}
}
