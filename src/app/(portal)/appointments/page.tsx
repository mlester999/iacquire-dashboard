import { requireOrgContext } from "@/server/tenancy/context";
import { getAppointments } from "@/server/queries/business";
import { getAgentByRole } from "@/server/workforce/service";
import { AppointmentsView } from "@/components/appointments/appointments-view";
import { NotConnected } from "@/components/not-connected";
import { canChat } from "@/lib/agents";
import { CalendarDays } from "lucide-react";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Appointments" };

export default async function AppointmentsPage() {
  const ctx = await requireOrgContext("appointments.view");
  const [data, setter] = await Promise.all([getAppointments(ctx), getAgentByRole(ctx.user.id, ctx.org.orgId, "appointment_setter")]);
  return (
    <div className="space-y-6">
      <PageHero eyebrow="Your meeting schedule" title="Make room for better conversations." description={<>Your calendar&apos;s recorded meetings, confirmations and booking links, shown in {ctx.org.timezone.replace(/_/g," ")}. Your Appointment Setter uses real availability.</>} icon={<CalendarDays className="size-4"/>} tone="neutral"/>
      {data.connected ? (
        <AppointmentsView
          appointments={JSON.parse(JSON.stringify(data.appointments))}
          timeZone={ctx.org.timezone}
          lastSync={data.integration?.last_checked_at ? new Date(data.integration.last_checked_at).toISOString() : null}
          canRefresh={ctx.can("integrations.view") && !ctx.org.isDemo}
          setterReady={Boolean(setter?.enabled && canChat(setter.status))}
        />
      ) : (
        <NotConnected
          title="Your calendar isn't connected yet"
          body="Once iAcquire connects your GoHighLevel calendar, your upcoming meetings, booking status and history appear here. Your Appointment Setter only ever offers real availability."
          canRequest={ctx.can("support.use")}
        />
      )}
    </div>
  );
}

