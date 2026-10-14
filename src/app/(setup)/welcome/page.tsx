import { requireOrgContext } from "@/server/tenancy/context";
import { WelcomeHero } from "@/components/onboarding/welcome-hero";

export const metadata = { title: "Welcome" };

export default async function WelcomePage() {
  const ctx = await requireOrgContext("workspace.manage_profile");
  return <WelcomeHero firstName={ctx.user.fullName.split(" ")[0] || null} orgName={ctx.org.name} resumed={Boolean(ctx.org.onboardingCompletedAt)} />;
}
