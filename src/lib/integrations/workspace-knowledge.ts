import type { WorkspaceOAuthProvider } from "./workspace-oauth";

export type WorkspaceKnowledgeChoice = { id: string; title: string };
export type NotionKnowledgeChoice = WorkspaceKnowledgeChoice & { kind: "page" | "data_source" };
export type AirtableKnowledgeTable = WorkspaceKnowledgeChoice & { fields: WorkspaceKnowledgeChoice[] };
export type WorkspaceKnowledgeSelection =
  | { kind: "page" | "data_source"; id: string }
  | { kind: "table"; baseId: string; tableId: string; fieldIds: string[] };
export type WorkspaceKnowledgeView = {
  provider: WorkspaceOAuthProvider;
  title: string;
  status: "current" | "unavailable" | "retry";
  checkedAt: string;
  syncedAt: string | null;
  retryAfter: string | null;
  message: string | null;
  activeReference: boolean;
  latest: { id: string; status: "pending" | "approved" | "rejected" | "superseded"; flagged: boolean } | null;
};
