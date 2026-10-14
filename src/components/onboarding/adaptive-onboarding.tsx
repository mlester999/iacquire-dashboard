"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, Cloud, CloudOff, Globe, Info, LifeBuoy, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { openHelp } from "@/components/help/help-widget";
import { QuestionInput, type DocumentSummary } from "@/components/onboarding/question-inputs";
import { ReviewPanel } from "@/components/onboarding/review-panel";
import { useOnboardingApi } from "@/components/onboarding/onboarding-api";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import {
  computeProgress,
  describeValue,
  effectiveAnswers,
  isEmptyValue,
  neighbour,
  questionState,
  validateAnswer,
  visibleQuestions,
  type ReviewModel,
} from "@/lib/onboarding/engine";
import { createSavePipeline, type PipelineState, type SavePipeline } from "@/lib/onboarding/save-pipeline";
import { ONBOARDING_SECTIONS, type AnswerSource, type AnswerValue, type QuestionDef, type SectionId, type StoredAnswers } from "@/lib/onboarding/types";
import type { OnboardingSession, Suggestion, WebsiteAnalysisSummary } from "@/server/onboarding/service";
import type { AssetView } from "@/server/assets/service";
import { cn } from "@/lib/utils";

type SiteSuggestion = WebsiteAnalysisSummary["suggestions"][number];

export function AdaptiveOnboarding({
  session,
  assets: initialAssets,
  documents: initialDocuments,
  onSubmitted,
  onExit,
}: {
  session: OnboardingSession;
  assets: AssetView[];
  documents: DocumentSummary[];
  /** Where to go after a successful approval. Defaults to the Setup Center. */
  onSubmitted?: () => void;
  /** Where "Save & exit" goes. Defaults to the dashboard (or the Setup Center once submitted). */
  onExit?: () => void;
}) {
  const router = useRouter();
  const api = useOnboardingApi();
  const reduced = useReducedMotion();
  const [answers, setAnswers] = React.useState<StoredAnswers>(session.answers);
  const [currentId, setCurrentId] = React.useState(session.currentQuestionId);
  const [direction, setDirection] = React.useState(1);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [save, setSave] = React.useState<PipelineState>({ status: "idle", error: null, savedAt: null, rejected: {}, staleBase: false });
  const [navigating, setNavigating] = React.useState(false);
  const [assets, setAssets] = React.useState(initialAssets);
  const [documents, setDocuments] = React.useState(initialDocuments);
  const [returnToReview, setReturnToReview] = React.useState(false);

  const [review, setReview] = React.useState<ReviewModel | null>(null);
  const [reviewError, setReviewError] = React.useState<string | null>(null);
  const [reviewNonce, setReviewNonce] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);

  const [assistBusy, setAssistBusy] = React.useState<string | null>(null);
  const [suggestion, setSuggestion] = React.useState<Suggestion | null>(null);
  const [assistError, setAssistError] = React.useState<{ id: string; message: string } | null>(null);
  const [siteBusy, setSiteBusy] = React.useState(false);
  const [siteSuggestions, setSiteSuggestions] = React.useState<SiteSuggestion[]>(session.websiteAnalysis?.suggestions ?? []);
  const [siteRead, setSiteRead] = React.useState<{ origin: string } | null>(session.websiteAnalysis ? { origin: session.websiteAnalysis.origin } : null);

  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const pipelineRef = React.useRef<SavePipeline | null>(null);
  const [pipeline] = React.useState(() =>
    createSavePipeline({
      baseRevision: session.revision,
      onChange: setSave,
      save: (payload) => api.save(payload),
    }),
  );
  React.useEffect(() => {
    pipelineRef.current = pipeline;
    return () => pipeline.dispose();
  }, [pipeline]);

  // Warn before leaving with changes the server has not confirmed.
  React.useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pipelineRef.current?.hasUnsaved()) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const effective = React.useMemo(() => effectiveAnswers(answers), [answers]);
  const visible = React.useMemo(() => visibleQuestions(effective), [effective]);
  const progress = React.useMemo(() => computeProgress(answers), [answers]);
  const question: QuestionDef = visible.find((q) => q.id === currentId) ?? QUESTION_BY_ID[currentId] ?? visible[0];
  const isReview = question.kind.type === "review";
  const stored = answers[question.id];
  const section = ONBOARDING_SECTIONS.find((s) => s.id === question.section)!;
  const countable = visible.filter((q) => q.kind.type !== "review");
  const number = Math.max(1, countable.findIndex((q) => q.id === question.id) + 1);

  // Move focus to the new question so keyboard and screen-reader users land in the right place.
  React.useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [question.id]);

  // Load the review from the server whenever the review card is shown; it reads real connection state.
  React.useEffect(() => {
    if (!isReview) return;
    let live = true;
    void api.review().then((res) => {
      if (!live) return;
      if (res.ok) {
        setReview(res.data);
        setReviewError(null);
      } else setReviewError(res.error);
    });
    return () => {
      live = false;
    };
  }, [isReview, reviewNonce, api]);

  // ---------------------------------------------------------------- answers
  const commit = (q: QuestionDef, value: AnswerValue, opts: { source?: Exclude<AnswerSource, "prefill">; confirmed?: boolean } = {}) => {
    const prev = answers[q.id];
    const inherited: Exclude<AnswerSource, "prefill"> = prev && !prev.skipped && (prev.source === "ai_suggestion" || prev.source === "website_analysis") ? prev.source : "user";
    const source = opts.source ?? inherited;
    const needsConfirmation = Boolean(q.sensitive) && source !== "user" && (opts.source !== undefined ? !opts.confirmed : opts.confirmed === true ? false : Boolean(prev?.needsConfirmation));
    setAnswers((cur) => ({ ...cur, [q.id]: { value, skipped: false, source, needsConfirmation, updatedAt: new Date().toISOString() } }));
    setErrors((cur) => {
      const { [q.id]: _gone, ...rest } = cur;
      void _gone;
      return rest;
    });
    const check = validateAnswer(q, value, { ...effective, [q.id]: value });
    // Half-typed values (an incomplete email, say) stay local; only valid answers are sent to the server.
    if (check.ok) pipeline.queue(q.id, { value, source, confirmed: !needsConfirmation });
  };

  const confirmSuggestion = () => {
    if (!stored) return;
    setAnswers((cur) => ({ ...cur, [question.id]: { ...cur[question.id], needsConfirmation: false } }));
    pipeline.queue(question.id, { value: stored.value, source: stored.source === "prefill" ? "user" : stored.source, confirmed: true });
  };

  const problem = (q: QuestionDef, a = answers[q.id]): string | null => {
    if (q.kind.type === "review") return null;
    const empty = !a || a.skipped || isEmptyValue(a.value);
    if (empty) return q.required ? "This one is required." : null;
    const check = validateAnswer(q, a.value, effective);
    if (!check.ok) return check.error;
    if (a.needsConfirmation) return "Check this suggestion, then press “I’ve checked this” (or edit it first).";
    return null;
  };

  const validateCurrent = () => {
    const message = problem(question);
    setErrors((cur) => (message ? { ...cur, [question.id]: message } : (({ [question.id]: _x, ...rest }) => (void _x, rest))(cur)));
    return message === null;
  };

  // ------------------------------------------------------------- navigation
  const travel = async (targetId: string, dir: 1 | -1, options: { skipCurrent?: boolean } = {}) => {
    if (navigating) return;
    setNavigating(true);
    pipeline.setPosition(targetId);
    const ok = await pipeline.flush();
    setNavigating(false);
    if (!ok) {
      toast.error("We couldn't save your progress, so we haven't moved on. Check your connection and try again.");
      return;
    }
    void options;
    setDirection(dir);
    setCurrentId(targetId);
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  };

  const next = async () => {
    if (!validateCurrent()) return;
    const target = returnToReview ? "f.review" : neighbour(answers, question.id, 1);
    if (!target) return;
    if (returnToReview && target === "f.review") setReviewNonce((n) => n + 1);
    await travel(target, 1);
    if (returnToReview) setReturnToReview(false);
  };

  const back = async () => {
    const target = neighbour(answers, question.id, -1);
    if (target) await travel(target, -1);
  };

  const skip = async () => {
    if (question.required) return;
    setAnswers((cur) => ({ ...cur, [question.id]: { value: null, skipped: true, source: "user", needsConfirmation: false, updatedAt: new Date().toISOString() } }));
    pipeline.queue(question.id, { skipped: true });
    const target = returnToReview ? "f.review" : neighbour(answers, question.id, 1);
    if (target) await travel(target, 1);
  };

  const saveAndExit = async () => {
    if (navigating) return;
    setNavigating(true);
    pipeline.setPosition(question.id);
    const ok = await pipeline.flush();
    setNavigating(false);
    if (!ok) {
      toast.error("Your latest changes haven't been saved yet. Try again before leaving.");
      return;
    }
    toast.success("Progress saved. You can pick up exactly here, on any device.");
    (onExit ?? (() => router.push(session.status === "submitted" ? "/setup" : "/overview")))();
  };

  const jumpToSection = async (id: SectionId) => {
    if (id === "F") return travel("f.review", 1);
    const inSection = visible.filter((q) => q.section === id);
    const first = inSection.find((q) => questionState(q, answers[q.id]) === "outstanding" && q.required) ?? inSection.find((q) => !answers[q.id]) ?? inSection[0];
    if (first) await travel(first.id, first.section >= question.section ? 1 : -1);
  };

  const editFromReview = async (questionId: string) => {
    setReturnToReview(true);
    await travel(questionId, -1);
  };

  // --------------------------------------------------------------------- AI
  const suggest = async () => {
    setAssistBusy(question.id);
    setAssistError(null);
    setSuggestion(null);
    await pipeline.flush(); // the assistant reads saved answers
    const res = await api.suggest(question.id);
    setAssistBusy(null);
    if (res.ok) setSuggestion(res.data);
    else setAssistError({ id: question.id, message: res.error });
  };

  const acceptSuggestion = (s: { questionId: string; value: AnswerValue; source: Exclude<AnswerSource, "prefill"> }) => {
    const q = QUESTION_BY_ID[s.questionId];
    if (!q) return;
    commit(q, s.value, { source: s.source });
    setSuggestion(null);
    setSiteSuggestions((cur) => cur.filter((x) => x.questionId !== s.questionId));
  };

  const readSite = async () => {
    const url = typeof effective["a.website"] === "string" ? (effective["a.website"] as string) : "";
    if (!url) return;
    setSiteBusy(true);
    await pipeline.flush();
    const res = await api.readWebsite(url);
    setSiteBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setSiteSuggestions(res.data.suggestions);
    setSiteRead({ origin: res.data.origin });
    toast.success(res.data.suggestions.length ? `Found ${res.data.suggestions.length} suggestion${res.data.suggestions.length === 1 ? "" : "s"}. You'll see them on the matching questions.` : "Read your website. Nothing to suggest yet.");
  };

  // ----------------------------------------------------------------- submit
  const approve = async (value: boolean) => {
    setAnswers((cur) => ({ ...cur, "f.review": { value, skipped: false, source: "user", needsConfirmation: false, updatedAt: new Date().toISOString() } }));
    pipeline.queue("f.review", { value });
  };

  const submit = async () => {
    setSubmitting(true);
    setReviewError(null);
    pipeline.queue("f.review", { value: true });
    if (!(await pipeline.flush())) {
      setSubmitting(false);
      setReviewError("Your approval couldn't be saved. Please try again.");
      return;
    }
    const res = await api.submit();
    if (!res.ok) {
      setSubmitting(false);
      setReviewError(res.error);
      return;
    }
    toast.success("Your AI team is being prepared.");
    // Stay in the "submitting" state while the page navigates away.
    (onSubmitted ?? (() => router.push("/setup?onboarded=1")))();
  };

  // ------------------------------------------------------------------ render
  const siteForQuestion = siteSuggestions.find((s) => s.questionId === question.id && (!stored || stored.skipped || isEmptyValue(stored.value)));
  const showSuggestion = suggestion && suggestion.questionId === question.id ? suggestion : null;
  const fieldError = errors[question.id] ?? save.rejected[question.id] ?? null;
  const websiteValue = typeof effective["a.website"] === "string" ? (effective["a.website"] as string) : "";
  const aiSourced = stored && !stored.skipped && (stored.source === "ai_suggestion" || stored.source === "website_analysis") && !isEmptyValue(stored.value);

  return (
    <main className="mx-auto max-w-6xl px-4 pb-20 pt-2 sm:px-6">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[272px_minmax(0,1fr)] lg:gap-10">
        <aside aria-label="Setup sections" className="min-w-0 self-start rounded-[24px] bg-[#11192c] p-5 text-white lg:sticky lg:top-6 lg:p-6">
          <p className="text-[10px] font-semibold uppercase tracking-[.18em] text-blue-200">Built around you</p>
          <h2 className="mt-2 text-[22px] font-semibold leading-tight tracking-tight lg:mt-3 lg:text-[25px]">
            Let&apos;s make this
            <br className="hidden lg:block" /> your workspace.
          </h2>
          <p className="mt-2 hidden text-[13px] leading-relaxed text-slate-300 lg:block">One question at a time. We save as you go, and you can stop and pick up anywhere.</p>
          <ol className="-mx-1 mt-4 flex gap-1 overflow-x-auto px-1 pb-1 lg:mt-6 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0">
            {ONBOARDING_SECTIONS.map((s) => {
              const p = progress.sections.find((x) => x.id === s.id);
              const active = s.id === question.section;
              const complete = p ? p.total > 0 && p.done === p.total && p.requiredOutstanding === 0 : false;
              return (
                <li key={s.id} className="shrink-0 lg:shrink">
                  <button
                    type="button"
                    onClick={() => void jumpToSection(s.id)}
                    disabled={navigating}
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[13px] transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300",
                      active ? "bg-white/10 font-medium text-white" : "text-slate-300 hover:bg-white/5",
                    )}
                  >
                    <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold", active ? "border-blue-300 bg-blue-400/20" : complete ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-200" : "border-white/20")}>
                      {complete && !active ? <Check className="size-3" aria-hidden /> : s.id}
                    </span>
                    <span className="whitespace-nowrap lg:whitespace-normal">
                      {s.short}
                      {s.id !== "F" && p && p.total > 0 && (
                        <span className="ml-2 hidden text-[11px] text-slate-400 lg:inline">
                          {p.done}/{p.total}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <button type="button" onClick={() => openHelp("chat")} className="mt-5 hidden items-center gap-2 text-[12px] text-blue-200 hover:text-white lg:flex">
            <LifeBuoy className="size-4" aria-hidden /> A little help from iAcquire
          </button>
        </aside>

        <div className="min-w-0">
          {session.status === "submitted" && (
            <p className="mb-4 rounded-xl border border-primary/25 bg-primary-soft/50 p-3.5 text-[13px] leading-relaxed text-ink-2">
              <Info className="mr-1.5 inline size-4 align-text-bottom text-primary" aria-hidden />
              Your setup is already approved. You can edit any answer; changes are saved as a draft and only reach your AI employees when you approve again at the end.
            </p>
          )}

          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[12.5px]">
            <span className="font-medium text-muted">{isReview ? "Final step" : `Question ${number} of ${countable.length}`}</span>
            <SaveBadge state={save} onRetry={() => void pipeline.flush()} />
          </div>
          <div className="mb-5 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
            <motion.div initial={false} animate={{ width: `${Math.max(3, progress.percent)}%` }} className="h-full rounded-full brand-gradient" transition={{ duration: reduced ? 0 : 0.4, ease: [0.16, 1, 0.3, 1] }} />
          </div>

          {save.staleBase && (
            <p role="status" className="mb-4 rounded-xl border border-warning/40 bg-warning-soft/60 p-3 text-[13px] text-warning-ink">
              This setup was also changed on another device or tab. Your answers have been merged. Reload to see everything.{" "}
              <button type="button" className="font-medium underline" onClick={() => router.refresh()}>
                Reload
              </button>
            </p>
          )}

          <motion.section
              key={question.id}
              initial={reduced ? false : { opacity: 0, y: direction * 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              aria-labelledby="onboarding-title"
              className="rounded-[24px] border border-line bg-surface p-5 shadow-card sm:p-8"
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!isReview) void next();
                }}
                noValidate
              >
                <header className="mb-6">
                  <p className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[.15em] text-primary">
                    <span>
                      {section.id} · {section.title}
                    </span>
                    {!isReview && <span className="text-muted">{question.required ? "Required" : "Optional"}</span>}
                  </p>
                  <h1 id="onboarding-title" ref={headingRef} tabIndex={-1} className="mt-3 text-[26px] font-semibold leading-tight tracking-[-0.03em] outline-none sm:text-[30px]">
                    {question.title}
                  </h1>
                  <p className="mt-3 text-[14.5px] leading-relaxed text-muted">{question.help}</p>
                  {question.example && !["choice", "multi", "yesno", "color", "files", "review", "hours", "list"].includes(question.kind.type) && (
                    <p className="mt-3 inline-block rounded-lg bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-2">
                      <span className="font-medium">Example:</span> {question.example}
                    </p>
                  )}
                </header>

                {isReview ? (
                  <ReviewPanel
                    review={review}
                    loading={!review && !reviewError}
                    error={reviewError}
                    confirmed={answers["f.review"]?.value === true}
                    submitting={submitting}
                    alreadySubmitted={session.status === "submitted"}
                    onRetry={() => {
                      setReviewError(null);
                      setReviewNonce((n) => n + 1);
                    }}
                    onEdit={(id) => void editFromReview(id)}
                    onConfirmChange={(v) => void approve(v)}
                    onSubmit={() => void submit()}
                  />
                ) : (
                  <fieldset disabled={navigating} className="m-0 min-w-0 space-y-4 border-0 p-0" onBlurCapture={() => void validateCurrent()}>
                    {aiSourced && (
                      <p className="flex items-center gap-2 text-[12.5px] text-violet-ink">
                        <Sparkles className="size-3.5" aria-hidden />
                        {stored.source === "website_analysis" ? "Suggested from your website" : "Suggested by the AI assistant"}. Please check it and edit anything that isn&apos;t right.
                      </p>
                    )}

                    <QuestionInput
                      q={question}
                      value={stored && !stored.skipped ? stored.value : undefined}
                      answers={effective}
                      error={fieldError}
                      onChange={(v) => commit(question, v)}
                      assets={assets}
                      onAssetsChange={setAssets}
                      documents={documents}
                      onDocumentsChange={setDocuments}
                      onFilesChange={(ids) => commit(question, ids)}
                    />

                    {fieldError && (
                      <p id="onboarding-input-error" role="alert" className="text-[13px] font-medium text-danger-ink">
                        {fieldError}
                      </p>
                    )}

                    {stored?.needsConfirmation && (
                      <div className="rounded-xl border border-warning/40 bg-warning-soft/60 p-4">
                        <p className="text-[13.5px] leading-relaxed text-warning-ink">
                          This came from {stored.source === "website_analysis" ? "your website" : "the AI assistant"} and is not treated as your approved wording until you confirm it. Edit it first if anything is wrong.
                        </p>
                        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={confirmSuggestion}>
                          <Check className="size-4" /> I&apos;ve checked this
                        </Button>
                      </div>
                    )}

                    {question.id === "a.website" && websiteValue && (
                      <div className="rounded-xl border border-line bg-surface-2/60 p-4">
                        <p className="flex items-center gap-2 text-[13px] font-medium">
                          <Globe className="size-4 text-primary" aria-hidden /> Want help filling in the rest?
                        </p>
                        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                          We can read the public pages of this website to suggest answers. We only read pages that allow it, never log in, and nothing we find is used until you accept it.
                        </p>
                        <Button type="button" variant="secondary" size="sm" className="mt-3" loading={siteBusy} onClick={() => void readSite()}>
                          {siteRead ? "Read it again" : "Read my website"}
                        </Button>
                        {siteRead && !siteBusy && (
                          <p className="mt-2 text-[12.5px] text-muted">
                            {siteSuggestions.length ? `${siteSuggestions.length} suggestion${siteSuggestions.length === 1 ? "" : "s"} ready; you'll see them on the matching questions.` : "Read it. There's nothing new to suggest."}
                          </p>
                        )}
                      </div>
                    )}

                    {siteForQuestion && !showSuggestion && (
                      <SuggestionCard
                        label="From your website"
                        preview={describeValue(question, siteForQuestion.value, effective)}
                        reason={siteForQuestion.evidence}
                        sensitive={Boolean(question.sensitive)}
                        onUse={() => acceptSuggestion({ questionId: question.id, value: siteForQuestion.value, source: "website_analysis" })}
                        onDismiss={() => setSiteSuggestions((cur) => cur.filter((x) => x.questionId !== question.id))}
                      />
                    )}

                    {showSuggestion && (
                      <SuggestionCard
                        label={showSuggestion.basis === "your_website" ? "AI suggestion, based on your website" : "AI suggestion, based on your answers"}
                        preview={describeValue(question, showSuggestion.value, effective)}
                        reason={showSuggestion.reason}
                        sensitive={showSuggestion.needsConfirmation}
                        onUse={() => acceptSuggestion({ questionId: question.id, value: showSuggestion.value, source: showSuggestion.source })}
                        onDismiss={() => setSuggestion(null)}
                      />
                    )}

                    {question.assist && (
                      <div>
                        <Button type="button" variant="soft" size="sm" loading={assistBusy === question.id} onClick={() => void suggest()}>
                          <Sparkles className="size-4" /> {showSuggestion ? "Suggest another" : "Suggest with AI"}
                        </Button>
                        {assistError?.id === question.id && (
                          <p role="status" className="mt-2 text-[12.5px] leading-relaxed text-muted">
                            {assistError.message}
                          </p>
                        )}
                        <p className="mt-2 text-[12px] text-faint">Optional. Suggestions are labelled, editable, and never treated as approved policy until you confirm them.</p>
                      </div>
                    )}
                  </fieldset>
                )}
              </form>
          </motion.section>

          {!isReview && (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="ghost" onClick={() => void back()} disabled={navigating || !neighbour(answers, question.id, -1)}>
                <ArrowLeft className="size-4" /> Back
              </Button>
              <span className="flex-1" />
              <Button variant="ghost" onClick={() => void saveAndExit()} disabled={navigating}>
                Save &amp; exit
              </Button>
              {!question.required && (
                <Button variant="ghost" onClick={() => void skip()} disabled={navigating}>
                  Skip for now
                </Button>
              )}
              <Button variant="brand" onClick={() => void next()} loading={navigating}>
                {returnToReview ? "Back to review" : "Next"} <ArrowRight className="size-4" />
              </Button>
            </div>
          )}
          {isReview && (
            <div className="mt-5 flex items-center gap-3">
              <Button variant="ghost" onClick={() => void back()} disabled={navigating || submitting}>
                <ArrowLeft className="size-4" /> Back
              </Button>
              <span className="flex-1" />
              <Button variant="ghost" onClick={() => void saveAndExit()} disabled={navigating || submitting}>
                Save &amp; exit
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function SaveBadge({ state, onRetry }: { state: PipelineState; onRetry: () => void }) {
  return (
    <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-muted">
      {state.status === "saving" ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
        </>
      ) : state.status === "dirty" ? (
        <>
          <Cloud className="size-3.5" aria-hidden /> Unsaved changes…
        </>
      ) : state.status === "error" ? (
        <>
          <CloudOff className="size-3.5 text-danger-ink" aria-hidden />
          <span className="text-danger-ink">{Object.keys(state.rejected).length ? "Some answers need attention" : "Not saved"}</span>
          {Object.keys(state.rejected).length === 0 && (
            <button type="button" onClick={onRetry} className="font-medium text-danger-ink underline underline-offset-2">
              Retry
            </button>
          )}
        </>
      ) : state.status === "saved" ? (
        <>
          <Cloud className="size-3.5 text-success" aria-hidden /> Saved
        </>
      ) : (
        <>
          <Cloud className="size-3.5" aria-hidden /> Saved as you go
        </>
      )}
    </span>
  );
}

function SuggestionCard({ label, preview, reason, sensitive, onUse, onDismiss }: { label: string; preview: string; reason: string; sensitive: boolean; onUse: () => void; onDismiss: () => void }) {
  return (
    <div className="rounded-xl border border-violet/30 bg-violet-soft/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <Badge tone="violet">
          <Sparkles className="size-3" aria-hidden /> {label}
        </Badge>
        <button type="button" onClick={onDismiss} aria-label="Dismiss suggestion" className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink">
          <X className="size-4" />
        </button>
      </div>
      <p className="mt-3 max-h-56 overflow-auto whitespace-pre-line text-[14px] leading-relaxed text-ink">{preview}</p>
      {reason && <p className="mt-2 text-[12.5px] text-muted">{reason}</p>}
      <p className="mt-2 text-[12.5px] text-muted">Not verified. {sensitive ? "You'll be asked to confirm it before it can be used." : "Edit it freely after adding."}</p>
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onUse}>
          Use this answer
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          No thanks
        </Button>
      </div>
    </div>
  );
}
