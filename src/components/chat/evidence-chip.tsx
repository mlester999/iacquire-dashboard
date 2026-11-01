import { StatusPill } from "@/components/ui/status";
import { evidenceChip, parseEvidenceMarker } from "@/lib/evidence-class";
import { formatChatTime } from "@/lib/conversation-time";
import { cn } from "@/lib/utils";

/**
 * Says what kind of reply a message is: written by the AI, read from the person's records, proposed and not applied, approved and applied, done and confirmed, or a notice from
 * iAcquire itself. `evidence` is whatever was stored or sent with the message; it is parsed strictly here too, so a missing, legacy or damaged marker renders nothing at all
 * rather than a guess.
 */
export function EvidenceChip({ evidence, timeZone, className }: { evidence: unknown; timeZone?: string; className?: string }) {
  const marker = parseEvidenceMarker(evidence);
  if (!marker) return null;
  const chip = evidenceChip(marker, { formatTime: (iso) => formatChatTime(iso, timeZone) });
  return (
    <span className={cn("inline-flex max-w-full", className)} data-evidence-class={marker.class} title={chip.hint}>
      <StatusPill tone={chip.tone} size="sm" className="h-auto min-h-5 max-w-full whitespace-normal py-0.5 leading-snug">
        {chip.label}
      </StatusPill>
      <span className="sr-only">. {chip.hint}</span>
    </span>
  );
}
