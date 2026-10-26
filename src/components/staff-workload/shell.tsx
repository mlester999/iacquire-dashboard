import Link from "next/link";
import { CalendarDays, Gauge, LayoutDashboard, Settings2, ShieldAlert, UserRound, Users } from "lucide-react";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The frame shared by every workload page: the title, the honest state when the module is off or the viewer may not use it, and the sub-navigation that only offers pages
// the server will actually answer for this person.

export type WorkloadTab = "overview" | "me" | "board" | "calendar" | "settings";

const TABS: Array<{ key: WorkloadTab; href: string; label: string; icon: typeof Gauge; team?: boolean; superOnly?: boolean }> = [
  { key: "overview", href: "/admin/workload", label: "Overview", icon: LayoutDashboard, team: true },
  { key: "me", href: "/admin/workload/me", label: "My workload", icon: UserRound },
  { key: "board", href: "/admin/workload/board", label: "Board", icon: Users, team: true },
  { key: "calendar", href: "/admin/workload/calendar", label: "Calendar", icon: CalendarDays, team: true },
  { key: "settings", href: "/admin/workload/settings", label: "Settings", icon: Settings2, superOnly: true },
];

export function WorkloadHeader({ active, showTeam, showSettings }: { active: WorkloadTab; showTeam: boolean; showSettings: boolean }) {
  const tabs = TABS.filter((t) => (!t.team || showTeam) && (!t.superOnly || showSettings));
  return (
    <div className="module-stack">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Agency team operations</p>
          <h1 className="mt-1 flex items-center gap-2 text-[26px] font-semibold tracking-[-0.04em] text-ink">
            <Gauge className="size-6 text-primary" aria-hidden /> Staff workload
          </h1>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">
            Who is carrying what, from the work recorded in iAcquire. A label is a prompt to look at how work is shared, never a score of a person.
          </p>
        </div>
        <Badge tone="outline" className="h-7 px-3">
          Internal only · clients never see this
        </Badge>
      </div>
      {tabs.length > 1 && (
        <nav aria-label="Staff workload sections" className="flex flex-wrap gap-1.5 border-b border-line pb-2">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              aria-current={active === t.key ? "page" : undefined}
              className={cn(
                "inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[14px] font-medium transition",
                active === t.key ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-ink",
              )}
            >
              <t.icon className="size-4" aria-hidden /> {t.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

export function WorkloadOff({ canEnable, enableAction }: { canEnable: boolean; enableAction: () => Promise<void> }) {
  return (
    <EmptyState
      headingLevel={2}
      icon={<Gauge className="size-5" />}
      title="Staff workload is switched off"
      description="Nothing is collected while it is off. A Super Admin can switch it on for the agency workspace; switching it on connects nothing and sends nothing."
      action={
        canEnable ? (
          <form action={enableAction}>
            <Button type="submit" variant="brand">
              Switch staff workload on
            </Button>
          </form>
        ) : (
          <ButtonLink href="/admin/workload/settings" variant="secondary">
            About staff workload
          </ButtonLink>
        )
      }
    />
  );
}

export function WorkloadDenied() {
  return (
    <EmptyState
      headingLevel={2}
      icon={<ShieldAlert className="size-5" />}
      title="Staff workload is not available to you"
      description="Your agency role does not hold the workload view permission, or the agency workspace is not ready yet. Ask a Super Admin if you should have it."
    />
  );
}

export function TeamOnly({ what }: { what: string }) {
  return (
    <EmptyState
      headingLevel={2}
      icon={<Users className="size-5" />}
      title={`${what} needs the team permission`}
      description="You can still see your own load, your own work and your own time off."
      action={
        <ButtonLink href="/admin/workload/me" variant="secondary">
          Open my workload
        </ButtonLink>
      }
    />
  );
}
