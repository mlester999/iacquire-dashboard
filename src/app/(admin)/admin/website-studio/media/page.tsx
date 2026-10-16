import Link from "next/link";
import { AlertTriangle, ImageIcon, Images } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { listAssets } from "@/server/assets/service";
import { managedClients } from "@/server/websites/admin";
import { getDraft } from "@/server/websites/service";
import { studioContext } from "@/server/websites/studio-ctx";
import { referencedAssetIds } from "@/lib/website/doc";
import { Card, EmptyState } from "@/components/ui/primitives";
import { AvatarTile } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { AdminMedia } from "@/components/website/admin/admin-media";

export const metadata = { title: "Media Library" };

type Loaded = { ok: true; assets: Awaited<ReturnType<typeof listAssets>>; usedIds: string[]; canUpload: boolean } | { ok: false; message: string };

/** Reads one client's images. A refusal (not assigned, no access) becomes a message, never a thrown page. */
async function loadClientMedia(orgId: string): Promise<Loaded> {
  try {
    const ctx = await studioContext(orgId, "workspace.view");
    const [assets, draft] = await Promise.all([listAssets(ctx), getDraft(ctx).catch(() => null)]);
    return { ok: true, assets, usedIds: draft ? referencedAssetIds(draft.content) : [], canUpload: ctx.can("workspace.manage_profile") };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, message: err.message };
    throw err;
  }
}

export default async function MediaPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const user = await requireAgency();
  const { org } = await searchParams;
  const clients = await managedClients(user);
  const selected = clients.find((c) => c.id === org) ?? null;
  const loaded = selected ? await loadClientMedia(selected.id) : null;
  return (
    <div className="module-stack">
      <PageHero eyebrow="Website Studio" icon={<ImageIcon className="size-5" />} title="Media Library"
        description="Each client's images are private to that client's workspace. You can add, describe and remove images for the clients you are assigned to. An image still used on a website can't be removed." />
      <nav aria-label="Clients" className="flex flex-wrap gap-2">
        {clients.map((c) => (
          <Link key={c.id} href={`/admin/website-studio/media?org=${c.id}`} aria-current={selected?.id === c.id ? "page" : undefined}
            className={selected?.id === c.id ? "inline-flex h-11 max-w-full items-center gap-2 rounded-full bg-primary py-1 pl-1.5 pr-4 text-[13px] font-medium text-white shadow-soft" : "inline-flex h-11 max-w-full items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1.5 pr-4 text-[13px] font-medium text-ink-2 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink"}><AvatarTile name={c.name} size="sm" className="!rounded-full" /><span className="truncate" title={c.name}>{c.name}</span></Link>
        ))}
        {clients.length === 0 && <Card className="w-full"><EmptyState compact icon={<Images className="size-5" />} title="No clients assigned yet" description="Once you are assigned to a client, their image library appears here." /></Card>}
      </nav>
      {!selected || !loaded ? (
        <Card><EmptyState icon={<Images className="size-5" />} title="Choose a client" description="Pick a client above to see and manage their images." /></Card>
      ) : loaded.ok ? (
        <AdminMedia key={selected.id} orgId={selected.id} initialAssets={JSON.parse(JSON.stringify(loaded.assets))} usedIds={loaded.usedIds} canUpload={loaded.canUpload} />
      ) : (
        <Card><EmptyState icon={<AlertTriangle className="size-5" />} title="Images are not available" description={loaded.message} /></Card>
      )}
    </div>
  );
}
