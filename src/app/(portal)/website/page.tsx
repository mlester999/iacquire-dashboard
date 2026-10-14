import Link from "next/link";
import { Globe, Palette } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getWebsite, preflight } from "@/server/websites/service";
import { listSubmissions } from "@/server/websites/forms";
import { OverviewView } from "@/components/website/portal/overview-view";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Website" };

export default async function WebsitePage() {
  const ctx = await requireOrgContext("website.view");
  const site = await getWebsite(ctx);
  const canEdit = ctx.can("website.edit");

  if (!site) {
    return (
      <div className="space-y-6">
        <PageHero
          eyebrow="Website" title="Get a website that sends you customers." icon={<Globe className="size-4" />} tone="neutral"
          description="We write a first draft from the business details you gave us, in a style you choose. You edit it in plain language, see it exactly as visitors will, and decide when it goes live. Enquiries land in your contacts automatically."
          action={canEdit ? (
            <Link href="/website/new" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl brand-gradient px-5 text-sm font-medium text-white shadow-glow transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10">
              <Palette className="size-4" aria-hidden /> Choose a style
            </Link>
          ) : undefined}
        />
        {!canEdit && <p className="text-[14px] text-muted">Your team hasn&apos;t created the website yet. Someone with edit access can start it from here.</p>}
      </div>
    );
  }

  const [pf, enquiries] = await Promise.all([preflight(ctx), ctx.can("contacts.view") ? listSubmissions(ctx, { limit: 5 }) : Promise.resolve([])]);
  return (
    <OverviewView
      site={JSON.parse(JSON.stringify(site))} pf={pf} enquiries={JSON.parse(JSON.stringify(enquiries))} timeZone={ctx.org.timezone}
      perms={{ canEdit, canPublish: ctx.can("website.publish"), canApprove: ctx.can("website.approve") }}
    />
  );
}
