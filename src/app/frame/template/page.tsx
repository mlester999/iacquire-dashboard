import type { Metadata } from "next";
import { TemplateFrame } from "@/components/website/frame/template-frame";
import { requireUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Template preview", robots: { index: false, follow: false } };

/** A template's sample site, for the gallery's thumbnails and previews. Signed-in users only; shown inside the portal's own pages. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await requireUser();
  return <TemplateFrame q={await searchParams} base="/frame/template" viewer={viewer} />;
}
