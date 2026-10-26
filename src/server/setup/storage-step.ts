import "server-only";
import type { Queryable } from "@/server/db";
import { workspaceEntitlements } from "@/server/entitlements";
import { mediaStoragePolicy } from "@/lib/social/media-policy";
import { mediaStorageStepText } from "@/lib/onboarding/media-storage-step";

/**
 * What the client's optional media storage step says, read from the storage policy for this workspace right now. Managed storage follows the maintenance plan exactly as the social
 * media library does (src/server/entitlements.ts, one answer for both); Google Drive and OneDrive are never reported as connected because that connection is not built (the same
 * rule as getMediaPolicy in src/server/social/media.ts). Trusted code: the caller has authorized the person for `orgId`.
 */
export async function mediaStorageStepDescription(db: Queryable, orgId: string): Promise<string> {
  const managed = (await workspaceEntitlements(db, orgId)).managedStorage;
  return mediaStorageStepText(mediaStoragePolicy({ managedPlanActive: managed, googleDriveConnected: false, onedriveConnected: false }));
}
