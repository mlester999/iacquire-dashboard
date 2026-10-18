import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyCanAccessClient } from "@/server/crm/actor";
import { canonicalJson } from "@/lib/crm/blueprints/canonical";
import { assetFingerprint, nativeProjection } from "@/lib/crm/blueprints/native";
import { packageDigestInput } from "@/lib/crm/blueprints/package";
import type { ApplyOptions, AssetType, AssetTypeMap, BlueprintContent, ConflictDecision, NativeTypeMap, PlanAction } from "@/lib/crm/blueprints/types";
import { roleHasPermission, type Permission } from "@/lib/permissions";
import type { SessionUser } from "@/server/auth/service";

// Who may do what with CRM Blueprints, and the digests every Blueprint service binds its writes to.
//
// The library is agency work: no client role ever reaches it. The permissions are the crm.blueprints.* keys of the shared matrix
// (src/lib/permissions.ts, seeded into role_permissions by migration 0035): agency staff browse and design, super admins publish and apply.
// Every service takes the signed-in agency person and checks the step's permission and, for anything touching one client (capture, apply
// preview, apply, rollback, update review, importing from a client's connected location), that person's access to that exact client: super
// admins reach every client, staff only clients they are assigned to. Inside the transaction that writes, the person's role and a staff
// member's assignment are read again with a row lock, so access removed a moment ago cannot still apply a Blueprint.

export type AgencyUser = Pick<SessionUser, "id" | "platformRole" | "email" | "fullName">;

export type BlueprintPermission = Extract<Permission, `crm.blueprints.${string}`>;
export const BLUEPRINT_PERMISSIONS = ["crm.blueprints.view", "crm.blueprints.design", "crm.blueprints.publish", "crm.blueprints.apply"] as const satisfies readonly BlueprintPermission[];

const DENIED: Record<BlueprintPermission, string> = {
  "crm.blueprints.view": "Agency access is required to see CRM Blueprints.",
  "crm.blueprints.design": "Your agency role can't change CRM Blueprints.",
  "crm.blueprints.publish": "Only agency super admins can publish CRM Blueprints.",
  "crm.blueprints.apply": "Only agency super admins can apply a CRM Blueprint to a client.",
};

/**
 * Every Blueprint step and what it needs. `client`: the step works on one client's workspace, so access to that client is checked too
 * (and re-checked under a row lock inside the write). `writes`: it changes a client's workspace, so an archived client is refused.
 * `superAdmin`: on top of the permission, only a super admin (a GoHighLevel import reads a stored agency credential).
 */
export const BLUEPRINT_ACTIONS = {
  list: { permission: "crm.blueprints.view", client: false, writes: false, superAdmin: false },
  inspect: { permission: "crm.blueprints.view", client: false, writes: false, superAdmin: false },
  compare: { permission: "crm.blueprints.view", client: false, writes: false, superAdmin: false },
  create: { permission: "crm.blueprints.design", client: false, writes: false, superAdmin: false },
  edit: { permission: "crm.blueprints.design", client: false, writes: false, superAdmin: false },
  duplicate: { permission: "crm.blueprints.design", client: false, writes: false, superAdmin: false },
  archive: { permission: "crm.blueprints.design", client: false, writes: false, superAdmin: false },
  export: { permission: "crm.blueprints.design", client: false, writes: false, superAdmin: false },
  import_file: { permission: "crm.blueprints.design", client: false, writes: false, superAdmin: false },
  import_ghl: { permission: "crm.blueprints.design", client: false, writes: false, superAdmin: true },
  /** Importing from a client's own connected GoHighLevel location also needs access to that client. */
  import_ghl_client: { permission: "crm.blueprints.design", client: true, writes: false, superAdmin: true },
  publish: { permission: "crm.blueprints.publish", client: false, writes: false, superAdmin: false },
  capture: { permission: "crm.blueprints.design", client: true, writes: false, superAdmin: false },
  preview_apply: { permission: "crm.blueprints.design", client: true, writes: false, superAdmin: false },
  review_update: { permission: "crm.blueprints.design", client: true, writes: false, superAdmin: false },
  apply: { permission: "crm.blueprints.apply", client: true, writes: true, superAdmin: false },
  rollback: { permission: "crm.blueprints.apply", client: true, writes: true, superAdmin: false },
} as const satisfies Record<string, { permission: BlueprintPermission; client: boolean; writes: boolean; superAdmin: boolean }>;
export type BlueprintAction = keyof typeof BLUEPRINT_ACTIONS;

export function canBlueprint(user: Pick<SessionUser, "platformRole">, permission: BlueprintPermission): boolean {
  return user.platformRole !== "none" && roleHasPermission(user.platformRole, permission);
}

export function needBlueprint(user: Pick<SessionUser, "platformRole">, permission: BlueprintPermission): void {
  if (!canBlueprint(user, permission)) throw new AppError("forbidden", DENIED[permission]);
}

/** Whether the person's role allows an action at all (the client check, when the action has one, comes on top). For buttons and menus. */
export function canDoBlueprint(user: Pick<SessionUser, "platformRole">, action: BlueprintAction): boolean {
  const spec = BLUEPRINT_ACTIONS[action];
  return canBlueprint(user, spec.permission) && (!spec.superAdmin || user.platformRole === "agency_super_admin");
}

/** Refuses an action the person's role doesn't allow. */
export function needBlueprintAction(user: Pick<SessionUser, "platformRole">, action: BlueprintAction): void {
  const spec = BLUEPRINT_ACTIONS[action];
  needBlueprint(user, spec.permission);
  if (spec.superAdmin && user.platformRole !== "agency_super_admin") {
    throw new AppError("forbidden", "Only agency super admins can import from GoHighLevel, because it uses a stored connection.");
  }
}

/** Re-reads the person's agency role inside a write transaction (row lock), and refuses if it changed or no longer allows `permission`. */
export async function lockBlueprintUser(db: Queryable, user: AgencyUser, permission: BlueprintPermission): Promise<void> {
  const { rows } = await db.query<{ platform_role: string }>("select platform_role from users where id = $1 and status = 'active' for share", [user.id]);
  const role = rows[0]?.platform_role;
  if (!role || role === "none" || role !== user.platformRole) throw new AppError("forbidden", "Your agency access has changed. Sign in again.");
  needBlueprint(user, permission);
}

export interface ClientOrgRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  industry: string | null;
  status: string;
}

export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * The client this person may work on, read inside the caller's transaction. Super admins reach every client; staff only clients they are
 * assigned to (re-checked with a row lock). An organization that is not a client, or one the person cannot reach, is "not found", so the
 * answer never reveals that another client exists.
 */
export async function lockClientForBlueprint(db: Queryable, user: AgencyUser, orgId: string): Promise<ClientOrgRow> {
  if (!isUuid(orgId)) throw new AppError("not_found", "Client not found.");
  if (user.platformRole === "agency_staff") {
    const a = await db.query("select 1 from staff_assignments where org_id = $1 and user_id = $2 for share", [orgId, user.id]);
    if (!a.rows.length) throw new AppError("not_found", "Client not found.");
  } else if (user.platformRole !== "agency_super_admin") {
    throw new AppError("forbidden", "Agency access is required.");
  }
  const { rows } = await db.query<ClientOrgRow & { kind: string }>("select id, name, slug, timezone, industry, status, kind from organizations where id = $1 for share", [orgId]);
  const org = rows[0];
  if (!org || org.kind !== "client") throw new AppError("not_found", "Client not found.");
  return { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone, industry: org.industry, status: org.status };
}

/**
 * Authorizes one Blueprint step inside the caller's write transaction: the person's role (re-read under a lock) and, for client steps, that
 * person's access to that client (locked too). Steps that change a workspace refuse an archived client. Returns the client when there is one.
 */
export async function authorizeBlueprintAction(db: Queryable, user: AgencyUser, action: BlueprintAction, orgId?: string | null): Promise<ClientOrgRow | null> {
  const spec = BLUEPRINT_ACTIONS[action];
  await lockBlueprintUser(db, user, spec.permission);
  needBlueprintAction(user, action);
  if (!spec.client) return null;
  if (!orgId) throw new AppError("invalid_input", "Choose a client.");
  const org = await lockClientForBlueprint(db, user, orgId);
  if (spec.writes && org.status === "archived") throw new AppError("conflict", "This client is archived, so its CRM can't be changed.");
  return org;
}

/** The same client check without a transaction, for reads and page guards. */
export async function canReachClient(user: Pick<SessionUser, "id" | "platformRole">, orgId: string): Promise<boolean> {
  if (!isUuid(orgId)) return false;
  return agencyCanAccessClient(user, orgId);
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/** sha256 over UTF-8 text, lower-case hex. Pass it to package.ts as the Hasher. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A stable hash of any JSON value (canonical JSON: key order never matters). */
export function jsonHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * The integrity digest of package content: sha256 over canonical JSON of the content (never the manifest, the digest itself or the export
 * stamp). Stored on every published version and in every exported file.
 */
export function contentDigest(content: BlueprintContent): string {
  return sha256(packageDigestInput(content as unknown as Record<string, unknown>));
}

/** crm_blueprint_links.asset_hash: the Blueprint asset as applied. A later different hash means the Blueprint changed that asset. */
export function assetHash<T extends AssetType>(type: T, asset: AssetTypeMap[T]): string {
  return jsonHash({ type, asset: assetFingerprint(type, asset) });
}

/** crm_blueprint_links.native_hash: the workspace record's projection right after a write. A later different hash means the client changed it. */
export function nativeHash<T extends AssetType>(type: T, record: NativeTypeMap[T]): string {
  return jsonHash({ type, record: nativeProjection(type, record) });
}

export interface PlanDigestInput {
  versionId: string;
  options: ApplyOptions;
  items: Array<{ assetId: string; action: PlanAction; existingId: string | null; decision: ConflictDecision | null }>;
}

/**
 * The digest of a dry run: every planned action with the record it matches and the decision taken, plus the version and the options.
 * Confirming re-plans under the workspace lock and refuses when this differs ("The workspace changed since the preview").
 */
export function planDigest(input: PlanDigestInput): string {
  const o = input.options;
  const options = {
    strategy: o.strategy,
    sections: o.sections ? [...o.sections].sort() : null,
    assetIds: o.assetIds ? [...o.assetIds].sort() : null,
    decisions: o.decisions ?? {},
    slotMappings: o.slotMappings ?? {},
  };
  const items = [...input.items].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0)).map((i) => [i.assetId, i.action, i.existingId, i.decision]);
  return jsonHash({ versionId: input.versionId, options, items });
}

/** A new inbound webhook nonce for a workflow applied from a Blueprint (the same shape the workflow editor generates). */
export function newInboundNonce(): string {
  return randomBytes(18).toString("base64url");
}

/** An apply confirmation's idempotency key: 16 to 80 URL-safe characters, generated by the confirming screen. */
export function assertIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw new AppError("invalid_input", "This confirmation can't be identified. Preview again and confirm.");
  return key;
}
