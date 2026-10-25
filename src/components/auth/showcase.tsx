"use client";

import { motion,useReducedMotion } from "motion/react";
import { ArrowUpRight,BookOpen,ShieldCheck } from "lucide-react";
import { AgentAvatar,Logo } from "@/components/brand";
import { AGENT_ROLES } from "@/lib/agents";

export function AuthShowcase() {
  const reduce=useReducedMotion();
  return <aside className="relative hidden overflow-hidden bg-[#0d1426] text-white lg:flex lg:flex-col">
    <div aria-hidden className="pointer-events-none absolute inset-0" style={{background:"radial-gradient(ellipse at 0% 0%,#2c5bff40,transparent 65%),radial-gradient(ellipse at 100% 100%,#7658d528,transparent 60%)"}}/>
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-15 [background-image:radial-gradient(#c3cfff_1px,transparent_1px)] [background-size:24px_24px]"/>
    <div className="relative flex items-center justify-between gap-4 px-8 pb-7 pt-9 xl:px-12"><Logo tone="inverse" /><span className="rounded-full border border-white/20 px-3 py-1 text-[12px] text-slate-300">Client Portal</span></div>
    <div className="relative flex flex-1 flex-col justify-center gap-8 px-8 pb-10 xl:gap-10 xl:px-12">
      <motion.div initial={reduce?false:{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{duration:.4}}>
        <p className="text-[12px] font-semibold uppercase tracking-[.2em] text-blue-200">Built around your business</p>
        <h2 className="mt-4 max-w-lg text-[38px] font-semibold leading-[1.08] tracking-[-.04em] xl:text-[48px]">A little less busywork.<br/><span className="text-blue-200">A lot more possibility.</span></h2>
        <p className="mt-5 max-w-lg text-[14px] leading-relaxed text-slate-300">Your company knowledge, specialist AI employees and daily business operations. Together in one iAcquire workspace.</p>
      </motion.div>
      <div>
        <div className="mb-3 flex items-center justify-between gap-3"><p className="text-[12px] font-semibold uppercase tracking-[.16em] text-slate-300">Six specialist roles</p><span className="text-[12px] text-blue-200">One shared business context</span></div>
        <div className="grid grid-cols-2 gap-3">{AGENT_ROLES.map((role,index)=><motion.div key={role.key} initial={reduce?false:{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={{duration:.3,delay:reduce?0:index*.04}} className="flex min-w-0 items-center gap-3 rounded-2xl border border-white/15 bg-white/[.045] p-3 xl:p-4"><AgentAvatar role={role} size="md"/><div className="min-w-0"><p className="text-[12px] font-medium text-white xl:text-[13px]">{role.shortName}</p><p className="mt-1 text-[12px] text-slate-300">Specialist {String(index+1).padStart(2,"0")}</p></div></motion.div>)}</div>
      </div>
      <div className="grid gap-3 border-t border-white/15 pt-5 text-[12px] leading-relaxed text-slate-300"><p className="flex items-center gap-3"><BookOpen className="size-4 shrink-0 text-blue-200" aria-hidden/>Company context follows your team.</p><p className="flex items-center gap-3"><ShieldCheck className="size-4 shrink-0 text-blue-200" aria-hidden/>Scoped access and clear review controls.</p><p className="flex items-center gap-3"><ArrowUpRight className="size-4 shrink-0 text-blue-200" aria-hidden/>Setup progress and real connection status.</p></div>
    </div>
  </aside>;
}