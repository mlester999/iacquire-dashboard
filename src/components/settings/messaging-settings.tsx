"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, Clock, Lock, Mail, MessageCircle, MessageSquareText, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { setChannelEnabledAction, updateMessagingSettingsAction } from "@/app/actions/inbox";
import { CHANNEL_LABELS, FOLLOW_UP_PRESETS, WEEKDAYS, type BusinessHours, type Channel, type Weekday } from "@/lib/messaging";
import { cn } from "@/lib/utils";
import type { MessagingSettingsView } from "@/server/messaging/inbox";

const ICONS: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const DAY_LABEL: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const DAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

type Hours = Record<Weekday, { open: boolean; from: string; to: string }>;
const toHours = (h: BusinessHours): Hours =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, { open: Boolean(h[d]?.length), from: h[d]?.[0]?.[0] ?? "09:00", to: h[d]?.[0]?.[1] ?? "17:00" }])) as Hours;
const fromHours = (h: Hours): BusinessHours => Object.fromEntries(WEEKDAYS.filter((d) => h[d].open).map((d) => [d, [[h[d].from, h[d].to]]])) as BusinessHours;

export function MessagingSettings({ settings, isOwner, canConfigure }: { settings: MessagingSettingsView; isOwner: boolean; canConfigure: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  async function save(key: string, input: Parameters<typeof updateMessagingSettingsAction>[0], ok: string) {
    setBusy(key);
    const r = await updateMessagingSettingsAction(input);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    toast.success(ok);
    router.refresh();
    return true;
  }
  const [hours, setHours] = React.useState<Hours>(() => toHours(settings.businessHours));
  const [bhOnly, setBhOnly] = React.useState(settings.replyBusinessHoursOnly);
  const [preset, setPreset] = React.useState(settings.followUpPreset);
  const custom = settings.followUpCustom;
  const [attempts, setAttempts] = React.useState(String(custom?.attempts ?? 3));
  const [gaps, setGaps] = React.useState((custom?.daysBetween ?? [2, 3]).join(", "));
  const [customChannel, setCustomChannel] = React.useState(custom?.channel ?? "same");
  const [customBh, setCustomBh] = React.useState(custom?.businessHoursOnly !== false);
  const [urgent, setUrgent] = React.useState(String(Math.round(settings.ownerTimeoutUrgentSeconds / 60 * 10) / 10));
  const [normal, setNormal] = React.useState(String(Math.round(settings.ownerTimeoutNormalSeconds / 60 * 10) / 10));
  const anyEnabled = settings.channels.some((c) => c.enabled);
  const L = settings.agencyLimits;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2"><Bot className="size-4" />Automatic replies</CardTitle>
            <CardDescription>When on, AI employees that you have let work autonomously can answer customers on your behalf, any time of day, inside your rules. When off, they prepare drafts for a person to approve.</CardDescription>
          </div>
          <Switch checked={settings.autoReplyEnabled} disabled={!isOwner || busy === "auto"} onCheckedChange={(next) => save("auto", { autoReplyEnabled: next }, next ? "Automatic replies are on." : "Automatic replies are off.")} aria-label="Automatic replies" />
        </CardHeader>
        <CardContent className="space-y-2 text-[13px]">
          <ul className="space-y-1.5">
            <li className="flex items-center gap-2"><Badge tone={anyEnabled ? "success" : "warning"}>{anyEnabled ? "Ready" : "Needed"}</Badge>At least one verified channel is switched on</li>
            <li className="flex items-center gap-2"><Badge tone="neutral">Per employee</Badge>The responsible AI employee is set to Autonomous and has passed its connection check</li>
            <li className="flex items-center gap-2"><Badge tone="neutral">Always</Badge>Opt-outs, consent, spending limits and emergency stops still apply</li>
          </ul>
          {!isOwner && <p className="flex items-center gap-1.5 text-muted"><Lock className="size-3.5" aria-hidden />Only the business owner can switch this on.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Channels</CardTitle>
            <CardDescription>A channel can only be switched on after iAcquire has checked its sender. Customers are never used as test recipients.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-line">
            {settings.channels.map((c) => {
              const Icon = ICONS[c.channel];
              const ready = c.verified && (c.channel === "email" || ["not_required", "approved"].includes(c.registrationStatus));
              return (
                <li key={c.channel} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-xl bg-surface-2"><Icon className="size-4" aria-hidden /></span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium">{CHANNEL_LABELS[c.channel]}</span>
                      <span className="block truncate text-[12.5px] text-muted">{c.senderIdentity ?? "No sender recorded yet"}</span>
                      {c.detail && <span className="block text-[12px] text-muted">{c.detail}</span>}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <Badge tone={c.enabled ? "success" : ready ? "primary" : "warning"}>{c.enabled ? "On" : ready ? "Verified · off" : c.verified ? "Registration pending" : "Not verified"}</Badge>
                    <Switch checked={c.enabled} disabled={!canConfigure || (!ready && !c.enabled) || busy === `ch-${c.channel}`} aria-label={`${CHANNEL_LABELS[c.channel]} channel`} onCheckedChange={async (next) => {
                      setBusy(`ch-${c.channel}`);
                      const r = await setChannelEnabledAction(c.channel, next);
                      setBusy(null);
                      if (!r.ok) toast.error(r.error);
                      else {
                        toast.success(next ? `${CHANNEL_LABELS[c.channel]} is on.` : `${CHANNEL_LABELS[c.channel]} is off.`);
                        router.refresh();
                      }
                    }} />
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2"><Clock className="size-4" />Business hours</CardTitle>
            <CardDescription>Used for follow-ups, and for replies if you limit them to business hours. Leave every day off to mean “always open”.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-2">
            {DAY_ORDER.map((d) => (
              <li key={d} className="grid grid-cols-[7rem_auto_1fr] items-center gap-3 text-[13px]">
                <span className="font-medium">{DAY_LABEL[d]}</span>
                <Switch checked={hours[d].open} disabled={!canConfigure} aria-label={`${DAY_LABEL[d]} open`} onCheckedChange={(open) => setHours((h) => ({ ...h, [d]: { ...h[d], open } }))} />
                <span className="flex items-center gap-2">
                  <input type="time" aria-label={`${DAY_LABEL[d]} opens`} value={hours[d].from} disabled={!canConfigure || !hours[d].open} onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], from: e.target.value } }))} className="h-10 rounded-lg border border-line bg-surface px-2 text-[13px] disabled:opacity-40" />
                  <span className="text-muted">to</span>
                  <input type="time" aria-label={`${DAY_LABEL[d]} closes`} value={hours[d].to} disabled={!canConfigure || !hours[d].open} onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], to: e.target.value } }))} className="h-10 rounded-lg border border-line bg-surface px-2 text-[13px] disabled:opacity-40" />
                </span>
              </li>
            ))}
          </ul>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]">
            <span><span className="block font-medium">Only reply during business hours</span><span className="block text-[12px] text-muted">Outside these hours, replies wait until you open. Off means the AI can reply 24/7.</span></span>
            <Switch checked={bhOnly} disabled={!canConfigure} onCheckedChange={setBhOnly} aria-label="Only reply during business hours" />
          </label>
          {canConfigure && <Button loading={busy === "hours"} onClick={() => save("hours", { businessHours: fromHours(hours), replyBusinessHoursOnly: bhOnly }, "Business hours saved.")}>Save business hours</Button>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Follow-ups</CardTitle>
            <CardDescription>How your AI team follows up with people who have not replied. One shared allowance per person across SMS, WhatsApp and email.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div role="radiogroup" aria-label="Follow-up style" className="grid gap-2 sm:grid-cols-2">
            {([...Object.entries(FOLLOW_UP_PRESETS).map(([k, v]) => [k, v.label, v.description] as const), ["off", "Off", "No automatic follow-ups."], ["custom", "Custom", "Choose how many attempts and how far apart."]] as const).map(([value, label, description]) => (
              <button key={value} role="radio" aria-checked={preset === value} disabled={!canConfigure} onClick={() => setPreset(value as typeof preset)} className={cn("rounded-2xl border p-3 text-left transition disabled:opacity-60", preset === value ? "border-primary bg-primary-soft/50" : "border-line bg-surface hover:border-line-strong")}>
                <span className="text-[14px] font-semibold">{label}{value === "balanced" ? " · default" : ""}</span>
                <span className="mt-1 block text-[12.5px] text-muted">{description}</span>
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <div className="grid gap-3 rounded-2xl border border-line p-3 sm:grid-cols-2">
              <Field label="Number of follow-ups" htmlFor="fu-attempts"><Input id="fu-attempts" inputMode="numeric" value={attempts} onChange={(e) => setAttempts(e.target.value.replace(/\D/g, ""))} /></Field>
              <Field label="Days between (comma-separated)" htmlFor="fu-gaps" hint="For example 2, 3 means day 2, then 3 days later, then 3 days later."><Input id="fu-gaps" value={gaps} onChange={(e) => setGaps(e.target.value)} /></Field>
              <Field label="Channel" htmlFor="fu-channel"><Select id="fu-channel" value={customChannel} onChange={(e) => setCustomChannel(e.target.value as typeof customChannel)}><option value="same">Same channel as the conversation</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></Select></Field>
              <label className="flex items-center justify-between gap-3 self-end rounded-xl border border-line p-3 text-[13px]"><span>Business hours only</span><Switch checked={customBh} onCheckedChange={setCustomBh} aria-label="Business hours only" /></label>
            </div>
          )}
          <div className="rounded-2xl bg-surface-2 p-3 text-[12.5px] leading-relaxed text-muted">
            <p className="flex items-center gap-1.5 font-medium text-ink"><ShieldCheck className="size-3.5" aria-hidden />iAcquire safety limits always apply</p>
            <p className="mt-1">At most {L.maxFollowupAttempts} follow-ups per plan and {L.maxFollowupsPer30Days} per person per 30 days across all channels, at least {L.minHoursBetweenFollowups} hours apart, never during quiet hours ({L.quietHoursStart}–{L.quietHoursEnd}), and never after an opt-out, a reply, a booking or a person taking over.</p>
          </div>
          {canConfigure && (
            <Button loading={busy === "followup"} onClick={() => save("followup", {
              followUpPreset: preset,
              followUpCustom: preset === "custom" ? { attempts: Number(attempts), daysBetween: gaps.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0), channel: customChannel, businessHoursOnly: customBh } : undefined,
            }, "Follow-up style saved.")}>Save follow-ups</Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>When a customer needs a person</CardTitle>
            <CardDescription>The business owner gets each escalation first. If they decline, are Away or Busy, or do not respond in time, authorized teammates are asked and the first to accept owns it.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="Owner priority for urgent matters (minutes)" htmlFor="own-urgent" hint="Default 2. Between 0.5 and 60."><Input id="own-urgent" inputMode="decimal" value={urgent} disabled={!canConfigure} onChange={(e) => setUrgent(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
          <Field label="Owner priority for routine matters (minutes)" htmlFor="own-normal" hint="Default 5. Between 0.5 and 120."><Input id="own-normal" inputMode="decimal" value={normal} disabled={!canConfigure} onChange={(e) => setNormal(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
          {canConfigure && <div className="sm:col-span-2"><Button loading={busy === "timers"} onClick={() => save("timers", { ownerTimeoutUrgentSeconds: Math.round(Number(urgent) * 60), ownerTimeoutNormalSeconds: Math.round(Number(normal) * 60) }, "Owner priority windows saved.")}>Save windows</Button></div>}
        </CardContent>
      </Card>
    </div>
  );
}
