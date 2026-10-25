"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, Cloud, CloudOff, Globe, Info, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuestionInput, type DocumentSummary } from "@/components/onboarding/question-inputs";
import { ReviewPanel } from "@/components/onboarding/review-panel";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import { SuggestionCard } from "@/components/onboarding/suggestion-card";
import { useOnboardingApi } from "@/components/onboarding/onboarding-api";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import {
  computeProgress,
  effectiveAnswers,
  isEmptyValue,
  neighbour,
  questionState,
  validateAnswer,
  visibleQuestions,
  type ReviewModel,
} from "@/lib/onboarding/engine";
import { createSavePipeline, type PipelineState, type SavePipeline } from "@/lib/onboarding/save-pipeline";
import { schedulingDraftMessage } from "@/lib/onboarding/scheduling-drafts";
import { type AnswerSource, type AnswerValue, type QuestionDef, type SectionId, type StoredAnswers } from "@/lib/onboarding/types";
import type { OnboardingSession, Suggestion, WebsiteAnalysisSummary } from "@/server/onboarding/service";
import type { AssetView } from "@/server/assets/service";

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
  const actionLock = React.useRef(false);
  const assistController = React.useRef<AbortController | null>(null);
  const assistSequence = React.useRef(0);
  const clarificationRef = React.useRef<Record<string, Record<string, string>>>({});
  const [suggestionVersion, setSuggestionVersion] = React.useState(0);
  const headerSlot = React.useSyncExternalStore(() => () => {}, () => document.getElementById("onboarding-header-actions"), () => null);

  // Safari can leave the layout viewport behind the keyboard; Android usually resizes it.
  React.useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      document.documentElement.style.setProperty("--onboarding-keyboard-inset", `${inset}px`);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--onboarding-keyboard-inset");
    };
  }, []);
  React.useEffect(() => () => { assistSequence.current += 1; assistController.current?.abort(); }, []);

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
    assistSequence.current += 1;
    assistController.current?.abort();
    setAssistBusy(null);
    setSuggestion(null);
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
    else pipeline.invalidate(q.id, check.error);
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
    if (actionLock.current) return;
    actionLock.current = true;
    assistSequence.current += 1;
    assistController.current?.abort();
    setAssistBusy(null);
    setNavigating(true);
    pipeline.setPosition(targetId);
    const ok = await pipeline.flush();
    actionLock.current = false;
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
    if (question.required || actionLock.current) return;
    setAnswers((cur) => ({ ...cur, [question.id]: { value: null, skipped: true, source: "user", needsConfirmation: false, updatedAt: new Date().toISOString() } }));
    pipeline.queue(question.id, { skipped: true });
    const target = returnToReview ? "f.review" : neighbour(answers, question.id, 1);
    if (target) await travel(target, 1);
  };

  const saveAndExit = async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setNavigating(true);
    pipeline.setPosition(question.id);
    const ok = await pipeline.flush();
    actionLock.current = false;
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
  const suggest = async (regenerate = false, details?: Record<string, string>) => {
    if (assistController.current && !assistController.current.signal.aborted) return;
    const id = question.id;
    const seq = ++assistSequence.current;
    const controller = new AbortController();
    assistController.current?.abort();
    assistController.current = controller;
    setAssistBusy(question.id);
    setAssistError(null);
    if (details) clarificationRef.current[id] = { ...clarificationRef.current[id], ...details };
    try {
      if (!(await pipeline.flush())) {
        if (seq === assistSequence.current) setAssistError({ id, message: "Save or correct your latest edits before requesting a suggestion." });
        return;
      }
      const res = await api.suggest(id, { regenerate, clarifications: clarificationRef.current[id] ?? {} }, controller.signal);
      if (seq !== assistSequence.current || controller.signal.aborted) return;
      if (res.ok) { setSuggestion(res.data); setSuggestionVersion((version) => version + 1); }
      else setAssistError({ id, message: res.error });
    } catch {
      if (seq === assistSequence.current && !controller.signal.aborted) setAssistError({ id, message: "Writing assistance couldn't finish. Please try again." });
    } finally {
      if (seq === assistSequence.current) setAssistBusy(null);
      if (assistController.current === controller) assistController.current = null;
    }
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
    if (!(await pipeline.flush())) { setSiteBusy(false); toast.error("Save or correct your latest edits before reading the website."); return; }
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
    if (actionLock.current || answers["f.review"]?.value !== true) return;
    actionLock.current = true;
    setSubmitting(true);
    setReviewError(null);
    pipeline.queue("f.review", { value: true });
    if (!(await pipeline.flush())) {
      setSubmitting(false);
      actionLock.current = false;
      setReviewError("Your approval couldn't be saved. Please try again.");
      return;
    }
    let res: Awaited<ReturnType<typeof api.submit>>;
    try { res = await api.submit(); } catch {
      setSubmitting(false);
      actionLock.current = false;
      setReviewError("We couldn't submit your setup. Your answers are saved; please try again.");
      return;
    }
    if (!res.ok) {
      setSubmitting(false);
      actionLock.current = false;
      setReviewError(res.error);
      return;
    }
    // A draft booking calendar made from the answers is said out loud, with the fact that it is not live.
    const drafted = res.data.scheduling ? schedulingDraftMessage(res.data.scheduling) : null;
    if (drafted) toast.success("Your AI team is being prepared.", { description: drafted, duration: 12000 });
    else toast.success("Your AI team is being prepared.");
    // Stay in the "submitting" state while the page navigates away.
    (onSubmitted ?? (() => router.push("/setup?onboarded=1")))();
  };

  // ------------------------------------------------------------------ render
  const siteForQuestion = siteSuggestions.find((s) => s.questionId === question.id && (!stored || stored.skipped || isEmptyValue(stored.value)));
  const showSuggestion = suggestion && suggestion.questionId === question.id ? suggestion : null;
  const fieldError = errors[question.id] ?? save.rejected[question.id] ?? null;
  const websiteValue = typeof effective["a.website"] === "string" ? (effective["a.website"] as string) : "";
  const aiSourced = stored && !stored.skipped && (stored.source === "ai_suggestion" || stored.source === "website_analysis") && !isEmptyValue(stored.value);
  const exitAction = <Button type="button" variant="ghost" size="sm" onClick={() => void saveAndExit()} disabled={navigating || submitting}>Save &amp; exit</Button>;
  const canApprove = Boolean(review && answers["f.review"]?.value === true && !review.blockers.some((blocker) => !blocker.startsWith("Confirm that you approve")));

  return (
    <main className="onboarding-workspace mx-auto max-w-5xl px-4 pb-28 pt-2 sm:px-6 lg:pb-8">
      {headerSlot ? createPortal(exitAction, headerSlot) : <div className="mb-2 flex justify-end">{exitAction}</div>}
      <div className="space-y-4 sm:space-y-5">
        <OnboardingProgress
          current={question.section}
          progress={progress}
          welcome={number === 1 && !isReview}
          position={isReview ? "Final step" : `Question ${number} of ${countable.length}`}
          saveState={<SaveBadge state={save} onRetry={() => void pipeline.flush()} />}
          disabled={navigating || submitting}
          onSelect={(id) => void jumpToSection(id)}
        />

        <div className="min-w-0">
          {session.status === "submitted" && (
            <p className="mb-4 rounded-xl border border-primary/25 bg-primary-soft/50 p-3.5 text-[13px] leading-relaxed text-ink-2">
              <Info className="mr-1.5 inline size-4 align-text-bottom text-primary" aria-hidden />
              Your setup is already approved. You can edit any answer; changes are saved as a draft and only reach your AI employees when you approve again at the end.
            </p>
          )}

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
              className="rounded-2xl border border-line bg-surface p-4 sm:p-6"
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!isReview) void next();
                }}
                noValidate
              >
                <header className="mb-4">
                  {/* The section is named in the progress panel above; the card only says whether this question can be skipped. */}
                  {!isReview && <p className="mb-2 text-[12px] font-semibold uppercase tracking-[.15em] text-muted">{question.required ? "Required" : "Optional"}</p>}
                  <h1 id="onboarding-title" ref={headingRef} tabIndex={-1} className="text-[23px] font-semibold leading-tight tracking-[-0.025em] outline-none sm:text-[28px]">
                    {question.title}
                  </h1>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">{question.help}</p>
                  {question.example && !["choice", "multi", "yesno", "color", "files", "review", "hours", "list"].includes(question.kind.type) && (
                    <details className="mt-1 text-[12px] text-muted"><summary className="inline-flex min-h-11 cursor-pointer items-center text-primary-ink">See an example</summary><p className="pb-2 leading-relaxed">{question.example}</p></details>
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
                    hideSubmit
                  />
                ) : (
                  <fieldset disabled={navigating || submitting} className="m-0 min-w-0 space-y-3 border-0 p-0 [&_input]:text-base [&_select]:text-base [&_textarea]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm sm:[&_textarea]:text-sm" onBlurCapture={() => { if (pipeline.getState().rejected[question.id]) void validateCurrent(); }}>
                    {aiSourced && (
                      <p className="flex items-center gap-2 text-[12.5px] text-violet-ink">
                        <Sparkles className="size-3.5" aria-hidden />
                        {stored.source === "website_analysis" ? "Website draft added" : "AI draft added"}
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
                        <p className="text-[13px] leading-relaxed text-warning-ink">Review this wording before it can become approved policy.</p>
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
                        q={question}
                        answers={effective}
                        value={siteForQuestion.value}
                        website
                        reason={siteForQuestion.evidence}
                        onUse={(value) => acceptSuggestion({ questionId: question.id, value, source: "website_analysis" })}
                        onDismiss={() => setSiteSuggestions((cur) => cur.filter((x) => x.questionId !== question.id))}
                      />
                    )}

                    {showSuggestion && (
                      <SuggestionCard
                        key={`${question.id}:${suggestionVersion}`}
                        q={question}
                        answers={effective}
                        value={showSuggestion.value}
                        website={showSuggestion.basis === "your_website"}
                        reason={showSuggestion.reason}
                        limited={showSuggestion.limited}
                        clarifications={showSuggestion.clarifications}
                        busy={assistBusy === question.id}
                        onUse={(value) => acceptSuggestion({ questionId: question.id, value, source: showSuggestion.source })}
                        onRegenerate={(details) => void suggest(true, details)}
                        onDismiss={() => { assistSequence.current += 1; assistController.current?.abort(); assistController.current = null; setAssistBusy(null); setSuggestion(null); }}
                      />
                    )}

                    {question.assist && (
                      <div>
                        <div className="flex items-center gap-2">
                          {!showSuggestion && <Button type="button" variant="soft" size="sm" loading={assistBusy === question.id} onClick={() => void suggest()}><Sparkles className="size-4" aria-hidden />{assistBusy === question.id ? "Writing a draft…" : "Suggest with AI"}</Button>}
                          {assistBusy === question.id && <Button type="button" variant="ghost" size="sm" onClick={() => { assistSequence.current += 1; assistController.current?.abort(); assistController.current = null; setAssistBusy(null); }}>Cancel</Button>}
                        </div>
                        {assistError?.id === question.id && (
                          <p role="status" className="mt-2 text-[12.5px] leading-relaxed text-muted">
                            {assistError.message}
                          </p>
                        )}
                      </div>
                    )}
                  </fieldset>
                )}
              </form>
          </motion.section>

          {!isReview && !question.required && <div className="mt-2 flex justify-end"><Button type="button" variant="ghost" size="sm" disabled={navigating} onClick={() => void skip()}>Skip for now</Button></div>}
          <nav aria-label="Question navigation" className="onboarding-navigation mt-5 border-t border-line bg-surface">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <Button type="button" variant="secondary" onClick={() => void back()} disabled={navigating || submitting || !neighbour(answers, question.id, -1)} className="shrink-0">
                <ArrowLeft className="size-4" aria-hidden /> Back
              </Button>
              <Button type="button" variant="brand" onClick={() => void (isReview ? submit() : next())} loading={navigating || submitting} disabled={isReview && !canApprove} className="min-w-0 max-w-[70%]">
                <span className="truncate">{isReview ? (session.status === "submitted" ? "Approve update" : "Approve setup") : returnToReview ? "Back to review" : "Continue"}</span>
                {!isReview && <ArrowRight className="size-4 shrink-0" aria-hidden />}
              </Button>
            </div>
          </nav>
        </div>
      </div>
    </main>
  );
}

/** Sits on the navy progress panel, so it uses that panel's colours rather than the theme tokens. */
function SaveBadge({ state, onRetry }: { state: PipelineState; onRetry: () => void }) {
  return (
    <span role="status" aria-live="polite" className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--stage-muted)] lg:text-[12px]">
      {state.status === "saving" ? (
        <>
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Saving…
        </>
      ) : state.status === "dirty" ? (
        <>
          <Cloud className="size-3.5" aria-hidden /> Unsaved changes…
        </>
      ) : state.status === "error" ? (
        <>
          <CloudOff className="size-3.5 text-rose-300" aria-hidden />
          <span className="text-rose-200">{Object.keys(state.rejected).length ? "Some answers need attention" : "Not saved"}</span>
          {Object.keys(state.rejected).length === 0 && (
            <button type="button" onClick={onRetry} className="inline-flex min-h-6 items-center rounded font-medium text-white underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--stage-accent)]">
              Retry
            </button>
          )}
        </>
      ) : state.status === "saved" ? (
        <>
          <Cloud className="size-3.5 text-emerald-300" aria-hidden /> <span className="text-[var(--stage-ink-2)]">Saved</span>
        </>
      ) : (
        <>
          <Cloud className="size-3.5" aria-hidden /> Saved as you go
        </>
      )}
    </span>
  );
}
