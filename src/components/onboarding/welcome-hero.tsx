"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Clock3, ShieldCheck, Sparkles } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { ButtonLink } from "@/components/ui/button";
import { AGENT_ROLES } from "@/lib/agents";

export function WelcomeHero({ firstName, orgName, resumed }: { firstName: string | null; orgName: string; resumed: boolean }) {
  const reduce = useReducedMotion();
  return (
    <main className="mx-auto flex min-h-[calc(100dvh-64px)] max-w-5xl flex-col items-center justify-center px-4 pb-16 text-center sm:px-6">
      <div className="relative mb-10 flex items-end justify-center gap-2 sm:gap-3" aria-hidden>
        {AGENT_ROLES.map((r, i) => (
          <motion.div
            key={r.key}
            initial={reduce ? false : { opacity: 0, y: 30, scale: 0.7 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: [0, -8, 0], scale: 1 }}
            transition={
              reduce
                ? { duration: 0.2 }
                : { opacity: { delay: 0.1 + i * 0.08, duration: 0.4 }, scale: { delay: 0.1 + i * 0.08, type: "spring", stiffness: 260, damping: 16 }, y: { delay: 1 + i * 0.15, duration: 4, repeat: Infinity, ease: "easeInOut" } }
            }
          >
            <AgentAvatar role={r} size={i === 2 || i === 3 ? "xl" : "lg"} className="drop-shadow-[0_16px_30px_rgba(16,24,40,0.15)]" />
          </motion.div>
        ))}
      </div>
      <p className="rise-in text-[13px] font-medium uppercase tracking-[0.16em] text-primary">Welcome{firstName ? `, ${firstName}` : ""}</p>
      <h1 className="rise-in mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[56px]" style={{ animationDelay: "80ms" }}>
        Your business. Your <span className="font-display font-normal italic text-gradient">AI team.</span>
        <br className="hidden sm:block" /> One workspace.
      </h1>
      <p className="rise-in mx-auto mt-5 max-w-2xl text-[16px] leading-relaxed text-muted sm:text-[17px]" style={{ animationDelay: "160ms" }}>
        Manage leads, appointments, sales, and customer relationships with a team of AI employees built around {orgName}.
      </p>
      <div className="rise-in mt-9 flex flex-col items-center gap-3 sm:flex-row" style={{ animationDelay: "240ms" }}>
        <ButtonLink href="/onboarding" variant="brand" size="lg" className="min-w-56">
          {resumed ? "Review company setup" : "Set up my AI team"} <ArrowRight className="size-4" />
        </ButtonLink>
        <ButtonLink href="/overview" variant="ghost" size="lg">
          Explore the dashboard first
        </ButtonLink>
      </div>
      <ul className="rise-in mt-10 grid gap-3 text-left text-[13.5px] text-ink-2 sm:grid-cols-3" style={{ animationDelay: "320ms" }}>
        <li className="flex items-center gap-2.5 rounded-2xl border border-line bg-surface/80 px-4 py-3 shadow-soft">
          <Clock3 className="size-4 text-primary" /> About 3–5 minutes, saves as you go
        </li>
        <li className="flex items-center gap-2.5 rounded-2xl border border-line bg-surface/80 px-4 py-3 shadow-soft">
          <Sparkles className="size-4 text-violet" /> No prompts or technical setup
        </li>
        <li className="flex items-center gap-2.5 rounded-2xl border border-line bg-surface/80 px-4 py-3 shadow-soft">
          <ShieldCheck className="size-4 text-success" /> You approve anything customer-facing
        </li>
      </ul>
    </main>
  );
}
