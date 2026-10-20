"use server";

import { revalidatePath } from "next/cache";
import { requireUserOrThrow } from "@/server/auth/session";
import { getOrgContext, switchActiveOrg } from "@/server/tenancy/context";
import { hiddenKinds, listNotifications, markNotificationsRead } from "@/server/notifications";
import { actionError } from "@/server/errors";

export async function switchOrgAction(orgId: string) {
  try {
    const ok = await switchActiveOrg(orgId);
    if (!ok) return { ok: false as const, error: "You don't have access to that workspace." };
    revalidatePath("/", "layout");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * The bell's paged feed. The signed-in user is resolved on the server; the browser never supplies a
 * user id or an organisation id, and the database's RLS plus the explicit user_id predicate confine
 * every row to that person. A cursor keeps "load older" stable even when timestamps repeat.
 */
export async function fetchNotificationsAction(options?: { limit?: number; before?: string | null; beforeId?: string | null }) {
  try {
    const user = await requireUserOrThrow();
    const ctx = await getOrgContext();
    const limit = Math.min(50, Math.max(1, Math.trunc(Number(options?.limit) || 12)));
    const before = typeof options?.before === "string" && !Number.isNaN(Date.parse(options.before)) ? options.before : null;
    const beforeId = typeof options?.beforeId === "string" && /^[0-9a-f-]{36}$/i.test(options.beforeId) ? options.beforeId : null;
    const clientAccount = user.platformRole === "none";
    const { items, unread, hasMore, nextBefore, nextBeforeId } = await listNotifications(user.id, {
      limit,
      before,
      beforeId,
      // Notification preferences belong to a client workspace. An agency feed is governed by the
      // agency permission/scope model, not by whichever client workspace happens to be active.
      hidden: clientAccount ? await hiddenKinds(user.id, ctx?.org.orgId ?? null) : [],
      // A client account is scoped to its active workspace. Agency accounts need the full agency
      // feed because their job spans the clients in their assigned scope.
      orgId: clientAccount ? (ctx?.org.orgId ?? null) : null,
    });
    return {
      ok: true as const,
      unread,
      hasMore,
      nextBefore,
      nextBeforeId,
      items: items.map((n) => ({
        ...n,
        created_at: new Date(n.created_at).toISOString(),
        read_at: n.read_at ? new Date(n.read_at).toISOString() : null,
      })),
    };
  } catch (err) {
    return actionError(err);
  }
}

export async function markNotificationsReadAction(ids: string[] | "all") {
  try {
    const user = await requireUserOrThrow();
    const ctx = await getOrgContext();
    const clean = ids === "all" ? "all" : ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
    // A client's read state is scoped to the workspace whose bell they used. Agency users keep the
    // cross-client feed, so their read action is intentionally unscoped.
    await markNotificationsRead(user.id, clean, { orgId: user.platformRole === "none" ? (ctx?.org.orgId ?? null) : null });
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}
