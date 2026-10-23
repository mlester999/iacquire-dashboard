"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Layers, Lock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { useCrmAction } from "@/components/crm/ui";
import { createBatchAction, updateBatchAction } from "@/app/actions/reputation";
import { BATCH_SOURCES, BATCH_SOURCE_LABELS, type BatchSource } from "@/lib/reputation/ask-criteria";
import { draftProblem, emptyDraft, inputFromDraft, RATE_CHOICES, type BatchDraft } from "@/lib/reputation/batch-form";
import { BATCH_STATUS_LABELS, MAX_BATCH_PEOPLE, type BatchStatus, type BatchView } from "@/lib/reputation/batches";
import { CHANNEL_LABELS } from "@/lib/messaging";
import type { CrmScope } from "@/server/crm/page";
import type { ReviewTemplateOption } from "@/server/crm/reviews";
import type { BatchBuilderOptions } from "@/server/reputation/batches";

// CRM → Reviews → Batches. One approved ask to many customers, chosen only by a service that was completed for them (never by how they felt), sent at a gentle pace through the
// same checks as one review request. This file is the list of batches and the form that makes or changes one; the batch itself is in batch-detail.tsx.

export const statusTone = (s: BatchStatus): "neutral" | "primary" | "success" | "warning" | "danger" =>
  s === "completed" ? "success" : s === "paused" ? "warning" : s === "stopped" ? "danger" : s === "cancelled" || s === "draft" ? "neutral" : "primary";

function Checks({ legend, hint, items, selected, onChange, disabled }: { legend: string; hint?: string; items: Array<{ id: string; label: string }>; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const ids = React.useId();
  if (!items.length) return null;
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[13px] font-medium text-ink">{legend} <span className="font-normal text-faint">Optional</span></legend>
      {hint && <p className="text-[12.5px] leading-relaxed text-muted">{hint}</p>}
      <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-xl border border-line p-1.5">
        {items.map((it) => (
          <label key={it.id} htmlFor={`${ids}-${it.id}`} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-[14px] text-ink hover:bg-surface-2 sm:min-h-9">
            <input
              id={`${ids}-${it.id}`}
              type="checkbox"
              className="size-5 shrink-0 rounded border-line-strong accent-[var(--color-primary,#2563eb)]"
              checked={selected.includes(it.id)}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? [...selected, it.id] : selected.filter((x) => x !== it.id))}
            />
            <span className="min-w-0 truncate">{it.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Makes a batch, or changes one that has not been approved. Saving sends nothing: the next step is the preview and the owner's approval. */
export function BatchFormDialog({ scope, open, onOpenChange, templates, options, surveysEnabled, today, initial, editing }: {
  scope: CrmScope;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templates: ReviewTemplateOption[];
  options: BatchBuilderOptions;
  surveysEnabled: boolean;
  /** The workspace's date today (YYYY-MM-DD): no day after it can be chosen. */
  today: string;
  initial?: BatchDraft | null;
  /** The batch being changed, with the time it was last saved (so two people can't overwrite each other). */
  editing?: { id: string; updatedAt: string } | null;
}) {
  const { run, busy } = useCrmAction();
  const router = useRouter();
  const ids = React.useId();
  const [d, setD] = React.useState<BatchDraft>(() => initial ?? emptyDraft(today));
  const [error, setError] = React.useState<string | null>(null);
  const set = <K extends keyof BatchDraft>(k: K, v: BatchDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const serviceTemplates = templates.filter((t) => t.purpose === "service");
  const template = serviceTemplates.find((t) => t.id === d.templateId) ?? null;

  const save = async () => {
    const problem = draftProblem(d);
    setError(problem);
    if (problem) return;
    const input = inputFromDraft(d);
    if (editing) {
      const ok = await run("save-batch", () => updateBatchAction(scope.orgId, editing.id, input, editing.updatedAt), (r) => (r.returnedToDraft ? "Batch saved. It went back to a draft because you changed what the owner would approve." : "Batch saved."));
      if (ok) onOpenChange(false);
      return;
    }
    const created = await run("save-batch", () => createBatchAction(scope.orgId, input), "Batch created. Look at who would be asked, then ask the owner to approve it.");
    if (created) {
      onOpenChange(false);
      router.push(`${scope.base}/reviews?tab=batches&batch=${created.id}`);
    }
  };

  const inputClass = "text-[16px] sm:text-[14px]";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={editing ? "Change this batch" : "New batch"}
      description="Choose the customers a service was finished for. You'll see exactly who would be asked, and who would not, before anything is approved or sent."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={busy("save-batch")} onClick={save}>{editing ? "Save changes" : "Create batch"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] text-danger-ink">{error}</p>}
        <Field label="Name" htmlFor={`${ids}-name`} hint="Only your team sees this.">
          <Input id={`${ids}-name`} maxLength={120} value={d.name} placeholder="October visits" className={inputClass} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Message template" htmlFor={`${ids}-template`} hint={serviceTemplates.length ? "Approved service templates that contain {{review.link}}. The owner approves this exact wording." : undefined}>
          <Select id={`${ids}-template`} value={d.templateId} className={inputClass} onChange={(e) => set("templateId", e.target.value)} disabled={!serviceTemplates.length}>
            <option value="">{serviceTemplates.length ? "Choose a template" : "No review request templates yet"}</option>
            {serviceTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} · {CHANNEL_LABELS[t.channel]} · v{t.version}</option>)}
          </Select>
          {template && <p className="mt-1 text-[12.5px] text-muted">Goes by {CHANNEL_LABELS[template.channel]}, to customers who agreed to service messages there.</p>}
        </Field>
        {surveysEnabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What to send" htmlFor={`${ids}-kind`}>
              <Select id={`${ids}-kind`} value={d.kind} className={inputClass} onChange={(e) => set("kind", e.target.value === "survey" ? "survey" : "review")}>
                <option value="review">A request for a review</option>
                <option value="survey">A short satisfaction survey</option>
              </Select>
            </Field>
            {d.kind === "survey" && (
              <Field label="The survey's question" htmlFor={`${ids}-scale`}>
                <Select id={`${ids}-scale`} value={d.scale} className={inputClass} onChange={(e) => set("scale", e.target.value === "nps10" ? "nps10" : "csat5")}>
                  <option value="csat5">How was your experience? (1 to 5)</option>
                  <option value="nps10">How likely are you to recommend us? (0 to 10)</option>
                </Select>
              </Field>
            )}
          </div>
        )}
        <Field label="Who to ask" htmlFor={`${ids}-source`} hint="Customers a service was completed for. Nobody is chosen, or left out, by how they felt about it.">
          <Select id={`${ids}-source`} value={d.source} className={inputClass} onChange={(e) => set("source", e.target.value as BatchSource)}>
            {BATCH_SOURCES.map((s) => <option key={s} value={s}>{BATCH_SOURCE_LABELS[s]}</option>)}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From (first day)" htmlFor={`${ids}-from`}>
            <Input id={`${ids}-from`} type="date" max={today} value={d.from} className={inputClass} onChange={(e) => set("from", e.target.value)} />
          </Field>
          <Field label="To (last day)" htmlFor={`${ids}-to`}>
            <Input id={`${ids}-to`} type="date" max={today} value={d.to} className={inputClass} onChange={(e) => set("to", e.target.value)} />
          </Field>
        </div>
        {d.source === "appointments_showed" && (
          <>
            <Checks legend="Only these calendars" items={options.calendars.map((c) => ({ id: c.id, label: c.name }))} selected={d.calendarIds} onChange={(v) => set("calendarIds", v)} />
            <Checks legend="Only these appointment types" items={options.appointmentTypes.map((t) => ({ id: t.id, label: `${t.name} (${t.calendarName})` }))} selected={d.appointmentTypeIds} onChange={(v) => set("appointmentTypeIds", v)} />
          </>
        )}
        {d.source === "deals_won" && options.pipelines.length > 0 && (
          <Field label="Only this pipeline" htmlFor={`${ids}-pipeline`} optional>
            <Select id={`${ids}-pipeline`} value={d.pipelineId} className={inputClass} onChange={(e) => set("pipelineId", e.target.value)}>
              <option value="">Any pipeline</option>
              {options.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Pace" htmlFor={`${ids}-rate`} hint={`At most this many customers are asked in any minute. One batch covers up to ${MAX_BATCH_PEOPLE.toLocaleString("en-US")} people.`}>
          <Select id={`${ids}-rate`} value={String(d.rate)} className={inputClass} onChange={(e) => set("rate", Number(e.target.value))}>
            {[...new Set<number>([...RATE_CHOICES, d.rate])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} a minute</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

const when = (iso: string, tz: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(new Date(iso));

/** The workspace's batches, newest first, and the button that makes a new one. */
export function BatchesPanel({ scope, batches, templates, options, enabled, canPrepare, surveysEnabled, today }: {
  scope: CrmScope;
  batches: BatchView[];
  templates: ReviewTemplateOption[];
  options: BatchBuilderOptions;
  /** A Super Admin switched batches on for the workspace. Without it existing batches can be looked at, paused and cancelled, and nothing new can be made. */
  enabled: boolean;
  canPrepare: boolean;
  surveysEnabled: boolean;
  today: string;
}) {
  const [creating, setCreating] = React.useState(false);
  const ids = React.useId();
  const blocked = !templates.some((t) => t.purpose === "service") ? "Approve a review request template first." : null;
  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`${ids}-title`} className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Layers className="size-4 text-muted" aria-hidden />Ask many customers at once</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
              Choose customers by a service you finished for them, such as appointments marked attended last month. You see who would be asked and who would not, the owner approves the wording, the
              people and the pace, and the messages go out a few at a time through the same checks as one request: only to customers who agreed, never to anyone who opted out or was asked in the last 30 days.
              Everyone gets the same public review links.
            </p>
          </div>
          {canPrepare && enabled && (
            <Button variant="secondary" size="sm" disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />New batch</Button>
          )}
        </div>
        {canPrepare && enabled && blocked && <p className="mt-3 text-[12.5px] text-warning-ink">{blocked}</p>}
        {!canPrepare && enabled && <p className="mt-3 text-[12.5px] text-muted">{scope.agency ? "Batches are the client's own decision: an iAcquire support session can look, not prepare or approve them." : "Owners and managers prepare batches. Only the owner approves one."}</p>}
      </Card>

      {batches.length === 0 ? (
        enabled ? (
          <EmptyState compact icon={<Layers className="size-5" />} title="No batches yet" description="A batch asks the customers you served in a stretch of dates. Nothing is sent until the owner approves it." />
        ) : (
          <EmptyState compact icon={<Lock className="size-5" />} title="Batches aren't switched on" description="Ask your iAcquire contact to switch review request batches on for this workspace. Single review requests work as usual." />
        )
      ) : (
        <ul className="space-y-3" aria-label="Review request batches">
          {batches.map((b) => {
            const c = b.counts;
            return (
              <li key={b.id}>
                <Link href={`${scope.base}/reviews?tab=batches&batch=${b.id}`} className="block rounded-2xl border border-line bg-surface p-4 transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-primary">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-[14.5px] font-semibold text-ink">{b.name}</p>
                    <Badge tone={statusTone(b.status)}>{BATCH_STATUS_LABELS[b.status]}</Badge>
                    <Badge tone="outline">{b.kind === "survey" ? "Survey" : "Review request"}</Badge>
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{b.criteriaText}</p>
                  <p className="mt-1 text-[12.5px] text-muted">
                    {CHANNEL_LABELS[b.channel]} · up to {b.ratePerMinute} a minute · made {when(b.createdAt, scope.timezone)}{b.createdByName ? ` by ${b.createdByName}` : ""}
                  </p>
                  {c.total > 0 ? (
                    <p className="mt-2 text-[13px] text-ink-2 tabular-nums">
                      {c.queued} asked · {c.pending} waiting · {c.excluded} left out{c.failed ? ` · ${c.failed} not sent` : ""}
                    </p>
                  ) : b.estimate ? (
                    <p className="mt-2 text-[13px] text-ink-2">{b.estimate.eligible} of {b.estimate.total} could be asked when it was last checked.</p>
                  ) : (
                    <p className="mt-2 text-[13px] text-muted">Not checked yet. Open it to see who would be asked.</p>
                  )}
                  {c.notice && <p className="mt-2 text-[12.5px] text-warning-ink">{c.notice.detail}</p>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {canPrepare && enabled && (
        <BatchFormDialog key={creating ? "open" : "closed"} scope={scope} open={creating} onOpenChange={setCreating} templates={templates} options={options} surveysEnabled={surveysEnabled} today={today} />
      )}
    </section>
  );
}
