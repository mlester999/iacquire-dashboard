import "server-only";
import { z } from "zod";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { recordAudit } from "@/server/audit";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";

export type GrowthPartnerLegacyKnowledgeSourceType = "employee_note" | "reference_document";
export type GrowthPartnerLegacyKnowledgeStatus = "pending_review" | "approved" | "rejected";

const sourceTypeSchema = z.enum(["employee_note", "reference_document"]);
const sourceSchema = z.object({ sourceType: sourceTypeSchema, sourceId: z.string().uuid(), sourceVersion: z.string().trim().min(1).max(120) }).strict();
const importInputSchema = z.object({ sources: z.array(sourceSchema).min(1).max(10) }).strict();
const previewInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("candidate"), sourceType: sourceTypeSchema, sourceId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("import"), importId: z.string().uuid() }).strict(),
]);
const decisionInputSchema = z.object({ importId: z.string().uuid(), status: z.enum(["approved", "rejected"]) }).strict();

function assertCanManage(ctx: OrgContext) {
  if (ctx.org.kind !== "client") throw new AppError("forbidden", "Legacy knowledge review is available in client workspaces.");
  if (!ctx.can("agents.configure") || !ctx.can("knowledge.view")) {
    throw new AppError("forbidden", "Only workspace owners and admins with knowledge access can review retained profile knowledge.");
  }
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AppError("conflict", "A legacy knowledge source has an invalid saved date.");
  return date.toISOString();
}

function noteSourceVersion(version: number): string {
  return String(version);
}

function documentSourceVersion(row: Pick<DocumentRow, "sha256" | "processed_at">): string {
  return `sha256:${row.sha256}:${row.processed_at ? isoDate(row.processed_at) : "unprocessed"}`;
}

function sourceIdentity(sourceType: GrowthPartnerLegacyKnowledgeSourceType, sourceId: string, version: string) {
  return `${sourceType}:${sourceId}:${version}`;
}

type NoteRow = {
  id: string;
  role_key: AgentRoleKey;
  title: string;
  content: string;
  version: number;
  updated_at: Date | string;
};

type DocumentRow = {
  id: string;
  role_key: AgentRoleKey | null;
  filename: string;
  sha256: string;
  processed_at: Date | string | null;
  extracted_text: string;
  created_at: Date | string;
};

type ImportedRow = {
  id: string;
  source_type: GrowthPartnerLegacyKnowledgeSourceType;
  source_record_id: string;
  source_version: string;
  source_role_key: AgentRoleKey | null;
  title: string;
  status: GrowthPartnerLegacyKnowledgeStatus;
  created_at: Date | string;
  reviewed_at: Date | string | null;
};

export type GrowthPartnerLegacyKnowledgeCandidate = {
  sourceType: GrowthPartnerLegacyKnowledgeSourceType;
  sourceId: string;
  sourceVersion: string;
  title: string;
  roleLabel: string;
  updatedAt: string;
  preview: string;
};

export type GrowthPartnerLegacyKnowledgeImport = {
  id: string;
  sourceType: GrowthPartnerLegacyKnowledgeSourceType;
  sourceId: string;
  sourceVersion: string;
  roleLabel: string;
  title: string;
  status: GrowthPartnerLegacyKnowledgeStatus;
  createdAt: string;
  reviewedAt: string | null;
};

export type GrowthPartnerLegacyKnowledgeReview = {
  candidates: GrowthPartnerLegacyKnowledgeCandidate[];
  imports: GrowthPartnerLegacyKnowledgeImport[];
};

function roleLabel(roleKey: AgentRoleKey | null): string {
  return roleKey ? AGENT_BY_KEY[roleKey].shortName : "Shared reference";
}

async function partnerIdFor(ctx: OrgContext, db: Queryable) {
  const partner = (await db.query<{ id: string }>(
    "select id from ai_growth_partners where org_id = $1 for update",
    [ctx.org.orgId],
  )).rows[0];
  if (!partner) throw new AppError("not_found", "Set up the AI Growth Partner before reviewing legacy knowledge.");
  return partner.id;
}

/** Lists only owner/admin-visible, released, risk-free source candidates and review status metadata. */
export async function listGrowthPartnerLegacyKnowledge(ctx: OrgContext): Promise<GrowthPartnerLegacyKnowledgeReview> {
  assertCanManage(ctx);
  return withUser(ctx.user.id, async (db) => {
    const partner = (await db.query<{ id: string }>(
      "select id from ai_growth_partners where org_id = $1",
      [ctx.org.orgId],
    )).rows[0];
    if (!partner) return { candidates: [], imports: [] };

    const notes = await db.query<NoteRow>(
        `select e.id, a.role_key, e.title, left(e.content, 280) as content, e.version, e.updated_at
         from employee_knowledge_entries e
         join agent_instances a on a.id = e.agent_instance_id and a.org_id = e.org_id
         where e.org_id = $1 and a.role_key = any($2::text[])
           and e.status = 'approved' and cardinality(e.risk_flags) = 0 and e.content <> ''
         order by e.updated_at desc, e.id
         limit 120`,
        [ctx.org.orgId, AGENT_ROLE_KEYS],
      );
    const documents = await db.query<DocumentRow>(
        `select d.id, a.role_key, d.filename, d.sha256, d.processed_at, left(d.extracted_text, 3000) as extracted_text, d.created_at
         from knowledge_documents d
         left join agent_instances a on a.id = d.agent_instance_id and a.org_id = d.org_id
         where d.org_id = $1 and d.status = 'ready' and d.extracted_text is not null
           and d.extracted_text <> '' and d.applied_at is not null and cardinality(d.risk_flags) = 0
           and (d.agent_instance_id is null or a.role_key = any($2::text[]))
         order by d.created_at desc, d.id
         limit 56`,
        [ctx.org.orgId, AGENT_ROLE_KEYS],
      );
    const imported = await db.query<ImportedRow>(
        `select id, source_type, source_record_id, source_version, source_role_key, title, status, created_at, reviewed_at
         from ai_growth_partner_legacy_knowledge where org_id = $1 and partner_id = $2
         order by created_at desc, id desc limit 250`,
        [ctx.org.orgId, partner.id],
      );

    const staged = new Set(imported.rows.map((row) => sourceIdentity(row.source_type, row.source_record_id, row.source_version)));
    const candidates: GrowthPartnerLegacyKnowledgeCandidate[] = [
      ...notes.rows.map((row) => {
        const sourceType = "employee_note" as const;
        const version = noteSourceVersion(row.version);
        return staged.has(sourceIdentity(sourceType, row.id, version)) ? null : {
          sourceType,
          sourceId: row.id,
          sourceVersion: version,
          title: row.title,
          roleLabel: roleLabel(row.role_key),
          updatedAt: isoDate(row.updated_at),
          preview: row.content.slice(0, 280),
        };
      }),
      ...documents.rows.map((row) => {
        const sourceType = "reference_document" as const;
        const version = documentSourceVersion(row);
        return staged.has(sourceIdentity(sourceType, row.id, version)) ? null : {
          sourceType,
          sourceId: row.id,
          sourceVersion: version,
          title: row.filename,
          roleLabel: roleLabel(row.role_key),
          updatedAt: isoDate(row.created_at),
          preview: row.extracted_text.slice(0, 280),
        };
      }),
    ].filter((candidate): candidate is GrowthPartnerLegacyKnowledgeCandidate => candidate !== null);

    return {
      candidates,
      imports: imported.rows.map((row) => ({
        id: row.id,
        sourceType: row.source_type,
        sourceId: row.source_record_id,
        sourceVersion: row.source_version,
        roleLabel: roleLabel(row.source_role_key),
        title: row.title,
        status: row.status,
        createdAt: isoDate(row.created_at),
        reviewedAt: row.reviewed_at ? isoDate(row.reviewed_at) : null,
      })),
    };
  });
}

/** Loads full source text only after an authorized owner/admin asks to preview it. */
export async function previewGrowthPartnerLegacyKnowledge(ctx: OrgContext, rawInput: unknown) {
  assertCanManage(ctx);
  const input = previewInputSchema.parse(rawInput);
  return withUser(ctx.user.id, async (db) => {
    const partner = (await db.query<{ id: string }>(
      "select id from ai_growth_partners where org_id = $1",
      [ctx.org.orgId],
    )).rows[0];
    if (!partner) throw new AppError("not_found", "Set up the AI Growth Partner before previewing legacy knowledge.");

    if (input.kind === "import") {
      const row = (await db.query<{ id: string; title: string; content: string; status: string }>(
        `select id, title, content, status from ai_growth_partner_legacy_knowledge
         where id = $1 and org_id = $2 and partner_id = $3`,
        [input.importId, ctx.org.orgId, partner.id],
      )).rows[0];
      if (!row) throw new AppError("not_found", "That retained knowledge snapshot is no longer available.");
      return { title: row.title, content: row.content, status: row.status };
    }

    if (input.sourceType === "employee_note") {
      const row = (await db.query<NoteRow>(
        `select e.id, a.role_key, e.title, e.content, e.version, e.updated_at
         from employee_knowledge_entries e
         join agent_instances a on a.id = e.agent_instance_id and a.org_id = e.org_id
         where e.id = $1 and e.org_id = $2 and a.role_key = any($3::text[])
           and e.status = 'approved' and cardinality(e.risk_flags) = 0 and e.content <> ''`,
        [input.sourceId, ctx.org.orgId, AGENT_ROLE_KEYS],
      )).rows[0];
      if (!row) throw new AppError("not_found", "That approved, risk-free profile note is no longer available.");
      return { title: `${roleLabel(row.role_key)} · ${row.title}`, content: row.content, status: "available" };
    }

    const row = (await db.query<DocumentRow>(
      `select d.id, a.role_key, d.filename, d.sha256, d.processed_at, left(d.extracted_text, 3000) as extracted_text, d.created_at
       from knowledge_documents d
       left join agent_instances a on a.id = d.agent_instance_id and a.org_id = d.org_id
       where d.id = $1 and d.org_id = $2 and d.status = 'ready'
         and d.extracted_text is not null and d.extracted_text <> '' and d.applied_at is not null
         and cardinality(d.risk_flags) = 0 and (d.agent_instance_id is null or a.role_key = any($3::text[]))`,
      [input.sourceId, ctx.org.orgId, AGENT_ROLE_KEYS],
    )).rows[0];
    if (!row) throw new AppError("not_found", "That released, risk-free reference document is no longer available.");
    return { title: `${roleLabel(row.role_key)} · ${row.filename} (runtime excerpt)`, content: row.extracted_text, status: "available" };
  });
}

/** Copies safe source snapshots into a review queue. It never changes legacy profiles or enables runtime use. */
export async function importGrowthPartnerLegacyKnowledge(ctx: OrgContext, rawInput: unknown) {
  assertCanManage(ctx);
  const input = importInputSchema.parse(rawInput);
  const identities = input.sources.map(({ sourceType, sourceId }) => `${sourceType}:${sourceId}`);
  if (new Set(identities).size !== identities.length) throw new AppError("invalid_input", "Choose each source only once.");

  return withSystem(async (db) => {
    const partnerId = await partnerIdFor(ctx, db);
    const notes = input.sources.filter((source) => source.sourceType === "employee_note");
    const documents = input.sources.filter((source) => source.sourceType === "reference_document");
    const noteRows = notes.length ? (await db.query<NoteRow>(
      `select e.id, a.role_key, e.title, e.content, e.version, e.updated_at
       from employee_knowledge_entries e
       join agent_instances a on a.id = e.agent_instance_id and a.org_id = e.org_id
       where e.org_id = $1 and a.role_key = any($2::text[]) and e.id = any($3::uuid[])
         and e.status = 'approved' and cardinality(e.risk_flags) = 0 and e.content <> ''`,
      [ctx.org.orgId, AGENT_ROLE_KEYS, notes.map((source) => source.sourceId)],
    )).rows : [];
    const documentRows = documents.length ? (await db.query<DocumentRow>(
      `select d.id, a.role_key, d.filename, d.sha256, d.processed_at, left(d.extracted_text, 3000) as extracted_text, d.created_at
       from knowledge_documents d
       left join agent_instances a on a.id = d.agent_instance_id and a.org_id = d.org_id
       where d.org_id = $1 and d.id = any($2::uuid[]) and d.status = 'ready'
         and d.extracted_text is not null and d.extracted_text <> '' and d.applied_at is not null
         and cardinality(d.risk_flags) = 0 and (d.agent_instance_id is null or a.role_key = any($3::text[]))`,
      [ctx.org.orgId, documents.map((source) => source.sourceId), AGENT_ROLE_KEYS],
    )).rows : [];
    if (noteRows.length !== notes.length || documentRows.length !== documents.length) {
      throw new AppError("conflict", "One or more selected sources are no longer eligible. Refresh the review list and try again.");
    }

    const sourceByIdentity = new Map(input.sources.map((source) => [`${source.sourceType}:${source.sourceId}`, source]));
    const rows = [
      ...noteRows.map((row) => ({
        sourceType: "employee_note" as const,
        sourceId: row.id,
        sourceVersion: noteSourceVersion(row.version),
        sourceRole: row.role_key,
        title: row.title,
        content: row.content,
        updatedAt: isoDate(row.updated_at),
      })),
      ...documentRows.map((row) => ({
        sourceType: "reference_document" as const,
        sourceId: row.id,
        sourceVersion: documentSourceVersion(row),
        sourceRole: row.role_key,
        title: row.filename,
        content: row.extracted_text,
        updatedAt: isoDate(row.created_at),
      })),
    ];
    for (const row of rows) {
      const submitted = sourceByIdentity.get(`${row.sourceType}:${row.sourceId}`);
      if (!submitted || submitted.sourceType !== row.sourceType || submitted.sourceId !== row.sourceId
        || submitted.sourceVersion !== row.sourceVersion) {
        throw new AppError("conflict", "A selected source changed while it was being prepared. Refresh and try again.");
      }
    }

    let imported = 0;
    const importedIds: string[] = [];
    for (const row of rows) {
      const inserted = await db.query<{ id: string }>(
        `insert into ai_growth_partner_legacy_knowledge
           (partner_id, org_id, source_type, source_record_id, source_version, source_role_key, title, content, status, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_review', $9)
         on conflict (org_id, partner_id, source_type, source_record_id, source_version) do nothing
         returning id`,
        [partnerId, ctx.org.orgId, row.sourceType, row.sourceId, row.sourceVersion, row.sourceRole, row.title, row.content, ctx.user.id],
      );
      if (inserted.rows[0]) {
        imported++;
        importedIds.push(inserted.rows[0].id);
      }
    }

    if (imported > 0) {
      await recordAudit({
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        action: "ai_growth_partner.legacy_knowledge_imported_for_review",
        targetType: "ai_growth_partner_legacy_knowledge",
        targetId: importedIds[0],
        result: "success",
        metadata: {
          importedCount: imported,
          sourceTypes: [...new Set(rows.map((row) => row.sourceType))],
          activeRuntimeChanged: false,
        },
      }, db);
    }
    return { imported, alreadyPresent: rows.length - imported };
  });
}

/** Approves or rejects a saved snapshot. Approved entries are included in the Partner's next context build. */
export async function reviewGrowthPartnerLegacyKnowledge(ctx: OrgContext, rawInput: unknown) {
  assertCanManage(ctx);
  const input = decisionInputSchema.parse(rawInput);
  return withSystem(async (db) => {
    const partnerId = await partnerIdFor(ctx, db);
    const row = (await db.query<{
      id: string;
      status: GrowthPartnerLegacyKnowledgeStatus;
      source_type: GrowthPartnerLegacyKnowledgeSourceType;
      source_record_id: string;
    }>(
      `select id, status, source_type, source_record_id from ai_growth_partner_legacy_knowledge
       where id = $1 and org_id = $2 and partner_id = $3 for update`,
      [input.importId, ctx.org.orgId, partnerId],
    )).rows[0];
    if (!row) throw new AppError("not_found", "That legacy knowledge snapshot is no longer available.");
    if (row.status === input.status) return { status: row.status, changed: false };

    const updated = await db.query(
      `update ai_growth_partner_legacy_knowledge set status = $4, reviewed_by = $5, reviewed_at = now()
       where id = $1 and org_id = $2 and partner_id = $3 returning id`,
      [row.id, ctx.org.orgId, partnerId, input.status, ctx.user.id],
    );
    if (!updated.rowCount) throw new AppError("conflict", "The knowledge review changed in another session. Refresh and try again.");
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: input.status === "approved" ? "ai_growth_partner.legacy_knowledge_approved" : "ai_growth_partner.legacy_knowledge_rejected",
      targetType: "ai_growth_partner_legacy_knowledge",
      targetId: row.id,
      result: "success",
      metadata: { sourceType: row.source_type, sourceId: row.source_record_id, status: input.status },
    }, db);
    return { status: input.status, changed: true };
  });
}
