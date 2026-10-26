import * as React from "react";
import { CalendarDays, Clock, ExternalLink, MapPin, Phone, Video } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { ManagePageView, PublicTypeSummary } from "@/server/calendars/public-booking";
import { durationLabel, formatDate, formatTimeRange, zoneLabel } from "./time";

// What a booking looks like to the customer who made it. Shared by the confirmation page (server) and the manage panel (client).

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  confirmed: { label: "Confirmed", tone: "success" },
  new: { label: "Waiting for confirmation", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "danger" },
  showed: { label: "Completed", tone: "neutral" },
  noshow: { label: "Missed", tone: "neutral" },
};

export function LocationIcon({ kind, className }: { kind: PublicTypeSummary["locationKind"]; className?: string }) {
  const Icon = kind === "phone" ? Phone : kind === "video" ? Video : MapPin;
  return <Icon className={className} aria-hidden />;
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: "Booked", tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Link-styled as a secondary button. A plain anchor, so downloads and other apps (mail, phone) open the way the browser intends. */
export const secondaryLinkClass =
  "inline-flex h-11 select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-soft transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10";

export function AppointmentDetails({ view, className }: { view: ManagePageView; className?: string }) {
  const a = view.appointment;
  const cancelled = a.status === "cancelled";
  return (
    <div className={className}>
      <p className="text-[13px] font-medium text-muted">{view.business.name}</p>
      <h2 className={cn("mt-1 text-[19px] font-semibold tracking-[-0.025em] text-ink", cancelled && "text-muted line-through decoration-1")}>{a.typeName}</h2>
      <dl className="mt-4 space-y-3 text-[14px]">
        <div>
          <dt className="sr-only">Date</dt>
          <dd className="flex gap-3 text-ink"><CalendarDays className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />{formatDate(a.startAt, a.timeZone)}</dd>
        </div>
        <div>
          <dt className="sr-only">Time</dt>
          <dd className="flex gap-3 text-ink">
            <Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span>
              <span className="tabular-nums">{formatTimeRange(a.startAt, a.endAt, a.timeZone)}</span>
              <span className="text-muted"> · {zoneLabel(a.timeZone, new Date(a.startAt).getTime())} · {durationLabel(a.durationMinutes)}</span>
            </span>
          </dd>
        </div>
        {a.location && (
          <div>
            <dt className="sr-only">Where</dt>
            <dd className="flex min-w-0 gap-3 break-words text-ink"><MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0">{a.location}</span></dd>
          </div>
        )}
        {a.meetingLink && !cancelled && (
          <div>
            <dt className="sr-only">Meeting link</dt>
            <dd className="flex min-w-0 gap-3">
              <Video className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              <a href={a.meetingLink} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 break-all font-medium text-primary-ink underline-offset-2 hover:underline">
                Join the video call<ExternalLink className="size-3.5 shrink-0" aria-hidden /><span className="sr-only"> (opens in a new tab)</span>
              </a>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
