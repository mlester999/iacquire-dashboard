"use server";

import { revalidatePath } from "next/cache";
import { withSystem, withUser } from "@/server/db";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { createConfigVersion, editableSettings, getAgentByRole, rollbackToVersion } from "@/server/workforce/service";
import { interpretChangeRequest } from "@/server/workforce/compiler";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { prepareConfigPreview } from "@/server/workforce/preview";
import { agentSettingsSchema, type AgentSettings } from "@/lib/agent-settings";
import { configAttribution } from "@/lib/config-review";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { getOnboardingSession } from "@/server/onboarding/service";
import { confirmedAnswers, toLegacyData } from "@/lib/onboarding/engine";
import { generateEmployeeSettings } from "@/server/onboarding/employee-generator";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

async function resolve(role: string) {
  const ctx = await requireOrgContextOrThrow("agents.configure");
  if (!isAgentRoleKey(role)) throw new AppError("not_found", "Unknown employee.");
  const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, role);
  if (!agent) throw new AppError("not_found", "Unknown employee.");
  return { ctx, agent, role };
}

function revalidateAgent(role: string) {
  if (!isAgentRoleKey(role)) return;
  revalidatePath(`/employees/${AGENT_BY_KEY[role].slug}`);
  revalidatePath("/employees");
}

export async function saveAgentSettingsAction(role: string, input: unknown) {
  try {
    const { ctx, agent } = await resolve(role);
    const parsed = agentSettingsSchema.safeParse(input);
    if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the form.");
    const attribution = configAttribution({ orgKind: ctx.org.kind, platformRole: ctx.user.platformRole });
    const res = await withSystem((db) =>
      createConfigVersion(db, {
        orgId: ctx.org.orgId,
        agentId: agent.id,
        settings: parsed.data,
        source: attribution.source,
        actorKind: attribution.actorKind,
        userId: ctx.user.id,
        apply: true,
      }),
    );
    revalidateAgent(role);
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

/** Generates a read-only style suggestion. The client reviews a visible draft before any version is saved. */
export async function regenerateEmployeeStyleAction(role: string) {
  try {
    const { ctx, agent } = await resolve(role);
    const session = await getOnboardingSession(ctx);
    if (session.status !== "submitted" || session.hasUnsubmittedChanges) throw new AppError("conflict", "Approve your latest company information before regenerating employee preferences.");
    const limit = await consumeRateLimit(RATE_LIMITS.onboardingAssistByOrg, ctx.org.orgId);
    if (!limit.allowed) throw new AppError("rate_limited", "AI suggestions are temporarily limited. Try again later.");
    const confirmed = confirmedAnswers(session.answers);
    const data = toLegacyData(confirmed, session.enabledRoles);
    const knowledge = await withUser(ctx.user.id, async (db) => {
      const { rows } = await db.query<{ content: string }>(
        "select content from company_knowledge where org_id = $1 and review_status = 'approved' order by section limit 8",
        [ctx.org.orgId],
      );
      return rows.map((row) => row.content);
    });
    const generated = (await generateEmployeeSettings(data, knowledge))[agent.role_key];
    const { personality, characterTraits, communicationStyle, responseBehavior } = generated.settings;
    return { ok: true as const, data: { personality, characterTraits, communicationStyle, responseBehavior, source: generated.source } };
  } catch (err) {
    return actionError(err);
  }
}

/** Interprets a plain-English request into a proposed settings diff. Nothing is saved yet. */
export async function proposeChangeAction(role: string, request: string) {
  try {
    const { ctx, agent } = await resolve(role);
    if (!request.trim()) throw new AppError("invalid_input", "Describe the change you'd like.");
    // Interpret against the draft the person is already editing, so a routine request cannot erase a
    // pending sensitive change. If the draft is sensitive, the combined change is held for review.
    const { settings } = await withSystem((db) => editableSettings(db, agent.id, ctx.org.orgId));
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
      const { settings } = await editableSettings(db, agent.id, ctx.org.orgId);
      // Re-interpret server-side; never trust a client-supplied diff beyond what the interpreter allows.
      const proposal = interpretChangeRequest(request, settings);
      if (proposal.status !== "proposed") throw new AppError("invalid_input", proposal.refusal ?? "Nothing to change.");
      const allowed = proposal.changes;
      for (const key of Object.keys(changes)) if (!(key in allowed)) throw new AppError("invalid_input", "The change no longer matches the request. Please try again.");
      const attribution = configAttribution({ orgKind: ctx.org.kind, platformRole: ctx.user.platformRole });
      return createConfigVersion(db, {
        orgId: ctx.org.orgId,
        agentId: agent.id,
        settings: agentSettingsSchema.parse({ ...settings, ...allowed }),
        source: "change_request",
        actorKind: attribution.actorKind,
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

/** Compiles an unsaved draft and reports exactly what would differ. No provider call and no write. */
export async function previewConfigAction(role: string, draft: unknown) {
  try {
    const { ctx } = await resolve(role);
    const parsed = agentSettingsSchema.safeParse(draft);
    if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the draft configuration.");
    const summary = await prepareConfigPreview(ctx, role, parsed.data);
    return { ok: true as const, data: summary };
  } catch (err) {
    return actionError(err);
  }
}

export async function rollbackAction(role: string, versionId: string) {
  try {
    const { ctx, agent } = await resolve(role);
    const attribution = configAttribution({ orgKind: ctx.org.kind, platformRole: ctx.user.platformRole });
    const res = await withSystem((db) => rollbackToVersion(db, { orgId: ctx.org.orgId, agentId: agent.id, versionId, userId: ctx.user.id, actorKind: attribution.actorKind }));
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
    revalidatePath("/employees");
    return { ok: true as const, data: { requested: n } };
  } catch (err) {
    return actionError(err);
  }
}
