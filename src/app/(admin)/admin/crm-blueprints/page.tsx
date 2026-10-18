import { requireAgency } from "@/server/tenancy/context";
import { listBlueprints, listClientOptions, listLibraryFolders, listStarters } from "@/server/crm/blueprints/library";
import { BlueprintLibrary } from "@/components/crm-blueprints/library";
import { blueprintPermissions, isUuid, orNote } from "./load";

export const metadata = { title: "CRM Blueprints" };

/**
 * The agency's CRM Blueprints & Snapshots library. `?new=1` opens New Blueprint; `?capture=<orgId>` opens capture for that client;
 * `?client=<orgId>` (the client page's "Apply a Blueprint") shows the library for choosing a Blueprint to apply to that client, with every
 * Apply link going to that client's preview. Only a client this person can reach is ever preselected; anything else is ignored.
 */
export default async function CrmBlueprintsPage({ searchParams }: { searchParams: Promise<{ new?: string; capture?: string; client?: string }> }) {
  const user = await requireAgency();
  const permissions = blueprintPermissions(user);
  const { new: openNew, capture, client } = await searchParams;
  // The library filters on the page (instant, kept in the address), so it loads the active collection and the archived one.
  const [active, archived, folders, starters, clients] = await Promise.all([
    listBlueprints(user),
    listBlueprints(user, { collection: "archived" }),
    listLibraryFolders(user),
    orNote(() => listStarters(user), []),
    permissions.capture || permissions.apply ? orNote(() => listClientOptions(user), []) : Promise.resolve({ value: [], note: null }),
  ]);
  const captureOrgId = permissions.capture && isUuid(capture) && clients.value.some((c) => c.id === capture) ? capture : null;
  const applyFor = permissions.apply && isUuid(client) ? clients.value.find((c) => c.id === client) ?? null : null;
  return (
    <BlueprintLibrary key={applyFor?.id ?? "library"} blueprints={[...active, ...archived.filter((a) => !active.some((b) => b.id === a.id))]} folders={folders} starters={starters.value}
      clients={permissions.capture ? clients.value : []} permissions={permissions} captureOrgId={captureOrgId} openNew={openNew === "1"} applyFor={applyFor} />
  );
}
