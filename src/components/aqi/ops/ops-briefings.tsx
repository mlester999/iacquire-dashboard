"use client";

import * as React from "react";
import { CalendarClock, Loader2, Newspaper, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, Switch } from "@/components/ui/overlays";
import { Field, Input, Select, Skeleton } from "@/components/ui/primitives";
import { OpsCardView } from "@/components/aqi/ops/ops-cards";
import { relativeTime } from "@/lib/utils";
import type { OpsBriefingCard, OpsHealthState } from "@/lib/aqi/ops/types";

interface Settings {
  dailyEnabled: boolean; weeklyEnabled: boolean; criticalAlertsEnabled: boolean; timezone: string; dailyHour: number; weeklyDay: number;
  quietStart: number | null; quietEnd: number | null; schedulerConfigured: boolean;
}
interface Summary { id: string; kind: string; title: string; summary: string; status: string; suppressedReason: string | null; createdAt: string }
interface BriefingBody {
  id?: string; title: string; summary: string; generatedAt: string; noteworthy: boolean; sources: string[];
  period: { from: string; to: string; hours: number };
  sections: Array<{ key: string; title: string; state: OpsHealthState; items: Array<{ text: string; href?: string }> }>;
  recommended: Array<{ text: string; href?: string }>;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

function asCard(b: BriefingBody): OpsBriefingCard {
  return { id: b.id ?? "briefing", kind: "briefing", title: b.title, asOf: b.generatedAt, source: `${b.sources.length} data sources`, period: b.period, summary: b.summary, noteworthy: b.noteworthy, sections: b.sections, recommended: b.recommended, sources: b.sources };
}

const STATUS_LABEL: Record<string, string> = { generated: "Stored", delivered: "Delivered", suppressed: "Quiet day, not announced" };

export function OpsBriefings({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [list, setList] = React.useState<Summary[]>([]);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [message, setMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [view, setView] = React.useState<BriefingBody | null>(null);
  const zones = React.useMemo(() => {
    try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"); } catch { return ["UTC"]; }
  }, []);

  const load = React.useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch("/api/aqi/ops/briefings", { cache: "no-store" });
      if (!res.ok) throw new Error("briefings");
      const data = (await res.json()) as { settings: Settings; briefings: Summary[] };
      setSettings(data.settings);
      setList(data.briefings);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch when the panel opens
    if (open) void load();
  }, [open, load]);

  const patch = (p: Partial<Settings>) => setSettings((s) => (s ? { ...s, ...p } : s));

  async function save() {
    if (!settings) return;
    setSaving(true);
    setMessage(null);
    const { schedulerConfigured: _unused, ...body } = settings;
    void _unused;
    const res = await fetch("/api/aqi/ops/briefings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { settings?: Settings; error?: string } | null;
    setSaving(false);
    if (!res?.ok || !data?.settings) { setMessage({ tone: "error", text: data?.error ?? "Settings could not be saved." }); return; }
    setSettings(data.settings);
    setMessage({ tone: "ok", text: "Briefing settings saved." });
  }

  async function generate() {
    setGenerating(true);
    setMessage(null);
    const res = await fetch("/api/aqi/ops/briefings", { method: "POST" }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { id?: string; briefing?: BriefingBody; error?: string } | null;
    setGenerating(false);
    if (!res?.ok || !data?.briefing) { setMessage({ tone: "error", text: data?.error ?? "A briefing could not be generated." }); return; }
    setView({ ...data.briefing, id: data.id });
    void load();
  }

  async function show(id: string) {
    setMessage(null);
    const res = await fetch(`/api/aqi/ops/briefings?id=${id}`, { cache: "no-store" }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { briefing?: BriefingBody; error?: string } | null;
    if (!res?.ok || !data?.briefing) { setMessage({ tone: "error", text: data?.error ?? "That briefing could not be opened." }); return; }
    setView({ ...data.briefing, id });
  }

  const anyScheduled = settings && (settings.dailyEnabled || settings.weeklyEnabled || settings.criticalAlertsEnabled);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Operations briefings" description="Optional summaries of platform health, incidents, approvals, support and costs. Nothing is sent unless you turn it on here.">
      <div className="space-y-5 p-4">
        {status === "loading" && <div className="space-y-3" aria-busy="true"><Skeleton className="h-24" /><Skeleton className="h-40" /></div>}
        {status === "error" && <p className="text-[14px] text-danger-ink" role="alert">Briefing settings could not be loaded. Close and reopen to try again.</p>}
        {settings && status === "ready" && (
          <>
            {!settings.schedulerConfigured && (
              <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft/50 px-3 py-2.5 text-[13px] leading-relaxed text-warning-ink" role="note">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>The scheduler is not configured for this deployment (it needs CRON_SECRET and SCHEDULER_ENABLED, and something calling /api/internal/tick). Scheduled and alert briefings will not run until it is. You can still generate one now.</span>
              </div>
            )}
            <section aria-labelledby="briefing-schedule" className="space-y-4">
              <h3 id="briefing-schedule" className="flex items-center gap-2 text-[14px] font-semibold text-ink"><CalendarClock className="size-4 text-primary" aria-hidden />Schedule</h3>
              {([
                ["dailyEnabled", "Daily briefing", "Sent once a day at the hour below, only when something needs attention."],
                ["weeklyEnabled", "Weekly operational summary", "Sent on the chosen weekday, whether or not anything is wrong."],
                ["criticalAlertsEnabled", "Critical incident alerts", "One alert per critical incident. These ignore quiet hours."],
              ] as const).map(([key, label, hint]) => (
                <div key={key} className="flex items-start justify-between gap-3">
                  <div><p id={`sw-${key}`} className="text-[14px] font-medium text-ink">{label}</p><p className="text-[12px] text-muted">{hint}</p></div>
                  <Switch checked={settings[key]} onCheckedChange={(v) => patch({ [key]: v } as Partial<Settings>)} aria-labelledby={`sw-${key}`} />
                </div>
              ))}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Time zone" htmlFor="brief-tz">
                  <Input id="brief-tz" list="brief-tz-list" value={settings.timezone} onChange={(e) => patch({ timezone: e.target.value })} autoComplete="off" />
                  <datalist id="brief-tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
                </Field>
                <Field label="Send at" htmlFor="brief-hour">
                  <Select id="brief-hour" value={settings.dailyHour} onChange={(e) => patch({ dailyHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select>
                </Field>
                <Field label="Weekly summary day" htmlFor="brief-day">
                  <Select id="brief-day" value={settings.weeklyDay} onChange={(e) => patch({ weeklyDay: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select>
                </Field>
              </div>
              <fieldset className="rounded-xl border border-line p-3">
                <legend className="px-1 text-[13px] font-medium text-ink-2">Quiet hours (optional)</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="From" htmlFor="quiet-start"><Select id="quiet-start" value={settings.quietStart ?? ""} onChange={(e) => patch({ quietStart: e.target.value === "" ? null : Number(e.target.value), quietEnd: e.target.value === "" ? null : settings.quietEnd ?? 22 })}><option value="">Off</option>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select></Field>
                  <Field label="Until" htmlFor="quiet-end"><Select id="quiet-end" value={settings.quietEnd ?? ""} disabled={settings.quietStart === null} onChange={(e) => patch({ quietEnd: e.target.value === "" ? null : Number(e.target.value) })}><option value="">Off</option>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select></Field>
                </div>
                <p className="mt-2 text-[12px] text-muted">Daily and weekly briefings wait until quiet hours end. Delivery is an in-app notification; email follows your notification email setting.</p>
              </fieldset>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void save()} loading={saving}>Save settings</Button>
                {anyScheduled && settings.schedulerConfigured && <span className="text-[12px] text-muted">Runs when the scheduler next ticks.</span>}
              </div>
            </section>

            <section aria-labelledby="briefing-now" className="space-y-3 border-t border-line pt-4">
              <h3 id="briefing-now" className="flex items-center gap-2 text-[14px] font-semibold text-ink"><Newspaper className="size-4 text-primary" aria-hidden />Briefings</h3>
              <Button variant="secondary" onClick={() => void generate()} disabled={generating}>{generating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}Generate one now</Button>
              {message && <p className={message.tone === "ok" ? "text-[13px] text-success-ink" : "text-[13px] text-danger-ink"} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p>}
              {list.length === 0 ? <p className="text-[14px] text-muted">No briefings yet.</p> : (
                <ul className="space-y-1.5">
                  {list.map((b) => (
                    <li key={b.id}>
                      <button type="button" onClick={() => void show(b.id)} className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-left hover:bg-surface-2">
                        <span className="block text-[14px] font-medium text-ink">{b.title}</span>
                        <span className="block text-[12px] text-muted">{STATUS_LABEL[b.status] ?? b.status} · {relativeTime(b.createdAt)}</span>
                        <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted">{b.summary}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {view && <OpsCardView card={asCard(view)} onActionOutcome={() => undefined} />}
            </section>
          </>
        )}
      </div>
    </Sheet>
  );
}
