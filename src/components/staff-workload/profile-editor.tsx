"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { addWorkloadTimeOffAction, removeWorkloadTimeOffAction, updateWorkloadProfileAction } from "@/app/actions/staff-workload";
import { SKILLS, SKILL_LABELS, type Skill } from "@/lib/staff-workload/sources";
import { TIME_OFF_KINDS, TIME_OFF_KIND_TEXT, type TimeOffKind } from "@/lib/staff-workload/time-off";
import type { ProfileView, TimeOffView } from "@/server/staff-workload/profile";

// The manage-permission editor: capacity, working days and recorded skills, plus time off. It never decides who may edit: the actions ask the service, which re-reads the
// permission and the revision from the database. A stale save is shown as a refusal.

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function ProfileEditor({ userId, name, profile, timeOff, today, canManageProfile, canEditTimeOff }: {
  userId: string;
  name: string;
  profile: ProfileView | null;
  timeOff: TimeOffView[];
  today: string;
  canManageProfile: boolean;
  canEditTimeOff: boolean;
}) {
  const router = useRouter();
  const [revision, setRevision] = React.useState(profile?.revision ?? 0);
  const [capacity, setCapacity] = React.useState(profile?.capacityPoints === null || profile?.capacityPoints === undefined ? "" : String(profile.capacityPoints));
  const [days, setDays] = React.useState<number[]>(profile?.workingDays ?? [1, 2, 3, 4, 5]);
  const [skills, setSkills] = React.useState<Record<Skill, number>>(() => {
    const out = {} as Record<Skill, number>;
    for (const s of SKILLS) out[s] = profile?.skills?.[s] ?? 0;
    return out;
  });
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [profileError, setProfileError] = React.useState<string | null>(null);
  const [startsOn, setStartsOn] = React.useState(today);
  const [endsOn, setEndsOn] = React.useState(today);
  const [partDay, setPartDay] = React.useState(false);
  const [kind, setKind] = React.useState<TimeOffKind>("leave");
  const [note, setNote] = React.useState("");
  const [savingTimeOff, setSavingTimeOff] = React.useState(false);
  const [timeOffError, setTimeOffError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingProfile(true);
    setProfileError(null);
    const recorded: Record<string, 1 | 2 | 3> = {};
    for (const s of SKILLS) if (skills[s] > 0) recorded[s] = skills[s] as 1 | 2 | 3;
    const result = await updateWorkloadProfileAction({
      userId,
      expectedRevision: revision,
      capacityPoints: capacity.trim() ? Number(capacity) : null,
      workingDays: days,
      skills: recorded,
    });
    setSavingProfile(false);
    if (!result.ok) {
      setProfileError(result.error);
      return;
    }
    setRevision(result.data.revision);
    toast.success("Capacity and skills saved.");
    router.refresh();
  };

  const addTimeOff = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingTimeOff(true);
    setTimeOffError(null);
    const result = await addWorkloadTimeOffAction({ userId, startsOn, endsOn, partDay, kind, note: note.trim() || undefined });
    setSavingTimeOff(false);
    if (!result.ok) {
      setTimeOffError(result.error);
      return;
    }
    setNote("");
    toast.success(result.data.created ? "Time off recorded." : "That time off was already recorded.");
    router.refresh();
  };

  const remove = async (id: string) => {
    setRemoving(id);
    const result = await removeWorkloadTimeOffAction(id);
    setRemoving(null);
    if (!result.ok) {
      setTimeOffError(result.error);
      return;
    }
    toast.success("Time off removed.");
    router.refresh();
  };

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      {canManageProfile && (
        <form onSubmit={saveProfile} className="space-y-4 rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Capacity and skills for {name}</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Capacity is a number of points over the planning horizon, not hours. Leave it empty to use the team default (or show no label).</p>
          </div>
          {profileError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink">{profileError}</p>}
          <div>
            <Label htmlFor="capacity-points">Capacity points over the horizon</Label>
            <Input id="capacity-points" type="number" min={1} max={200} step={1} inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="Not set" className="mt-1.5 max-w-48" />
          </div>
          <fieldset>
            <legend className="text-[12.5px] font-medium text-ink-2">Working days</legend>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {DAY_NAMES.map((label, i) => {
                const day = i + 1;
                const on = days.includes(day);
                return (
                  <label key={day} className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[12.5px] ${on ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted"}`}>
                    <input type="checkbox" checked={on} onChange={() => setDays((cur) => (cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day].sort((a, b) => a - b)))} className="sr-only" />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-[12.5px] font-medium text-ink-2">Skills recorded by a manager</legend>
            <p className="mt-0.5 text-[11.5px] leading-snug text-muted">Only recorded skills rank suggestions. Nothing is inferred from a person&apos;s work.</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {SKILLS.map((skill) => (
                <label key={skill} className="flex items-center justify-between gap-2 text-[12.5px] text-ink-2">
                  <span>{SKILL_LABELS[skill]}</span>
                  <Select aria-label={`${SKILL_LABELS[skill]} level`} value={String(skills[skill])} onChange={(e) => setSkills((cur) => ({ ...cur, [skill]: Number(e.target.value) }))} className="h-9 w-32 text-[12px]">
                    <option value="0">Not recorded</option>
                    <option value="1">Can help</option>
                    <option value="2">Comfortable</option>
                    <option value="3">Expert</option>
                  </Select>
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" loading={savingProfile} disabled={!days.length}>
            <Save className="size-4" aria-hidden /> Save capacity and skills
          </Button>
        </form>
      )}
      {canEditTimeOff && (
        <div className="space-y-4 rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Time off</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Time off reduces the available days in the planning horizon. It never appears in a client-facing page, and a colleague without the manage permission learns only that someone is away.</p>
          </div>
          {timeOffError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink">{timeOffError}</p>}
          {timeOff.length > 0 && (
            <ul className="divide-y divide-line text-[12.5px]">
              {timeOff.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0">
                  <span>
                    {entry.startsOn === entry.endsOn ? entry.startsOn : `${entry.startsOn} to ${entry.endsOn}`}
                    {entry.partDay ? " · half day" : ""}
                    {entry.kind ? ` · ${TIME_OFF_KIND_TEXT[entry.kind]}` : ""}
                    {entry.note ? ` · ${entry.note}` : ""}
                  </span>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove time off from ${entry.startsOn}`} onClick={() => void remove(entry.id)} loading={removing === entry.id}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addTimeOff} className="space-y-3 border-t border-line pt-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="time-off-start">First day</Label>
                <Input id="time-off-start" type="date" value={startsOn} onChange={(e) => { setStartsOn(e.target.value); if (endsOn < e.target.value) setEndsOn(e.target.value); }} className="mt-1" required />
              </div>
              <div>
                <Label htmlFor="time-off-end">Last day</Label>
                <Input id="time-off-end" type="date" min={startsOn} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} className="mt-1" required />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="time-off-kind">Kind</Label>
                <Select id="time-off-kind" value={kind} onChange={(e) => setKind(e.target.value as TimeOffKind)} className="mt-1">
                  {TIME_OFF_KINDS.map((k) => <option key={k} value={k}>{TIME_OFF_KIND_TEXT[k]}</option>)}
                </Select>
              </div>
              <label className="flex items-end gap-2 pb-2 text-[12.5px] text-ink-2">
                <input type="checkbox" checked={partDay} onChange={(e) => setPartDay(e.target.checked)} /> Half a day (one day)
              </label>
            </div>
            <div>
              <Label htmlFor="time-off-note">Note (optional, private to managers)</Label>
              <Textarea id="time-off-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} rows={2} className="mt-1" />
            </div>
            <Button type="submit" loading={savingTimeOff} disabled={!startsOn || !endsOn || endsOn < startsOn}>
              <CalendarPlus className="size-4" aria-hidden /> Add time off
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
