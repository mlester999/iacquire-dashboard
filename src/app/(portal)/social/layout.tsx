import { requireOrgContext } from "@/server/tenancy/context";
import { listPosts } from "@/server/social/posts";
import { socialAvailableIn } from "@/lib/social/workspace";
import { SocialClientOnlyNotice } from "@/components/social/client-only-notice";
import { SocialSubnav } from "@/components/social/social-subnav";

export default async function SocialLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext("social.view");
  // Social media is a client-workspace feature. An agency workspace gets an honest notice, and its pages are never rendered (so they query nothing).
  if (!socialAvailableIn(ctx.org.kind)) return <SocialClientOnlyNotice canOpenClients={ctx.user.platformRole !== "none"} />;
  const waiting = (await listPosts(ctx, { statuses: ["pending_approval"], limit: 200 })).length;
  return (
    <div className="space-y-5">
      <SocialSubnav waiting={waiting} />
      {children}
    </div>
  );
}
