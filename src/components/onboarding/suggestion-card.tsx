"use client";

import * as React from "react";
import { Pencil, RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { QuestionInput } from "./question-inputs";
import { describeValue, isEmptyValue, validateAnswer } from "@/lib/onboarding/engine";
import type { Answers, AnswerValue, QuestionDef } from "@/lib/onboarding/types";
import type { Clarification } from "@/lib/onboarding/assistance";

export function SuggestionCard({ q, answers, value, reason, website, limited, clarifications = [], busy, onUse, onDismiss, onRegenerate }: {
  q: QuestionDef; answers: Answers; value: AnswerValue; reason: string; website?: boolean; limited?: boolean; clarifications?: Clarification[]; busy?: boolean;
  onUse: (value: AnswerValue) => void; onDismiss: () => void; onRegenerate?: (details?: Record<string, string>) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  const [editing, setEditing] = React.useState(false);
  const [details, setDetails] = React.useState<Record<string, string>>({});
  const check = draft === null ? null : validateAnswer(q, draft, answers);
  const canUse = check?.ok && !isEmptyValue(check.value);
  return (
    <section aria-label="AI suggestion preview" className="rounded-xl border border-primary/20 bg-primary-soft/25 p-3.5 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-primary-ink"><Sparkles className="size-3.5" aria-hidden /> {website ? "Website draft" : "AI draft"}</p>
        <button type="button" onClick={onDismiss} aria-label="Dismiss suggestion" className="flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary"><X className="size-4" aria-hidden /></button>
      </div>
      {draft !== null && (editing ? (
        <div className="mt-2 [&_input]:text-base [&_textarea]:text-base sm:[&_input]:text-sm sm:[&_textarea]:text-sm">
          <QuestionInput inputId="suggestion-input" q={q} value={draft} answers={answers} error={check && !check.ok ? check.error : null} onChange={setDraft} assets={[]} documents={[]} onAssetsChange={() => {}} onDocumentsChange={() => {}} onFilesChange={() => {}} />
          {check && !check.ok && <p id="suggestion-input-error" role="alert" className="mt-2 text-[12px] text-danger-ink">{check.error}</p>}
        </div>
      ) : <p className="whitespace-pre-line break-words text-[14px] leading-relaxed text-ink">{describeValue(q, draft, answers)}</p>)}
      {limited && <p className="mt-2 text-[12px] text-muted">A starting point. Add services or customers to make it more specific.</p>}
      {draft === null && <p className="text-[13px] text-ink-2">{reason || "Add a detail below to help draft this answer."}</p>}
      {clarifications.length > 0 && onRegenerate && (
        <details className="mt-3" open={draft === null ? true : undefined}>
          <summary className="min-h-11 cursor-pointer py-3 text-[12px] font-medium text-primary-ink">Add detail (optional)</summary>
          <div className="space-y-3 pb-2">
            {clarifications.map((item) => <div key={item.fieldId}>
              <label htmlFor={`clarify-${item.fieldId}`} className="text-[13px] font-medium text-ink">{item.label}</label>
              <Input id={`clarify-${item.fieldId}`} value={details[item.fieldId] ?? ""} maxLength={800} className="mt-1 text-base sm:text-sm" onChange={(event) => setDetails((current) => ({ ...current, [item.fieldId]: event.target.value }))} />
              <p className="mt-1 text-[12px] text-muted">{item.example}</p>
            </div>)}
            <Button type="button" variant="secondary" size="sm" disabled={busy || !Object.values(details).some((text) => text.trim())} onClick={() => onRegenerate(details)}>Improve draft</Button>
          </div>
        </details>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="secondary" size="sm" disabled={!canUse || busy} onClick={() => { if (check?.ok) onUse(check.value); }}>Use suggestion</Button>
        {draft !== null && <Button type="button" variant="ghost" size="sm" aria-label="Edit suggestion" onClick={() => setEditing((current) => !current)}><Pencil className="size-3.5" aria-hidden />{editing ? "Done" : "Edit"}</Button>}
        {onRegenerate && <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label="Regenerate suggestion" onClick={() => onRegenerate()}><RefreshCw className="size-3.5" aria-hidden /><span className="sr-only sm:not-sr-only">Regenerate</span></Button>}
      </div>
      <details className="mt-2 text-[12px] text-muted"><summary className="cursor-pointer py-1">{website ? "Based on your website" : "Based on your information"}</summary><p className="pt-1 leading-relaxed">{reason} Review before using. Nothing is added to your answer until you choose Use suggestion.</p></details>
    </section>
  );
}
