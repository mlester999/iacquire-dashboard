"use client";

import * as React from "react";
import { CheckCircle2, CircleDashed, HelpCircle, Plug, TriangleAlert, XCircle } from "lucide-react";
import { StatusPill, type StatusTone } from "@/components/ui/status";
import { OPS_EMPLOYEE_STATE_LABEL, OPS_STATE_LABEL, type OpsEmployeeState, type OpsHealthState } from "@/lib/aqi/ops/types";

/**
 * State is never conveyed by colour alone: each state has its own icon and word. "Unknown" and "Not
 * configured" are deliberately neutral, never green, so missing evidence cannot look like good news.
 */
const HEALTH: Record<OpsHealthState, { tone: StatusTone; icon: React.ReactNode }> = {
  healthy: { tone: "success", icon: <CheckCircle2 className="size-3.5" aria-hidden /> },
  degraded: { tone: "warning", icon: <TriangleAlert className="size-3.5" aria-hidden /> },
  unavailable: { tone: "danger", icon: <XCircle className="size-3.5" aria-hidden /> },
  unknown: { tone: "neutral", icon: <HelpCircle className="size-3.5" aria-hidden /> },
  not_configured: { tone: "neutral", icon: <Plug className="size-3.5" aria-hidden /> },
};

export function OpsStatePill({ state, size = "md" }: { state: OpsHealthState; size?: "sm" | "md" }) {
  const h = HEALTH[state];
  return <StatusPill tone={h.tone} icon={h.icon} size={size}>{OPS_STATE_LABEL[state]}</StatusPill>;
}

const EMPLOYEE: Record<OpsEmployeeState, StatusTone> = {
  working: "primary", scheduled: "primary", queued: "primary", waiting_for_approval: "warning", blocked: "warning", idle: "neutral",
  offline: "danger", setup_required: "warning", failed: "danger", unknown: "neutral",
};

export function OpsEmployeePill({ state }: { state: OpsEmployeeState }) {
  return <StatusPill tone={EMPLOYEE[state]} icon={state === "unknown" ? <CircleDashed className="size-3.5" aria-hidden /> : undefined}>{OPS_EMPLOYEE_STATE_LABEL[state]}</StatusPill>;
}

export const tileAccent: Record<OpsHealthState, string> = {
  healthy: "before:bg-success",
  degraded: "before:bg-warning",
  unavailable: "before:bg-danger",
  unknown: "before:bg-faint",
  not_configured: "before:bg-faint",
};
