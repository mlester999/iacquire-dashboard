import { sentenceCase } from "@/lib/utils";
import { statusLabel, type StatusTone } from "@/components/ui/status";

/** Plain helpers shared by the support list, the new-request dialog and the request page (no JSX, so server and client can both use them). */

export const TICKET_CATEGORIES = ["general", "ai_employees", "integrations", "onboarding", "account", "billing", "bug"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export function categoryLabel(category: string) {
  return category === "ai_employees" ? "AI employees" : sentenceCase(category);
}

/** From the client's point of view "waiting for client" is "waiting for you". */
export function ticketStatusLabel(status: string) {
  return status === "waiting_for_client" ? "Waiting for you" : statusLabel(status);
}

export function ticketStatusTone(status: string): StatusTone {
  switch (status) {
    case "resolved":
      return "success";
    case "closed":
      return "neutral";
    case "waiting_for_client":
      return "warning";
    default:
      return "primary";
  }
}

export const PRIORITY_TONE: Record<(typeof TICKET_PRIORITIES)[number], StatusTone> = {
  low: "neutral",
  normal: "primary",
  high: "warning",
  urgent: "danger",
};
