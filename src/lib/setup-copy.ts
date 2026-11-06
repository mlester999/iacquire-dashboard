type ClientActionCopy = { type: string; label: string; instructions: string };

export interface SetupCopyView {
  key: string;
  title: string;
  clientTitle: string | null;
  description: string;
  completionNotice: string | null;
  clientAction: ClientActionCopy | null;
}

const LEGACY_COPY: Record<string, {
  title?: readonly [string, string];
  clientTitle?: readonly [string, string];
  description?: readonly [string, string];
  completionNotice?: readonly [string, string];
  action?: { oldLabel: string; newLabel: string; oldInstructions: string; newInstructions: string };
}> = {
  company_info: {
    description: [
      "The details you shared about your business, goals and how your AI team should communicate.",
      "The details you shared about your business, goals and how AI should support your work.",
    ],
  },
  ai_employees: {
    title: ["Six client-specific Hermes AI employees configured", "AI runtime and safety checks passed"],
    clientTitle: ["Your six AI employees are configured", "Your AI runtime is configured"],
    description: [
      "Each AI employee gets its own private environment and is checked live before it is marked ready.",
      "We prepare the AI runtime with your approved business information, behavior and permissions. It becomes ready only after its connection and safety checks pass.",
    ],
    completionNotice: ["Your AI team is ready", "Your AI workspace is ready"],
    action: {
      oldLabel: "Approve your AI employee configuration",
      newLabel: "Review your AI workspace configuration",
      oldInstructions: "Review how each AI employee will work and communicate in AI Workforce, then approve so we can finish and test them.",
      newInstructions: "Review the approved business information, communication settings and enabled capabilities, then approve so we can finish and test your setup.",
    },
  },
  ai_configuration: {
    title: ["AI employee configuration drafts prepared", "AI workspace configuration prepared"],
    clientTitle: ["Your AI employee instructions are prepared", "Your AI configuration is prepared"],
    description: [
      "We prepare each included employee around your business knowledge, tone and approved responsibilities.",
      "We prepare an AI configuration around your approved business information, communication preferences and permitted capabilities.",
    ],
  },
  ai_profiles: {
    title: ["Dedicated AI employee profiles provisioned", "Private AI runtime profile provisioned"],
    clientTitle: ["Your private AI employees are prepared", "Your private AI runtime is prepared"],
    description: [
      "We prepare separate employee identities for your company. They become ready only after successful connection and safety checks.",
      "We prepare the private runtime profile for your workspace. It becomes ready only after successful connection and safety checks.",
    ],
  },
  integration_tests: {
    title: ["AI workforce and integration tests passed", "AI and integration checks passed"],
    description: [
      "We run live checks across your AI employees and connected tools before activation.",
      "We run live checks across the AI runtime, CRM and connected tools before activation.",
    ],
  },
  knowledge_review: {
    description: [
      "We review your approved business information so your AI employees have accurate reference material.",
      "We review approved business information and reference materials before the AI runtime is activated.",
    ],
  },
};

function current(value: string | null, rule?: readonly [string, string]) {
  return rule && value === rule[0] ? rule[1] : value;
}

/** Presentation-only cleanup for known legacy checklist copy; it never changes saved workflow rows. */
export function currentSetupCopy<T extends SetupCopyView>(source: T): T {
  const rules = LEGACY_COPY[source.key];
  if (!rules) return source;
  const action = source.clientAction;
  const nextAction = rules.action && action?.type === "approve"
    && action.label === rules.action.oldLabel
    && action.instructions === rules.action.oldInstructions
    ? { ...action, label: rules.action.newLabel, instructions: rules.action.newInstructions }
    : action;
  return {
    ...source,
    title: current(source.title, rules.title) ?? source.title,
    clientTitle: current(source.clientTitle, rules.clientTitle),
    description: current(source.description, rules.description) ?? source.description,
    completionNotice: current(source.completionNotice, rules.completionNotice),
    clientAction: nextAction,
  } as T;
}
