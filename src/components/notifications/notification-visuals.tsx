import * as React from "react";
import {
  AlertTriangle,
  Bell,
  BookOpen,
  Bot,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Contact,
  CreditCard,
  FolderKanban,
  Gauge,
  Globe,
  LifeBuoy,
  MessageSquareWarning,
  Plug,
  Settings2,
  ShieldCheck,
  Siren,
  Sparkles,
  UserRound,
  Wrench,
  XCircle,
} from "lucide-react";
import { IconTile, type PanelTone } from "@/components/settings/panel";
import {
  absoluteNotificationTime,
  compactRelativeTime,
  notificationCategory,
  type NotificationCategoryKey,
  type NotificationTone,
} from "@/lib/notification-presentation";
import { cn } from "@/lib/utils";

const CATEGORY_ICON: Record<NotificationCategoryKey, React.ReactNode> = {
  approvals: <ShieldCheck />,
  workforce: <Bot />,
  connectivity: <Plug />,
  support: <LifeBuoy />,
  onboarding: <ClipboardCheck />,
  billing: <CreditCard />,
  projects: <FolderKanban />,
  maintenance: <Wrench />,
  website: <Globe />,
  operations: <Siren />,
  account: <UserRound />,
  calendar: <CalendarClock />,
  knowledge: <BookOpen />,
  crm: <Contact />,
  messaging: <MessageSquareWarning />,
  usage: <Gauge />,
  system: <Settings2 />,
};

/** A few notification kinds have a more specific symbol than their category. */
const KIND_ICON: Record<string, React.ReactNode> = {
  approval_decided: <CheckCircle2 />,
  approval_requested: <ShieldCheck />,
  agent_status: <Bot />,
  agent_task_completed: <Sparkles />,
  integration_disconnected: <Plug />,
  integration_reconnect_required: <Plug />,
  support_reply: <LifeBuoy />,
  support_ticket_created: <LifeBuoy />,
  setup_issue: <AlertTriangle />,
  setup_ready: <CheckCircle2 />,
  incident_opened: <Siren />,
  incident_recovered: <CheckCircle2 />,
  billing_payment_failed: <CreditCard />,
  billing_credits_exhausted: <CreditCard />,
  knowledge_update_ready: <BookOpen />,
};

function severityTone(severity: string): NotificationTone | null {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  if (severity === "success") return "success";
  return null;
}

const DOT: Record<NotificationTone, string> = {
  neutral: "bg-faint",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  violet: "bg-violet",
};

/** The icon and tint for one notification, chosen from its saved kind and severity. */
export function NotificationTypeIcon({
  kind,
  severity,
  size = "md",
  className,
}: {
  kind: string;
  severity: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const category = notificationCategory(kind);
  const tone: PanelTone = severityTone(severity) ?? category.tone;
  const icon = KIND_ICON[kind] ?? CATEGORY_ICON[category.key] ?? <Bell />;
  return <IconTile icon={icon} tone={tone} size={size} className={className} />;
}

/**
 * A small, intentional timestamp surface. The relative value ticks with the caller's clock; the
 * absolute value (with the workspace time zone) is always available on hover and to assistive tech.
 */
export function NotificationTimestamp({
  value,
  timeZone,
  now,
  className,
}: {
  value: string | Date | null | undefined;
  timeZone: string;
  now: number;
  className?: string;
}) {
  const relative = compactRelativeTime(value, now, timeZone);
  const absolute = absoluteNotificationTime(value, timeZone);
  const dateTime = value ? (value instanceof Date ? value.toISOString() : value) : undefined;
  return (
    <time
      dateTime={dateTime}
      title={absolute}
      aria-label={`${relative}, ${absolute}`}
      className={cn(
        "inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-md bg-surface-2/80 px-1.5 text-[12px] font-medium tabular-nums text-muted ring-1 ring-inset ring-line",
        className,
      )}
    >
      <Clock className="size-3 shrink-0 text-faint" aria-hidden />
      <span suppressHydrationWarning className="truncate">{relative}</span>
    </time>
  );
}

/** The saved notification category, kept quiet so the row's title stays the primary signal. */
export function NotificationCategoryChip({ kind, className }: { kind: string; className?: string }) {
  const category = notificationCategory(kind);
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-0 max-w-full items-center gap-1.5 rounded-md bg-surface-2/70 px-1.5 text-[12px] font-semibold uppercase tracking-[.08em] text-muted ring-1 ring-inset ring-line",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[category.tone])} />
      <span className="truncate">{category.label}</span>
    </span>
  );
}

/** A single severity mark for a row that already has a category icon. */
export function NotificationSeverityMark({ severity }: { severity: string }) {
  if (severity !== "critical" && severity !== "warning") return null;
  return severity === "critical" ? (
    <XCircle className="size-3.5 shrink-0 text-danger" aria-label="Critical" />
  ) : (
    <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-label="Needs attention" />
  );
}
