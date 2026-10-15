"use client";

import * as React from "react";
import { TemplateGallery } from "@/components/website/gallery/template-gallery";
import type { GalleryCard } from "@/lib/website/gallery";

/** The gallery with a stand-in "choose" so selection can be tried without creating anything. */
export default function GalleryPreviewClient({ cards, industry }: { cards: GalleryCard[]; industry?: string }) {
  const [chosen, setChosen] = React.useState<string | null>(null);
  return (
    <>
      <TemplateGallery cards={cards} frameBase="/dev/frame/template" preferIndustry={industry} onChoose={setChosen} chooseLabel="Use this template" />
      {chosen && <p role="status" className="fixed bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-full bg-warning-soft px-4 py-2 text-[12px] font-medium text-warning-ink shadow-lg">Preview only: “{chosen}” was chosen, and nothing was created.</p>}
    </>
  );
}
