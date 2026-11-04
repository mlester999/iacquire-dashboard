import { Check } from "lucide-react";
import type { JourneyStep } from "@/lib/purchase-intents/rules";

/** The four stops from the invitation to a workspace, with the buyer's place marked. It only draws what buyerJourney (rules.ts) says. */
export function JourneySteps({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="room-steps" aria-label="Progress of this purchase">
      {steps.map((step, i) => (
        <li key={step.label} className="room-step" data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
          <span className="room-step-dot" aria-hidden>{step.state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}</span>
          <span>{step.label}<span className="sr-only">{step.state === "done" ? " (done)" : step.state === "current" ? " (now)" : ""}</span></span>
        </li>
      ))}
    </ol>
  );
}
