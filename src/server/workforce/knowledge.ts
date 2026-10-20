import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import {
  compileKnowledgeSections,
  detectRiskFlags,
  sanitizeClientText,
  type KnowledgeSection,
} from "@/server/workforce/compiler";
import type { OrgContext } from "@/server/tenancy/context";

const MAX_ENTRIES = 20;
const MAX_DOCUMENTS = 8;
const TITLE_MAX = 160;
const CONTENT_MAX = 40_000;

export interface EmployeeKnowledgeEntry {
  id: string;
  title: string;
  content: string;
  status: "approved" | "pending_agency_review" | "rejected" | "archived";
  version: number;
  risk_flags: string[];
  updated_at: Date;
  created_at: Date;
  last_used_at: Date | null;
  updated_by_name: string | null;
}

export interface EmployeeKnowledgeDocument {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: Date;
  applied_at: Date | null;
  last_used_at: Date | null;
  /** True only when usable text was extracted and released (not held for review). */
  searchable: boolean;
  risk_flags: string[];
  agent_instance_id: string | null;
  processing_detail: string | null;
  extraction_method: string | null;
  processed_at: Date | null;
  uploaded_by_name: string | null;
}

export interface EmployeeKnowledgeView {
  entries: EmployeeKnowledgeEntry[];
  documents: EmployeeKnowledgeDocument[];
  retrieval: {
    includedEntryIds: string[];
    includedDocumentIds: string[];
    truncated: boolean;
    characters: number;
  };
}

/** Verifies the employee belongs to the active workspace using the caller's own row-level access. */
async function assertEmployee(ctx: OrgContext, agentId: string) {
  const found = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; role_key: string }>(
      "select id, role_key from agent_instances where id = $1 and org_id = $2",
      [agentId, ctx.org.orgId],
    );
    return rows[0];
  });
  if (!found) throw new AppError("not_found", "AI employee not found.");
  return found;
}

/**
 * The exact knowledge block appended to this employee's run instructions. Shared organization knowledge comes
 * first, then employee notes, then uploaded reference documents; a single character budget applies to all three.
 * The same function powers the UI's retrieval check, so "used in the next conversation" is derived, not asserted.
 */
export async function employeeKnowledgeContext(db: Queryable, orgId: string, agentId: string): Promise<{
  block: string;
  entryIds: string[];
  documentIds: string[];
  truncated: boolean;
}> {
  // One transaction, one pooled connection. node-postgres queues statements on a single client, so
  // Promise.all over these three reads never overlapped any work — it only made the statements
  // depend on the driver's internal queue, which pg 8 deprecates ("calling client.query() when the
  // client is already executing a query") and pg 9 removes. The reads are issued in order instead;
  // the row limits (20 notes, 8 documents) keep the whole block to three round trips.
  const { rows: orgKnowledge } = await db.query<{ section: string; content: string }>(
    "select section, content from company_knowledge where org_id = $1 and review_status = 'approved' and content <> '' order by section",
    [orgId],
  );
  const { rows: entries } = await db.query<{ id: string; title: string; content: string }>(
    `select id, title, content from employee_knowledge_entries
       where org_id = $1 and agent_instance_id = $2 and status = 'approved' and content <> ''
       order by updated_at desc limit $3`,
    [orgId, agentId, MAX_ENTRIES],
  );
  const { rows: docs } = await db.query<{ id: string; filename: string; excerpt: string }>(
    `select id, filename, left(extracted_text, 3000) as excerpt from knowledge_documents
       where org_id = $1 and (agent_instance_id is null or agent_instance_id = $2)
         and status = 'ready' and extracted_text is not null and applied_at is not null
       order by (agent_instance_id is not null) desc, created_at desc limit $3`,
    [orgId, agentId, MAX_DOCUMENTS],
  );
  const sections: KnowledgeSection[] = [
    ...orgKnowledge.map((k) => ({ section: k.section, content: k.content })),
    ...entries.map((e) => ({ id: `entry:${e.id}`, section: "employee_note", label: `Employee note: ${e.title}`, content: e.content })),
    ...docs.map((d) => ({ id: `document:${d.id}`, section: "reference_document", label: `Reference document: ${d.filename}`, content: d.excerpt })),
  ];
  const compiled = compileKnowledgeSections(sections);
  return {
    block: compiled.text,
    entryIds: entries.map((e) => e.id).filter((id) => compiled.included.includes(`entry:${id}`)),
    documentIds: docs.map((d) => d.id).filter((id) => compiled.included.includes(`document:${id}`)),
    truncated: compiled.truncated,
  };
}

export async function listEmployeeKnowledge(ctx: OrgContext, agentId: string): Promise<EmployeeKnowledgeView> {
  await assertEmployee(ctx, agentId);
  return withUser(ctx.user.id, async (db) => {
    const { rows: entries } = await db.query<EmployeeKnowledgeEntry>(
      `select e.id, e.title, e.content, e.status, e.version, e.risk_flags, e.updated_at, e.created_at, e.last_used_at,
              u.full_name as updated_by_name
       from employee_knowledge_entries e left join users u on u.id = e.updated_by
       where e.org_id = $1 and e.agent_instance_id = $2 and e.status <> 'archived'
       order by e.updated_at desc limit 100`,
      [ctx.org.orgId, agentId],
    );
    const { rows: documents } = await db.query<EmployeeKnowledgeDocument>(
      `select d.id, d.filename, d.mime_type, d.size_bytes, d.status, d.created_at, d.applied_at, d.last_used_at,
              (d.extracted_text is not null and d.applied_at is not null) as searchable,
              d.risk_flags, d.agent_instance_id, d.processing_detail, d.extraction_method, d.processed_at,
              u.full_name as uploaded_by_name
       from knowledge_documents d left join users u on u.id = d.uploaded_by
       where d.org_id = $1 and d.status <> 'deleted' and (d.agent_instance_id is null or d.agent_instance_id = $2)
       order by (d.agent_instance_id is not null) desc, d.created_at desc`,
      [ctx.org.orgId, agentId],
    );
    // Use the exact same composition as buildRunInstructions, including the organization knowledge block and the
    // shared character budget, so the retrieval check cannot claim more than the provider will receive.
    const context = await employeeKnowledgeContext(db, ctx.org.orgId, agentId);
    return {
      entries,
      documents,
      retrieval: {
        includedEntryIds: context.entryIds,
        includedDocumentIds: context.documentIds,
        truncated: context.truncated,
        characters: context.block.length,
      },
    };
  });
}

function cleanTitle(value: string) {
  return sanitizeClientText(value, TITLE_MAX).replace(/\s+/g, " ").trim();
}

export async function saveEmployeeKnowledgeEntry(
  ctx: OrgContext,
  agentId: string,
  input: { id?: string | null; title: string; content: string },
): Promise<{ id: string; status: string; version: number; held: boolean }> {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and managers can edit employee knowledge.");
  await assertEmployee(ctx, agentId);
  const title = cleanTitle(input.title);
  const content = sanitizeClientText(input.content, CONTENT_MAX);
  if (!title) throw new AppError("invalid_input", "Give this knowledge note a title.");
  if (!content) throw new AppError("invalid_input", "Write the information the employee should know.");
  const flags = detectRiskFlags(title, content);
  const status = flags.length ? "pending_agency_review" : "approved";

  const saved = await withUser(ctx.user.id, async (db) => {
    if (input.id) {
      const { rows: existing } = await db.query<{ id: string; version: number }>(
        "select id, version from employee_knowledge_entries where id = $1 and org_id = $2 and agent_instance_id = $3 and status <> 'archived'",
        [input.id, ctx.org.orgId, agentId],
      );
      if (!existing[0]) throw new AppError("not_found", "That knowledge note no longer exists.");
      const { rows: duplicate } = await db.query(
        "select 1 from employee_knowledge_entries where agent_instance_id = $1 and lower(title) = lower($2) and status <> 'archived' and id <> $3",
        [agentId, title, input.id],
      );
      if (duplicate.length) throw new AppError("conflict", "That employee already has a note with this title.");
      const { rows } = await db.query<{ id: string; version: number }>(
        `update employee_knowledge_entries
         set title = $2, content = $3, status = $4, risk_flags = $5, version = version + 1, updated_by = $6
         where id = $1 and org_id = $7 and agent_instance_id = $8 returning id, version`,
        [input.id, title, content, status, flags, ctx.user.id, ctx.org.orgId, agentId],
      );
      return { id: rows[0].id, status, version: rows[0].version };
    }
    const { rows: duplicate } = await db.query(
      "select 1 from employee_knowledge_entries where agent_instance_id = $1 and lower(title) = lower($2) and status <> 'archived'",
      [agentId, title],
    );
    if (duplicate.length) throw new AppError("conflict", "That employee already has a note with this title.");
    const { rows } = await db.query<{ id: string; version: number }>(
      `insert into employee_knowledge_entries (org_id, agent_instance_id, title, content, status, risk_flags, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7) returning id, version`,
      [ctx.org.orgId, agentId, title, content, status, flags, ctx.user.id],
    );
    return { id: rows[0].id, status, version: rows[0].version };
  });

  await withSystem(async (db) => {
    await recordAudit(
      {
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        agentInstanceId: agentId,
        action: input.id ? "agent.knowledge_note_updated" : "agent.knowledge_note_created",
        targetType: "employee_knowledge_entry",
        targetId: saved.id,
        result: "success",
        metadata: { held: flags.length > 0, flags, version: saved.version },
      },
      db,
    );
    if (flags.length) {
      await notifyAgency(db, ctx.org.orgId, {
        kind: "knowledge_update_ready",
        severity: "warning",
        title: `${ctx.org.name}: an employee knowledge note needs review`,
        body: `“${title}” was held because it may conflict with AI safety policy.`,
        link: `/admin/clients/${ctx.org.orgId}`,
      });
    }
  });
  return { ...saved, held: flags.length > 0 };
}

export async function archiveEmployeeKnowledgeEntry(ctx: OrgContext, agentId: string, entryId: string) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and managers can edit employee knowledge.");
  await assertEmployee(ctx, agentId);
  const { rowCount } = await withUser(ctx.user.id, (db) =>
    db.query(
      `update employee_knowledge_entries set status = 'archived', version = version + 1, updated_by = $4
       where id = $1 and org_id = $2 and agent_instance_id = $3 and status <> 'archived'`,
      [entryId, ctx.org.orgId, agentId, ctx.user.id],
    ),
  );
  if (!rowCount) throw new AppError("not_found", "That knowledge note no longer exists.");
  await withSystem((db) =>
    recordAudit(
      {
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        agentInstanceId: agentId,
        action: "agent.knowledge_note_archived",
        targetType: "employee_knowledge_entry",
        targetId: entryId,
        result: "success",
      },
      db,
    ),
  );
}

async function documentAndEmployee(agentId: string, documentId: string, orgId: string) {
  return withSystem(async (db) => {
    const { rows: agents } = await db.query("select 1 from agent_instances where id = $1 and org_id = $2", [agentId, orgId]);
    if (!agents[0]) throw new AppError("not_found", "AI employee not found.");
    const { rows: docs } = await db.query<{ id: string; agent_instance_id: string | null }>(
      "select id, agent_instance_id from knowledge_documents where id = $1 and org_id = $2 and status = 'ready'",
      [documentId, orgId],
    );
    if (!docs[0]) throw new AppError("not_found", "Document not found.");
    return docs[0];
  });
}

export async function assignKnowledgeDocument(ctx: OrgContext, agentId: string, documentId: string) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and managers can assign documents.");
  const doc = await documentAndEmployee(agentId, documentId, ctx.org.orgId);
  if (doc.agent_instance_id && doc.agent_instance_id !== agentId) {
    throw new AppError("conflict", "This document already belongs to another employee. Return it to the shared library first.");
  }
  await withSystem((db) =>
    db.query("update knowledge_documents set agent_instance_id = $3 where id = $1 and org_id = $2 and status = 'ready'", [
      documentId,
      ctx.org.orgId,
      agentId,
    ]),
  );
  await withSystem((db) =>
    recordAudit(
      {
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        agentInstanceId: agentId,
        action: "knowledge.document_assigned",
        targetType: "knowledge_document",
        targetId: documentId,
        result: "success",
      },
      db,
    ),
  );
}

export async function unassignKnowledgeDocument(ctx: OrgContext, agentId: string, documentId: string) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and managers can change documents.");
  const doc = await documentAndEmployee(agentId, documentId, ctx.org.orgId);
  if (doc.agent_instance_id !== agentId) throw new AppError("conflict", "This document isn't assigned to that employee.");
  await withSystem((db) =>
    db.query("update knowledge_documents set agent_instance_id = null where id = $1 and org_id = $2 and status = 'ready'", [documentId, ctx.org.orgId]),
  );
  await withSystem((db) =>
    recordAudit(
      {
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        agentInstanceId: agentId,
        action: "knowledge.document_unassigned",
        targetType: "knowledge_document",
        targetId: documentId,
        result: "success",
      },
      db,
    ),
  );
}

/**
 * Records that a provider accepted a run whose instructions included these sources. Called only after POST /v1/runs
 * succeeds; a failed start never marks anything as used.
 */
export async function markEmployeeKnowledgeUsed(db: Queryable, orgId: string, agentId: string, entryIds: string[], documentIds: string[]) {
  if (entryIds.length) {
    await db.query(
      "update employee_knowledge_entries set last_used_at = now() where org_id = $1 and agent_instance_id = $2 and id = any($3::uuid[]) and status = 'approved'",
      [orgId, agentId, entryIds],
    );
  }
  if (documentIds.length) {
    await db.query(
      "update knowledge_documents set last_used_at = now() where org_id = $1 and (agent_instance_id is null or agent_instance_id = $2) and id = any($3::uuid[])",
      [orgId, agentId, documentIds],
    );
  }
}
