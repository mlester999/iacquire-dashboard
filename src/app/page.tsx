import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getOrgContext } from "@/server/tenancy/context";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Agency staff start in the admin portal; they can open the agency workspace from there.
  if (user.platformRole !== "none") redirect("/admin");
  const ctx = await getOrgContext();
  if (!ctx) redirect(user.platformRole !== "none" ? "/admin" : "/no-workspace");
  if (ctx.org.kind === "client" && !ctx.org.onboardingCompletedAt && ctx.can("workspace.manage_profile")) redirect("/welcome");
  redirect("/overview");
}
