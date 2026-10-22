import * as React from "react";
import {
  Flame, Gauge, PhoneMissed, ArrowRightLeft, Ban, BellRing, Bot, CircleCheck, CircleDashed, CircleX, Clock, FlaskConical, GitBranch, Globe, Handshake, Hourglass, Inbox, ListTodo, Loader2, MessageSquareText, OctagonX, PencilLine, Send, ShieldAlert,
  SkipForward, Star, StickyNote, Tag, Tags, UserCheck, Webhook, Workflow, Zap, type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

// Shared labels, tones and icons for the workflow screens. The status vocabularies are the database's (0032_crm_automation.sql).

export type WorkflowStatus = "draft" | "active" | "paused" | "archived";
export type RunStatus = "queued" | "running" | "waiting" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "dead";
export type StepStatus = "running" | "completed" | "skipped" | "failed" | "waiting" | "awaiting_approval" | "cancelled";
export type StartedVia = "event" | "manual" | "schedule" | "webhook" | "test";
type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet" | "outline";

export const WORKFLOW_STATUS: Record<WorkflowStatus, { label: string; tone: Tone; hint: string }> = {
  draft: { label: "Draft", tone: "neutral", hint: "Not running. Publish and turn it on when it's ready." },
  active: { label: "Active", tone: "success", hint: "Starts for every matching event." },
  paused: { label: "Paused", tone: "warning", hint: "Nothing new starts. Runs already waiting hold until you resume." },
  archived: { label: "Archived", tone: "outline", hint: "Hidden and never runs." },
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "primary" },
  waiting: { label: "Waiting", tone: "violet" },
  awaiting_approval: { label: "Needs approval", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "outline" },
  dead: { label: "Stopped after retries", tone: "danger" },
};
export const RUN_STATUSES = Object.keys(RUN_STATUS) as RunStatus[];
/** Runs that can still do something, so they can be cancelled. */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "waiting", "awaiting_approval"];

export const STEP_STATUS: Record<StepStatus, { label: string; tone: Tone; icon: LucideIcon; iconClass: string }> = {
  running: { label: "Running", tone: "primary", icon: Loader2, iconClass: "text-primary" },
  completed: { label: "Done", tone: "success", icon: CircleCheck, iconClass: "text-success" },
  skipped: { label: "Skipped", tone: "neutral", icon: SkipForward, iconClass: "text-muted" },
  failed: { label: "Failed", tone: "danger", icon: CircleX, iconClass: "text-danger" },
  waiting: { label: "Waiting", tone: "violet", icon: Hourglass, iconClass: "text-violet" },
  awaiting_approval: { label: "Needs approval", tone: "warning", icon: ShieldAlert, iconClass: "text-warning" },
  cancelled: { label: "Cancelled", tone: "outline", icon: Ban, iconClass: "text-muted" },
};

export const STARTED_VIA: Record<StartedVia, string> = {
  event: "From an event",
  manual: "Started by a person",
  schedule: "On schedule",
  webhook: "From an incoming webhook",
  test: "Test run",
};

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  const s = WORKFLOW_STATUS[status] ?? WORKFLOW_STATUS.draft;
  return (
    <Badge tone={s.tone} title={s.hint}>
      {status === "active" && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {s.label}
    </Badge>
  );
}

export function RunStatusBadge({ status, test }: { status: RunStatus; test?: boolean }) {
  const s = RUN_STATUS[status] ?? RUN_STATUS.queued;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={s.tone}>{s.label}</Badge>
      {test && <Badge tone="violet"><FlaskConical className="size-3" aria-hidden />Test</Badge>}
    </span>
  );
}

export function StepStatusIcon({ status, className }: { status: StepStatus; className?: string }) {
  const s = STEP_STATUS[status] ?? STEP_STATUS.running;
  const Icon = s.icon;
  return <Icon className={cn("size-4 shrink-0", s.iconClass, status === "running" && "animate-spin", className)} aria-hidden />;
}

/** Icons per step kind. A kind the catalog adds later falls back to a neutral icon rather than failing. */
export const STEP_ICONS: Record<string, LucideIcon> = {
  wait: Clock,
  branch: GitBranch,
  add_tag: Tag,
  remove_tag: Tags,
  assign: UserCheck,
  create_task: ListTodo,
  update_field: PencilLine,
  create_opportunity: Handshake,
  move_stage: ArrowRightLeft,
  send_message: Send,
  request_review: Star,
  notify_team: BellRing,
  internal_note: StickyNote,
  request_reassessment: Gauge,
  set_priority: Flame,
  recovery_check: PhoneMissed,
  n8n: Workflow,
  webhook: Webhook,
  http_request: Globe,
  slack_message: MessageSquareText,
  ai_task: Bot,
  conversation_action: Inbox,
  end: OctagonX,
};

export function StepIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = STEP_ICONS[kind] ?? CircleDashed;
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden />;
}

/** Colour family per kind, so a long canvas scans by what each step does: timing, logic, records, messages, outside systems. */
export function stepTone(kind: string): string {
  switch (kind) {
    case "wait":
      return "bg-violet-soft text-violet-ink";
    case "branch":
    case "end":
      return "bg-surface-3 text-ink-2";
    case "send_message":
    case "request_review":
    case "notify_team":
    case "conversation_action":
      return "bg-primary-soft text-primary-ink";
    case "n8n":
    case "webhook":
    case "http_request":
    case "slack_message":
    case "ai_task":
      return "bg-warning-soft text-warning-ink";
    default:
      return "bg-success-soft text-success-ink";
  }
}

export function TriggerIcon({ className }: { className?: string }) {
  return <Zap className={cn("size-4 shrink-0", className)} aria-hidden />;
}
