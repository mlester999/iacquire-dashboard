import "server-only";
import { z } from "zod";
import type { WorkspaceKnowledgeSelection, WorkspaceKnowledgeView } from "@/lib/integrations/workspace-knowledge";
import type { WorkspaceOAuthProvider } from "@/lib/integrations/workspace-oauth";
import { recordAudit } from "@/server/audit";
import { readSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { sha256 } from "@/server/security/crypto";
import type { OrgContext } from "@/server/tenancy/context";
import { detectRiskFlags } from "@/lib/instruction-risk";
import {
  discoverAirtableBases, discoverAirtableTables, discoverNotionKnowledge, fetchWorkspaceKnowledge,
  parseWorkspaceSelection, type WorkspaceKnowledgeSnapshot,
} from "./workspace-knowledge-adapter";
import { canManageWorkspaceOAuth, withWorkspaceKnowledgeReview, withWorkspaceOAuthRead } from "./workspace-oauth";
import { WorkspaceOAuthError } from "./workspace-oauth-adapter";

type SourceRow = {
  id: string;
  provider: WorkspaceOAuthProvider;
  selection: WorkspaceKnowledgeSelection;
  title: string;
  status: WorkspaceKnowledgeView["status"];
  checked_at: Date;
  synced_at: Date | null;
  retry_after: Date | null;
  error_code: string | null;
  active_reference: boolean;
  approved_provenance: WorkspaceKnowledgeSnapshot["provenance"] | null;
  latest_id: string | null;
  latest_status: NonNullable<WorkspaceKnowledgeView["latest"]>["status"] | null;
  latest_fingerprint: string | null;
  latest_provenance: WorkspaceKnowledgeSnapshot["provenance"] | null;
  latest_flags: string[] | null;
};

const errorMessages: Record<string, string> = {
  grant_changed: "The authorization changed. Sync the source again before reviewing it.",
  missing: "The provider removed this source or stopped sharing it.",
  empty: "The source has no supported content to import.",
  bounds: "The provider could not return the complete source within the supported limits. Choose a smaller source or check its sharing settings.",
  schema: "The selected fields changed. Review the table and choose the fields again.",
  rate_limit: "The provider asked us to slow down. Try again after the displayed retry time.",
  provider: "The provider could not return a usable snapshot. Try syncing again.",
};

export function canManageWorkspaceKnowledge(ctx: OrgContext) {
  return canManageWorkspaceOAuth(ctx) && ctx.can("knowledge.view") && ctx.can("knowledge.edit");
}

function requireManager(ctx: OrgContext) {
  if (!canManageWorkspaceKnowledge(ctx)) throw new AppError("forbidden", "Only workspace owners and admins with knowledge access can manage imported references.");
}

function querySources(db: Queryable, orgId: string, provider: WorkspaceOAuthProvider | null) {
  return db.query<SourceRow>(
    `select s.*, last.id as latest_id, last.status as latest_status, last.fingerprint as latest_fingerprint,
       last.provenance as latest_provenance, last.risk_flags as latest_flags, approved.provenance as approved_provenance,
       (s.status <> 'unavailable' and c.status = 'connected' and c.check_id is null
         and (c.access_expires_at is null or c.access_expires_at > now())
         and approved.source_id is not null) as active_reference
       from workspace_knowledge_sources s
       join workspace_oauth_connections c on c.org_id = s.org_id and c.provider = s.provider
       left join workspace_knowledge_versions approved on approved.source_id = s.id and approved.org_id = s.org_id and approved.status = 'approved'
       left join lateral (
         select v.id, v.status, v.fingerprint, v.provenance, v.risk_flags
           from workspace_knowledge_versions v where v.source_id = s.id and v.org_id = s.org_id
          order by v.created_at desc, v.id desc limit 1
       ) last on true
      where s.org_id = $1 and ($2::text is null or s.provider = $2)`,
    [orgId, provider],
  );
}

function asView(row: SourceRow): WorkspaceKnowledgeView {
  const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;
  return {
    provider: row.provider, title: row.title, status: row.status, checkedAt: new Date(row.checked_at).toISOString(),
    syncedAt: iso(row.synced_at), retryAfter: iso(row.retry_after),
    message: row.error_code ? errorMessages[row.error_code] ?? errorMessages.provider : null,
    activeReference: row.active_reference,
    latest: row.latest_id && row.latest_status ? { id: row.latest_id, status: row.latest_status, flagged: Boolean(row.latest_flags?.length) } : null,
  };
}

export async function listWorkspaceKnowledge(ctx: OrgContext) {
  if (!canManageWorkspaceKnowledge(ctx)) return [];
  return (await readSystem((db) => querySources(db, ctx.org.orgId, null))).rows.map(asView);
}

const browseInput = z.object({
  query: z.string().trim().max(120).default(""), cursor: z.string().min(1).max(2048).optional(), baseId: z.string().max(30).optional(),
}).strict();

export async function browseWorkspaceKnowledge(ctx: OrgContext, provider: WorkspaceOAuthProvider, raw: unknown) {
  requireManager(ctx);
  const input = browseInput.parse(raw);
  if (provider === "notion") {
    const result = await withWorkspaceOAuthRead(ctx, provider, (cfg, token) => discoverNotionKnowledge(cfg, token, input.query, input.cursor));
    return { kind: "notion" as const, ...result! };
  }
  if (input.baseId) {
    const baseId = input.baseId;
    const tables = await withWorkspaceOAuthRead(ctx, provider, (cfg, token) => discoverAirtableTables(cfg, token, baseId));
    return { kind: "tables" as const, choices: tables!, cursor: null };
  }
  const result = await withWorkspaceOAuthRead(ctx, provider, (cfg, token) => discoverAirtableBases(cfg, token, input.cursor));
  return { kind: "bases" as const, ...result! };
}

function auditImport(db: Queryable, ctx: OrgContext, provider: WorkspaceOAuthProvider, sourceId: string, action: string, detail: Record<string, unknown>) {
  return recordAudit({
    orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user",
    action: "integration.workspace_knowledge_" + action, targetType: "workspace_knowledge_source", targetId: sourceId,
    result: action === "sync_failed" ? "failure" : "success", metadata: { provider, ...detail },
  }, db);
}

async function supersede(db: Queryable, orgId: string, sourceId: string, preserveApproved: boolean) {
  await db.query(
    "update workspace_knowledge_versions set status = 'superseded' where org_id = $1 and source_id = $2 and (status = 'pending' or ($3::boolean = false and status = 'approved'))",
    [orgId, sourceId, preserveApproved],
  );
}

export async function syncWorkspaceKnowledge(ctx: OrgContext, provider: WorkspaceOAuthProvider, rawSelection?: unknown) {
  requireManager(ctx);
  const orgId = ctx.org.orgId;
  const requested = rawSelection === undefined ? null : parseWorkspaceSelection(provider, rawSelection);
  let previous: SourceRow | null = null;
  let selected: WorkspaceKnowledgeSelection | null = requested;
  let sameSelection = false;
  await withWorkspaceOAuthRead(ctx, provider, (cfg, token) => {
    if (!selected) throw new AppError("invalid_input", "Choose a source first.");
    return fetchWorkspaceKnowledge(cfg, token, selected);
  }, {
    before: async (db) => {
      previous = (await querySources(db, orgId, provider)).rows[0] ?? null;
      if (previous && !selected) selected = parseWorkspaceSelection(provider, previous.selection);
      if (!selected) throw new AppError("invalid_input", "Choose a source first.");
      sameSelection = previous !== null && JSON.stringify(parseWorkspaceSelection(provider, previous.selection)) === JSON.stringify(selected);
    },
    complete: async (db, snapshot) => {
      if (!selected) throw new AppError("conflict", "The selected source changed.");
      const saved = (await db.query<{ id: string }>(
        `insert into workspace_knowledge_sources (org_id, provider, selection, title, status, synced_at, error_code)
           values ($1, $2, $3::jsonb, $4, $5, now(), $6)
           on conflict (org_id, provider) do update set selection = excluded.selection, title = excluded.title,
             status = excluded.status, error_code = excluded.error_code, checked_at = now(), synced_at = now(), retry_after = null
           returning id`,
        [orgId, provider, JSON.stringify(selected), snapshot.title, snapshot.content ? "current" : "unavailable", snapshot.content ? null : "empty"],
      )).rows[0];
      const fingerprint = sha256(JSON.stringify([selected, snapshot.title, snapshot.content]));
      const changed = !sameSelection || previous?.latest_status === "superseded" || fingerprint !== previous?.latest_fingerprint;
      if (!snapshot.content) {
        await supersede(db, orgId, saved.id, false);
      } else if (changed) {
        const records = new Set(snapshot.provenance.records);
        const removed = previous?.approved_provenance?.records.some((id) => !records.has(id));
        await supersede(db, orgId, saved.id, sameSelection && !removed);
        await db.query(
          `insert into workspace_knowledge_versions (org_id, source_id, fingerprint, content, provenance, status, risk_flags)
           values ($1, $2, $3, $4, $5::jsonb, 'pending', $6)`,
          [orgId, saved.id, fingerprint, snapshot.content, JSON.stringify({ ...snapshot.provenance, title: snapshot.title }), detectRiskFlags(snapshot.title, snapshot.content)],
        );
      }
      await auditImport(db, ctx, provider, saved.id, "synced", { changed, records: snapshot.provenance.records.length, empty: !snapshot.content });
    },
    failed: async (db, error) => {
      if (!sameSelection || !previous) return;
      const providerError = error instanceof WorkspaceOAuthError ? error : null;
      const missing = providerError?.kind === "missing" || providerError?.kind === "permission";
      const mappingInvalid = error instanceof AppError && error.code === "conflict";
      const tooLarge = error instanceof AppError && error.code === "usage_limit";
      const unavailable = missing || mappingInvalid || tooLarge;
      const reason = missing ? "missing" : mappingInvalid ? "schema" : tooLarge ? "bounds"
        : providerError?.kind === "rate_limit" ? "rate_limit" : "provider";
      if (unavailable) await supersede(db, orgId, previous.id, false);
      await db.query(
        `update workspace_knowledge_sources set status = $3, checked_at = now(), error_code = $4,
           retry_after = case when $5::int is null then null else now() + $5 * interval '1 second' end where id = $1 and org_id = $2`,
        [previous.id, orgId, unavailable ? "unavailable" : "retry", reason, providerError?.retryAfter ?? null],
      );
      await auditImport(db, ctx, provider, previous.id, "sync_failed", { reason });
    },
  });
  return (await listWorkspaceKnowledge(ctx)).find((row) => row.provider === provider) ?? null;
}

async function currentVersion(db: Queryable, orgId: string, provider: WorkspaceOAuthProvider, snapshotId: string) {
  const source = (await querySources(db, orgId, provider)).rows[0];
  if (!source || source.latest_id !== snapshotId || source.status === "unavailable" || source.latest_status === "superseded") {
    throw new AppError("not_found", "That snapshot is no longer current. Refresh the source and try again.");
  }
  return source;
}

export async function previewWorkspaceKnowledge(ctx: OrgContext, provider: WorkspaceOAuthProvider, rawSnapshotId: string) {
  requireManager(ctx);
  const snapshotId = z.string().uuid().parse(rawSnapshotId);
  return withWorkspaceKnowledgeReview(ctx, provider, async (db) => {
    const source = await currentVersion(db, ctx.org.orgId, provider, snapshotId);
    const row = (await db.query<{ content: string }>(
      "select content from workspace_knowledge_versions where id = $1 and org_id = $2", [snapshotId, ctx.org.orgId],
    )).rows[0];
    return {
      title: source.title, content: row.content, selection: source.selection, capturedFrom: source.latest_provenance?.records.length ?? 0,
      status: source.latest_status, flagged: Boolean(source.latest_flags?.length),
    };
  });
}

export async function reviewWorkspaceKnowledge(ctx: OrgContext, provider: WorkspaceOAuthProvider, rawSnapshotId: string, rawDecision: string) {
  requireManager(ctx);
  const snapshotId = z.string().uuid().parse(rawSnapshotId);
  const decision = z.enum(["approved", "rejected"]).parse(rawDecision);
  const orgId = ctx.org.orgId;
  return withWorkspaceKnowledgeReview(ctx, provider, async (db) => {
    const source = await currentVersion(db, orgId, provider, snapshotId);
    if (source.latest_status === decision) return asView(source);
    if (source.latest_status !== "pending") throw new AppError("conflict", "This snapshot was already reviewed.");
    if (decision === "approved" && source.status !== "current") throw new AppError("conflict", "Sync this source before approving it.");
    if (decision === "approved" && source.latest_flags?.length) {
      throw new AppError("forbidden", "Update the source to remove potentially unsafe instructions, then sync it again.");
    }
    if (decision === "approved") {
      await db.query("update workspace_knowledge_versions set status = 'superseded' where source_id = $1 and org_id = $2 and status = 'approved'", [source.id, orgId]);
    }
    await db.query(
      "update workspace_knowledge_versions set status = $3, reviewed_at = now(), reviewed_by = $4 where id = $1 and org_id = $2",
      [snapshotId, orgId, decision, ctx.user.id],
    );
    await auditImport(db, ctx, provider, source.id, decision, { snapshotId });
    const updated = (await querySources(db, orgId, provider)).rows[0];
    return asView(updated);
  });
}
