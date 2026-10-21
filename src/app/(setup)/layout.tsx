import { Building2 } from "lucide-react";
import { InfoChip } from "@/components/ui/status";
import { requireOrgContext } from "@/server/tenancy/context";
import { Logo } from "@/components/brand";
import { AuthAppearance } from "@/components/auth/appearance";

export const dynamic = "force-dynamic";

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext("workspace.manage_profile");
  return (
    <div className="app-backdrop grain relative min-h-dvh">
      <header className="relative z-10 mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <div className="flex items-center gap-3 text-[13px] text-muted">
          <span className="hidden max-w-[16rem] sm:inline-flex">
            <InfoChip icon={<Building2 />}>{ctx.org.name}</InfoChip>
          </span>
          <div id="onboarding-header-actions" />
          <AuthAppearance />
        </div>
      </header>
      <div className="relative z-10">{children}</div>
    </div>
  );
}
