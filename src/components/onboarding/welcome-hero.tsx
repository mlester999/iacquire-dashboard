"use client";

import { motion,useReducedMotion } from "motion/react";
import { ArrowRight,BookOpen,Check,ShieldCheck,Sparkles } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { ButtonLink } from "@/components/ui/button";
import { AGENT_ROLES } from "@/lib/agents";

export function WelcomeHero({firstName,orgName,resumed}:{firstName:string|null;orgName:string;resumed:boolean}) {
  const reduce=useReducedMotion();
  return <main className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6 sm:pt-12">
    <div className="grid items-center gap-8 lg:grid-cols-[1.05fr_.95fr] lg:gap-12">
      <motion.div initial={{opacity:0,y:16}} animate={{opacity:1,y:0}} transition={{duration:.35}}>
        <p className="text-[12px] font-semibold uppercase tracking-[.18em] text-primary">Welcome{firstName?`, ${firstName}`:""}</p>
        <h1 className="mt-4 max-w-xl text-[36px] font-semibold leading-[1.08] tracking-[-.04em] sm:text-[48px]">Your business.<br/>Your <span className="font-display font-normal italic text-gradient">AI team.</span><br/>A new way to work.</h1>
        <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-muted">A little context goes a long way. Tell us about {orgName}, choose your priorities, and help your AI employees understand how you work.</p>
        <div className="mt-7 flex flex-col items-start gap-3"><ButtonLink href="/onboarding" variant="brand" size="lg">{resumed?"Review company setup":"Set up my AI team"}<ArrowRight className="size-4"/></ButtonLink><ButtonLink href="/overview" variant="ghost">Explore the dashboard first</ButtonLink></div>
        <p className="mt-5 flex items-center gap-2 text-[12px] leading-relaxed text-muted"><BookOpen className="size-4 shrink-0 text-primary" aria-hidden/>One question at a time. Save and resume when it suits you.</p>
      </motion.div>
      <motion.section initial={{opacity:0,y:18}} animate={{opacity:1,y:0}} transition={{duration:.4,delay:reduce?0:.08}} className="relative overflow-hidden rounded-[28px] bg-[#101a30] p-5 text-white sm:p-7" aria-labelledby="welcome-team-title">
        <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 size-72 rounded-full bg-blue-500/15 blur-3xl"/>
        <div className="relative"><p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[.16em] text-blue-200"><Sparkles className="size-3.5" aria-hidden/>Built around your priorities</p><h2 id="welcome-team-title" className="mt-3 text-[23px] font-semibold leading-tight tracking-tight">Specialists with<br/>a shared business context.</h2><div className="mt-6 grid grid-cols-2 gap-3">{AGENT_ROLES.map(role=><div key={role.key} className="flex min-w-0 items-center gap-2 rounded-xl border border-white/15 bg-white/5 p-3"><AgentAvatar role={role} size="sm"/><span className="text-[12px] font-medium leading-relaxed text-slate-200 sm:text-[12px]">{role.shortName}</span></div>)}</div><p className="mt-5 text-[12px] leading-relaxed text-slate-300">Available employees depend on your package. Their connections and readiness are verified during setup.</p><div className="mt-5 flex items-start gap-2.5 border-t border-white/15 pt-4 text-[12px] leading-relaxed text-slate-300"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-blue-200" aria-hidden/>Your company information stays scoped to your workspace.</div></div>
      </motion.section>
    </div>
    <section className="mt-10 border-t border-line pt-7" aria-label="How setup works"><p className="mb-4 text-[12px] font-semibold uppercase tracking-[.15em] text-muted">How it comes together</p><ol className="grid gap-4 sm:grid-cols-3">{[{title:"Share your context",copy:"Business, customers and priorities. Your answers save as you go."},{title:"Shape your AI team",copy:"Review the roles and preferences that fit how your business works."},{title:"Follow your setup",copy:"Our team handles the connections. Track verified progress in Setup Center."}].map((item,index)=><li key={item.title} className="flex items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary-soft font-mono text-[12px] text-primary-ink">{resumed&&index===0?<Check className="size-3.5" aria-label="Company setup already saved"/>:String(index+1).padStart(2,"0")}</span><div><h3 className="text-[14px] font-semibold">{item.title}</h3><p className="mt-1 text-[12px] leading-relaxed text-muted">{item.copy}</p></div></li>)}</ol></section>
  </main>;
}