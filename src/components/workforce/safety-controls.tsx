import { ChevronDown, ShieldCheck } from "lucide-react";
import { EmergencyControls } from "@/components/workforce/operating-controls";
import { IconTile } from "@/components/overview/panel";
import { StatusPill } from "@/components/ui/status";

export function WorkforceSafetyControls({
  messagingPaused,
  outboundPaused,
  agencyPaused,
  canPause,
  outboundMessagingEnabled = false,
}: {
  messagingPaused: boolean;
  outboundPaused: boolean;
  agencyPaused: boolean;
  canPause: boolean;
  outboundMessagingEnabled?: boolean;
}) {
  const workspacePaused = messagingPaused || outboundPaused;
  const paused = workspacePaused || agencyPaused;
  const outboundStopped = !outboundMessagingEnabled;

  return (
    <details className="group card-surface overflow-hidden rounded-2xl" open={paused}>
      <summary className="grid min-h-16 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary min-[480px]:flex [&::-webkit-details-marker]:hidden">
        <IconTile tone={paused || outboundStopped ? "warning" : "primary"} className="row-span-2"><ShieldCheck /></IconTile>
        <span className="col-start-2 row-start-1 min-w-0 flex-1">
          <span className="block text-[14px] font-semibold tracking-tight">Safety controls</span>
          <span className="mt-0.5 hidden text-[13px] text-muted sm:block">Review workspace and agency pauses.</span>
        </span>
        <span className="col-start-2 row-start-2">
          {outboundStopped
            ? <StatusPill tone="warning">Outbound stopped</StatusPill>
            : agencyPaused
              ? <StatusPill tone="danger">Agency pause</StatusPill>
              : workspacePaused
                ? <StatusPill tone="warning">Workspace pause</StatusPill>
                : <StatusPill tone="neutral">No active pauses</StatusPill>}
        </span>
        <ChevronDown className="col-start-3 row-span-2 row-start-1 size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-line p-3">
        {outboundStopped && (
          <p className="rounded-xl bg-warning-soft px-4 py-3 text-[14px] leading-relaxed text-warning-ink">
            Outbound customer messaging is disabled across this environment. Workspace and agency pauses apply separately.
          </p>
        )}
        <EmergencyControls messagingPaused={messagingPaused} outboundPaused={outboundPaused} agencyPaused={agencyPaused} canPause={canPause} />
      </div>
    </details>
  );
}
