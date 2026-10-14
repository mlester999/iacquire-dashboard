"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellRing, Info, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { setAvailabilityAction, setEscalationAuthorizationAction, setNotificationPreferencesAction, setOwnerPriorityModeAction } from "@/app/actions/inbox";
import { ESCALATION_CATEGORIES, ESCALATION_LABELS, OWNER_PRIORITY_LABELS, OWNER_PRIORITY_MODES, type Availability, type EscalationCategory, type OwnerPriorityMode } from "@/lib/escalation";
import { ROLE_LABELS, roleHasPermission, type OrgRole } from "@/lib/permissions";
import { cn, sentenceCase } from "@/lib/utils";
import type { StaffProfile } from "@/server/staff/service";

const AVAIL: Array<{ value: Availability; label: string; hint: string }> = [
  { value: "available", label: "Available", hint: "You are offered escalations." },
  { value: "busy", label: "Busy", hint: "You are skipped while you work on something else." },
  { value: "away", label: "Away", hint: "You are skipped until you are back." },
];
const UNTIL = [
  { value: "", label: "Until I change it" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2"><UserCheck className="size-4" />Your availability</CardTitle>
            <CardDescription>Away and Busy skip you when a customer needs a person, so nobody waits on someone who is not there.</CardDescription>
          </div>
          <Badge tone={me.availability === "available" ? "success" : "warning"}>{sentenceCase(me.availability)}</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <div role="radiogroup" aria-label="Availability" className="grid gap-2 sm:grid-cols-3">
            {AVAIL.map((a) => (
              <button key={a.value} role="radio" aria-checked={availability === a.value} onClick={() => setAvailability(a.value)} className={cn("rounded-2xl border p-3 text-left transition", availability === a.value ? "border-primary bg-primary-soft/50" : "border-line bg-surface hover:border-line-strong")}>
                <span className="text-[14px] font-semibold">{a.label}</span>
                <span className="mt-1 block text-[12.5px] text-muted">{a.hint}</span>
              </button>
            ))}
          </div>
          {availability !== "available" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="For how long" htmlFor="avail-until"><Select id="avail-until" value={until} onChange={(e) => setUntil(e.target.value)}>{UNTIL.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</Select></Field>
              <Field label="Note for teammates (optional)" htmlFor="avail-note"><Input id="avail-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
            </div>
          )}
          <Button loading={busy === "avail"} onClick={() => run("avail", () => setAvailabilityAction(availability, note, until ? new Date(Date.now() + Number(until) * 3600_000).toISOString() : null), "Availability updated.")}>Save availability</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2"><BellRing className="size-4" />How you are alerted</CardTitle>
            <CardDescription>In-app alerts are always on. Email is on by default. SMS and WhatsApp alerts are optional and billed as usage.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]"><span><span className="block font-medium">In-app</span><span className="block text-[12px] text-muted">Always on for escalations.</span></span><Switch checked disabled aria-label="In-app alerts" /></label>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]"><span className="font-medium">Email</span><Switch checked={email} onCheckedChange={setEmail} aria-label="Email alerts" /></label>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]"><span><span className="block font-medium">SMS to my phone</span><span className="block text-[12px] text-muted">Optional. Billed as usage.</span></span><Switch checked={sms} onCheckedChange={setSms} aria-label="SMS alerts" /></label>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]"><span><span className="block font-medium">WhatsApp to my phone</span><span className="block text-[12px] text-muted">Optional. Billed as usage.</span></span><Switch checked={whatsapp} onCheckedChange={setWhatsapp} aria-label="WhatsApp alerts" /></label>
          {optional && (
            <div className="space-y-3 rounded-2xl bg-surface-2 p-3">
              <Field label="Mobile number (with country code)" htmlFor="alert-phone" hint="Kept private. Never visible to teammates."><Input id="alert-phone" inputMode="tel" placeholder="+639171234567" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
              <label className="flex items-start gap-2 text-[12.5px]"><input type="checkbox" className="mt-1 size-4" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I understand SMS and WhatsApp alerts are charged to my workspace as usage, and I choose to receive them.</span></label>
              <p className="flex items-start gap-1.5 text-[12px] text-muted"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />These optional alerts are recorded but are not delivered until a messaging provider path is verified for your workspace. In-app and email alerts work today.</p>
            </div>
          )}
          <Button loading={busy === "alerts"} onClick={() => run("alerts", () => setNotificationPreferencesAction({ notifyEmail: email, notifySms: sms, notifyWhatsapp: whatsapp, alertPhone: phone || undefined, acknowledgeCosts: ack }), "Alert preferences saved.")}>Save alert preferences</Button>
        </CardContent>
      </Card>

      {isOwner && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>How escalations reach you first</CardTitle>
              <CardDescription>You are the business owner, so you get the first chance on every escalation unless you choose otherwise.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div role="radiogroup" aria-label="Owner notification preference" className="grid gap-2 sm:grid-cols-3">
              {OWNER_PRIORITY_MODES.map((mode) => (
                <button key={mode} role="radio" aria-checked={ownerMode === mode} disabled={busy === "owner"} onClick={() => run("owner", () => setOwnerPriorityModeAction(mode), "Saved.")} className={cn("rounded-2xl border p-3 text-left transition", ownerMode === mode ? "border-primary bg-primary-soft/50" : "border-line bg-surface hover:border-line-strong")}>
                  <span className="text-[14px] font-semibold">{OWNER_PRIORITY_LABELS[mode].label}{mode === "first_priority" ? " · default" : ""}</span>
                  <span className="mt-1 block text-[12.5px] leading-relaxed text-muted">{OWNER_PRIORITY_LABELS[mode].description}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {canConfigure && <TeamAuthorization team={team} run={run} busy={busy} />}
    </div>
  );
}

function TeamAuthorization({ team, run, busy }: { team: StaffProfile[]; busy: string | null; run: (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => Promise<boolean> }) {
  const [draft, setDraft] = React.useState<Record<string, EscalationCategory[]>>(() => Object.fromEntries(team.map((p) => [p.userId, p.escalationCategories])));
  const people = team.filter((p) => roleHasPermission(p.role as OrgRole, "escalations.respond"));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Who handles which escalations</CardTitle>
          <CardDescription>Teammates only hear about, and can only accept, the kinds you authorize for them. Viewers cannot take escalations.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {people.map((p) => {
          const chosen = draft[p.userId] ?? [];
          const changed = JSON.stringify([...chosen].sort()) !== JSON.stringify([...p.escalationCategories].sort());
          return (
            <fieldset key={p.userId} className="rounded-2xl border border-line p-3">
              <legend className="px-1 text-[13px] font-semibold">{p.name} <span className="font-normal text-muted">· {ROLE_LABELS[p.role as OrgRole]} · {sentenceCase(p.availability)}</span></legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {ESCALATION_CATEGORIES.map((cat) => (
                  <label key={cat} className="flex items-center gap-2 text-[12.5px]">
                    <input type="checkbox" className="size-4" checked={chosen.includes(cat)} onChange={(e) => setDraft((d) => ({ ...d, [p.userId]: e.target.checked ? [...(d[p.userId] ?? []), cat] : (d[p.userId] ?? []).filter((x) => x !== cat) }))} />
                    {ESCALATION_LABELS[cat]}
                  </label>
                ))}
              </div>
              <Button size="sm" className="mt-3" variant={changed ? "brand" : "secondary"} disabled={!changed} loading={busy === `auth-${p.userId}`} onClick={() => run(`auth-${p.userId}`, () => setEscalationAuthorizationAction(p.userId, chosen), `Saved for ${p.name}.`)}>Save for {p.name.split(" ")[0]}</Button>
            </fieldset>
          );
        })}
        {!people.length && <p className="text-[13px] text-muted">No teammates can take escalations yet. Invite a sales representative or customer support person from Team members.</p>}
      </CardContent>
    </Card>
  );
}

