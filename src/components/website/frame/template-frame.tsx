import { notFound } from "next/navigation";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { findPage } from "@/lib/website/doc";
import { resolveTemplate, sampleSite } from "@/lib/website/templates";

/**
 * A bare page that draws one template, with its sample content, using the same renderer as a published site. It is shown inside an iframe in the
 * gallery, so a template's styles can never touch the portal around it, and previews are real pages a visitor could navigate.
 *   key=family.variation   p=page slug   thumb=1 (a still of the top of the home page, not interactive)
 */
export function TemplateFrame({ q, base }: { q: Record<string, string | undefined>; base: string }) {
  const t = resolveTemplate(q.key ?? "");
  if (!t) notFound();
  const content = sampleSite(t.key);
  const page = findPage(content, q.p ?? "home")?.slug ?? "home";
  const thumb = q.thumb === "1";
  return (
    <div style={thumb ? { height: "100vh", overflow: "hidden", pointerEvents: "none", background: "#fff" } : { background: "#fff" }} aria-hidden={thumb ? true : undefined} data-template-frame={t.key}>
      <SiteRenderer
        content={content} pageSlug={page} resolveAsset={() => null} mode="preview" formAction={null} hrefFor={(s) => `${base}?key=${encodeURIComponent(t.key)}&p=${s}`}
        limitSections={thumb ? 4 : undefined} year={2026}
      />
    </div>
  );
}
