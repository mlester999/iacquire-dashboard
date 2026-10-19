"use client";

import * as React from "react";
import type { AqiTutorialDefinition, AqiTutorialProgressView, AqiTutorialSummary, AqiTutorialView } from "@/lib/aqi/tutorials";

export type GuidancePhase = "idle" | "starting" | "active" | "confirming" | "paused" | "completed" | "exited" | "unavailable" | "error";
export type TargetState = "idle" | "searching" | "found" | "missing";

export interface GuidanceResume {
  slug: string;
  title: string;
  currentStep: number;
  stepCount: number;
  versionChanged: boolean;
  status: "in_progress" | "paused" | "unavailable";
}

export interface GuidanceSnapshot {
  ready: boolean;
  busy: boolean;
  tutorials: AqiTutorialSummary[];
  open: boolean;
  tutorial: AqiTutorialView | null;
  progress: AqiTutorialProgressView | null;
  stepIndex: number;
  phase: GuidancePhase;
  message: string | null;
  verified: boolean;
  error: string | null;
  resume: GuidanceResume | null;
  targetState: TargetState;
  onboardingVisible: boolean;
  tipVisible: boolean;
  lastPath: string | null;
  preview: boolean;
}

const INITIAL: GuidanceSnapshot = {
  ready: false,
  busy: false,
  tutorials: [],
  open: false,
  tutorial: null,
  progress: null,
  stepIndex: 0,
  phase: "idle",
  message: null,
  verified: false,
  error: null,
  resume: null,
  targetState: "idle",
  onboardingVisible: false,
  tipVisible: false,
  lastPath: null,
  preview: false,
};

let snapshot: GuidanceSnapshot = INITIAL;
const listeners = new Set<() => void>();
let bootstrapPromise: Promise<void> | null = null;
let bootstrappedAt = 0;
const BOOTSTRAP_MS = 30_000;

function emit(patch: Partial<GuidanceSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

const SERVER_SNAPSHOT = INITIAL;

export function useGuidance(): GuidanceSnapshot {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}

export function currentGuidance(): GuidanceSnapshot {
  return snapshot;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || "Something went wrong. Please try again.");
  return data;
}

/** Loads the eligible tutorial list and any persisted progress. Never opens the overlay. */
export async function bootstrapGuidance(pathname: string | null, force = false): Promise<void> {
  if (!force && bootstrappedAt && Date.now() - bootstrappedAt < BOOTSTRAP_MS) {
    if (snapshot.lastPath !== pathname) emit({ lastPath: pathname });
    return;
  }
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    try {
      const data = await requestJson<{
        tutorials: AqiTutorialSummary[];
        state: { active: Array<AqiTutorialProgressView & { tutorialStatus: string }>; completed: AqiTutorialProgressView[]; availableCount: number };
      }>(`/api/aqi/tutorials?path=${encodeURIComponent(pathname ?? "/")}`);
      const active = data.state?.active?.[0] ?? null;
      const resume: GuidanceResume | null = active
        ? {
            slug: active.slug,
            title: active.title,
            currentStep: active.currentStep,
            stepCount: active.stepCount,
            versionChanged: active.versionChanged,
            status: active.status === "paused" ? "paused" : active.status === "unavailable" ? "unavailable" : "in_progress",
          }
        : null;
      bootstrappedAt = Date.now();
      emit({ ready: true, tutorials: data.tutorials ?? [], resume, lastPath: pathname });
    } catch {
      // Guidance is an enhancement; a bootstrap failure must never block the page or AQi chat.
      emit({ ready: false, lastPath: pathname });
    } finally {
      bootstrapPromise = null;
    }
  })();
  return bootstrapPromise;
}

function isGuidancePath(): boolean {
  if (typeof window === "undefined") return false;
  return /^\/(activity|add-ons|analytics|appointments|approvals|chat|crm|inbox|knowledge|leads|maintenance|notifications|our-work|overview|projects|retention|sales|settings|setup|support|website|workforce|admin)(\/|$)/.test(window.location.pathname);
}

export async function startTutorial(slug: string, source: "chat" | "library" | "onboarding" | "tip" = "library"): Promise<boolean> {
  if (snapshot.busy) return false;
  if (!isGuidancePath()) return false;
  emit({ busy: true, error: null, message: null, phase: "starting" });
  try {
    const result = await requestJson<{ tutorial: AqiTutorialView; progress: AqiTutorialProgressView; resumed: boolean }>("/api/aqi/tutorials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, source }),
    });
    emit({
      busy: false,
      open: true,
      tutorial: result.tutorial,
      progress: result.progress,
      stepIndex: Math.min(result.progress.currentStep, result.tutorial.steps.length - 1),
      phase: result.progress.status === "paused" ? "paused" : "active",
      verified: result.progress.verified,
      message: null,
      error: null,
      resume: null,
      targetState: "idle",
      onboardingVisible: false,
      tipVisible: false,
      preview: false,
    });
    if (typeof document !== "undefined") document.body.dataset.aqiTutorial = "on";
    return true;
  } catch (err) {
    emit({
      busy: false,
      open: false,
      phase: "error",
      error: err instanceof Error ? err.message : "I couldn't start that walkthrough. Please try again.",
      targetState: "idle",
    });
    return false;
  }
}

export async function resumeTutorial(): Promise<boolean> {
  const resume = snapshot.resume;
  if (!resume) return false;
  return startTutorial(resume.slug, "library");
}

/**
 * Real browser preview for a Super Admin draft. It resolves the same approved targets and follows
 * real navigation, but it never creates progress or event records and never calls a model.
 */
export function previewTutorialDraft(definition: AqiTutorialDefinition, slug = "draft-preview"): void {
  const tutorial: AqiTutorialView = {
    id: "preview",
    slug,
    title: definition.title,
    description: definition.description,
    category: definition.category,
    routePrefix: definition.routePrefix,
    roles: definition.roles,
    priority: definition.priority,
    version: 0,
    versionId: "preview",
    stepCount: definition.steps.length,
    estimatedMinutes: Math.max(1, Math.ceil(definition.steps.length * 0.6)),
    requiresCrm: definition.requiresCrm,
    aliases: definition.aliases,
    keywords: definition.keywords,
    steps: definition.steps,
    completion: definition.completion,
  };
  const progress: AqiTutorialProgressView = {
    tutorialId: "preview",
    slug,
    title: definition.title,
    status: "in_progress",
    currentStep: 0,
    stepCount: definition.steps.length,
    tutorialVersion: 0,
    publishedVersion: 0,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    completedAt: null,
    verified: false,
    versionChanged: false,
  };
  emit({
    busy: false,
    open: true,
    tutorial,
    progress,
    stepIndex: 0,
    phase: "active",
    message: null,
    verified: false,
    error: null,
    resume: null,
    targetState: "idle",
    onboardingVisible: false,
    tipVisible: false,
    preview: true,
  });
  if (typeof document !== "undefined") document.body.dataset.aqiTutorial = "on";
}

function previewStep(action: TutorialAction, extra: { step?: number; pathname?: string | null }): void {
  const tutorial = snapshot.tutorial;
  if (!tutorial) return;
  const total = tutorial.steps.length;
  const index = Math.min(snapshot.stepIndex, total - 1);
  if (action === "pause") {
    emit({ phase: "paused" });
    return;
  }
  if (action === "resume") {
    emit({ phase: "active" });
    return;
  }
  if (action === "exit") {
    emit({ phase: "exited", message: "Preview ended. Nothing was saved or published." });
    return;
  }
  if (action === "restart") {
    emit({ stepIndex: 0, phase: "active", message: null, verified: false, targetState: "idle", progress: snapshot.progress ? { ...snapshot.progress, currentStep: 0, status: "in_progress" } : null });
    return;
  }
  if (action === "previous") {
    const previous = Math.max(0, index - 1);
    emit({ stepIndex: previous, phase: "active", targetState: "idle" });
    return;
  }
  if (action === "viewed" || action === "target_missing" || action === "route_verified") return;
  if (action === "skip" && !tutorial.steps[index]?.optional) return;
  if (index >= total - 1) {
    const routeMatched = tutorial.completion.kind !== "finish" && routePatternMatches(tutorial.completion.pattern, extra.pathname ?? (typeof window !== "undefined" ? window.location.pathname : null));
    emit({
      phase: "completed",
      verified: false,
      message: tutorial.completion.kind === "contact_created"
        ? `Preview only — the destination matched (${routeMatched ? "yes" : "no"}), but business confirmation is not recorded in preview.`
        : "Preview only — no progress, completion or event was recorded.",
    });
    return;
  }
  emit({ stepIndex: index + 1, phase: "active", targetState: "idle" });
}

function routePatternMatches(pattern: string, pathname: string | null): boolean {
  if (!pathname) return false;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:id/g, "[0-9a-f-]{8,}");
  return new RegExp(`^${escaped}/?$`, "i").test(pathname.split("?")[0].split("#")[0]);
}

/** Remembers the control that opened the walkthrough so focus can return to it on close. */
let guidanceReturnFocus: HTMLElement | null = null;
export function rememberGuidanceFocus(): void {
  const active = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  guidanceReturnFocus = active && active !== document.body && active !== document.documentElement ? active : null;
}

/** Called by the persistent guidance host after the stage unmounts. */
export function restoreGuidanceFocus(): void {
  const target = guidanceReturnFocus;
  guidanceReturnFocus = null;
  window.setTimeout(() => {
    if (target?.isConnected && target.getClientRects().length > 0) {
      target.focus();
      return;
    }
    const fallback = [...document.querySelectorAll<HTMLElement>('[data-aqi-panel] button, [data-aqi-launcher]')]
      .find((element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0);
    fallback?.focus();
  }, 180);
}

export function dismissResume(): void {
  emit({ resume: null });
}

/**
 * Asks the server to confirm completion after the real destination appears. The UI does not claim
 * completion until the response: a route match alone is navigation, and a created-contact tutorial
 * needs the CRM record as authoritative proof.
 */
export async function confirmTutorialCompletion(pathname: string): Promise<void> {
  if (!snapshot.open || !snapshot.tutorial || snapshot.preview) return;
  if (!snapshot.busy) emit({ phase: "confirming", message: null, error: null });
  await progressAction("complete", { pathname });
}

type TutorialAction = "next" | "previous" | "pause" | "resume" | "exit" | "complete" | "skip" | "target_missing" | "route_verified" | "restart" | "viewed";

let progressSequence = 0;
let lastFailedAction: { action: TutorialAction; extra: { step?: number; pathname?: string | null } } | null = null;

async function progressAction(action: TutorialAction, extra: { step?: number; pathname?: string | null } = {}) {
  const tutorial = snapshot.tutorial;
  const progress = snapshot.progress;
  if (!tutorial || !progress) return null;
  if (snapshot.preview) {
    previewStep(action, extra);
    return null;
  }
  // Viewing is analytics only. It must never block the highlighted control or the Next button
  // while its request is in flight.
  if (action === "viewed") {
    void fetch(`/api/aqi/tutorials/${encodeURIComponent(tutorial.slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        step: extra.step ?? snapshot.stepIndex,
        pathname: typeof window !== "undefined" ? window.location.pathname : null,
        eventId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : null,
      }),
    }).catch(() => undefined);
    return null;
  }
  // Completion checks can arrive while another request is in flight. Ignoring them would leave the
  // person on the last step even though the real destination already appeared.
  const silent = action === "route_verified" || action === "complete";
  if (snapshot.busy && !silent) return null;
  const sequence = ++progressSequence;
  lastFailedAction = { action, extra };
  if (!silent) emit({ busy: true, error: null });
  try {
    const result = await requestJson<{
      progress: AqiTutorialProgressView;
      status: string;
      verified: boolean;
      message?: string;
      versionChanged?: boolean;
    }>(`/api/aqi/tutorials/${encodeURIComponent(tutorial.slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        step: extra.step ?? snapshot.stepIndex,
        pathname: extra.pathname ?? (typeof window !== "undefined" ? window.location.pathname : null),
        eventId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : null,
      }),
    });
    const status = result.status;
    const phase: GuidancePhase = status === "completed" ? "completed" : status === "exited" ? "exited" : status === "paused" ? "paused" : status === "unavailable" ? "unavailable" : "active";
    // A slower, older response must never overwrite a completion or a newer step.
    if (sequence !== progressSequence) return result;
    lastFailedAction = null;
    emit({
      busy: false,
      progress: result.progress,
      stepIndex: Math.min(result.progress.currentStep, Math.max(0, tutorial.steps.length - 1)),
      phase,
      verified: result.verified,
      message: result.message ?? null,
      targetState: "idle",
      ...(phase === "completed" || phase === "exited" || phase === "unavailable"
        ? { resume: phase === "completed" || phase === "exited" ? null : snapshot.resume }
        : {}),
    });
    return result;
  } catch (err) {
    if (sequence !== progressSequence) return null;
    emit({
      busy: false,
      phase: "error",
      error: err instanceof Error ? err.message : "That step could not be saved. Please try again.",
    });
    return null;
  }
}

export const tutorialActions = {
  next: () => progressAction("next"),  previous: () => progressAction("previous"),
  pause: async () => {
    const result = await progressAction("pause");
    return result;
  },
  resume: () => progressAction("resume"),
  exit: () => progressAction("exit", { pathname: typeof window !== "undefined" ? window.location.pathname : null }),
  skip: () => progressAction("skip"),
  complete: () => progressAction("complete"),
  restart: () => progressAction("restart"),
  viewed: (step: number) => progressAction("viewed", { step }),
  routeVerified: (pathname: string) => progressAction("route_verified", { pathname }),
};

/** Retries the last failed save or completion check without resetting the walkthrough. */
export function retryTutorialAction(): void {
  if (!lastFailedAction) return;
  void progressAction(lastFailedAction.action, lastFailedAction.extra);
}

const missingReported = new Set<string>();

export async function reportTargetMissing(): Promise<void> {
  const tutorial = snapshot.tutorial;
  const progress = snapshot.progress;
  if (!tutorial || !progress) return;
  const key = `${tutorial.slug}:${snapshot.progress?.tutorialVersion}:${snapshot.stepIndex}`;
  if (missingReported.has(key)) return;
  missingReported.add(key);
  emit({ targetState: "missing" });
  try {
    await fetch(`/api/aqi/tutorials/${encodeURIComponent(tutorial.slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "target_missing",
        step: snapshot.stepIndex,
        pathname: typeof window !== "undefined" ? window.location.pathname : null,
        eventId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : null,
        reason: "target_not_found",
      }),
    });
  } catch {
    // The event is diagnostic only; the overlay still offers retry, skip and exit.
  }
}

export function setTargetState(state: TargetState): void {
  if (snapshot.targetState === state) return;
  emit({ targetState: state });
}

/**
 * Reconciles the open walkthrough with the server after a navigation. This covers a response that
 * was lost while a route was compiling. Only a completed row from the server can mark completion.
 */
export async function syncGuidanceProgress(pathname: string | null): Promise<void> {
  if (!snapshot.open || !snapshot.tutorial || snapshot.preview) return;
  const tutorial = snapshot.tutorial;
  try {
    const data = await requestJson<{
      state: { active: Array<AqiTutorialProgressView & { tutorialStatus: string }>; completed: AqiTutorialProgressView[] };
    }>(`/api/aqi/tutorials?path=${encodeURIComponent(pathname ?? "/")}`);
    const completed = data.state?.completed?.find((entry) => entry.slug === tutorial.slug);
    if (completed) {
      emit({
        phase: "completed",
        verified: completed.verified,
        progress: completed,
        stepIndex: Math.min(completed.currentStep, tutorial.steps.length - 1),
        busy: false,
        error: null,
        message: completed.verified ? "Verified by the real workspace page." : null,
        resume: null,
      });
      return;
    }
    const active = data.state?.active?.find((entry) => entry.slug === tutorial.slug);
    if (active && (active.currentStep !== snapshot.stepIndex || active.status === "paused" || active.status === "unavailable")) {
      emit({
        stepIndex: Math.min(active.currentStep, tutorial.steps.length - 1),
        progress: active,
        phase: active.status === "paused" ? "paused" : active.status === "unavailable" ? "unavailable" : "active",
        verified: active.verified,
        resume: null,
        busy: false,
      });
    }
  } catch {
    // Reconciliation is a safety net; the visible overlay and its manual controls remain available.
  }
}

export function closeTutorial(): void {
  const phase = snapshot.phase;
  const progress = snapshot.progress;
  const tutorial = snapshot.tutorial;
  const resume: GuidanceResume | null =
    phase === "paused" && progress && tutorial
      ? { slug: tutorial.slug, title: tutorial.title, currentStep: progress.currentStep, stepCount: tutorial.steps.length, versionChanged: false, status: "paused" }
      : null;
  emit({
    open: false,
    tutorial: null,
    progress: null,
    stepIndex: 0,
    phase: "idle",
    message: null,
    error: null,
    verified: false,
    targetState: "idle",
    resume: resume ?? (phase === "completed" || phase === "exited" ? null : snapshot.resume),
    preview: false,
  });
  if (typeof document !== "undefined") delete document.body.dataset.aqiTutorial;
}

export function pauseAndClose(): void {
  void progressAction("pause").finally(() => closeTutorial());
}

export function clearGuidanceError(): void {
  emit({ error: null, phase: snapshot.tutorial ? "active" : "idle" });
}

export function setOnboardingVisible(visible: boolean): void {
  if (snapshot.onboardingVisible === visible) return;
  emit({ onboardingVisible: visible });
}

export function setTipVisible(visible: boolean): void {
  if (snapshot.tipVisible === visible) return;
  emit({ tipVisible: visible });
}

export async function recordChatGuidance(kind: "guidance_accept" | "guidance_decline" | "guidance_offer", slug: string): Promise<void> {
  try {
    await fetch("/api/aqi/guidance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, slug, page: typeof window !== "undefined" ? window.location.pathname : null }),
    });
  } catch {
    // Signals are analytics only; they never block starting a walkthrough.
  }
}

export function resetGuidanceForTests(): void {
  snapshot = INITIAL;
  bootstrappedAt = 0;
  bootstrapPromise = null;
  missingReported.clear();
  for (const listener of listeners) listener();
}
