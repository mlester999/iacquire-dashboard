import type { StatusTone } from "@/components/ui/status";
import type { AgencyWebsiteView } from "@/server/websites/agency";

/** The one-line state of a client's website, shared by the page hero and the website panel so they can never disagree. */
export function websiteState(data: Pick<AgencyWebsiteView, "exists" | "published">): { tone: StatusTone; label: string } {
  if (!data.exists) return { tone: "neutral", label: "No website yet" };
  const pub = data.published;
  if (!pub) return { tone: "neutral", label: "Not published" };
  if (pub.health === "healthy") return { tone: "success", label: "Live and confirmed" };
  if (pub.health === "unhealthy") return { tone: "danger", label: "Published, failing its check" };
  return { tone: "warning", label: "Published, not yet confirmed" };
}
