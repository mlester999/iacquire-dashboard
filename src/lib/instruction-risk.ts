/**
 * Conservative instruction-risk scanning shared by server validation and review UI.
 *
 * The scanner deliberately works sentence by sentence so a restrictive policy statement
 * ("never send without approval") is not treated the same as a permissive one
 * ("send it automatically without approval"). Keyword matching alone cannot tell those apart.
 */

export type InstructionRiskSeverity = "block" | "review";

export type InstructionRiskCode =
  | "override_attempt"
  | "prompt_probe"
  | "role_hijack"
  | "permission_grant"
  | "secret_request"
  | "cross_tenant"
  | "approval_bypass"
  | "ambiguous_instruction"
  | "markup_injection";

export interface InstructionFinding {
  code: InstructionRiskCode;
  severity: InstructionRiskSeverity;
  /** The exact substring that triggered the finding. */
  match: string;
  /** A short sentence excerpt for reviewers; never the whole document. */
  excerpt: string;
}

export interface InstructionRiskMeta {
  label: string;
  detail: string;
  severity: InstructionRiskSeverity;
}

export const INSTRUCTION_RISK_META: Record<InstructionRiskCode, InstructionRiskMeta> = {
  override_attempt: {
    label: "Instruction override",
    detail: "Tries to override or disregard the employee's rules, policy or instructions.",
    severity: "block",
  },
  prompt_probe: {
    label: "System prompt probe",
    detail: "Tries to reveal or extract hidden system or developer instructions.",
    severity: "block",
  },
  role_hijack: {
    label: "Role hijack",
    detail: "Tries to change the employee into an administrator, developer or other privileged role.",
    severity: "block",
  },
  permission_grant: {
    label: "Permission grant",
    detail: "Tries to grant tools, administrator access or permissions the workspace does not control.",
    severity: "block",
  },
  secret_request: {
    label: "Secret request",
    detail: "Tries to collect, reveal or exfiltrate passwords, API keys, tokens or credentials.",
    severity: "block",
  },
  cross_tenant: {
    label: "Cross-tenant access",
    detail: "Tries to access or share another client's data or workspace.",
    severity: "block",
  },
  approval_bypass: {
    label: "Approval bypass",
    detail: "May let sensitive or external work proceed without the human approval the platform requires.",
    severity: "review",
  },
  ambiguous_instruction: {
    label: "Ambiguous instruction",
    detail: "Uses an open-ended instruction for a customer-facing or high-impact action.",
    severity: "review",
  },
  markup_injection: {
    label: "Prompt markup injection",
    detail: "Contains prompt-control tags or markup that could escape the quoted business context.",
    severity: "block",
  },
};

const SENTENCE_BREAK = /[.!?]+(?:\s+|$)|\n+/;

const NEGATION =
  /\b(never|do not|don't|must not|mustn't|should not|shouldn't|cannot|can't|may not|not permitted|prohibited|forbidden|avoid|refuse|decline)\b/i;

const CONDITIONAL =
  /\b(only when|only if|when permitted|where permitted|if permitted|permitted by|allowed by|subject to|in accordance with|consistent with|requires?|required|needs? approval|approval (?:is )?required)\b/i;

const EXTERNAL_ACTION =
  /\b(send|sending|email|e-mail|message|messaging|contact|contacting|call|calling|publish|publishing|post|posting|book|booking|charge|charging|refund|refunding|delete|deleting|contract|contracts|payment|payments|proposal|proposals|quote|quotes|price|pricing|discount|discounts|outreach|campaign|campaigns|customer|customers|client|clients|external)\b/i;

const INTERNAL_ROUTINE =
  /\b(monitor|monitoring|review|reviewing|internal|analyse|analyze|analysis|draft|drafting|summarise|summarize|summarising|summarizing|retrieve|retrieving|research|researching|prepare|preparing|recommend|recommending|report|reporting|organise|organize|organising|organizing|prioritise|prioritize|coordinate|coordinating)\b/i;

const BROAD_SCOPE = /\b(all|any|every|everything|anything|unlimited|unrestricted)\b/i;

const OVERRIDE_ATTEMPT =
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,50}\b(instructions?|rules?|polic(?:y|ies)|guardrails?|prompt)\b/i;

const SYSTEM_PROMPT = /\b(?:system|developer)\s+(?:prompt|instructions?)\b|\bhidden\s+(?:prompt|message|instructions?)\b/i;
const REVEAL_VERB = /\b(reveal|show|print|repeat|display|output|share|disclose|leak|dump|return)\b/i;

const ROLE_HIJACK =
  /\b(you are now|act as (?:an? )?(?:admin|administrator|developer|root|superuser)|pretend (?:to be|you are))\b/i;

const PERMISSION_GRANT =
  /\b(grant|give|enable|unlock|allow)\b[^.\n]{0,40}\b(yourself|full access|admin|administrator|permissions?|tools?|access to)\b/i;

const SECRET_TERM = /\b(api[\s_-]?keys?|passwords?|access tokens?|credentials?|secret keys?)\b/i;
const SECRET_VERB = /\b(reveal|show|print|send|share|collect|ask(?: for)?|provide|export|expose|return|disclose|leak|enter|submit)\b/i;

const CROSS_TENANT_DATA =
  /\b(?:other|another|all)\s+(?:clients?|tenants?|customers?)(?:'s|’s|s')?\s+(?:data|accounts?|records?|information|details|workspaces?)\b/i;
const CROSS_TENANT_ACTION =
  /\b(access|accessing|read|reading|view|viewing|export|exporting|share|sharing|use|using|include|including|retrieve|retrieving|copy|copying|send|sending)\b[^.\n]{0,50}\b(?:other|another|all)\s+(?:clients?|tenants?|customers?)\b/i;

const MARKUP_INJECTION = /<\/?\s*(?:system|instructions?|assistant|im_start|im_end)\b|<\|/i;

const SAFETY_DISABLE =
  /\b(disable|turn off|remove|bypass)\b[^.\n]{0,40}\b(safety|guardrails?|security controls?|platform policy|platform security)\b/i;

const APPROVAL_CUE =
  /\b(without (?:asking|approval|permission)|skip (?:the )?approvals?|disable (?:approvals?|safety|guardrails?)|send (?:it )?automatically|no approval (?:is )?(?:needed|required)|approval (?:is )?not required)\b/i;

const AMBIGUOUS_ACTION =
  /\b(always|must|from now on|automatically)\b[^.\n]{0,60}\b(send|contact|email|message|publish|post|book|charge|refund|delete|share|access|price|discount|contract|payment|customer|client)\b/i;

function excerptOf(sentence: string): string {
  return sentence.length > 260 ? `${sentence.slice(0, 260)}…` : sentence;
}

function sentencesOf(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Returns conservative findings for one piece of user-editable text.
 *
 * Rules:
 * - literal prompt-control markup is always blocked;
 * - an explicit override, privilege grant, secret request or cross-tenant access is
 *   blocked unless the sentence is clearly restrictive ("never", "do not", ...);
 * - approval-bypass language is reviewed only when it is not clearly restrictive and
 *   it affects an external/sensitive action or is broad; routine internal work is allowed;
 * - open-ended customer-facing instructions are reviewed.
 */
export function scanInstructionText(value: string | null | undefined): InstructionFinding[] {
  if (!value?.trim()) return [];
  const findings = new Map<string, InstructionFinding>();
  const add = (code: InstructionRiskCode, match: string, sentence: string) => {
    const key = `${code}:${match}`;
    if (findings.has(key)) return;
    findings.set(key, {
      code,
      severity: INSTRUCTION_RISK_META[code].severity,
      match,
      excerpt: excerptOf(sentence),
    });
  };

  for (const sentence of sentencesOf(value)) {
    const negated = NEGATION.test(sentence);
    const conditional = CONDITIONAL.test(sentence);

    const markup = MARKUP_INJECTION.exec(sentence);
    if (markup) add("markup_injection", markup[0], sentence);

    const safety = SAFETY_DISABLE.exec(sentence);
    if (safety && !negated) add("override_attempt", safety[0], sentence);

    const override = OVERRIDE_ATTEMPT.exec(sentence);
    if (override && !negated) add("override_attempt", override[0], sentence);

    const probe = SYSTEM_PROMPT.exec(sentence);
    if (probe && REVEAL_VERB.test(sentence) && !negated) add("prompt_probe", probe[0], sentence);

    const hijack = ROLE_HIJACK.exec(sentence);
    if (hijack && !negated) add("role_hijack", hijack[0], sentence);

    const grant = PERMISSION_GRANT.exec(sentence);
    if (grant && !negated) add("permission_grant", grant[0], sentence);

    const secret = SECRET_TERM.exec(sentence);
    if (secret && SECRET_VERB.test(sentence) && !negated) add("secret_request", secret[0], sentence);

    const crossData = CROSS_TENANT_DATA.exec(sentence);
    const crossAction = CROSS_TENANT_ACTION.exec(sentence);
    if ((crossData || crossAction) && !negated) add("cross_tenant", (crossData ?? crossAction)![0], sentence);

    const approval = APPROVAL_CUE.exec(sentence);
    if (approval && !negated) {
      const external = EXTERNAL_ACTION.test(sentence);
      const internal = INTERNAL_ROUTINE.test(sentence);
      const broad = BROAD_SCOPE.test(sentence);
      // A sentence that only describes routine internal work is not a bypass. If it is
      // external, broad, or gives no bounded routine scope, a person should review it.
      if (external || broad || !internal) add("approval_bypass", approval[0], sentence);
    }

    // "When permitted by system policies" narrows an approval statement rather than
    // expanding it. It is still not enough to make an external bypass safe, but it keeps
    // a routine internal statement from being flagged.
    const ambiguous = AMBIGUOUS_ACTION.exec(sentence);
    if (ambiguous && !negated && !conditional) add("ambiguous_instruction", ambiguous[0], sentence);
  }

  return [...findings.values()];
}

/** Backwards-compatible flag-only helper used by knowledge, profile and preview validation. */
export function detectRiskFlags(...values: Array<string | undefined | null>): string[] {
  const flags = new Set<string>();
  for (const value of values) {
    for (const finding of scanInstructionText(value)) flags.add(finding.code);
  }
  return [...flags].sort();
}
