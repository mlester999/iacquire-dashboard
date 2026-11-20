export const WORKSPACE_OAUTH_PROVIDERS = ["notion", "airtable"] as const;
export type WorkspaceOAuthProvider = (typeof WORKSPACE_OAUTH_PROVIDERS)[number];

export const WORKSPACE_OAUTH_LABEL: Record<WorkspaceOAuthProvider, string> = { notion: "Notion", airtable: "Airtable" };
export const WORKSPACE_OAUTH_RETURN_PATH = "/settings/integrations";
export const WORKSPACE_OAUTH_NOTICE = "iaq_workspace_oauth_notice";

export function workspaceOAuthProvider(value: unknown): WorkspaceOAuthProvider | null {
  return value === "notion" || value === "airtable" ? value : null;
}

export type WorkspaceConnectionView = {
  provider: WorkspaceOAuthProvider;
  configured: boolean;
  status: "connected" | "needs_reauth" | "error" | "disconnected" | "needs_check";
  lastVerifiedAt: string | null;
  hasSharedResources: boolean | null;
};
