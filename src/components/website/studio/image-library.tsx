"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, ImagePlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { setAssetAltAction } from "@/app/actions/onboarding";
import { useOnboardingApi } from "@/components/onboarding/onboarding-api";
import type { AssetView } from "@/server/assets/service";
import { cn } from "@/lib/utils";

/** The workspace's brand images: choose one for the page, upload another, and describe it for people who can't see it. */
export function ImageLibrary({
  open, onClose, assets, onAssetsChange, current, onPick,
}: {
  open: boolean; onClose: () => void; assets: AssetView[]; onAssetsChange: (next: AssetView[]) => void; current: string | null; onPick: (id: string | null) => void;
}) {
  const api = useOnboardingApi();
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(current);
  const [alt, setAlt] = React.useState("");
  const input = React.useRef<HTMLInputElement>(null);
  const chosen = assets.find((a) => a.id === selected);

  const choose = (id: string) => {
    setSelected(id);
    setAlt(assets.find((a) => a.id === id)?.altText ?? "");
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    let next = assets;
    let last: string | null = null;
    for (const file of Array.from(files)) {
      const res = await api.uploadImage("image", file);
      if (!res.ok) toast.error(res.error);
      else {
        next = [res.data, ...next.filter((a) => a.id !== res.data.id)];
        last = res.data.id;
      }
    }
    onAssetsChange(next);
    if (last) {
      setSelected(last);
      setAlt("");
    }
    setBusy(false);
    if (input.current) input.current.value = "";
  };

  const confirm = async () => {
    if (!chosen) return;
    if (alt.trim() !== chosen.altText) {
      const res = await setAssetAltAction(chosen.id, alt);
      if (!res.ok) return void toast.error(res.error);
      onAssetsChange(assets.map((a) => (a.id === chosen.id ? { ...a, altText: alt.trim() } : a)));
    }
    onPick(chosen.id);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Choose an image"
      description="Use your own photos. Add a short description so people using screen readers know what the picture shows."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" disabled={!chosen} onClick={() => void confirm()}>
            Use this image
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <input ref={input} id="image-library-upload" type="file" className="sr-only" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => void upload(e.target.files)} />
          <label htmlFor="image-library-upload" className={cn("flex cursor-pointer items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong bg-surface-2/50 px-4 py-5 text-[13.5px] font-medium hover:border-primary/50 focus-within:outline-2 focus-within:outline-primary", busy && "pointer-events-none opacity-70")}>
            {busy ? <Loader2 className="size-4 animate-spin text-primary" /> : <ImagePlus className="size-4 text-primary" />}
            {busy ? "Uploading…" : "Upload photos (PNG, JPG or WebP, up to 10 MB)"}
          </label>
        </div>
        {assets.length === 0 ? (
          <p className="text-center text-[13.5px] text-muted">You haven&apos;t uploaded any images yet.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Your images">
            {assets.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected === a.id}
                  onClick={() => choose(a.id)}
                  className={cn("relative block w-full overflow-hidden rounded-xl border bg-surface p-1.5 text-left transition focus-visible:outline-2 focus-visible:outline-primary", selected === a.id ? "border-primary ring-2 ring-primary/25" : "border-line hover:border-line-strong")}
                >
                  <span className="checkerboard flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg">
                    {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated image route */}
                    <img src={a.useVariant === "processed" && a.processedUrl ? a.processedUrl : a.url} alt={a.altText || `${a.kind} image`} className="max-h-full max-w-full object-contain" />
                  </span>
                  <span className="mt-1.5 flex items-center justify-between gap-1 px-1 text-[12px] text-muted">
                    <span className="truncate">{a.altText || (a.kind === "logo" ? "Logo" : "No description")}</span>
                    {selected === a.id && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {chosen && (
          <div>
            <label htmlFor="image-alt" className="mb-1.5 block text-[13px] font-medium text-ink-2">
              Describe this image
            </label>
            <Input id="image-alt" value={alt} maxLength={200} placeholder="A crew repairing a tiled roof" onChange={(e) => setAlt(e.target.value)} />
            <p className="mt-1 text-[12px] text-muted">Leave it empty if the picture is purely decorative.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
