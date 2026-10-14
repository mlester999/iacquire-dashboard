"use client";

import { motion, useReducedMotion } from "motion/react";
import { CalendarCheck2, ShieldCheck, Sparkles } from "lucide-react";
import { AgentAvatar, Logo } from "@/components/brand";
import { AGENT_ROLES } from "@/lib/agents";

// Positions are relative to the mascot stage above the headline, so nothing overlaps the copy.
const POSITIONS = [
  { top: "6%", left: "8%", size: "lg" as const, delay: 0 },
  { top: "40%", left: "24%", size: "xl" as const, delay: 0.6 },
  { top: "4%", left: "44%", size: "lg" as const, delay: 1.2 },
  { top: "44%", left: "58%", size: "lg" as const, delay: 0.3 },
  { top: "10%", left: "74%", size: "xl" as const, delay: 0.9 },
  { top: "62%", left: "84%", size: "md" as const, delay: 1.5 },
];

export function AuthShowcase() {
  const reduce = useReducedMotion();
  return (
    <aside className="relative hidden overflow-hidden bg-[#06070b] text-white lg:flex lg:flex-col">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(900px 600px at 20% 10%, rgba(44,91,255,0.35), transparent 60%), radial-gradient(700px 600px at 90% 80%, rgba(139,92,255,0.28), transparent 60%), radial-gradient(500px 400px at 60% 50%, rgba(18,201,165,0.08), transparent 60%)",
        }}
      />
      <div aria-hidden className="absolute inset-0 opacity-[0.18] [background-image:radial-gradient(rgba(255,255,255,0.35)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />

      <div className="relative z-10 flex items-center justify-between px-12 pt-10">
        <span className="[&_span]:!text-white">
          <Logo />
        </span>
        <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[12px] text-white/70">Client Portal</span>
      </div>

      <div className="relative z-10 flex flex-1 flex-col px-12 pb-14">
        <div aria-hidden className="pointer-events-none relative my-6 min-h-[220px] flex-1">
          {AGENT_ROLES.map((role, i) => {
            const p = POSITIONS[i];
            return (
              <motion.div
                key={role.key}
                className="absolute"
                style={{ top: p.top, left: p.left }}
                initial={{ opacity: 0, scale: 0.6, y: 20 }}
                animate={reduce ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1, scale: 1, y: [0, -10, 0] }}
                transition={
                  reduce
                    ? { duration: 0.3 }
                    : { opacity: { duration: 0.6, delay: 0.2 + i * 0.12 }, scale: { type: "spring", stiffness: 160, damping: 14, delay: 0.2 + i * 0.12 }, y: { duration: 5 + i * 0.4, repeat: Infinity, ease: "easeInOut", delay: p.delay } }
                }
              >
                <div className="rounded-[22px] bg-white/[0.06] p-1.5 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/10 backdrop-blur-sm">
                  <AgentAvatar role={role} size={p.size} />
                </div>
              </motion.div>
            );
          })}
        </div>

        <motion.div
          className="relative max-w-[460px]"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <h1 className="text-[44px] font-semibold leading-[1.04] tracking-[-0.03em]">
            Your business.
            <br />
            Your <span className="font-display text-[50px] font-normal italic tracking-normal text-[#a9b8ff]">AI team.</span>
            <br />
            One workspace.
          </h1>
          <p className="mt-5 text-[15.5px] leading-relaxed text-white/65">
            Manage leads, appointments, sales, and customer relationships with a team of AI employees built around your business.
          </p>
          <ul className="mt-8 space-y-3 text-[13.5px] text-white/75">
            <li className="flex items-center gap-3">
              <Sparkles className="size-4 text-[#a9b8ff]" aria-hidden /> Six specialised AI employees, configured in minutes
            </li>
            <li className="flex items-center gap-3">
              <CalendarCheck2 className="size-4 text-[#a9b8ff]" aria-hidden /> Real availability, real pipeline — nothing invented
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="size-4 text-[#a9b8ff]" aria-hidden /> Every customer-facing action waits for your approval
            </li>
          </ul>
        </motion.div>
      </div>
    </aside>
  );
}
