"use client";

import * as React from "react";
import { Palette } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useStudioApi } from "@/components/website/studio/studio-api";
import type { SiteContent } from "@/lib/website/doc";
import { applyDesignUpdate, designChanges } from "@/lib/website/editor/template-update";
import type { TemplateUpdate } from "@/server/websites/template-update";

/**
 * Shown at the top of the Design panel when the agency has published a newer look for the template this site began as. Taking it changes
 * only colours, fonts, shapes and spacing. Every word, picture and section stays as it is, a restore point is saved first, and Undo brings
 * the old look straight back.
 */
export function TemplateUpdateCard({ doc, commit, checkpoint, readOnly }: { doc: SiteContent; commit: (d: SiteContent) => void; checkpoint: (note: string) => Promise<boolean>; readOnly: boolean }) {
  const api = useStudioApi();
  const [update, setUpdate] = React.useState<TemplateUpdate | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    void api.getTemplateUpdate?.().then((r) => { if (live && r.ok) setUpdate(r.data); });
    return () => { live = false; };
  }, [api]);
  const changes = React.useMemo(() => (update ? designChanges(doc.design, update.design) : []), [update, doc.design]);
  if (!update || dismissed || doc.origin.version >= update.toVersion || changes.length === 0) return null;
  const apply = async () => {
    setBusy(true);
    const saved = await checkpoint(`Before taking the newer look of “${update.templateName}”`);
    if (saved) {
      commit(applyDesignUpdate(doc, update.design, update.toVersion));
      toast.success("The newer look is applied. Undo brings the old one back.");
    }
    setBusy(false);
  };
  return (
    <section aria-label="Template update" className="m-3 space-y-2.5 rounded-xl border border-primary/25 bg-primary-soft/60 p-3">
      <p className="flex items-start gap-2 text-[12.5px] font-semibold leading-snug text-primary-ink"><Palette className="mt-0.5 size-4 shrink-0" aria-hidden /> A newer look for “{update.templateName}” is available</p>
      <p className="text-[12px] leading-relaxed text-ink-2">You started from version {update.fromVersion}. Taking it changes colours, fonts, shapes and spacing only. Your words, pictures and sections stay exactly as they are.</p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="text-[12px] font-medium text-primary-ink hover:underline">{open ? "Hide what would change" : `See what would change · ${changes.length}`}</button>
      {open && (
        <ul className="space-y-1.5 rounded-lg bg-surface p-2.5 text-[12px]">
          {changes.map((c) => (
            <li key={c.label} className="flex items-center justify-between gap-2">
              <span className="text-muted">{c.label}</span>
              <span className="flex items-center gap-1.5 font-medium">
                {c.swatch && <span className="size-3.5 rounded-full border border-line" style={{ background: c.swatch.from }} aria-hidden />}
                <span>{c.from}</span><span aria-hidden>→</span>
                {c.swatch && <span className="size-3.5 rounded-full border border-line" style={{ background: c.swatch.to }} aria-hidden />}
                <span>{c.to}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="brand" loading={busy} disabled={readOnly} onClick={() => void apply()}>Take the newer look</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDismissed(true)}>Not now</Button>
      </div>
    </section>
  );
}
