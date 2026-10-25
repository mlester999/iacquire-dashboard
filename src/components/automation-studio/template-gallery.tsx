"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, Layers, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Select } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { isReviewTemplate } from "@/components/crm/reviews/model";
import { cn } from "@/lib/utils";
import { createFromStudioTemplateAction } from "@/app/actions/automation-studio";
import { REACH_LABELS, STUDIO_TEMPLATES, STUDIO_TEMPLATE_CATEGORIES, templateMatches, templateReadiness, type StudioInputSpec, type StudioTemplate } from "@/lib/automation-studio/templates";
import type { EditorOptions } from "@/components/crm/workflows/types";

/**
 * Ready-made automations: complete workflows, not prompts. Each card says what it does, what it reaches outside iAcquire and what the workspace is still
 * missing; setting one up asks only for the choices that are the workspace's own, and opens the result in the same editor as everything else (the builder
 * can keep changing it by chat, and so can the person by hand). Nothing runs until it has been tested, published and, if it reaches outside, approved.
 */
export function TemplateGallery({ options, canBuild }: { options: EditorOptions; canBuild: boolean }) {
  const [category, setCategory] = React.useState<string | null>(null);
  const [setup, setSetup] = React.useState<StudioTemplate | null>(null);
  const [query, setQuery] = React.useState("");
  const shown = templateMatches(STUDIO_TEMPLATES.filter((t) => !category || t.category === category), query);

  return (
    <section aria-labelledby="studio-templates">
      <div>
        <h2 id="studio-templates" className="text-[18px] font-semibold text-ink">Ready-made automations</h2>
        <p className="mt-1 max-w-3xl text-[13.5px] text-muted">Complete automations you set up in a minute. Each one opens in the editor, where you can change anything by chatting or by hand, test it with a real contact, and only then switch it on.</p>
      </div>
      <div className="relative mt-4 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
        <input
          type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, for example “slack new lead” or “review”" aria-label="Search ready-made automations"
          className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-[13.5px] text-ink placeholder:text-faint focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Template categories">
        <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)} className={cn("rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors", category === null ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}>All ({STUDIO_TEMPLATES.length})</button>
        {STUDIO_TEMPLATE_CATEGORIES.map((c) => (
          <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c === category ? null : c)} className={cn("rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors", category === c ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong")}>{c}</button>
        ))}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{shown.length === 1 ? "1 ready-made automation" : `${shown.length} ready-made automations`}</p>
      {shown.length === 0 && (
        <p className="mt-5 rounded-2xl border border-dashed border-line-strong bg-surface p-5 text-[13.5px] text-muted">
          No ready-made automation matches{query.trim() ? ` “${query.trim()}”` : ""}. Clear the search, or describe what you want in the box above and the builder will make it.
        </p>
      )}
      <ul className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((t) => {
          const ready = templateReadiness(t, options);
          return (
            <li key={t.key} className="flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-soft" data-template={t.key}>
              <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">{t.category}</p>
              <h3 className="mt-1 text-[15px] font-semibold text-ink">{t.name}</h3>
              <p className="mt-1 flex-1 text-[13px] leading-relaxed text-muted">{t.description}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {t.reach.length ? t.reach.map((r) => <Badge key={r} tone="warning">{REACH_LABELS[r]}</Badge>) : <Badge tone="neutral">Stays inside iAcquire</Badge>}
              </div>
              <p className={cn("mt-3 text-[12px]", ready.ready ? "text-success-ink" : "text-warning-ink")}>
                {ready.ready ? "Your workspace has what this needs." : `Needs ${ready.missing.join(" and ")} first.`}
              </p>
              {ready.notes.map((n) => <p key={n} className="mt-1 text-[12px] text-muted">{n}</p>)}
              <div className="mt-3 flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setSetup(t)} disabled={!canBuild || !ready.ready}>Set up</Button>
                {!ready.ready && (t.inputs.some((i) => i.kind === "slack" || i.kind === "http")) && (
                  <Link href="/automation-studio/connections" className="text-[12.5px] font-medium text-primary hover:underline">Add a connection</Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {setup && <SetupDialog template={setup} options={options} onClose={() => setSetup(null)} />}
    </section>
  );
}

const CHANNEL = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" } as const;
const STATUS = { active: "verified", unverified: "not verified yet", needs_attention: "needs attention" } as Record<string, string>;

function choicesFor(spec: StudioInputSpec, o: EditorOptions): Array<{ value: string; label: string; group?: string }> {
  switch (spec.kind) {
    case "tag": return o.tags.map((t) => ({ value: t.id, label: t.name }));
    case "user": return o.members.map((m) => ({ value: m.id, label: m.name }));
    case "pipeline": return o.pipelines.map((p) => ({ value: p.id, label: p.name }));
    case "stage": return o.pipelines.flatMap((p) => p.stages.filter((s) => s.kind === "open").map((s) => ({ value: JSON.stringify({ pipelineId: p.id, stageId: s.id }), label: s.name, group: p.name })));
    case "message_template": return o.templates.map((t) => ({ value: t.id, label: `${t.name} (${CHANNEL[t.channel as keyof typeof CHANNEL] ?? t.channel})` }));
    case "review_template": return o.templates.filter(isReviewTemplate).map((t) => ({ value: t.id, label: `${t.name} (${CHANNEL[t.channel as keyof typeof CHANNEL] ?? t.channel})` }));
    case "calendar": return o.calendars.map((c) => ({ value: c.id, label: c.name }));
    case "form": return (o.forms ?? []).map((f) => ({ value: f.id, label: f.name }));
    case "slack": return (o.connections ?? []).filter((c) => c.kind === "slack_webhook").map((c) => ({ value: c.id, label: `${c.name} (${STATUS[c.status] ?? c.status})` }));
    case "http": return (o.connections ?? []).filter((c) => c.kind === "http").map((c) => ({ value: c.id, label: `${c.name}, ${c.host} (${STATUS[c.status] ?? c.status})` }));
    case "employee": return o.employees.filter((e) => e.enabled).map((e) => ({ value: e.roleKey, label: e.name }));
  }
}

function SetupDialog({ template, options, onClose }: { template: StudioTemplate; options: EditorOptions; onClose: () => void }) {
  const router = useRouter();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const missing = template.inputs.filter((s) => s.required && !values[s.key]);

  const create = async () => {
    setBusy(true);
    setError(null);
    const inputs = Object.fromEntries(Object.entries(values).filter(([, v]) => v).map(([k, v]) => [k, v.startsWith("{") ? JSON.parse(v) : v]));
    const res = await createFromStudioTemplateAction(template.key, { inputs });
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }
    router.push(`/automation-studio/${res.data.id}`);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={template.name}
      description={template.description}
      size="md"
      icon={<Layers className="size-5" aria-hidden />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="brand" loading={busy} disabled={missing.length > 0} onClick={() => void create()}>Create automation</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!missing.length) void create(); }}>
        {template.inputs.length === 0 && <p className="text-[13.5px] text-muted">This one needs nothing from you. You can change everything in the editor.</p>}
        {template.inputs.map((spec) => {
          const choices = choicesFor(spec, options);
          const groups = [...new Set(choices.map((c) => c.group).filter(Boolean))] as string[];
          const id = `tpl-${spec.key}`;
          return (
            <Field key={spec.key} label={spec.label} htmlFor={id} hint={spec.help} optional={!spec.required}>
              <Select id={id} value={values[spec.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [spec.key]: e.target.value }))}>
                <option value="">{spec.required ? "Choose…" : "None"}</option>
                {groups.length
                  ? groups.map((g) => <optgroup key={g} label={g}>{choices.filter((c) => c.group === g).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</optgroup>)
                  : choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
            </Field>
          );
        })}
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-muted">{template.before}</p>
        {template.reach.length > 0 && (
          <p className="rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-warning-ink" role="note">
            {template.reach.map((r) => REACH_LABELS[r]).join(". ")}. It does nothing until you test it, publish it and the owner of your workspace approves this exact version.
          </p>
        )}
        {error && <p role="alert" className="flex items-start gap-1.5 text-[13px] text-danger-ink"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>}
      </form>
    </Dialog>
  );
}
