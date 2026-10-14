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

export async function fetchNotificationsAction() {
  const user = await requireUserOrThrow();
  const ctx = await getOrgContext();
  const { items, unread } = await listNotifications(user.id, 30, await hiddenKinds(user.id, ctx?.org.orgId ?? null));
  return {
    unread,
    items: items.map((n) => ({ ...n, created_at: new Date(n.created_at).toISOString(), read_at: n.read_at ? new Date(n.read_at).toISOString() : null })),
  };
}

export async function markNotificationsReadAction(ids: string[] | "all") {
  const user = await requireUserOrThrow();
  const clean = ids === "all" ? "all" : ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
  await markNotificationsRead(user.id, clean);
  return { ok: true as const };
}
