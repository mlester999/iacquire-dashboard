"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Field, Input, Textarea } from "@/components/ui/primitives";
import { saveDemoSettingsAction } from "@/app/actions/demo-admin";
import { visitorsSee, type SwitchState } from "@/lib/demo/admin-view";
import { checkSettingsPatch, DEMO_RANGES, type DemoSettings } from "@/lib/demo/settings";

// The demo's settings. Switching the demo on, switching the AI chat on, and every number below are a Super Admin's decision; a manager can read them. A save carries the version the
// screen was showing: if someone else saved first, the screen says so and asks for a reload instead of overwriting their change.

type NumberKey = keyof typeof DEMO_RANGES;

const NUMBERS: Array<{ key: NumberKey; label: string; hint: string }> = [
  { key: "windowHours", label: "Hours a demo stays open", hint: "Counted from the moment the prospect confirms their address. A change moves nobody who has already started." },
  { key: "messageLimit", label: "AI messages per demo", hint: "What a new prospect may ask the AI chat. A change moves nobody who has already started." },
  { key: "maxExtensionHours", label: "Most hours that can be added to one prospect", hint: "In all, over their whole life. A reason is always required." },
  { key: "maxExtraMessages", label: "Most messages that can be added to one prospect", hint: "In all, over their whole life. A reason is always required." },
  { key: "dailyStartCap", label: "Demos that can start per day", hint: "Platform-wide, per UTC day. 0 stops new demos." },
  { key: "dailyMessageCap", label: "AI messages per day, in all", hint: "Platform-wide, per UTC day. iAcquire pays for every one. 0 stops the AI chat." },
  { key: "retentionDays", label: "Days conversations and details are kept", hint: "Counted from when the demo ended or the prospect last visited. Someone who never confirmed is removed after 7 days." },
];

type Form = Record<NumberKey, string> & { enabled: boolean; aiEnabled: boolean; consultationUrl: string; blockedEmailDomains: string };

const toForm = (s: DemoSettings): Form => ({
  enabled: s.enabled,
  aiEnabled: s.aiEnabled,
  windowHours: String(s.windowHours),
  messageLimit: String(s.messageLimit),
  maxExtensionHours: String(s.maxExtensionHours),
  maxExtraMessages: String(s.maxExtraMessages),
  dailyStartCap: String(s.dailyStartCap),
  dailyMessageCap: String(s.dailyMessageCap),
  retentionDays: String(s.retentionDays),
  consultationUrl: s.consultationUrl ?? "",
  blockedEmailDomains: s.blockedEmailDomains.join("\n"),
});

/** The fields that differ from what was saved, as the patch the server checks. */
function patchOf(form: Form, saved: DemoSettings): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (form.enabled !== saved.enabled) patch.enabled = form.enabled;
  if (form.aiEnabled !== saved.aiEnabled) patch.aiEnabled = form.aiEnabled;
  for (const { key } of NUMBERS) {
    const n = form[key].trim() === "" ? Number.NaN : Number(form[key]);
    if (n !== saved[key]) patch[key] = n;
  }
  if (form.consultationUrl.trim() !== (saved.consultationUrl ?? "")) patch.consultationUrl = form.consultationUrl.trim();
  const domains = form.blockedEmailDomains.split(/[\s,]+/).filter(Boolean);
  if (JSON.stringify(domains.map((d) => d.toLowerCase().replace(/^@/, ""))) !== JSON.stringify(saved.blockedEmailDomains)) patch.blockedEmailDomains = domains;
  return patch;
}

export function DemoSettingsForm({ settings, version, env, canManage }: { settings: DemoSettings; version: number; env: { environment: boolean; emergencyStop: boolean }; canManage: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = React.useState({ settings, version });
  const [form, setForm] = React.useState<Form>(() => toForm(settings));
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [conflict, setConflict] = React.useState(false);
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const patch = patchOf(form, saved.settings);
  const dirty = Object.keys(patch).length > 0;
  const turningAiOn = patch.aiEnabled === true;
  const state = visitorsSee({ ...env, enabled: saved.settings.enabled, aiEnabled: saved.settings.aiEnabled });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!dirty || busy) return;
    const checked = checkSettingsPatch(patch);
    if (!checked.ok) return setProblems(checked.problems as Record<string, string>);
    if (turningAiOn && !ack) return setProblems({ aiEnabled: "Tick the box to confirm you have read the warning." });
    setProblems({});
    setBusy(true);
    try {
      const r = await saveDemoSettingsAction(checked.value, saved.version);
      if (!r.ok) {
        if (r.code === "conflict") setConflict(true);
        else setProblems({ form: r.error });
        return;
      }
      setSaved({ settings: r.data.settings, version: r.data.version });
      setForm(toForm(r.data.settings));
      setAck(false);
      toast.success("The demo settings were saved.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const off = !canManage;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/prospects" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />
          All prospects
        </Link>
      </div>
      <header className="space-y-1.5">
        <h1 className="text-[22px] font-semibold tracking-tight">Demo settings</h1>
        <p className="max-w-3xl text-[13.5px] leading-relaxed text-muted">
          The demo is off until three things agree: this deployment allows it, you switch it on here, and (for the AI chat) the AI chat is switched on and a language model is connected. The
          numbers below are proposals that the founder has not confirmed yet.
        </p>
      </header>

      <p role="status" className={`rounded-xl border px-4 py-3 text-[13.5px] leading-relaxed ${state.tone === "success" ? "border-success/25 bg-success-soft text-success-ink" : state.tone === "danger" ? "border-danger/20 bg-danger-soft text-danger-ink" : "border-warning/30 bg-warning-soft text-warning-ink"}`}>
        {state.text}
      </p>

      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-[13.5px] text-danger-ink">
          <span>The settings were changed by someone else while you were looking at them. Reload to see their change before you save yours.</span>
          <Button variant="secondary" onClick={() => router.refresh()}>
            Reload
          </Button>
        </div>
      )}
      {off && <p role="status" className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">Only a Super Admin can change these settings. You can read them.</p>}

      <form onSubmit={save} className="space-y-5" aria-describedby={problems.form ? "settings-form-error" : undefined}>
        <Card className="space-y-4 p-4">
          <h2 className="text-[15px] font-semibold text-ink">Switches</h2>
          <dl className="space-y-1 text-[13px] text-muted">
            <div className="flex flex-wrap gap-x-2">
              <dt>DEMO_ENABLED in this deployment:</dt>
              <dd className="font-medium text-ink">{env.environment ? "on" : "off"}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt>Emergency stop (DEMO_PUBLIC_DISABLED):</dt>
              <dd className="font-medium text-ink">{env.emergencyStop ? "ON, the public demo is stopped" : "off"}</dd>
            </div>
          </dl>
          <label className="flex min-h-11 items-start gap-3 text-[14px] text-ink">
            <input type="checkbox" className="mt-1 size-5 shrink-0 accent-primary" checked={form.enabled} disabled={off} onChange={(e) => set("enabled", e.target.checked)} />
            <span>
              <span className="font-medium">The demo is open to visitors</span>
              <span className="block text-[13px] text-muted">Off: /demo says it is not open. Prospects who already started keep their data.</span>
            </span>
          </label>
          <label className="flex min-h-11 items-start gap-3 text-[14px] text-ink">
            <input type="checkbox" className="mt-1 size-5 shrink-0 accent-primary" checked={form.aiEnabled} disabled={off} onChange={(e) => set("aiEnabled", e.target.checked)} />
            <span>
              <span className="font-medium">The AI chat is on</span>
              <span className="block text-[13px] text-muted">Off: prospects get the guided tour only. On: they may ask the AI team questions, up to the limits below. It also needs a connected language model.</span>
            </span>
          </label>
          {problems.aiEnabled && (
            <p role="alert" className="text-[12.5px] text-danger-ink">
              {problems.aiEnabled}
            </p>
          )}
          {turningAiOn && (
            <div className="space-y-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-[13px] leading-relaxed text-warning-ink">
              <p className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  No real language model has been tested with this chat. Its answers are checked for prices, promises and claims, but those checks have only been run on made-up answers. Every
                  message costs iAcquire money, up to the daily limit below.
                </span>
              </p>
              <label className="flex min-h-11 items-start gap-3">
                <input type="checkbox" className="mt-1 size-5 shrink-0 accent-primary" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I have read this and want the AI chat on.</span>
              </label>
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-4">
          <h2 className="text-[15px] font-semibold text-ink">Limits</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {NUMBERS.map((n) => (
              <Field key={n.key} label={n.label} htmlFor={`s-${n.key}`} hint={n.hint} error={problems[n.key]}>
                <Input
                  id={`s-${n.key}`}
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={DEMO_RANGES[n.key][0]}
                  max={DEMO_RANGES[n.key][1]}
                  value={form[n.key]}
                  disabled={off}
                  onChange={(e) => set(n.key, e.target.value)}
                  aria-invalid={problems[n.key] ? true : undefined}
                />
              </Field>
            ))}
          </div>
        </Card>

        <Card className="space-y-4 p-4">
          <h2 className="text-[15px] font-semibold text-ink">Links and addresses</h2>
          <Field label="Consultation link" htmlFor="s-consultation" hint="Where a prospect is sent after asking for a consultation. A web address starting with https://. Leave empty to show none." error={problems.consultationUrl}>
            <Input id="s-consultation" type="url" inputMode="url" value={form.consultationUrl} disabled={off} onChange={(e) => set("consultationUrl", e.target.value)} maxLength={500} aria-invalid={problems.consultationUrl ? true : undefined} />
          </Field>
          <Field label="Email domains that cannot ask for a demo" htmlFor="s-blocked" hint="One per line, for example a free-mail domain if the demo is for work addresses only. A domain and its subdomains." error={problems.blockedEmailDomains}>
            <Textarea id="s-blocked" rows={4} value={form.blockedEmailDomains} disabled={off} onChange={(e) => set("blockedEmailDomains", e.target.value)} aria-invalid={problems.blockedEmailDomains ? true : undefined} />
          </Field>
        </Card>

        {problems.form && (
          <p id="settings-form-error" role="alert" className="text-[13px] text-danger-ink">
            {problems.form}
          </p>
        )}
        {canManage && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={busy} disabled={!dirty || conflict}>
              Save the settings
            </Button>
            {dirty && (
              <Button type="button" variant="ghost" onClick={() => { setForm(toForm(saved.settings)); setProblems({}); setAck(false); }}>
                Discard my changes
              </Button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
