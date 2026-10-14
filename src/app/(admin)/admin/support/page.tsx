import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getTicketForAgency, listAgencyTickets, TICKET_STATUSES, type TicketStatus } from "@/server/support/service";
import { SupportInbox, type SupportSelection } from "@/components/admin/support-inbox";

export const metadata = { title: "Support inbox" };
const FILTERS=["active",...TICKET_STATUSES] as const;

export default async function AdminSupportPage({searchParams}:{searchParams:Promise<{status?:string;ticket?:string}>}) {
  const {status,ticket}=await searchParams;
  const user=await requireAgency();
  const filter=(FILTERS as readonly string[]).includes(status??"")?status as TicketStatus|"active":"active";
  const tickets=await listAgencyTickets(user,filter);
  let selected:SupportSelection|null=null;
  if(ticket){
    if(!/^[0-9a-f-]{36}$/i.test(ticket))notFound();
    const detail=await getTicketForAgency(user,ticket);
    if(!detail)notFound();
    selected={ticket:detail.ticket,messages:JSON.parse(JSON.stringify(detail.messages)) as SupportSelection["messages"]};
  }
  return <SupportInbox tickets={tickets} filter={filter} selected={selected} timeZone={user.timezone} statuses={TICKET_STATUSES}/>;
}
