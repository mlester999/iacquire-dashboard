"use client";

import * as React from "react";
import {
  deleteAssetAction, getDraftAction, listAssetsAction, listVersionsAction, preflightAction, previewVersionAction, publishAction, regenerateDraftAction, restoreVersionAction, saveDraftAction, saveVersionAction,
  setAssetAltAction, submitForApprovalAction,
} from "@/app/actions/website";
import type { SaveOutcome } from "@/lib/website/draft-saver";
import type { Section, SiteContent } from "@/lib/website/doc";
import type { Issue } from "@/lib/website/lint";
import type { AssetKind, AssetView } from "@/server/assets/service";
import type { Preflight, PublishOutcome, VersionView } from "@/server/websites/service";

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
  saveVersion(note: string): Promise<Res<{ version: number; created: boolean }>>;
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
}

export function createServerStudioApi(orgId?: string): StudioApi {
  const q = orgId ? `?org=${encodeURIComponent(orgId)}` : "";
  return {
    async saveDraft(content, revision) {
      const res = await saveDraftAction(content, revision, orgId);
      return res.ok ? { ok: true, revision: res.data.revision } : { ok: false, error: res.error, conflict: res.code === "conflict" };
    },
    getDraft: () => getDraftAction(orgId),
    saveVersion: (note) => saveVersionAction(note, orgId),
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
  };
}

export const serverStudioApi: StudioApi = createServerStudioApi();

const Context = React.createContext<StudioApi>(serverStudioApi);
export const StudioApiProvider = Context.Provider;
export const useStudioApi = () => React.useContext(Context);
