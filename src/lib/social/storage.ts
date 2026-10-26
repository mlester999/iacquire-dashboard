// How much of a workspace's media storage is used, in words. The server decides the limit and refuses an upload past it; this only says where the
// workspace stands. Pure.

import type { StoragePolicy } from "@/lib/social/media-policy";

/** The storage policy as the media screen reads it. The cap is null when managed upload is not allowed for the workspace (there is nothing to measure against), and
 *  both sizes may be missing, so the screen shows no figures rather than a wrong one. */
export type MediaPolicyView = Omit<StoragePolicy, "usedBytes" | "limitBytes"> & { usedBytes?: number | null; limitBytes?: number | null };

/** The share of the cap, in percent, at which the screen starts warning. */
export const STORAGE_WARN_PERCENT = 90;

const MB = 1_048_576;

/** "1.2 MB", "2,048 MB". Anything smaller than a tenth of a megabyte is said as such rather than rounded to zero. */
export function formatMb(bytes: number): string {
  if (bytes > 0 && bytes < MB / 10) return "less than 0.1 MB";
  return `${(bytes / MB).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
}

export interface StorageUse {
  /** "Using 12.5 MB of 2,048 MB". */
  summary: string;
  /** 0 to 100, rounded down. */
  percent: number;
  level: "ok" | "near" | "full";
  /** What to tell the person at 90 percent and at the cap. Null while there is room. */
  warning: string | null;
}

/** Null when the workspace has no cap to show (no limit, or no usage figure to compare it with). */
export function storageUse(usedBytes: number | null | undefined, limitBytes: number | null | undefined): StorageUse | null {
  if (typeof limitBytes !== "number" || !(limitBytes > 0) || typeof usedBytes !== "number" || !(usedBytes >= 0)) return null;
  // Multiplying before dividing keeps whole percentages exact (90 MB of 100 MB is 90, not 89.99999).
  const percent = Math.min(100, Math.floor((usedBytes * 100) / limitBytes));
  const level = usedBytes >= limitBytes ? "full" : percent >= STORAGE_WARN_PERCENT ? "near" : "ok";
  return {
    summary: `Using ${formatMb(usedBytes)} of ${formatMb(limitBytes)}`,
    percent,
    level,
    warning: level === "full"
      ? "Your media storage is full. Remove files you no longer need before adding more."
      : level === "near"
        ? `You have used ${percent}% of your media storage. Remove files you no longer need to make room.`
        : null,
  };
}
