"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createWebsiteAction } from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { TemplateGallery } from "@/components/website/gallery/template-gallery";
import type { GalleryCard } from "@/lib/website/gallery";

/**
 * Choosing a design creates a private draft built from the business details already given. Nothing is published, and the design is a starting
 * point: every part of it can be changed in the editor afterwards.
 */
export function NewWebsite({ cards, preferIndustry }: { cards: GalleryCard[]; preferIndustry?: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const card = cards.find((c) => c.key === confirm);
  const create = async () => {
    if (!confirm) return;
    setBusy(true);
    const res = await createWebsiteAction(confirm);
    if (!res.ok) {
      setBusy(false);
      return void toast.error(res.error);
    }
    router.push("/website/edit");
  };
  return (
    <>
      <TemplateGallery cards={cards} frameBase="/frame/template" preferIndustry={preferIndustry} onChoose={setConfirm} chooseLabel="Use this template" />
      <Dialog
        open={confirm !== null} onOpenChange={(o) => !busy && !o && setConfirm(null)} size="sm" title={card ? `Start with ${card.name}?` : "Start your website"}
        description="We'll write a private first draft from your business details, with this design. Nothing goes live until you publish, and you can change every part of it."
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>Not yet</Button><Button variant="brand" loading={busy} onClick={() => void create()}>Create my website</Button></>}
      >
        <ul className="list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-2">
          <li>Your business name, services, contact details and colours are filled in for you.</li>
          <li>Pictures start as built-in artwork. You&apos;ll swap in your own before you publish.</li>
          <li>You can rearrange, add or remove anything, and even start again from another design later.</li>
        </ul>
      </Dialog>
    </>
  );
}
