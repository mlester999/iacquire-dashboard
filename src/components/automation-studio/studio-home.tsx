"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleAlert, Gauge, KeyRound, Search, Sparkles, Workflow as WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { cn, formatDate } from "@/lib/utils";
import { startAutomationAction, startBlankAutomationAction } from "@/app/actions/automation-studio";
import { STARTERS, STARTER_CATEGORIES, searchStarters, starterReadiness, type Starter } from "@/lib/automation-studio/starters";
import type { EditorOptions } from "@/components/crm/workflows/types";
import { TemplateGallery } from "@/components/automation-studio/template-gallery";

export interface HomeWorkflow {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  stepCount: number;
  triggerLabel: string;
  updatedAt: string;
  unpublishedChanges: boolean;
  pausedForPlan: boolean;
  publishedVersion: number | null;
}

const STATUS: Record<HomeWorkflow["status"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  active: { label: "On", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  draft: { label: "Draft", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

const CHIPS = ["new-lead-welcome", "follow-up-sequence", "appointment-team-reminder", "review-request"];

export function StudioHome({ workflows, options, builderReady, builderReason, canBuild, planNotice, timezone }: {
  /** The workspace's time zone: dates are written in it on the server and in the browser alike. */
  timezone: string;
  workflows: HomeWorkflow[];
  options: EditorOptions;
  builderReady: boolean;
  builderReason: string | null;
  canBuild: boolean;
  /** A sentence about the plan to show above everything (a payment problem, a grace period), or null. */
  planNotice: string | null;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = React.useState("");
  const [busy, setBusy] = React.useState<"ai" | "blank" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [category, setCategory] = React.useState<string | null>(null);
  const box = React.useRef<HTMLTextAreaElement>(null);

  const matches = React.useMemo(() => searchStarters(q, category), [q, category]);
  const chips = CHIPS.map((id) => STARTERS.find((s) => s.id === id)!).filter(Boolean);

  const use = (s: Starter) => {
    setPrompt(s.prompt);
    setError(null);
    box.current?.focus();
    box.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const start = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy("ai");
    setError(null);
    const res = await startAutomationAction({ prompt: text });
    if (!res.ok) {
      setError(res.error);
      setBusy(null);
      return;
    }
    router.push(`/automation-studio/${res.data.id}`);
  };
  const startBlank = async () => {
    if (busy) return;
    setBusy("blank");
    setError(null);
    const res = await startBlankAutomationAction();
    if (!res.ok) {
      setError(res.error);
      setBusy(null);
      return;
    }
    router.push(`/automation-studio/${res.data.id}`);
  };

  return (
    <div className="space-y-10">
      {planNotice && <p className="rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13.5px] text-warning-ink" role="note">{planNotice}</p>}
      <div className="mb-6 flex justify-end gap-1">
        <Link href="/automation-studio/usage" className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-primary"><Gauge className="size-3.5" aria-hidden />Usage and plan</Link>
        <Link href="/automation-studio/connections" className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-primary"><KeyRound className="size-3.5" aria-hidden />Connections</Link>
      </div>

      <section aria-labelledby="studio-headline" className="relative overflow-hidden rounded-3xl border border-line bg-surface px-5 py-10 shadow-md sm:px-10 sm:py-14">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(60%_80%_at_50%_0%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_70%)]" />
        <div className="relative mx-auto max-w-3xl text-center">
          <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl brand-gradient text-white shadow-glow"><Sparkles className="size-6" aria-hidden /></span>
          <h1 id="studio-headline" className="mt-5 text-balance text-[28px] font-semibold leading-tight tracking-tight text-ink sm:text-[38px]">What would you like to automate?</h1>
          <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-muted">Describe it the way you would to a colleague. You’ll watch the automation take shape, and you can keep changing it by chatting or by editing it directly.</p>

          <form onSubmit={(e) => { e.preventDefault(); void start(); }} className="mt-8 text-left">
            <label htmlFor="studio-prompt" className="sr-only">What would you like to automate?</label>
            <div className={cn("rounded-2xl border bg-surface p-2 shadow-md transition-shadow focus-within:shadow-glow", error ? "border-danger" : "border-line-strong focus-within:border-primary")}>
              <textarea
                id="studio-prompt"
                ref={box}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start(); } }}
                rows={4}
                maxLength={4000}
                disabled={!canBuild || !builderReady}
                placeholder="For example: When a new lead comes in, text them our welcome message, and if they haven’t replied after two days, remind my team to call them."
                className="block w-full resize-none bg-transparent px-3 py-2.5 text-[15.5px] leading-relaxed text-ink outline-none placeholder:text-faint disabled:opacity-60"
                aria-describedby={error ? "studio-prompt-error" : "studio-prompt-help"}
                aria-invalid={error ? true : undefined}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1">
                <p id="studio-prompt-help" className="text-[12px] text-faint">{builderReady ? "Ctrl+Enter to build. Nothing goes live until you publish it." : ""}</p>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => void startBlank()} loading={busy === "blank"} disabled={!canBuild || busy === "ai"}>Start from scratch</Button>
                  <Button type="submit" variant="brand" size="md" loading={busy === "ai"} disabled={!canBuild || !builderReady || !prompt.trim() || busy === "blank"}>Build it<ArrowRight className="size-4" aria-hidden /></Button>
                </div>
              </div>
            </div>
            {error && <p id="studio-prompt-error" role="alert" className="mt-2 flex items-start gap-1.5 text-[13px] text-danger-ink"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>}
            {!builderReady && <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink" role="note">{builderReason ?? "The AI builder isn't available right now."} Start from scratch to build by hand with the same editor.</p>}
            {!canBuild && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-muted" role="note">Building automations needs the “Build and change automations” permission. Ask the owner of your workspace.</p>}
          </form>

          <div className="mt-5 flex flex-wrap justify-center gap-2" role="group" aria-label="Ideas to start from">
            {chips.map((s) => <button key={s.id} type="button" onClick={() => use(s)} disabled={!canBuild || !builderReady} className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] text-ink-2 shadow-sm transition-colors hover:border-primary hover:text-primary disabled:opacity-50">{s.title}</button>)}
          </div>
        </div>
      </section>

      {workflows.length > 0 && (
        <section aria-labelledby="studio-yours">
          <h2 id="studio-yours" className="text-[18px] font-semibold text-ink">Your automations</h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {workflows.map((w) => (
              <li key={w.id}>
                <Link href={`/automation-studio/${w.id}`} className="group block h-full rounded-2xl border border-line bg-surface p-4 shadow-soft transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md">
                  <div className="flex items-start justify-between gap-2">
                    <span className="inline-flex size-9 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><WorkflowIcon className="size-4" aria-hidden /></span>
                    <Badge tone={STATUS[w.status].tone}>{w.status === "paused" && w.pausedForPlan ? "Paused: plan" : STATUS[w.status].label}</Badge>
                  </div>
                  <p className="mt-3 truncate text-[15px] font-semibold text-ink group-hover:text-primary" title={w.name}>{w.name}</p>
                  <p className="mt-1 line-clamp-1 text-[12.5px] text-muted">{w.triggerLabel} · {w.stepCount} step{w.stepCount === 1 ? "" : "s"}</p>
                  <p className="mt-2 text-[12px] text-faint">{w.unpublishedChanges ? "Has unpublished changes · " : ""}Updated {formatDate(w.updatedAt, timezone)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <TemplateGallery options={options} canBuild={canBuild} />

      <section aria-labelledby="studio-ideas">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="studio-ideas" className="text-[18px] font-semibold text-ink">Start from an idea</h2>
            <p className="mt-1 text-[13.5px] text-muted">Each one is a request the builder turns into a real automation in your workspace. You’ll see it, test it and change it before anything runs.</p>
          </div>
          <div className="relative w-full sm:w-72">
            <label htmlFor="studio-search" className="sr-only">Search ideas</label>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <input id="studio-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ideas" className="h-10 w-full rounded-xl border border-line-strong bg-surface pl-9 pr-3 text-[14px] text-ink outline-none placeholder:text-faint focus:border-primary focus:ring-2 focus:ring-primary/25" />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Categories">
          <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)} className={cn("rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors", category === null ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}>All</button>
          {STARTER_CATEGORIES.map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c === category ? null : c)} className={cn("rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors", category === c ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}>{c}</button>)}
        </div>
        {matches.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-dashed border-line-strong p-8 text-center text-[14px] text-muted">No idea matches “{q}”. Describe what you need in the box above instead.</p>
        ) : (
          <ul className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {matches.map((s) => {
              const ready = starterReadiness(s, options);
              return (
                <li key={s.id} className="flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-soft">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{s.category}</p>
                  <h3 className="mt-1 text-[15px] font-semibold text-ink">{s.title}</h3>
                  <p className="mt-1 flex-1 text-[13px] leading-relaxed text-muted">{s.description}</p>
                  <p className={cn("mt-3 text-[12px]", ready.ready ? "text-success-ink" : "text-warning-ink")}>{ready.ready ? "Your workspace has what this needs." : `Needs ${ready.missing.join(" and ")} first.`}</p>
                  <Button variant="secondary" size="sm" className="mt-3 self-start" onClick={() => use(s)} disabled={!canBuild || !builderReady}>Use this idea</Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
