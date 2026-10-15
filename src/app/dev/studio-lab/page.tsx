import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { Art } from "@/components/website/render/art";
import { ART_SCENES } from "@/lib/website/art-keys";
import { ALL_TEMPLATE_KEYS, DEFAULT_TEMPLATE_KEY, resolveTemplate, sampleSite } from "@/lib/website/templates/index";

export const dynamic = "force-dynamic";
export const metadata = { title: "Website Studio lab" };

/**
 * Development only (404 in production): any template on its sample business, at any width.
 *   ?t=meridian.estate&p=home&w=390     one template, one page, in a frame of that width
 *   ?list=1                              every template key
 */
export default async function Lab({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  if (q.art) {
    const tone = (["warm", "cool", "dark", "light", "auto"].includes(q.tone ?? "") ? q.tone : "auto") as "warm";
    return (
      <div className="iq-site" style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, background: "#222", ["--c-primary" as string]: "#3a6a58", ["--c-accent" as string]: "#d6a85c" }}>
        {ART_SCENES.map((sc) => (
          <figure key={sc.key} style={{ margin: 0, color: "#ddd", font: "12px system-ui" }}>
            <div style={{ aspectRatio: "16 / 10", position: "relative", overflow: "hidden", borderRadius: 6 }}><Art scene={sc.key} tone={tone} seed={Number(q.seed) || 0} className="iq-fill" /></div>
            <figcaption style={{ padding: "4px 0" }}>{sc.key} · {sc.kind}</figcaption>
          </figure>
        ))}
      </div>
    );
  }
  if (q.list) return <pre style={{ padding: 24 }}>{ALL_TEMPLATE_KEYS().join("\n")}</pre>;
  const key = resolveTemplate(q.t ?? "")?.key ?? DEFAULT_TEMPLATE_KEY;
  const content = sampleSite(key);
  const w = Number(q.w) || 0;
  const page = content.pages.find((p) => p.slug === (q.p ?? "home"))?.slug ?? "home";
  return (
    <div style={{ background: "#d9dbe0", minHeight: "100vh", padding: w ? 16 : 0 }}>
      <div style={{ width: w || "100%", margin: "0 auto", background: "#fff" }}>
        <SiteRenderer content={content} pageSlug={page} resolveAsset={() => null} mode="preview" formAction={null} hrefFor={(s) => `?t=${key}&p=${s}${w ? `&w=${w}` : ""}`} embedded viewportHeight={w ? (w < 500 ? 780 : 900) : 900} />
      </div>
    </div>
  );
}
