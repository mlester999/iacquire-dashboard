export const GROWTH_PARTNER_MEMORY_KINDS = ["preference", "decision", "goal", "working_context"] as const;
export type GrowthPartnerMemoryKind = (typeof GROWTH_PARTNER_MEMORY_KINDS)[number];

export interface GrowthPartnerMemory {
  id: string;
  kind: GrowthPartnerMemoryKind;
  content: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export type GrowthPartnerMemoryCommand =
  | { kind: "remember"; content: string }
  | { kind: "forget"; content: string }
  | { kind: "clarify" }
  | { kind: "none" };

const MEMORY_COMMAND_PREFIX = /^(?:please\s+)?(remember|forget)\b/i;

/** Only explicit, deterministic commands may write or remove persistent Partner memory. */
export function parseGrowthPartnerMemoryCommand(input: string): GrowthPartnerMemoryCommand {
  const trimmed = input.trim();
  const prefix = /^(?:please\s+)?(remember|forget)(?:\s+that)?\s*:\s*([\s\S]*)$/i.exec(trimmed);
  if (prefix) {
    const content = prefix[2]?.trim() ?? "";
    if (content) return { kind: prefix[1]!.toLowerCase() as "remember" | "forget", content };
    return { kind: "clarify" };
  }
  return MEMORY_COMMAND_PREFIX.test(trimmed) ? { kind: "clarify" } : { kind: "none" };
}

export function normalizeGrowthPartnerMemory(input: string): string {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim();
}
