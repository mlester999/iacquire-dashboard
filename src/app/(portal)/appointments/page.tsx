import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { nativeAppointmentsHome } from "@/server/calendars/schedule";
import { getAppointments } from "@/server/queries/business";
import { getAgentByRole } from "@/server/workforce/service";
import { listPendingBookings } from "@/server/appointments/overview";
import { getPolicyView } from "@/server/appointments/settings";
import { AppointmentsView } from "@/components/appointments/appointments-view";
import { NotConnected } from "@/components/not-connected";
import { canChat } from "@/lib/agents";
import { CalendarDays } from "lucide-react";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Appointments" };

export default async function AppointmentsPage() {
  const ctx = await requireOrgContext("appointments.view");
  // When iAcquire's own calendar owns appointments, they are managed in the CRM calendar; GoHighLevel workspaces keep this view.
  if (ctx.org.kind === "client" && ctx.can("crm.view")) {
    const home = await nativeAppointmentsHome(ctx.org.orgId);
    if (home) redirect(home);
  }
  const [data, setter, pending, policy] = await Promise.all([
    getAppointments(ctx),
    getAgentByRole(ctx.user.id, ctx.org.orgId, "appointment_setter"),
    listPendingBookings(ctx),
    getPolicyView(ctx),
  ]);
  return (
    <div className="space-y-6">
      <PageHero target="appointments.hero" eyebrow="Your meeting schedule" title="Make room for better conversations." description={<>Your calendar&apos;s recorded meetings, confirmations and booking links, shown in {ctx.org.timezone.replace(/_/g," ")}. Your Appointment Setter only ever offers times your calendar reports as free.</>} icon={<CalendarDays className="size-4"/>} tone="neutral"/>
      {data.connected ? (
        <AppointmentsView
          appointments={JSON.parse(JSON.stringify(data.appointments))}
          timeZone={ctx.org.timezone}
          lastSync={data.integration?.last_checked_at ? new Date(data.integration.last_checked_at).toISOString() : null}
          canRefresh={ctx.can("integrations.view") && !ctx.org.isDemo}
          setterReady={Boolean(setter?.enabled && canChat(setter.status))}
          pending={pending}
          policy={policy}
          canBook={ctx.can("appointments.book")}
          canManage={ctx.can("appointments.manage")}
          canGoAutonomous={ctx.can("automation.go_autonomous")}
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
