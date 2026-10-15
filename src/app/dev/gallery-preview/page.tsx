import { notFound } from "next/navigation";
import { builtInCards } from "@/lib/website/gallery-data";
import { env } from "@/server/env";
import GalleryPreviewClient from "./client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Template gallery preview" };

/** Development only (404 in production): the template gallery with no sign-in, so it can be reviewed in a browser. ?industry=real-estate leads with that sector. */
export default async function GalleryPreview({ searchParams }: { searchParams: Promise<{ industry?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { industry } = await searchParams;
  return (
    <main className="mx-auto max-w-[1500px] space-y-6 p-4 sm:p-8">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Template gallery</p>
        <h1 className="mt-1 text-[28px] font-semibold tracking-tight">Choose a design</h1>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">Each design below is a complete, editable website. Preview it on desktop, tablet and phone, then make it yours.</p>
      </header>
      <GalleryPreviewClient cards={builtInCards()} industry={industry} />
    </main>
  );
}
