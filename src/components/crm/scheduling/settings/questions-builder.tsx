"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/primitives";
import { blankQuestion, MAX_QUESTIONS, questionProblem, type QuestionDraft } from "@/components/crm/scheduling/settings/forms";

const TYPE_LABEL: Record<QuestionDraft["type"], string> = { text: "Short answer", textarea: "Long answer", select: "Choice from a list" };

/** Extra questions on the booking form, in order. Every control is a real input or button; reordering uses up and down buttons. */
export function QuestionsBuilder({ value, onChange, showErrors, idPrefix }: { value: QuestionDraft[]; onChange: (v: QuestionDraft[]) => void; showErrors: boolean; idPrefix: string }) {
  const update = (id: string, patch: Partial<QuestionDraft>) => onChange(value.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ol className="space-y-2">
          {value.map((d, i) => {
            const id = `${idPrefix}-${d.id}`;
            const problem = showErrors ? questionProblem(d) : null;
            return (
              <li key={d.id} className="rounded-xl border border-line bg-surface p-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
                  <div>
                    <label htmlFor={`${id}-label`} className="sr-only">Question {i + 1}</label>
                    <Input id={`${id}-label`} value={d.label} placeholder="What's the property address?" maxLength={120} onChange={(e) => update(d.id, { label: e.target.value })} aria-invalid={!!problem || undefined} aria-describedby={problem ? `${id}-err` : undefined} />
                  </div>
                  <div>
                    <label htmlFor={`${id}-type`} className="sr-only">Answer type for question {i + 1}</label>
                    <Select id={`${id}-type`} value={d.type} onChange={(e) => update(d.id, { type: e.target.value as QuestionDraft["type"] })}>
                      {(Object.keys(TYPE_LABEL) as Array<QuestionDraft["type"]>).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                    </Select>
                  </div>
                </div>
                {d.type === "select" && (
                  <div className="mt-2">
                    <label htmlFor={`${id}-opts`} className="text-[13px] font-medium text-ink-2">Choices, one per line</label>
                    <Textarea id={`${id}-opts`} rows={3} className="mt-1 min-h-[72px]" value={d.optionsText} onChange={(e) => update(d.id, { optionsText: e.target.value })} placeholder={"Morning\nAfternoon"} />
                  </div>
                )}
                {problem && <p id={`${id}-err`} role="alert" className="mt-2 text-[13px] text-danger-ink">{problem}</p>}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <label className="flex min-h-11 items-center gap-2 text-[14px] text-ink-2 sm:min-h-8">
                    <input type="checkbox" className="size-4 accent-primary" checked={d.required} onChange={(e) => update(d.id, { required: e.target.checked })} />
                    Required
                  </label>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move question ${i + 1} down`} disabled={i === value.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove question ${i + 1}`} onClick={() => onChange(value.filter((x) => x.id !== d.id))}><Trash2 className="size-4" /></Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" size="sm" disabled={value.length >= MAX_QUESTIONS} onClick={() => onChange([...value, blankQuestion()])}><Plus className="size-4" />Add a question</Button>
        <span className="text-[12px] text-muted" aria-live="polite">{value.length} of {MAX_QUESTIONS} questions</span>
      </div>
    </div>
  );
}
