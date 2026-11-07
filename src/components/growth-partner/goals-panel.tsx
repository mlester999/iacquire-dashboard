"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle, Select } from "@/components/ui/primitives";
import {
  GROWTH_PARTNER_GOAL_CADENCES,
  GROWTH_PARTNER_GOAL_DEFINITIONS,
  GROWTH_PARTNER_GOAL_METRICS,
  type GrowthPartnerGoalCadence,
  type GrowthPartnerGoalMetric,
  type GrowthPartnerGoalProgress,
} from "@/lib/ai-growth-partner-goals";
import { saveGrowthPartnerGoalAction, setGrowthPartnerGoalEnabledAction } from "@/app/actions/ai-growth-partner";

const cadenceLabels: Record<GrowthPartnerGoalCadence, string> = { weekly: "Weekly", monthly: "Monthly" };

export function GrowthPartnerGoalsPanel({
  goals,
  canManage,
  hasPartner,
}: {
  goals: GrowthPartnerGoalProgress[];
  canManage: boolean;
  hasPartner: boolean;
}) {
  const router = useRouter();
  const [metric, setMetric] = React.useState<GrowthPartnerGoalMetric>("leads_approved");
  const [cadence, setCadence] = React.useState<GrowthPartnerGoalCadence>("weekly");
  const [targetText, setTargetText] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const selectedGoal = goals.find((goal) => goal.metric === metric && goal.cadence === cadence);

  function changeMetric(value: string) {
    const nextMetric = value as GrowthPartnerGoalMetric;
    setMetric(nextMetric);
    setTargetText(String(goals.find((goal) => goal.metric === nextMetric && goal.cadence === cadence)?.targetValue ?? ""));
    setError(null);
    setNotice(null);
  }

  function changeCadence(value: string) {
    const nextCadence = value as GrowthPartnerGoalCadence;
    setCadence(nextCadence);
    setTargetText(String(goals.find((goal) => goal.metric === metric && goal.cadence === nextCadence)?.targetValue ?? ""));
    setError(null);
    setNotice(null);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const result = await saveGrowthPartnerGoalAction({
        metric,
        cadence,
        targetValue: Number(targetText),
        baseRevision: selectedGoal?.revision ?? null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Growth target saved. Results use recorded workspace activity.");
      router.refresh();
    } catch {
      setError("The growth target could not be saved. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function toggle(goal: GrowthPartnerGoalProgress) {
    if (busy) return;
    setBusy(goal.id);
    setError(null);
    setNotice(null);
    try {
      const result = await setGrowthPartnerGoalEnabledAction({ goalId: goal.id, enabled: !goal.enabled, baseRevision: goal.revision });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(result.data?.enabled ? "Growth target resumed." : "Growth target paused.");
      router.refresh();
    } catch {
      setError("The growth target could not be changed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="growth-goals-title">
      <Card className="border border-line bg-surface shadow-soft">
        <CardHeader className="items-center">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><Target className="size-5" aria-hidden /></div>
            <div className="min-w-0">
              <CardTitle><span id="growth-goals-title">Growth goals</span></CardTitle>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">Set measurable targets and compare them with activity recorded in this workspace.</p>
            </div>
          </div>
          <Badge tone="violet">Targets, not guarantees</Badge>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <p className="rounded-xl border border-line bg-surface-2/55 px-3.5 py-3 text-[13px] leading-relaxed text-muted">
            Progress uses the same definitions as Performance Snapshot reports and follows the workspace time zone. Only recorded activity is counted. No target predicts or guarantees business results.
          </p>
          {error && <p role="alert" className="text-[13px] text-danger-ink">{error}</p>}
          {notice && <p role="status" className="text-[13px] text-success-ink">{notice}</p>}

          {goals.length > 0 ? (
            <ul className="grid gap-2 sm:grid-cols-2">
              {goals.map((goal) => (
                <li key={goal.id} className="rounded-xl border border-line bg-surface px-3.5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">{goal.metricLabel}</span>
                    <Badge tone={goal.enabled ? "success" : "neutral"}>{goal.enabled ? "Tracking" : "Paused"}</Badge>
                    <Badge tone="neutral">{cadenceLabels[goal.cadence]}</Badge>
                    <span className="ml-auto text-[12px] text-muted">Target {goal.targetValue}</span>
                  </div>
                  <p className="mt-2 text-[12px] leading-relaxed text-muted">{GROWTH_PARTNER_GOAL_DEFINITIONS[goal.metric].description}</p>
                  {goal.enabled && goal.canViewProgress && goal.actualValue !== null && goal.percentComplete !== null ? (
                    <div className="mt-3">
                      <div className="flex items-baseline justify-between gap-2 text-[12px]">
                        <span className="font-medium text-ink-2">{goal.actualValue} of {goal.targetValue} · {goal.periodLabel.toLowerCase()}</span>
                        <span className="tabular-nums text-muted">{goal.remainingValue === 0 ? "Target met" : `${goal.remainingValue} to go`}</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={`${goal.metricLabel} ${goal.cadence} target progress`} aria-valuemin={0} aria-valuemax={goal.targetValue} aria-valuenow={Math.min(goal.actualValue, goal.targetValue)}>
                        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${goal.percentComplete}%` }} />
                      </div>
                    </div>
                  ) : goal.enabled && !goal.canViewProgress ? (
                    <p className="mt-3 text-[12px] text-muted">Your workspace access does not include this metric&apos;s underlying records.</p>
                  ) : goal.enabled ? (
                    <p className="mt-3 text-[12px] text-muted">No recorded progress is available yet.</p>
                  ) : null}
                  {canManage && (
                    <Button type="button" variant="ghost" size="sm" className="mt-2" loading={busy === goal.id} disabled={busy !== null} onClick={() => void toggle(goal)}>
                      {goal.enabled ? <><Pause className="size-3.5" aria-hidden /> Pause target</> : <><Play className="size-3.5" aria-hidden /> Resume target</>}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-muted">No measurable goals have been set for this workspace.</p>}

          {canManage && (
            <form className="grid gap-3 rounded-xl border border-primary/15 bg-surface-2/45 p-3.5 sm:grid-cols-[minmax(0,1.2fr)_minmax(120px,.7fr)_minmax(110px,.55fr)_auto] sm:items-end" onSubmit={(event) => void save(event)}>
              <label className="block space-y-1.5 text-[13px] font-medium text-ink-2">Metric
                <Select value={metric} onChange={(event) => changeMetric(event.target.value)}>
                  {GROWTH_PARTNER_GOAL_METRICS.map((key) => <option key={key} value={key}>{GROWTH_PARTNER_GOAL_DEFINITIONS[key].label}</option>)}
                </Select>
              </label>
              <label className="block space-y-1.5 text-[13px] font-medium text-ink-2">Period
                <Select value={cadence} onChange={(event) => changeCadence(event.target.value)}>
                  {GROWTH_PARTNER_GOAL_CADENCES.map((value) => <option key={value} value={value}>{cadenceLabels[value]}</option>)}
                </Select>
              </label>
              <label className="block space-y-1.5 text-[13px] font-medium text-ink-2">Target count
                <input className="h-10 w-full rounded-xl border border-line bg-surface px-3 text-[14px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40" type="number" min={1} max={100_000} step={1} inputMode="numeric" required value={targetText} onChange={(event) => setTargetText(event.target.value)} aria-label="Target count" />
              </label>
              <Button type="submit" loading={busy === "save"} disabled={!hasPartner || busy !== null || !targetText}>{selectedGoal ? "Update target" : "Save target"}</Button>
              <p className="text-[12px] leading-relaxed text-muted sm:col-span-4">Counts are capped at 100,000 and are stored for this workspace only. The result definitions are shown with each target.</p>
            </form>
          )}
          {!canManage && <p className="border-t border-line pt-3 text-[12px] leading-relaxed text-muted">Only workspace owners and admins can set or pause goals.</p>}
          {!hasPartner && <p className="text-[12px] text-warning-ink">Set up the AI Growth Partner identity before saving a target.</p>}
        </CardContent>
      </Card>
    </section>
  );
}
