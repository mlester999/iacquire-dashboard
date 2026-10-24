import "server-only";
import type { Queryable } from "@/server/db";
import type { AssetType, NativeTypeMap } from "@/lib/crm/blueprints/types";

// The shapes the native readers and writers share. A NativeEntry is one configuration record of a workspace in the contract's native
// record shape (src/lib/crm/blueprints/types.ts → NativeTypeMap), plus the workspace-owned state the apply engine, rollback and the setup
// checklist look at (status, defaults, positions, approvals). Nothing here ever holds a customer record.

/** Workspace-owned state of a configuration record: never part of a Blueprint, never part of the customization fingerprint. */
export interface EntryMeta {
  /** calendars: draft | active; forms: draft | published | archived; templates: draft | approved | archived; workflows: draft | active | paused | archived. */
  status?: string;
  isDefault?: boolean;
  public?: boolean;
  visibility?: "private" | "team";
  ownerUserId?: string | null;
  position?: number;
  slug?: string;
  /** Assignment rules: switched on. */
  active?: boolean;
  /** Calendars: active hosts. Assignment rules: members. */
  memberCount?: number;
  /** Templates: the current version's content hash (what a workflow send step is bound to). */
  contentHash?: string;
  currentVersion?: number;
  approvedVersion?: number | null;
  whatsappTemplateId?: string | null;
  /** Forms and workflows: the published version, if any. */
  publishedVersionId?: string | null;
  /** Calendars: manual | blueprint | ghl_import | onboarding. */
  origin?: string;
  verifiedAt?: string | null;
  /** Workflows: whether the record came from its live (published) version rather than its working copy (capture only). */
  live?: boolean;
}

export interface NativeEntry<T extends AssetType = AssetType> {
  type: T;
  id: string;
  record: NativeTypeMap[T];
  /** What a person calls it (name, label or key). */
  name: string;
  /** The pipeline of a stage, the calendar of an appointment type. */
  parentId: string | null;
  archived: boolean;
  meta: EntryMeta;
}

export type EntriesByType = { [T in AssetType]: Array<NativeEntry<T>> };

/** Every configuration record of one workspace that a Blueprint can hold, read inside the caller's transaction. */
export interface WorkspaceConfig {
  orgId: string;
  entries: EntriesByType;
  byId: Map<string, NativeEntry>;
}

export interface ReadOptions {
  /**
   * Forms, templates and workflows as they are used: a published form's live version, an approved template's approved wording, an active
   * or paused workflow's published version. Off (the default), each record is its working copy, which is what the apply engine writes and
   * fingerprints.
   */
  live?: boolean;
}

/** What every writer needs: the transaction, the workspace, and who the new records are attributed to. */
export interface WriteContext {
  db: Queryable;
  orgId: string;
  /** The agency person applying (created_by columns). */
  userId: string | null;
  /** Team Smart Lists' owner: the client's first active owner, else the applying agency person. */
  listOwnerId: string;
  /** Saved reports' owner: the client's first active owner, or nobody. */
  reportOwnerId: string | null;
  defaultCallingCode: string | null;
}

/** Options a create takes beyond the record itself. */
export interface CreateOptions {
  /** Assignment rules: switch the rule on (only when every member and the fallback person are mapped). */
  active?: boolean;
  /** Smart Lists and pipelines: become the default when the workspace has none of its own. */
  makeDefault?: boolean;
  /** Stages of a pipeline this apply creates: their place in the Blueprint's order (1-based). Otherwise a new stage goes where the CRM puts one. */
  position?: number;
}
