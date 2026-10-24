"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { requestMeta } from "@/server/auth/session";
import { hashIp } from "@/server/security/crypto";
import { guard } from "@/server/action-guard";
import { decideChangeOrder, postChangeMessage, submitChangeOrder, withdrawChangeOrder, type ChangeOrderInput } from "@/server/projects/change-orders";

// The client's side of a project's change list. Every action re-reads the person's workspace and permission from the session; the service checks them again, and nothing the
// browser sends (a project id, a change id) is trusted without the same workspace check the pages use.

const refresh = (requestId: string) => {
  revalidatePath(`/projects/${requestId}`);
  revalidatePath("/projects");
};

export async function submitChangeOrderAction(requestId: string, input: ChangeOrderInput) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.request");
    const made = await submitChangeOrder(ctx, requestId, input);
    refresh(requestId);
    return made;
  });
}

export async function withdrawChangeOrderAction(requestId: string, changeId: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.request");
    await withdrawChangeOrder(ctx, changeId);
    refresh(requestId);
  });
}

export async function postChangeMessageAction(requestId: string, changeId: string, body: string, clientMessageId?: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.request");
    const posted = await postChangeMessage(ctx, changeId, body, clientMessageId);
    refresh(requestId);
    return posted;
  });
}

export async function decideChangeOrderAction(requestId: string, changeId: string, decision: "accepted" | "declined", note?: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.view");
    const meta = await requestMeta();
    const result = await decideChangeOrder(ctx, changeId, decision, note, hashIp(meta.ip));
    refresh(requestId);
    return result;
  });
}
