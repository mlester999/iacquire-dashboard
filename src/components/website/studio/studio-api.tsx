"use client";

import * as React from "react";
import {
  acquireLockAction, addCommentAction, listCommentsAction, releaseLockAction, resolveCommentAction,
  deleteAssetAction, getDraftAction, listAssetsAction, listVersionsAction, preflightAction, previewVersionAction, publishAction, regenerateDraftAction, restoreVersionAction, saveDraftAction, saveVersionAction,
  setAssetAltAction, submitForApprovalAction, suggestEditAction, templateUpdateAction, listComponentsAction, saveComponentAction, deleteComponentAction,
} from "@/app/actions/website";
import type { SaveOutcome } from "@/lib/website/draft-saver";
import type { Section, SiteContent } from "@/lib/website/doc";
import type { Issue } from "@/lib/website/lint";
import type { AssetKind, AssetView } from "@/server/assets/service";
import type { Preflight, PublishOutcome, VersionView } from "@/server/websites/service";
import type { CommentView, LockResult } from "@/server/websites/review";
import type { Brief } from "@/lib/website/assistant/brief";
import type { Plan } from "@/lib/website/assistant/ops";
import type { TemplateUpdate } from "@/server/websites/template-update";

export type Res<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };
export type PublishResult = { ok: true; data: PublishOutcome } | { ok: false; error: string; code?: string; blockers?: Issue[]; needsAcknowledgement?: Issue[] };
export type SubmitResult = { ok: true; data: { versionId: string } } | { ok: false; error: string; code?: string; blockers?: Issue[] };
export interface SavedComponent {
  id: string;
  name: string;
  scope: "site" | "agency";
  section: Section;
}
export type VersionContent = { content: SiteContent; templateKey: string; version: number };

/**
 * Everything the editor asks of the server. The real implementation calls server actions (scoped to a client by the server, never by
 * the browser); the development preview supplies an in-memory stand-in so the interface can be reviewed without a backend.
 */
export interface StudioApi {
  saveDraft(content: SiteContent, expectedRevision: number): Promise<SaveOutcome>;
  getDraft(): Promise<Res<{ content: SiteContent; revision: number; templateKey: string }>>;
  saveVersion(note: string, source?: "checkpoint" | "ai"): Promise<Res<{ version: number; created: boolean }>>;
  listVersions(): Promise<Res<VersionView[]>>;
  previewVersion(id: string): Promise<Res<VersionContent>>;
  restoreVersion(id: string, expectedRevision: number): Promise<Res<{ revision: number }>>;
  regenerate(expectedRevision: number, templateKey?: string): Promise<Res<{ revision: number }>>;
  preflight(): Promise<Res<Preflight>>;
  publish(acknowledgeClaims: boolean, note: string): Promise<PublishResult>;
  submitForApproval(): Promise<SubmitResult>;
  listAssets(): Promise<Res<AssetView[]>>;
  uploadAsset(file: File, kind: AssetKind, alt?: string): Promise<Res<AssetView>>;
  setAssetAlt(id: string, alt: string): Promise<Res<Record<string, never>>>;
  deleteAsset(id: string): Promise<Res<Record<string, never>>>;
  /** Where an asset's picture is served from for this editor. */
  assetUrl(id: string): string;
  /** Saved sections the owner can reuse. Optional: an editor without them simply has none. */
  listComponents?(): Promise<Res<SavedComponent[]>>;
  saveComponent?(name: string, section: Section, scope: "site" | "agency"): Promise<Res<SavedComponent>>;
  deleteComponent?(id: string): Promise<Res<Record<string, never>>>;
  /** Asks the connected AI provider for suggested edits. Null means none is available, and the built-in assistant answers instead. Optional. */
  suggestEdit?(request: string, brief: Brief): Promise<Res<Plan | null>>;
  /** A newer look from the template this site began as, when there is one. Optional. */
  getTemplateUpdate?(): Promise<Res<TemplateUpdate | null>>;
  /** Collaboration. Optional: an editor without them is simply on its own. */
  acquireLock?(takeOver: boolean): Promise<Res<LockResult>>;
  releaseLock?(): Promise<Res<Record<string, never>>>;
  listComments?(): Promise<Res<CommentView[]>>;
  addComment?(body: string, nodeId: string | null, pageSlug: string | null): Promise<Res<{ id: string }>>;
  resolveComment?(id: string, resolved: boolean): Promise<Res<Record<string, never>>>;
}

export function createServerStudioApi(orgId?: string): StudioApi {
  const q = orgId ? `?org=${encodeURIComponent(orgId)}` : "";
  return {
    async saveDraft(content, revision) {
      const res = await saveDraftAction(content, revision, orgId);
      return res.ok ? { ok: true, revision: res.data.revision } : { ok: false, error: res.error, conflict: res.code === "conflict" };
    },
    getDraft: () => getDraftAction(orgId),
    saveVersion: (note, source) => saveVersionAction(note, orgId, source),
    suggestEdit: (request, brief) => suggestEditAction(request, brief, orgId),
    getTemplateUpdate: () => templateUpdateAction(orgId),
    listComponents: () => listComponentsAction(orgId),
    saveComponent: (name, section, scope) => saveComponentAction(name, section, scope, orgId),
    deleteComponent: (id) => deleteComponentAction(id, orgId),
    listVersions: () => listVersionsAction(orgId),
    previewVersion: (id) => previewVersionAction(id, orgId),
    restoreVersion: (id, revision) => restoreVersionAction(id, revision, orgId),
    regenerate: (revision, key) => regenerateDraftAction(revision, key, orgId),
    preflight: () => preflightAction(orgId),
    publish: (ack, note) => publishAction(ack, note, orgId),
    submitForApproval: () => submitForApprovalAction(orgId),
    listAssets: () => listAssetsAction(orgId),
    async uploadAsset(file, kind, alt) {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      if (alt) form.set("alt", alt);
      if (orgId) form.set("org", orgId);
      try {
        const res = await fetch("/api/assets/upload", { method: "POST", body: form });
        const json = (await res.json()) as { asset?: AssetView; error?: string };
        return res.ok && json.asset ? { ok: true, data: json.asset } : { ok: false, error: json.error ?? "That image couldn't be uploaded." };
      } catch {
        return { ok: false, error: "That image couldn't be uploaded. Check your connection and try again." };
      }
    },
    setAssetAlt: (id, alt) => setAssetAltAction(id, alt, orgId),
    deleteAsset: (id) => deleteAssetAction(id, orgId),
    assetUrl: (id) => `/api/assets/${id}${q}`,
    acquireLock: (takeOver) => acquireLockAction(takeOver, orgId),
    releaseLock: () => releaseLockAction(orgId),
    listComments: () => listCommentsAction(orgId),
    addComment: (body, nodeId, pageSlug) => addCommentAction(body, nodeId, pageSlug, orgId),
    resolveComment: (id, resolved) => resolveCommentAction(id, resolved, orgId),
  };
}

export const serverStudioApi: StudioApi = createServerStudioApi();

const Context = React.createContext<StudioApi>(serverStudioApi);
export const StudioApiProvider = Context.Provider;
export const useStudioApi = () => React.useContext(Context);
