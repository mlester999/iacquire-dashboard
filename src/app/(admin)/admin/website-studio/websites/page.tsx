import Link from "next/link";
import { Globe, Plus } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { listManagedWebsites, managedClients } from "@/server/websites/admin";
import { roleHasPermission } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { AvatarTile } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { WebsitesTable } from "@/components/website/admin/websites-table";

export const metadata = { title: "Client Websites" };

export default async function ClientWebsitesPage() {
  const user = await requireAgency();
  const [sites, clients] = await Promise.all([listManagedWebsites(user), managedClients(user)]);
  const without = clients.filter((c) => !c.hasWebsite);
  const canEdit = roleHasPermission(user.platformRole === "none" ? null : user.platformRole, "website.edit");
  return (
    <div className="module-stack">
      <PageHero
        eyebrow="Website Studio" icon={<Globe className="size-5" />} title="Client Websites"
        description={user.platformRole === "agency_super_admin" ? "Every client website, with its status, domain and what needs a person's attention." : "The websites of the clients you are assigned to, with their status, domain and what needs attention."}
      />
      {without.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Clients without a website</CardTitle><CardDescription>Choose a design and create a private first draft from the client&apos;s own business details. Nothing goes live until it is published.</CardDescription></CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {without.map((c) => (
                <li key={c.id}>
                  <Link href={`/admin/website-studio/websites/${c.id}`} className="group inline-flex h-11 max-w-full items-center gap-2 rounded-xl border border-line bg-surface py-1 pl-1.5 pr-3 text-[13px] font-medium text-ink shadow-soft transition-colors hover:border-primary/40 hover:bg-surface-2">
                    <AvatarTile name={c.name} size="sm" /> <span className="truncate" title={c.name}>{c.name}</span> <Plus className="size-3.5 shrink-0 text-primary transition-transform group-hover:rotate-90" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {sites.length === 0 ? (
        <Card><EmptyState icon={<Globe className="size-5" />} title="No client websites yet" description="Create the first one from a client above." /></Card>
      ) : (
        <WebsitesTable sites={JSON.parse(JSON.stringify(sites))} timeZone={user.timezone} canEdit={canEdit} />
      )}
    </div>
  );
}
