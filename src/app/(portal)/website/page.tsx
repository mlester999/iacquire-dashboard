import Link from "next/link";
import { ArrowRight,CheckCircle2,Globe,Palette } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getWebsite, preflight } from "@/server/websites/service";
import { listSubmissions } from "@/server/websites/forms";
import { OverviewView } from "@/components/website/portal/overview-view";
import { PageHero } from "@/components/ui/workspace";
import { InfoChip } from "@/components/ui/status";
import { TemplateThumb } from "@/components/website/gallery/template-gallery";
import { listPublishedCards } from "@/server/websites/templates";

export const metadata = { title: "Website" };

export default async function WebsitePage() {
  const ctx = await requireOrgContext("website.view");
  const site = await getWebsite(ctx);
  const canEdit = ctx.can("website.edit");
  const canCreate = ctx.can("website.create");
  const cards = await listPublishedCards();

  if (!site) {
    return (
      <div className="space-y-6">
        <PageHero
          target="website.hero"
          eyebrow="Your business, online" title="Make a space that feels like your business." icon={<Globe className="size-4" />} tone="blue"
          description="Choose a style, review a private draft built from your business details, and make it your own. You decide when it goes live. No website has been created or published yet."
          action={canCreate ? (
            <Link href="/website/new" data-aqi-target="website.start" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl brand-gradient px-5 text-sm font-medium text-white shadow-glow transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10">
              <Palette className="size-4" aria-hidden /> Choose a style
            </Link>
          ) : undefined}
        />
        <section aria-labelledby="website-style-intro" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[12px] font-semibold uppercase tracking-[.15em] text-muted">A starting point, made yours</p><h2 id="website-style-intro" className="mt-2 text-[20px] font-semibold tracking-tight">Find your visual direction</h2></div><InfoChip>{cards.length} designs to explore</InfoChip></div>
          <div className="grid gap-4 md:grid-cols-3">{["meridian.estate","luxe.noir","care.haven"].map((key)=>{const card=cards.find((c)=>c.key===key);if(!card)return null;return <figure key={key} className="min-w-0 overflow-hidden rounded-[22px] border border-line bg-surface"><TemplateThumb card={card} frameBase="/frame/template" /><figcaption className="border-t border-line p-4"><p className="text-[14px] font-semibold">{card.familyName} · {card.name}</p><p className="mt-1 text-[12px] leading-relaxed text-muted">{card.description}</p><InfoChip className="mt-3">Sample content</InfoChip></figcaption></figure>;})}</div>
          <p className="text-[12px] leading-relaxed text-muted">These previews use sample content. Your private draft will use your company details, and publication stays under your control.</p>
        </section>
        <section aria-label="Your website journey" className="grid gap-4 rounded-[22px] border border-line bg-surface/70 p-5 sm:grid-cols-3">{[{title:"Choose your style",copy:"Explore the layouts and find a direction that suits your business.",icon:<Palette className="size-4"/>},{title:"Review and refine",copy:"Edit words, pages and images while everything stays private.",icon:<CheckCircle2 className="size-4"/>},{title:"Publish when ready",copy:"Review readiness and approvals before visitors see your site.",icon:<ArrowRight className="size-4"/>}].map(step=><div key={step.title} className="flex items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink" aria-hidden>{step.icon}</span><div><h3 className="text-[14px] font-semibold">{step.title}</h3><p className="mt-1 text-[12px] leading-relaxed text-muted">{step.copy}</p></div></div>)}</section>
        {!canCreate && <p className="rounded-xl bg-surface-2/70 p-4 text-[14px] text-ink-2 ring-1 ring-inset ring-line">Your team hasn&apos;t created the website yet. Someone with website creation access can start it from here.</p>}
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
