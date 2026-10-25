import { Images } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getMediaPolicy, listMedia } from "@/server/social/media";
import { MediaLibrary } from "@/components/social/media-library";

export const metadata = { title: "Social media library" };

export default async function SocialMediaPage() {
  const ctx = await requireOrgContext("social.view");
  const [items, policy] = await Promise.all([listMedia(ctx), getMediaPolicy(ctx)]);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><Images className="size-5 text-muted" aria-hidden />Media</h1>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">Pictures and videos to use in posts. Each file is checked against what Facebook and Instagram accept, and is visible only to your team.</p>
      </header>
      <MediaLibrary items={items} policy={policy} canCreate={ctx.can("social.create")} />
    </div>
  );
}
