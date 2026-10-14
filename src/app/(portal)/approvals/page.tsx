import { requireOrgContext } from "@/server/tenancy/context";
import { listApprovals } from "@/server/approvals/service";
import { ApprovalCenter } from "@/components/approvals/approval-center";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const ctx = await requireOrgContext("approvals.view");
  const rows = await listApprovals(ctx, "all");
  const data = JSON.parse(JSON.stringify(rows)) as typeof rows;
  return (
    <ApprovalCenter
      approvals={data as never}
      canDecide={ctx.can("approvals.decide")}
      canDecideHigh={ctx.can("approvals.decide_high")}
      timeZone={ctx.org.timezone}
    />
  );
}
