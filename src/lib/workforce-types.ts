import type { AgentSettingsChange } from "@/lib/agent-settings";
import type { AgentRoleKey } from "@/lib/agents";
import type { ConfigDecision } from "@/lib/config-review";

export interface PreviewMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConfigPreviewSummary {
  role: AgentRoleKey;
  version: number;
  summary: string;
  riskFlags: string[];
  decision: ConfigDecision;
  changed: AgentSettingsChange[];
  warnings: string[];
  knowledge: {
    entries: number;
    documents: number;
    truncated: boolean;
    characters: number;
  };
  connectionConfigured: boolean;
  provider: "hermes" | null;
}

export interface PreviewUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export type ConfigPreviewEvent =
  | { type: "prepared"; data: ConfigPreviewSummary }
  | { type: "started"; runId: string }
  | { type: "delta"; text: string }
  | { type: "activity"; label: string }
  | { type: "done"; content: string; usage: PreviewUsage | null }
  | { type: "cancelled" }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "unavailable"; message: string };
