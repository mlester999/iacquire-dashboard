import "server-only";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import type { ReviewProvider as Site } from "@/lib/reputation/external";
import { googleReady, googleReviewProvider, googleSettings } from "@/server/reputation/providers/google";
import { metaReviewProvider, metaRepliesReady, metaReviewsReady } from "@/server/reputation/providers/meta-reviews";
import { simulatedReviewProvider } from "@/server/reputation/providers/simulated";
import type { ReviewAdapter, ReviewProvider } from "@/server/reputation/providers/types";

/** The simulated review site returns made-up reviews, so it must never be mistaken for a real connection: it does not exist in production. */
export const simulatedAllowed = () => env().NODE_ENV !== "production";

export function reviewProviderFor(adapter: ReviewAdapter): ReviewProvider {
  if (adapter === "simulated") {
    if (!simulatedAllowed()) throw new AppError("forbidden", "Simulated review sites are not available in production.");
    return simulatedReviewProvider;
  }
  return adapter === "google" ? googleReviewProvider : metaReviewProvider;
}

export interface SiteEnvironment {
  /** Reading this site is switched on and set up in this environment. */
  ready: boolean;
  /** Plain words for what is missing, with no setting names; null when ready. */
  missing: string | null;
  /** Posting replies there is switched on as well. */
  repliesReady: boolean;
}

/** Whether the deployment may read (and reply on) a real site. Off by default: each is a step that needs the site's approval first. */
export function siteEnvironment(site: Site): SiteEnvironment {
  if (site === "google") {
    const s = googleSettings();
    const ready = googleReady(s);
    return {
      ready,
      missing: ready ? null : !s.approved
        ? "Google hasn't approved iAcquire's access to Business Profile reviews yet, so nothing can be connected. Your Google review link still works as usual."
        : "iAcquire's Google project isn't set up in this deployment yet, so nothing can be connected. Your Google review link still works as usual.",
      repliesReady: ready && s.repliesEnabled,
    };
  }
  const ready = metaReviewsReady();
  return {
    ready,
    missing: ready ? null : "Meta hasn't approved iAcquire to read recommendations on Facebook Pages yet, so nothing can be connected. Your Facebook review link still works as usual.",
    repliesReady: metaRepliesReady(),
  };
}
