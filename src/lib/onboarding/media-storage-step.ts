// The optional "media_storage" step of the Setup Center (migration 0102) only tells a client where the pictures and videos of their social media posts may be kept. The words come
// from the storage policy every time (src/lib/social/media-policy.ts), so the step can never promise storage the workspace does not have. It connects nothing and completes nothing.
import type { StoragePolicy } from "@/lib/social/media-policy";

/** The key of the step in the default checklist template (migration 0102). */
export const MEDIA_STORAGE_STEP_KEY = "media_storage";

/** One honest paragraph: what the policy allows now, why each other place is not available, and that the step is optional. */
export function mediaStorageStepText(policy: StoragePolicy): string {
  const unavailable = policy.options.filter((o) => !o.available && o.reason).map((o) => `${o.label}: ${o.reason}`);
  return [policy.summary, ...unavailable, "This step is optional. It connects nothing and changes nothing."].join(" ");
}
