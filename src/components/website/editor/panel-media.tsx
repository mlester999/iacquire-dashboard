"use client";

import * as React from "react";
import { Check, ImagePlus, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Art } from "@/components/website/render/art";
import { useStudioApi } from "@/components/website/studio/studio-api";
import { ART_SCENES, ART_TONES, type ArtScene, type ArtTone } from "@/lib/website/art-keys";
import type { ImageSrc } from "@/lib/website/doc";
import { cn } from "@/lib/utils";
import type { AssetView } from "@/server/assets/service";
import { IconButton, NumberControl, Row, Seg, TextControl } from "./controls";
import { useServices } from "./context";
import { useResetOnOpen } from "./hooks";
import { ImageThumb } from "./fields";

const ACCEPT = "image/png,image/jpeg,image/webp";
const MAX_BYTES = 10 * 1024 * 1024;

/** Uploads one or more files, reporting each outcome, and returns the assets that were added. */
function useUploader(onAdded: (a: AssetView[]) => void) {
  const api = useStudioApi();
  const [busy, setBusy] = React.useState(0);
  const upload = React.useCallback(async (files: File[], kind: "image" | "logo") => {
    const added: AssetView[] = [];
    for (const f of files) {
      if (!ACCEPT.split(",").includes(f.type)) {
        toast.error(`${f.name}: use a PNG, JPG or WebP image.`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name}: images can be up to 10 MB.`);
        continue;
      }
      setBusy((n) => n + 1);
      const res = await api.uploadAsset(f, kind, "");
      setBusy((n) => n - 1);
      if (res.ok) added.push(res.data);
      else toast.error(`${f.name}: ${res.error}`);
    }
    if (added.length) {
      onAdded(added);
      toast.success(added.length === 1 ? "Image added to your library." : `${added.length} images added to your library.`);
    }
    return added;
  }, [api, onAdded]);
  return { upload, busy };
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

export function MediaLibrary({
  assets, onAssetsChange, usedIds, onPick, selectedId, compact,
}: { assets: AssetView[]; onAssetsChange: (a: AssetView[]) => void; usedIds: Set<string>; onPick?: (a: AssetView) => void; selectedId?: string | null; compact?: boolean }) {
  const api = useStudioApi();
  const { assetUrl, canUpload } = useServices();
  const [kind, setKind] = React.useState<"image" | "logo">("image");
  const [filter, setFilter] = React.useState<"all" | "image" | "logo">("all");
  const [q, setQ] = React.useState("");
  const [over, setOver] = React.useState(false);
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const { upload, busy } = useUploader((added) => onAssetsChange([...added, ...assets]));
  const shown = assets.filter((a) => (filter === "all" || a.kind === filter) && (!q.trim() || a.altText.toLowerCase().includes(q.toLowerCase())));
  const used = (id: string) => usedIds.has(id.toLowerCase());

  const remove = async (a: AssetView) => {
    const res = await api.deleteAsset(a.id);
    if (!res.ok) return void toast.error(res.error);
    onAssetsChange(assets.filter((x) => x.id !== a.id));
    setConfirm(null);
    toast.success("Image removed from your library.");
  };
  const saveAlt = async (a: AssetView, alt: string) => {
    if (alt === a.altText) return;
    const res = await api.setAssetAlt(a.id, alt);
    if (!res.ok) return void toast.error(res.error);
    onAssetsChange(assets.map((x) => (x.id === a.id ? { ...x, altText: alt } : x)));
  };

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", over && "ring-2 ring-inset ring-primary")}
      onDragOver={(e) => { if (canUpload && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (!canUpload) return; e.preventDefault(); setOver(false); void upload(Array.from(e.dataTransfer.files), kind); }}
    >
      <div className="space-y-2 px-4 pb-2 pt-3">
        {canUpload ? (
          <>
            <div className="flex gap-2">
              <Button size="sm" variant="soft" className="!h-8 flex-1 !text-[12px]" onClick={() => fileRef.current?.click()} disabled={busy > 0}>
                {busy > 0 ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Upload images
              </Button>
              <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { void upload(Array.from(e.target.files ?? []), kind); e.target.value = ""; }} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Seg label="Upload as" value={kind} onChange={setKind} options={[{ value: "image", label: "Photo" }, { value: "logo", label: "Logo" }]} size="sm" />
            </div>
            <p className="text-[11px] leading-relaxed text-muted">PNG, JPG or WebP up to 10 MB. Photos are compressed for fast loading. Logos keep their format, and a plain background can be removed where possible. Drop files anywhere here.</p>
          </>
        ) : <p className="rounded-lg bg-surface-3 p-2.5 text-[11.5px] text-muted">Only owners and managers can add images.</p>}
        {!compact && (
          <div className="flex items-center gap-2">
            <TextControl aria-label="Search images by description" placeholder="Search by description" value={q} onChange={(e) => setQ(e.target.value)} />
            <Seg label="Show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "image", label: "Photos" }, { value: "logo", label: "Logos" }]} size="sm" />
          </div>
        )}
      </div>
      {assets.length === 0 ? (
        <div className="mx-4 mt-2 flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
          <ImagePlus className="size-8 text-faint" aria-hidden />
          <p className="mt-2 text-[13px] font-medium">No images yet</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">Upload photos of your work, your team or your premises. Until then the site shows built-in artwork, which you&apos;ll replace before publishing.</p>
        </div>
      ) : (
        <ul className={cn("grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto px-4 pb-4", compact ? "grid-cols-3" : "grid-cols-2")}>
          {shown.map((a) => {
            const isUsed = used(a.id);
            return (
              <li key={a.id} className="group relative overflow-hidden rounded-xl border border-line bg-surface">
                <button type="button" disabled={!onPick} onClick={() => onPick?.(a)} aria-label={onPick ? `Use image: ${a.altText || "untitled"}` : undefined} aria-pressed={selectedId === a.id} className={cn("relative block aspect-square w-full overflow-hidden bg-surface-3", onPick && "cursor-pointer hover:opacity-90")}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={assetUrl(a.id)} alt="" loading="lazy" className="size-full object-cover" />
                  {a.kind === "logo" && <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-white">Logo</span>}
                  {isUsed && <span className="absolute bottom-1 left-1 rounded bg-primary px-1.5 py-px text-[9.5px] font-semibold text-white">In use</span>}
                  {selectedId === a.id && <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-white"><Check className="size-3" aria-hidden /></span>}
                </button>
                {!compact && (
                  <div className="space-y-1 p-1.5">
                    <input aria-label="Description for screen readers" defaultValue={a.altText} maxLength={200} placeholder="Describe this image" onBlur={(e) => void saveAlt(a, e.target.value.trim())} className="h-7 w-full rounded-md border border-transparent bg-surface-2 px-1.5 text-[11.5px] hover:border-line focus:border-primary focus:outline-none" />
                    <div className="flex items-center justify-between text-[10.5px] text-muted">
                      <span>{a.width && a.height ? `${a.width}×${a.height}` : ""}</span>
                      {confirm === a.id ? (
                        <span className="flex items-center gap-1"><button type="button" onClick={() => void remove(a)} className="rounded bg-danger px-1.5 py-0.5 font-medium text-white">Remove</button><button type="button" onClick={() => setConfirm(null)} className="rounded px-1 py-0.5 hover:bg-surface-3">Keep</button></span>
                      ) : (
                        <IconButton label={isUsed ? "Used on your site. Replace it there first to remove it." : "Remove from library"} disabled={isUsed || !canUpload} onClick={() => setConfirm(a.id)} className="size-6"><Trash2 className="size-3" /></IconButton>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          {!shown.length && <li className="col-span-full py-6 text-center text-[12px] text-muted">No images match.</li>}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

export function MediaPickerDialog({
  open, onOpenChange, current, onPick, assets, onAssetsChange, usedIds, title,
}: { open: boolean; onOpenChange: (o: boolean) => void; current: ImageSrc; onPick: (s: ImageSrc) => void; assets: AssetView[]; onAssetsChange: (a: AssetView[]) => void; usedIds: Set<string>; title?: string }) {
  const [tab, setTab] = React.useState<"mine" | "art">(current?.kind === "art" ? "art" : "mine");
  const [scene, setScene] = React.useState<ArtScene>(current?.kind === "art" ? current.scene : "villa");
  const [tone, setTone] = React.useState<ArtTone>(current?.kind === "art" ? current.tone : "auto");
  const [seed, setSeed] = React.useState(current?.kind === "art" ? current.seed : 0);
  const { design } = useServices();
  useResetOnOpen(open, () => {
    setTab(current?.kind === "art" ? "art" : "mine");
    if (current?.kind === "art") {
      setScene(current.scene);
      setTone(current.tone);
      setSeed(current.seed);
    }
  });
  const pickAsset = (a: AssetView) => {
    onPick({ kind: "asset", id: a.id });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl" title={title ? `Choose an image: ${title}` : "Choose an image"} description="Use one of your own images, or a piece of built-in artwork while you're still gathering photos."
      footer={<>
        {current && <Button variant="ghost" onClick={() => { onPick(null); onOpenChange(false); }}>Remove image</Button>}
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        {tab === "art" && <Button variant="brand" onClick={() => { onPick({ kind: "art", scene, tone, seed }); onOpenChange(false); }}>Use this artwork</Button>}
      </>}>
      <div className="space-y-3">
        <Seg label="Where from" value={tab} onChange={setTab} options={[{ value: "mine", label: `Your images (${assets.length})` }, { value: "art", label: "Built-in artwork" }]} />
        {tab === "mine" ? (
          <div className="-mx-4 flex h-[52dvh] min-h-[22rem] flex-col">
            <MediaLibrary assets={assets} onAssetsChange={onAssetsChange} usedIds={usedIds} onPick={pickAsset} selectedId={current?.kind === "asset" ? current.id : null} compact />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
            <ul className="grid max-h-[52dvh] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3" style={{ ["--c-primary" as string]: design.colors.primary, ["--c-accent" as string]: design.colors.accent }}>
              {ART_SCENES.map((s) => (
                <li key={s.key}>
                  <button type="button" onClick={() => setScene(s.key)} aria-pressed={scene === s.key} className={cn("block w-full overflow-hidden rounded-xl border-2 text-left", scene === s.key ? "border-primary" : "border-transparent hover:border-line-strong")}>
                    <span className="block aspect-[16/10] overflow-hidden bg-surface-3"><Art scene={s.key} tone={tone} seed={seed} className="size-full" /></span>
                    <span className="flex items-center justify-between gap-1 px-1.5 py-1 text-[11px]"><span className="truncate font-medium">{s.label}</span>{s.kind === "illustration" && <span className="shrink-0 rounded bg-warning-soft px-1 text-[9.5px] font-semibold text-warning-ink">Illustration</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="space-y-3">
              <Row label="Mood"><Seg label="Artwork mood" value={tone} onChange={setTone} options={ART_TONES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))} size="sm" /></Row>
              <Row label="Variation"><NumberControl label="Artwork variation" value={seed} min={0} max={99} onChange={setSeed} /></Row>
              <div className="overflow-hidden rounded-xl border border-line" style={{ ["--c-primary" as string]: design.colors.primary, ["--c-accent" as string]: design.colors.accent }}><div className="aspect-[16/10]"><Art scene={scene} tone={tone} seed={seed} className="size-full" /></div></div>
              <p className="rounded-lg bg-warning-soft/60 p-2.5 text-[11.5px] leading-relaxed text-warning-ink">An “illustration” is drawn artwork standing in for a photograph. It&apos;s fine while you build, but you&apos;ll be asked to confirm it, or replace it with your own picture, before you publish. It is never allowed to stand in for photos of your work or your people.</p>
            </div>
          </div>
        )}
      </div>
      <span className="sr-only"><ImageThumb src={current} /></span>
    </Dialog>
  );
}
