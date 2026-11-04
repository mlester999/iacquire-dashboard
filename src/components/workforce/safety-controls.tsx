import { ChevronDown, ShieldCheck } from "lucide-react";
import { EmergencyControls } from "@/components/workforce/operating-controls";
import { IconTile } from "@/components/overview/panel";
import { StatusPill } from "@/components/ui/status";

export function WorkforceSafetyControls({
  messagingPaused,
  outboundPaused,
  agencyPaused,
  canPause,
}: {
  messagingPaused: boolean;
  outboundPaused: boolean;
  agencyPaused: boolean;
  canPause: boolean;
}) {
  const paused = messagingPaused || outboundPaused || agencyPaused;

  return (
    <details className="group card-surface overflow-hidden rounded-2xl" open={paused}>
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <IconTile tone={paused ? "warning" : "primary"}><ShieldCheck /></IconTile>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold tracking-tight">Safety controls</span>
          <span className="mt-0.5 hidden text-[13px] text-muted sm:block">Pause messaging or outbound actions at any time.</span>
        </span>
        {agencyPaused
          ? <StatusPill tone="danger">Agency pause</StatusPill>
          : messagingPaused || outboundPaused
            ? <StatusPill tone="warning">Pause in effect</StatusPill>
            : <StatusPill tone="success">Nothing paused</StatusPill>}
        <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-line p-3">
        <EmergencyControls messagingPaused={messagingPaused} outboundPaused={outboundPaused} agencyPaused={agencyPaused} canPause={canPause} />
      </div>
    </details>
  );
}
