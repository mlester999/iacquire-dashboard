"use client";
import * as React from "react";
import Link from "next/link";
import { AnimatePresence,motion,useReducedMotion } from "motion/react";
import { ArrowUpRight,ArrowRight,Check,MessageSquare,Search,ShieldCheck,SlidersHorizontal,Sparkles } from "lucide-react";
import { AgentAvatar,AgentStatusBadge } from "@/components/brand";
import { ButtonLink } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { RequestSetupButton } from "@/components/workforce/request-setup";
import { AGENT_BY_KEY,AGENT_ROLES,canChat,type AgentRoleKey,type AgentStatus } from "@/lib/agents";
import { cn } from "@/lib/utils";

type Employee={id:string;role_key:AgentRoleKey;display_name:string;enabled:boolean;status:AgentStatus;mode:"autonomous"|"approval_required"|"paused";summary:string|null};
const MODE_LABEL={autonomous:"Autonomous",approval_required:"Approval required",paused:"Paused"} as const;
const GROUPS=[{key:"all",label:"Entire team"},{key:"ready",label:"Ready to work"},{key:"setup",label:"Needs attention"},{key:"disabled",label:"Not included"}] as const;
export function WorkforceGallery({agents,capabilities,companyName,canConfigure,canUse}:{agents:Employee[];capabilities:Record<string,string[]>;companyName:string;canConfigure:boolean;canUse:boolean}) {
  const reduced=useReducedMotion();const [filter,setFilter]=React.useState<string>("all");const [query,setQuery]=React.useState("");
  const ready=agents.filter(a=>a.enabled&&canChat(a.status));const preparing=agents.filter(a=>a.enabled&&(a.status==="setup_required"||a.status==="provisioning"));
  const visible=agents.filter(a=>(filter==="all"||filter==="ready"&&a.enabled&&canChat(a.status)||filter==="setup"&&a.enabled&&!canChat(a.status)||filter==="disabled"&&!a.enabled)&&`${a.display_name} ${AGENT_BY_KEY[a.role_key].name}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-6">
    <section data-aqi-target="workforce.hero" className="relative isolate overflow-hidden rounded-[26px] bg-[#11192c] p-5 text-white sm:p-8">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-28 size-96 rounded-full bg-blue-500/15 blur-3xl"/>
      <div className="relative grid items-center gap-8 lg:grid-cols-[1.4fr_1fr]">
        <div><p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.18em] text-blue-200"><Sparkles className="size-3.5"/>The {companyName} AI team</p>
          <h1 className="mt-3 max-w-xl text-[26px] font-semibold leading-[1.1] tracking-[-.04em] sm:text-[36px]">Specialists. A shared mission.<br/><span className="text-blue-200">Your business, moving forward.</span></h1>
          <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-slate-300">Meet the employees behind your growth. Each has a dedicated identity, clear responsibilities and its own private workspace.</p>
          <div className="mt-5 flex flex-wrap items-center gap-3">{preparing.length>0&&canConfigure?<RequestSetupButton count={preparing.length}/>:<ButtonLink href="/setup" variant="brand" size="sm">View your setup journey<ArrowRight className="size-3.5"/></ButtonLink>}
            <span className="flex items-center gap-1.5 text-[12px] text-slate-300"><ShieldCheck className="size-3.5 text-blue-200"/>Private to your organization</span></div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-5">
          <div className="flex items-center justify-between gap-3"><span className="text-[12px] font-medium text-slate-300">Team readiness</span><span className="rounded-full border border-white/15 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-300">Current status</span></div>
          <div className="mt-3 flex items-baseline gap-2"><strong className="text-[32px] font-semibold leading-none tracking-[-.05em] sm:text-[42px]">{ready.length}</strong><span className="text-[14px] text-slate-300">of {agents.filter(a=>a.enabled).length} included employees ready</span></div>
          <div className="mt-4 grid grid-cols-6 gap-0 sm:flex sm:flex-wrap sm:gap-2">{agents.map(a=><Link aria-label={`View ${a.display_name}`} key={a.id} href={`/workforce/${AGENT_BY_KEY[a.role_key].slug}`} className="flex size-11 items-center justify-center rounded-xl transition hover:-translate-y-1 focus-visible:outline-white"><AgentAvatar role={AGENT_BY_KEY[a.role_key]} size="sm"/></Link>)}</div>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-300 sm:hidden">Open an employee to review its status and configuration.</p><p className="mt-4 hidden text-[12px] leading-relaxed text-slate-300 sm:block">{preparing.length?`${preparing.length} employees need preparation or connection verification. Follow their progress in Setup Center.`:ready.length?"Open an employee to review its configuration or start a conversation.":"Connection checks will confirm when your employees are ready to work."}</p>
        </div>
      </div>
    </section>
    <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
      <div role="group" aria-label="Filter employees" className="flex max-w-full flex-wrap gap-1.5">{GROUPS.map(group=><button key={group.key} onClick={()=>setFilter(group.key)} aria-pressed={filter===group.key} className={cn("min-h-11 rounded-xl px-3.5 text-[13px] font-medium transition",filter===group.key?"bg-ink text-bg shadow-soft":"text-muted hover:bg-surface-2 hover:text-ink")}>{group.label}{<span className="ml-2 opacity-65">{group.key==="all"?agents.length:group.key==="ready"?ready.length:group.key==="disabled"?agents.filter(a=>!a.enabled).length:agents.filter(a=>a.enabled&&!canChat(a.status)).length}</span>}</button>)}</div>
      <label className="relative w-full lg:w-64"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted"/><span className="sr-only">Search your AI team</span><Input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Find an employee…" className="pl-9"/></label>
    </div>
    <motion.div data-aqi-target="workforce.gallery" className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      <AnimatePresence initial={false}>{visible.map((a,index)=>{
        const role=AGENT_BY_KEY[a.role_key];const connected=a.enabled&&canChat(a.status);
        return <motion.article key={a.id} data-aqi-target="workforce.employee" initial={reduced?false:{opacity:0,y:14}} animate={{opacity:1,y:0}} exit={{opacity:0,scale:reduced?1:.97}} transition={{duration:reduced?0:.3,delay:reduced?0:index*.035}} whileHover={reduced?undefined:{y:-4}} className={cn("group flex min-w-0 flex-col overflow-hidden rounded-[22px] border border-line bg-surface shadow-soft",!a.enabled&&"opacity-75")}>
          <div className="relative flex h-36 items-center justify-between overflow-hidden border-b border-line px-5" style={{background:`radial-gradient(ellipse at 85% 25%,${role.accent}30,transparent 70%),var(--surface-2)`}}>
            <div className="relative z-10"><span className="block font-mono text-[10px] uppercase tracking-[.14em] text-muted">Employee {String(AGENT_ROLES.findIndex(role=>role.key===a.role_key)+1).padStart(2,"0")}</span><span className="mt-3 block max-w-32 text-[17px] font-semibold leading-tight tracking-tight text-ink">{({operations_manager:"Coordination",lead_hunter:"Lead research",appointment_setter:"Appointments",sales_assistant:"Sales support",crm_manager:"Customer records",performance_analyst:"Performance"})[a.role_key]}</span><div className="mt-3 flex flex-wrap items-center gap-1.5"><AgentStatusBadge status={a.enabled?a.status:"disabled"}/>{a.enabled&&<span className={cn("inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-medium",a.mode==="paused"?"border-warning/40 bg-warning-soft text-warning-ink":a.mode==="autonomous"?"border-transparent bg-primary-soft text-primary-ink":"border-line bg-surface-2 text-ink-2")}>{MODE_LABEL[a.mode]}</span>}</div></div>
            <div aria-hidden className="absolute right-4 top-4 size-32 rounded-full border border-line-strong"/><div aria-hidden className="absolute right-0 top-0 size-40 rounded-full border border-line"/>
            <AgentAvatar role={role} size="xl" className="relative z-10 drop-shadow-lg"/>
          </div>
          <div className="flex flex-1 flex-col p-5"><h2 className="text-[18px] font-semibold tracking-tight">{a.display_name}</h2><p className="mt-2 min-h-12 text-[13px] leading-relaxed text-muted" title={a.summary??undefined}>{a.summary?.split(/(?<=[.!?])\s/)[0]??role.tagline}</p>
            <div className="mt-4 border-t border-line pt-4"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[.14em] text-muted">What this employee handles</p><ul className="space-y-2">{(capabilities[a.role_key]??[]).slice(0,3).map(capability=><li key={capability} className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-2"><Check className="mt-0.5 size-3.5 shrink-0 text-primary"/>{capability}</li>)}</ul></div>
            <div className="mt-auto flex items-center justify-between gap-2 pt-5">{connected&&canUse?<ButtonLink href={`/chat/${role.slug}`} size="sm" variant="brand"><MessageSquare className="size-3.5"/>Open chat</ButtonLink>:<span className="max-w-36 text-[12px] text-muted">{a.enabled?"Chat opens after verification":"Not included in your package"}</span>}
              <Link href={`/workforce/${role.slug}`} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2">{canConfigure?<SlidersHorizontal className="size-3.5"/>:null}{canConfigure?"Configure":"Details"}<ArrowUpRight className="size-3.5"/></Link></div>
          </div>
        </motion.article>;
      })}</AnimatePresence>
    </motion.div>
    {!visible.length&&<div className="rounded-2xl border border-dashed border-line-strong p-10 text-center"><Search className="mx-auto size-6 text-muted"/><h2 className="mt-3 font-semibold">No employees match this view</h2><p className="mt-1 text-[13px] text-muted">Try another filter or employee name.</p><button onClick={()=>{setFilter("all");setQuery("");}} className="mt-4 text-[13px] font-medium text-primary">Show the entire team</button></div>}
  </div>;
}
