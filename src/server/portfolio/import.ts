import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import { AppError } from "@/server/errors";
import founderPortfolio from "../../../content/founder-portfolio.json";

const projectSchema = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/),
  title: z.string().min(2).max(200),
  anonymizedTitle: z.string().max(200).nullable(),
  clientNamePublic: z.boolean(),
  summary: z.string().max(1200),
  problem: z.string().max(4000),
  solution: z.string().max(4000),
  publishedOutcome: z.string().max(600).nullable(),
  privacyNote: z.string().max(600).nullable(),
  limitations: z.array(z.string().max(300)),
  featured: z.boolean(),
  sortOrder: z.number().int(),
  services: z.array(z.string()),
  sections: z.array(z.object({ heading: z.string(), body: z.string().optional(), items: z.array(z.string()).optional() })),
  technologies: z.array(z.string()),
  categories: z.array(z.string()),
  status: z.enum(["built", "in_development", "built_locally", "planned"]),
  statusLabel: z.string().nullable(),
  sourceUrl: z.string().url().regex(/^https:\/\/www\.automatewithmarky\.com\//),
  assets: z.array(z.object({ sourceUrl: z.string().url().regex(/^https:\/\/www\.automatewithmarky\.com\//), alt: z.string().max(300), kind: z.enum(["cover", "screenshot"]) })),
});
const fileSchema = z.object({ attribution: z.string(), projects: z.array(projectSchema) });

export interface ImportResult {
  created: number;
  refreshed: number;
  untouched: number;
  assetsAdded: number;
  linksAdded: number;
}

/**
 * Loads the verified founder-portfolio content into the iAcquire content system.
 * Idempotent and conservative: new projects arrive as "pending review" and hidden; a project an admin
 * has already approved is never overwritten (only missing image references and links are added).
 */
export async function importFounderPortfolio(db: Queryable, actorId: string | null = null): Promise<ImportResult> {
  const file = fileSchema.parse(founderPortfolio);
  const result: ImportResult = { created: 0, refreshed: 0, untouched: 0, assetsAdded: 0, linksAdded: 0 };
  for (const p of file.projects) {
    const existing = (await db.query<{ id: string; review_state: string }>("select id, review_state from portfolio_projects where slug = $1", [p.slug])).rows[0];
    const fields = [p.title, p.anonymizedTitle, p.clientNamePublic, p.summary, p.problem, p.solution, p.publishedOutcome, JSON.stringify(p.sections), p.limitations, p.privacyNote, p.technologies, p.categories, p.status, p.statusLabel, file.attribution, p.sourceUrl, p.featured, p.sortOrder];
    let id: string;
    if (!existing) {
      id = (await db.query<{ id: string }>(
        `insert into portfolio_projects (slug,title,anonymized_title,client_name_public,summary,problem,solution,published_outcome,sections,limitations,privacy_note,technologies,categories,
           project_status,status_label,attribution,source_url,featured,sort_order,source_imported_at,created_by,updated_by,review_state,visible,disclosure_confirmed)
         values ($19,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),$20,$20,'pending_review',false,false) returning id`,
        [...fields, p.slug, actorId],
      )).rows[0].id;
      result.created++;
    } else if (existing.review_state === "pending_review") {
      id = existing.id;
      await db.query(
        `update portfolio_projects set title=$1,anonymized_title=$2,client_name_public=$3,summary=$4,problem=$5,solution=$6,published_outcome=$7,sections=$8::jsonb,limitations=$9,
           privacy_note=$10,technologies=$11,categories=$12,project_status=$13,status_label=$14,attribution=$15,source_url=$16,featured=$17,sort_order=$18,source_imported_at=now() where id=$19`,
        [...fields, id],
      );
      result.refreshed++;
    } else {
      id = existing.id;
      result.untouched++;
    }
    for (const [i, a] of p.assets.entries()) {
      const r = await db.query("insert into portfolio_assets (project_id, kind, source_url, alt, sort_order, created_by) select $1,$2,$3,$4,$5,$6 where not exists (select 1 from portfolio_assets where project_id = $1 and source_url = $3)", [id, a.kind, a.sourceUrl, a.alt, (i + 1) * 10, actorId]);
      result.assetsAdded += r.rowCount ?? 0;
    }
    for (const [i, slug] of p.services.entries()) {
      const r = await db.query("insert into service_portfolio_links (service_id, project_id, sort_order) select s.id, $1, $3 from service_catalog s where s.slug = $2 on conflict do nothing", [id, slug, i]);
      result.linksAdded += r.rowCount ?? 0;
    }
  }
  await recordAudit({ actorUserId: actorId, actorKind: actorId ? "agency" : "system", action: "portfolio.import_run", targetType: "portfolio_project", result: "success", metadata: { ...result } }, db);
  return result;
}

export async function runPortfolioImport(user: SessionUser): Promise<ImportResult> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only agency super admins can import portfolio content.");
  return withSystem((db) => importFounderPortfolio(db, user.id));
}
