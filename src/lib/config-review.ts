import { diffAgentSettings, type AgentSettings } from "@/lib/agent-settings";
import type { AgentRoleKey } from "@/lib/agents";
import type { PlatformRole } from "@/lib/permissions";
import { INSTRUCTION_RISK_META, scanInstructionText } from "@/lib/instruction-risk";
import { sentenceCase } from "@/lib/utils";

export type ConfigSource = "onboarding" | "client_edit" | "change_request" | "rollback" | "agency";
export type ConfigActorKind = "user" | "agency" | "system";
export type ConfigOrgKind = "agency" | "client";
export type ConfigDecision = "auto_apply" | "review_required" | "blocked";
export type ConfigReasonSeverity = "block" | "review";

export interface ConfigReason {
  code: string;
  severity: ConfigReasonSeverity;
  field: string;
  label: string;
  detail: string;
  match?: string;
}

export interface ConfigClassification {
  decision: ConfigDecision;
  severity: "none" | "block" | "review";
  reasons: ConfigReason[];
  riskFlags: string[];
}

export interface ReviewReasonView {
  code: string;
  label: string;
  detail: string;
  severity: ConfigReasonSeverity;
  field: string;
  match?: string;
}

export interface ReviewDiffView {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface ReviewPayload {
  decision: ConfigDecision;
  severity: "review" | "block";
  reasons: ReviewReasonView[];
  diff: ReviewDiffView[];
  storedFlags: string[];
  legacy: boolean;
  legacyNote: string | null;
}

/** Serializable review item used by the client and internal review screens. */
export interface ReviewVersionView {
  id: string;
  orgId: string;
  orgName: string;
  orgKind: ConfigOrgKind;
  agentRole: AgentRoleKey;
  agentName: string;
  version: number;
  /** The version currently applied to this employee when the review was loaded, if any. */
  appliedVersion: number | null;
  source: string;
  summary: string;
  changeRequest: string | null;
  submittedBy: string;
  submittedByRole: string | null;
  submittedAt: string;
  /** Redacted compiled prompt evidence for an authorised reviewer. Null when unavailable. */
  compiledInstructions: string | null;
  compiledInstructionsTruncated: boolean;
  review: ReviewPayload;
}

const STRUCTURAL_REASONS: Record<string, { label: string; detail: string; severity: ConfigReasonSeverity }> = {
  guardrail_removed: {
    label: "Guardrail removed",
    detail: "An existing instruction that restricted the employee was deleted.",
    severity: "review",
  },
  guardrail_weakened: {
    label: "Guardrail weakened",
    detail: "An existing instruction that restricted the employee was shortened or materially changed.",
    severity: "review",
  },
  approval_scope_reduced: {
    label: "Approval scope reduced",
    detail: "The configuration would reduce when a person must approve the employee's work.",
    severity: "review",
  },
  escalation_destination_changed: {
    label: "Escalation destination changed",
    detail: "A different person or destination would receive escalations.",
    severity: "review",
  },
  tool_reenabled: {
    label: "Allowed action re-enabled",
    detail: "A tool that was switched off for this employee would be switched back on.",
    severity: "review",
  },
  impersonation_risk: {
    label: "Impersonation risk",
    detail: "The employee name looks like it could be mistaken for iAcquire support, an administrator or another authority.",
    severity: "review",
  },
};

const FIELD_LABELS: Record<string, string> = {
  displayName: "Employee name",
  tone: "Tone",
  replyLength: "Reply length",
  language: "Language",
  personality: "Personality",
  characterTraits: "Character traits",
  communicationStyle: "Communication style",
  responseBehavior: "Response behavior",
  operatingProcedures: "Operating procedures",
  proactiveResponsibilities: "Proactive responsibilities",
  reportingBehavior: "Reporting behavior",
  responsibilities: "Main responsibilities",
  goals: "Goals",
  targetCustomers: "Target customers",
  companyRules: "Company rules",
  neverPromise: "Never promise",
  escalateWhen: "Ask a human when",
  escalationContact: "Escalation contact",
  approvalPreference: "Approval preference",
  customInstruction: "Additional instruction",
  disabledTools: "Allowed actions",
};

const COMPANY_LABELS: Record<string, string> = {
  companyName: "Company name",
  description: "Business description",
  services: "Products and services",
  idealCustomers: "Ideal customers",
  operatingArea: "Operating area",
  goals: "Business goals",
};

function reasonMeta(code: string): { label: string; detail: string; severity: ConfigReasonSeverity } {
  return (
    STRUCTURAL_REASONS[code] ??
    (code in INSTRUCTION_RISK_META
      ? INSTRUCTION_RISK_META[code as keyof typeof INSTRUCTION_RISK_META]
      : { label: sentenceCase(code.replaceAll("_", " ")), detail: "This change needs a person's review.", severity: "review" as const })
  );
}

/** Maps stored risk codes (including codes from older validator versions) to review labels. */
export function describeRiskCodes(codes: readonly string[]): ReviewReasonView[] {
  const seen = new Set<string>();
  const out: ReviewReasonView[] = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const meta = reasonMeta(code);
    out.push({ code, label: meta.label, detail: meta.detail, severity: meta.severity, field: "" });
  }
  return out;
}

export function decisionFromRiskFlags(flags: readonly string[]): ConfigDecision {
  let decision: ConfigDecision = flags.length ? "review_required" : "auto_apply";
  for (const flag of flags) {
    if (reasonMeta(flag).severity === "block") return "blocked";
    decision = "review_required";
  }
  return decision;
}

const SUSPICIOUS_NAME = /\b(iacquire|iacquireos|admin|administrator|support|official|system|security|billing|owner)\b/i;

const guardrailFields: Array<{ key: "neverPromise" | "escalateWhen" | "companyRules"; label: string }> = [
  { key: "neverPromise", label: "Never promise" },
  { key: "escalateWhen", label: "Ask a human when" },
  { key: "companyRules", label: "Company rules" },
];

function roleAnswerLabel(key: string) {
  return `Role answer: ${key.replaceAll("_", " ")}`;
}

export interface CompanyReviewInput {
  companyName?: string;
  description?: string;
  services?: string;
  idealCustomers?: string;
  operatingArea?: string;
  goals?: string[];
}

export function classifyConfigChange(input: {
  role: AgentRoleKey;
  previous: AgentSettings | null;
  next: AgentSettings;
  source: ConfigSource;
  actorKind: ConfigActorKind;
  orgKind: ConfigOrgKind;
  company?: CompanyReviewInput;
}): ConfigClassification {
  const reasons: ConfigReason[] = [];
  const seen = new Set<string>();
  const add = (reason: ConfigReason) => {
    const key = `${reason.code}:${reason.field}`;
    if (seen.has(key)) return;
    seen.add(key);
    reasons.push(reason);
  };
  const addInstruction = (field: string, label: string, value: string | undefined | null) => {
    for (const finding of scanInstructionText(value)) {
      const meta = INSTRUCTION_RISK_META[finding.code];
      add({
        code: finding.code,
        severity: finding.severity,
        field,
        label,
        detail: meta.detail,
        match: finding.match,
      });
    }
  };

  const { previous, next, company } = input;

  if (previous) {
    for (const guardrail of guardrailFields) {
      const before = previous[guardrail.key].trim();
      const after = next[guardrail.key].trim();
      if (!before || before === after) continue;
      if (!after) {
        add({
          code: "guardrail_removed",
          severity: "review",
          field: guardrail.key,
          label: guardrail.label,
          detail: `${guardrail.label} was deleted. The employee would no longer have that restriction.`,
          match: before.slice(0, 200),
        });
      } else if (!after.includes(before)) {
        add({
          code: "guardrail_weakened",
          severity: "review",
          field: guardrail.key,
          label: guardrail.label,
          detail: `${guardrail.label} was changed rather than extended. Review that the new wording still protects the same boundary.`,
          match: after.slice(0, 200),
        });
      }
    }

    if (previous.escalationContact.trim() !== next.escalationContact.trim()) {
      add({
        code: "escalation_destination_changed",
        severity: "review",
        field: "escalationContact",
        label: "Escalation contact",
        detail: "Escalations would go to a different contact.",
        match: next.escalationContact.slice(0, 200),
      });
    }

    if (previous.approvalPreference === "always" && next.approvalPreference === "high_impact") {
      add({
        code: "approval_scope_reduced",
        severity: "review",
        field: "approvalPreference",
        label: "Approval preference",
        detail: "The preferred approval scope would move from every business action to only high-impact actions.",
      });
    }

    const reenabled = previous.disabledTools.filter((tool) => !next.disabledTools.includes(tool));
    if (reenabled.length) {
      add({
        code: "tool_reenabled",
        severity: "review",
        field: "disabledTools",
        label: "Allowed actions",
        detail: `Previously switched-off action${reenabled.length === 1 ? "" : "s"} would be switched back on: ${reenabled.join(", ")}.`,
        match: reenabled.join(", "),
      });
    }

    if (previous.displayName !== next.displayName && SUSPICIOUS_NAME.test(next.displayName)) {
      add({
        code: "impersonation_risk",
        severity: "review",
        field: "displayName",
        label: "Employee name",
        detail: "The proposed name could be mistaken for iAcquire, an administrator or another authority.",
        match: next.displayName,
      });
    }
  }

  const textFields: Array<[string, string, string | undefined]> = [
    ["displayName", FIELD_LABELS.displayName, next.displayName],
    ["personality", FIELD_LABELS.personality, next.personality],
    ["characterTraits", FIELD_LABELS.characterTraits, next.characterTraits],
    ["communicationStyle", FIELD_LABELS.communicationStyle, next.communicationStyle],
    ["responseBehavior", FIELD_LABELS.responseBehavior, next.responseBehavior],
    ["operatingProcedures", FIELD_LABELS.operatingProcedures, next.operatingProcedures],
    ["proactiveResponsibilities", FIELD_LABELS.proactiveResponsibilities, next.proactiveResponsibilities],
    ["reportingBehavior", FIELD_LABELS.reportingBehavior, next.reportingBehavior],
    ["customInstruction", FIELD_LABELS.customInstruction, next.customInstruction],
    ["companyRules", FIELD_LABELS.companyRules, next.companyRules],
    ["neverPromise", FIELD_LABELS.neverPromise, next.neverPromise],
    ["escalateWhen", FIELD_LABELS.escalateWhen, next.escalateWhen],
    ["escalationContact", FIELD_LABELS.escalationContact, next.escalationContact],
    ["responsibilities", FIELD_LABELS.responsibilities, next.responsibilities],
    ["goals", FIELD_LABELS.goals, next.goals],
    ["targetCustomers", FIELD_LABELS.targetCustomers, next.targetCustomers],
  ];
  for (const [field, label, value] of textFields) addInstruction(field, label, value);
  for (const [key, value] of Object.entries(next.roleAnswers)) addInstruction(`roleAnswers.${key}`, roleAnswerLabel(key), value);

  if (company) {
    const companyFields: Array<[string, string | undefined]> = [
      ["companyName", company.companyName],
      ["description", company.description],
      ["services", company.services],
      ["idealCustomers", company.idealCustomers],
      ["operatingArea", company.operatingArea],
      ["goals", (company.goals ?? []).join("\n")],
    ];
    for (const [field, value] of companyFields) addInstruction(`company.${field}`, COMPANY_LABELS[field] ?? sentenceCase(field), value);
  }

  const hasBlock = reasons.some((reason) => reason.severity === "block");
  const decision: ConfigDecision = hasBlock ? "blocked" : reasons.length ? "review_required" : "auto_apply";
  const riskFlags = [...new Set(reasons.map((reason) => reason.code))].sort();
  return { decision, severity: hasBlock ? "block" : reasons.length ? "review" : "none", reasons, riskFlags };
}

/** Redacts token-like values before review text is sent to a browser. */
export function redactReviewText(value: string): string {
  return value
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\b\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}

export function buildReviewDiff(previous: AgentSettings, next: AgentSettings): ReviewDiffView[] {
  return diffAgentSettings(previous, next).map((change) => ({
    key: change.key,
    label: change.label,
    before: redactReviewText(change.before),
    after: redactReviewText(change.after),
  }));
}

/** Human label for a version's source, corrected for internal agency workspaces. */
export function configSourceLabel(source: string, orgKind: ConfigOrgKind): string {
  if (source === "onboarding") return "Onboarding configuration";
  if (orgKind === "agency" && (source === "agency" || source === "client_edit")) return "Internal edit";
  if (source === "agency") return "Agency edit";
  if (source === "change_request") return "Requested change";
  if (source === "rollback") return "Restored version";
  return sentenceCase(source);
}

/**
 * Server-derived attribution. A portal save is an agency edit when it happens in the agency
 * workspace or when the signed-in account has an agency platform role; otherwise it is a client edit.
 */
export function configAttribution(input: { orgKind: ConfigOrgKind; platformRole: PlatformRole }): {
  source: "client_edit" | "agency";
  actorKind: "user" | "agency";
} {
  const agencyActor = input.orgKind === "agency" || input.platformRole !== "none";
  return agencyActor ? { source: "agency", actorKind: "agency" } : { source: "client_edit", actorKind: "user" };
}
