"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { saveReputationSettingsAction } from "@/app/actions/reputation";
import { THRESHOLD_LIMITS } from "@/lib/reputation/scores";
import { SETTING_LIMITS, type ReputationSettings } from "@/lib/reputation/settings";

// How the team handles low private feedback. Everything here is about the TEAM's follow-up: none of it changes who is asked for a review, which public review links a
// customer sees, or what they are told to do before posting one. Only settings that already do something are shown.

const HOUR_CHOICES = [2, 4, 8, 24, 48, 72, 168];
const hoursLabel = (h: number) => (h === 168 ? "1 week" : h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hours`);
const starLabel = (n: number) => `${n} star${n === 1 ? "" : "s"}`;

function Check({ id, checked, onChange, disabled, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean; label: string; hint: string }) {
  return (
    <div className="relative flex items-start gap-3 py-1.5">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 rounded border-line-strong accent-[var(--color-primary,#2563eb)]" />
      <div className="min-w-0">
        <label htmlFor={id} className="text-[14px] font-medium text-ink after:absolute after:inset-0 after:content-['']">{label}</label>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{hint}</p>
      </div>
    </div>
  );
}

export function ReputationSettingsPanel({ orgId, settings, canEdit }: { orgId: string | null; settings: ReputationSettings; canEdit: boolean }) {
  const { run, busy } = useCrmAction();
  // The version the form started from. A save names it, so edits made on top of old settings can never overwrite newer ones; the workspace remounts this panel
  // (key = version) when the page brings newer settings, so it always starts from the latest.
  const [loaded, setLoaded] = React.useState(settings);
  const [d, setD] = React.useState({ stars: settings.escalateAtOrBelow, nps: settings.npsDetractorMax, hours: settings.acknowledgeWithinHours, sla: settings.slaRemindersEnabled, nudge: settings.outcomeNudgesEnabled });
  const dirty = d.stars !== loaded.escalateAtOrBelow || d.nps !== loaded.npsDetractorMax || d.hours !== loaded.acknowledgeWithinHours || d.sla !== loaded.slaRemindersEnabled || d.nudge !== loaded.outcomeNudgesEnabled;
  const hourOptions = HOUR_CHOICES.includes(d.hours) ? HOUR_CHOICES : [...HOUR_CHOICES, d.hours].filter((h) => h >= SETTING_LIMITS.acknowledgeWithinHours.min && h <= SETTING_LIMITS.acknowledgeWithinHours.max).sort((a, b) => a - b);
  const stars = Array.from({ length: THRESHOLD_LIMITS.escalateAtOrBelow.max - THRESHOLD_LIMITS.escalateAtOrBelow.min + 1 }, (_, i) => THRESHOLD_LIMITS.escalateAtOrBelow.min + i);
  const tenths = Array.from({ length: THRESHOLD_LIMITS.npsDetractorMax.max - THRESHOLD_LIMITS.npsDetractorMax.min + 1 }, (_, i) => THRESHOLD_LIMITS.npsDetractorMax.min + i);

  async function save() {
    const saved = await run(
      "save",
      () => saveReputationSettingsAction(orgId, { escalateAtOrBelow: d.stars, npsDetractorMax: d.nps, acknowledgeWithinHours: d.hours, slaRemindersEnabled: d.sla, outcomeNudgesEnabled: d.nudge }, loaded.version),
      "Settings saved.",
    );
    if (saved && typeof saved === "object") setLoaded(saved as ReputationSettings);
  }

  return (
    <section aria-label="Reputation settings" className="max-w-2xl space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">Low private feedback</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          When a customer&apos;s private rating or recommend score is low, or they write a complaint with no score, your team gets a follow-up: a task, a notice, a flag in the inbox, and the customer&apos;s automatic program messages stop.
          It never changes who you ask for a review or which public review links they see. Feedback already received keeps the level it was judged by.
        </p>
      </div>
      {settings.isDefault && <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">Nothing has been changed yet, so these are the standard settings.</p>}
      <Field label="Treat a private rating as low when it is at or below" htmlFor="rs-stars">
        <Select id="rs-stars" value={String(d.stars)} disabled={!canEdit} onChange={(e) => setD((x) => ({ ...x, stars: Number(e.target.value) }))} className="text-[16px] sm:text-[14px]">
          {stars.map((n) => <option key={n} value={n}>{starLabel(n)}{n === 2 ? " (standard)" : ""}</option>)}
        </Select>
      </Field>
      <Field label="Treat a recommend score (0 to 10) as low when it is at or below" htmlFor="rs-nps" hint="For surveys that ask how likely a customer is to recommend you. The Satisfaction view always uses the standard groups: 0 to 6 are detractors.">
        <Select id="rs-nps" value={String(d.nps)} disabled={!canEdit} onChange={(e) => setD((x) => ({ ...x, nps: Number(e.target.value) }))} className="text-[16px] sm:text-[14px]">
          {tenths.map((n) => <option key={n} value={n}>{n}{n === 6 ? " (standard)" : ""}</option>)}
        </Select>
      </Field>
      <Field label="Time to acknowledge low feedback" htmlFor="rs-hours" hint="Its follow-up task is due when this time ends, and the reminder below goes out if nobody has acknowledged it by then.">
        <Select id="rs-hours" value={String(d.hours)} disabled={!canEdit} onChange={(e) => setD((x) => ({ ...x, hours: Number(e.target.value) }))} className="text-[16px] sm:text-[14px]">
          {hourOptions.map((h) => <option key={h} value={h}>{hoursLabel(h)}{h === 24 ? " (standard)" : ""}</option>)}
        </Select>
      </Field>
      <Check id="rs-sla" checked={d.sla} disabled={!canEdit} onChange={(v) => setD((x) => ({ ...x, sla: v }))} label="Remind the team once if nobody has acknowledged low feedback in time" hint="The owner, the managers and the person the follow-up task is assigned to are told. It is not repeated." />
      <Check id="rs-nudge" checked={d.nudge} disabled={!canEdit} onChange={(v) => setD((x) => ({ ...x, nudge: v }))} label="Remind the owner each day to record how finished appointments went" hint="Follow-ups after a visit start only once an appointment is marked attended or a no-show by a person. This reminder counts the appointments still open; it never marks anything for you." />
      {canEdit ? (
        <Button variant="brand" loading={busy("save")} disabled={!dirty} onClick={save}>Save settings</Button>
      ) : (
        <p className="text-[12.5px] text-muted">Only owners and managers in the client&apos;s own workspace can change these.</p>
      )}
    </section>
  );
}
