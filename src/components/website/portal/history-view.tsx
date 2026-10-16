"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Clock, Eye, History, Palette, RadioTower, RotateCcw, ShieldAlert, Undo2, User } from "lucide-react";
import { previewVersionAction, restoreVersionAction, rollbackAction } from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { PreviewOverlay } from "@/components/website/editor/dialogs";
import type { SiteContent } from "@/lib/website/doc";
import { resolveTemplate } from "@/lib/website/templates";
import { formatDateTime, relativeTime } from "@/lib/utils";
import type { AssetView } from "@/server/assets/service";
import type { PublicationView, VersionView } from "@/server/websites/service";

const SOURCE: Record<string, string> = {
  generated: "Written for you", editor: "Saved by you", submit: "Sent for approval", publish: "Published", import: "Imported", restore: "Restored",
};
const styleName = (key: string) => {
  const t = resolveTemplate(key);
  return t ? `${t.family.name} · ${t.variation.name}` : "Style";
};

/**
 * Earlier drafts and every publication. Restoring a version only changes the draft (and first saves what was there);
 * rolling back changes what visitors see and is checked the same way a publish is.
 */
export function HistoryView({
  versions, publications, assets, draftRevision, canEdit, canPublish, timeZone,
}: {
  versions: VersionView[]; publications: PublicationView[]; assets: AssetView[]; draftRevision: number; canEdit: boolean; canPublish: boolean; timeZone: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [view, setView] = React.useState<{ version: VersionView; content: SiteContent; templateKey: string } | null>(null);
  const [restoreId, setRestoreId] = React.useState<VersionView | null>(null);
  const [rollback, setRollback] = React.useState<PublicationView | null>(null);

  const open = async (v: VersionView) => {
    setBusy(true);
    const res = await previewVersionAction(v.id);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setView({ version: v, content: res.data.content, templateKey: res.data.templateKey });
  };

  const restore = async (v: VersionView) => {
    setBusy(true);
    const res = await restoreVersionAction(v.id, draftRevision);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setRestoreId(null);
    setView(null);
    toast.success(`Version ${v.version} is back in your draft. What was there before is saved too.`);
    router.push("/website/edit");
  };

  const doRollback = async (p: PublicationView) => {
    setBusy(true);
    const res = await rollbackAction(p.number);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setRollback(null);
    toast[res.data.restoredPrevious ? "error" : "success"](res.data.restoredPrevious ? "That version couldn't be served, so the current one stays live." : `Version ${p.number} is live again.`);
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-col items-stretch gap-0">
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink ring-1 ring-inset ring-line"><RadioTower className="size-4" /></span>
            <CardTitle>Published versions</CardTitle>
            <InfoChip className="ml-auto">{publications.length}</InfoChip>
          </div>
          <CardDescription className="mt-3">Every time you publish, the exact site is kept. If something goes wrong, you can put an earlier one back.</CardDescription>
        </CardHeader>
        <CardContent>
          {publications.length === 0 ? (
            <EmptyState compact icon={<RadioTower className="size-5" />} title="Nothing published yet" description="Each time you publish, the exact site is kept here so you can put it back." />
          ) : (
            <ul className="divide-y divide-line">
              {publications.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5 transition-colors hover:bg-surface-2/40 sm:-mx-2 sm:rounded-xl sm:px-2">
                  <div className="flex min-w-[min(100%,17rem)] flex-1 items-start gap-3">
                    <span aria-hidden className={`grid size-10 shrink-0 place-items-center rounded-xl text-[13px] font-semibold tabular-nums ring-1 ring-inset ${p.status === "live" ? "bg-success-soft text-success-ink ring-success/20" : p.status === "failed" ? "bg-danger-soft text-danger-ink ring-danger/20" : "bg-surface-2 text-ink-2 ring-line"}`}>{p.number}</span>
                    <div className="min-w-0 space-y-1.5">
                      <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                        Publication {p.number}
                        {p.status === "live" && <StatusPill tone="success" icon={<CheckCircle2 className="size-3" aria-hidden />}>Live now</StatusPill>}
                        {p.status === "failed" && <StatusPill tone="danger" icon={<ShieldAlert className="size-3" aria-hidden />}>Couldn&apos;t be served</StatusPill>}
                        {p.rolledBackTo !== null && <StatusPill tone="neutral" icon={<Undo2 className="size-3" aria-hidden />}>Rolled back to {p.rolledBackTo}</StatusPill>}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <InfoChip icon={<Clock />}>{formatDateTime(p.publishedAt, timeZone)}</InfoChip>
                        {p.publishedByName && <InfoChip icon={<User />}>{p.publishedByName}</InfoChip>}
                        <InfoChip icon={<Palette />}>{styleName(p.templateKey)}</InfoChip>
                      </div>
                      {p.note && <p className="text-[13px] text-ink-2">“{p.note}”</p>}
                      {p.status === "live" && p.health !== "healthy" && p.healthDetail && <p className="text-[12.5px] text-warning-ink">{p.healthDetail}</p>}
                    </div>
                  </div>
                  {canPublish && p.status === "superseded" && (
                    <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setRollback(p)}>
                      <Undo2 className="size-3.5" /> Put this live again
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col items-stretch gap-0">
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink ring-1 ring-inset ring-line"><History className="size-4" /></span>
            <CardTitle>Saved drafts</CardTitle>
            <InfoChip className="ml-auto">{versions.length}</InfoChip>
          </div>
          <CardDescription className="mt-3">Look at an earlier draft, and bring it back if you prefer it. Restoring never loses your current draft; it&apos;s saved first.</CardDescription>
        </CardHeader>
        <CardContent>
          {versions.length === 0 ? (
            <EmptyState compact icon={<History className="size-5" />} title="Nothing saved yet" description="Use “Save version” in the editor any time you like a draft." />
          ) : (
            <ul className="divide-y divide-line">
              {versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5 transition-colors hover:bg-surface-2/40 sm:-mx-2 sm:rounded-xl sm:px-2">
                  <div className="flex min-w-[min(100%,17rem)] flex-1 items-start gap-3">
                    <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-[13px] font-semibold tabular-nums text-ink-2 ring-1 ring-inset ring-line">v{v.version}</span>
                    <div className="min-w-0 space-y-1.5">
                      <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                        Version {v.version}
                        <StatusPill tone={v.source === "submit" ? "warning" : v.source === "publish" ? "success" : v.source === "generated" ? "violet" : v.source === "editor" ? "primary" : "neutral"}>{SOURCE[v.source] ?? "Saved"}</StatusPill>
                        {v.isLive && <StatusPill tone="success">Live</StatusPill>}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <InfoChip icon={<Clock />}>{relativeTime(v.createdAt)}</InfoChip>
                        {v.createdByName && <InfoChip icon={<User />}>{v.createdByName}</InfoChip>}
                        <InfoChip icon={<Palette />}>{styleName(v.templateKey)}</InfoChip>
                      </div>
                      {v.note && <p className="text-[13px] text-ink-2">{v.note}</p>}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void open(v)}>
                      <Eye className="size-3.5" /> Look
                    </Button>
                    {canEdit && (
                      <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setRestoreId(v)}>
                        <RotateCcw className="size-3.5" /> Restore
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {view && (
        <PreviewOverlay
          doc={view.content} title={`Version ${view.version.version}`} subtitle="Nothing here changes your draft" onClose={() => setView(null)}
          resolveAsset={(id) => { const a = id ? assets.find((x) => x.id.toLowerCase() === id.toLowerCase()) : null; return a ? { src: a.url, width: a.width, height: a.height, alt: a.altText } : null; }}
          actions={canEdit ? <button type="button" onClick={() => setRestoreId(view.version)} className="flex h-8 items-center gap-1.5 rounded-lg bg-[#3b5bdb] px-3 text-[12.5px] font-medium text-white hover:bg-[#4c6ae0]"><RotateCcw className="size-3.5" /> Restore this version</button> : undefined}
        />
      )}

      <Dialog
        open={restoreId !== null} onOpenChange={(o) => !o && setRestoreId(null)} size="sm" title={restoreId ? `Restore version ${restoreId.version}?` : "Restore"}
        description="It replaces your current draft. Your current draft is saved as its own version first, and your live site doesn't change until you publish."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoreId(null)}>Cancel</Button>
            <Button variant="brand" loading={busy} onClick={() => restoreId && void restore(restoreId)}>Restore</Button>
          </>
        }
      />

      <Dialog
        open={rollback !== null} onOpenChange={(o) => !o && setRollback(null)} size="sm" title={rollback ? `Put publication ${rollback.number} live again?` : "Roll back"}
        description="Visitors will see that earlier version straight away. We check it's being served, and if it isn't, the current one stays live."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRollback(null)}>Cancel</Button>
            <Button variant="brand" loading={busy} onClick={() => rollback && void doRollback(rollback)}>Put it live</Button>
          </>
        }
      />
    </div>
  );
}
