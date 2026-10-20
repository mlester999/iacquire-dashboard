"use server";

import { revalidatePath } from "next/cache";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContextOrThrow, requireAgencyOrgAccessOrThrow } from "@/server/tenancy/context";
import { isAgentMode, setAgencyPause, setAgentMode, setClientPause } from "@/server/automation/controls";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refresh() {
  revalidatePath("/employees");
  revalidatePath("/overview");
}

export async function setAgentModeAction(agentId: string, mode: string, options: { reason?: string; confirmAutonomous?: boolean } = {}) {
  try {
    if (!uuid.test(agentId) || !isAgentMode(mode)) throw new AppError("invalid_input", "Choose a valid employee and mode.");
    const ctx = await requireOrgContextOrThrow();
    const result = await setAgentMode(ctx, { agentId, mode, reason: options.reason, confirmAutonomous: options.confirmAutonomous });
    refresh();
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function setClientPauseAction(scope: string, paused: boolean, reason?: string) {
  try {
    if (scope !== "messaging" && scope !== "outbound") throw new AppError("invalid_input", "Unknown pause type.");
    const ctx = await requireOrgContextOrThrow();
    const state = await setClientPause(ctx, { scope, paused: paused === true, reason });
    refresh();
    return { ok: true as const, data: state.pauses };
  } catch (err) {
    return actionError(err);
  }
}

/** Agency emergency pause for one client. The organization is checked against the caller's assignments. */
export async function setAgencyPauseAction(orgId: string, paused: boolean, reason: string) {
  try {
    if (!uuid.test(orgId)) throw new AppError("invalid_input", "Choose a client.");
    const user = await requireAgencyOrgAccessOrThrow(orgId);
    const result = await setAgencyPause(user, { orgId, paused: paused === true, reason });
    revalidatePath(`/admin/clients/${orgId}`);
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}
