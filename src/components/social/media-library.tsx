"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Video as VideoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { removeMediaAction } from "@/app/actions/social";
import type { MediaView } from "@/server/social/media";
import { storageUse, type MediaPolicyView } from "@/lib/social/storage";

// Pictures and videos for posts. Where they may be kept depends on the plan, and this page says so plainly rather than offering what is not available.

const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function MediaLibrary({ items, policy, canCreate }: { items: MediaView[]; policy: MediaPolicyView; canCreate: boolean }) {
  const router = useRouter();
  // The managed plan is not unlimited: when the server reports a cap, the workspace sees where it stands before an upload is refused.
  const use = storageUse(policy.usedBytes, policy.limitBytes);
  const { run, busy } = useCrmAction();
  const [uploading, setUploading] = React.useState(false);
  const [alt, setAlt] = React.useState("");
  const [remove, setRemove] = React.useState<MediaView | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      if (alt.trim()) body.set("altText", alt.trim());
      const res = await fetch("/api/social/media", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) toast.error(json.error ?? "That file could not be added.");
      else {
        toast.success("Added to your library.");
        setAlt("");
        router.refresh();
      }
    } catch {
      toast.error("That didn't go through. Check your connection and try again.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-6">
      <section aria-label="Where media is kept" className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">Where your media is kept</h2>
        <p className="mt-1 text-[14px] text-ink-2">{policy.summary}</p>
        {use && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[14px] font-medium text-ink">{use.summary}</p>
            <div role="progressbar" aria-label="Media storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={use.percent} aria-valuetext={`${use.percent}% used`} className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div className={use.level === "ok" ? "h-full rounded-full bg-primary" : use.level === "near" ? "h-full rounded-full bg-warning-ink" : "h-full rounded-full bg-danger-ink"} style={{ width: `${use.percent}%` }} />
            </div>
            {/* The live region is always there, so a warning that appears after an upload is announced. */}
            <div role="status">{use.warning && <p className={`rounded-xl px-3 py-2 text-[13px] ${use.level === "full" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink"}`}>{use.warning}</p>}</div>
          </div>
        )}
        <ul className="mt-3 grid gap-2 sm:grid-cols-3">
          {policy.options.map((o) => (
            <li key={o.source} className="rounded-xl border border-line p-3 text-[14px]">
              <p className="flex items-center justify-between gap-2 font-medium text-ink">{o.label}<Badge tone={o.available ? "success" : "neutral"}>{o.available ? "Available" : "Not available"}</Badge></p>
              {o.reason && <p className="mt-1 text-[13px] text-muted">{o.reason}</p>}
            </li>
          ))}
        </ul>
      </section>

      {canCreate && policy.managedUploadAllowed && (
        <section aria-label="Add a file" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-semibold text-ink">Add a picture or video</h2>
          <p className="text-[13px] text-muted">JPEG, PNG or WebP pictures and MP4 videos, up to 50 MB each.Instagram takes JPEG pictures only, between 4:5 and 1.91:1 in shape; each file is checked and shows what each platform will accept.</p>
          <Field label="Description for people who cannot see it" htmlFor="media-alt" optional>
            <Input id="media-alt" value={alt} maxLength={400} onChange={(e) => setAlt(e.target.value)} className="text-[16px] sm:text-[14px]" />
          </Field>
          <div>
            <input ref={fileRef} id="media-file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            <label htmlFor="media-file" className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl brand-gradient px-4 text-[14px] font-medium text-white shadow-glow focus-within:outline-2 sm:min-h-10" aria-disabled={uploading}>
              <Upload className="size-4" aria-hidden />{uploading ? "Adding…" : "Choose a file"}
            </label>
          </div>
        </section>
      )}

      <section aria-label="Library" className="space-y-3">
        <h2 className="text-[15px] font-semibold text-ink">Library</h2>
        {items.length === 0 ? <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">Nothing here yet.</p> : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((m) => (
              <li key={m.id} className="overflow-hidden rounded-2xl border border-line bg-surface">
                {m.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/social/media/${m.id}`} alt={m.altText ?? m.filename} className="h-40 w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-40 items-center justify-center bg-surface-2 text-muted"><VideoIcon className="size-8" aria-hidden /><span className="sr-only">Video</span></div>
                )}
                <div className="space-y-2 p-3 text-[13px]">
                  <p className="truncate text-[14px] font-medium text-ink">{m.filename}</p>
                  <p className="text-muted">{m.kind === "image" ? `${m.width ?? "?"} × ${m.height ?? "?"} · ` : ""}{size(m.sizeBytes)} · used by {m.usedBy} post{m.usedBy === 1 ? "" : "s"}</p>
                  <ul className="space-y-1">
                    {Object.entries(m.validation).map(([platform, v]) => (
                      <li key={platform} className={v.ok ? "text-success-ink" : "text-danger-ink"}>
                        <span className="font-medium">{platform === "facebook" ? "Facebook" : "Instagram"}:</span> {v.ok ? "can be used" : v.problems[0] ?? "cannot be used"}
                      </li>
                    ))}
                  </ul>
                  {canCreate && <Button size="sm" variant="ghost" onClick={() => setRemove(m)}>Remove</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(remove)} onOpenChange={(o) => !o && setRemove(null)} title={`Remove ${remove?.filename ?? "this file"}?`} confirmLabel="Remove" danger loading={busy("remove")}
        description="It is deleted from your library. A file still needed by a post that has not been published cannot be removed."
        onConfirm={async () => { if (!remove) return; await run("remove", () => removeMediaAction(remove.id), "Removed."); setRemove(null); }}
      />
    </div>
  );
}
