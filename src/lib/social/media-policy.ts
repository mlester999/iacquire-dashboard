// Where a client's post media may live. Pure.
//
// The rule (from the product's storage policy): a client on the managed maintenance plan may use the platform's managed storage, within its fair-use limits.
// A client without it is expected to keep media in its own Google Drive or OneDrive. Managed storage is never handed out silently to everyone.
//
// Connecting Google Drive or OneDrive is NOT built (it needs an OAuth app registered with each provider; see blockers.md). So for a client without the managed
// plan the honest answer today is: no media storage is available yet, and text and link posts work. The policy reports that as it is rather than pretending.

export interface StorageFacts {
  /** An active (or past-due or cancel-requested) managed maintenance subscription. */
  managedPlanActive: boolean;
  googleDriveConnected: boolean;
  onedriveConnected: boolean;
  /** Managed media the workspace keeps now, and the most it may keep (bytes). Both default to "not measured" for callers that only ask what is allowed. */
  usedBytes?: number;
  limitBytes?: number;
}

export type MediaSource = "managed" | "google_drive" | "onedrive";

export interface SourceOption {
  source: MediaSource;
  label: string;
  available: boolean;
  /** Why it is not available, in the person's terms. Null when it is. */
  reason: string | null;
}

export interface StoragePolicy {
  /** The person may upload files to managed storage. */
  managedUploadAllowed: boolean;
  /** Bytes of managed media the workspace keeps now. */
  usedBytes: number;
  /** The most managed media it may keep. Null when managed upload is not allowed: there is nothing to measure against. */
  limitBytes: number | null;
  options: SourceOption[];
  /** One honest sentence about what media can be used right now. */
  summary: string;
}

export function mediaStoragePolicy(f: StorageFacts): StoragePolicy {
  const options: SourceOption[] = [
    {
      source: "managed", label: "iAcquire storage", available: f.managedPlanActive,
      reason: f.managedPlanActive ? null : "Included with the managed maintenance plan. Without it, media is kept in your own Google Drive or OneDrive.",
    },
    {
      source: "google_drive", label: "Your Google Drive", available: f.googleDriveConnected,
      reason: f.googleDriveConnected ? null : "Connecting Google Drive is not available yet.",
    },
    {
      source: "onedrive", label: "Your OneDrive", available: f.onedriveConnected,
      reason: f.onedriveConnected ? null : "Connecting OneDrive is not available yet.",
    },
  ];
  const any = options.find((o) => o.available);
  return {
    managedUploadAllowed: f.managedPlanActive,
    usedBytes: f.usedBytes ?? 0,
    limitBytes: f.managedPlanActive ? f.limitBytes ?? null : null,
    options,
    summary: any
      ? `Media can be added from ${options.filter((o) => o.available).map((o) => o.label).join(" and ")}.`
      : "No media storage is available for this workspace yet. Text and link posts work now; pictures and videos need either the managed maintenance plan or a connected Google Drive or OneDrive.",
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Roughly where each platform folds a long caption behind "See more". The numbers are approximate and vary by screen; the preview says so. They exist so a
 * person can see that the call to action sits below the fold, not to promise an exact cut.
 */
export const FOLD_CHARS = { facebook: 480, instagram: 125 } as const;

export function previewFold(platform: "facebook" | "instagram", composed: string): { visible: string; hidden: string; approximate: true } {
  const at = FOLD_CHARS[platform];
  if (composed.length <= at) return { visible: composed, hidden: "", approximate: true };
  const cut = composed.lastIndexOf(" ", at);
  const i = cut > at * 0.6 ? cut : at;
  return { visible: composed.slice(0, i), hidden: composed.slice(i), approximate: true };
}
