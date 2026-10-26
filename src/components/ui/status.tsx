import * as React from "react";
import { cn, initials, relativeTime, sentenceCase } from "@/lib/utils";

/**
 * The shared status vocabulary. Every status, state or recorded fact that a person scans for should be a pill with a
 * tinted surface, a hairline ring and a state dot, never loose coloured text. Use `<StatusPill status="in_progress" />`
 * to pick the tone and label from the status string, or pass `tone` and children for a custom label.
 */

export type StatusTone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet";

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

const GROUPS: Array<[StatusTone, string]> = [
  ["success", "active online connected verified approved activated completed complete done paid published live healthy resolved accepted sent delivered ready passed success succeeded enabled operational granted available ok won winning good on_track converted confirmed attended signed_in replied answered"],
  ["primary", "in_progress in_setup running busy processing provisioning scheduled new open assigned upcoming syncing sending contacted engaged qualified in_flight inprogress started"],
  ["warning", "pending invited awaiting awaiting_onboarding waiting waiting_for_client waiting_on_client needs_review pending_agency_review pending_review partial partly_connected held paused trial trialing past_due high expiring setup_required unverified draft not_invoiced invoiced requested snoozed degraded at_risk changes_requested follow_up needs_input incomplete unpaid payment_pending quote_sent on_hold"],
  ["danger", "error failed failure blocked suspended disconnected offline rejected declined overdue critical revoked expired timeout timed_out interrupted unhealthy needs_attention denied lost churned at_risk_high publication_failed bounced missed no_show cancelled_by_client defect high_risk urgent"],
  ["violet", "ready_for_review in_review final_review review under_review reviewing escalated escalation"],
  ["neutral", "disabled not_started not_configured not_connected inactive archived cancelled canceled closed none unknown queued captured skipped waived hidden n_a na idle pending_setup not_set unassigned refunded void normal medium low"],
];

const TONE_BY_STATUS = new Map<string, StatusTone>();
for (const [tone, words] of GROUPS) for (const w of words.split(" ")) if (!TONE_BY_STATUS.has(w)) TONE_BY_STATUS.set(w, tone);

/** Tone for a status string. Unknown statuses are neutral, never an accidental alarm. */
export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return "neutral";
  return TONE_BY_STATUS.get(norm(status)) ?? "neutral";
}

export function statusLabel(status: string) {
  return sentenceCase(status.trim().replace(/[-\s]+/g, "_"));
}

const PILL: Record<StatusTone, { box: string; dot: string }> = {
  neutral: { box: "bg-surface-2 text-ink-2 ring-line-strong", dot: "bg-faint" },
  primary: { box: "bg-primary-soft text-primary-ink ring-primary/20", dot: "bg-primary" },
  success: { box: "bg-success-soft text-success-ink ring-success/20", dot: "bg-success" },
  warning: { box: "bg-warning-soft text-warning-ink ring-warning/25", dot: "bg-warning" },
  danger: { box: "bg-danger-soft text-danger-ink ring-danger/20", dot: "bg-danger" },
  violet: { box: "bg-violet-soft text-violet-ink ring-violet/20", dot: "bg-violet" },
};

export function toneDotClass(tone: StatusTone) {
  return PILL[tone].dot;
}

export interface StatusPillProps {
  /** A raw status string such as "in_progress"; sets the tone and, unless children are given, the label. */
  status?: string | null;
  tone?: StatusTone;
  icon?: React.ReactNode;
  /** Show the leading state dot (default). Ignored when an icon is given. */
  dot?: boolean;
  size?: "sm" | "md";
  className?: string;
  children?: React.ReactNode;
}

/** A status with a tinted surface, hairline ring and state dot. */
export function StatusPill({ status, tone, icon, dot = true, size = "md", className, children }: StatusPillProps) {
  const resolved = tone ?? statusTone(status);
  const t = PILL[resolved];
  const label = children ?? (status ? statusLabel(status) : null);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset",
        size === "sm" ? "h-5 px-2 text-[12px]" : "h-6 px-2.5 text-[12px]",
        t.box,
        className,
      )}
    >
      {icon ?? (dot && <span aria-hidden className={cn("size-1.5 rounded-full", t.dot)} />)}
      {label}
    </span>
  );
}

/** Clock-relative text legitimately differs between the server render and hydration, so that one text node opts out of the check. */
export function RelativeTime({ value, prefix = "" }: { value: string | Date | null | undefined; prefix?: string }) {
  return (
    <span suppressHydrationWarning>
      {prefix}
      {relativeTime(value)}
    </span>
  );
}

/** A quiet chip for non-status facts (owner, count, date, channel) so they never sit as bare muted text. */
export function InfoChip({ icon, className, children }: { icon?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex h-6 max-w-full items-center gap-1.5 rounded-lg bg-surface-2/80 px-2 text-[12px] font-medium text-ink-2 ring-1 ring-inset ring-line [&>svg]:size-3 [&>svg]:shrink-0 [&>svg]:text-muted", className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#2c5bff,#5b4dff)",
  "linear-gradient(135deg,#7a5cff,#b25cf0)",
  "linear-gradient(135deg,#0b8bd9,#2c5bff)",
  "linear-gradient(135deg,#4f46e5,#2b3a9e)",
  "linear-gradient(135deg,#0ea5a4,#2c5bff)",
];

function hashOf(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic gradient monogram: the same person or company always gets the same colour. */
export function AvatarTile({ name, size = "md", className }: { name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const dims = { sm: "size-7 rounded-lg text-[12px]", md: "size-9 rounded-[10px] text-[12px]", lg: "size-12 rounded-[14px] text-[15px]" }[size];
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center font-semibold tracking-wide text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_6px_14px_-6px_rgb(44_91_255/0.55)] ring-1 ring-inset ring-white/15", dims, className)}
      style={{ background: AVATAR_GRADIENTS[hashOf(name) % AVATAR_GRADIENTS.length] }}
    >
      {initials(name)}
    </span>
  );
}
