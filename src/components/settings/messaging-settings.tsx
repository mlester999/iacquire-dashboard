"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellOff, Bot, CircleCheck, CircleDashed, Clock, Flame, Leaf, Lock, Mail, MessageCircle, MessagesSquare, MessageSquareText, Scale, ShieldCheck, SlidersHorizontal, Timer, UserRoundCheck } from "lucide-react";
import { Field, Input, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { IconTile, Notice, OptionCard, Panel, SaveBar, SettingRow } from "@/components/settings/panel";
import { setChannelEnabledAction, updateMessagingSettingsAction } from "@/app/actions/inbox";
import { CHANNEL_LABELS, FOLLOW_UP_PRESETS, WEEKDAYS, type BusinessHours, type Channel, type Weekday } from "@/lib/messaging";
import { cn } from "@/lib/utils";
import type { MessagingSettingsView } from "@/server/messaging/inbox";

const ICONS: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
const DAY_LABEL: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const DAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PRESET_ICONS: Record<string, React.ReactNode> = { gentle: <Leaf />, balanced: <Scale />, persistent: <Flame />, off: <BellOff />, custom: <SlidersHorizontal /> };

type Hours = Record<Weekday, { open: boolean; from: string; to: string }>;
const toHours = (h: BusinessHours): Hours =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, { open: Boolean(h[d]?.length), from: h[d]?.[0]?.[0] ?? "09:00", to: h[d]?.[0]?.[1] ?? "17:00" }])) as Hours;
const fromHours = (h: Hours): BusinessHours => Object.fromEntries(WEEKDAYS.filter((d) => h[d].open).map((d) => [d, [[h[d].from, h[d].to]]])) as BusinessHours;

const PRESETS = [...Object.entries(FOLLOW_UP_PRESETS).map(([k, v]) => [k, v.label, v.description] as const)];
const OTHER_PRESETS = [["off", "Off", "No automatic follow-ups."], ["custom", "Custom", "Choose how many attempts and how far apart."]] as const;

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
  const initialHours = React.useMemo(() => toHours(settings.businessHours), [settings.businessHours]);
  const [hours, setHours] = React.useState<Hours>(initialHours);
  const [bhOnly, setBhOnly] = React.useState(settings.replyBusinessHoursOnly);
  const [preset, setPreset] = React.useState(settings.followUpPreset);
  const custom = settings.followUpCustom;
  const [attempts, setAttempts] = React.useState(String(custom?.attempts ?? 3));
  const [gaps, setGaps] = React.useState((custom?.daysBetween ?? [2, 3]).join(", "));
  const [customChannel, setCustomChannel] = React.useState(custom?.channel ?? "same");
  const [customBh, setCustomBh] = React.useState(custom?.businessHoursOnly !== false);
  const initialUrgent = String(Math.round(settings.ownerTimeoutUrgentSeconds / 60 * 10) / 10);
  const initialNormal = String(Math.round(settings.ownerTimeoutNormalSeconds / 60 * 10) / 10);
  const [urgent, setUrgent] = React.useState(initialUrgent);
  const [normal, setNormal] = React.useState(initialNormal);
  const anyEnabled = settings.channels.some((c) => c.enabled);
  const L = settings.agencyLimits;
  const initialAttempts = String(custom?.attempts ?? 3);
  const initialGaps = (custom?.daysBetween ?? [2, 3]).join(", ");
  const initialChannel = custom?.channel ?? "same";
  const initialCustomBh = custom?.businessHoursOnly !== false;
  const followDirty = preset !== settings.followUpPreset || (preset === "custom" && (attempts !== initialAttempts || gaps !== initialGaps || customChannel !== initialChannel || customBh !== initialCustomBh));
  const windowsDirty = urgent !== initialUrgent || normal !== initialNormal;
  const hoursDirty = JSON.stringify(hours) !== JSON.stringify(initialHours) || bhOnly !== settings.replyBusinessHoursOnly;
  const openDays = DAY_ORDER.filter((d) => hours[d].open).length;

  const requirements: Array<{ text: string; pill: string; tone: StatusTone; done?: boolean }> = [
    { text: "At least one verified channel is switched on", pill: anyEnabled ? "Ready" : "Needed", tone: anyEnabled ? "success" : "warning", done: anyEnabled },
    { text: "The responsible AI employee is set to Autonomous and has passed its connection check", pill: "Per employee", tone: "neutral" },
    { text: "Opt-outs, consent, spending limits and emergency stops still apply", pill: "Always", tone: "neutral" },
  ];

  return (
    <div className="space-y-6">
      <Panel
        icon={<Bot />}
        tone={settings.autoReplyEnabled ? "success" : "neutral"}
        title="Automatic replies"
        description="When on, AI employees that you have let work autonomously can answer customers on your behalf, any time of day, inside your rules. When off, they prepare drafts for a person to approve."
        aside={
          <>
            <StatusPill tone={settings.autoReplyEnabled ? "success" : "neutral"}>{settings.autoReplyEnabled ? "On" : "Off"}</StatusPill>
            <Switch checked={settings.autoReplyEnabled} disabled={!isOwner || busy === "auto"} onCheckedChange={(next) => save("auto", { autoReplyEnabled: next }, next ? "Automatic replies are on." : "Automatic replies are off.")} aria-label="Automatic replies" />
          </>
        }
        bodyClassName="space-y-3"
      >
        <ul className="space-y-2" aria-label="Requirements for automatic replies">
          {requirements.map((r) => (
            <li key={r.text}>
              <SettingRow icon={r.done ? <CircleCheck /> : <CircleDashed />} tone={r.done ? "success" : "neutral"} title={<span className="font-normal">{r.text}</span>}>
                <StatusPill tone={r.tone} size="sm">{r.pill}</StatusPill>
              </SettingRow>
            </li>
          ))}
        </ul>
        {!isOwner && (
          <Notice tone="neutral" icon={<Lock />}>
            Only the business owner can switch this on.
          </Notice>
        )}
      </Panel>

      <Panel icon={<MessagesSquare />} title="Channels" description="A channel can only be switched on after iAcquire has checked its sender. Customers are never used as test recipients." aside={<InfoChip>{settings.channels.filter((c) => c.enabled).length} of {settings.channels.length} on</InfoChip>} flush>
        <ul className="divide-y divide-line border-t border-line">
          {settings.channels.map((c) => {
            const Icon = ICONS[c.channel];
            const ready = c.verified && (c.channel === "email" || ["not_required", "approved"].includes(c.registrationStatus));
            const state: { tone: StatusTone; label: string } = c.enabled ? { tone: "success", label: "On" } : ready ? { tone: "primary", label: "Verified · off" } : c.verified ? { tone: "warning", label: "Registration pending" } : { tone: "warning", label: "Not verified" };
            return (
              <li key={c.channel} className="management-row flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4 sm:px-6">
                <span className="flex min-w-0 flex-1 basis-60 items-center gap-3.5">
                  <IconTile icon={<Icon />} tone={c.enabled ? "success" : "neutral"} />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                      {CHANNEL_LABELS[c.channel]}
                      <StatusPill tone={state.tone} size="sm">{state.label}</StatusPill>
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-muted" title={c.senderIdentity ?? undefined}>{c.senderIdentity ?? "No sender recorded yet"}</span>
                    {c.detail && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{c.detail}</span>}
                  </span>
                </span>
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
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel
        icon={<Clock />}
        title="Business hours"
        description="Used for follow-ups, and for replies if you limit them to business hours. Leave every day off to mean “always open”."
        aside={<InfoChip>{openDays === 0 ? "Always open" : `${openDays} ${openDays === 1 ? "day" : "days"} a week`}</InfoChip>}
        bodyClassName="space-y-3"
        footer={
          canConfigure && (
            <SaveBar
              dirty={hoursDirty}
              pending={busy === "hours"}
              saveLabel="Save business hours"
              onReset={() => {
                setHours(initialHours);
                setBhOnly(settings.replyBusinessHoursOnly);
              }}
              onSave={() => void save("hours", { businessHours: fromHours(hours), replyBusinessHoursOnly: bhOnly }, "Business hours saved.")}
            />
          )
        }
      >
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {DAY_ORDER.map((d) => (
            <li key={d} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-2.5 text-[13px] 2xl:grid-cols-[8rem_auto_1fr]">
              <span className="font-medium text-ink">{DAY_LABEL[d]}</span>
              <Switch checked={hours[d].open} disabled={!canConfigure} aria-label={`${DAY_LABEL[d]} open`} onCheckedChange={(open) => setHours((h) => ({ ...h, [d]: { ...h[d], open } }))} />
              <span className="col-span-2 flex items-center gap-2 2xl:col-span-1">
                {hours[d].open ? (
                  <>
                    <Input type="time" aria-label={`${DAY_LABEL[d]} opens`} value={hours[d].from} disabled={!canConfigure} onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], from: e.target.value } }))} className="min-w-0 flex-1 px-2.5 text-[14px] 2xl:w-36 2xl:flex-none sm:px-3.5 sm:text-sm" />
                    <span className="text-muted">to</span>
                    <Input type="time" aria-label={`${DAY_LABEL[d]} closes`} value={hours[d].to} disabled={!canConfigure} onChange={(e) => setHours((h) => ({ ...h, [d]: { ...h[d], to: e.target.value } }))} className="min-w-0 flex-1 px-2.5 text-[14px] 2xl:w-36 2xl:flex-none sm:px-3.5 sm:text-sm" />
                  </>
                ) : (
                  <StatusPill tone="neutral" size="sm">Closed</StatusPill>
                )}
              </span>
            </li>
          ))}
        </ul>
        <SettingRow as="label" icon={<Timer />} tone={bhOnly ? "primary" : "neutral"} title="Only reply during business hours" description="Outside these hours, replies wait until you open. Off means the AI can reply 24/7.">
          <Switch checked={bhOnly} disabled={!canConfigure} onCheckedChange={setBhOnly} aria-label="Only reply during business hours" />
        </SettingRow>
      </Panel>

      <Panel
        icon={<UserRoundCheck />}
        tone="violet"
        title="Follow-ups"
        description="How your AI team follows up with people who have not replied. One shared allowance per person across SMS, WhatsApp and email."
        bodyClassName="space-y-4"
        footer={
          canConfigure && (
            <SaveBar
              dirty={followDirty}
              pending={busy === "followup"}
              saveLabel="Save follow-ups"
              onReset={() => {
                setPreset(settings.followUpPreset);
                setAttempts(initialAttempts);
                setGaps(initialGaps);
                setCustomChannel(initialChannel);
                setCustomBh(initialCustomBh);
              }}
              onSave={() => save("followup", {
                followUpPreset: preset,
                followUpCustom: preset === "custom" ? { attempts: Number(attempts), daysBetween: gaps.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0), channel: customChannel, businessHoursOnly: customBh } : undefined,
              }, "Follow-up style saved.")}
            />
          )
        }
      >
        <div role="radiogroup" aria-label="Follow-up style" className="space-y-2.5">
          <div className="grid gap-2.5 sm:grid-cols-3">
            {PRESETS.map(([value, label, description]) => (
              <OptionCard key={value} selected={preset === value} disabled={!canConfigure} onSelect={() => setPreset(value as typeof preset)} icon={PRESET_ICONS[value]} title={label} description={description} meta={value === "balanced" ? <StatusPill tone="neutral" size="sm" dot={false}>Default</StatusPill> : undefined} />
            ))}
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {OTHER_PRESETS.map(([value, label, description]) => (
              <OptionCard key={value} selected={preset === value} disabled={!canConfigure} onSelect={() => setPreset(value as typeof preset)} icon={PRESET_ICONS[value]} title={label} description={description} />
            ))}
          </div>
        </div>
        {preset === "custom" && (
          <div className="grid gap-4 rounded-2xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line sm:grid-cols-2">
            <Field label="Number of follow-ups" htmlFor="fu-attempts"><Input id="fu-attempts" inputMode="numeric" value={attempts} onChange={(e) => setAttempts(e.target.value.replace(/\D/g, ""))} /></Field>
            <Field label="Days between (comma-separated)" htmlFor="fu-gaps" hint="For example 2, 3 means day 2, then 3 days later, then 3 days later."><Input id="fu-gaps" value={gaps} onChange={(e) => setGaps(e.target.value)} /></Field>
            <Field label="Channel" htmlFor="fu-channel"><Select id="fu-channel" value={customChannel} onChange={(e) => setCustomChannel(e.target.value as typeof customChannel)}><option value="same">Same channel as the conversation</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></Select></Field>
            <SettingRow as="label" title="Business hours only" className="self-end"><Switch checked={customBh} onCheckedChange={setCustomBh} aria-label="Business hours only" /></SettingRow>
          </div>
        )}
        <Notice tone="primary" icon={<ShieldCheck />} title="iAcquire safety limits always apply">
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <InfoChip className="bg-surface">At most {L.maxFollowupAttempts} follow-ups per plan</InfoChip>
            <InfoChip className="bg-surface">{L.maxFollowupsPer30Days} per person per 30 days</InfoChip>
            <InfoChip className="bg-surface">At least {L.minHoursBetweenFollowups} hours apart</InfoChip>
            <InfoChip className="bg-surface">Quiet hours {L.quietHoursStart}–{L.quietHoursEnd}</InfoChip>
          </div>
          <p className="mt-2 text-[12.5px] text-muted">Limits apply across all channels, and follow-ups never continue after an opt-out, a reply, a booking or a person taking over.</p>
        </Notice>
      </Panel>

      <Panel
        icon={<Timer />}
        tone="warning"
        title="When a customer needs a person"
        description="The business owner gets each escalation first. If they decline, are Away or Busy, or do not respond in time, authorized teammates are asked and the first to accept owns it."
        bodyClassName={cn("grid gap-4 sm:grid-cols-2")}
        footer={
          canConfigure && (
            <SaveBar
              dirty={windowsDirty}
              pending={busy === "timers"}
              saveLabel="Save windows"
              onReset={() => {
                setUrgent(initialUrgent);
                setNormal(initialNormal);
              }}
              onSave={() => save("timers", { ownerTimeoutUrgentSeconds: Math.round(Number(urgent) * 60), ownerTimeoutNormalSeconds: Math.round(Number(normal) * 60) }, "Owner priority windows saved.")}
            />
          )
        }
      >
        <Field label="Owner priority for urgent matters (minutes)" htmlFor="own-urgent" hint="Default 2. Between 0.5 and 60."><Input id="own-urgent" inputMode="decimal" value={urgent} disabled={!canConfigure} onChange={(e) => setUrgent(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
        <Field label="Owner priority for routine matters (minutes)" htmlFor="own-normal" hint="Default 5. Between 0.5 and 120."><Input id="own-normal" inputMode="decimal" value={normal} disabled={!canConfigure} onChange={(e) => setNormal(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
      </Panel>
    </div>
  );
}
