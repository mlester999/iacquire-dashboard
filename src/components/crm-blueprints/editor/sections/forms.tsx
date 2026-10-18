"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { AddQuestionMenu, QuestionList, QuestionPanel } from "@/components/crm/forms/question-editor";
import { AfterEditor } from "@/components/crm/forms/after-editor";
import { IssueList } from "@/components/crm/forms/parts";
import {
  FORM_KEY_RE, FORM_KIND_LABELS, FORM_KINDS, FORM_LIMITS, FORM_PURPOSE_LABELS, FORM_PURPOSES, formContextFrom, newQuestion, questionKeyFrom, validateDraft,
  type FormDraft, type FormKind, type FormPurpose, type FormQuestion, type QuestionType,
} from "@/lib/crm/forms/spec";
import type { FormAsset } from "@/lib/crm/blueprints/types";
import type { CrmScope } from "@/server/crm/page";
import { keysIn, updateAsset } from "@/components/crm-blueprints/editor/model";
import { formFromEditor, formOptionsFor, formToEditor } from "@/components/crm-blueprints/editor/bridge";
import { AssetWorkspace, DetailCard, DetailHeader, FieldGrid, FolderSelect, IssueNotes, SectionNote, issuesOf, useAdder, useEditor } from "@/components/crm-blueprints/editor/parts";
import { KeyInput, ToggleRow } from "@/components/crm-blueprints/editor/inputs";

export function FormsSection() {
  const { content, readOnly, remove, issues } = useEditor();
  const add = useAdder("forms");
  const items = content.assets.forms.map((f) => ({ id: f.id, name: f.name, detail: `${FORM_KIND_LABELS[f.kind]} · ${f.draft.questions.length} ${f.draft.questions.length === 1 ? "question" : "questions"}${f.placeholder ? " · to rebuild" : ""}` }));
  return (
    <>
      <AssetWorkspace
        section="forms"
        title="Forms & surveys"
        intro="Forms a client starts with, built with the CRM's own form builder. Their choices are this Blueprint's tags, pipelines, fields and assignment rules."
        items={items}
        addLabel="Add form"
        onAdd={add.open}
        emptyText="Add the forms this kind of business puts on its website, such as a quote request or a contact form."
      >
        {(id) => {
          const f = content.assets.forms.find((x) => x.id === id)!;
          return (
            <DetailCard>
              <DetailHeader id={f.id} title={f.name} kind={FORM_KIND_LABELS[f.kind]} onRemove={() => remove(f.id, f.name)} />
              <SectionNote>Forms arrive in a client&apos;s CRM as drafts and take no submissions until someone there reviews and publishes them.</SectionNote>
              <IssueNotes issues={issuesOf(issues, f.id).filter((i) => i.code !== "native_form")} />
              <FormSettings form={f} />
              {!readOnly || f.draft.questions.length ? <FormBuilder key={f.id} form={f} /> : null}
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

function FormSettings({ form: f }: { form: FormAsset }) {
  const { content, edit, readOnly } = useEditor();
  const set = (patch: Partial<FormAsset>) => edit((c) => updateAsset(c, "forms", f.id, (x) => ({ ...x, ...patch })));
  const taken = keysIn(content, "forms").filter((k) => k !== f.key);
  return (
    <div className="space-y-4">
      <FieldGrid>
        <Field label="Name" htmlFor="fm-name"><Input id="fm-name" value={f.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Key" htmlFor="fm-key" hint="The hosted page's address in each client's CRM.">
          <KeyInput id="fm-key" value={f.key} pattern={FORM_KEY_RE} taken={taken} disabled={readOnly} invalidText="Lower-case letters, numbers and hyphens inside (48 at most)." onCommit={(key) => set({ key })} />
        </Field>
        <Field label="Kind" htmlFor="fm-kind">
          <Select id="fm-kind" value={f.kind} disabled={readOnly} onChange={(e) => set({ kind: e.target.value as FormKind })}>
            {FORM_KINDS.map((k) => <option key={k} value={k}>{FORM_KIND_LABELS[k]}</option>)}
          </Select>
        </Field>
        <Field label="Purpose" htmlFor="fm-purpose">
          <Select id="fm-purpose" value={f.purpose} disabled={readOnly} onChange={(e) => set({ purpose: e.target.value as FormPurpose })}>
            {FORM_PURPOSES.map((p) => <option key={p} value={p}>{FORM_PURPOSE_LABELS[p]}</option>)}
          </Select>
        </Field>
        <FolderSelect id="fm-folder" kind="form" value={f.folder} onChange={(folder) => set({ folder })} />
      </FieldGrid>
      {f.placeholder && (
        <ToggleRow
          id="fm-placeholder"
          label="Only the name is known"
          hint="This form came over without its questions (GoHighLevel's API shares names only). Build its questions, then switch this off: until then each client is asked to rebuild it."
          checked={f.placeholder}
          disabled={readOnly}
          onChange={(placeholder) => set({ placeholder })}
        />
      )}
    </div>
  );
}

/**
 * The CRM's own question list, question panel and "after submitting" editor, on this form's draft. The builder works on the native draft
 * shape with this Blueprint's references as its IDs; every change is turned back into the package draft at once.
 */
function FormBuilder({ form }: { form: FormAsset }) {
  const { content, edit, readOnly, linkBase } = useEditor();
  const options = React.useMemo(() => formOptionsFor(content), [content]);
  const bridged = React.useMemo(() => formToEditor(form, content), [form, content]);
  const draft = bridged.value;
  const [tab, setTab] = React.useState<"questions" | "after">("questions");
  const [selected, setSelected] = React.useState<string | null>(draft.questions[0]?.key ?? null);
  const ctx = React.useMemo(
    () => formContextFrom({ tags: options.tags, pipelines: options.pipelines, contactFields: options.contactFields, assignmentRules: options.assignmentRuleRefs.map((r) => ({ ...r, active: true })) }),
    [options],
  );
  const issues = React.useMemo(() => validateDraft(draft, ctx, { kind: form.kind }), [draft, ctx, form.kind]);
  const scope = React.useMemo<CrmScope>(() => ({ base: linkBase, orgId: null, agency: true, readOnly, userId: null, timezone: "UTC", currency: "USD", can: {} }), [linkBase, readOnly]);

  const setDraft = (next: FormDraft | ((d: FormDraft) => FormDraft)) => {
    const value = typeof next === "function" ? next(draft) : next;
    edit((c) => updateAsset(c, "forms", form.id, (x) => ({ ...x, draft: formFromEditor(value, x, c) })));
  };
  const setQuestions = (questions: FormQuestion[]) => setDraft((d) => ({ ...d, questions }));
  const addQuestion = (type: QuestionType) => {
    if (draft.questions.length >= FORM_LIMITS.questions) return void toast.error(`A form can have at most ${FORM_LIMITS.questions} questions.`);
    const q = newQuestion(type, draft.questions.map((x) => x.key));
    const at = selected ? draft.questions.findIndex((x) => x.key === selected) + 1 : draft.questions.length;
    const next = [...draft.questions];
    next.splice(at <= 0 ? next.length : at, 0, q);
    setQuestions(next);
    setSelected(q.key);
  };
  const moveQuestion = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= draft.questions.length) return;
    const next = [...draft.questions];
    [next[i], next[j]] = [next[j], next[i]];
    setQuestions(next);
  };
  const removeQuestion = (key: string) => {
    const i = draft.questions.findIndex((q) => q.key === key);
    const next = draft.questions.filter((q) => q.key !== key);
    setQuestions(next);
    setSelected(next[Math.min(i, next.length - 1)]?.key ?? null);
  };
  const duplicateQuestion = (key: string) => {
    const i = draft.questions.findIndex((q) => q.key === key);
    const q = draft.questions[i];
    if (!q) return;
    const copy: FormQuestion = { ...structuredClone(q), key: questionKeyFrom(`${q.label} copy`, draft.questions.map((x) => x.key)), label: `${q.label} (copy)`.slice(0, 200), map: null };
    const next = [...draft.questions];
    next.splice(i + 1, 0, copy);
    setQuestions(next);
    setSelected(copy.key);
  };
  const renameKey = (from: string, to: string) => {
    if (draft.questions.some((q) => q.key === to)) return void toast.error(`Another question already uses the answer key “${to}”.`);
    setDraft((d) => ({
      ...d,
      questions: d.questions.map((q) => ({
        ...(q.key === from ? { ...q, key: to } : q),
        visibleWhen: q.visibleWhen ? { ...q.visibleWhen, conditions: q.visibleWhen.conditions.map((c) => (c.question === from ? { ...c, question: to } : c)) } : q.visibleWhen,
      })),
      actions: d.actions.opportunity ? {
        ...d.actions,
        opportunity: { ...d.actions.opportunity, valueQuestion: d.actions.opportunity.valueQuestion === from ? to : d.actions.opportunity.valueQuestion, name: d.actions.opportunity.name.split(`{{answer.${from}}}`).join(`{{answer.${to}}}`) },
      } : d.actions,
    }));
    setSelected(to);
  };

  const selectedIndex = draft.questions.findIndex((q) => q.key === selected);
  const selectedQuestion = selectedIndex >= 0 ? draft.questions[selectedIndex] : null;
  const errors = issues.filter((i) => i.level === "error").length;

  return (
    <div className="space-y-4 border-t border-line pt-4">
      {bridged.unresolved.length > 0 && (
        <SectionNote tone="warning">
          {bridged.unresolved.length} {bridged.unresolved.length === 1 ? "reference points" : "references point"} at something that isn&apos;t in this Blueprint
          ({bridged.unresolved.map((u) => u.value).slice(0, 3).join(", ")}). The builder shows {bridged.unresolved.length === 1 ? "it as missing" : "them as missing"} and keeps {bridged.unresolved.length === 1 ? "it" : "them"} as written; point {bridged.unresolved.length === 1 ? "it" : "them"} at something in this Blueprint before publishing.
        </SectionNote>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented id={`form-tab-${form.id}`} ariaLabel="Form builder" value={tab} onChange={setTab} options={[{ value: "questions", label: `Questions (${draft.questions.length})` }, { value: "after", label: "Consent & actions" }]} />
        {issues.length > 0 && <span className="text-[12.5px] text-muted" role="status">{errors ? `${errors} to fix before a client can publish it` : "Worth checking"}</span>}
      </div>
      {issues.length > 0 && <Card className="p-2"><IssueList issues={issues} onPick={(i) => { if (i.area === "questions") { setTab("questions"); if (i.question) setSelected(i.question); } else setTab("after"); }} /></Card>}
      {tab === "questions" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-[14px] font-semibold text-ink">Questions</h4>
              {!readOnly && <AddQuestionMenu onAdd={addQuestion} disabled={draft.questions.length >= FORM_LIMITS.questions} label="Add" />}
            </div>
            {draft.questions.length ? (
              <QuestionList questions={draft.questions} selected={selected} onSelect={setSelected} onMove={moveQuestion} issues={issues} readOnly={readOnly} fields={options.contactFields} />
            ) : (
              <p className="rounded-xl bg-surface-2 px-3 py-4 text-center text-[12.5px] text-muted">No questions yet. Add the first one.</p>
            )}
          </div>
          <div className="min-w-0 rounded-2xl border border-line p-4">
            {selectedQuestion ? (
              <QuestionPanel
                key={selectedQuestion.key}
                question={selectedQuestion}
                index={selectedIndex}
                questions={draft.questions}
                onChange={(q) => setQuestions(draft.questions.map((x) => (x.key === selectedQuestion.key ? q : x)))}
                onRemove={() => removeQuestion(selectedQuestion.key)}
                onDuplicate={() => duplicateQuestion(selectedQuestion.key)}
                onKeyChange={renameKey}
                options={options}
                readOnly={readOnly}
                issues={issues}
              />
            ) : (
              <EmptyState compact title="Choose a question" description="Pick a question to edit it, or add a new one." action={!readOnly ? <AddQuestionMenu onAdd={addQuestion} /> : undefined} />
            )}
          </div>
        </div>
      ) : (
        <AfterEditor draft={draft} onChange={(d) => setDraft(d)} options={options} readOnly={readOnly} kind={form.kind} scope={scope} />
      )}
    </div>
  );
}
