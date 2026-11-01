import { requireOrgContext } from "@/server/tenancy/context";
import { ACCEPTED_UPLOADS, getKnowledge, KNOWLEDGE_SECTIONS } from "@/server/knowledge/service";
import { loadKnowledgeHistoryAction, restoreKnowledgeRevisionAction } from "@/app/actions/knowledge";
import { KnowledgeCenter } from "@/components/knowledge/knowledge-center";

export const metadata = { title: "Knowledge Center" };

export default async function KnowledgePage() {
  const ctx = await requireOrgContext("knowledge.view");
  const data = await getKnowledge(ctx);
  return (
    <KnowledgeCenter
      sections={KNOWLEDGE_SECTIONS.map((s) => {
        const row = data.sections.find((r) => r.section === s.key);
        return {
          ...s,
          content: row?.content ?? "",
          version: row?.version ?? 0,
          updatedAt: row ? new Date(row.updated_at).toISOString() : null,
          appliedAt: row?.applied_at ? new Date(row.applied_at).toISOString() : null,
          held: row?.review_status === "pending_agency_review",
          pendingContent: row?.pending_content ?? null,
          updatedBy: row?.updated_by_name ?? null,
        };
      })}
      documents={JSON.parse(JSON.stringify(data.documents))}
      canEdit={ctx.can("knowledge.edit")}
      loadHistory={loadKnowledgeHistoryAction}
      restoreRevision={restoreKnowledgeRevisionAction}
      accept={ACCEPTED_UPLOADS}
      timeZone={ctx.org.timezone}
    />
  );
}
