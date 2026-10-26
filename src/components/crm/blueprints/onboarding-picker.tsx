"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, CheckCircle2, LayoutTemplate, RefreshCw, Search, Sparkles, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Input, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  BLUEPRINT_INDUSTRY_LABELS, BLUEPRINT_SOURCE_LABELS, type BlueprintIndustry,
} from "@/lib/crm/blueprints/types";
import type { BlueprintSummary, StarterView } from "@/lib/crm/blueprints/views";
import type { OnboardingBlueprintChoices } from "@/server/admin/tenants";
import { matchesIndustry, rankForIndustry } from "@/components/crm/blueprints/industry";
import { draftNotes, requirementLabels } from "@/components/crm/blueprints/labels";

/** "blank", "bp:<blueprint id>" or "st:<starter key>". */
export type SetupValue = "blank" | `bp:${string}` | `st:${string}`;

export type SetupChoice = { kind: "blueprint"; blueprintId: string } | { kind: "starter"; starterKey: string } | null;

export function choiceFor(value: SetupValue): SetupChoice {
  if (value.startsWith("bp:")) return { kind: "blueprint", blueprintId: value.slice(3) };
  if (value.startsWith("st:")) return { kind: "starter", starterKey: value.slice(3) };
  return null;
}

type Option =
  | { value: `bp:${string}`; kind: "blueprint"; item: BlueprintSummary }
  | { value: `st:${string}`; kind: "starter"; item: StarterView };

const SEARCH_FROM = 7;

/**
 * The "CRM setup" step of creating a client: a blank CRM, a published Blueprint (ordered for the client's industry), or an iAcquire starter
 * that is not in the library yet. A GoHighLevel client can't take a Blueprint, so the whole choice is disabled with the reason.
 */
export function OnboardingBlueprintPicker({
  value,
  onChange,
  industry,
  choices,
  loading,
  error,
  onRetry,
  disabledReason,
}: {
  value: SetupValue;
  onChange: (v: SetupValue) => void;
  industry: BlueprintIndustry | null;
  choices: OnboardingBlueprintChoices | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Set when a Blueprint can't be chosen (a GoHighLevel client). */
  disabledReason: string | null;
}) {
  const name = React.useId();
  const reasonId = React.useId();
  const [q, setQ] = React.useState("");
  const disabled = !!disabledReason;

  const options = React.useMemo<Option[]>(() => {
    if (!choices) return [];
    return [
      ...rankForIndustry(choices.blueprints, industry).map((item) => ({ value: `bp:${item.id}` as const, kind: "blueprint" as const, item })),
      ...rankForIndustry(choices.starters, industry).map((item) => ({ value: `st:${item.key}` as const, kind: "starter" as const, item })),
    ];
  }, [choices, industry]);
  const term = q.trim().toLowerCase();
  const shown = term
    ? options.filter((o) => [o.item.name, o.item.description, BLUEPRINT_INDUSTRY_LABELS[o.item.industry]].some((s) => s.toLowerCase().includes(term)))
    : options;
  const blueprints = shown.filter((o) => o.kind === "blueprint");
  const starters = shown.filter((o) => o.kind === "starter");
  const matching = blueprints.filter((o) => matchesIndustry(o.item, industry));
  const others = blueprints.filter((o) => !matchesIndustry(o.item, industry));
  const selected = options.find((o) => o.value === value) ?? null;
  const industryLabel = industry ? BLUEPRINT_INDUSTRY_LABELS[industry] : null;

  const radio = (o: Option) => <SetupRadio key={o.value} name={name} option={o} checked={value === o.value} onSelect={() => onChange(o.value)} disabled={disabled} industry={industry} />;

  return (
    <fieldset disabled={disabled} aria-describedby={disabled ? reasonId : undefined} className="min-w-0">
      <legend className="mb-1 text-[14px] font-medium text-ink-2">CRM setup</legend>
      <p className="mb-3 text-[13px] leading-relaxed text-muted">
        Start empty, or copy a Blueprint&apos;s configuration (pipelines, tags, fields, forms, templates and more) into this client&apos;s own CRM. It is applied right after the client is created.
      </p>
      {disabled && (
        <p id={reasonId} className="mb-3 flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {disabledReason}
        </p>
      )}
      <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]", disabled && "opacity-60")}>
        <div className="min-w-0 space-y-3">
          <label className={radioClass(value === "blank", disabled)}>
            <input type="radio" name={name} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={value === "blank"} onChange={() => onChange("blank")} disabled={disabled} />
            <span className="min-w-0">
              <span className="block text-[14px] font-medium text-ink">Blank CRM</span>
              <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">Nothing is added. The team builds its own pipelines, fields, tags and calendars (a basic sales pipeline appears when the board is first opened).</span>
            </span>
          </label>

          {loading && !choices ? (
            <div role="status" className="space-y-2" aria-busy="true" aria-label="Loading Blueprints">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : error ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">
              <span>Blueprints couldn&apos;t be loaded: {error}</span>
              <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
                <RefreshCw className="size-3.5" aria-hidden />Try again
              </Button>
            </div>
          ) : choices && !choices.canApply ? (
            <p className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] text-muted">Your agency role can&apos;t apply Blueprints, so this client starts with a blank CRM.</p>
          ) : choices && options.length === 0 ? (
            <p className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-muted">
              No published Blueprints yet. Publish one in{" "}
              <Link href="/admin/crm-blueprints" className="font-medium text-primary underline-offset-2 hover:underline">CRM Blueprints</Link>, or start with a blank CRM.
            </p>
          ) : choices ? (
            <>
              {options.length >= SEARCH_FROM && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Blueprints" aria-label="Search Blueprints" className="pl-9" />
                </div>
              )}
              <div className="scrollbar-thin max-h-80 space-y-3 overflow-y-auto pr-1">
                {matching.length > 0 && <Group title={`Matches ${industryLabel}`}>{matching.map(radio)}</Group>}
                {others.length > 0 && <Group title={matching.length ? "Other Blueprints" : "Published Blueprints"}>{others.map(radio)}</Group>}
                {starters.length > 0 && (
                  <Group title="iAcquire starters" hint="Not in your library yet. Choosing one adds it to the library as a published Blueprint.">
                    {starters.map(radio)}
                  </Group>
                )}
                {shown.length === 0 && <p className="px-1 text-[13px] text-muted">No Blueprints match “{q.trim()}”.</p>}
              </div>
            </>
          ) : null}
        </div>
        <SetupPreview option={selected} />
      </div>
    </fieldset>
  );
}

function radioClass(checked: boolean, disabled: boolean) {
  return cn(
    "flex items-start gap-3 rounded-xl border p-3 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
    disabled ? "cursor-not-allowed" : "cursor-pointer hover:border-line-strong",
    checked ? "border-primary/40 bg-primary-soft/40" : "border-line",
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} className="space-y-2">
      <div className="px-1">
        <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">{title}</p>
        {hint && <p className="mt-0.5 text-[12px] leading-relaxed text-faint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function SetupRadio({ name, option, checked, onSelect, disabled, industry }: { name: string; option: Option; checked: boolean; onSelect: () => void; disabled: boolean; industry: BlueprintIndustry | null }) {
  const it = option.item;
  return (
    <label className={radioClass(checked, disabled)}>
      <input type="radio" name={name} value={option.value} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={checked} onChange={onSelect} disabled={disabled} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[14px] font-medium text-ink">{it.name}</span>
          {option.kind === "blueprint" && option.item.featured && <Badge tone="violet" className="h-5 px-2 text-[12px]">Featured</Badge>}
        </span>
        <span className="mt-0.5 block text-[12px] text-muted">
          {BLUEPRINT_INDUSTRY_LABELS[it.industry]}
          {option.kind === "blueprint" ? ` · Version ${option.item.currentVersion} · ${BLUEPRINT_SOURCE_LABELS[option.item.source]}` : " · iAcquire starter"}
          {" · "}
          {it.totalAssets} {it.totalAssets === 1 ? "item" : "items"}
          {industry && it.industry !== industry && (it.industry === "general_services" || it.industry === "other") ? " · General purpose" : ""}
        </span>
      </span>
    </label>
  );
}

function SetupPreview({ option }: { option: Option | null }) {
  if (!option) {
    return (
      <div className="rounded-xl border border-dashed border-line p-4 text-[13px] leading-relaxed text-muted">
        <p className="font-medium text-ink-2">Blank CRM</p>
        <p className="mt-1">You can apply a Blueprint to this client later from CRM Blueprints, without touching anything the team has set up.</p>
      </div>
    );
  }
  const it = option.item;
  const notes = draftNotes(it.modules);
  const reqs = requirementLabels(it.requirements);
  return (
    <section aria-label={`Preview of ${it.name}`} className="min-w-0 rounded-xl border border-line bg-surface-2/60 p-4">
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-ink">
          {option.kind === "starter" ? <Sparkles className="size-4" aria-hidden /> : <LayoutTemplate className="size-4" aria-hidden />}
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-ink">{it.name}</p>
          <p className="text-[12px] text-muted">
            {option.kind === "blueprint" ? `Version ${option.item.currentVersion} · ${option.item.sourceLabel ?? BLUEPRINT_SOURCE_LABELS[option.item.source]}` : "Added to your library as version 1, then applied"}
          </p>
        </div>
      </div>
      {it.description && <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-muted">{it.description}</p>}

      <p className="mt-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">What it adds</p>
      {it.modules.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {it.modules.map((m) => (
            <li key={m.section} className="rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-ink-2">
              {m.label} <span className="font-semibold text-ink">{m.count}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[13px] text-muted">This Blueprint is empty.</p>
      )}

      <p className="mt-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Left to set up afterwards</p>
      {reqs.length ? (
        <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">
          {reqs.slice(0, 8).map((r) => (
            <li key={r} className="flex items-start gap-1.5">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-faint" />
              {r}
            </li>
          ))}
          {reqs.length > 8 && <li className="text-muted">and {reqs.length - 8} more on the client&apos;s setup checklist</li>}
        </ul>
      ) : (
        <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted"><CheckCircle2 className="size-3.5 text-success" aria-hidden />Nothing to connect, map or approve.</p>
      )}

      {option.kind === "blueprint" && option.item.compatibility === "partial" && option.item.compatibilityNotes.length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-[12px] text-warning-ink">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {option.item.compatibilityNotes.join(" ")}
        </p>
      )}

      {notes.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-line pt-3 text-[12px] leading-relaxed text-muted">
          {notes.map((n) => (
            <li key={n.key} className="flex items-start gap-1.5">
              {n.icon === "calendar" ? <CalendarClock className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : n.icon === "workflow" ? <Workflow className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <LayoutTemplate className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
