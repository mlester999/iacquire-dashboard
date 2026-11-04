"use client";

import { motion,useReducedMotion } from "motion/react";
import { ArrowUpRight,BookOpen,ShieldCheck,Sparkles } from "lucide-react";
import { Logo } from "@/components/brand";
import { AI_GROWTH_PARTNER_CAPABILITIES, AI_GROWTH_PARTNER_CAPABILITY_INFO } from "@/lib/ai-growth-partner";

export function AuthShowcase() {
  const reduce=useReducedMotion();
  return <aside className="relative hidden overflow-hidden bg-[#0d1426] text-white lg:flex lg:flex-col">
    <div aria-hidden className="pointer-events-none absolute inset-0" style={{background:"radial-gradient(ellipse at 0% 0%,#2c5bff40,transparent 65%),radial-gradient(ellipse at 100% 100%,#7658d528,transparent 60%)"}}/>
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-15 [background-image:radial-gradient(#c3cfff_1px,transparent_1px)] [background-size:24px_24px]"/>
    <div className="relative flex items-center justify-between gap-4 px-8 pb-7 pt-9 xl:px-12"><Logo tone="inverse" /><span className="rounded-full border border-white/20 px-3 py-1 text-[12px] text-slate-300">Client Portal</span></div>
    <div className="relative flex flex-1 flex-col justify-center gap-8 px-8 pb-10 xl:gap-10 xl:px-12">
      <motion.div initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{duration:.4}}>
        <p className="text-[12px] font-semibold uppercase tracking-[.2em] text-blue-200">Built around your business</p>
        <h2 className="mt-4 max-w-lg text-[38px] font-semibold leading-[1.08] tracking-[-.04em] xl:text-[48px]">A little less busywork.<br/><span className="text-blue-200">A lot more possibility.</span></h2>
        <p className="mt-5 max-w-lg text-[14px] leading-relaxed text-slate-300">One AI Growth Partner, your company knowledge and daily business operations. Together in one iAcquire workspace.</p>
      </motion.div>
      <div>
        <div className="mb-3 flex items-center justify-between gap-3"><p className="text-[12px] font-semibold uppercase tracking-[.16em] text-slate-300">One AI Growth Partner</p><span className="text-[12px] text-blue-200">Six connected capabilities</span></div>
        <motion.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={{duration:.3}} className="mb-3 flex items-center gap-3 rounded-2xl border border-white/15 bg-white/[.06] p-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/10 text-blue-200"><Sparkles className="size-6" aria-hidden /></span>
          <div className="min-w-0"><p className="text-[15px] font-semibold text-white">AI Growth Partner</p><p className="mt-1 text-[12px] text-slate-300">One identity and shared business context</p></div>
        </motion.div>
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">{AI_GROWTH_PARTNER_CAPABILITIES.map((key,index)=>{const area=AI_GROWTH_PARTNER_CAPABILITY_INFO[key];return <motion.div key={key} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.25,delay:reduce?0:index*.025}} className="flex min-h-12 items-center rounded-xl border border-white/10 bg-white/[.035] px-3 py-2"><p className="text-[12px] leading-snug text-slate-200">{area.title}</p></motion.div>;})}</div>
      </div>
      <div className="grid gap-3 border-t border-white/15 pt-5 text-[12px] leading-relaxed text-slate-300"><p className="flex items-center gap-3"><BookOpen className="size-4 shrink-0 text-blue-200" aria-hidden/>Company context follows your team.</p><p className="flex items-center gap-3"><ShieldCheck className="size-4 shrink-0 text-blue-200" aria-hidden/>Scoped access and clear review controls.</p><p className="flex items-center gap-3"><ArrowUpRight className="size-4 shrink-0 text-blue-200" aria-hidden/>Setup progress and real connection status.</p></div>
    </div>
  </aside>;
}
