import { requireOrgContext } from "@/server/tenancy/context";
import { getOnboardingSession, listOnboardingFiles } from "@/server/onboarding/service";
import { AdaptiveOnboarding } from "@/components/onboarding/adaptive-onboarding";

export const metadata = { title: "Company setup" };

export default async function OnboardingPage() {
  const ctx = await requireOrgContext("workspace.manage_profile");
  const [session, files] = await Promise.all([getOnboardingSession(ctx), listOnboardingFiles(ctx)]);
  return <AdaptiveOnboarding key={`${ctx.org.orgId}:${session.revision}`} session={session} assets={files.assets} documents={files.documents} />;
}
