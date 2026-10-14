import { requireOrgContext } from "@/server/tenancy/context";
import { getMyStaffProfile, listStaffProfiles } from "@/server/staff/service";
import { EscalationPreferences } from "@/components/settings/escalation-preferences";

export const metadata = { title: "Escalations and availability" };

export default async function EscalationSettingsPage() {
  const ctx = await requireOrgContext("staff.availability");
  const me = await getMyStaffProfile(ctx);
  const canConfigure = ctx.can("escalations.configure");
  const team = canConfigure ? await listStaffProfiles(ctx) : [];
  return <EscalationPreferences me={me} team={team} isOwner={ctx.role === "owner"} canConfigure={canConfigure} ownerMode={me.ownerPriorityMode} />;
}
