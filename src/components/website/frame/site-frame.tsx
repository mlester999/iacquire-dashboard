import { notFound } from "next/navigation";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { findPage } from "@/lib/website/doc";
import { listAssets } from "@/server/assets/service";
import { AppError } from "@/server/errors";
import { getDraft, getVersionContent } from "@/server/websites/service";
import { studioContext } from "@/server/websites/studio-ctx";

/**
 * A client's draft (or one of its saved versions) drawn as a visitor would see it, inside an iframe. The client's own team sees their site;
 * an agency user sees it only for a client they are assigned to. Nothing here is public: it is never served on a customer host.
 *   org=<client id> (agency only)   v=<version id>   p=<page slug>   thumb=1
 */
export async function SiteFrame({ q, base }: { q: Record<string, string | undefined>; base: string }) {
  let content;
  let orgId: string | undefined = q.org && /^[0-9a-f-]{36}$/i.test(q.org) ? q.org : undefined;
  let assets: Awaited<ReturnType<typeof listAssets>> = [];
  try {
    const ctx = await studioContext(orgId, "website.view");
    orgId = orgId ?? undefined;
    if (q.v && /^[0-9a-f-]{36}$/i.test(q.v)) content = (await getVersionContent(ctx, q.v))?.content ?? null;
    else content = (await getDraft(ctx))?.content ?? null;
    assets = await listAssets(ctx);
  } catch (err) {
    if (err instanceof AppError) notFound();
    throw err;
  }
  if (!content) notFound();
  const page = findPage(content, q.p ?? "home")?.slug ?? "home";
  const thumb = q.thumb === "1";
  const byId = new Map(assets.map((a) => [a.id.toLowerCase(), a]));
  const suffix = orgId ? `?org=${orgId}` : "";
  const keep = `${orgId ? `&org=${orgId}` : ""}${q.v ? `&v=${q.v}` : ""}`;
  return (
    <div style={thumb ? { height: "100vh", overflow: "hidden", pointerEvents: "none", background: "#fff" } : { background: "#fff" }} aria-hidden={thumb ? true : undefined}>
      <SiteRenderer
        content={content} pageSlug={page} mode="preview" formAction={null} limitSections={thumb ? 4 : undefined} year={2026} hrefFor={(s) => `${base}?p=${s}${keep}`}
        resolveAsset={(id) => { const a = id ? byId.get(id.toLowerCase()) : null; return a ? { src: `/api/assets/${a.id}${suffix}`, width: a.width, height: a.height, alt: a.altText } : null; }}
      />
    </div>
  );
}
