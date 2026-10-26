"use client";

import * as React from "react";
import {
  deleteAssetAction,
  getOnboardingReviewAction,
  readOnboardingWebsiteAction,
  saveOnboardingStepAction,
  setAssetVariantAction,
  submitOnboardingAction,
} from "@/app/actions/onboarding";
import type { PipelinePayload, PipelineSaveResult } from "@/lib/onboarding/save-pipeline";
import type { ReviewModel } from "@/lib/onboarding/engine";
import type { SchedulingDraftOutcome } from "@/lib/onboarding/scheduling-drafts";
import type { Suggestion, WebsiteAnalysisSummary } from "@/server/onboarding/service";
import type { AssetView } from "@/server/assets/service";
import type { AssistanceOptions } from "@/lib/onboarding/assistance";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Everything the questionnaire needs from the server. The real implementation calls server actions
 * and upload routes; the development preview supplies an in-memory stand-in so the interface can be
 * reviewed without a backend.
 */
export interface OnboardingApi {
  save(payload: PipelinePayload): Promise<PipelineSaveResult>;
  suggest(questionId: string, options?: AssistanceOptions, signal?: AbortSignal): Promise<Result<Suggestion>>;
  readWebsite(url: string): Promise<Result<WebsiteAnalysisSummary>>;
  review(): Promise<Result<ReviewModel>>;
  /** `scheduling` is what the booking answers did: a draft calendar made or extended, or why not (never live). Absent in the preview. */
  submit(): Promise<Result<{ scheduling?: SchedulingDraftOutcome }>>;
  uploadImage(kind: "logo" | "image" | "reference", file: File): Promise<Result<AssetView>>;
  uploadDocument(file: File): Promise<Result<{ id: string; filename: string }>>;
  removeAsset(id: string): Promise<Result<unknown>>;
  setAssetVariant(id: string, variant: "original" | "processed"): Promise<Result<unknown>>;
}

async function upload<T>(url: string, form: FormData, pick: (body: Record<string, unknown>) => T | null): Promise<Result<T>> {
  try {
    const res = await fetch(url, { method: "POST", body: form });
    const body = (await res.json()) as Record<string, unknown>;
    const value = res.ok ? pick(body) : null;
    return value ? { ok: true, data: value } : { ok: false, error: typeof body.error === "string" ? body.error : "Upload failed. Please try again." };
  } catch {
    return { ok: false, error: "Upload failed. Check your connection and try again." };
  }
}

export const serverApi: OnboardingApi = {
  async save(payload) {
    const res = await saveOnboardingStepAction(payload);
    return res.ok ? { ok: true, data: { revision: res.data.revision, rejected: res.data.rejected, staleBase: res.data.staleBase } } : { ok: false, error: res.error };
  },
  async suggest(questionId, options, signal) {
    try {
      const response = await fetch("/api/onboarding/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionId, ...options }), signal });
      return await response.json() as Result<Suggestion>;
    } catch {
      return { ok: false, error: signal?.aborted ? "Suggestion cancelled." : "Couldn't reach writing assistance. Check your connection and try again." };
    }
  },
  readWebsite: (url) => readOnboardingWebsiteAction(url),
  review: () => getOnboardingReviewAction(),
  submit: () => submitOnboardingAction(),
  uploadImage(kind, file) {
    const form = new FormData();
    form.set("file", file);
    form.set("kind", kind);
    return upload("/api/assets/upload", form, (b) => (b.asset as AssetView | undefined) ?? null);
  },
  uploadDocument(file) {
    const form = new FormData();
    form.set("file", file);
    return upload("/api/knowledge/upload", form, (b) => (typeof b.id === "string" ? { id: b.id, filename: typeof b.filename === "string" ? b.filename : file.name } : null));
  },
  removeAsset: (id) => deleteAssetAction(id),
  setAssetVariant: (id, variant) => setAssetVariantAction(id, variant),
};

const Context = React.createContext<OnboardingApi>(serverApi);
export const OnboardingApiProvider = Context.Provider;
export const useOnboardingApi = () => React.useContext(Context);
