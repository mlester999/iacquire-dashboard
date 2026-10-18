import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { canDoBlueprint, isUuid } from "@/server/crm/blueprints/access";
import { getBlueprint, listClientOptions, listUpdateCandidates } from "@/server/crm/blueprints/library";
import { Card, EmptyState } from "@/components/ui/primitives";
import { ApplyWizard } from "@/components/crm-blueprints/apply/wizard";
import { blueprintHref } from "@/components/crm-blueprints/apply/links";

export const metadata = { title: "Apply to client" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Apply a published Blueprint version to one client: choose, preview (dry run), confirm, result. Staff without apply see the dry run only. */
export default async function ApplyBlueprintPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ client?: string | string[]; version?: string | string[] }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const user = await requireAgency();
  if (!canDoBlueprint(user, "inspect")) notFound();
  let detail;
  try {
    detail = await getBlueprint(user, id);
  } catch (err) {
    if (err instanceof AppError && (err.code === "not_found" || err.code === "forbidden" || err.code === "invalid_input")) notFound();
    throw err;
  }
  const back = (
    <Link href={blueprintHref(detail.id)} className="font-medium text-primary-ink hover:underline">Back to the Blueprint</Link>
  );
  const notice = (title: string, description: React.ReactNode) => (
    <div className="space-y-4">
      <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">Apply {detail.name} to a client</h1>
      <Card className="max-w-2xl"><EmptyState title={title} description={description} /></Card>
    </div>
  );
  if (!canDoBlueprint(user, "preview_apply")) {
    return notice("Previewing needs the Blueprint design permission", <>Your agency role can look at Blueprints but not preview applying them. {back}</>);
  }
  if (detail.status === "archived") {
    return notice(`${detail.name} is archived`, <>Archived Blueprints aren&apos;t applied. Restore it on its page first. {back}</>);
  }
  if (!detail.currentVersion || !detail.versions.length) {
    return notice(`${detail.name} has no published version`, <>Only published versions are applied to clients, so what a client receives never changes afterwards. Publish the draft on the Blueprint&apos;s page first. {back}</>);
  }
  const [clients, updates] = await Promise.all([listClientOptions(user), listUpdateCandidates(user, detail.id)]);
  const sp = await searchParams;
  const client = first(sp.client);
  const version = Number(first(sp.version));
  return (
    <ApplyWizard
      blueprint={{ id: detail.id, name: detail.name }}
      versions={JSON.parse(JSON.stringify(detail.versions))}
      clients={JSON.parse(JSON.stringify(clients))}
      updates={JSON.parse(JSON.stringify(updates))}
      canApply={canDoBlueprint(user, "apply")}
      initialClientId={client && isUuid(client) ? client : null}
      initialVersion={Number.isInteger(version) && version > 0 ? version : null}
      timeZone={user.timezone}
    />
  );
}
