import { requireOrgContext } from "@/server/tenancy/context";
import { invoicesEnabled } from "@/server/invoices/feature";
import { receivablesSummary } from "@/server/invoices/invoices";
import { InvoicesClientOnly, InvoicesNotEnabled } from "@/components/invoices/notices";
import { InvoicesSubnav } from "@/components/invoices/subnav";

export default async function InvoicesLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext("invoices.view");
  // Invoices are a client workspace's own bill to its own customer. An agency workspace gets an honest notice, and its pages are never rendered (so they query nothing).
  if (ctx.org.kind !== "client") return <InvoicesClientOnly canOpenClients={ctx.user.platformRole !== "none"} />;
  // A Super Admin switches the module on per workspace. Until then every page of it says so, and nothing is read.
  if (!(await invoicesEnabled(ctx.org.orgId))) return <InvoicesNotEnabled isOwner={ctx.role === "owner"} />;
  const { pendingApproval } = await receivablesSummary(ctx);
  return (
    <div className="space-y-5">
      <InvoicesSubnav waiting={pendingApproval} canConnect={ctx.can("invoices.connect_payments")} />
      {children}
    </div>
  );
}
