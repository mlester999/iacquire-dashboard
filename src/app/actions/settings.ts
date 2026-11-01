"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { actionError, AppError } from "@/server/errors";
import {
  aiPrefsInputSchema,
  changeMemberRole,
  getTeamSuggestions,
  inviteMember,
  previewAiPreferencesApply,
  profileSchema,
  revokeInvite,
  revokeMember,
  saveNotificationPrefs,
  notificationPrefsSchema,
  updateAiPreferences,
  updateProfile,
  updateUserProfile,
  userProfileSchema,
} from "@/server/settings/service";
import { changeOwnPassword, listOwnSessions, revokeOneSession, revokeOtherSessions, supportsPerSessionRevoke } from "@/server/auth/provider";
import { ORG_ROLES, type OrgRole } from "@/lib/permissions";

function zodFail(err: unknown) {
  if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
  return actionError(err);
}

export async function updateProfileAction(input: z.input<typeof profileSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    const data = await updateProfile(ctx, input);
    revalidatePath("/", "layout");
    // The employees the save reached are said as they are: a version waiting for review is reported as waiting, never as applied.
    return { ok: true as const, data: { employees: { updated: data.employees.updated.length, held: data.employees.held.length, failed: data.employees.failed } } };
  } catch (err) {
    return zodFail(err);
  }
}

export async function updateAiPreferencesAction(input: z.input<typeof aiPrefsInputSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.configure");
    const res = await updateAiPreferences(ctx, input);
    revalidatePath("/settings/ai");
    revalidatePath("/employees");
    return { ok: true as const, data: res };
  } catch (err) {
    return zodFail(err);
  }
}

/** Which employees an AI-preferences apply would change, and which of their own edits it would replace. Reads only. */
export async function previewAiPreferencesApplyAction(input: Parameters<typeof previewAiPreferencesApply>[1]) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.configure");
    return { ok: true as const, data: await previewAiPreferencesApply(ctx, input) };
  } catch (err) {
    return zodFail(err);
  }
}

/** The people listed in setup who are not on the team yet, for Settings > Team. */
export async function teamSuggestionsAction() {
  try {
    const ctx = await requireOrgContextOrThrow("team.manage");
    return { ok: true as const, data: await getTeamSuggestions(ctx) };
  } catch (err) {
    return zodFail(err);
  }
}

export async function inviteMemberAction(email: string, role: string) {
  try {
    const ctx = await requireOrgContextOrThrow("team.manage");
    if (!ORG_ROLES.includes(role as OrgRole)) throw new AppError("invalid_input", "Choose a role.");
    await inviteMember(ctx, email, role as OrgRole);
    revalidatePath("/settings/team");
    return { ok: true as const };
  } catch (err) {
    return zodFail(err);
  }
}

export async function changeRoleAction(userId: string, role: string) {
  try {
    const ctx = await requireOrgContextOrThrow("team.manage");
    if (!ORG_ROLES.includes(role as OrgRole)) throw new AppError("invalid_input", "Choose a role.");
    await changeMemberRole(ctx, userId, role as OrgRole);
    revalidatePath("/settings/team");
    return { ok: true as const };
  } catch (err) {
    return zodFail(err);
  }
}

export async function revokeMemberAction(userId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("team.manage");
    if (userId === ctx.user.id) throw new AppError("invalid_input", "You can't remove yourself here.");
    const data = await revokeMember(ctx, userId);
    revalidatePath("/settings/team");
    // Bookings the person leaves behind are said, never moved: the screen shows the sentence after "Access removed".
    return { ok: true as const, data };
  } catch (err) {
    return zodFail(err);
  }
}

export async function revokeInviteAction(inviteId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("team.manage");
    await revokeInvite(ctx, inviteId);
    revalidatePath("/settings/team");
    return { ok: true as const };
  } catch (err) {
    return zodFail(err);
  }
}

export async function saveNotificationPrefsAction(prefs: z.input<typeof notificationPrefsSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow();
    await saveNotificationPrefs(ctx, prefs);
    revalidatePath("/settings/notifications");
    return { ok: true as const };
  } catch (err) {
    return zodFail(err);
  }
}

export async function updateUserProfileAction(input: z.input<typeof userProfileSchema>) {
  try {
    const ctx = await requireOrgContextOrThrow();
    await updateUserProfile(ctx, input);
    revalidatePath("/", "layout");
    return { ok: true as const };
  } catch (err) {
    return zodFail(err);
  }
}

export async function changePasswordAction(current: string, next: string, confirm: string) {
  try {
    const ctx = await requireOrgContextOrThrow();
    if (next !== confirm) throw new AppError("invalid_input", "New passwords don't match.");
    const res = await changeOwnPassword(ctx.user, current, next);
    if (!res.ok) throw new AppError("invalid_input", res.error);
    return { ok: true as const };
  } catch (err) {
    return zodFail(err);
  }
}

export async function listSessionsAction() {
  try {
    const ctx = await requireOrgContextOrThrow();
    const data = await listOwnSessions(ctx.user);
    return { ok: true as const, data, canRevokeOne: supportsPerSessionRevoke() };
  } catch (err) {
    return zodFail(err);
  }
}

export async function revokeSessionAction(sessionId: string | "others") {
  try {
    const ctx = await requireOrgContextOrThrow();
    if (sessionId === "others") await revokeOtherSessions(ctx.user);
    else {
      if (sessionId === ctx.user.sessionId) throw new AppError("invalid_input", "Use Sign out to end this session.");
      if (!(await revokeOneSession(ctx.user, sessionId))) {
        throw new AppError("invalid_input", "Individual sessions can't be ended separately here. Use Sign out others.");
      }
    }
    return { ok: true as const };
  } catch (err) {
    return zodFail(err);
  }
}
