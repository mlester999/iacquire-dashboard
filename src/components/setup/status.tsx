"use client";

import * as React from "react";
import { motion } from "motion/react";
import { Ban, Check, CircleDashed, Eye, Loader2, UserRound } from "lucide-react";
import { StatusPill } from "@/components/ui/status";
import { CLIENT_STATUS_LABEL, STATUS_LABEL, type TaskStatus } from "@/lib/setup";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet";

export const STATUS_TONE: Record<TaskStatus, Tone> = {
  pending: "neutral",
  in_progress: "primary",
  waiting_for_client: "warning",
  ready_for_review: "violet",
  completed: "success",
  blocked: "danger",
};

const ICON_BOX: Record<TaskStatus, string> = {
  pending: "border-line bg-surface-2 text-faint",
  in_progress: "border-transparent bg-primary-soft text-primary",
  waiting_for_client: "border-transparent bg-warning-soft text-warning-ink",
  ready_for_review: "border-transparent bg-violet-soft text-violet-ink",
  completed: "border-transparent bg-success text-white shadow-[0_6px_16px_-8px_var(--success)]",
  blocked: "border-transparent bg-danger-soft text-danger-ink",
};

export function StatusIcon({ status, className, size = "md" }: { status: TaskStatus; className?: string; size?: "sm" | "md" }) {
  const px = size === "sm" ? "size-7" : "size-9";
  const icon = size === "sm" ? "size-3.5" : "size-[18px]";
  return (
    <span className={cn("relative flex shrink-0 items-center justify-center rounded-full border", px, ICON_BOX[status], className)} aria-hidden>
      {status === "waiting_for_client" && <span className="absolute inset-0 animate-ping rounded-full bg-warning/25 [animation-duration:2.4s] motion-reduce:hidden" />}
      {status === "pending" && <CircleDashed className={icon} />}
      {status === "in_progress" && <Loader2 className={cn(icon, "animate-spin [animation-duration:2.6s] motion-reduce:animate-none")} />}
      {status === "waiting_for_client" && <UserRound className={cn(icon, "relative")} />}
      {status === "ready_for_review" && <Eye className={icon} />}
      {status === "blocked" && <Ban className={icon} />}
      {status === "completed" && (
        <motion.span key="done" className="page-in" initial={false} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 380, damping: 18 }}>
          <Check className={icon} strokeWidth={3} />
        </motion.span>
      )}
    </span>
  );
}

export function StatusBadge({ status, audience = "agency", className }: { status: TaskStatus; audience?: "agency" | "client"; className?: string }) {
  return (
    <StatusPill tone={STATUS_TONE[status]} className={className}>
      {(audience === "client" ? CLIENT_STATUS_LABEL : STATUS_LABEL)[status]}
    </StatusPill>
  );
}
