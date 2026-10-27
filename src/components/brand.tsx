"use client";

import * as React from "react";
import Image from "next/image";
import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { StatusPill, type StatusTone } from "@/components/ui/status";
import { AGENT_STATUS_LABEL, type AgentRoleMeta, type AgentStatus } from "@/lib/agents";

export function LogoMark({ className, title = "iAcquire" }: { className?: string; title?: string }) {
  return (
    <Image
      src="/brand/iacquire-mark.png"
      alt={title}
      width={1280}
      height={1280}
      sizes="48px"
      draggable={false}
      className={cn("size-8 shrink-0 object-contain drop-shadow-[0_3px_10px_rgba(91,77,255,0.2)]", className)}
    />
  );
}

/** The supplied full lockup sits on a white tile for contrast; compact placements use the standalone mark. */
export function Logo({ className, compact, tone = "auto" }: { className?: string; compact?: boolean; tone?: "auto" | "inverse" }) {
  return (
    <span data-tone={tone} className={cn("logo inline-flex items-center", className)}>
      {compact ? (
        <LogoMark className="size-8" />
      ) : (
        <span className="inline-flex h-11 w-[150px] shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white px-1 ring-1 ring-black/5 shadow-sm">
          <Image
            src="/brand/iacquire-lockup.png"
            alt="iAcquireOS"
            width={1456}
            height={1024}
            sizes="150px"
            loading="eager"
            draggable={false}
            className="h-full w-full object-cover object-[50%_52%]"
          />
        </span>
      )}
    </span>
  );
}

const SIZES = { xs: 24, sm: 32, md: 40, lg: 56, xl: 88 } as const;

export function AgentAvatar({
  role,
  size = "md",
  thinking,
  className,
  decorative = true,
  eager = false,
}: {
  role: Pick<AgentRoleMeta, "mascot" | "accent" | "shortName">;
  size?: keyof typeof SIZES;
  thinking?: boolean;
  className?: string;
  decorative?: boolean;
  /** Load the image immediately. For avatars in a hidden-until-opened panel, where lazy loading would show an empty tile. */
  eager?: boolean;
}) {
  const px = SIZES[size];
  const reduce = useReducedMotion();
  const radius = px >= 56 ? 18 : px >= 40 ? 12 : 9;
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: px, height: px }}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : role.shortName}
      aria-hidden={decorative || undefined}
    >
      {thinking && !reduce && (
        <span
          className="absolute inset-0 animate-pulse-ring"
          style={{ borderRadius: radius, boxShadow: `0 0 0 2px ${role.accent}` }}
        />
      )}
      <motion.span
        className="relative flex size-full items-center justify-center overflow-hidden border border-black/5 dark:border-white/10"
        style={{
          borderRadius: radius,
          background: `radial-gradient(120% 120% at 30% 15%, ${role.accent}38, ${role.accent}14 60%, transparent), var(--surface-2)`,
        }}
        animate={thinking && !reduce ? { y: [0, -2, 0], rotate: [0, -2, 0] } : { y: 0, rotate: 0 }}
        transition={thinking && !reduce ? { duration: 1.4, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${role.mascot}-${px > 64 ? 256 : 128}.webp`}
          srcSet={`${role.mascot}-128.webp 128w, ${role.mascot}-256.webp 256w, ${role.mascot}-512.webp 512w`}
          sizes={`${px}px`}
          alt=""
          width={px}
          height={px}
          className="size-[82%] object-contain"
          draggable={false}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
        />
      </motion.span>
    </span>
  );
}

const STATUS_STYLE: Record<AgentStatus, { dot: string; tone: StatusTone; pulse: boolean }> = {
  online: { dot: "bg-success", tone: "success", pulse: true },
  busy: { dot: "bg-primary", tone: "primary", pulse: true },
  provisioning: { dot: "bg-violet", tone: "violet", pulse: true },
  setup_required: { dot: "bg-warning", tone: "warning", pulse: false },
  offline: { dot: "bg-danger", tone: "danger", pulse: false },
  error: { dot: "bg-danger", tone: "danger", pulse: false },
  disabled: { dot: "bg-faint", tone: "neutral", pulse: false },
};

export function StatusDot({ status, className, label }: { status: AgentStatus; className?: string; label?: string }) {
  const s = STATUS_STYLE[status];
  const text = label ?? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return (
    <span className={cn("relative inline-flex size-2", className)} title={text}>
      {s.pulse && <span aria-hidden className={cn("absolute inset-0 rounded-full animate-pulse-ring", s.dot)} />}
      <span aria-hidden className={cn("relative inline-flex size-2 rounded-full ring-2 ring-[color:var(--dot-ring,var(--surface))]", s.dot)} />
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** An AI employee's connection state as a tinted pill with a live state dot (pulsing while working or being set up). */
export function AgentStatusBadge({ status, className, size = "md" }: { status: AgentStatus; className?: string; size?: "sm" | "md" }) {
  const s = STATUS_STYLE[status];
  return (
    <StatusPill
      tone={s.tone}
      size={size}
      className={className}
      icon={
        <span className="relative inline-flex size-1.5" aria-hidden>
          {s.pulse && <span className={cn("absolute inset-0 rounded-full animate-pulse-ring", s.dot)} />}
          <span className={cn("relative inline-flex size-1.5 rounded-full", s.dot)} />
        </span>
      }
    >
      {AGENT_STATUS_LABEL[status]}
    </StatusPill>
  );
}

export function AnimatedNumber({
  value,
  format = (n) => new Intl.NumberFormat("en-US").format(Math.round(n)),
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const reduce = useReducedMotion();
  const fmt = React.useRef(format);
  React.useEffect(() => {
    fmt.current = format;
  });
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const format = fmt.current;
    if (reduce || !inView) {
      node.textContent = format(value);
      return;
    }
    const controls = animate(0, value, {
      duration: Math.min(1.4, 0.5 + Math.log10(Math.max(10, value)) * 0.25),
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        node.textContent = format(v);
      },
    });
    return () => controls.stop();
  }, [value, inView, reduce]);
  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}

export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)} aria-hidden>
      <span className="thinking-dot size-1.5 rounded-full bg-current" />
      <span className="thinking-dot size-1.5 rounded-full bg-current" />
      <span className="thinking-dot size-1.5 rounded-full bg-current" />
    </span>
  );
}
