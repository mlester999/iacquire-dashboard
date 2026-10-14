"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Eye, History, RotateCcw, ShieldAlert, Undo2 } from "lucide-react";
import { previewVersionAction, restoreVersionAction, rollbackAction } from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { LivePreview, type Device } from "@/components/website/studio/live-preview";
import type { SiteContent } from "@/lib/website/schema";
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
  const [device, setDevice] = React.useState<Device>("desktop");
  const [page, setPage] = React.useState("home");
  const [restoreId, setRestoreId] = React.useState<VersionView | null>(null);
  const [rollback, setRollback] = React.useState<PublicationView | null>(null);

  const open = async (v: VersionView) => {
    setBusy(true);
    const res = await previewVersionAction(v.id);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setPage("home");
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
          <CardTitle>Published versions</CardTitle>
          <CardDescription>Every time you publish, the exact site is kept. If something goes wrong, you can put an earlier one back.</CardDescription>
        </CardHeader>
        <CardContent>
          {publications.length === 0 ? (
            <p className="text-[13.5px] text-muted">You haven&apos;t published yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {publications.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                      Publication {p.number}
                      {p.status === "live" && <Badge tone="success"><CheckCircle2 className="size-3" aria-hidden /> Live now</Badge>}
                      {p.status === "failed" && <Badge tone="danger"><ShieldAlert className="size-3" aria-hidden /> Couldn&apos;t be served</Badge>}
                      {p.rolledBackTo !== null && <Badge tone="neutral">Rolled back to {p.rolledBackTo}</Badge>}
                    </p>
                    <p className="text-[12.5px] text-muted">
                      {formatDateTime(p.publishedAt, timeZone)}{p.publishedByName ? ` by ${p.publishedByName}` : ""} · {styleName(p.templateKey)}
                    </p>
                    {p.note && <p className="text-[13px] text-ink-2">“{p.note}”</p>}
                    {p.status === "live" && p.health !== "healthy" && p.healthDetail && <p className="text-[12.5px] text-warning-ink">{p.healthDetail}</p>}
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
          <CardTitle>Saved drafts</CardTitle>
          <CardDescription>Look at an earlier draft, and bring it back if you prefer it. Restoring never loses your current draft; it&apos;s saved first.</CardDescription>
        </CardHeader>
        <CardContent>
          {versions.length === 0 ? (
            <p className="flex items-center gap-2 text-[13.5px] text-muted"><History className="size-4" aria-hidden /> Nothing saved yet. Use “Save version” in the editor any time you like a draft.</p>
          ) : (
            <ul className="divide-y divide-line">
              {versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                      Version {v.version}
                      <Badge tone="neutral">{SOURCE[v.source] ?? "Saved"}</Badge>
                      {v.isLive && <Badge tone="success">Live</Badge>}
                    </p>
                    <p className="text-[12.5px] text-muted">{relativeTime(v.createdAt)}{v.createdByName ? ` · ${v.createdByName}` : ""} · {styleName(v.templateKey)}</p>
                    {v.note && <p className="text-[13px] text-ink-2">{v.note}</p>}
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void open(v)}>
                      <Eye className="size-3.5" /> Look
                    </Button>
                    {canEdit && (
                      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setRestoreId(v)}>
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

      <Dialog
        open={view !== null} onOpenChange={(o) => !o && setView(null)} size="xl"
        title={view ? `Version ${view.version.version}` : "Version"} description="This is how the site looked in this version. Nothing here changes your draft."
        footer={
          <>
            <Button variant="ghost" onClick={() => setView(null)}>Close</Button>
            {canEdit && view && <Button variant="brand" onClick={() => { setRestoreId(view.version); }}>Restore this version</Button>}
          </>
        }
      >
        {view && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Segmented id="hv-device" ariaLabel="Preview width" value={device} onChange={setDevice} options={[{ value: "desktop", label: "Desktop" }, { value: "tablet", label: "Tablet" }, { value: "mobile", label: "Phone" }]} />
              <Segmented id="hv-page" ariaLabel="Page" value={page} onChange={setPage} options={view.content.pages.slice(0, 5).map((p) => ({ value: p.slug, label: p.navLabel || p.title }))} />
            </div>
            <div className="max-h-[60dvh] overflow-auto rounded-2xl bg-surface-3 p-2">
              <LivePreview content={view.content} templateKey={view.templateKey} pageSlug={page} assets={assets} device={device} selectedId={null} year={new Date().getFullYear()} onSelectSection={() => undefined} onSelectSite={() => undefined} onNavigatePage={setPage} />
            </div>
          </div>
        )}
      </Dialog>

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
