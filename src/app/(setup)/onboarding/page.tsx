import { requireOrgContext } from "@/server/tenancy/context";
import { getOnboardingSession, listOnboardingFiles } from "@/server/onboarding/service";
import { AdaptiveOnboarding } from "@/components/onboarding/adaptive-onboarding";
import { QUESTIONS } from "@/lib/onboarding/definitions";

export const metadata = { title: "Company setup" };

// A link from the setup page can open one question and bring the person back afterwards. Both values come from the address, so both are checked: the question must be one the
// questionnaire has, and the way back must be one of these exact pages of this site (never an address, never a path with anything extra on it).
const RETURN_PATHS: ReadonlySet<string> = new Set(["/setup", "/overview"]);
const firstOf = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ question?: string | string[]; return?: string | string[] }> }) {
  const ctx = await requireOrgContext("workspace.manage_profile");
  const { question, return: back } = await searchParams;
  const asked = firstOf(question);
  const startQuestionId = QUESTIONS.find((q) => q.id === asked)?.id ?? null;
  const wanted = firstOf(back);
  const returnTo = wanted !== undefined && RETURN_PATHS.has(wanted) ? wanted : null;
  const [session, files] = await Promise.all([getOnboardingSession(ctx), listOnboardingFiles(ctx)]);
  return <AdaptiveOnboarding key={`${ctx.org.orgId}:${session.revision}`} session={session} assets={files.assets} documents={files.documents} startQuestionId={startQuestionId} returnTo={returnTo} />;
}
