// Keeping the editor honest when the saved post changes under it. The editor's fields start from one saved version of the post (the one a save is checked
// against). When the page brings a newer version, there are four cases, and only one of them needs the person's attention. Pure.

import type { PostKind } from "@/lib/social/rules";

export interface EditFields {
  accountId: string;
  kind: PostKind;
  caption: string;
  hashtags: string[];
  /** The address as typed, "" when there is none. */
  linkUrl: string;
  /** "" for no campaign. */
  campaignId: string;
  mediaIds: string[];
}

export interface SavedPostFields {
  accountId: string;
  kind: PostKind;
  caption: string;
  hashtags: string[];
  linkUrl: string | null;
  campaignId: string | null;
  media: Array<{ id: string }>;
}

/** The editor's view of a saved post. */
export const fieldsOfPost = (p: SavedPostFields): EditFields => ({
  accountId: p.accountId, kind: p.kind, caption: p.caption, hashtags: p.hashtags, linkUrl: p.linkUrl ?? "", campaignId: p.campaignId ?? "", mediaIds: p.media.map((m) => m.id),
});

// The server stores the caption with Windows line breaks turned into plain ones and trailing space removed, so a caption is compared the way it is stored.
const stored = (caption: string) => caption.replace(/\r\n/g, "\n").trimEnd();
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function sameFields(a: EditFields, b: EditFields): boolean {
  return a.accountId === b.accountId && a.kind === b.kind && stored(a.caption) === stored(b.caption) && sameList(a.hashtags, b.hashtags) && a.linkUrl.trim() === b.linkUrl.trim()
    && a.campaignId === b.campaignId && sameList(a.mediaIds, b.mediaIds);
}

export type EditSync =
  /** The fields are based on the version the page shows (or the page has not caught up with a save yet). */
  | "in_sync"
  /** The page brought a newer version that holds exactly what is in the fields (this person's own save came back): remember it as the base. */
  | "mark_current"
  /** The page brought a newer version and the person has not touched the fields: show the new text. */
  | "adopt_current"
  /** The page brought a newer version, and the person has unsaved edits of the old one: keep them, refuse to save over the newer text, and say so. */
  | "conflict";

/** The decision itself, for any editor: its fields (`mine`), the saved version they started from (`loaded`) and the saved version the page shows now (`current`). */
export function syncVersions<T>(i: { loadedVersion: number; currentVersion: number; loaded: T; current: T; mine: T; same: (a: T, b: T) => boolean }): EditSync {
  // A page that is not newer than the base is either the same version or still catching up with a save that just succeeded: nothing to reconcile yet.
  if (i.currentVersion <= i.loadedVersion) return "in_sync";
  if (i.same(i.mine, i.current)) return "mark_current";
  if (i.same(i.mine, i.loaded)) return "adopt_current";
  return "conflict";
}

export const syncEdit = (i: { loadedVersion: number; currentVersion: number; loaded: EditFields; current: EditFields; mine: EditFields }): EditSync => syncVersions({ ...i, same: sameFields });

// The settings form (src/components/social/settings-panel.tsx) is the same kind of editor, over the workspace's rules for posts.

export interface SettingsFields {
  approvalForPublishers: boolean;
  aiDraftsEnabled: boolean;
  trackingLinks: boolean;
  hashtags: string[];
  voice: string;
}

export const fieldsOfSettings = (s: { approvalForPublishers: boolean; aiDraftsEnabled: boolean; trackingLinks: boolean; defaultHashtags: string[]; brandVoiceNote: string | null }): SettingsFields => ({
  approvalForPublishers: s.approvalForPublishers, aiDraftsEnabled: s.aiDraftsEnabled, trackingLinks: s.trackingLinks, hashtags: s.defaultHashtags, voice: s.brandVoiceNote ?? "",
});

// The server collapses the voice note's white space before storing it.
const storedVoice = (v: string) => v.replace(/\s+/g, " ").trim();

export const sameSettings = (a: SettingsFields, b: SettingsFields): boolean =>
  a.approvalForPublishers === b.approvalForPublishers && a.aiDraftsEnabled === b.aiDraftsEnabled && a.trackingLinks === b.trackingLinks && sameList(a.hashtags, b.hashtags) && storedVoice(a.voice) === storedVoice(b.voice);
