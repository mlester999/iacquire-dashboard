import * as React from "react";
import { Mail, MessageCircle, MessageSquareText, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { BLOCK_REASON_LABELS, CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { formatUsd } from "@/lib/billing";
import type { ApprovalState, CampaignCounts, CampaignNotice, CampaignStatus, RecipientStatus } from "@/server/crm/campaigns";

// Shared labels, tones and small pieces for the campaign screens. The vocabularies are the database's (0033_crm_growth.sql) and the
// service's (src/server/crm/campaigns.ts): this file only words them.

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet" | "outline";

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; tone: Tone; hint: string }> = {
  draft: { label: "Draft", tone: "neutral", hint: "Being prepared. Nothing is sent until the owner approves it." },
  awaiting_approval: { label: "Awaiting approval", tone: "warning", hint: "Waiting for the workspace owner to approve exactly what it sends." },
  scheduled: { label: "Scheduled", tone: "primary", hint: "Approved. It starts at its scheduled time." },
  sending: { label: "Sending", tone: "violet", hint: "Queuing messages at its approved pace." },
  paused: { label: "Paused", tone: "warning", hint: "Nothing more is queued until the owner resumes it." },
  completed: { label: "Completed", tone: "success", hint: "Everyone on the list was sent the message or left out with a reason." },
  cancelled: { label: "Cancelled", tone: "outline", hint: "Stopped for good." },
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const s = CAMPAIGN_STATUS[status] ?? CAMPAIGN_STATUS.draft;
  return (
    <Badge tone={s.tone} title={s.hint}>
      {status === "sending" && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {s.label}
    </Badge>
  );
}

export const APPROVAL_STATE: Record<ApprovalState, { label: string; tone: Tone }> = {
  none: { label: "Not requested", tone: "neutral" },
  pending: { label: "Waiting for the owner", tone: "warning" },
  approved: { label: "Approved by the owner", tone: "success" },
  expired: { label: "Request expired", tone: "outline" },
  declined: { label: "Sent back", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "outline" },
};

export const CHANNEL_ICON: Record<Channel, LucideIcon> = { email: Mail, sms: MessageSquareText, whatsapp: MessageCircle };

export function ChannelLabel({ channel, className }: { channel: Channel; className?: string }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className={className ?? "inline-flex items-center gap-1.5 text-[12.5px] text-ink-2"}>
      <Icon className="size-3.5 text-muted" aria-hidden />
      {CHANNEL_LABELS[channel]}
    </span>
  );
}

export const RECIPIENT_STATUS: Record<RecipientStatus, { label: string; tone: Tone }> = {
  pending: { label: "Not yet", tone: "neutral" },
  excluded: { label: "Left out", tone: "outline" },
  queued: { label: "Queued", tone: "primary" },
  sent: { label: "Sent", tone: "violet" },
  delivered: { label: "Delivered", tone: "success" },
  failed: { label: "Not delivered", tone: "danger" },
  bounced: { label: "Bounced", tone: "danger" },
  unsubscribed: { label: "Unsubscribed", tone: "warning" },
};

/** Why someone was left out (or wasn't delivered to), in plain words. */
export function reasonLabel(reason: string | null | undefined, channel: Channel): string {
  if (!reason) return "";
  const address = channel === "email" ? "email address" : "mobile number";
  switch (reason) {
    case "no_address": return `No ${address} on file`;
    case "suppressed": return "Opted out or bounced before (suppressed)";
    case "consent_withdrawn": return `Withdrew consent to ${CHANNEL_LABELS[channel]} marketing`;
    case "no_marketing_consent": return `Hasn't agreed to ${CHANNEL_LABELS[channel]} marketing`;
    case "missing_values": return "Missing a detail the message uses";
    case "deleted": return "Contact was deleted";
    case "archived": return "Contact was archived";
    case "frequency_limit": return "Reached the 30-day limit for program and campaign messages";
    case "template_mismatch": return "Message didn't fit the approved WhatsApp template";
    case "not_linked": return "Not linked to the CRM this channel sends through";
    case "wait_expired": return "Couldn't be reached within 7 days (quiet hours, business hours or spacing)";
    case "campaign_cancelled": return "The campaign was cancelled before their turn";
    case "provider_error": return "The provider didn't accept it";
    case "bounce": return "Bounced: the provider says the address doesn't work";
    case "quiet_hours": return "Waiting for quiet hours to end";
    case "outside_business_hours": return "Waiting for business hours";
    case "retention_too_soon": return "Waiting: had a message from you recently";
    case "provider_switching": return "Waiting for the provider switch to finish";
  }
  if (reason.startsWith("waiting:")) return reasonLabel(reason.slice(8).split("|")[0], channel) || "Waiting for a better time";
  if (reason.startsWith("blocked:")) {
    const r = reason.slice(8);
    return `Held by a send rule: ${(BLOCK_REASON_LABELS[r] ?? r.replaceAll("_", " ")).replace(/^./, (s) => s.toLowerCase())}`;
  }
  return reason.replaceAll("_", " ");
}

export const NOTICE_TITLE: Record<CampaignNotice["code"], string> = {
  paused: "Paused",
  credits: "Stopped: service credits ran out",
  budget: "Stopped: monthly spending limit",
  channel: "Stopped: the channel isn't available",
  price: "Stopped: no published price",
  template_changed: "Stopped: the approved message no longer stands",
  approval_void: "The approval no longer applies",
  too_large: "Stopped: the list is too large",
  provider: "Stopped: contacts are managed elsewhere",
  list_unavailable: "Stopped: the Smart List isn't available",
  returned: "Sent back by the owner",
  workspace_paused: "Waiting: automation is paused for this workspace",
  missing_values: "Stopped: a detail the message needs is empty",
};

export const money = (micros: number | null | undefined) => (micros === null || micros === undefined ? null : formatUsd(micros, { precise: micros < 10_000 }));

/** People who have had the message leave (handed to the provider), whatever happened next. */
export const handedOver = (c: CampaignCounts) => c.sent + c.delivered + c.unsubscribed + c.bounced + c.failed;

export function Fingerprint({ hash }: { hash: string | null | undefined }) {
  if (!hash) return null;
  return <span className="font-mono text-[11.5px] text-muted" title={hash}>#{hash.slice(0, 10)}</span>;
}

/** Counts as a compact, readable row (each with its label), for lists and summaries. */
export function CountChips({ counts, className }: { counts: CampaignCounts; className?: string }) {
  const items = [
    { label: "recipients", value: counts.total },
    { label: "sent", value: counts.sent + counts.delivered + counts.unsubscribed },
    { label: "delivered", value: counts.delivered },
    { label: "left out", value: counts.excluded },
    { label: "not delivered", value: counts.failed + counts.bounced },
  ];
  return (
    <p className={className ?? "text-[12.5px] tabular-nums text-muted"}>
      {items.map((i, n) => (
        <React.Fragment key={i.label}>
          {n > 0 && <span aria-hidden> · </span>}
          <span className={i.label === "not delivered" && i.value ? "text-danger-ink" : undefined}>{i.value.toLocaleString("en-US")} {i.label}</span>
        </React.Fragment>
      ))}
    </p>
  );
}
