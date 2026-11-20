import { Activity, AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { Badge, Card } from "@/components/ui/primitives";

export type ServiceState = "verified" | "attention" | "not_configured" | "configured" | "error" | "switched_off";
const STATES = {
  verified: { text: "Verified", tone: "success", icon: CheckCircle2 },
  attention: { text: "Needs attention", tone: "warning", icon: AlertTriangle },
  not_configured: { text: "Not configured", tone: "neutral", icon: Activity },
  configured: { text: "Configured · not verified", tone: "primary", icon: ShieldCheck },
  error: { text: "Check failed", tone: "danger", icon: XCircle },
  switched_off: { text: "Switched off", tone: "neutral", icon: Activity },
} as const;
export function ServiceCard({ icon, name, state, detail, note }: { icon: React.ReactNode; name: string; state: ServiceState; detail: React.ReactNode; note?: string }) {
  const semantic = STATES[state]; const StatusIcon = semantic.icon;
  return <Card className="flex min-w-0 flex-col p-5"><div className="flex flex-wrap items-center justify-between gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-primary-ink">{icon}</span><Badge tone={semantic.tone}><StatusIcon className="size-3" />{semantic.text}</Badge></div><h2 className="mt-4 text-[15px] font-semibold">{name}</h2><div className="mt-2 break-words text-[14px] leading-relaxed text-muted">{detail}</div>{note && <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-muted">{note}</p>}</Card>;
}
