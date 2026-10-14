import type { DomainView } from "@/server/websites/service";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

/** One plain word for where a domain is in the connection process. "Connected" is only said once the live check passed. */
export function domainStatusLabel(d: Pick<DomainView, "kind" | "status" | "acquisition" | "liveOk" | "routingOk" | "sslStatus">): string {
  if (d.kind === "platform") return d.liveOk === false ? "Unreachable" : "Included";
  if (d.acquisition === "purchase_requested") return "Awaiting quote";
  if (d.acquisition === "purchase_approved") return "Being purchased";
  if (d.status === "error") return "Needs attention";
  if (d.status === "pending_dns") return "Waiting for DNS";
  if (d.status === "verified") return d.routingOk ? (d.sslStatus === "ready" ? (d.liveOk ? "Connected" : "Almost there") : "Waiting for certificate") : "Point it at us";
  if (d.status === "active") return d.liveOk ? "Connected" : "Almost there";
  return "Removed";
}

export function domainStatusTone(d: Pick<DomainView, "kind" | "status" | "acquisition" | "liveOk" | "routingOk" | "sslStatus">): Tone {
  const l = domainStatusLabel(d);
  if (l === "Connected" || l === "Included") return "success";
  if (l === "Needs attention" || l === "Unreachable") return "danger";
  if (l === "Awaiting quote" || l === "Being purchased") return "primary";
  return "warning";
}
