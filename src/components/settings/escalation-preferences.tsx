"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, BellRing, Check, CircleCheck, Crown, Hourglass, Info, Mail, MessageCircle, MessageSquareText, Moon, ShieldAlert, UserCheck, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { AvatarTile, InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { Notice, OptionCard, Panel, SaveBar, SettingRow } from "@/components/settings/panel";
import { RolePill } from "@/components/settings/role-pill";
import { setAvailabilityAction, setEscalationAuthorizationAction, setNotificationPreferencesAction, setOwnerPriorityModeAction } from "@/app/actions/inbox";
import { ESCALATION_CATEGORIES, ESCALATION_LABELS, OWNER_PRIORITY_LABELS, OWNER_PRIORITY_MODES, type Availability, type EscalationCategory, type OwnerPriorityMode } from "@/lib/escalation";
import { roleHasPermission, type OrgRole } from "@/lib/permissions";
import { cn, sentenceCase } from "@/lib/utils";
import type { StaffProfile } from "@/server/staff/service";

const AVAIL: Array<{ value: Availability; label: string; hint: string; icon: React.ReactNode }> = [
  { value: "available", label: "Available", hint: "You are offered escalations.", icon: <CircleCheck /> },
  { value: "busy", label: "Busy", hint: "You are skipped while you work on something else.", icon: <Hourglass /> },
  { value: "away", label: "Away", hint: "You are skipped until you are back.", icon: <Moon /> },
];
const AVAIL_TONE: Record<Availability, StatusTone> = { available: "success", busy: "warning", away: "neutral" };
const OWNER_ICONS: Record<OwnerPriorityMode, React.ReactNode> = { first_priority: <Crown />, notify_only: <Bell />, urgent_only: <Zap /> };
const UNTIL = [
  { value: "", label: "Until I change it" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

function AvailabilityPill({ value }: { value: Availability }) {
  return <StatusPill tone={AVAIL_TONE[value] ?? "neutral"}>{sentenceCase(value)}</StatusPill>;
}

export function EscalationPreferences({ me, team, isOwner, canConfigure, ownerMode }: { me: StaffProfile; team: StaffProfile[]; isOwner: boolean; canConfigure: boolean; ownerMode: OwnerPriorityMode }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error ?? "That didn't work.");
      return false;
    }
    toast.success(ok);
    router.refresh();
    return true;
  }
  const [availability, setAvailability] = React.useState<Availability>(me.availability);
  const [note, setNote] = React.useState(me.availabilityNote ?? "");
  const [until, setUntil] = React.useState("");
  const [email, setEmail] = React.useState(me.notifyEmail);
  const [sms, setSms] = React.useState(me.notifySms);
  const [whatsapp, setWhatsapp] = React.useState(me.notifyWhatsapp);
  const [phone, setPhone] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const optional = sms || whatsapp;
  const availabilityDirty = availability !== me.availability || note !== (me.availabilityNote ?? "") || until !== "";
  const alertsDirty = email !== me.notifyEmail || sms !== me.notifySms || whatsapp !== me.notifyWhatsapp || phone !== "";

  return (
    <div className="space-y-6">
      <Panel
        icon={<UserCheck />}
        tone="success"
        title="Your availability"
        description="Away and Busy skip you when a customer needs a person, so nobody waits on someone who is not there."
        aside={<AvailabilityPill value={me.availability} />}
        bodyClassName="space-y-4"
        footer={
          <SaveBar
            dirty={availabilityDirty}
            pending={busy === "avail"}
            saveLabel="Save availability"
            onReset={() => {
              setAvailability(me.availability);
              setNote(me.availabilityNote ?? "");
              setUntil("");
            }}
            onSave={() => void run("avail", () => setAvailabilityAction(availability, note, until ? new Date(Date.now() + Number(until) * 3600_000).toISOString() : null), "Availability updated.")}
          />
        }
      >
        <div role="radiogroup" aria-label="Availability" className="grid gap-2.5 sm:grid-cols-3">
          {AVAIL.map((a) => (
            <OptionCard key={a.value} selected={availability === a.value} onSelect={() => setAvailability(a.value)} icon={a.icon} title={a.label} description={a.hint} />
          ))}
        </div>
        {availability !== "available" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="For how long" htmlFor="avail-until">
              <Select id="avail-until" value={until} onChange={(e) => setUntil(e.target.value)}>
                {UNTIL.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Note for teammates" htmlFor="avail-note" optional>
              <Input id="avail-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
        )}
      </Panel>

      <Panel
        icon={<BellRing />}
        title="How you are alerted"
        description="In-app alerts are always on. Email is on by default. SMS and WhatsApp alerts are optional and billed as usage."
        bodyClassName="space-y-2.5"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            {alertsDirty ? <StatusPill tone="warning">Unsaved changes</StatusPill> : <InfoChip icon={<Check aria-hidden />}>Up to date</InfoChip>}
            <Button disabled={!alertsDirty} loading={busy === "alerts"} onClick={() => run("alerts", () => setNotificationPreferencesAction({ notifyEmail: email, notifySms: sms, notifyWhatsapp: whatsapp, alertPhone: phone || undefined, acknowledgeCosts: ack }), "Alert preferences saved.")}>
              Save alert preferences
            </Button>
          </div>
        }
      >
        <SettingRow as="label" icon={<Bell />} tone="primary" title="In-app" description="Always on for escalations.">
          <StatusPill tone="success" size="sm">Always on</StatusPill>
          <Switch checked disabled aria-label="In-app alerts" />
        </SettingRow>
        <SettingRow as="label" icon={<Mail />} tone={email ? "primary" : "neutral"} title="Email" description="On by default.">
          <Switch checked={email} onCheckedChange={setEmail} aria-label="Email alerts" />
        </SettingRow>
        <SettingRow as="label" icon={<MessageSquareText />} tone={sms ? "primary" : "neutral"} title="SMS to my phone" description="Optional.">
          <InfoChip>Billed as usage</InfoChip>
          <Switch checked={sms} onCheckedChange={setSms} aria-label="SMS alerts" />
        </SettingRow>
        <SettingRow as="label" icon={<MessageCircle />} tone={whatsapp ? "primary" : "neutral"} title="WhatsApp to my phone" description="Optional.">
          <InfoChip>Billed as usage</InfoChip>
          <Switch checked={whatsapp} onCheckedChange={setWhatsapp} aria-label="WhatsApp alerts" />
        </SettingRow>
        {optional && (
          <div className="space-y-3 rounded-2xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line">
            <Field label="Mobile number (with country code)" htmlFor="alert-phone" hint="Kept private. Never visible to teammates.">
              <Input id="alert-phone" inputMode="tel" placeholder="+639171234567" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl bg-surface px-3.5 py-3 text-[13px] leading-relaxed text-ink-2 ring-1 ring-inset ring-line">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand SMS and WhatsApp alerts are charged to my workspace as usage, and I choose to receive them.</span>
            </label>
            <Notice tone="primary" icon={<Info />}>
              These optional alerts are recorded but are not delivered until a messaging provider path is verified for your workspace. In-app and email alerts work today.
            </Notice>
          </div>
        )}
      </Panel>

      {isOwner && (
        <Panel icon={<Crown />} tone="violet" title="How escalations reach you first" description="You are the business owner, so you get the first chance on every escalation unless you choose otherwise.">
          <div role="radiogroup" aria-label="Owner notification preference" className="grid gap-2.5 sm:grid-cols-3">
            {OWNER_PRIORITY_MODES.map((mode) => (
              <OptionCard
                key={mode}
                selected={ownerMode === mode}
                disabled={busy === "owner"}
                onSelect={() => run("owner", () => setOwnerPriorityModeAction(mode), "Saved.")}
                icon={OWNER_ICONS[mode]}
                title={OWNER_PRIORITY_LABELS[mode].label}
                meta={mode === "first_priority" ? <StatusPill tone="neutral" size="sm" dot={false}>Default</StatusPill> : undefined}
                description={OWNER_PRIORITY_LABELS[mode].description}
              />
            ))}
          </div>
        </Panel>
      )}

      {canConfigure && <TeamAuthorization team={team} run={run} busy={busy} />}
    </div>
  );
}

function TeamAuthorization({ team, run, busy }: { team: StaffProfile[]; busy: string | null; run: (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => Promise<boolean> }) {
  const [draft, setDraft] = React.useState<Record<string, EscalationCategory[]>>(() => Object.fromEntries(team.map((p) => [p.userId, p.escalationCategories])));
  const people = team.filter((p) => roleHasPermission(p.role as OrgRole, "escalations.respond"));
  return (
    <Panel
      icon={<ShieldAlert />}
      tone="warning"
      title="Who handles which escalations"
      description="Teammates only hear about, and can only accept, the kinds you authorize for them. Viewers cannot take escalations."
      aside={people.length > 0 ? <InfoChip>{people.length} {people.length === 1 ? "teammate" : "teammates"}</InfoChip> : undefined}
      bodyClassName="space-y-3"
    >
      {people.map((p) => {
        const chosen = draft[p.userId] ?? [];
        const changed = JSON.stringify([...chosen].sort()) !== JSON.stringify([...p.escalationCategories].sort());
        return (
          <fieldset key={p.userId} className="min-w-0 rounded-2xl border border-line bg-surface p-4">
            <legend className="sr-only">Escalations for {p.name}</legend>
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
              <AvatarTile name={p.name} />
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-[14px] font-semibold text-ink" title={p.name}>
                  {p.name}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <RolePill role={p.role as OrgRole} />
                  <AvailabilityPill value={p.availability} />
                  <InfoChip>
                    {chosen.length} of {ESCALATION_CATEGORIES.length} kinds
                  </InfoChip>
                </div>
              </div>
              <Button size="sm" className="w-full sm:w-auto" variant={changed ? "brand" : "secondary"} disabled={!changed} loading={busy === `auth-${p.userId}`} onClick={() => run(`auth-${p.userId}`, () => setEscalationAuthorizationAction(p.userId, chosen), `Saved for ${p.name}.`)}>
                Save for {p.name.split(" ")[0]}
              </Button>
            </div>
            <div className="mt-3.5 flex flex-wrap gap-2 border-t border-line pt-3.5">
              {ESCALATION_CATEGORIES.map((cat) => {
                const on = chosen.includes(cat);
                return (
                  <label
                    key={cat}
                    className={cn(
                      "inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full px-3 text-[12.5px] font-medium ring-1 ring-inset transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary sm:min-h-8",
                      on ? "bg-primary-soft text-primary-ink ring-primary/25" : "bg-surface text-muted ring-line-strong hover:text-ink",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={(e) => setDraft((d) => ({ ...d, [p.userId]: e.target.checked ? [...(d[p.userId] ?? []), cat] : (d[p.userId] ?? []).filter((x) => x !== cat) }))}
                    />
                    <span aria-hidden className={cn("grid size-4 place-items-center rounded-full border", on ? "border-primary bg-primary text-white" : "border-line-strong")}>
                      {on && <Check className="size-2.5" strokeWidth={3.5} />}
                    </span>
                    {ESCALATION_LABELS[cat]}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      {!people.length && <EmptyState compact icon={<ShieldAlert className="size-5" />} title="No teammates can take escalations yet" description="Invite a sales representative or customer support person from Team members." />}
    </Panel>
  );
}
