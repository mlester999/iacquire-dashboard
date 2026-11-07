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
  title?: Readonly<Record<string, string>>;
  clientTitle?: Readonly<Record<string, string>>;
  description?: Readonly<Record<string, string>>;
  completionNotice?: Readonly<Record<string, string>>;
  action?: { oldLabel: string; newLabel: string; oldInstructions: string; newInstructions: string };
}> = {
  company_info: {
    description: {
      "The details you shared about your business, goals and how your AI team should communicate.": "The details you shared about your business, goals and how AI should support your work.",
    },
  },
  ai_employees: {
    title: {
      "Six client-specific Hermes AI employees configured": "AI runtime verification",
      "AI runtime and safety checks passed": "AI runtime verification",
      "AI Growth Partner runtime and safety checks passed": "AI Growth Partner runtime verification",
    },
    clientTitle: {
      "Your six AI employees are configured": "Your AI runtime setup",
      "Your AI runtime is configured": "Your AI runtime setup",
      "Your AI Growth Partner is ready": "Your AI Growth Partner setup",
    },
    description: {
      "Each AI employee gets its own private environment and is checked live before it is marked ready.": "We prepare your approved AI configuration and verify its runtime connections, identities and safety before marking setup ready.",
      "We prepare the AI runtime with your approved business information, behavior and permissions. It becomes ready only after its connection and safety checks pass.": "We prepare your approved AI configuration and verify its runtime connections, identities and safety before marking setup ready.",
      "We prepare one tenant-isolated Growth Partner profile with its approved persona, permissions and Business Brain. It becomes ready only after its connection, identity and permitted-tool checks pass.": "We prepare one tenant-isolated AI Growth Partner with its approved Business Brain, personality and permissions. Setup stays in progress until its runtime identity, connection and permitted tools are verified.",
    },
    completionNotice: {
      "Your AI team is ready": "Your AI workspace is ready",
    },
    action: {
      oldLabel: "Approve your AI employee configuration",
      newLabel: "Review your AI workspace configuration",
      oldInstructions: "Review how each AI employee will work and communicate in AI Workforce, then approve so we can finish and test them.",
      newInstructions: "Review the approved business information, communication settings and enabled capabilities, then approve so we can finish and test your setup.",
    },
  },
  ai_configuration: {
    title: {
      "AI employee configuration drafts prepared": "AI workspace configuration",
      "AI workspace configuration prepared": "AI workspace configuration",
      "AI Growth Partner configuration prepared": "AI Growth Partner configuration",
    },
    clientTitle: {
      "Your AI employee instructions are prepared": "Your AI configuration",
      "Your AI configuration is prepared": "Your AI configuration",
    },
    description: {
      "We prepare each included employee around your business knowledge, tone and approved responsibilities.": "We prepare the AI configuration around your approved business information, communication preferences and permitted capabilities.",
    },
  },
  ai_profiles: {
    title: {
      "Dedicated AI employee profiles provisioned": "AI runtime profile preparation",
      "Private AI runtime profile provisioned": "AI runtime profile preparation",
      "AI Growth Partner Hermes profile provisioned": "AI Growth Partner runtime profile",
    },
    clientTitle: {
      "Your private AI employees are prepared": "Your private AI runtime setup",
      "Your private AI runtime is prepared": "Your private AI runtime setup",
      "Your private AI Growth Partner profile is prepared": "Your private AI Growth Partner profile",
    },
    description: {
      "We prepare separate employee identities for your company. They become ready only after successful connection and safety checks.": "We prepare the private runtime profile for your workspace. It becomes ready only after its identity, connection and safety checks pass.",
      "We prepare the private runtime profile for your workspace. It becomes ready only after successful connection and safety checks.": "We prepare the private runtime profile for your workspace. It becomes ready only after its identity, connection and safety checks pass.",
      "We prepare one private Hermes profile for your AI Growth Partner. It becomes ready only after its connection and safety checks pass.": "We prepare one private runtime profile for your AI Growth Partner. It becomes ready only after its identity, connection and safety checks pass.",
    },
  },
  integration_tests: {
    title: {
      "AI workforce and integration tests passed": "AI and integration verification",
      "AI and integration checks passed": "AI and integration verification",
      "AI Growth Partner and integration checks passed": "AI Growth Partner and integration verification",
    },
    clientTitle: {
      "Final system checks passed": "Final system verification",
    },
    description: {
      "We run live checks across your AI employees and connected tools before activation.": "We verify the AI runtime, CRM and connected tools before activation.",
      "We run live checks across the AI runtime, CRM and connected tools before activation.": "We verify the AI runtime, CRM and connected tools before activation.",
      "We run live checks across your AI Growth Partner, CRM and connected tools before activation.": "We verify the AI Growth Partner runtime, CRM and connected tools before activation.",
    },
  },
  knowledge_review: {
    description: {
      "We review your approved business information so your AI employees have accurate reference material.": "We review the approved Business Brain and company information before the AI runtime is activated.",
    },
  },
};

function current(value: string | null, rule?: Readonly<Record<string, string>>) {
  return value === null ? null : rule?.[value] ?? value;
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
