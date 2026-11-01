import "server-only";
import type { Queryable } from "@/server/db";
import { detectRiskFlags } from "@/server/workforce/compiler";

export type KnowledgeWriteSource = "client" | "onboarding" | "agency" | "restore";

export interface KnowledgeWriteInput {
  orgId: string;
  section: string;
  /** Already sanitized by the caller. It is scanned here, so no writer can skip the scan. */
  text: string;
  /** The person responsible for the text; null for a system write that has no person. */
  userId: string | null;
  source: KnowledgeWriteSource;
  restoredFromVersion?: number | null;
  /** Set by the onboarding seeder: the hash that marks a section as still holding the seeded text (a clean write stores it; a held one leaves it alone). */
  seededHash?: string | null;
  /** The hash a brand-new row that starts empty (its first text is held) carries, so a later clean seed can still fill it. */
  emptySeededHash?: string | null;
}

export interface KnowledgeWriteResult {
  held: boolean;
  flags: string[];
  version: number;
  fromVersion: number | null;
  /** A text that was still waiting when this write happened. */
  hadPending: boolean;
  /** Older waiting revisions marked superseded by this write (0 when the connection may not update the history). */
  superseded: number;
}

/**
 * The one writer of company knowledge text, shared by the Knowledge Center, restore, the onboarding seeder and the knowledge-change approval, so none of them can replace
 * approved text with unreviewed text or skip the history. A clean text becomes the approved text; a flagged one waits in pending_content and `content` stays exactly as it
 * was. Either way a revision row records the version. Runs inside the caller's transaction.
 */
export async function writeKnowledgeTextTx(db: Queryable, input: KnowledgeWriteInput): Promise<KnowledgeWriteResult> {
  const { orgId, section, text, userId, source } = input;
  const flags = detectRiskFlags(text);
  const held = flags.length > 0;
  // One writer per section at a time, so the version number below cannot be handed out twice.
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`knowledge:${orgId}:${section}`]);
  const { rows } = await db.query<{ content: string; version: number; review_status: string; had_pending: boolean }>(
    "select content, version, review_status, (pending_content is not null) as had_pending from company_knowledge where org_id = $1 and section = $2",
    [orgId, section],
  );
  const existing = rows[0];
  const { rows: history } = await db.query<{ top: number; total: number }>(
    "select coalesce(max(version), 0)::int as top, count(*)::int as total from company_knowledge_revisions where org_id = $1 and section = $2",
    [orgId, section],
  );
  // The first edit after history began keeps what was there, so the person can always go back to it.
  if (existing && history[0].total === 0 && existing.content !== "" && existing.review_status === "approved") {
    await db.query(
      `insert into company_knowledge_revisions (org_id, section, version, content, review_status, risk_flags, source, actor_user_id)
       values ($1, $2, $3, $4, 'approved', '{}', 'baseline', null)`,
      [orgId, section, existing.version, existing.content],
    );
  }
  const version = Math.max(existing?.version ?? 0, history[0].top) + 1;
  if (held) {
    await db.query(
      `insert into company_knowledge (org_id, section, content, version, updated_by, pending_content, pending_flags, seeded_hash)
       values ($1, $2, '', $3, $4, $5, $6, $7)
       on conflict (org_id, section) do update set pending_content = excluded.pending_content, pending_flags = excluded.pending_flags`,
      [orgId, section, version, userId, text, flags, input.emptySeededHash ?? null],
    );
  } else {
    await db.query(
      `insert into company_knowledge (org_id, section, content, version, updated_by, risk_flags, review_status, applied_at, seeded_hash)
       values ($1, $2, $3, $4, $5, '{}', 'approved', now(), $6)
       on conflict (org_id, section) do update set content = excluded.content, version = excluded.version,
         updated_by = excluded.updated_by, updated_at = now(), risk_flags = '{}', review_status = 'approved', applied_at = now(),
         pending_content = null, pending_flags = '{}', seeded_hash = case when $7::boolean then excluded.seeded_hash else company_knowledge.seeded_hash end`,
      [orgId, section, text, version, userId, input.seededHash ?? null, input.seededHash !== undefined],
    );
  }
  await db.query(
    `insert into company_knowledge_revisions (org_id, section, version, content, review_status, risk_flags, source, actor_user_id, restored_from_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [orgId, section, version, text, held ? "held" : "approved", flags, source, userId, input.restoredFromVersion ?? null],
  );
  // A newer edit replaces one that was still waiting: its row says so instead of staying "held" forever. Only a connection that may update the history can say so
  // (a person's own connection can only add rows); the Knowledge Center repeats this step with the trusted connection.
  let superseded = 0;
  const { rows: can } = await db.query<{ ok: boolean }>("select has_table_privilege('public.company_knowledge_revisions', 'UPDATE') as ok");
  if (can[0]?.ok) {
    const res = await db.query(
      "update company_knowledge_revisions set review_status = 'superseded', decided_at = now() where org_id = $1 and section = $2 and review_status = 'held' and version < $3",
      [orgId, section, version],
    );
    superseded = res.rowCount ?? 0;
  }
  return { held, flags, version, fromVersion: existing?.version ?? null, hadPending: existing?.had_pending === true, superseded };
}
