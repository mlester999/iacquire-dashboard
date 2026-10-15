import "server-only";
import { withSystem } from "@/server/db";
import { parseContent, type Design } from "@/lib/website/doc";
import { designChanges } from "@/lib/website/editor/template-update";
import { getDraft } from "@/server/websites/service";
import type { OrgContext } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";

export interface TemplateUpdate {
  templateName: string;
  fromVersion: number;
  toVersion: number;
  /** Only the look is offered: colours, fonts, shapes and spacing. Words, pictures and sections of the template never leave the agency. */
  design: Design;
}

/**
 * A website began as a copy of an agency template. When the agency has since published a newer version that changes its look, this returns
 * that look so the owner can preview it and choose to take it. It never returns the template's content, and never offers a template that is
 * no longer published.
 */
export async function templateUpdateFor(ctx: OrgContext): Promise<TemplateUpdate | null> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  const draft = await getDraft(ctx);
  const origin = draft?.content.origin;
  if (!draft || !origin?.templateId) return null;
  const row = (await withSystem((db) => db.query<{ name: string; version: number; content: unknown }>(
    "select name, version, content from website_templates where id = $1 and kind = 'custom' and status = 'published' and content is not null", [origin.templateId]))).rows[0];
  if (!row || row.version <= origin.version) return null;
  const parsed = parseContent(row.content);
  if (!parsed.ok) return null;
  if (designChanges(draft.content.design, parsed.content.design).length === 0) return null;
  return { templateName: row.name, fromVersion: origin.version, toVersion: row.version, design: parsed.content.design };
}
