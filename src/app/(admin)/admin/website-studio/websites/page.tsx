import Link from "next/link";
import { Globe, Plus } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { listManagedWebsites, managedClients } from "@/server/websites/admin";
import { roleHasPermission } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
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
                  <Link href={`/admin/website-studio/websites/${c.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 shadow-soft hover:border-line-strong hover:bg-surface-2">
                    <Plus className="size-3.5 text-primary" aria-hidden /> {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {sites.length === 0 ? (
        <Card className="px-6 py-14 text-center"><p className="text-[15px] font-semibold">No client websites yet</p><p className="mt-1 text-[13px] text-muted">Create the first one from a client above.</p></Card>
      ) : (
        <WebsitesTable sites={JSON.parse(JSON.stringify(sites))} timeZone={user.timezone} canEdit={canEdit} />
      )}
    </div>
  );
}
