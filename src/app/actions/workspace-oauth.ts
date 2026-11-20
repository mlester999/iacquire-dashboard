"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/server/action-guard";
import { requireFreshUserOrThrow } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { browseWorkspaceKnowledge, previewWorkspaceKnowledge, reviewWorkspaceKnowledge, syncWorkspaceKnowledge } from "@/server/integrations/workspace-knowledge";
import { requireOrgContextOrThrow, type OrgContext } from "@/server/tenancy/context";
import { canManageWorkspaceOAuth, checkWorkspaceOAuth, disconnectWorkspaceOAuth, startWorkspaceOAuth } from "@/server/integrations/workspace-oauth";
import { WORKSPACE_OAUTH_RETURN_PATH, workspaceOAuthProvider, type WorkspaceOAuthProvider } from "@/lib/integrations/workspace-oauth";

function act<T>(expectedOrgId: string, key: string, operation: (ctx: OrgContext, provider: WorkspaceOAuthProvider) => Promise<T>) {
  return guard(async () => {
    const provider = workspaceOAuthProvider(key);
    if (!provider) throw new AppError("invalid_input", "Choose a supported workspace provider.");
    const ctx = await requireOrgContextOrThrow("integrations.view");
    if (ctx.org.orgId !== expectedOrgId) throw new AppError("conflict", "Your active workspace changed. Reload the page and try again.");
    if (!canManageWorkspaceOAuth(ctx)) throw new AppError("forbidden", "Only workspace owners and admins can manage these connections.");
    const user = await requireFreshUserOrThrow({ requireSessionId: true });
    if (user.id !== ctx.user.id || user.sessionId !== ctx.user.sessionId) {
      throw new AppError("unauthenticated", "Your session changed. Please sign in again.");
    }
    return operation(ctx, provider);
  });
}

export async function startWorkspaceOAuthAction(expectedOrgId: string, provider: string) {
  return act(expectedOrgId, provider, startWorkspaceOAuth);
}

export async function checkWorkspaceOAuthAction(expectedOrgId: string, provider: string) {
  return act(expectedOrgId, provider, async (ctx, key) => {
    const status = await checkWorkspaceOAuth(ctx, key);
    revalidatePath(WORKSPACE_OAUTH_RETURN_PATH);
    return status;
  });
}

export async function disconnectWorkspaceOAuthAction(expectedOrgId: string, provider: string) {
  return act(expectedOrgId, provider, async (ctx, key) => {
    const result = await disconnectWorkspaceOAuth(ctx, key);
    revalidatePath(WORKSPACE_OAUTH_RETURN_PATH);
    return result;
  });
}

export async function browseWorkspaceKnowledgeAction(expectedOrgId: string, provider: string, input: unknown) {
  return act(expectedOrgId, provider, (ctx, key) => browseWorkspaceKnowledge(ctx, key, input));
}

export async function syncWorkspaceKnowledgeAction(expectedOrgId: string, provider: string, selection?: unknown) {
  return act(expectedOrgId, provider, async (ctx, key) => {
    try {
      return await syncWorkspaceKnowledge(ctx, key, selection);
    } finally {
      revalidatePath(WORKSPACE_OAUTH_RETURN_PATH);
    }
  });
}

export async function previewWorkspaceKnowledgeAction(expectedOrgId: string, provider: string, snapshotId: string) {
  return act(expectedOrgId, provider, (ctx, key) => previewWorkspaceKnowledge(ctx, key, snapshotId));
}

export async function reviewWorkspaceKnowledgeAction(expectedOrgId: string, provider: string, snapshotId: string, decision: string) {
  return act(expectedOrgId, provider, async (ctx, key) => {
    const result = await reviewWorkspaceKnowledge(ctx, key, snapshotId, decision);
    revalidatePath(WORKSPACE_OAUTH_RETURN_PATH);
    return result;
  });
}
