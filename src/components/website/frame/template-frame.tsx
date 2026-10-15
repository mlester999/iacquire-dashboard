import { notFound } from "next/navigation";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { findPage } from "@/lib/website/doc";
import { resolveTemplate, sampleSite } from "@/lib/website/templates";
import type { SessionUser } from "@/server/auth/service";
import { isCustomKey, templateContentForFrame } from "@/server/websites/templates";

/**
 * A bare page that draws one template, with its sample content, using the same renderer as a published site. It is shown inside an iframe in the
 * gallery, so a template's styles can never touch the portal around it, and previews are real pages a visitor could navigate.
 *   key=family.variation or custom.name   p=page slug   thumb=1 (a still of the top of the home page, not interactive)
 *   draft=1 (the agency's working copy of its own template; ignored for anyone else)
 */
export async function TemplateFrame({ q, base, viewer }: { q: Record<string, string | undefined>; base: string; viewer: SessionUser | null }) {
  const key = q.key ?? "";
  const custom = isCustomKey(key);
  const content = custom ? await templateContentForFrame(key, { agency: viewer, draft: q.draft === "1" }) : resolveTemplate(key) ? sampleSite(key) : null;
  if (!content) notFound();
  const page = findPage(content, q.p ?? "home")?.slug ?? "home";
  const thumb = q.thumb === "1";
  const qs = (slug: string) => `${base}?key=${encodeURIComponent(key)}&p=${slug}${q.draft === "1" ? "&draft=1" : ""}`;
  return (
    <div style={thumb ? { height: "100vh", overflow: "hidden", pointerEvents: "none", background: "#fff" } : { background: "#fff" }} aria-hidden={thumb ? true : undefined} data-template-frame={key}>
      <SiteRenderer content={content} pageSlug={page} resolveAsset={() => null} mode="preview" formAction={null} hrefFor={qs} limitSections={thumb ? 4 : undefined} year={2026} />
    </div>
  );
}
