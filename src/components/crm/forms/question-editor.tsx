"use client";

import * as React from "react";
import {
  AlignLeft, ArrowDown, ArrowUp, AtSign, Calendar, CheckSquare, ChevronDown, CircleDot, Copy, EyeOff, GitBranch, Hash, ListChecks, Phone, Plus, Save, Trash2, Type, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Segmented, Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import {
  CONDITION_OP_LABELS, CONTACT_TARGET_KEYS, CONTACT_TARGETS, CUSTOM_FIELD_ACCEPTS, FORM_LIMITS, newQuestion, opsFor, QUESTION_TYPE_HINTS, QUESTION_TYPE_LABELS, QUESTION_TYPES,
  slugValue, type ChoiceOption, type Condition, type ConditionOp, type FormIssue, type FormQuestion, type HiddenSource, type QuestionType, type QuestionValidation,
} from "@/lib/crm/forms/spec";
import { ATTRIBUTION_PARAMS } from "@/lib/crm/forms/logic";
import { describeVisibility } from "@/lib/crm/forms/visibility";
import type { FormBuilderOptions } from "@/components/crm/forms/types";

export const TYPE_ICON: Record<QuestionType, React.ComponentType<{ className?: string }>> = {
  short_text: Type, long_text: AlignLeft, email: AtSign, phone: Phone, number: Hash, date: Calendar, single_choice: CircleDot, multiple_choice: ListChecks, checkbox: CheckSquare, hidden: EyeOff,
};

/** Where an answer can be saved, for a question of this type: the contact's own fields and custom fields of a fitting type. */
export function mapTargets(type: QuestionType, fields: FormBuilderOptions["contactFields"]): Array<{ value: string; label: string; group: string }> {
  const out: Array<{ value: string; label: string; group: string }> = [];
  for (const key of CONTACT_TARGET_KEYS) if ((CONTACT_TARGETS[key].accepts as readonly string[]).includes(type)) out.push({ value: key, label: CONTACT_TARGETS[key].label, group: "Contact" });
  for (const f of fields) if (CUSTOM_FIELD_ACCEPTS[f.type].includes(type)) out.push({ value: `custom:${f.key}`, label: f.label, group: "Custom fields" });
  return out;
}

export function targetLabel(map: string | null | undefined, fields: FormBuilderOptions["contactFields"]): string | null {
  if (!map) return null;
  if (map in CONTACT_TARGETS) return `Contact: ${CONTACT_TARGETS[map as keyof typeof CONTACT_TARGETS].label}`;
  if (map.startsWith("custom:")) return fields.find((f) => f.key === map.slice(7))?.label ?? "A custom field that no longer exists";
  return null;
}

// ---------------------------------------------------------------------------
// The list of questions
// ---------------------------------------------------------------------------

export function AddQuestionMenu({ onAdd, disabled, label = "Add question" }: { onAdd: (type: QuestionType) => void; disabled?: boolean; label?: string }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="secondary" size="sm" disabled={disabled}><Plus className="size-4" aria-hidden />{label}<ChevronDown className="size-3.5" aria-hidden /></Button>
      </MenuTrigger>
      <MenuContent align="start" className="w-72">
        <MenuLabel>Question type</MenuLabel>
        {QUESTION_TYPES.map((t) => {
          const Icon = TYPE_ICON[t];
          return (
            <MenuItem key={t} onSelect={() => onAdd(t)} className="items-start">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink">{QUESTION_TYPE_LABELS[t]}</span>
                <span className="block text-[11.5px] leading-snug text-muted">{QUESTION_TYPE_HINTS[t]}</span>
              </span>
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

export function QuestionList({
  questions, selected, onSelect, onMove, issues, readOnly, fields,
}: {
  questions: FormQuestion[];
  selected: string | null;
  onSelect: (key: string) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  issues: readonly FormIssue[];
  readOnly: boolean;
  fields: FormBuilderOptions["contactFields"];
}) {
  return (
    <ol className="space-y-1.5" aria-label="Questions">
      {questions.map((q, i) => {
        const Icon = TYPE_ICON[q.type];
        const bad = issues.some((x) => x.question === q.key && x.level === "error");
        const active = selected === q.key;
        return (
          <li key={q.key} className={cn("group flex items-center gap-1 rounded-xl border bg-surface pr-1 transition-colors", active ? "border-primary/40 bg-primary-soft/40" : "border-line hover:border-line-strong")}>
            <button type="button" onClick={() => onSelect(q.key)} aria-current={active ? "true" : undefined} className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted"><Icon className="size-3.5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{q.label || <span className="text-faint">Untitled question</span>}{q.required && <span className="text-danger" aria-label="required"> *</span>}</span>
                <span className="flex items-center gap-1.5 truncate text-[11.5px] text-muted">
                  {QUESTION_TYPE_LABELS[q.type]}
                  {q.visibleWhen?.conditions.length ? <GitBranch className="size-3" aria-label="Shown only when a condition holds" /> : null}
                  {q.map ? <span className="truncate">· {targetLabel(q.map, fields)}</span> : null}
                </span>
              </span>
              {bad && <span className="size-2 shrink-0 rounded-full bg-danger" aria-label="Has a problem" />}
            </button>
            {!readOnly && (
              <span className="flex shrink-0 flex-col">
                <button type="button" onClick={() => onMove(i, -1)} disabled={i === 0} aria-label={`Move “${q.label || "question"}” up`} className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
                <button type="button" onClick={() => onMove(i, 1)} disabled={i === questions.length - 1} aria-label={`Move “${q.label || "question"}” down`} className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="size-3.5" /></button>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

const num = (v: string): number | undefined => (v.trim() === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

export function QuestionPanel({
  question: q, index, questions, onChange, onRemove, onDuplicate, onKeyChange, options, readOnly, issues,
}: {
  question: FormQuestion;
  index: number;
  questions: FormQuestion[];
  onChange: (next: FormQuestion) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  /** The answer key changed: conditions and the deal's value question that point at it follow. */
  onKeyChange: (from: string, to: string) => void;
  options: FormBuilderOptions;
  readOnly: boolean;
  issues: readonly FormIssue[];
}) {
  const id = (k: string) => `fq-${q.key}-${k}`;
  const set = <K extends keyof FormQuestion>(k: K, v: FormQuestion[K]) => onChange({ ...q, [k]: v });
  const setValidation = (patch: Partial<QuestionValidation>) => {
    const v = { ...(q.validation ?? {}), ...patch };
    for (const k of Object.keys(v) as Array<keyof QuestionValidation>) if (v[k] === undefined || v[k] === false) delete v[k];
    onChange({ ...q, validation: Object.keys(v).length ? v : undefined });
  };
  const own = issues.filter((x) => x.question === q.key);
  const earlier = questions.slice(0, index);
  const targets = mapTargets(q.type, options.contactFields);
  // The panel is keyed by the question's key, so a renamed key starts a fresh panel with it.
  const [keyDraft, setKeyDraft] = React.useState(q.key);

  const changeType = (type: QuestionType) => {
    if (type === q.type) return;
    const fresh = newQuestion(type, questions.filter((x) => x.key !== q.key).map((x) => x.key));
    const keepMap = q.map && mapTargets(type, options.contactFields).some((t) => t.value === q.map) ? q.map : null;
    onChange({
      key: q.key, type, label: q.label || fresh.label, help: q.help, required: type === "hidden" ? false : q.required, width: type === "hidden" ? undefined : q.width ?? "full",
      options: type === "single_choice" || type === "multiple_choice" ? (q.options?.length ? q.options : fresh.options) : undefined,
      display: type === "single_choice" ? q.display ?? "radio" : undefined,
      source: type === "hidden" ? fresh.source : undefined,
      visibleWhen: type === "hidden" ? null : q.visibleWhen ?? null,
      placeholder: ["short_text", "long_text", "email", "phone", "number"].includes(type) ? q.placeholder : undefined,
      map: keepMap,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14.5px] font-semibold tracking-tight text-ink">Question {index + 1}</h3>
        {!readOnly && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onDuplicate}><Copy className="size-3.5" aria-hidden />Duplicate</Button>
            <Button variant="ghost" size="sm" onClick={onRemove} className="text-danger-ink hover:bg-danger-soft"><Trash2 className="size-3.5" aria-hidden />Remove</Button>
          </div>
        )}
      </div>
      {own.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-danger/20 bg-danger-soft/50 px-3 py-2" aria-label="Problems with this question">
          {own.map((x, i) => <li key={i} className={cn("text-[12.5px] leading-relaxed", x.level === "error" ? "text-danger-ink" : "text-warning-ink")}>{x.message}</li>)}
        </ul>
      )}

      <fieldset disabled={readOnly} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" htmlFor={id("type")} hint={QUESTION_TYPE_HINTS[q.type]}>
            <Select id={id("type")} value={q.type} onChange={(e) => changeType(e.target.value as QuestionType)}>
              {QUESTION_TYPES.map((t) => <option key={t} value={t}>{QUESTION_TYPE_LABELS[t]}</option>)}
            </Select>
          </Field>
          <Field label="Answer key" htmlFor={id("key")} hint="How reports, workflows and exports name this answer. Keep it the same after publishing.">
            <Input
              id={id("key")} value={keyDraft} maxLength={40} className="font-mono text-[13px]"
              onChange={(e) => setKeyDraft(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              onBlur={() => {
                const next = keyDraft.trim();
                if (next && next !== q.key) onKeyChange(q.key, next);
                else setKeyDraft(q.key);
              }}
            />
          </Field>
        </div>
        <Field label={q.type === "checkbox" ? "Text next to the box" : q.type === "hidden" ? "Name (only your team sees it)" : "Question"} htmlFor={id("label")}>
          <Input id={id("label")} value={q.label} maxLength={200} onChange={(e) => set("label", e.target.value)} />
        </Field>
        {q.type !== "hidden" && (
          <Field label="Help text" htmlFor={id("help")} optional hint="A short line under the question.">
            <Input id={id("help")} value={q.help ?? ""} maxLength={300} onChange={(e) => set("help", e.target.value || undefined)} />
          </Field>
        )}
        {["short_text", "long_text", "email", "phone", "number"].includes(q.type) && (
          <Field label="Placeholder" htmlFor={id("ph")} optional hint="Example text inside the empty box. Never a replacement for the question.">
            <Input id={id("ph")} value={q.placeholder ?? ""} maxLength={120} onChange={(e) => set("placeholder", e.target.value || undefined)} />
          </Field>
        )}

        {q.type !== "hidden" && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="inline-flex min-h-11 items-center gap-2.5 text-[13px] text-ink-2 sm:min-h-9">
              <Switch checked={q.required} onCheckedChange={(v) => set("required", v)} aria-label="Required" />
              {q.type === "checkbox" ? "Must be ticked" : "Required"}
            </label>
            <div className="flex items-center gap-2 text-[13px] text-ink-2">
              <span id={id("width-l")}>Width</span>
              <Segmented id={id("width")} ariaLabel="Width on wide screens" size="sm" value={q.width ?? "full"} onChange={(v) => set("width", v)} options={[{ value: "full", label: "Full" }, { value: "half", label: "Half" }]} />
            </div>
            {q.type === "single_choice" && (
              <div className="flex items-center gap-2 text-[13px] text-ink-2">
                <span>Show as</span>
                <Segmented id={id("display")} ariaLabel="Show choices as" size="sm" value={q.display ?? "radio"} onChange={(v) => set("display", v)} options={[{ value: "radio", label: "Buttons" }, { value: "dropdown", label: "Dropdown" }]} />
              </div>
            )}
          </div>
        )}

        {(q.type === "single_choice" || q.type === "multiple_choice") && <ChoicesEditor q={q} onChange={(opts) => set("options", opts)} readOnly={readOnly} />}

        <ValidationEditor q={q} id={id} setValidation={setValidation} />

        {q.type === "hidden" && <HiddenSourceEditor q={q} id={id} onChange={(src) => set("source", src)} />}

        {q.type !== "hidden" && <ConditionEditor q={q} earlier={earlier} id={id} onChange={(v) => set("visibleWhen", v)} />}

        <Field label="Save the answer to" htmlFor={id("map")} hint={q.map?.startsWith("custom:") ? "Checked with the field's own rules when a submission is processed." : "Answers are always kept with the submission. Saving one to the contact also fills in their record."}>
          <Select id={id("map")} value={q.map ?? ""} onChange={(e) => set("map", e.target.value || null)}>
            <option value="">Only keep it with the submission</option>
            {(["Contact", "Custom fields"] as const).map((g) => {
              const list = targets.filter((t) => t.group === g);
              return list.length ? (
                <optgroup key={g} label={g === "Contact" ? "Contact" : "Contact custom fields"}>
                  {list.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </optgroup>
              ) : null;
            })}
            {q.map && !targets.some((t) => t.value === q.map) && <option value={q.map}>{targetLabel(q.map, options.contactFields) ?? q.map} (doesn&apos;t fit this question)</option>}
          </Select>
        </Field>
      </fieldset>
    </div>
  );
}

function ChoicesEditor({ q, onChange, readOnly }: { q: FormQuestion; onChange: (o: ChoiceOption[]) => void; readOnly: boolean }) {
  const opts = q.options ?? [];
  const update = (i: number, label: string) => {
    const cur = opts[i];
    // The stored value follows the label until someone changes it, so a new choice gets a value that reads well in reports.
    const follows = cur.value === slugValue(cur.label) || /^option_\d+$/.test(cur.value);
    const taken = new Set(opts.filter((_, k) => k !== i).map((o) => o.value));
    let value = follows ? slugValue(label) : cur.value;
    if (follows) for (let n = 2; taken.has(value); n++) value = `${slugValue(label)}_${n}`;
    onChange(opts.map((o, k) => (k === i ? { value, label } : o)));
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= opts.length) return;
    const next = [...opts];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () => {
    const taken = new Set(opts.map((o) => o.value));
    let n = opts.length + 1;
    while (taken.has(`option_${n}`)) n++;
    onChange([...opts, { value: `option_${n}`, label: `Option ${n}` }]);
  };
  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium text-ink-2">Choices</p>
      <ul className="space-y-1.5">
        {opts.map((o, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <Input aria-label={`Choice ${i + 1}`} value={o.label} maxLength={120} onChange={(e) => update(i, e.target.value)} className="flex-1" />
            <span className="hidden max-w-[9rem] truncate font-mono text-[11px] text-faint sm:inline" title={`Stored as ${o.value}`}>{o.value}</span>
            {!readOnly && (
              <>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move choice ${i + 1} up`} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === opts.length - 1} aria-label={`Move choice ${i + 1} down`} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="size-3.5" /></button>
                <button type="button" onClick={() => onChange(opts.filter((_, k) => k !== i))} aria-label={`Remove choice ${i + 1}`} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2"><X className="size-3.5" /></button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && opts.length < FORM_LIMITS.options && <Button variant="ghost" size="sm" onClick={add}><Plus className="size-3.5" aria-hidden />Add choice</Button>}
    </div>
  );
}

function ValidationEditor({ q, id, setValidation }: { q: FormQuestion; id: (k: string) => string; setValidation: (p: Partial<QuestionValidation>) => void }) {
  const v = q.validation ?? {};
  if (q.type === "short_text" || q.type === "long_text") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shortest answer" htmlFor={id("minl")} optional hint="Characters.">
          <Input id={id("minl")} type="number" inputMode="numeric" min={0} value={v.minLength ?? ""} onChange={(e) => setValidation({ minLength: num(e.target.value) })} />
        </Field>
        <Field label="Longest answer" htmlFor={id("maxl")} optional hint={`Up to ${(q.type === "short_text" ? FORM_LIMITS.shortText : FORM_LIMITS.longText).toLocaleString("en-US")} characters.`}>
          <Input id={id("maxl")} type="number" inputMode="numeric" min={1} value={v.maxLength ?? ""} onChange={(e) => setValidation({ maxLength: num(e.target.value) })} />
        </Field>
      </div>
    );
  }
  if (q.type === "number") {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Lowest" htmlFor={id("min")} optional><Input id={id("min")} type="number" inputMode="decimal" value={v.min ?? ""} onChange={(e) => setValidation({ min: num(e.target.value) })} /></Field>
        <Field label="Highest" htmlFor={id("max")} optional><Input id={id("max")} type="number" inputMode="decimal" value={v.max ?? ""} onChange={(e) => setValidation({ max: num(e.target.value) })} /></Field>
        <label className="inline-flex min-h-11 items-center gap-2.5 self-end text-[13px] text-ink-2"><Switch checked={Boolean(v.integer)} onCheckedChange={(x) => setValidation({ integer: x || undefined })} aria-label="Whole numbers only" />Whole numbers only</label>
      </div>
    );
  }
  if (q.type === "date") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Earliest date" htmlFor={id("mind")} optional><Input id={id("mind")} type="date" value={v.minDate ?? ""} onChange={(e) => setValidation({ minDate: e.target.value || undefined })} /></Field>
        <Field label="Latest date" htmlFor={id("maxd")} optional><Input id={id("maxd")} type="date" value={v.maxDate ?? ""} onChange={(e) => setValidation({ maxDate: e.target.value || undefined })} /></Field>
      </div>
    );
  }
  if (q.type === "multiple_choice") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Choose at least" htmlFor={id("minc")} optional><Input id={id("minc")} type="number" inputMode="numeric" min={0} value={v.minChoices ?? ""} onChange={(e) => setValidation({ minChoices: num(e.target.value) })} /></Field>
        <Field label="Choose at most" htmlFor={id("maxc")} optional><Input id={id("maxc")} type="number" inputMode="numeric" min={1} value={v.maxChoices ?? ""} onChange={(e) => setValidation({ maxChoices: num(e.target.value) })} /></Field>
      </div>
    );
  }
  return null;
}

function HiddenSourceEditor({ q, id, onChange }: { q: FormQuestion; id: (k: string) => string; onChange: (s: HiddenSource) => void }) {
  const src = q.source ?? { kind: "param", param: "utm_source" };
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface-2/50 p-3.5">
      <p className="text-[12.5px] leading-relaxed text-muted">A hidden field isn&apos;t shown. It records a value only when the visit actually had one; it is never guessed.</p>
      <Field label="Value comes from" htmlFor={id("src")}>
        <Select id={id("src")} value={src.kind} onChange={(e) => onChange(e.target.value === "param" ? { kind: "param", param: src.kind === "param" ? src.param : "utm_source" } : (e.target.value === "referrer" ? { kind: "referrer" } : { kind: "landing_page" }))}>
          <option value="param">A parameter in the link (such as utm_source)</option>
          <option value="referrer">The page that sent the visitor</option>
          <option value="landing_page">The page the form was on</option>
        </Select>
      </Field>
      {src.kind === "param" && (
        <Field label="Parameter name" htmlFor={id("param")} hint={`Common ones: ${ATTRIBUTION_PARAMS.slice(0, 5).join(", ")}.`}>
          <Input id={id("param")} value={src.param} maxLength={40} list={id("params")} className="font-mono text-[13px]" onChange={(e) => onChange({ kind: "param", param: e.target.value.trim() })} />
          <datalist id={id("params")}>{ATTRIBUTION_PARAMS.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
      )}
    </div>
  );
}

function ConditionEditor({ q, earlier, id, onChange }: { q: FormQuestion; earlier: FormQuestion[]; id: (k: string) => string; onChange: (v: FormQuestion["visibleWhen"]) => void }) {
  const rule = q.visibleWhen;
  const on = Boolean(rule?.conditions.length);
  const conditions = rule?.conditions ?? [];
  const setConditions = (next: Condition[]) => onChange(next.length ? { match: rule?.match ?? "all", conditions: next } : null);
  const blank = (): Condition | null => {
    const subject = earlier[earlier.length - 1];
    if (!subject) return null;
    const op = opsFor(subject.type)[0];
    return { question: subject.key, op, ...(op === "equals" || op === "not_equals" || op === "contains" ? { value: subject.options?.[0]?.value ?? (subject.type === "checkbox" ? "true" : "") } : {}) };
  };
  const byKey = new Map(earlier.map((x) => [x.key, x]));
  const summary = describeVisibility(rule, (k) => byKey.get(k));
  return (
    <div className="space-y-3 rounded-xl border border-line p-3.5">
      <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
        <Switch
          checked={on}
          disabled={!earlier.length}
          onCheckedChange={(v) => {
            if (!v) onChange(null);
            else {
              const c = blank();
              if (c) onChange({ match: "all", conditions: [c] });
            }
          }}
          aria-label="Show only when"
        />
        <span>
          <span className="block font-medium text-ink">Show only when…</span>
          <span className="block text-[12px] text-muted">{earlier.length ? (on && summary ? `Shown when ${summary}.` : "Always shown.") : "A question can depend only on questions above it."}</span>
        </span>
      </label>
      {on && (
        <div className="space-y-2">
          {conditions.length > 1 && (
            <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <span>Show when</span>
              <Segmented id={id("match")} ariaLabel="Match" size="sm" value={rule?.match ?? "all"} onChange={(m) => onChange({ match: m, conditions })} options={[{ value: "all", label: "all hold" }, { value: "any", label: "any holds" }]} />
            </div>
          )}
          {conditions.map((c, i) => {
            const subject = byKey.get(c.question);
            const ops = subject ? opsFor(subject.type) : (["is_set"] as ConditionOp[]);
            const needsValue = c.op === "equals" || c.op === "not_equals" || c.op === "contains";
            const patch = (p: Partial<Condition>) => setConditions(conditions.map((x, k) => (k === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="grid gap-2 rounded-lg bg-surface-2/60 p-2 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-center">
                <Select aria-label={`Condition ${i + 1}: question`} value={c.question} onChange={(e) => {
                  const s = byKey.get(e.target.value);
                  const op = s ? opsFor(s.type)[0] : "is_set";
                  patch({ question: e.target.value, op, value: op === "is_set" || op === "is_not_set" ? undefined : s?.options?.[0]?.value ?? (s?.type === "checkbox" ? "true" : "") });
                }}>
                  {!subject && <option value={c.question}>A question that no longer exists</option>}
                  {earlier.map((x) => <option key={x.key} value={x.key}>{x.label || x.key}</option>)}
                </Select>
                <Select aria-label={`Condition ${i + 1}: comparison`} value={c.op} onChange={(e) => {
                  const op = e.target.value as ConditionOp;
                  patch({ op, value: op === "is_set" || op === "is_not_set" ? undefined : c.value ?? subject?.options?.[0]?.value ?? "" });
                }}>
                  {ops.map((o) => <option key={o} value={o}>{CONDITION_OP_LABELS[o]}</option>)}
                </Select>
                {needsValue ? (
                  subject && (subject.type === "single_choice" || subject.type === "multiple_choice") ? (
                    <Select aria-label={`Condition ${i + 1}: answer`} value={c.value ?? ""} onChange={(e) => patch({ value: e.target.value })}>
                      {(subject.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                  ) : subject?.type === "checkbox" ? (
                    <Select aria-label={`Condition ${i + 1}: answer`} value={c.value ?? "true"} onChange={(e) => patch({ value: e.target.value })}>
                      <option value="true">ticked</option>
                      <option value="false">not ticked</option>
                    </Select>
                  ) : (
                    <Input aria-label={`Condition ${i + 1}: answer`} type={subject?.type === "number" ? "number" : subject?.type === "date" ? "date" : "text"} value={c.value ?? ""} maxLength={200} onChange={(e) => patch({ value: e.target.value })} />
                  )
                ) : <span className="hidden sm:block" />}
                <button type="button" onClick={() => setConditions(conditions.filter((_, k) => k !== i))} aria-label={`Remove condition ${i + 1}`} className="inline-flex size-9 items-center justify-center justify-self-end rounded-lg text-muted hover:bg-surface"><X className="size-3.5" /></button>
              </div>
            );
          })}
          {conditions.length < FORM_LIMITS.conditions && (
            <Button variant="ghost" size="sm" onClick={() => { const c = blank(); if (c) setConditions([...conditions, c]); }}><Plus className="size-3.5" aria-hidden />Add condition</Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A small "unsaved changes" pill for the header. */
export function DirtyPill({ dirty, saving }: { dirty: boolean; saving: boolean }) {
  if (saving) return <Badge tone="neutral"><Save className="size-3" aria-hidden />Saving…</Badge>;
  return dirty ? <Badge tone="warning">Unsaved changes</Badge> : <Badge tone="neutral">Saved</Badge>;
}
