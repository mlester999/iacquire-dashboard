"use client";

import * as React from "react";
import { changeTemplateAction, preflightAction, publishAction, saveDraftAction, saveVersionAction, submitForApprovalAction } from "@/app/actions/website";
import type { SaveOutcome } from "@/lib/website/draft-saver";
import type { Issue } from "@/lib/website/lint";
import type { SiteContent } from "@/lib/website/schema";
import type { Preflight, PublishOutcome } from "@/server/websites/service";

type Res<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };
export type PublishResult = { ok: true; data: PublishOutcome } | { ok: false; error: string; code?: string; blockers?: Issue[]; needsAcknowledgement?: Issue[] };
export type SubmitResult = { ok: true; data: { versionId: string } } | { ok: false; error: string; code?: string; blockers?: Issue[] };

/**
 * Everything the editor asks of the server. The real implementation calls server actions; the development preview supplies
 * an in-memory stand-in so the interface can be reviewed without a backend.
 */
export interface StudioApi {
  saveDraft(content: SiteContent, expectedRevision: number): Promise<SaveOutcome>;
  changeTemplate(templateKey: string, expectedRevision: number): Promise<Res<{ revision: number }>>;
  saveVersion(note: string): Promise<Res<{ version: number; created: boolean }>>;
  preflight(): Promise<Res<Preflight>>;
  publish(acknowledgeClaims: boolean, note: string): Promise<PublishResult>;
  submitForApproval(): Promise<SubmitResult>;
}

export const serverStudioApi: StudioApi = {
  async saveDraft(content, revision) {
    const res = await saveDraftAction(content, revision);
    return res.ok ? { ok: true, revision: res.data.revision } : { ok: false, error: res.error, conflict: res.code === "conflict" };
  },
  changeTemplate: (key, revision) => changeTemplateAction(key, revision),
  saveVersion: (note) => saveVersionAction(note),
  preflight: () => preflightAction(),
  publish: (ack, note) => publishAction(ack, note),
  submitForApproval: () => submitForApprovalAction(),
};

const Context = React.createContext<StudioApi>(serverStudioApi);
export const StudioApiProvider = Context.Provider;
export const useStudioApi = () => React.useContext(Context);
