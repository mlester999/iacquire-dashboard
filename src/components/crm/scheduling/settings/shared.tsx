"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { TAG_COLORS } from "@/lib/crm/types";
import type { Assignment, BookingPageBlocker, BookingPageView, LocationKind } from "@/server/calendars/setup";

export const ASSIGNMENT_INFO: Record<Assignment, { label: string; short: string; explain: string }> = {
  single: { label: "One person", short: "One person", explain: "Every booking goes to the same host. Times come from their working hours." },
  round_robin: { label: "Round robin", short: "Round robin", explain: "Each booking goes to one host who is free at that time, shared out between the hosts." },
  collective: { label: "Collective", short: "Everyone attends", explain: "All hosts attend together, so a time is only offered when every one of them is free." },
};

export const ROUND_ROBIN_INFO: Record<"balanced" | "priority", { label: string; explain: string }> = {
  balanced: { label: "Balanced", explain: "The free host who was booked least recently gets the next booking, so work evens out." },
  priority: { label: "By priority", explain: "The free host with the highest priority gets the booking; others take it when they're busy." },
};

export const LOCATION_INFO: Record<LocationKind, { label: string; detailLabel: string | null; placeholder: string }> = {
  phone: { label: "Phone call", detailLabel: "Call details", placeholder: "We'll call the number you give us" },
  video: { label: "Video call", detailLabel: "Joining details", placeholder: "How to join, if you're not using a meeting link below" },
  in_person: { label: "In person", detailLabel: "Address", placeholder: "Unit 4, 12 Mango Street, Makati" },
  custom: { label: "Somewhere else", detailLabel: "Where", placeholder: "At the property, or wherever you agree" },
  none: { label: "Not needed", detailLabel: null, placeholder: "" },
};

/** What a draft calendar is, in one sentence shared by every screen that shows one. */
export const DRAFT_EXPLAINER = "A draft takes no bookings: it has no booking page, isn't offered to your team, your AI Appointment Setter or your website, and can't be the default until it is verified and activated.";

/** Marks a calendar that takes no bookings yet. */
export function DraftBadge() {
  return <Badge tone="violet">Draft</Badge>;
}

export function BookingStatusBadge({ page }: { page: BookingPageView | undefined }) {
  if (!page) return null;
  if (page.status === "draft") return <Badge tone="neutral">No bookings while a draft</Badge>;
  if (page.live) return <Badge tone="success">Booking page live</Badge>;
  if (!page.public) return <Badge tone="neutral">Booking page off</Badge>;
  return <Badge tone="warning">Booking page not live yet</Badge>;
}

/** Booking page problems in plain words, each with the place to fix it. */
export function blockerText(b: BookingPageBlocker, base: string, calendarId: string): { text: string; fix?: { label: string; href: string } } {
  switch (b.code) {
    case "draft":
      return { text: "This calendar is a draft, so it takes no bookings until it is verified and activated.", fix: { label: "Verify and activate", href: `${base}/calendars/${calendarId}#verify` } };
    case "calendar_private":
      return { text: "The booking page is turned off." };
    case "no_hosts":
      return { text: "Nobody active hosts this calendar.", fix: { label: "Choose hosts", href: `${base}/calendars/${calendarId}` } };
    case "not_accepting":
      return { text: "Every host has paused new bookings.", fix: { label: "Open availability", href: `${base}/availability` } };
    case "no_hours": {
      const names = b.people.map((p) => p.name);
      const who = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
      return { text: `${who} ${names.length === 1 ? "has" : "have"} no weekly hours, so no time can be offered.`, fix: { label: "Set hours", href: `${base}/availability?person=${b.people[0]?.userId ?? ""}` } };
    }
    case "no_types":
      return { text: "There are no appointment types to book.", fix: { label: "Add an appointment type", href: `${base}/calendars/${calendarId}` } };
    case "no_public_types":
      return { text: "Every appointment type is hidden from the page.", fix: { label: "Show a type", href: `${base}/calendars/${calendarId}` } };
  }
}

export function BlockerList({ blockers, base, calendarId, skip = [] }: { blockers: BookingPageBlocker[]; base: string; calendarId: string; skip?: BookingPageBlocker["code"][] }) {
  const shown = blockers.filter((b) => !skip.includes(b.code));
  if (!shown.length) return null;
  return (
    <ul className="space-y-1.5" aria-label="Why this page isn't live">
      {shown.map((b) => {
        const t = blockerText(b, base, calendarId);
        return (
          <li key={b.code} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] text-ink-2">
            <span className="mt-1.5 size-1.5 shrink-0 self-start rounded-full bg-warning" aria-hidden />
            <span className="min-w-0 flex-1">{t.text}</span>
            {t.fix && <Link href={t.fix.href} className="font-medium text-primary hover:underline">{t.fix.label}</Link>}
          </li>
        );
      })}
    </ul>
  );
}

/** A row of colour swatches as real radio buttons, so arrow keys move between them. */
export function ColorPicker({ value, onChange, label, name }: { value: string | null; onChange: (c: string | null) => void; label: string; name: string }) {
  return (
    <fieldset>
      <legend className="text-[14px] font-medium text-ink-2">{label}</legend>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {[null, ...TAG_COLORS].map((c) => (
          <label key={c ?? "none"} className="inline-flex size-11 cursor-pointer items-center justify-center rounded-full sm:size-8">
            <input type="radio" name={name} className="peer sr-only" checked={value === c} onChange={() => onChange(c)} aria-label={c ? `Colour ${c}` : "No colour"} />
            <span
              aria-hidden
              className={cn("size-6 rounded-full peer-checked:ring-2 peer-checked:ring-primary peer-checked:ring-offset-2 peer-checked:ring-offset-surface peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-primary", !c && "border border-dashed border-line-strong")}
              style={c ? { background: c } : undefined}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ColorDot({ color, className }: { color: string | null; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", !color && "border border-line-strong", className)} style={color ? { background: color } : undefined} />;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and some embedded views: fall back to a temporary selection.
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      el.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label, size = "sm" }: { text: string; label: string; size?: "sm" | "icon-sm" }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="secondary"
      size={size}
      aria-label={size === "icon-sm" ? label : undefined}
      onClick={async () => {
        if (await writeClipboard(text)) {
          setCopied(true);
          toast.success("Link copied.");
        } else toast.error("Couldn't copy. Select the link and copy it instead.");
      }}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {size === "sm" && (copied ? "Copied" : "Copy link")}
    </Button>
  );
}

/**
 * Runs `reset` at the moment `open` turns true, during render (React's recommended way to reset state when an input changes), so a
 * dialog always opens with fresh values and no effect has to set state after the fact.
 */
export function useResetOnOpen(open: boolean, reset: () => void) {
  const [was, setWas] = React.useState(open);
  if (open !== was) {
    setWas(open);
    if (open) reset();
  }
}

/** A labelled switch row: the label names the setting, the hint says what it does. */
export function SettingRow({ id, label, hint, control }: { id: string; label: React.ReactNode; hint?: React.ReactNode; control: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[14px] font-medium text-ink-2">{label}</label>
        {hint && <div id={`${id}-hint`} className="mt-0.5 text-[13px] leading-relaxed text-muted">{hint}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}
