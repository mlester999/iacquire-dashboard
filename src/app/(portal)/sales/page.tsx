import { requireOrgContext } from "@/server/tenancy/context";
import { getSalesPipeline } from "@/server/queries/business";
import { NotConnected } from "@/components/not-connected";
import { SalesBoard } from "@/components/sales/sales-board";
import { Handshake } from "lucide-react";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Sales Pipeline" };

export default async function SalesPage() {
  const ctx = await requireOrgContext("sales.view");
  const data = await getSalesPipeline(ctx);
  return (
    <div className="space-y-6">
      <PageHero eyebrow="Sales pipeline" title="See the next opportunity. Know the next step." description="A clear view of your CRM opportunities, deal stages and follow-ups. Your team can add notes and tasks; AI-proposed changes always go through approval." icon={<Handshake className="size-4"/>}/>
      {data.connected ? (
        <SalesBoard
          data={JSON.parse(JSON.stringify(data))}
          canNote={ctx.can("notes.write")}
          canTask={ctx.can("tasks.manage")}
          canRefresh={ctx.can("integrations.view") && !ctx.org.isDemo}
          timeZone={ctx.org.timezone}
        />
      ) : (
        <NotConnected
          title="Your CRM isn't connected yet"
          body="Once iAcquire connects your GoHighLevel location, your pipeline stages, opportunities and deal values appear here — read-only, with any changes going through approval."
          canRequest={ctx.can("support.use")}
        />
      )}
    </div>
  );
}
