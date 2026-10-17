"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createWebsiteForClientAction } from "@/app/actions/website-admin";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { TemplateGallery } from "@/components/website/gallery/template-gallery";
import type { GalleryCard } from "@/lib/website/gallery";

/** An agency user picks a design for a client who has no website yet. The first draft is built from that client's own details. */
export function CreateForClient({ orgId, clientName, cards, canCreate }: { orgId: string; clientName: string; cards: GalleryCard[]; canCreate: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const card = cards.find((c) => c.key === confirm);
  const create = async () => {
    if (!confirm) return;
    setBusy(true);
    const res = await createWebsiteForClientAction(orgId, confirm);
    if (!res.ok) {
      setBusy(false);
      return void toast.error(res.error);
    }
    router.push(`/admin/website-studio/websites/${orgId}`);
  };
  return (
    <>
      {!canCreate && <p className="rounded-xl bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">You can look at the designs, but your role can&apos;t create a website for this client.</p>}
      <TemplateGallery cards={cards} frameBase="/frame/template" onChoose={canCreate ? setConfirm : undefined} chooseLabel="Use for this client" />
      <Dialog
        open={confirm !== null} onOpenChange={(o) => !busy && !o && setConfirm(null)} size="sm" title={card ? `Start ${clientName} with ${card.name}?` : "Start the website"}
        description="A private first draft is written from the client's confirmed business details. Nothing goes live until it is published, and the client can edit everything."
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>Not yet</Button><Button variant="brand" loading={busy} onClick={() => void create()}>Create the website</Button></>}
      />
    </>
  );
}
