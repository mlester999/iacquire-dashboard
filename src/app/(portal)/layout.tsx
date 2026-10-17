import { requireOrgContext } from "@/server/tenancy/context";
import { getShellData } from "@/server/queries/shell";
import { PortalShell } from "@/components/shell/portal-shell";

export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext();
  const data = await getShellData(ctx);
  return <PortalShell data={data}>{children}</PortalShell>;
}
