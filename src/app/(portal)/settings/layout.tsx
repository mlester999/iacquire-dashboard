import { Globe, Settings } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { invoicesEnabled } from "@/server/invoices/feature";
import { SettingsNav } from "@/components/settings/settings-nav";
import { PageHero } from "@/components/ui/workspace";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { ROLE_LABELS } from "@/lib/permissions";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext();
  // Customer payments are a client workspace's own, and only once a Super Admin has switched invoicing on for it.
  const features = ctx.org.kind === "client" && ctx.can("invoices.connect_payments") && (await invoicesEnabled(ctx.org.orgId)) ? ["invoices"] : [];
  return (
    <div className="space-y-6">
      <PageHero
        tone="neutral"
        eyebrow="Workspace preferences"
        title="Make iAcquire work the way you do."
        description="Manage your business profile, team access, AI preferences and account security. Your permissions determine what you can change."
        icon={<Settings />}
        aside={
          <div className="flex items-center gap-3.5 rounded-2xl border border-line bg-surface/80 p-4 shadow-soft">
            <AvatarTile name={ctx.org.name} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold tracking-tight text-ink" title={ctx.org.name}>
                {ctx.org.name}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <StatusPill tone="primary" size="sm">
                  {ROLE_LABELS[ctx.role]}
                </StatusPill>
                <InfoChip icon={<Globe aria-hidden />}>{ctx.org.timezone.replace(/_/g, " ")}</InfoChip>
              </div>
            </div>
          </div>
        }
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[232px_minmax(0,1fr)]">
        <div className="min-w-0 self-start lg:sticky lg:top-24">
          <SettingsNav permissions={ctx.permissions} features={features} />
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
