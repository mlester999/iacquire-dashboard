import { requireOrgContext } from "@/server/tenancy/context";
import { getOnboarding } from "@/server/onboarding/service";
import { FocusedOnboarding } from "@/components/onboarding/focused-wizard";

export const metadata = { title: "Company setup" };

export default async function OnboardingPage() {
  const ctx = await requireOrgContext("workspace.manage_profile");
  const state = await getOnboarding(ctx);
  return <FocusedOnboarding initialData={state.data} initialStep={state.step} enabledRoles={state.enabledRoles} completedAt={state.completedAt} resumeKey={`${ctx.org.orgId}:${ctx.user.id}`} />;
}
