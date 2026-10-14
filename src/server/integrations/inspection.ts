import "server-only";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { assertAssignableLocation } from "@/server/admin/tenants";
import { readOnlyJson, validateIntegrationEndpoint, validateLlmEndpoint } from "@/server/integrations/safety";
import { llmComplete, llmHeaders, llmModelsUrl, type LlmConfig } from "@/server/llm/client";
import { getCapabilities,getProfileModels,getToolsets,restrictedToolsIn,hasVerifiedCompleteToolInventory,type HermesConnection } from "@/server/integrations/hermes/client";

export interface Inspection {
  status:"connected"|"permission_limited"|"needs_attention"|"error";
  detail:string;
  capabilities:Record<string,unknown>;
}
const id=(v:unknown)=>typeof v === "string" ? v : "";
const list=(v:unknown):Record<string,unknown>[] => Array.isArray(v) ? v.filter((x):x is Record<string,unknown>=>!!x && typeof x === "object") : [];

export async function inspectHermes(conn:HermesConnection,clientProfile:boolean):Promise<Inspection> {
  conn={...conn,baseUrl:validateIntegrationEndpoint(conn.baseUrl)};
  const caps=await getCapabilities(conn);
  const models=await getProfileModels(conn);
  const sets=await getToolsets(conn);
  const restricted=restrictedToolsIn(sets);
  const identity=!!conn.profile && models.includes(conn.profile);
  const contract=caps.contract === "hermes.api_server.capabilities" && caps.authenticated && caps.supportsRuns && caps.supportsEvents;
  const completeToolInventory=hasVerifiedCompleteToolInventory(conn);
  const capabilities={identityVerified:identity,profile:conn.profile,installedContractVerified:contract,packageVersion:"not_reported",supportsRuns:caps.supportsRuns,supportsEvents:caps.supportsEvents,supportsStop:caps.supportsStop,supportsApproval:caps.supportsApproval,restrictedTools:restricted,completeToolInventoryVerified:completeToolInventory,toolInventoryScope:completeToolInventory?"synthetic_complete":"advertised_configurable_toolsets_only",profileCreation:"agency_controlled_task",safeReadOnlyTest:true};
  if(!identity || !contract) return {status:"needs_attention",detail:"The gateway did not verify the intended profile identity and required installed API capabilities.",capabilities};
  if(clientProfile && restricted.length) return {status:"needs_attention",detail:"This client profile exposes restricted tools. Remove those permissions before use.",capabilities};
  if(clientProfile && !completeToolInventory)return {status:"permission_limited",detail:"Profile identity and API access verified. The public toolset API cannot prove complete plugin/MCP permissions. Client use stays blocked until a supported complete-inventory check is available; ask the gateway administrator to review the installed contract and disable hidden/default tools.",capabilities};
  return {status:"connected",detail:"Authenticated profile identity, installed API compatibility and advertised tool inventory verified. No AI run was started.",capabilities};
}

export const GHL_READ_SCOPES=["locations.readonly","opportunities.readonly","calendars.readonly","calendars/events.readonly","locations/tags.readonly","locations/customFields.readonly","locations/customValues.readonly","forms.readonly","workflows.readonly","funnels.readonly"] as const;
export type GhlAssetKind="pipelines"|"tags"|"customFields"|"customValues"|"forms"|"calendars"|"workflows";
export interface GhlAssetReference { id:string; name:string; status?:string; stages?:Array<{id:string;name:string}>; }
export interface GhlReadConnection {locationId:string;token:string;orgKind:"agency"|"client";version?:"v3"|"2021-07-28";}

function assertGhl(c:GhlReadConnection) {
  assertAssignableLocation(c.locationId,c.orgKind);
  if(!/^[a-zA-Z0-9]{10,40}$/.test(c.locationId)) throw new AppError("invalid_input","Invalid CRM location identifier.");
}
async function ghlRead(c:GhlReadConnection,path:string,params:Record<string,string>={}) {
  assertGhl(c);
  const base=env().GHL_API_BASE;
  // GHL only goes to the official host. Synthetic tests may replace fetch, never the destination.
  if(new URL(base).origin!=="https://services.leadconnectorhq.com") throw new AppError("invalid_input","GoHighLevel must use the official API host.");
  const u=new URL(path,base); for(const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  return readOnlyJson(u.toString(),{Authorization:`Bearer ${c.token}`,Version:c.version ?? "2021-07-28",Accept:"application/json"},"GoHighLevel");
}
export async function verifyGhlIdentity(c:GhlReadConnection):Promise<void> {
  const body=await ghlRead(c,`/locations/${encodeURIComponent(c.locationId)}`);
  const location=body.location as Record<string,unknown>|undefined;
  if(!location || location.id!==c.locationId) throw new AppError("forbidden","GoHighLevel location mismatch. This credential must belong to the intended client location.");
}
export async function readGhlAssets(c:GhlReadConnection,kind:GhlAssetKind):Promise<GhlAssetReference[]> {
  // Verify identity first for every metadata operation; do not trust saved mappings alone.
  await verifyGhlIdentity(c);
  const paths:Record<GhlAssetKind,string>={pipelines:"/opportunities/pipelines",tags:`/locations/${c.locationId}/tags`,customFields:`/locations/${c.locationId}/customFields`,customValues:`/locations/${c.locationId}/customValues`,forms:"/forms/",calendars:"/calendars/",workflows:"/workflows/"};
  const scoped=["pipelines","forms","calendars","workflows"].includes(kind);
  const body=await ghlRead(c,paths[kind],scoped ? {locationId:c.locationId,...(kind==="forms" ? {limit:"50"} : {})} : {});
  if(!Array.isArray(body[kind])) throw new AppError("upstream_error","GoHighLevel returned an unsupported metadata response.");
  return list(body[kind]).map(row=>{
    if(row.locationId && row.locationId!==c.locationId) throw new AppError("forbidden","GoHighLevel metadata belongs to another location.");
    // No custom-value contents, form markup, webhook data, or workflow configuration is returned.
    return {id:id(row.id),name:id(row.name).slice(0,120),...(typeof row.status==="string" ? {status:row.status.slice(0,40)} : {}),...(kind==="pipelines" ? {stages:list(row.stages).map(s=>({id:id(s.id),name:id(s.name).slice(0,120)}))} : {})};
  });
}
export async function inspectGhl(c:GhlReadConnection,scopes:string[]):Promise<Inspection> {
  await verifyGhlIdentity(c);
  const permitted:string[]=[]; const unavailable:string[]=[]; const inventory:Record<string,GhlAssetReference[]>={};
  const probes:Array<[string,GhlAssetKind]>=[["opportunities.readonly","pipelines"],["calendars.readonly","calendars"],["locations/tags.readonly","tags"],["locations/customFields.readonly","customFields"],["locations/customValues.readonly","customValues"],["forms.readonly","forms"],["workflows.readonly","workflows"]];
  for(const [scope,kind] of probes) {
    if(!scopes.includes(scope)) continue;
    try { inventory[kind]=await readGhlAssets(c,kind); permitted.push(scope); }
    catch(error) {if(error instanceof AppError && error.code==="forbidden" && /another location|mismatch/.test(error.message)) throw error; unavailable.push(scope);}
  }
  const unverified=scopes.filter(scope=>scope!=="locations.readonly" && !permitted.includes(scope) && !unavailable.includes(scope));
  const capabilities={locationIdentityVerified:true,locationId:c.locationId,apiContract:c.version ?? "2021-07-28",provenReadPermissions:["locations.readonly",...permitted],requestedPermissions:scopes,unavailablePermissions:unavailable,unverifiedPermissions:unverified,inventory,snapshotInstallation:"unverified",bookingUrls:"admin_mapping_required",websiteReferences:"admin_mapping_required",marketplaceWebhooks:"separate_unconfigured_connection",remoteWritesEnabled:false};
  return {status:unavailable.length || unverified.length || !permitted.includes("opportunities.readonly") ? "permission_limited" : "connected",detail:unavailable.length || unverified.length ? "Location identity verified. Some requested read permissions could not be verified." : "Location identity and requested metadata read permissions verified. Snapshot installation is unverified.",capabilities};
}

export interface N8nWorkflowReference {id:string;name:string;active:boolean;}
export interface N8nReadConnection {baseUrl:string;apiKey:string;}
async function n8nRead(c:N8nReadConnection,path:string,params:Record<string,string>={}) {
  const base=validateIntegrationEndpoint(c.baseUrl); const u=new URL(`${base}/api/v1/${path}`);
  for(const [k,v]of Object.entries(params))u.searchParams.set(k,v);
  return readOnlyJson(u.toString(),{"X-N8N-API-KEY":c.apiKey,Accept:"application/json"},"n8n");
}
export async function readN8nInventory(c:N8nReadConnection):Promise<{workflows:N8nWorkflowReference[];truncated:boolean}> {
  const workflows:N8nWorkflowReference[]=[];let cursor="";
  for(let page=0;page<10;page++) {
    const body=await n8nRead(c,"workflows",{limit:"100",...(cursor?{cursor}:{})});
    if(!Array.isArray(body.data))throw new AppError("upstream_error","n8n returned an unsupported workflow inventory.");
    workflows.push(...list(body.data).map(w=>({id:id(w.id),name:id(w.name).slice(0,120),active:"activeVersionId" in w ? typeof w.activeVersionId === "string" && !!w.activeVersionId : w.active===true})));
    cursor=id(body.nextCursor);if(!cursor) return {workflows,truncated:false};
  }
  return {workflows,truncated:true};
}
/** Approved IDs come from server configuration; execution payloads are never requested or retained. */
export async function readN8nExecutions(c:N8nReadConnection,workflowId:string,approvedIds:string[]) {
  if(!approvedIds.includes(workflowId))throw new AppError("forbidden","This workflow is not approved for this connection.");
  const body=await n8nRead(c,"executions",{workflowId,includeData:"false",limit:"20"});
  if(!Array.isArray(body.data))throw new AppError("upstream_error","n8n returned unsupported execution summaries.");
  return list(body.data).map(e=>{
    if(id(e.workflowId)!==workflowId)throw new AppError("forbidden","n8n returned an execution belonging to another workflow.");
    return {id:id(e.id),workflowId,status:id(e.status).slice(0,40),startedAt:id(e.startedAt),stoppedAt:id(e.stoppedAt)};
  });
}
export async function inspectN8n(c:N8nReadConnection,approvedIds:string[]):Promise<Inspection> {
  const {workflows,truncated}=await readN8nInventory(c);
  const approved=workflows.filter(w=>approvedIds.includes(w.id));
  const missing=approvedIds.filter(x=>!approved.some(w=>w.id===x));
  const summaries:Record<string,unknown>={};let executionLimited=false;
  for(const w of approved)try{summaries[w.id]=await readN8nExecutions(c,w.id,approvedIds);}catch{executionLimited=true;}
  return {status:missing.length || truncated ? "needs_attention" : executionLimited ? "permission_limited" : "connected",detail:missing.length ? "Authenticated API responds, but an approved workflow was not found." : "Authenticated workflow inventory verified. Installed edition, package version and key restrictions are unverified; treat the key as having broad privileges.",capabilities:{apiContract:"public_api_v1",packageVersion:"not_reported",edition:"unverified",keyScopeRestrictions:"unverified_high_risk",workflows,approvedWorkflows:approved,missingApprovedIds:missing,inventoryTruncated:truncated,executions:summaries,executionReadVerified:!executionLimited,remoteWritesEnabled:false,appointmentEventSubscription:"unverified"}};
}

/** Only an explicit unsupported listing endpoint can authorize the disclosed minimal response probe. */
class UnsupportedModelListing extends AppError {
  constructor(){super("upstream_error","This provider does not support model listing.");}
}
/** Model IDs from the provider's own list endpoint (read-only). Throws AppError on auth or network failure. */
export async function fetchLlmModels(c:Omit<LlmConfig,"source"|"model">):Promise<string[]> {
  const conn={...c,baseUrl:validateLlmEndpoint(c.baseUrl),model:""};
  let response:Response;
  try {response=await fetch(llmModelsUrl(conn),{method:"GET",headers:llmHeaders(conn.format,conn.apiKey),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000)});}
  catch {throw new AppError("upstream_error","The model provider could not be reached or timed out.");}
  if(response.status===401 || response.status===403)throw new AppError("forbidden","The model provider rejected the credential or its permissions.");
  if([404,405,501].includes(response.status))throw new UnsupportedModelListing();
  if(!response.ok)throw new AppError("upstream_error",`The model provider returned HTTP ${response.status}.`);
  const body:unknown=await response.json().catch(()=>null);
  if(!body || typeof body!=="object" || Array.isArray(body) || !Array.isArray((body as {data?:unknown}).data))throw new AppError("upstream_error","The model provider returned an unsupported response.");
  const models=[...new Set(list((body as {data:unknown[]}).data).map(m=>id(m.id)).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  if(!models.length) throw new AppError("upstream_error","The provider returned no models.");
  return models;
}

export async function inspectLlm(c:Omit<LlmConfig,"source">):Promise<Inspection> {
  const conn={...c,baseUrl:validateLlmEndpoint(c.baseUrl),source:"portal" as const};
  const base={format:c.format,model:c.model,host:new URL(conn.baseUrl).host};
  try {
    const models=await fetchLlmModels(conn);
    const listed=models.includes(conn.model);
    return listed
      ? {status:"connected",detail:`Authenticated. Model ${conn.model} is available. No completion was requested.`,capabilities:{...base,verification:"model_list",verificationOperation:"model_listing",safeReadOnlyTest:true,modelListed:true,modelCount:models.length}}
      : {status:"needs_attention",detail:`Authenticated, but the provider does not list model "${conn.model}". Check the model name.`,capabilities:{...base,verification:"model_list",verificationOperation:"model_listing",safeReadOnlyTest:true,modelListed:false,modelCount:models.length,sampleModels:models.slice(0,8)}};
  } catch(error) {
    if(!(error instanceof UnsupportedModelListing))throw error;
  }
  // The admin-facing test discloses this POST. Network, auth, malformed and server errors never
  // trigger it. It requests one output token and may incur the provider's normal usage charges.
  const probe=await llmComplete(conn,{system:"Reply with OK.",user:"ping",maxTokens:1,temperature:0,timeoutMs:15000});
  const capabilities={...base,verification:"one_token_completion",verificationOperation:"basic_model_response",safeReadOnlyTest:false,maxOutputTokensRequested:1};
  if(probe.ok) return {status:"connected",detail:`Authenticated. Model listing is unsupported; the provider accepted a minimal one-token response request for ${conn.model}.`,capabilities};
  if(probe.status===401 || probe.status===403)return {status:"error",detail:"The model provider rejected the API key during the minimal response test.",capabilities};
  if(probe.status===404) return {status:"needs_attention",detail:`The provider does not recognise model "${conn.model}" or this endpoint. Check the base URL and model name.`,capabilities};
  return {status:"error",detail:probe.status?`The model provider returned HTTP ${probe.status} during the minimal response test.`:"The model provider could not be reached or timed out during the minimal response test.",capabilities};
}
