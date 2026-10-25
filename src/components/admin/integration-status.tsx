"use client";
import { CheckCircle2,CircleDashed,KeyRound,LoaderCircle,ShieldAlert,Unplug,XCircle,AlertCircle } from "lucide-react";
import type { IntegrationState } from "@/lib/integrations";
import { cn } from "@/lib/utils";

const STATES={
  connected:{label:"Connected & verified",Icon:CheckCircle2,style:"border-success/25 bg-success-soft text-success-ink",dot:"bg-success"},
  credentials_saved:{label:"Saved · not verified",Icon:KeyRound,style:"border-primary/25 bg-primary-soft text-primary-ink",dot:"bg-primary"},
  not_configured:{label:"Not configured",Icon:CircleDashed,style:"border-line bg-surface-2 text-muted",dot:"bg-faint"},
  testing:{label:"Testing connection",Icon:LoaderCircle,style:"border-primary/25 bg-primary-soft text-primary-ink",dot:"bg-primary"},
  permission_limited:{label:"Permission limited",Icon:ShieldAlert,style:"border-warning/25 bg-warning-soft text-warning-ink",dot:"bg-warning"},
  needs_attention:{label:"Needs attention",Icon:AlertCircle,style:"border-warning/25 bg-warning-soft text-warning-ink",dot:"bg-warning"},
  disconnected:{label:"Disconnected",Icon:Unplug,style:"border-line-strong bg-surface-2 text-ink-2",dot:"bg-muted"},
  error:{label:"Connection error",Icon:XCircle,style:"border-danger/25 bg-danger-soft text-danger-ink",dot:"bg-danger"},
} as const;
export function IntegrationStatus({status,className,compact=false}:{status:IntegrationState;className?:string;compact?:boolean}){
  const {Icon,style,label}=STATES[status];return <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-semibold leading-4",style,className)}><Icon aria-hidden className={cn("size-3.5 shrink-0",status==="testing"&&"motion-safe:animate-spin")}/><span>{compact&&status==="connected"?"Verified":label}</span></span>;
}
