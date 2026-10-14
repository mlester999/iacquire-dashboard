import { requireOrgContext } from "@/server/tenancy/context";
import { listTickets } from "@/server/support/service";
import { SupportWorkspace } from "@/components/support/support-workspace";
export const metadata = { title: "Support" };
export default async function SupportPage() {
  const ctx=await requireOrgContext("support.use");
  const tickets=await listTickets(ctx);
  return <SupportWorkspace tickets={tickets.map((t)=>({id:t.id,ref:t.ref,subject:t.subject,category:t.category,status:t.status,created_by_name:t.created_by_name,is_assigned:t.is_assigned,last_message_at:new Date(t.last_message_at).toISOString()}))} />;
}
