export const INTEGRATION_PROVIDERS=["supabase","hermes","ghl","n8n","llm","google_calendar","email","domain","external"] as const;
export type IntegrationProvider=typeof INTEGRATION_PROVIDERS[number];
export type IntegrationState="not_configured"|"credentials_saved"|"testing"|"connected"|"permission_limited"|"needs_attention"|"disconnected"|"error";
export const INTEGRATION_STATE_LABEL:Record<IntegrationState,string>={not_configured:"Not configured",credentials_saved:"Credentials saved",testing:"Testing",connected:"Connected",permission_limited:"Permission limited",needs_attention:"Needs attention",disconnected:"Disconnected",error:"Error"};
export const INTEGRATION_NAMES:Record<IntegrationProvider,string>={supabase:"Supabase",hermes:"Hermes Agent",ghl:"GoHighLevel",n8n:"n8n",llm:"AI model (LLM)",google_calendar:"Google Calendar",email:"Business email",domain:"Website domains",external:"Future integrations"};
export interface IntegrationView {
  id:string|null;provider:IntegrationProvider;label:string;status:IntegrationState;environment:string;
  config:Record<string,unknown>;capabilities:Record<string,unknown>;
  lastSuccessAt:string|null;lastFailureAt:string|null;lastError:string|null;
  fingerprint:string|null;rotatedAt:string|null;hasCredential:boolean;checks:Array<{status:string;detail:string;mode:string;operation?:string;at:string}>;
}

export type LlmApiFormat="openai"|"anthropic";
export interface LlmPreset {id:string;label:string;baseUrl:string;format:LlmApiFormat;model:string;note:string;}
/** Presets only prefill the form. Their hosts are the only ones accepted without INTEGRATION_ALLOWED_HOSTS. */
export const LLM_PRESETS:readonly LlmPreset[]=[
  {id:"deepseek",label:"DeepSeek",baseUrl:"https://api.deepseek.com",format:"openai",model:"deepseek-chat",note:"OpenAI-compatible."},
  {id:"openai",label:"OpenAI",baseUrl:"https://api.openai.com/v1",format:"openai",model:"gpt-4o-mini",note:"OpenAI Chat Completions."},
  {id:"anthropic",label:"Anthropic (Claude)",baseUrl:"https://api.anthropic.com",format:"anthropic",model:"claude-haiku-5-5",note:"Native Messages API."},
  {id:"openrouter",label:"OpenRouter",baseUrl:"https://openrouter.ai/api/v1",format:"openai",model:"deepseek/deepseek-chat",note:"One key, many models."},
  {id:"groq",label:"Groq",baseUrl:"https://api.groq.com/openai/v1",format:"openai",model:"llama-3.3-70b-versatile",note:"OpenAI-compatible."},
  {id:"custom",label:"Custom (OpenAI-compatible)",baseUrl:"",format:"openai",model:"",note:"Self-hosted or other gateway. Its host must be approved in INTEGRATION_ALLOWED_HOSTS."},
] as const;
export const LLM_PRESET_IDS=LLM_PRESETS.map(p=>p.id) as [string,...string[]];
