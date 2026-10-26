"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ArrowLeft, Copy, ExternalLink, Eye, Globe, MoreHorizontal, PowerOff, Rocket, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Segmented, Switch, Tabs } from "@/components/ui/overlays";
import { ConfirmDialog, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import {
  duplicateFormAction, publishFormAction, saveFormDraftAction, setFormArchivedAction, unpublishFormAction, updateFormSettingsAction,
} from "@/app/actions/crm-forms";
import {
  canonicalJson, FORM_KIND_LABELS, FORM_LIMITS, FORM_PURPOSE_LABELS, FORM_PURPOSES, formContextFrom, hasErrors, newQuestion, normalizeDraft, publicDefinition, questionKeyFrom,
  validateDraft, type FormDraft, type FormIssue, type FormKind, type FormPurpose, type FormQuestion, type QuestionType,
} from "@/lib/crm/forms/spec";
import { PublicForm } from "@/components/crm/forms/public-form";
import { AddQuestionMenu, DirtyPill, QuestionList, QuestionPanel } from "@/components/crm/forms/question-editor";
import { AfterEditor } from "@/components/crm/forms/after-editor";
import { SubmissionsPanel } from "@/components/crm/forms/submissions-panel";
import { VersionsPanel } from "@/components/crm/forms/versions-panel";
import { FormStatusBadge, IssueList, Section } from "@/components/crm/forms/parts";
import type { CrmScope } from "@/server/crm/page";
import type { FormBuilderOptions, FormDetail, FormTab, FormVersionView, SubmissionPage, SubmissionStatus } from "@/components/crm/forms/types";

export interface FormEditorProps {
  scope: CrmScope;
  form: FormDetail;
  options: FormBuilderOptions;
  versions: FormVersionView[];
  tab: FormTab;
  submissions: SubmissionPage | null;
  submissionStatus: SubmissionStatus | "all";
  canManage: boolean;
  canSeeSubmissions: boolean;
}

const json = (d: FormDraft) => canonicalJson(d);
const subscribeNever = () => () => undefined;

/** One form: build its questions, decide what a submission does, publish frozen versions, and read what came in. */
export function FormEditor(props: FormEditorProps) {
  const { scope, form, options, canManage } = props;
  const router = useRouter();
  const pathname = usePathname();
  const { run, busy } = useCrmAction();
  const readOnly = !canManage || form.status === "archived";
  const [tab, setTab] = React.useState<FormTab>(props.tab);
  const [draft, setDraft] = React.useState<FormDraft>(form.draft);
  const [saved, setSaved] = React.useState(() => json(form.draft));
  const [revision, setRevision] = React.useState(form.draftRevision);
  const [selected, setSelected] = React.useState<string | null>(form.draft.questions[0]?.key ?? null);
  const [previewing, setPreviewing] = React.useState(false);
  const [confirm, setConfirm] = React.useState<"offline" | "archive" | null>(null);
  const forceSync = React.useRef(false);
  const dirty = json(draft) !== saved;

  // The server's copy moved on (someone else saved, or a version was put back into the draft): take it, unless there are edits here.
  React.useEffect(() => {
    if (form.draftRevision === revision && !forceSync.current) return;
    if (dirty && !forceSync.current) return;
    forceSync.current = false;
    setDraft(form.draft);
    setSaved(json(form.draft));
    setRevision(form.draftRevision);
    setSelected((s) => (s && form.draft.questions.some((q) => q.key === s) ? s : form.draft.questions[0]?.key ?? null));
    // Only a new server revision should replace the draft here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.draftRevision, form.draft]);

  // A link to another tab (a notification, the browser's back button) moves the tab too.
  const [propTab, setPropTab] = React.useState(props.tab);
  if (props.tab !== propTab) {
    setPropTab(props.tab);
    setTab(props.tab);
  }

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const ctx = React.useMemo(
    () => formContextFrom({ tags: options.tags, pipelines: options.pipelines, contactFields: options.contactFields, assignmentRules: options.assignmentRuleRefs.map((r) => ({ ...r, active: true })) }),
    [options],
  );
  const issues = React.useMemo(() => validateDraft(draft, ctx, { kind: form.kind }), [draft, ctx, form.kind]);
  const errors = issues.filter((i) => i.level === "error");
  const contactsBlocked = Boolean(options.contactsProblem);

  const changeTab = (t: string) => {
    setTab(t as FormTab);
    const sp = new URLSearchParams();
    if (t !== "build") sp.set("tab", t);
    router.replace(`${pathname}${sp.size ? `?${sp}` : ""}`, { scroll: false });
  };
  const submissionsHref = ({ status, page }: { status?: string; page?: number }) => {
    const sp = new URLSearchParams({ tab: "submissions" });
    if (status) sp.set("status", status);
    if (page && page > 1) sp.set("page", String(page));
    return `${pathname}?${sp}`;
  };

  // --- Editing the questions ------------------------------------------------
  const setQuestions = (questions: FormQuestion[]) => setDraft((d) => ({ ...d, questions }));
  const updateQuestion = (key: string, next: FormQuestion) => setQuestions(draft.questions.map((q) => (q.key === key ? next : q)));
  const addQuestion = (type: QuestionType) => {
    if (draft.questions.length >= FORM_LIMITS.questions) return toast.error(`A form can have at most ${FORM_LIMITS.questions} questions.`);
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
    if (draft.questions.some((q) => q.key === to)) return toast.error(`Another question already uses the answer key “${to}”.`);
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

  // --- Saving and publishing -------------------------------------------------
  const save = async (quiet = false): Promise<number | null> => {
    const sent = draft;
    const r = await run("save", () => saveFormDraftAction(scope.orgId, form.id, { draft: sent, expectedRevision: revision }), quiet ? undefined : "Draft saved. Publish to make the changes live.");
    if (!r || typeof r !== "object") return null;
    setRevision(r.revision);
    setSaved(json(sent));
    return r.revision;
  };
  const publish = async () => {
    if (hasErrors(issues)) {
      setTab("build");
      return toast.error(`Fix ${errors.length === 1 ? "the problem" : `the ${errors.length} problems`} listed before publishing.`);
    }
    const rev = dirty ? await save(true) : revision;
    if (rev === null) return;
    await run("publish", () => publishFormAction(scope.orgId, form.id, rev), (r) => (r.created ? `Published as version ${r.version}. Visitors see it straight away.` : form.status === "published" ? `Version ${r.version} is already live.` : `Live again as version ${r.version}.`));
  };
  const pickIssue = (i: FormIssue) => {
    if (i.area === "questions") {
      setTab("build");
      if (i.question) setSelected(i.question);
    } else setTab(i.area === "settings" || i.area === "consent" || i.area === "actions" ? "after" : "build");
  };

  const previewDef = React.useMemo(() => {
    const d = normalizeDraft(draft);
    return publicDefinition({ key: form.key, name: form.name, kind: form.kind }, { version: 0, fields: d.questions, consent: d.consent, settings: d.settings, actions: d.actions });
  }, [draft, form.key, form.name, form.kind]);

  const selectedIndex = draft.questions.findIndex((q) => q.key === selected);
  const selectedQuestion = selectedIndex >= 0 ? draft.questions[selectedIndex] : null;
  // The full link needs the browser's own address; until then (and on the server) the path is shown.
  const origin = React.useSyncExternalStore(subscribeNever, () => window.location.origin, () => "");
  const hostedUrl = `${origin}${form.hostedPath}`;

  return (
    <div className="space-y-5">
      <div>
        <Link href={`${scope.base}/forms`} className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />All forms</Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[20px] font-semibold tracking-[-0.03em] text-ink">{form.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <FormStatusBadge status={form.status} />
              {form.publishedVersion && <Badge tone="outline">Version {form.publishedVersion} live</Badge>}
              {form.status === "published" && (form.unpublishedChanges || dirty) && <Badge tone="warning">Changes not live yet</Badge>}
              <Badge tone="outline">{FORM_KIND_LABELS[form.kind]}</Badge>
              {!readOnly && <DirtyPill dirty={dirty} saving={busy("save")} />}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setPreviewing(true)}><Eye className="size-4" aria-hidden />Preview</Button>
            {!readOnly && <Button variant="secondary" onClick={() => void save()} loading={busy("save")} disabled={!dirty}><Save className="size-4" aria-hidden />Save draft</Button>}
            {!readOnly && (
              <Button onClick={() => void publish()} loading={busy("publish")} disabled={contactsBlocked || (!dirty && !form.unpublishedChanges && form.status === "published")}>
                <Rocket className="size-4" aria-hidden />{form.status === "published" ? "Publish changes" : "Publish"}
              </Button>
            )}
            {canManage && (
              <Menu>
                <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                <MenuContent>
                  {form.status === "published" && <MenuItem onSelect={() => setConfirm("offline")}><PowerOff className="size-4" aria-hidden />Take offline</MenuItem>}
                  <MenuItem onSelect={() => void run("dup", () => duplicateFormAction(scope.orgId, form.id), "Copy made. It starts as a draft.").then((r) => { if (r && typeof r === "object") router.push(`${scope.base}/forms/${r.id}`); })}><Copy className="size-4" aria-hidden />Duplicate</MenuItem>
                  <MenuSeparator />
                  {form.status === "archived"
                    ? <MenuItem onSelect={() => void run("restore", () => setFormArchivedAction(scope.orgId, form.id, false), "Restored as a draft.")}><ArchiveRestore className="size-4" aria-hidden />Restore</MenuItem>
                    : <MenuItem destructive onSelect={() => setConfirm("archive")}><Archive className="size-4" aria-hidden />Archive</MenuItem>}
                </MenuContent>
              </Menu>
            )}
          </div>
        </div>
      </div>

      {options.contactsProblem && <p className="rounded-xl border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[14px] leading-relaxed text-warning-ink">{options.contactsProblem}</p>}
      {form.status === "archived" && <ReadOnlyNotice>This form is archived, so it takes no answers. Restore it to edit or publish it again.</ReadOnlyNotice>}
      {!canManage && form.status !== "archived" && <ReadOnlyNotice>{scope.readOnly ? undefined : "You can see this form and its results. Owners and managers change and publish it."}</ReadOnlyNotice>}

      <Tabs
        id="form-tabs"
        value={tab}
        onValueChange={changeTab}
        items={[
          { value: "build", label: "Questions", count: draft.questions.length },
          { value: "after", label: "Consent & actions" },
          { value: "settings", label: "Sharing & settings" },
          { value: "submissions", label: "Submissions", ...(props.canSeeSubmissions ? { count: form.submissions.total } : {}) },
          { value: "versions", label: "Versions", count: props.versions.length },
        ]}
      >
        {tab === "build" && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <div className="space-y-4">
              <Card className="p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-ink">Questions</h3>
                  {!readOnly && <AddQuestionMenu onAdd={addQuestion} disabled={draft.questions.length >= FORM_LIMITS.questions} label="Add" />}
                </div>
                {draft.questions.length ? (
                  <QuestionList questions={draft.questions} selected={selected} onSelect={setSelected} onMove={moveQuestion} issues={issues} readOnly={readOnly} fields={options.contactFields} />
                ) : (
                  <p className="rounded-xl bg-surface-2 px-3 py-4 text-center text-[13px] text-muted">No questions yet. Add the first one.</p>
                )}
              </Card>
              {issues.length > 0 && (
                <Card className="p-3">
                  <h3 className="px-2 pb-1 text-[14px] font-semibold text-ink">{errors.length ? `${errors.length} to fix before publishing` : "Worth checking"}</h3>
                  <IssueList issues={issues} onPick={pickIssue} />
                </Card>
              )}
            </div>
            <Card className="p-4 sm:p-5">
              {selectedQuestion ? (
                <QuestionPanel
                  key={selectedQuestion.key}
                  question={selectedQuestion}
                  index={selectedIndex}
                  questions={draft.questions}
                  onChange={(q) => updateQuestion(selectedQuestion.key, q)}
                  onRemove={() => removeQuestion(selectedQuestion.key)}
                  onDuplicate={() => duplicateQuestion(selectedQuestion.key)}
                  onKeyChange={renameKey}
                  options={options}
                  readOnly={readOnly}
                  issues={issues}
                />
              ) : (
                <EmptyState compact title="Choose a question" description="Pick a question on the left to edit it, or add a new one." action={!readOnly ? <AddQuestionMenu onAdd={addQuestion} /> : undefined} />
              )}
            </Card>
          </div>
        )}

        {tab === "after" && (
          <div className="space-y-4">
            {issues.some((i) => i.area !== "questions") && (
              <Card className="p-3"><IssueList issues={issues.filter((i) => i.area !== "questions")} /></Card>
            )}
            <AfterEditor draft={draft} onChange={setDraft} options={options} readOnly={readOnly} kind={form.kind} scope={scope} />
          </div>
        )}

        {tab === "settings" && <SettingsPanel scope={scope} form={form} readOnly={readOnly} hostedUrl={hostedUrl} />}

        {tab === "submissions" && <SubmissionsPanel scope={scope} page={props.submissions} status={props.submissionStatus} hrefFor={submissionsHref} canSee={props.canSeeSubmissions} />}

        {tab === "versions" && (
          <VersionsPanel scope={scope} formId={form.id} versions={props.versions} canManage={!readOnly} draftRevision={revision} dirty={dirty} onRestored={() => { forceSync.current = true; }} />
        )}
      </Tabs>

      <Dialog open={previewing} onOpenChange={setPreviewing} size="lg" title="Preview" description="The draft as visitors will see it once published. Try the questions; sending is switched off here.">
        <div>
          <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{previewDef.title}</h2>
          {previewDef.intro && <p className="mt-1.5 whitespace-pre-line text-[14px] text-muted">{previewDef.intro}</p>}
          <div className="mt-5"><PublicForm key={json(draft)} def={previewDef} action={null} idPrefix="preview" /></div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirm === "offline"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Take this form offline?"
        description="Its page and your website stop accepting it straight away (the website shows its built-in enquiry form instead). Submissions already received are kept and still processed."
        confirmLabel="Take offline"
        danger
        loading={busy("offline")}
        onConfirm={() => void run("offline", () => unpublishFormAction(scope.orgId, form.id), "The form is offline.").then((r) => { if (r) setConfirm(null); })}
      />
      <ConfirmDialog
        open={confirm === "archive"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Archive this form?"
        description="It stops taking answers everywhere. Its versions and submissions are kept, and you can restore it later."
        confirmLabel="Archive"
        danger
        loading={busy("archive")}
        onConfirm={() => void run("archive", () => setFormArchivedAction(scope.orgId, form.id, true), "Archived.").then((r) => { if (r) setConfirm(null); })}
      />
    </div>
  );
}

function SettingsPanel({ scope, form, readOnly, hostedUrl }: { scope: CrmScope; form: FormDetail; readOnly: boolean; hostedUrl: string }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(form.name);
  const [key, setKey] = React.useState(form.key);
  const [purpose, setPurpose] = React.useState<FormPurpose>(form.purpose);
  const [kind, setKind] = React.useState<FormKind>(form.kind);
  // After a save (or someone else's), the saved details become the starting point again.
  const savedKey = `${form.name} ${form.key} ${form.purpose} ${form.kind}`;
  const [lastSaved, setLastSaved] = React.useState(savedKey);
  if (savedKey !== lastSaved) {
    setLastSaved(savedKey);
    setName(form.name);
    setKey(form.key);
    setPurpose(form.purpose);
    setKind(form.kind);
  }
  const changed = name !== form.name || key !== form.key || purpose !== form.purpose || kind !== form.kind;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hostedUrl);
      toast.success("Link copied.");
    } catch {
      window.prompt("Copy this link:", hostedUrl);
    }
  };
  const live = form.status === "published";
  return (
    <div className="space-y-4">
      <Section title="Its own page" description="A page with just this form, at its own address: share it in messages, on social media or in a QR code. It works on any phone, even without script.">
        <label className="flex items-start gap-2.5 text-[14px] text-ink-2">
          <Switch
            checked={form.hosted}
            disabled={readOnly || busy("hosted")}
            onCheckedChange={(v) => void run("hosted", () => updateFormSettingsAction(scope.orgId, form.id, { hosted: v }), v ? (live ? "The page is on." : "The page will open once the form is published.") : "The page is off.")}
            aria-label="Offer this form on its own page"
          />
          <span>
            <span className="block font-medium text-ink">Offer this form on its own page</span>
            <span className="block text-[12px] text-muted">{form.hosted ? (live ? "On: anyone with the link can send it." : "On, but the form isn't published yet, so the page says it isn't available.") : "Off: the link shows that the form isn't available."}</span>
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5">
          <Globe className="size-4 shrink-0 text-muted" aria-hidden />
          <code className="min-w-0 flex-1 break-all text-[13px] text-ink-2">{hostedUrl}</code>
          <Button size="sm" variant="secondary" onClick={() => void copy()}><Copy className="size-3.5" aria-hidden />Copy</Button>
          {form.hosted && live && <a href={form.hostedPath} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[14px] font-medium text-primary-ink hover:bg-primary-soft sm:min-h-8"><ExternalLink className="size-3.5" aria-hidden />Open</a>}
        </div>
      </Section>

      <Section title="On your website" description="Add an “Enquiry form” element in Website Studio and choose this form in its settings. The website then shows these questions and posts them here.">
        {form.websitePages.length ? (
          <p className="text-[14px] text-ink-2">Live on: {form.websitePages.join(", ")}.</p>
        ) : (
          <p className="text-[14px] text-muted">{live ? "Not on your live website yet." : "Publish the form first; the website shows it as soon as it's live."}</p>
        )}
        <p className="text-[12px] text-muted">Use the address below to choose it: <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-ink-2">{form.key}</code></p>
      </Section>

      <Section title="Details" actions={!readOnly ? <Button size="sm" disabled={!changed} loading={busy("details")} onClick={() => void run("details", () => updateFormSettingsAction(scope.orgId, form.id, { name, key: key !== form.key ? key : undefined, purpose, kind }), "Saved.")}>Save details</Button> : undefined}>
        <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="fs-name" hint="Only your team sees this.">
            <Input id="fs-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Address" htmlFor="fs-key" hint={form.everPublished ? "This form has been published, so its address is in use and stays the same. Duplicate it to use another." : "Lower-case letters, numbers and hyphens. Used in the page link and on your website."}>
            <Input id="fs-key" value={key} maxLength={48} disabled={form.everPublished} className="font-mono text-[14px]" onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
          </Field>
          <Field label="Kind" htmlFor="fs-kind">
            <Segmented id="fs-kind" ariaLabel="Kind" value={kind} onChange={setKind} options={[{ value: "form", label: "Form" }, { value: "survey", label: "Survey" }]} />
          </Field>
          <Field label="What it's for" htmlFor="fs-purpose" hint="Used in reports.">
            <Select id="fs-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as FormPurpose)}>
              {FORM_PURPOSES.map((p) => <option key={p} value={p}>{FORM_PURPOSE_LABELS[p]}</option>)}
            </Select>
          </Field>
        </fieldset>
      </Section>
    </div>
  );
}
