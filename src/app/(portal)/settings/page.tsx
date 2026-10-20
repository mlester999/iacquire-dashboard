import { requireOrgContext } from "@/server/tenancy/context";
import { getProfile } from "@/server/settings/service";
import { ProfileForms } from "@/components/settings/settings-forms";

export const metadata = { title: "Settings" };

export default async function SettingsProfilePage() {
  const ctx = await requireOrgContext();
  const p = await getProfile(ctx);
  return (
    <ProfileForms
      canEdit={ctx.can("workspace.manage_profile")}
      walkthroughsEnabled={ctx.user.platformRole !== "agency_super_admin"}
      profile={{
        name: p?.name ?? ctx.org.name,
        industry: p?.industry ?? "",
        website: p?.website ?? "",
        region: p?.region ?? "",
        timezone: p?.timezone ?? ctx.org.timezone,
        description: p?.description ?? "",
        services: p?.services ?? "",
        idealCustomers: p?.ideal_customers ?? "",
        brandColor: p?.brand_color ?? "",
      }}
      user={{ fullName: ctx.user.fullName, email: ctx.user.email, timezone: ctx.user.timezone }}
    />
  );
}
