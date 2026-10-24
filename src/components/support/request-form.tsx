"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Lightbulb, Loader2, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { Notice } from "@/components/settings/panel";
import { Switch } from "@/components/ui/overlays";
import { AttachmentPicker, type PickerState } from "@/components/support/attachment-picker";
import { findSimilarRequestsAction, improveRequestDraftAction, submitRequestAction, suggestForDraftAction } from "@/app/actions/support";
import {
  AFFECTED_FEATURES, CATEGORIES_BY_TYPE, CATEGORY_LABELS, CLIENT_URGENCIES, CLIENT_URGENCY_LABELS, FEATURE_LABELS, categoryLabel, statusLabelForClient, type ClientUrgency, type RequestType,
} from "@/lib/support/lifecycle";
import { describeDiagnostics, newIdempotencyKey, sanitizeDiagnostics, summarizeUserAgent, type Diagnostics } from "@/lib/support/content";
import { cn } from "@/lib/utils";

interface Values {
  subject: string;
  category: string;
  feature: string;
  message: string;
  happened: string;
  expected: string;
  steps: string;
  urgency: ClientUrgency | "";
  includeDiagnostics: boolean;
  errorReference: string;
  /** Request a Change: the project a change is about, and whether it is also filed as a change to what was agreed. */
  projectId: string;
  asChange: boolean;
}

const EMPTY: Omit<Values, "category"> = { subject: "", feature: "", message: "", happened: "", expected: "", steps: "", urgency: "", includeDiagnostics: false, errorReference: "", projectId: "", asChange: false };

/** What Request a Change needs besides the form itself: the projects a change can be about, and what the person's plan says, if anything. */
export interface ChangeFormProps {
  projects: Array<{ id: string; ref: string; title: string; status: string; canFileAsChange: boolean }>;
  /** One sentence about the monthly maintenance allowance. Null unless the workspace has an active plan. */
  allowanceNote: string | null;
}

const COPY: Record<RequestType, {
  subjectLabel: string; subjectHint: string; subjectPlaceholder: string; categoryLabel: string; categoryHint: string; featureLabel: string; messageLabel: string; messageHint: string; messagePlaceholder: string;
  submit: string; sentTitle: string; sentBody: string;
}> = {
  support: {
    subjectLabel: "Request subject", subjectHint: "A few words are enough.", subjectPlaceholder: "For example: My calendar isn't syncing", categoryLabel: "What is this about?", categoryHint: "This helps us send your request to the right person.",
    featureLabel: "Which part of iAcquire is it about?", messageLabel: "How can we help?", messageHint: "Tell us what you're trying to do and what's getting in the way.", messagePlaceholder: "Tell us a bit about what you need…",
    submit: "Send request", sentTitle: "Your request has been sent", sentBody: "The iAcquire team will review it and reply here. You can follow everything from My Requests.",
  },
  issue: {
    subjectLabel: "Issue title", subjectHint: "What's going wrong, in a few words?", subjectPlaceholder: "For example: The contacts page never finishes loading", categoryLabel: "What kind of problem is it?", categoryHint: "Pick the closest match.",
    featureLabel: "Which feature is affected?", messageLabel: "What happened?", messageHint: "Tell us what you saw. Include any message that appeared.", messagePlaceholder: "Tell us what happened…",
    submit: "Send report", sentTitle: "Thanks. We've got your report", sentBody: "The team will look into it and update you here. If we need more detail, we'll ask in the request.",
  },
  feedback: {
    subjectLabel: "Feedback title", subjectHint: "Sum it up in a few words.", subjectPlaceholder: "For example: Let me tag messages in the inbox", categoryLabel: "What kind of feedback is it?", categoryHint: "Choose what fits best.",
    featureLabel: "Which part of iAcquire does it relate to?", messageLabel: "Tell us more", messageHint: "What would you like, and how would it help your business?", messagePlaceholder: "Share your idea or thoughts…",
    submit: "Send feedback", sentTitle: "Thank you for your feedback", sentBody: "We read all feedback. We can't promise every idea will be built, but you can follow what happens to it from My Requests.",
  },
  change: {
    subjectLabel: "What should change?", subjectHint: "A few words are enough.", subjectPlaceholder: "For example: Make the voice agent greet callers by name", categoryLabel: "What is the change about?", categoryHint: "This sends your request to the right person.",
    featureLabel: "Which part of iAcquire does it relate to?", messageLabel: "What would you like different?", messageHint: "Say what you want changed and why. Nothing is done, priced or promised until the team has replied.", messagePlaceholder: "Describe the change you have in mind…",
    submit: "Send change request", sentTitle: "Your change request has been sent", sentBody: "The team will look at it and tell you here whether it is covered, a small change, or needs a quote first. Nothing is done or charged until you agree.",
  },
};

const MESSAGE_MAX = 5000;
const draftKey = (kind: RequestType, orgId: string) => `iaq-support-draft:${kind}:${orgId}`;

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const subscribeNever = () => () => {};

const store = {
  read(key: string): Values | null {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Values) : null;
    } catch {
      return null;
    }
  },
  write(key: string, value: Values | null) {
    try {
      if (value) window.localStorage.setItem(key, JSON.stringify(value));
      else window.localStorage.removeItem(key);
    } catch {
      // Drafts are a convenience; a blocked store never stops the form.
    }
  },
};

export function RequestForm({
  kind, orgId, maxMb, maxFiles, expectation, appVersion, fromPath, defaultCategory, change, aboutProject,
}: {
  kind: RequestType;
  orgId: string;
  maxMb: number;
  maxFiles: number;
  expectation: string | null;
  appVersion: string;
  fromPath: string | null;
  defaultCategory?: string;
  /** Request a Change only. */
  change?: ChangeFormProps;
  /** A project the person came from (a link on the project's page), already checked to be one of this workspace's. The request is filed against it. */
  aboutProject?: { id: string; label: string };
}) {
  const copy = COPY[kind];
  const categories = CATEGORIES_BY_TYPE[kind];
  const initialCategory = defaultCategory && (categories as readonly string[]).includes(defaultCategory) ? defaultCategory : kind === "change" && aboutProject ? "change_project" : categories[0];
  const [values, setValues] = React.useState<Values>({ ...EMPTY, category: initialCategory, projectId: aboutProject?.id ?? "" });
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const [restored, setRestored] = React.useState(false);
  const [categoryChosen, setCategoryChosen] = React.useState(false);
  const [files, setFiles] = React.useState<PickerState>({ ids: [], busy: false, failed: false });
  const [pickerKey, setPickerKey] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<{ id: string; ref: string; status: string; existing: boolean; expectation: string | null; changeOrderRef: string | null } | null>(null);
  const [similarFound, setSimilar] = React.useState<Array<{ id: string; ref: string; subject: string; status: string }>>([]);
  const [suggestionFound, setSuggestion] = React.useState<{ category: string; requestType: RequestType; reason: string; confidence: string } | null>(null);
  const [articlesFound, setArticles] = React.useState<Array<{ id: string; title: string; href: string | null }>>([]);
  const [improving, setImproving] = React.useState(false);
  const [improved, setImproved] = React.useState<{ text: string; questions: string[] } | { reason: string } | null>(null);
  const keyRef = React.useRef(newIdempotencyKey());
  const lock = React.useRef(false);
  const formId = React.useId();
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const storageKey = draftKey(kind, orgId);

  // Restore an unsent draft once the page is running in the browser (it can't be read during server rendering). Everything here lives
  // in this browser only.
  const inBrowser = React.useSyncExternalStore(subscribeNever, () => true, () => false);
  const [draftChecked, setDraftChecked] = React.useState(false);
  if (inBrowser && !draftChecked) {
    setDraftChecked(true);
    const saved = store.read(storageKey);
    if (saved && (saved.subject || saved.message || saved.happened)) {
      setValues({ ...EMPTY, ...saved, projectId: aboutProject?.id ?? saved.projectId ?? "", category: saved.category && (categories as readonly string[]).includes(saved.category) ? saved.category : initialCategory });
      setCategoryChosen(true);
      setRestored(true);
    }
  }

  // The saved draft is only written after it has been read back, and only emptied once the person has actually edited the form, so the
  // first render (which has nothing in it yet) can never wipe the draft that is about to be restored.
  const edited = React.useRef(false);
  const contentOf = (v: Values) => Boolean(v.subject || v.message || v.happened || v.expected || v.steps);
  const debouncedValues = useDebounced(values, 500);
  React.useEffect(() => {
    if (sent || !draftChecked) return;
    if (contentOf(debouncedValues)) store.write(storageKey, debouncedValues);
    else if (edited.current) store.write(storageKey, null);
  }, [debouncedValues, draftChecked, sent, storageKey]);

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    edited.current = true;
    setValues((v) => ({ ...v, [key]: value }));
  };
  const body = kind === "issue" ? values.happened : values.message;

  // Requests the person already has that read alike.
  const subjectForSearch = useDebounced(values.subject.trim(), 700);
  React.useEffect(() => {
    if (sent || subjectForSearch.length < 8) return;
    let live = true;
    void findSimilarRequestsAction({ subject: subjectForSearch }).then((r) => {
      if (live && r.ok) setSimilar(r.data.slice(0, 3));
    });
    return () => {
      live = false;
    };
  }, [subjectForSearch, sent]);

  // A suggested topic and help articles from what they have written (no AI provider is called).
  const textForSuggest = useDebounced(`${values.subject}\n${body}`.trim(), 900);
  React.useEffect(() => {
    if (sent || textForSuggest.length < 30) return;
    let live = true;
    void suggestForDraftAction({ subject: values.subject, text: body }).then((r) => {
      if (!live || !r.ok) return;
      const s = r.data.suggestion;
      setSuggestion(s.confidence === "low" ? null : { category: s.category, requestType: s.requestType, reason: s.reason, confidence: s.confidence });
      setArticles(r.data.articles.filter((a) => a.href).slice(0, 3));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textForSuggest, sent]);

  // Technical details the person can choose to attach to an issue. They see every line before sending.
  const diagnostics: Diagnostics | null = React.useMemo(() => {
    if (kind !== "issue" || !values.includeDiagnostics || typeof window === "undefined") return null;
    const ua = summarizeUserAgent(window.navigator.userAgent);
    return sanitizeDiagnostics({
      page: fromPath ?? undefined, browser: ua.browser, os: ua.os, appVersion, references: values.errorReference.trim() ? [values.errorReference.trim()] : undefined,
      capturedAt: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: `${window.screen.width}x${window.screen.height}`, language: window.navigator.language,
    });
  }, [kind, values.includeDiagnostics, values.errorReference, fromPath, appVersion]);

  const similar = !sent && subjectForSearch.length >= 8 ? similarFound : [];
  const suggestion = !sent && textForSuggest.length >= 30 ? suggestionFound : null;
  const articles = !sent && textForSuggest.length >= 30 ? articlesFound : [];

  const isProjectChange = kind === "change" && values.category === "change_project";
  const pickedProject = isProjectChange ? change?.projects.find((p) => p.id === values.projectId) : undefined;
  const errors: Record<string, string> = {};
  if (isProjectChange && !pickedProject) errors.projectId = "Choose the project the change is about.";
  if (values.subject.trim().length < 3) errors.subject = "Add a short title.";
  if (body.trim().length < 5) errors[kind === "issue" ? "happened" : "message"] = kind === "issue" ? "Tell us what happened." : "Tell us a little more.";
  if (values.errorReference.trim() && !/^[A-Za-z0-9_-]{4,64}$/.test(values.errorReference.trim())) errors.errorReference = "Use only letters, numbers, - and _ (4 to 64 characters).";
  const show = (name: string) => (touched[name] ? errors[name] : undefined);

  const improve = async () => {
    setImproving(true);
    setImproved(null);
    const r = await improveRequestDraftAction({ type: kind, subject: values.subject, text: body });
    setImproving(false);
    if (!r.ok) setImproved({ reason: r.error });
    else if (!r.data.ok) setImproved({ reason: r.data.reason });
    else setImproved(r.data.data);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lock.current || submitting) return;
    setTouched({ subject: true, message: true, happened: true, errorReference: true, projectId: true });
    if (Object.keys(errors).length) {
      setError("Please fix the highlighted fields.");
      summaryRef.current?.focus();
      return;
    }
    if (files.busy) {
      setError("Your files are still uploading. Please wait a moment.");
      return;
    }
    if (files.failed) {
      setError("One of your files didn't upload. Retry it or remove it, then send.");
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setError(null);
    const res = await submitRequestAction({
      requestType: kind,
      subject: values.subject,
      ...(kind === "issue" ? { issue: { happened: values.happened, expected: values.expected || undefined, steps: values.steps || undefined } } : { message: values.message }),
      category: values.category,
      affectedFeature: (values.feature || undefined) as never,
      clientUrgency: kind === "issue" ? ((values.urgency || undefined) as ClientUrgency | undefined) : undefined,
      pageContext: fromPath ?? undefined,
      // A change about a project, or a request opened from a project's page, is filed against that project; the server checks it is this workspace's.
      projectId: kind === "change" ? (isProjectChange ? values.projectId : undefined) : aboutProject?.id,
      asChangeOrder: kind === "change" && isProjectChange && values.asChange && pickedProject?.canFileAsChange ? true : undefined,
      idempotencyKey: keyRef.current,
      attachmentIds: files.ids,
      shareDiagnostics: kind === "issue" && values.includeDiagnostics,
      diagnostics: kind === "issue" && values.includeDiagnostics ? diagnostics : undefined,
    });
    setSubmitting(false);
    lock.current = false;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    store.write(storageKey, null);
    setSent({ id: res.data.id, ref: res.data.ref, status: res.data.status, existing: res.data.existing, expectation: res.data.expectation, changeOrderRef: res.data.changeOrderRef ?? null });
  };

  const another = () => {
    keyRef.current = newIdempotencyKey();
    setValues({ ...EMPTY, category: initialCategory, projectId: aboutProject?.id ?? "" });
    setTouched({});
    setSent(null);
    setError(null);
    setImproved(null);
    setRestored(false);
    setCategoryChosen(false);
    setFiles({ ids: [], busy: false, failed: false });
    setPickerKey((k) => k + 1);
  };

  if (sent) {
    return (
      <Card className="relative overflow-hidden p-6 sm:p-8" role="status" aria-live="polite">
        <div className="flex flex-col items-center text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-success-soft text-success-ink ring-1 ring-inset ring-success/20" aria-hidden><CheckCircle2 className="size-7" /></span>
          <h2 className="mt-5 text-[22px] font-semibold tracking-tight text-ink">{sent.existing ? "That request was already sent" : copy.sentTitle}</h2>
          <p className="mt-2 max-w-md text-[14px] leading-relaxed text-muted">{sent.existing ? "We found the request you just sent, so nothing was duplicated." : copy.sentBody}</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            <span className="rounded-lg bg-surface-2 px-2.5 py-1 font-mono text-[13px] font-semibold text-ink ring-1 ring-inset ring-line">{sent.ref}</span>
            <StatusPill status={sent.status} tone="primary">{statusLabelForClient(sent.status, kind, kind === "feedback" ? "received" : null)}</StatusPill>
          </div>
          {sent.changeOrderRef && <p className="mt-4 max-w-md text-[13px] text-ink-2">It is also on the project&apos;s Change requests list as <strong className="font-medium text-ink">{sent.changeOrderRef}</strong>. The team decides how to answer it; nothing is done or charged yet.</p>}
          {sent.expectation && <p className="mt-4 max-w-md text-[13px] text-ink-2">{sent.expectation}</p>}
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
            <ButtonLink href={`/support/${sent.id}`} variant="brand">View your request <ArrowRight className="size-4" aria-hidden /></ButtonLink>
            <Button type="button" variant="secondary" onClick={another}>{kind === "feedback" ? "Send more feedback" : kind === "issue" ? "Report another issue" : kind === "change" ? "Request another change" : "Ask something else"}</Button>
          </div>
        </div>
      </Card>
    );
  }

  const invalidCount = Object.keys(errors).length;
  const categorySuggestionVisible = suggestion && suggestion.requestType === kind && suggestion.category !== values.category && !categoryChosen && (categories as readonly string[]).includes(suggestion.category);
  const otherPage = suggestion && suggestion.requestType !== kind && suggestion.requestType !== "support" ? (suggestion.requestType === "issue" ? { href: "/support/report-issue", label: "Report an issue" } : { href: "/support/feedback", label: "Provide feedback" }) : null;

  return (
    <form onSubmit={submit} noValidate aria-describedby={`${formId}-privacy`} className="space-y-5">
      {restored && (
        <Notice tone="primary" icon={<Info />} role="status">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">We restored your unsent draft from this browser.
            <button type="button" className="font-medium text-primary-ink underline-offset-2 hover:underline" onClick={another}>Start over</button>
          </span>
        </Notice>
      )}

      {error && (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/25 bg-danger-soft p-3.5 text-[13.5px] leading-relaxed text-danger-ink outline-none">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{error}</p>
            {!submitting && <p className="mt-0.5 text-[12.5px] opacity-90">Nothing was lost. Your answers are still here, and sending again won&apos;t create a duplicate.</p>}
          </div>
          <button type="button" className="-m-1 rounded-lg p-1.5 hover:bg-danger/10" aria-label="Dismiss message" onClick={() => setError(null)}><X className="size-4" /></button>
        </div>
      )}

      <Card className="space-y-5 p-5 sm:p-6">
        <Field label={copy.subjectLabel} htmlFor={`${formId}-subject`} hint={copy.subjectHint} error={show("subject")}>
          <Input id={`${formId}-subject`} value={values.subject} maxLength={160} placeholder={copy.subjectPlaceholder} autoComplete="off" aria-invalid={Boolean(show("subject"))} aria-required="true"
            onChange={(e) => set("subject", e.target.value)} onBlur={() => setTouched((t) => ({ ...t, subject: true }))} />
        </Field>

        {similar.length > 0 && (
          <Notice tone="warning" icon={<Lightbulb />} title="You may already have a request about this" role="status">
            <ul className="mt-1 space-y-1">
              {similar.map((s) => (
                <li key={s.id}>
                  <Link href={`/support/${s.id}`} className="inline-flex flex-wrap items-center gap-x-2 font-medium text-primary-ink hover:underline">
                    <span className="font-mono text-[12px]">{s.ref}</span> {s.subject}
                    <span className="text-[12px] font-normal text-muted">({statusLabelForClient(s.status)})</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[12.5px] text-muted">Following up there keeps everything in one place. You can still send a new request below.</p>
          </Notice>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={copy.categoryLabel} htmlFor={`${formId}-category`} hint={CATEGORY_LABELS[values.category]?.hint ?? copy.categoryHint}>
            <Select id={`${formId}-category`} value={values.category} onChange={(e) => { setCategoryChosen(true); set("category", e.target.value); }}>
              {categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
            </Select>
          </Field>
          <Field label={copy.featureLabel} htmlFor={`${formId}-feature`} optional>
            <Select id={`${formId}-feature`} value={values.feature} onChange={(e) => set("feature", e.target.value)}>
              <option value="">Not sure / not specific</option>
              {AFFECTED_FEATURES.map((f) => <option key={f} value={f}>{FEATURE_LABELS[f]}</option>)}
            </Select>
          </Field>
        </div>

        {kind === "change" && isProjectChange && change && (
          <div className="space-y-3 rounded-2xl border border-line bg-surface-2/40 p-4">
            <Field label="Which project?" htmlFor={`${formId}-project`} error={show("projectId")}>
              <Select id={`${formId}-project`} value={values.projectId} aria-invalid={Boolean(show("projectId"))} aria-required="true"
                onChange={(e) => { set("projectId", e.target.value); set("asChange", false); }} onBlur={() => setTouched((t) => ({ ...t, projectId: true }))}>
                <option value="">Choose a project…</option>
                {change.projects.map((p) => <option key={p.id} value={p.id}>{p.ref} · {p.title}</option>)}
              </Select>
            </Field>
            {change.projects.length === 0 && <p className="text-[12.5px] text-muted">You have no agreed custom project yet. A change can be asked for once a quote has been accepted.</p>}
            {pickedProject?.canFileAsChange ? (
              <label className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-[13px] leading-relaxed text-ink-2">
                <input type="checkbox" className="mt-1 size-4" checked={values.asChange} onChange={(e) => set("asChange", e.target.checked)} />
                <span><strong className="font-medium text-ink">This changes what we agreed</strong> (the scope, features or deliverables). It is added to the project&apos;s Change requests list, where the team says whether it is a revision your agreement includes or needs a quote. Nothing is charged until you accept a quote.</span>
              </label>
            ) : pickedProject ? (
              <p className="text-[12.5px] text-muted">This project can&apos;t take a change to its agreed scope right now{change.projects.length ? ", or your role can't ask for one" : ""}. Your request still goes to the team.</p>
            ) : null}
          </div>
        )}
        {kind !== "change" && aboutProject && (
          <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-ink-2" role="status"><Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />About the project <strong className="font-medium text-ink">{aboutProject.label}</strong>.</p>
        )}
        {kind === "change" && change?.allowanceNote && <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-2" role="status"><Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />{change.allowanceNote}</p>}

        {categorySuggestionVisible && (
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2" role="status">
            <Sparkles className="size-3.5 text-primary" aria-hidden /> This looks like <strong className="font-medium">{categoryLabel(suggestion!.category)}</strong>.
            <button type="button" className="font-medium text-primary-ink hover:underline" onClick={() => { set("category", suggestion!.category); setCategoryChosen(true); }}>Use this</button>
          </p>
        )}
        {otherPage && (
          <p className="text-[13px] text-ink-2" role="status">
            <Info className="mr-1.5 inline size-3.5 text-primary" aria-hidden />{suggestion!.reason}{" "}
            <Link href={otherPage.href} className="font-medium text-primary-ink hover:underline">Try &ldquo;{otherPage.label}&rdquo; instead</Link>
          </p>
        )}

        {kind === "issue" ? (
          <>
            <Field label={copy.messageLabel} htmlFor={`${formId}-happened`} hint={copy.messageHint} error={show("happened")}>
              <Textarea id={`${formId}-happened`} rows={4} value={values.happened} maxLength={3000} placeholder={copy.messagePlaceholder} aria-invalid={Boolean(show("happened"))} aria-required="true"
                onChange={(e) => set("happened", e.target.value)} onBlur={() => setTouched((t) => ({ ...t, happened: true }))} />
            </Field>
            <Field label="What did you expect to happen?" htmlFor={`${formId}-expected`} optional>
              <Textarea id={`${formId}-expected`} rows={2} value={values.expected} maxLength={1500} placeholder="For example: I expected to see my list of contacts." onChange={(e) => set("expected", e.target.value)} />
            </Field>
            <Field label="Steps to reproduce it" htmlFor={`${formId}-steps`} optional hint="If you know how to make it happen again, list what you did.">
              <Textarea id={`${formId}-steps`} rows={3} value={values.steps} maxLength={1500} placeholder={"1. Open Contacts\n2. Click Filters\n3. …"} onChange={(e) => set("steps", e.target.value)} />
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-[13px] font-medium text-ink-2">How much is this affecting you? <span className="ml-1 text-[12px] font-normal text-faint">Optional</span></legend>
              <div role="radiogroup" aria-label="How much is this affecting you" className="grid gap-2 sm:grid-cols-3">
                {CLIENT_URGENCIES.map((u) => {
                  const on = values.urgency === u;
                  return (
                    <button key={u} type="button" role="radio" aria-checked={on} onClick={() => set("urgency", on ? "" : u)}
                      className={cn("rounded-xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", on ? "border-primary/50 bg-primary-soft ring-2 ring-primary/15" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2/60")}>
                      <span className="block text-[13.5px] font-medium text-ink">{CLIENT_URGENCY_LABELS[u].label}</span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-muted">{CLIENT_URGENCY_LABELS[u].hint}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[12px] text-muted">This helps us understand the impact. The team decides how to prioritise.</p>
            </fieldset>
          </>
        ) : (
          <Field
            label={copy.messageLabel} htmlFor={`${formId}-message`} error={show("message")}
            hint={<span className="flex items-center justify-between gap-3"><span>{copy.messageHint}</span><span className="shrink-0 tabular-nums text-faint">{values.message.length.toLocaleString("en-US")} / {MESSAGE_MAX.toLocaleString("en-US")}</span></span>}
          >
            <Textarea id={`${formId}-message`} rows={6} value={values.message} maxLength={MESSAGE_MAX} placeholder={copy.messagePlaceholder} aria-invalid={Boolean(show("message"))} aria-required="true"
              onChange={(e) => set("message", e.target.value)} onBlur={() => setTouched((t) => ({ ...t, message: true }))} />
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="button" variant="soft" size="sm" onClick={() => void improve()} disabled={improving || body.trim().length < 10}>
            {improving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />} Help me say this more clearly
          </Button>
          <span className="text-[12px] text-muted">Optional. You decide whether to use the suggestion.</span>
        </div>
        {improving && <p role="status" className="text-[12.5px] text-muted">Looking at your draft…</p>}
        {improved && (
          <div className="rounded-2xl border border-primary/20 bg-primary-soft/40 p-4" role="region" aria-label="Suggestion">
            {"reason" in improved ? (
              <p className="text-[13px] text-ink-2">{improved.reason}</p>
            ) : (
              <>
                <p className="text-[12px] font-semibold uppercase tracking-wide text-primary-ink">Suggested wording</p>
                <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{improved.text}</p>
                {improved.questions.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[12.5px] font-medium text-ink-2">Adding answers to these could help us resolve it faster:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-ink-2">{improved.questions.map((q) => <li key={q}>{q}</li>)}</ul>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="brand" onClick={() => { set(kind === "issue" ? "happened" : "message", improved.text); setImproved(null); }}>Use this wording</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setImproved(null)}>No thanks</Button>
                </div>
              </>
            )}
            {"reason" in improved && <div className="mt-2"><Button type="button" size="sm" variant="ghost" onClick={() => setImproved(null)}>Dismiss</Button></div>}
          </div>
        )}

        {articles.length > 0 && (
          <Notice tone="neutral" icon={<Lightbulb />} title="These help pages might answer this right away" role="status">
            <ul className="mt-1 space-y-0.5">{articles.map((a) => <li key={a.id}><Link href={a.href!} className="font-medium text-primary-ink hover:underline">{a.title}</Link></li>)}</ul>
          </Notice>
        )}
      </Card>

      <Card className="space-y-4 p-5 sm:p-6">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{kind === "issue" ? "Screenshots or files" : "Attachments"} <span className="ml-1 text-[12px] font-normal text-faint">Optional</span></h2>
          <p className="mt-1 text-[13px] text-muted">{kind === "issue" ? "A screenshot of what you're seeing often saves a round of questions." : "Add anything that helps us understand."}</p>
        </div>
        <AttachmentPicker key={pickerKey} maxMb={maxMb} maxFiles={maxFiles} onChange={setFiles} disabled={submitting} />
      </Card>

      {kind === "issue" && (
        <Card className="space-y-4 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">Include technical details</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">Share a few facts about your browser and the page you were on so the team can reproduce the problem. You can see exactly what would be attached.</p>
            </div>
            <Switch checked={values.includeDiagnostics} onCheckedChange={(on) => set("includeDiagnostics", on)} aria-label="Include technical details" />
          </div>
          {values.includeDiagnostics && (
            <div className="space-y-3">
              <Field label="Error reference" htmlFor={`${formId}-ref`} optional error={show("errorReference")} hint="If a message on screen showed a reference or code, you can paste it here.">
                <Input id={`${formId}-ref`} value={values.errorReference} maxLength={64} placeholder="For example: err_9f3a21" autoComplete="off" onChange={(e) => set("errorReference", e.target.value)} onBlur={() => setTouched((t) => ({ ...t, errorReference: true }))} />
              </Field>
              <div className="rounded-2xl border border-line bg-surface-2/60 p-4" role="region" aria-label="What will be attached">
                <p className="flex items-center gap-2 text-[12.5px] font-semibold text-ink"><ShieldCheck className="size-4 text-success-ink" aria-hidden /> This is everything that will be attached</p>
                <dl className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-[auto_minmax(0,1fr)] text-[13px]">
                  {describeDiagnostics(diagnostics ?? {}).map((row) => (
                    <React.Fragment key={row.label}>
                      <dt className="text-muted">{row.label}</dt>
                      <dd className="min-w-0 break-words font-medium text-ink">{row.value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                <p className="mt-3 text-[12px] leading-relaxed text-muted">We never attach passwords, access keys, your records or your conversations. Turn this off and none of it is sent.</p>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card className="p-5 sm:p-6">
        {expectation && <p className="mb-4 flex items-start gap-2 text-[13px] text-ink-2"><Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />{expectation}</p>}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p id={`${formId}-privacy`} className="flex max-w-md items-start gap-2 text-[12.5px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> Please don&apos;t include passwords, API keys or payment details. Your workspace and name are added for you.</p>
          <Button type="submit" variant="brand" size="lg" loading={submitting} disabled={submitting || files.busy} className="w-full sm:w-auto">
            {!submitting && <Send className="size-4" aria-hidden />} {submitting ? "Sending…" : files.busy ? "Uploading files…" : copy.submit}
          </Button>
        </div>
        {invalidCount > 0 && Object.keys(touched).length > 0 && <p className="mt-3 text-[12.5px] text-danger-ink" role="status">{invalidCount} thing{invalidCount === 1 ? "" : "s"} to fill in before sending.</p>}
      </Card>
    </form>
  );
}
