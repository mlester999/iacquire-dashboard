"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ListFilter, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { FilterBuilder, type FilterOptions } from "@/components/crm/filter-builder";
import { cn } from "@/lib/utils";
import { CHANNEL_LABELS } from "@/lib/messaging";
import { LEAD_STATUS_LABELS, PREFERRED_CHANNEL_LABELS, type FieldType } from "@/lib/crm/types";
import { EMPTY_FILTER, type FilterGroup } from "@/lib/crm/filters";
import {
  STEP_KINDS, TRIGGERS, UPDATABLE_FIELDS, type AiTaskConfig, type AssignConfig, type BranchConfig, type CreateOpportunityConfig, type CreateTaskConfig,
  type HttpRequestConfig, type InternalNoteConfig, type MoveStageConfig, type N8nConfig, type NotifyTeamConfig, type SendMessageConfig, type SlackMessageConfig, type TagsConfig, type UpdateFieldConfig,
  type ValidationIssue, type WaitConfig, type WebhookConfig, type WorkflowDefinition, type WorkflowStep,
} from "@/lib/crm/workflow/spec";
import { StepIcon, stepTone } from "@/components/crm/workflows/parts";
import { Choice, DurationInput, MultiPick, SinglePick, Toggle, TokenInsert, WeekdayPick } from "@/components/crm/workflows/pickers";
import { DealConditions } from "@/components/crm/workflows/deal-conditions";
import { conditionsText, namesFrom } from "@/components/crm/workflows/summaries";
import { aiTaskState, sendAsState, type ReadyState } from "@/components/crm/workflows/editor-logic";
import type { EditorOptions } from "@/components/crm/workflows/types";
import { RequestReviewFields } from "@/components/crm/reviews/workflow-step-fields";

export interface StepPanelProps {
  step: WorkflowStep;
  number: number;
  definition: WorkflowDefinition;
  options: EditorOptions;
  issues: ValidationIssue[];
  readOnly: boolean;
  base: string;
  onChange: (step: WorkflowStep) => void;
  onRemove: () => void;
}

/** The settings of one step: the right pickers for its kind, the problems the validator found, and a way to remove it. */
export function StepPanel({ step, number, definition, options, issues, readOnly, base, onChange, onRemove }: StepPanelProps) {
  const spec = STEP_KINDS[step.kind];
  const errorAt = (path: string) => issues.find((i) => i.path === path || i.path?.startsWith(`${path}.`))?.message ?? null;
  // "Can't act right now" warnings show next to the choice they're about (the AI employee, the automation), so they aren't repeated here.
  const general = issues.filter((i) => (!i.path || !i.path.startsWith("config.")) && i.code !== "not_ready");
  const config = (patch: Record<string, unknown>) => onChange({ ...step, config: { ...(step.config as object), ...patch } } as WorkflowStep);
  const replace = (cfg: WorkflowStep["config"]) => onChange({ ...step, config: cfg } as WorkflowStep);
  const ctx: KindProps = { step, definition, options, errorAt, config, replace, base, readOnly };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-xl", stepTone(step.kind))}><StepIcon kind={step.kind} /></span>
        <div className="min-w-0">
          <p className="text-[11.5px] font-semibold uppercase tracking-wider text-faint">Step {number}</p>
          <h3 className="text-[16px] font-semibold text-ink">{spec.label}</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{spec.description}</p>
        </div>
      </div>

      {general.length > 0 && (
        <ul className="space-y-1.5" aria-label="Problems with this step">
          {general.map((i, n) => (
            <li key={`${i.code}-${n}`} className={cn("flex gap-2 rounded-xl px-3 py-2 text-[12.5px]", i.level === "error" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink")}>
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{i.message}
            </li>
          ))}
        </ul>
      )}

      <fieldset disabled={readOnly} className="min-w-0 space-y-4">
        <legend className="sr-only">Settings for step {number}</legend>
        <Field label="Step name" htmlFor="wf-step-name" optional hint="Shown in the run history. Leave empty to use the step's description.">
          <Input id="wf-step-name" value={step.name ?? ""} maxLength={80} placeholder={spec.label} onChange={(e) => onChange({ ...step, name: e.target.value || undefined })} />
        </Field>
        <KindFields {...ctx} />
        {spec.approvable && (
          <div className="border-t border-line pt-4">
            <Toggle
              id="wf-step-ask"
              label="Ask a person before doing this"
              hint="Each time a run reaches this step it waits until someone approves it in Approvals. Declining stops that run."
              checked={!!step.requireApproval}
              onChange={(v) => onChange({ ...step, requireApproval: v || undefined })}
            />
          </div>
        )}
      </fieldset>

      {!readOnly && (
        <div className="border-t border-line pt-4">
          <Button variant="ghost" className="text-danger-ink hover:bg-danger-soft" onClick={onRemove}><Trash2 className="size-4" aria-hidden />{step.kind === "branch" ? "Remove with both paths" : "Remove step"}</Button>
        </div>
      )}
    </div>
  );
}

interface KindProps {
  step: WorkflowStep;
  definition: WorkflowDefinition;
  options: EditorOptions;
  errorAt: (path: string) => string | null;
  config: (patch: Record<string, unknown>) => void;
  replace: (cfg: WorkflowStep["config"]) => void;
  base: string;
  readOnly: boolean;
}

function KindFields(p: KindProps) {
  switch (p.step.kind) {
    case "wait":
      return <WaitFields {...p} />;
    case "branch":
      return <BranchFields {...p} />;
    case "add_tag":
    case "remove_tag":
      return <TagFields {...p} />;
    case "assign":
      return <AssignFields {...p} />;
    case "create_task":
      return <TaskFields {...p} />;
    case "update_field":
      return <UpdateFieldFields {...p} />;
    case "create_opportunity":
      return <CreateDealFields {...p} />;
    case "move_stage":
      return <MoveStageFields {...p} />;
    case "send_message":
      return <SendMessageFields {...p} />;
    case "request_review":
      return <RequestReviewFields {...p} />;
    case "notify_team":
      return <NotifyFields {...p} />;
    case "internal_note":
      return <NoteFields {...p} />;
    case "n8n":
      return <N8nFields {...p} />;
    case "webhook":
      return <WebhookFields {...p} />;
    case "http_request":
      return <HttpRequestFields {...p} />;
    case "slack_message":
      return <SlackMessageFields {...p} />;
    case "ai_task":
      return <AiTaskFields {...p} />;
    case "end":
      return <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-muted">The run finishes here. Nothing after this step runs on this path.</p>;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

function WaitFields({ step, definition, options, errorAt, replace }: KindProps) {
  const w = step.config as WaitConfig;
  const appointmentTrigger = TRIGGERS[definition.trigger.type]?.entity === "appointment";
  const dateFields = (entity: "contact" | "opportunity") => (entity === "contact" ? options.contactFields : options.opportunityFields).filter((f) => f.type === "date" || f.type === "datetime");
  return (
    <>
      <Field label="Wait" htmlFor="wf-wait-mode">
        <Choice<WaitConfig["mode"]>
          name="wf-wait-mode"
          label="How to wait"
          value={w.mode}
          onChange={(mode) => replace(mode === "duration" ? { mode, amount: 1, unit: "days" } : mode === "until_time" ? { mode, time: "09:00" } : { mode, source: appointmentTrigger ? "appointment_start" : "contact_field", offset: { amount: 1, unit: "days", direction: "before" }, ifMissing: "continue" })}
          options={[{ value: "duration", label: "For a while" }, { value: "until_time", label: "Until a time of day" }, { value: "until_date", label: "Until a date" }]}
        />
      </Field>
      {w.mode === "duration" && (
        <Field label="How long" htmlFor="wf-wait-amount" error={errorAt("config.amount") ?? errorAt("config.unit")}>
          <DurationInput id="wf-wait-amount" label="How long" amount={w.amount} unit={w.unit} onChange={(d) => replace({ mode: "duration", ...d })} />
        </Field>
      )}
      {w.mode === "until_time" && (
        <>
          <Field label="Time of day" htmlFor="wf-wait-time" error={errorAt("config.time")} hint="In your workspace's time zone. If it's already past that time, the run waits for the next one.">
            <Input id="wf-wait-time" type="time" className="w-36" value={w.time} onChange={(e) => replace({ ...w, time: e.target.value })} />
          </Field>
          <Field label="On these days" optional error={errorAt("config.weekdays")} hint="None chosen means any day.">
            <WeekdayPick label="On these days" value={w.weekdays ?? []} onChange={(days) => replace({ mode: "until_time", time: w.time, ...(days.length ? { weekdays: days } : {}) })} />
          </Field>
        </>
      )}
      {w.mode === "until_date" && (
        <>
          <Field label="Which date" htmlFor="wf-wait-source" error={errorAt("config.source")}>
            <Select id="wf-wait-source" value={w.source} onChange={(e) => replace({ ...w, source: e.target.value as typeof w.source, fieldId: undefined })}>
              <option value="appointment_start" disabled={!appointmentTrigger}>The appointment&apos;s start{appointmentTrigger ? "" : " (needs an appointment trigger)"}</option>
              <option value="contact_field">A date field on the contact</option>
              <option value="opportunity_field">A date field on the deal</option>
              <option value="opportunity_close_date">The deal&apos;s expected close date</option>
            </Select>
          </Field>
          {(w.source === "contact_field" || w.source === "opportunity_field") && (
            <Field label="Date field" htmlFor="wf-wait-field" error={errorAt("config.fieldId")}>
              <SinglePick
                id="wf-wait-field"
                value={w.fieldId}
                onChange={(v) => replace({ ...w, fieldId: v ?? undefined })}
                options={dateFields(w.source === "contact_field" ? "contact" : "opportunity").map((f) => ({ id: f.id, label: f.label }))}
                placeholder={dateFields(w.source === "contact_field" ? "contact" : "opportunity").length ? "Choose a date field" : "No date fields yet: add one in Custom Fields"}
              />
            </Field>
          )}
          <Field label="When" htmlFor="wf-wait-offset" error={errorAt("config.offset")}>
            <div className="flex flex-wrap items-center gap-2">
              <DurationInput id="wf-wait-offset" label="Offset" min={0} amount={w.offset.amount} unit={w.offset.unit} onChange={(d) => replace({ ...w, offset: { ...w.offset, ...d } })} />
              <Select aria-label="Before or after" value={w.offset.direction} onChange={(e) => replace({ ...w, offset: { ...w.offset, direction: e.target.value as "before" | "after" } })} className="w-auto min-w-28">
                <option value="before">before</option>
                <option value="after">after</option>
              </Select>
            </div>
          </Field>
          <Field label="If there's no date" htmlFor="wf-wait-missing" hint="A date that has already passed always carries on right away.">
            <Select id="wf-wait-missing" value={w.ifMissing} onChange={(e) => replace({ ...w, ifMissing: e.target.value as "continue" | "end" })}>
              <option value="continue">Carry on right away</option>
              <option value="end">End the run</option>
            </Select>
          </Field>
        </>
      )}
    </>
  );
}

function filterOptionsOf(o: EditorOptions): FilterOptions {
  return {
    tags: o.tags,
    members: o.members.map((m) => ({ id: m.id, name: m.name })),
    pipelines: o.pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, name: s.name })) })),
    customFields: o.contactFields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options })),
  };
}

/** Conditions are edited in a roomy dialog; the panel shows them in words. */
export function ConditionsEditor({ id, subject, value, onChange, options, readOnly, title, emptyText }: { id: string; subject: "contact" | "opportunity"; value: FilterGroup; onChange: (g: FilterGroup) => void; options: EditorOptions; readOnly: boolean; title: string; emptyText: string }) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<FilterGroup>(value);
  const names = React.useMemo(() => namesFrom(options), [options]);
  const fopts = React.useMemo(() => filterOptionsOf(options), [options]);
  const text = value.conditions.length ? conditionsText(value, subject, names) : emptyText;
  return (
    <div className="space-y-2">
      <p className="rounded-xl border border-line bg-surface-2/60 px-3 py-2.5 text-[13px] text-ink-2">{text}</p>
      <Button variant="secondary" size="sm" disabled={readOnly} onClick={() => { setDraft(value); setOpen(true); }}><ListFilter className="size-4" aria-hidden />{value.conditions.length ? "Edit conditions" : "Add conditions"}</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title={title}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => { onChange(draft); setOpen(false); }}>Use these conditions</Button></>}
      >
        {subject === "contact" ? (
          <FilterBuilder value={draft} onChange={setDraft} options={fopts} />
        ) : (
          <DealConditions
            id={`${id}-deal`}
            value={draft}
            onChange={setDraft}
            options={{ tags: options.tags.map((t) => ({ id: t.id, label: t.name, color: t.color })), members: options.members.map((m) => ({ id: m.id, label: m.name })), pipelines: options.pipelines }}
          />
        )}
      </Dialog>
    </div>
  );
}

function BranchFields({ step, options, errorAt, replace, readOnly }: KindProps) {
  const b = step.config as BranchConfig;
  return (
    <>
      <Field label="Check" htmlFor="wf-branch-subject" error={errorAt("config.subject")}>
        <Choice<"contact" | "opportunity">
          name="wf-branch-subject"
          label="Check the contact or the deal"
          value={b.subject}
          onChange={(subject) => replace({ subject, filter: EMPTY_FILTER, reply: subject === "contact" ? b.reply ?? null : null })}
          options={[{ value: "contact", label: "The contact" }, { value: "opportunity", label: "The deal" }]}
        />
      </Field>
      {b.subject === "contact" && (
        <Field label="Replies" htmlFor="wf-branch-reply" error={errorAt("config.reply")} hint="Put a Wait before this step to give them time to answer, for example two days.">
          <Select id="wf-branch-reply" value={b.reply ?? ""} onChange={(e) => replace({ ...b, reply: (e.target.value || null) as BranchConfig["reply"] })}>
            <option value="">Don&apos;t check replies</option>
            <option value="not_replied">They haven&apos;t replied since this run started</option>
            <option value="replied">They replied since this run started</option>
          </Select>
        </Field>
      )}
      <Field label={b.reply ? "And these conditions (optional)" : "Conditions"} error={errorAt("config.filter")}>
        <ConditionsEditor
          id="wf-branch-cond"
          subject={b.subject}
          value={b.filter}
          onChange={(filter) => replace({ ...b, filter })}
          options={options}
          readOnly={readOnly}
          title={b.subject === "contact" ? "Conditions on the contact" : "Conditions on the deal"}
          emptyText={b.reply ? "No other conditions." : "No conditions yet. Add at least one."}
        />
      </Field>
      <p className="text-[12.5px] leading-relaxed text-muted">Contacts who match continue down the <strong className="font-semibold text-success-ink">Yes</strong> path; everyone else takes the <strong className="font-semibold text-ink-2">No</strong> path. A path with no steps ends the run.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

function TagFields({ step, options, errorAt, config, base }: KindProps) {
  const t = step.config as TagsConfig;
  return (
    <Field label={step.kind === "add_tag" ? "Tags to add" : "Tags to remove"} error={errorAt("config.tagIds")}>
      <MultiPick
        id="wf-tags"
        label="Tags"
        max={20}
        options={options.tags.map((x) => ({ id: x.id, label: x.name, color: x.color }))}
        value={t.tagIds ?? []}
        onChange={(tagIds) => config({ tagIds })}
        empty={<>There are no tags yet. <Link href={`${base}/tags`} className="font-medium text-primary hover:underline">Create tags</Link> first.</>}
      />
    </Field>
  );
}

function AssignFields({ step, options, errorAt, config, replace, base }: KindProps) {
  const a = step.config as AssignConfig;
  const rules = (options.assignmentRules ?? []).filter((r) => r.entity === a.subject);
  return (
    <>
      <Field label="Assign" htmlFor="wf-assign-subject">
        <Choice<"contact" | "opportunity"> name="wf-assign-subject" label="Assign the contact or the deal" value={a.subject} onChange={(subject) => replace({ ...a, subject, ruleId: undefined })} options={[{ value: "contact", label: "The contact" }, { value: "opportunity", label: "The deal" }]} />
      </Field>
      <Field label="To" htmlFor="wf-assign-to">
        <Choice<"user" | "rule"> name="wf-assign-to" label="Assign to a person or through a rule" value={a.to} onChange={(to) => replace({ ...a, to, userId: undefined, ruleId: undefined })} options={[{ value: "user", label: "A person" }, { value: "rule", label: "An assignment rule" }]} />
      </Field>
      {a.to === "user" ? (
        <Field label="Person" htmlFor="wf-assign-user" error={errorAt("config.userId")}>
          <SinglePick id="wf-assign-user" value={a.userId} onChange={(v) => config({ userId: v ?? undefined })} options={options.members.map((m) => ({ id: m.id, label: m.name }))} placeholder="Choose a person" />
        </Field>
      ) : options.assignmentRules === null ? (
        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[12.5px] text-muted">Seeing assignment rules needs the “Assign contacts and deals to others” permission.</p>
      ) : (
        <Field label="Rule" htmlFor="wf-assign-rule" error={errorAt("config.ruleId")} hint="The rule picks the next person (round robin, weighted or by priority) at the moment the step runs.">
          <SinglePick id="wf-assign-rule" value={a.ruleId} onChange={(v) => config({ ruleId: v ?? undefined })} options={rules.map((r) => ({ id: r.id, label: r.name, hint: r.active ? undefined : "off" }))} placeholder={rules.length ? "Choose a rule" : `No ${a.subject === "contact" ? "contact" : "deal"} rules yet`} />
          {!rules.length && <Link href={`${base}/settings/assignment`} className="mt-1 inline-block text-[12.5px] font-medium text-primary hover:underline">Set up assignment rules</Link>}
        </Field>
      )}
      <Toggle id="wf-assign-only" label="Only if it has no owner yet" hint="Leaves records that already have an owner alone." checked={a.onlyIfUnassigned} onChange={(v) => config({ onlyIfUnassigned: v })} />
    </>
  );
}

const CONTACT_BUILT_IN = UPDATABLE_FIELDS.contact as Record<string, { label: string; type: "enum" | "number" | "text"; options?: readonly string[]; min?: number; max?: number }>;
const DEAL_BUILT_IN = UPDATABLE_FIELDS.opportunity as Record<string, { label: string; type: "enum" | "number" | "text"; options?: readonly string[]; min?: number; max?: number }>;
const ENUM_LABELS: Record<string, Record<string, string>> = { lead_status: LEAD_STATUS_LABELS, preferred_channel: PREFERRED_CHANNEL_LABELS };

function UpdateFieldFields({ step, options, errorAt, config, replace }: KindProps) {
  const u = step.config as UpdateFieldConfig;
  const builtIn = u.subject === "contact" ? CONTACT_BUILT_IN : DEAL_BUILT_IN;
  const custom = (u.subject === "contact" ? options.contactFields : options.opportunityFields);
  const def = u.field.startsWith("cf:") ? null : builtIn[u.field];
  const cf = u.field.startsWith("cf:") ? custom.find((f) => f.id === u.field.slice(3)) : null;
  const firstValue = (field: string, subject: "contact" | "opportunity") => {
    const b = (subject === "contact" ? CONTACT_BUILT_IN : DEAL_BUILT_IN)[field];
    if (b?.type === "enum") return b.options?.[0] ?? null;
    return null;
  };
  return (
    <>
      <Field label="Record" htmlFor="wf-uf-subject">
        <Choice<"contact" | "opportunity"> name="wf-uf-subject" label="The contact or the deal" value={u.subject} onChange={(subject) => { const field = Object.keys(subject === "contact" ? CONTACT_BUILT_IN : DEAL_BUILT_IN)[0]; replace({ subject, field, value: firstValue(field, subject) }); }} options={[{ value: "contact", label: "The contact" }, { value: "opportunity", label: "The deal" }]} />
      </Field>
      <Field label="Field" htmlFor="wf-uf-field" error={errorAt("config.field")}>
        <Select id="wf-uf-field" value={u.field} onChange={(e) => config({ field: e.target.value, value: e.target.value.startsWith("cf:") ? null : firstValue(e.target.value, u.subject) })}>
          <optgroup label="Standard fields">{Object.entries(builtIn).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</optgroup>
          {custom.length > 0 && <optgroup label="Custom fields">{custom.map((f) => <option key={f.id} value={`cf:${f.id}`}>{f.label}</option>)}</optgroup>}
          {!def && !cf && <option value={u.field}>A field that no longer exists</option>}
        </Select>
      </Field>
      <Field label="New value" htmlFor="wf-uf-value" error={errorAt("config.value")} hint="Leave empty to clear the field.">
        {def ? (
          def.type === "enum" ? (
            <Select id="wf-uf-value" value={typeof u.value === "string" ? u.value : ""} onChange={(e) => config({ value: e.target.value || null })}>
              {(def.options ?? []).map((o) => <option key={o} value={o}>{ENUM_LABELS[u.field]?.[o] ?? o}</option>)}
            </Select>
          ) : def.type === "number" ? (
            <Input id="wf-uf-value" type="number" min={def.min} max={def.max} className="w-40" value={typeof u.value === "number" ? String(u.value) : ""} onChange={(e) => config({ value: e.target.value === "" ? null : Number(e.target.value) })} />
          ) : (
            <Input id="wf-uf-value" value={typeof u.value === "string" ? u.value : ""} maxLength={def.max ?? 200} onChange={(e) => config({ value: e.target.value || null })} />
          )
        ) : cf ? (
          <CustomValue id="wf-uf-value" type={cf.type} options={cf.options} value={u.value} onChange={(value) => config({ value })} />
        ) : (
          <p className="text-[12.5px] text-muted">Choose a field first.</p>
        )}
      </Field>
    </>
  );
}

function CustomValue({ id, type, options, value, onChange }: { id: string; type: FieldType; options: Array<{ value: string; label: string }>; value: UpdateFieldConfig["value"]; onChange: (v: UpdateFieldConfig["value"]) => void }) {
  switch (type) {
    case "boolean":
      return (
        <Select id={id} value={value === true ? "true" : value === false ? "false" : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}>
          <option value="">Empty</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      );
    case "select":
      return (
        <Select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Empty</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      );
    case "multiselect":
      return <MultiPick id={id} label="Values" options={options.map((o) => ({ id: o.value, label: o.label }))} value={Array.isArray(value) ? value : []} onChange={(v) => onChange(v.length ? v : null)} empty="This field has no options." />;
    case "number":
    case "currency":
      return <Input id={id} type="number" className="w-44" value={typeof value === "number" ? String(value) : ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "date":
      return <Input id={id} type="date" className="w-44" value={typeof value === "string" ? value.slice(0, 10) : ""} onChange={(e) => onChange(e.target.value || null)} />;
    case "datetime":
      return <Input id={id} type="datetime-local" className="w-56" value={typeof value === "string" ? value.slice(0, 16) : ""} onChange={(e) => onChange(e.target.value || null)} />;
    case "textarea":
      return <Textarea id={id} rows={3} maxLength={2000} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />;
    default:
      return <Input id={id} type={type === "email" ? "email" : type === "url" ? "url" : type === "phone" ? "tel" : "text"} maxLength={2000} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />;
  }
}

// ---------------------------------------------------------------------------
// Tasks, notes, deals
// ---------------------------------------------------------------------------

function TaskFields({ step, options, errorAt, config, definition }: KindProps) {
  const t = step.config as CreateTaskConfig;
  const hasDeal = TRIGGERS[definition.trigger.type]?.carries.opportunity !== "never" || definition.steps.some((s) => s.kind === "create_opportunity");
  return (
    <>
      <Field label="Title" htmlFor="wf-task-title" error={errorAt("config.title")}>
        <Input id="wf-task-title" value={t.title ?? ""} maxLength={200} placeholder="Call {{contact.first_name}} about their quote" onChange={(e) => config({ title: e.target.value })} />
        <div className="mt-1.5"><TokenInsert id="wf-task-title-token" groups={["contact", "appointment"]} customValues={options.customValues} onInsert={(tok) => config({ title: `${t.title ?? ""}${t.title ? " " : ""}${tok}` })} /></div>
      </Field>
      <Field label="Details" htmlFor="wf-task-desc" optional error={errorAt("config.description")}>
        <Textarea id="wf-task-desc" rows={3} maxLength={2000} value={t.description ?? ""} onChange={(e) => config({ description: e.target.value || undefined })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Priority" htmlFor="wf-task-priority">
          <Select id="wf-task-priority" value={t.priority} onChange={(e) => config({ priority: e.target.value })}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </Field>
        <Field label="For" htmlFor="wf-task-assignee">
          <Select id="wf-task-assignee" value={t.assignee} onChange={(e) => config({ assignee: e.target.value, userId: undefined })}>
            <option value="contact_owner">The contact&apos;s owner</option>
            <option value="user">A person</option>
            <option value="none">Nobody in particular</option>
          </Select>
        </Field>
      </div>
      {t.assignee === "user" && (
        <Field label="Person" htmlFor="wf-task-user" error={errorAt("config.userId")}>
          <SinglePick id="wf-task-user" value={t.userId} onChange={(v) => config({ userId: v ?? undefined })} options={options.members.map((m) => ({ id: m.id, label: m.name }))} placeholder="Choose a person" />
        </Field>
      )}
      <Toggle id="wf-task-due-on" label="Give it a due date" checked={!!t.dueIn} onChange={(on) => config({ dueIn: on ? { amount: 1, unit: "days" } : undefined })} />
      {t.dueIn && (
        <Field label="Due" htmlFor="wf-task-due" error={errorAt("config.dueIn")} hint="Counted from when this step runs. 0 means due right away.">
          <DurationInput id="wf-task-due" label="Due in" min={0} amount={t.dueIn.amount} unit={t.dueIn.unit} onChange={(d) => config({ dueIn: d })} />
        </Field>
      )}
      {hasDeal && <Toggle id="wf-task-deal" label="Link it to the deal too" checked={!!t.linkOpportunity} onChange={(v) => config({ linkOpportunity: v || undefined })} />}
    </>
  );
}

function NoteFields({ step, options, errorAt, config }: KindProps) {
  const n = step.config as InternalNoteConfig;
  return (
    <>
      <Field label="On" htmlFor="wf-note-subject">
        <Choice<"contact" | "opportunity"> name="wf-note-subject" label="The contact or the deal" value={n.subject} onChange={(subject) => config({ subject })} options={[{ value: "contact", label: "The contact" }, { value: "opportunity", label: "The deal" }]} />
      </Field>
      <Field label="Note" htmlFor="wf-note-body" error={errorAt("config.body")} hint="Only your team sees notes.">
        <Textarea id="wf-note-body" rows={4} maxLength={4000} value={n.body ?? ""} onChange={(e) => config({ body: e.target.value })} />
        <div className="mt-1.5"><TokenInsert id="wf-note-token" groups={["contact", "appointment"]} customValues={options.customValues} onInsert={(tok) => config({ body: `${n.body ?? ""}${n.body ? " " : ""}${tok}` })} /></div>
      </Field>
    </>
  );
}

function stageOptions(options: EditorOptions, pipelineId: string | undefined, onlyOpen: boolean) {
  const pipe = options.pipelines.find((p) => p.id === pipelineId);
  return (pipe?.stages ?? []).filter((s) => !onlyOpen || s.kind === "open").map((s) => ({ id: s.id, label: s.name, hint: s.kind === "won" ? "Won" : s.kind === "lost" ? "Lost" : undefined }));
}

function CreateDealFields({ step, options, errorAt, config }: KindProps) {
  const o = step.config as CreateOpportunityConfig;
  return (
    <>
      <Field label="Deal name" htmlFor="wf-deal-name" error={errorAt("config.name")}>
        <Input id="wf-deal-name" value={o.name ?? ""} maxLength={200} onChange={(e) => config({ name: e.target.value })} />
        <div className="mt-1.5"><TokenInsert id="wf-deal-token" groups={["contact"]} customValues={options.customValues} onInsert={(tok) => config({ name: `${o.name ?? ""}${o.name ? " " : ""}${tok}` })} /></div>
      </Field>
      <PipelineStage options={options} pipelineId={o.pipelineId} stageId={o.stageId} onlyOpen errorAt={errorAt} onChange={(pipelineId, stageId) => config({ pipelineId, stageId })} />
      <Field label="Value" htmlFor="wf-deal-value" optional error={errorAt("config.value")}>
        <Input id="wf-deal-value" type="number" min={0} className="w-44" value={o.value ?? ""} onChange={(e) => config({ value: e.target.value === "" ? null : Number(e.target.value) })} />
      </Field>
      <Toggle id="wf-deal-owner" label="The contact's owner owns the deal" checked={o.ownerFromContact} onChange={(v) => config({ ownerFromContact: v })} />
      <Toggle id="wf-deal-skip" label="Skip if they already have an open deal in this pipeline" hint="That deal becomes the one later steps work on." checked={o.skipIfOpenInPipeline} onChange={(v) => config({ skipIfOpenInPipeline: v })} />
    </>
  );
}

function PipelineStage({ options, pipelineId, stageId, onlyOpen, errorAt, onChange }: { options: EditorOptions; pipelineId?: string; stageId?: string; onlyOpen: boolean; errorAt: (p: string) => string | null; onChange: (pipelineId: string | undefined, stageId: string | undefined) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Pipeline" htmlFor="wf-pipe" error={errorAt("config.pipelineId")}>
        <SinglePick id="wf-pipe" value={pipelineId} onChange={(v) => onChange(v ?? undefined, undefined)} options={options.pipelines.map((p) => ({ id: p.id, label: p.name }))} placeholder={options.pipelines.length ? "Choose a pipeline" : "No pipelines yet"} />
      </Field>
      <Field label="Stage" htmlFor="wf-stage" error={errorAt("config.stageId")}>
        <SinglePick id="wf-stage" value={stageId} disabled={!pipelineId} onChange={(v) => onChange(pipelineId, v ?? undefined)} options={stageOptions(options, pipelineId, onlyOpen)} placeholder={pipelineId ? "Choose a stage" : "Choose a pipeline first"} />
      </Field>
    </div>
  );
}

function MoveStageFields({ step, options, errorAt, config }: KindProps) {
  const m = step.config as MoveStageConfig;
  const lost = options.pipelines.find((p) => p.id === m.pipelineId)?.stages.find((s) => s.id === m.stageId)?.kind === "lost";
  return (
    <>
      <PipelineStage options={options} pipelineId={m.pipelineId} stageId={m.stageId} onlyOpen={false} errorAt={errorAt} onChange={(pipelineId, stageId) => config({ pipelineId, stageId, ...(stageId ? {} : { lostReason: undefined }) })} />
      {lost && (
        <Field label="Why it's lost" htmlFor="wf-lost" error={errorAt("config.lostReason")}>
          <Input id="wf-lost" value={m.lostReason ?? ""} maxLength={300} placeholder="e.g. No response after three follow-ups" onChange={(e) => config({ lostReason: e.target.value || undefined })} />
        </Field>
      )}
      <p className="text-[12.5px] leading-relaxed text-muted">Moves the run&apos;s deal. Without one, it moves the contact&apos;s open deal in this pipeline; with neither, the step is skipped.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Messages, team, integrations, AI
// ---------------------------------------------------------------------------

function SendMessageFields({ step, options, errorAt, config, replace, base }: KindProps) {
  const s = step.config as SendMessageConfig;
  const chosen = options.templates.find((t) => t.id === s.templateId) ?? null;
  const byChannel = (["sms", "whatsapp", "email"] as const).map((c) => ({ label: CHANNEL_LABELS[c], ids: options.templates.filter((t) => t.channel === c).map((t) => t.id) })).filter((g) => g.ids.length);
  const employees = options.employees.length ? options.employees : [];
  const sendAsEmployee = employees.find((e) => e.roleKey === s.sendAs);
  const sendAs = sendAsEmployee ? sendAsState(sendAsEmployee) : null;
  return (
    <>
      <Field label="Approved template" htmlFor="wf-msg-template" error={errorAt("config.templateId") ?? errorAt("config.contentHash") ?? errorAt("config.channel")}>
        <SinglePick
          id="wf-msg-template"
          value={s.templateId}
          onChange={(id) => {
            const t = options.templates.find((x) => x.id === id);
            if (!t) return replace({ ...s, templateId: "", contentHash: "", channel: s.channel } as SendMessageConfig);
            replace({ ...s, templateId: t.id, contentHash: t.contentHash, channel: t.channel as SendMessageConfig["channel"] });
          }}
          options={options.templates.map((t) => ({ id: t.id, label: t.name, hint: t.purpose === "marketing" ? "marketing" : undefined }))}
          groups={byChannel}
          placeholder={options.templates.length ? "Choose an approved template" : "No approved templates yet"}
        />
        {options.unapprovedTemplates.length > 0 && (
          <p className="mt-1 text-[12px] text-muted">{options.unapprovedTemplates.length} {options.unapprovedTemplates.length === 1 ? "template isn't" : "templates aren't"} approved yet, so {options.unapprovedTemplates.length === 1 ? "it can't" : "they can't"} be sent automatically. <Link href={`${base}/templates`} className="font-medium text-primary hover:underline">Review templates</Link></p>
        )}
        {!options.templates.length && !options.unapprovedTemplates.length && <Link href={`${base}/templates`} className="mt-1 inline-block text-[12.5px] font-medium text-primary hover:underline">Write a template</Link>}
      </Field>
      {chosen && (
        <div className="space-y-2 rounded-2xl border border-line bg-surface-2/50 p-3">
          <p className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-muted">
            <Badge tone="success"><ShieldCheck className="size-3" aria-hidden />Approved v{chosen.version}</Badge>
            {CHANNEL_LABELS[chosen.channel]} · {chosen.purpose === "marketing" ? "Marketing" : "Service"} message
          </p>
          {chosen.subject && <p className="text-[13px] font-medium text-ink">{chosen.subject}</p>}
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{chosen.body}</p>
          <p className="text-[12px] leading-relaxed text-muted">
            Sent only to contacts who agreed to {chosen.purpose === "marketing" ? "marketing" : "service"} messages by {CHANNEL_LABELS[chosen.channel]}, never to anyone who opted out, outside quiet hours, within sending limits and your credits.
            {chosen.purpose === "marketing" ? " Marketing messages need explicit marketing consent." : ""}
          </p>
        </div>
      )}
      <Field label="Send as" htmlFor="wf-msg-as" error={errorAt("config.sendAs")} hint="The AI employee the message goes out under. If it's paused, or set to ask first without this workflow's approval, nothing is sent.">
        <Select id="wf-msg-as" value={s.sendAs} aria-describedby={sendAs && sendAs.state !== "ok" ? "wf-msg-as-state" : undefined} onChange={(e) => config({ sendAs: e.target.value })}>
          {employees.map((e) => <option key={e.roleKey} value={e.roleKey}>{e.name}{!e.enabled ? " (off)" : e.mode === "paused" ? " (paused)" : !e.ready ? " (not ready)" : ""}</option>)}
          {!employees.some((e) => e.roleKey === s.sendAs) && <option value={s.sendAs}>{s.sendAs.replace(/_/g, " ")} (not in this workspace)</option>}
        </Select>
        {sendAs && sendAs.state !== "ok" && <StateNote id="wf-msg-as-state" state={sendAs} />}
      </Field>
      <Toggle id="wf-msg-hours" label="Only during business hours" hint="Quiet hours always apply; this also holds messages outside your business hours." checked={s.businessHoursOnly} onChange={(v) => config({ businessHoursOnly: v })} />
    </>
  );
}

function NotifyFields({ step, options, errorAt, config }: KindProps) {
  const n = step.config as NotifyTeamConfig;
  const roles = new Set(n.roles ?? []);
  const setRole = (r: "owner" | "admin", on: boolean) => {
    const next = new Set(roles);
    if (on) next.add(r);
    else next.delete(r);
    config({ roles: next.size ? (["owner", "admin"] as const).filter((x) => next.has(x)) : undefined });
  };
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium text-ink-2">Who gets it</legend>
        <Toggle id="wf-notify-owner" label="The business owner" checked={roles.has("owner")} onChange={(v) => setRole("owner", v)} />
        <Toggle id="wf-notify-admin" label="Managers" checked={roles.has("admin")} onChange={(v) => setRole("admin", v)} />
        <Toggle id="wf-notify-contact-owner" label="The contact's owner" checked={!!n.contactOwner} onChange={(v) => config({ contactOwner: v || undefined })} />
        {errorAt("config.roles") && <p className="text-[12.5px] text-danger-ink" role="alert">{errorAt("config.roles")}</p>}
      </fieldset>
      <Field label="Also these people" optional error={errorAt("config.userIds")}>
        <MultiPick id="wf-notify-users" label="People" max={20} options={options.members.map((m) => ({ id: m.id, label: m.name }))} value={n.userIds ?? []} onChange={(ids) => config({ userIds: ids.length ? ids : undefined })} empty="There's nobody else in the workspace." />
      </Field>
      <Field label="Title" htmlFor="wf-notify-title" error={errorAt("config.title")}>
        <Input id="wf-notify-title" value={n.title ?? ""} maxLength={160} placeholder="New lead from the website: {{contact.full_name}}" onChange={(e) => config({ title: e.target.value })} />
        <div className="mt-1.5"><TokenInsert id="wf-notify-token" groups={["contact", "appointment"]} customValues={options.customValues} onInsert={(tok) => config({ title: `${n.title ?? ""}${n.title ? " " : ""}${tok}` })} /></div>
      </Field>
      <Field label="Message" htmlFor="wf-notify-body" optional error={errorAt("config.body")}>
        <Textarea id="wf-notify-body" rows={3} maxLength={600} value={n.body ?? ""} onChange={(e) => config({ body: e.target.value || undefined })} />
      </Field>
      <p className="text-[12.5px] text-muted">An in-app notification for your team. Customers never see it.</p>
    </>
  );
}

function N8nFields({ step, options, errorAt, config }: KindProps) {
  const n = step.config as N8nConfig;
  const problem = options.n8nMappings.find((m) => m.id === n.mappingId)?.problem ?? null;
  return (
    <>
      <Field label="n8n automation" htmlFor="wf-n8n" error={errorAt("config.mappingId")}>
        <SinglePick
          id="wf-n8n"
          value={n.mappingId}
          describedBy={problem ? "wf-n8n-state" : undefined}
          onChange={(v) => config({ mappingId: v ?? "" })}
          options={options.n8nMappings.map((m) => ({ id: m.id, label: m.label, hint: m.problem ? "can't run yet" : undefined }))}
          placeholder={options.n8nMappings.length ? "Choose an automation" : "None verified for your workspace yet"}
        />
        {!options.n8nMappings.length && <p className="mt-1 text-[12px] text-muted">Your agency connects and verifies n8n automations for your workspace. Ask them if you need one.</p>}
        {problem && <StateNote id="wf-n8n-state" state={{ state: "blocked", text: problem }} />}
      </Field>
      <Toggle id="wf-n8n-contact" label="Include the contact's name, email and phone" checked={n.includeContact} onChange={(v) => config({ includeContact: v })} />
      <p className="text-[12.5px] leading-relaxed text-muted">Starts the automation once per run step. If iAcquire can&apos;t tell whether n8n received it, the step is marked for review instead of being sent again.</p>
    </>
  );
}

function WebhookFields({ step, options, errorAt, config, base }: KindProps) {
  const w = step.config as WebhookConfig;
  const active = options.webhooks.filter((x) => x.active);
  return (
    <>
      <Field label="Endpoint" htmlFor="wf-webhook" error={errorAt("config.subscriptionId")}>
        <SinglePick id="wf-webhook" value={w.subscriptionId} onChange={(v) => config({ subscriptionId: v ?? "" })} options={active.map((x) => ({ id: x.id, label: x.name, hint: x.host }))} placeholder={active.length ? "Choose an endpoint" : "No active endpoints"} />
        {!active.length && <Link href={`${base}/settings/api`} className="mt-1 inline-block text-[12.5px] font-medium text-primary hover:underline">Add a webhook endpoint</Link>}
      </Field>
      <Toggle id="wf-webhook-contact" label="Include the contact's name, email and phone" checked={w.includeContact} onChange={(v) => config({ includeContact: v })} />
      <p className="text-[12.5px] leading-relaxed text-muted">Sent signed with the endpoint&apos;s secret, and retried if the endpoint is down.</p>
    </>
  );
}

/** A short list of name / value pairs (query values, form fields, extra headers) with add and remove. */
function PairList({ id, label, pairs, onChange, namePlaceholder, valuePlaceholder, max, hint }: {
  id: string;
  label: string;
  pairs: Array<{ name: string; value: string }>;
  onChange: (next: Array<{ name: string; value: string }>) => void;
  namePlaceholder: string;
  valuePlaceholder: string;
  max: number;
  hint?: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] font-medium text-ink">{label}</legend>
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
      {pairs.map((p, i) => (
        <div key={i} className="flex items-start gap-2">
          <Input aria-label={`${label}: name ${i + 1}`} value={p.name} placeholder={namePlaceholder} maxLength={60} onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="w-2/5" />
          <Input aria-label={`${label}: value ${i + 1}`} value={p.value} placeholder={valuePlaceholder} maxLength={300} onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="flex-1" />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(pairs.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /></Button>
        </div>
      ))}
      {pairs.length < max && <Button type="button" variant="secondary" size="sm" id={id} onClick={() => onChange([...pairs, { name: "", value: "" }])}>Add</Button>}
    </fieldset>
  );
}

function HttpRequestFields({ step, options, errorAt, config, base }: KindProps) {
  const h = step.config as HttpRequestConfig;
  const connections = (options.connections ?? []).filter((c) => c.kind === "http");
  const conn = connections.find((c) => c.id === h.connectionId);
  const methods = conn?.methods.length ? conn.methods : ["GET", "POST", "PUT", "PATCH", "DELETE"];
  return (
    <>
      <Field label="Connection" htmlFor="wf-http-connection" error={errorAt("config.connectionId")}>
        <SinglePick
          id="wf-http-connection" value={h.connectionId} onChange={(v) => config({ connectionId: v ?? "" })}
          options={connections.map((c) => ({ id: c.id, label: c.name, hint: `${c.host} · ${c.status === "active" ? "verified" : c.status === "unverified" ? "not verified yet" : "needs attention"}` }))}
          placeholder={connections.length ? "Choose a connection" : "No HTTP connection yet"}
        />
        {!connections.length && <Link href="/automation-studio/connections" className="mt-1 inline-block text-[12.5px] font-medium text-primary hover:underline">Set up a connection</Link>}
        {conn && <p className="mt-1 text-[12px] text-muted">Calls only {conn.host}. The credentials are kept on the connection and never appear here.</p>}
      </Field>
      <div className="grid grid-cols-[110px_1fr] gap-3">
        <Field label="Method" htmlFor="wf-http-method" error={errorAt("config.method")}>
          <Select id="wf-http-method" value={h.method} onChange={(e) => config({ method: e.target.value, ...(e.target.value === "GET" ? { bodyType: "none", body: undefined, form: undefined } : {}) })}>
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Path" htmlFor="wf-http-path" error={errorAt("config.path")} hint="Starts with /. May hold placeholders, which are filled in safely.">
          <Input id="wf-http-path" value={h.path} maxLength={300} placeholder="/v1/orders" onChange={(e) => config({ path: e.target.value })} className="font-mono text-[12.5px]" />
        </Field>
      </div>
      <PairList id="wf-http-query-add" label="Query values" pairs={h.query ?? []} onChange={(query) => config({ query })} namePlaceholder="name" valuePlaceholder="value or {{placeholder}}" max={20} />
      {errorAt("config.query") && <p className="text-[12.5px] text-danger-ink" role="alert">{errorAt("config.query")}</p>}
      {h.method !== "GET" && (
        <>
          <Field label="Body" htmlFor="wf-http-bodytype" error={errorAt("config.bodyType")}>
            <Choice<"none" | "json" | "form" | "text"> name="wf-http-bodytype" label="Body type" value={h.bodyType} onChange={(bodyType) => config({ bodyType })} options={[{ value: "none", label: "None" }, { value: "json", label: "JSON" }, { value: "form", label: "Form" }, { value: "text", label: "Text" }]} />
          </Field>
          {(h.bodyType === "json" || h.bodyType === "text") && (
            <Field label={h.bodyType === "json" ? "JSON body" : "Text body"} htmlFor="wf-http-body" error={errorAt("config.body")} hint={h.bodyType === "json" ? "Put placeholders inside quotes. Their values are escaped for you." : undefined}>
              <Textarea id="wf-http-body" rows={6} maxLength={4000} value={h.body ?? ""} onChange={(e) => config({ body: e.target.value })} className="font-mono text-[12.5px]" placeholder={h.bodyType === "json" ? '{"name": "{{contact.full_name}}", "email": "{{contact.email}}"}' : ""} />
              <div className="mt-1.5"><TokenInsert id="wf-http-token" groups={["contact", "appointment"]} customValues={options.customValues} onInsert={(tok) => config({ body: `${h.body ?? ""}${tok}` })} /></div>
            </Field>
          )}
          {h.bodyType === "form" && <PairList id="wf-http-form-add" label="Form fields" pairs={h.form ?? []} onChange={(form) => config({ form })} namePlaceholder="field" valuePlaceholder="value or {{placeholder}}" max={20} />}
          {errorAt("config.form") && <p className="text-[12.5px] text-danger-ink" role="alert">{errorAt("config.form")}</p>}
        </>
      )}
      <PairList id="wf-http-header-add" label="Extra headers" pairs={h.headers ?? []} onChange={(headers) => config({ headers })} namePlaceholder="X-Source" valuePlaceholder="value" max={8} hint="Only Accept, If-None-Match and headers starting with X-. Credentials go on the connection." />
      {errorAt("config.headers") && <p className="text-[12.5px] text-danger-ink" role="alert">{errorAt("config.headers")}</p>}
      <div className="grid grid-cols-[120px_1fr] items-end gap-3">
        <Field label="Time limit (s)" htmlFor="wf-http-timeout">
          <Input id="wf-http-timeout" type="number" min={1} max={30} value={h.timeoutSeconds ?? 15} onChange={(e) => config({ timeoutSeconds: Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 15))) })} />
        </Field>
        <Toggle id="wf-http-repeat" label="The other system ignores a repeat of the same request" checked={h.safeToRepeat === true} onChange={(v) => config({ safeToRepeat: v })} />
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted">Each attempt carries an Idempotency-Key. If the request may have reached the other system and we can&apos;t tell, it is marked for review instead of being sent again, unless you say repeats are safe. Redirects aren&apos;t followed and private networks are never called. {base ? "" : ""}</p>
    </>
  );
}

function SlackMessageFields({ step, options, errorAt, config }: KindProps) {
  const m = step.config as SlackMessageConfig;
  const connections = (options.connections ?? []).filter((c) => c.kind === "slack_webhook");
  return (
    <>
      <Field label="Slack connection" htmlFor="wf-slack-connection" error={errorAt("config.connectionId")}>
        <SinglePick
          id="wf-slack-connection" value={m.connectionId} onChange={(v) => config({ connectionId: v ?? "" })}
          options={connections.map((c) => ({ id: c.id, label: c.name, hint: c.status === "active" ? "verified" : c.status === "unverified" ? "not verified yet" : "needs attention" }))}
          placeholder={connections.length ? "Choose a connection" : "No Slack connection yet"}
        />
        {!connections.length && <Link href="/automation-studio/connections" className="mt-1 inline-block text-[12.5px] font-medium text-primary hover:underline">Set up a Slack connection</Link>}
      </Field>
      <Field label="Message" htmlFor="wf-slack-text" error={errorAt("config.text")} hint="Mentions and links in the text are made harmless, so a customer's name can't ping a channel.">
        <Textarea id="wf-slack-text" rows={4} maxLength={1500} value={m.text ?? ""} onChange={(e) => config({ text: e.target.value })} placeholder="New lead: {{contact.full_name}} ({{contact.email}})" />
        <div className="mt-1.5"><TokenInsert id="wf-slack-token" groups={["contact", "appointment"]} customValues={options.customValues} onInsert={(tok) => config({ text: `${m.text ?? ""}${m.text ? " " : ""}${tok}` })} /></div>
      </Field>
    </>
  );
}

function AiTaskFields({ step, options, errorAt, config }: KindProps) {
  const a = step.config as AiTaskConfig;
  const chosen = options.employees.find((e) => e.roleKey === a.roleKey);
  const state = chosen ? aiTaskState(chosen) : null;
  return (
    <>
      <Field label="AI employee" htmlFor="wf-ai-role" error={errorAt("config.roleKey")}>
        <Select id="wf-ai-role" value={a.roleKey} aria-describedby={state ? "wf-ai-role-state" : undefined} onChange={(e) => config({ roleKey: e.target.value })}>
          {options.employees.map((e) => <option key={e.roleKey} value={e.roleKey}>{e.name}</option>)}
          {!chosen && <option value={a.roleKey}>{a.roleKey.replace(/_/g, " ")} (not in this workspace)</option>}
        </Select>
        {state && <StateNote id="wf-ai-role-state" state={state} />}
      </Field>
      <Field label="What to do" htmlFor="wf-ai-instruction" error={errorAt("config.instruction")}>
        <Textarea id="wf-ai-instruction" rows={4} maxLength={2000} placeholder="Review this lead's details and add a short note on how qualified they look." value={a.instruction ?? ""} onChange={(e) => config({ instruction: e.target.value })} />
      </Field>
      <p className="text-[12.5px] leading-relaxed text-muted">It works only on this workspace&apos;s CRM, through tools scoped to this run.</p>
    </>
  );
}

/** Under a choice: what it does right now, in warning colours when the step can't act (the same words the run records). */
function StateNote({ id, state }: { id: string; state: ReadyState }) {
  if (state.state === "ok") return <p id={id} className="mt-1 text-[12px] text-muted">{state.text}</p>;
  return (
    <p id={id} className="mt-1.5 flex gap-1.5 rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{state.text}
    </p>
  );
}
