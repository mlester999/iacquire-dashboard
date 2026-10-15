import Link from "next/link";
import { ImageIcon } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { listAssets } from "@/server/assets/service";
import { managedClients } from "@/server/websites/admin";
import { getDraft } from "@/server/websites/service";
import { studioContext } from "@/server/websites/studio-ctx";
import { referencedAssetIds } from "@/lib/website/doc";
import { Card } from "@/components/ui/primitives";
import { PageHero } from "@/components/ui/workspace";
import { AdminMedia } from "@/components/website/admin/admin-media";

export const metadata = { title: "Media library" };

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
      <PageHero eyebrow="Website Studio" icon={<ImageIcon className="size-5" />} title="Media library"
        description="Each client's images are private to that client's workspace. You can add, describe and remove images for the clients you are assigned to. An image still used on a website can't be removed." />
      <nav aria-label="Clients" className="flex flex-wrap gap-2">
        {clients.map((c) => (
          <Link key={c.id} href={`/admin/website-studio/media?org=${c.id}`} aria-current={selected?.id === c.id ? "page" : undefined}
            className={selected?.id === c.id ? "inline-flex h-9 items-center rounded-full bg-primary px-3.5 text-[13px] font-medium text-white" : "inline-flex h-9 items-center rounded-full border border-line bg-surface px-3.5 text-[13px] font-medium text-ink-2 hover:border-line-strong"}>{c.name}</Link>
        ))}
        {clients.length === 0 && <p className="text-[13px] text-muted">You have no clients assigned yet.</p>}
      </nav>
      {!selected || !loaded ? (
        <Card className="px-6 py-12 text-center text-[13.5px] text-muted">Choose a client to see and manage their images.</Card>
      ) : loaded.ok ? (
        <AdminMedia key={selected.id} orgId={selected.id} initialAssets={JSON.parse(JSON.stringify(loaded.assets))} usedIds={loaded.usedIds} canUpload={loaded.canUpload} />
      ) : (
        <Card className="px-6 py-12 text-center text-[13.5px] text-warning-ink">{loaded.message}</Card>
      )}
    </div>
  );
}
