import "server-only";
import { AppError } from "@/server/errors";
import { loadStaffActor, type StaffUser } from "@/server/staff-messages/access";
import { buildSnapshot } from "@/server/staff-messages/snapshot";
import type { SnapshotPayload } from "@/lib/staff-messages/snapshot";
import type { StaffRole } from "@/lib/staff-messages/view";

// What the Messages pages are built from on the server: the person's standing (so a page can say honestly why there is nothing to show) and the first snapshot. The same
// access rules as every later request apply: nothing here trusts the address.

export type PageData =
  | { kind: "unavailable"; reason: "off" | "denied" | "no_agency" }
  | {
      kind: "ready";
      me: { id: string; name: string; role: StaffRole; canChannels: boolean; canModerate: boolean; timeZone: string };
      initial: SnapshotPayload;
    };

export interface PageRequest {
  conversationId: string | null;
  aroundSeq: number | null;
  threadId: string | null;
}

/** `user` is the session (id, role, time zone). Anything unexpected is rethrown; the three ways of having nothing to show are answers. */
export async function loadPageData(user: StaffUser & { timezone: string }, request: PageRequest): Promise<PageData> {
  let actor;
  try {
    actor = await loadStaffActor(user);
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "not_enabled") return { kind: "unavailable", reason: "off" };
      if (error.code === "forbidden") return { kind: "unavailable", reason: "denied" };
      if (error.code === "unavailable") return { kind: "unavailable", reason: "no_agency" };
    }
    throw error;
  }
  const first = await buildSnapshot(user, { since: null, conversationId: request.conversationId, threadRootId: request.threadId, beforeSeq: null, aroundSeq: request.aroundSeq, badgeOnly: false });
  // `since` is null, so the answer is never "unchanged".
  const initial = first as SnapshotPayload;
  return {
    kind: "ready",
    me: { id: actor.userId, name: actor.name, role: actor.role, canChannels: actor.caps.channels, canModerate: actor.caps.moderate, timeZone: user.timezone },
    initial,
  };
}
