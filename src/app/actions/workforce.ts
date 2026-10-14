"use server";

import { revalidatePath } from "next/cache";
import { withSystem } from "@/server/db";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { createConfigVersion, currentSettings, getAgentByRole, rollbackToVersion } from "@/server/workforce/service";
import { interpretChangeRequest } from "@/server/workforce/compiler";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { agentSettingsSchema, type AgentSettings } from "@/lib/agent-settings";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";

async function resolve(role: string) {
  const ctx = await requireOrgContextOrThrow("agents.configure");
  if (!isAgentRoleKey(role)) throw new AppError("not_found", "Unknown employee.");
  const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, role);
  if (!agent) throw new AppError("not_found", "Unknown employee.");
  return { ctx, agent, role };
}

function revalidateAgent(role: string) {
  if (!isAgentRoleKey(role)) return;
  revalidatePath(`/workforce/${AGENT_BY_KEY[role].slug}`);
  revalidatePath("/workforce");
}

export async function saveAgentSettingsAction(role: string, input: unknown) {
  try {
    const { ctx, agent } = await resolve(role);
    const parsed = agentSettingsSchema.safeParse(input);
    if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the form.");
    const res = await withSystem((db) =>
      createConfigVersion(db, { orgId: ctx.org.orgId, agentId: agent.id, settings: parsed.data, source: "client_edit", userId: ctx.user.id, apply: true }),
    );
    revalidateAgent(role);
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

/** Interprets a plain-English request into a proposed settings diff. Nothing is saved yet. */
export async function proposeChangeAction(role: string, request: string) {
  try {
    const { ctx, agent } = await resolve(role);
    if (!request.trim()) throw new AppError("invalid_input", "Describe the change you'd like.");
    const { settings } = await withSystem((db) => currentSettings(db, agent.id, ctx.org.orgId));
    const proposal = interpretChangeRequest(request, settings);
    return { ok: true as const, data: proposal };
  } catch (err) {
    return actionError(err);
  }
}

export async function applyChangeAction(role: string, request: string, changes: Partial<AgentSettings>) {
  try {
    const { ctx, agent } = await resolve(role);
    const res = await withSystem(async (db) => {
      const { settings } = await currentSettings(db, agent.id, ctx.org.orgId);
      // Re-interpret server-side; never trust a client-supplied diff beyond what the interpreter allows.
      const proposal = interpretChangeRequest(request, settings);
      if (proposal.status !== "proposed") throw new AppError("invalid_input", proposal.refusal ?? "Nothing to change.");
      const allowed = proposal.changes;
      for (const key of Object.keys(changes)) if (!(key in allowed)) throw new AppError("invalid_input", "The change no longer matches the request. Please try again.");
      return createConfigVersion(db, {
        orgId: ctx.org.orgId,
        agentId: agent.id,
        settings: agentSettingsSchema.parse({ ...settings, ...allowed }),
        source: "change_request",
        changeRequest: request.slice(0, 1000),
        userId: ctx.user.id,
        apply: true,
      });
    });
    revalidateAgent(role);
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

export async function rollbackAction(role: string, versionId: string) {
  try {
    const { ctx, agent } = await resolve(role);
    const res = await withSystem((db) => rollbackToVersion(db, { orgId: ctx.org.orgId, agentId: agent.id, versionId, userId: ctx.user.id }));
    revalidateAgent(role);
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

export async function requestSetupAction() {
  try {
    const ctx = await requireOrgContextOrThrow("agents.configure");
    const n = await withSystem((db) => requestProvisioning(db, ctx.org.orgId, ctx.user.id));
    revalidatePath("/workforce");
    return { ok: true as const, data: { requested: n } };
  } catch (err) {
    return actionError(err);
  }
}
