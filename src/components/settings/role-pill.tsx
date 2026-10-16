import { Crown, Eye, Handshake, Headset, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import { StatusPill, type StatusTone } from "@/components/ui/status";
import { ROLE_LABELS, type OrgRole } from "@/lib/permissions";

export const ROLE_META: Record<OrgRole, { tone: StatusTone; icon: LucideIcon }> = {
  owner: { tone: "violet", icon: Crown },
  admin: { tone: "primary", icon: ShieldCheck },
  member: { tone: "neutral", icon: UserRound },
  sales_rep: { tone: "neutral", icon: Handshake },
  support: { tone: "neutral", icon: Headset },
  viewer: { tone: "neutral", icon: Eye },
};

/** A role is a kind of access, shown as a quiet pill with its own icon so it can be scanned down a list. */
export function RolePill({ role, size = "sm" }: { role: OrgRole; size?: "sm" | "md" }) {
  const meta = ROLE_META[role] ?? ROLE_META.member;
  const Icon = meta.icon;
  return (
    <StatusPill tone={meta.tone} size={size} icon={<Icon className="size-3" aria-hidden />}>
      {ROLE_LABELS[role] ?? role}
    </StatusPill>
  );
}
