import "server-only";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { LLM_PRESETS } from "@/lib/integrations";

/** Deployment-owned allowlist prevents credential-bearing requests to arbitrary admin-supplied hosts. */
export function validateIntegrationEndpoint(raw:string,builtInHosts:readonly string[]=[]):string {
  let u:URL;
  try {u=new URL(raw);} catch {throw new AppError("invalid_input","Enter a valid HTTPS service endpoint.");}
  if(u.username || u.password || u.search || u.hash) throw new AppError("invalid_input","The endpoint must not contain credentials, query parameters or fragments.");
  const local=["127.0.0.1","localhost","[::1]"].includes(u.hostname);
  const isTestLocal=env().NODE_ENV === "test" && local && u.protocol === "http:";
  if(u.protocol!=="https:" && !isTestLocal) throw new AppError("invalid_input","Use an approved HTTPS service endpoint.");
  const allowed=[...builtInHosts,...(env().INTEGRATION_ALLOWED_HOSTS ?? "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean)];
  if(!isTestLocal && !allowed.includes(u.host.toLowerCase())) throw new AppError("invalid_input","This service host is not approved. Add its exact host and port to INTEGRATION_ALLOWED_HOSTS in secure server settings.");
  return u.toString().replace(/\/+$/,"");
}

/** Model providers: the well-known preset hosts are built in; anything else needs the deployment allowlist. */
export const validateLlmEndpoint=(raw:string)=>validateIntegrationEndpoint(raw,LLM_PRESETS.filter(p=>p.baseUrl).map(p=>new URL(p.baseUrl).host));

export async function readOnlyJson(url:string,headers:Record<string,string>,service:string):Promise<Record<string,unknown>> {
  let res:Response;
  try {res=await fetch(url,{method:"GET",headers,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000)});}
  catch {throw new AppError("upstream_error",`${service} could not be reached or timed out.`);}
  if(res.status===401 || res.status===403) throw new AppError("forbidden",`${service} rejected the credential or its permissions.`);
  if(!res.ok) throw new AppError("upstream_error",`${service} returned HTTP ${res.status}.`);
  // Never surface raw upstream responses: they can contain secrets or customer data.
  const body:unknown=await res.json().catch(()=>null);
  if(!body || typeof body!=="object" || Array.isArray(body)) throw new AppError("upstream_error",`${service} returned an unsupported response.`);
  return body as Record<string,unknown>;
}
