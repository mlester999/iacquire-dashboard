import { z } from "zod";

export const TONES = ["friendly", "professional", "casual", "premium"] as const;
export const REPLY_LENGTHS = ["concise", "balanced", "detailed"] as const;
export const LANGUAGES = [
  "English", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch", "Filipino", "Japanese", "Chinese (Simplified)",
] as const;

export type Tone = (typeof TONES)[number];
export type ReplyLength = (typeof REPLY_LENGTHS)[number];

export const TONE_COPY: Record<Tone, { label: string; example: string }> = {
  friendly: { label: "Friendly", example: "Happy to help! Here's what I found…" },
  professional: { label: "Professional", example: "Here is a summary of the requested information." },
  casual: { label: "Casual", example: "Sure thing — quick rundown below." },
  premium: { label: "Premium", example: "Certainly. Here's a considered overview for you." },
};

export const LENGTH_COPY: Record<ReplyLength, { label: string; description: string }> = {
  concise: { label: "Concise", description: "Short and practical." },
  balanced: { label: "Balanced", description: "Useful detail without extra length." },
  detailed: { label: "Detailed", description: "Full explanations when helpful." },
};

const text = (max: number) => z.string().trim().max(max).default("");

/** Company-wide AI preferences captured in onboarding step 3 and Settings → AI preferences. */
export const aiPreferencesSchema = z.object({
  tone: z.enum(TONES).default("friendly"),
  replyLength: z.enum(REPLY_LENGTHS).default("concise"),
  language: z.enum(LANGUAGES).default("English"),
  companyRules: text(1500),
  neverPromise: text(1000),
  escalateWhen: text(600),
});
export type AiPreferences = z.infer<typeof aiPreferencesSchema>;

/** Per-employee configuration shown to clients as simple controls. */
export const agentSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  tone: z.enum(TONES),
  replyLength: z.enum(REPLY_LENGTHS),
  language: z.enum(LANGUAGES),
  responsibilities: text(1000),
  goals: text(1000),
  targetCustomers: text(1000),
  companyRules: text(1500),
  neverPromise: text(1000),
  escalateWhen: text(600),
  escalationContact: text(200),
  approvalPreference: z.enum(["always", "high_impact"]).default("always"),
  roleAnswers: z.record(z.string().regex(/^[a-z_]{2,40}$/), z.string().trim().max(1000)).default({}),
  customInstruction: text(500),
  /** Subset of the role's default tools. Clients can switch tools off, never add new ones. */
  disabledTools: z.array(z.string().regex(/^[a-z_.]{3,60}$/)).max(20).default([]),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

const SETTING_LABELS: Record<keyof Omit<AgentSettings, "roleAnswers" | "disabledTools">, string> = {
  displayName: "Name",
  tone: "Tone",
  replyLength: "Reply length",
  language: "Language",
  responsibilities: "Main responsibilities",
  goals: "Goals",
  targetCustomers: "Target customers",
  companyRules: "Company rules",
  neverPromise: "Never promise",
  escalateWhen: "Ask a human when",
  escalationContact: "Escalation contact",
  approvalPreference: "Approval preference",
  customInstruction: "Additional instruction",
};

export interface AgentSettingsChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

/**
 * Plain-language comparison of two configurations. Used by the Test & compare screen so a reviewer sees exactly what
 * differs between the saved configuration and the draft being tested. It never includes hidden prompts or policy.
 */
export function diffAgentSettings(active: AgentSettings, draft: AgentSettings): AgentSettingsChange[] {
  const out: AgentSettingsChange[] = [];
  for (const key of Object.keys(SETTING_LABELS) as Array<keyof typeof SETTING_LABELS>) {
    const before = active[key];
    const after = draft[key];
    if (before !== after) {
      out.push({
        key,
        label: SETTING_LABELS[key],
        before: key === "approvalPreference" ? (before === "always" ? "Ask before any action" : "Ask for high-impact actions") : String(before || "Not set"),
        after: key === "approvalPreference" ? (after === "always" ? "Ask before any action" : "Ask for high-impact actions") : String(after || "Not set"),
      });
    }
  }
  const roleKeys = [...new Set([...Object.keys(active.roleAnswers), ...Object.keys(draft.roleAnswers)])].sort();
  for (const roleKey of roleKeys) {
    const before = active.roleAnswers[roleKey] ?? "";
    const after = draft.roleAnswers[roleKey] ?? "";
    if (before !== after) out.push({ key: `roleAnswers.${roleKey}`, label: `Role answer: ${roleKey.replaceAll("_", " ")}`, before: before || "Not set", after: after || "Not set" });
  }
  const beforeTools = [...active.disabledTools].sort().join(", ");
  const afterTools = [...draft.disabledTools].sort().join(", ");
  if (beforeTools !== afterTools) {
    out.push({ key: "disabledTools", label: "Tools switched off", before: beforeTools || "None", after: afterTools || "None" });
  }
  return out;
}

export const onboardingSchema = z.object({
  business: z
    .object({
      companyName: z.string().trim().max(120).default(""),
      description: text(2000),
      industry: text(120),
      website: text(300),
      operatingArea: text(500),
      services: text(2000),
      idealCustomers: text(2000),
    })
    .default({ companyName: "", description: "", industry: "", website: "", operatingArea: "", services: "", idealCustomers: "" }),
  goals: z
    .object({ selected: z.array(z.string().max(40)).max(12).default([]), other: text(300) })
    .default({ selected: [], other: "" }),
  communication: aiPreferencesSchema.default(aiPreferencesSchema.parse({})),
  workforce: z
    .object({
      selected: z.array(z.string()).max(6).default([]),
      answers: z.record(z.string(), z.record(z.string(), z.string().max(1000))).default({}),
    })
    .default({ selected: [], answers: {} }),
});
export type OnboardingData = z.infer<typeof onboardingSchema>;

export const BUSINESS_GOALS = [
  { id: "more_leads", label: "Find more leads", icon: "radar" },
  { id: "more_appointments", label: "Book more appointments", icon: "calendar" },
  { id: "faster_response", label: "Improve customer response times", icon: "zap" },
  { id: "sales_followups", label: "Automate sales follow-ups", icon: "send" },
  { id: "organize_customers", label: "Organise customer information", icon: "database" },
  { id: "customer_service", label: "Improve customer service", icon: "heart" },
  { id: "retention", label: "Improve customer retention", icon: "repeat" },
  { id: "reduce_manual", label: "Reduce repetitive manual work", icon: "sparkles" },
  { id: "other", label: "Other", icon: "plus" },
] as const;

export function websiteLooksValid(value: string) {
  if (!value) return true;
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return Boolean(u.hostname.includes("."));
  } catch {
    return false;
  }
}
