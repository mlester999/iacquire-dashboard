import { requireOrgContext } from "@/server/tenancy/context";
import { listPosts } from "@/server/social/posts";
import { SocialSubnav } from "@/components/social/social-subnav";

export default async function SocialLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext("social.view");
  const waiting = (await listPosts(ctx, { statuses: ["pending_approval"], limit: 200 })).length;
  return (
    <div className="space-y-5">
      <SocialSubnav waiting={waiting} />
      {children}
    </div>
  );
}
