import type { AgentRoleKey } from "@/lib/agents";

/**
 * Client-safe, role-aware guidance for every editable AI-employee field.
 *
 * The copy here is deliberately tied to real backend behaviour: tools can only be switched off
 * (never added), the approval preference is fixed by policy, and instructions cannot grant
 * permissions. Examples are illustrative only and are never written into a field automatically.
 */

export interface FieldGuidance {
  /** Short, visible explanation shown beneath the label. */
  description: string;
  /** A realistic answer used as the placeholder and, when useful, inside the help popover. */
  example?: string;
  /** Deeper explanation, available through the optional information button. */
  info?: string;
}

interface RoleGuidance {
  responsibilities: FieldGuidance;
  goals: FieldGuidance;
  targetCustomers: FieldGuidance;
  customInstruction: FieldGuidance;
}

const ROLE_GUIDANCE: Record<AgentRoleKey, RoleGuidance> = {
  operations_manager: {
    responsibilities: {
      description: "Describe the operational work this employee should own. Focus on outcomes rather than technical instructions.",
      example: "Monitor operational tasks, identify blockers, coordinate internal work, and prepare progress reports.",
      info: "The Operations Manager works on internal coordination. It does not contact customers unless its approved tools and your rules explicitly allow it.",
    },
    goals: {
      description: "Describe what a good week looks like for this employee. Goals help it prioritise its work.",
      example: "Help the agency meet deadlines and reduce unresolved operational issues.",
      info: "Goals guide prioritisation and reporting. They do not grant new tools or permissions.",
    },
    targetCustomers: {
      description: "Who relies on this employee's work? Describe the internal teams or client contacts it supports.",
      example: "Agency account managers and client owners who need weekly operational updates.",
      info: "This is internal context. It helps the employee decide what to summarise and who the work is for.",
    },
    customInstruction: {
      description: "Add one specific operating preference for this employee. Keep it factual and within its role.",
      example: "Always flag unresolved blockers that are more than two days old.",
      info: "Instructions refine behaviour. They cannot add tools, change the employee's role or relax iAcquire's safety rules.",
    },
  },
  lead_hunter: {
    responsibilities: {
      description: "Describe the research work this employee should own. Focus on the leads you want prepared for review.",
      example: "Research businesses that match our ideal customer profile and prepare qualified lead records.",
      info: "The Lead Hunter researches and prepares records. Contacting leads is not part of this role.",
    },
    goals: {
      description: "Describe the result you want from lead research. Specific goals make prioritisation clearer.",
      example: "Identify relevant prospects with accurate business information.",
      info: "Goals guide which prospects are prioritised. They do not expand the data the employee can access.",
    },
    targetCustomers: {
      description: "Describe the businesses or people that fit your ideal customer profile.",
      example: "Independent dental clinics with 2–10 locations and an online booking page.",
      info: "This narrows research. Do not include another company's private or customer data.",
    },
    customInstruction: {
      description: "Add one specific research preference for this employee.",
      example: "Include the source URL and a one-line reason for every lead.",
      info: "Instructions refine how research is presented. They cannot grant access to private sources or contacts.",
    },
  },
  appointment_setter: {
    responsibilities: {
      description: "Describe the scheduling work this employee should handle. It prepares bookings; a person still approves customer-facing changes.",
      example: "Help qualified customers find available appointment times and manage booking requests.",
      info: "The Appointment Setter works within your connected calendar and approved meeting types. It cannot create times that are not available.",
    },
    goals: {
      description: "Describe what better scheduling looks like for your business.",
      example: "Improve scheduling efficiency and reduce missed appointments.",
      info: "Goals guide how the employee prioritises requests. Real availability still comes from your calendar.",
    },
    targetCustomers: {
      description: "Describe the qualified prospects who should be offered an appointment.",
      example: "Homeowners who have requested a quote and confirmed their service area.",
      info: "This helps the employee decide who is ready to book. It does not change who can be contacted.",
    },
    customInstruction: {
      description: "Add one specific booking preference for this employee.",
      example: "Always confirm the appointment type before offering a time.",
      info: "Instructions refine scheduling behaviour. They cannot override calendar availability or approval requirements.",
    },
  },
  sales_assistant: {
    responsibilities: {
      description: "Describe the sales support work this employee should handle. It drafts and answers within approved information.",
      example: "Answer approved sales questions, explain services, and prepare follow-up drafts.",
      info: "The Sales Assistant drafts messages but does not send them without the tools and approval rules you have configured.",
    },
    goals: {
      description: "Describe what progress you want this employee to support.",
      example: "Help qualified prospects move through the sales process.",
      info: "Goals guide follow-up priorities. They do not change prices, offers or approval rules.",
    },
    targetCustomers: {
      description: "Describe the qualified prospects your sales assistant should support.",
      example: "Prospects evaluating a website redesign with a budget above $3,000.",
      info: "This helps the employee tailor its support. Do not include sensitive personal data or another company's information.",
    },
    customInstruction: {
      description: "Add one specific sales preference for this employee.",
      example: "Always mention the free consultation in follow-ups.",
      info: "Instructions refine wording and follow-up style. They cannot create new offers or relax approval rules.",
    },
  },
  crm_manager: {
    responsibilities: {
      description: "Describe the record-keeping work this employee should own. Focus on accuracy and visibility.",
      example: "Maintain accurate CRM records, identify incomplete data, and organize pipeline information.",
      info: "The CRM Manager proposes updates. Direct edits still depend on its approved tools and your approval rules.",
    },
    goals: {
      description: "Describe what better CRM data looks like for your team.",
      example: "Improve CRM data quality and visibility.",
      info: "Goals guide which records and fields the employee focuses on. They do not grant access to other workspaces.",
    },
    targetCustomers: {
      description: "Describe whose records this employee maintains.",
      example: "All active clients and open opportunities in the agency CRM.",
      info: "This scopes the employee's reporting context. It cannot expand the records it is authorised to read.",
    },
    customInstruction: {
      description: "Add one specific CRM preference for this employee.",
      example: "Flag records that have no owner or next step.",
      info: "Instructions refine how records are reviewed. They cannot grant access to records outside the workspace.",
    },
  },
  performance_analyst: {
    responsibilities: {
      description: "Describe the analysis and reporting work this employee should own.",
      example: "Analyze authorized business metrics and create performance reports.",
      info: "The Performance Analyst reads only the data it is authorised to access. It does not change business records.",
    },
    goals: {
      description: "Describe the improvements you want the reports to surface.",
      example: "Identify trends, operational improvements, and opportunities.",
      info: "Goals shape what the employee highlights. They do not expand the underlying data set.",
    },
    targetCustomers: {
      description: "Describe who uses the reports and which part of the business they cover.",
      example: "Agency leadership reviewing lead response and conversion.",
      info: "Audience context helps the employee choose the right level of detail. It does not change access.",
    },
    customInstruction: {
      description: "Add one specific reporting preference for this employee.",
      example: "Compare this week with the previous four weeks.",
      info: "Instructions refine reporting style. They cannot grant access to new data sources.",
    },
  },
};

const SHARED_GUIDANCE = {  displayName: {
    description: "The name your team sees in chat, the workforce directory and notifications.",
    example: "e.g. Ava, Operations Manager",
    info: "The name does not change the employee's role, tools or permissions. Names that could be mistaken for iAcquire support or an administrator need review.",
  },
  tone: {
    description: "Choose how this employee should sound when it replies.",
    info: "Tone changes wording only. It cannot change what the employee is allowed to do or when a person must approve an action.",
  },
  replyLength: {
    description: "Choose how much detail replies should include by default.",
    info: "Reply length is a default. The employee can still be brief when a short answer is clearer.",
  },
  language: {
    description: "The language this employee writes its replies in.",
    info: "Company knowledge and instructions are stored as written. They are not translated in storage.",
  },
  companyRules: {
    description: "Add standing rules this employee must follow. Use this to add restrictions, not to grant access.",
    example: "e.g. Never discuss competitor pricing. Always offer the free inspection first.",
    info: "Rules are added to the employee's instructions and combined with iAcquire's protected policy. They cannot override it or grant tools.",
  },
  neverPromise: {
    description: "Tell the employee which commitments it must never make without authorization.",
    example: "e.g. Guaranteed results, discounts, refunds, or exact delivery dates.",
    info: "This protects you from commitments the employee cannot keep. Mandatory platform restrictions still apply.",
  },
  escalateWhen: {
    description: "When should this employee stop and ask a human for help?",
    example: "e.g. When a customer requests a refund, pricing exception, or contract change.",
    info: "Use concrete triggers. The employee hands the conversation to a person instead of guessing.",
  },
  escalationContact: {
    description: "Who should receive escalations? Add a name and a monitored email address.",
    example: "e.g. Dana Ruiz, operations@yourcompany.com",
    info: "This contact is used when the employee hands work to a person. Make sure the inbox is monitored. Changing it can require review.",
  },
} satisfies Record<string, FieldGuidance>;

/** Shared guidance for company-wide defaults, without needing a role-specific lookup. */
export const SHARED_EMPLOYEE_GUIDANCE = SHARED_GUIDANCE;

export const TONE_GUIDANCE: Record<string, string> = {
  friendly: "Warm and approachable, in plain language.",
  professional: "Clear, formal and businesslike.",
  casual: "Relaxed and conversational.",
  premium: "Polished and considered, with a white-glove feel.",
};

export function employeeFieldGuidance(role: AgentRoleKey, field: keyof typeof SHARED_GUIDANCE | keyof RoleGuidance): FieldGuidance {
  if (field === "responsibilities" || field === "goals" || field === "targetCustomers" || field === "customInstruction") {
    return ROLE_GUIDANCE[role][field];
  }
  return SHARED_GUIDANCE[field];
}

export const ROLE_TOOL_GUIDANCE: Record<string, { description: string; off: string }> = {
  "tasks.read": {
    description: "Lets the employee read the workspace tasks it is authorised to access. It cannot read tasks outside its assigned workspace.",
    off: "The employee will not be given task-list access in its instructions.",
  },
  "approvals.create": {
    description: "Lets the employee ask you to approve a customer-facing action. It cannot approve its own requests.",
    off: "The employee cannot create new approval requests. Existing approval rules still apply.",
  },
  "summaries.write": {
    description: "Lets the employee save internal summaries for your team. This does not send anything to customers.",
    off: "The employee will not be asked to save internal summaries.",
  },
  "research.public_web": {
    description: "Lets the employee research approved public web sources. It cannot sign in to private sites or use another workspace's data.",
    off: "The employee will not research public web sources.",
  },
  "leads.stage_for_review": {
    description: "Lets the employee prepare lead records for your review. It cannot contact the lead or change existing records.",
    off: "The employee will not add researched leads to your review queue.",
  },
  "calendar.read_availability": {
    description: "Lets the employee read free and busy times from a connected calendar. It cannot create or move events with this permission alone.",
    off: "The employee will not be given calendar availability.",
  },
  "appointments.read": {
    description: "Lets the employee look up existing appointments in this workspace.",
    off: "The employee will not look up existing appointments.",
  },
  "appointments.request_change": {
    description: "Lets the employee prepare a booking or change request for your team to review. It cannot change the calendar directly with this permission alone.",
    off: "The employee cannot prepare booking or change requests.",
  },
  "crm.read_opportunities": {
    description: "Lets the employee read sales opportunities in your CRM. It cannot edit them.",
    off: "The employee will not read CRM opportunities.",
  },
  "drafts.create": {
    description: "Lets the employee prepare message drafts for your team. It never sends them.",
    off: "The employee will not prepare message drafts.",
  },
  "crm.read": {
    description: "Lets the employee read customer records in your CRM.",
    off: "The employee will not read CRM records.",
  },
  "crm.request_update": {
    description: "Lets the employee propose a CRM change for your team to review. It cannot edit the record directly with this permission alone.",
    off: "The employee cannot propose CRM updates.",
  },
  "analytics.read": {
    description: "Lets the employee read the workspace analytics it is authorised to see for reporting.",
    off: "The employee will not read workspace analytics.",
  },
};

export const TOOL_BOUNDARY_NOTE =
  "Switching a tool off removes it from the employee's instructions. No switch can add a tool the role was not granted. The provider profile and connection health check remain the enforced boundary.";

export const COMPANY_FIELD_GUIDANCE = {
  companyName: {
    description: "The name your team and customers see in this workspace.",
    example: "e.g. Brightside Roofing",
    info: "It appears in reports, notifications and some customer-facing messages. Changing it does not change your AI employees' roles.",
  },
  industry: {
    description: "Choose the closest match for your business. This helps tailor examples and reporting.",
    example: "e.g. Home services",
  },
  website: {
    description: "Provide a company webpage containing information you want included in your business knowledge.",
    example: "e.g. https://brightsideroofing.com",
    info: "Use a public page you own. Reading a website only produces suggestions; it is not treated as verified company data until you review it.",
  },
  operatingArea: {
    description: "The cities, regions or countries you serve.",
    example: "e.g. Austin and surrounding areas, Texas",
    info: "Used to qualify leads and set customer expectations. It does not change which leads can be contacted.",
  },
  description: {
    description: "Explain what your business does, who it serves, and what makes it different. Your authorized AI employees may use this to understand your company.",
    example: "e.g. We repair storm-damaged roofs for homeowners across Central Texas, with a free inspection before any quote.",
    info: "This is business context, not instructions. AI employees treat it as information and cannot gain permissions from it.",
  },
  services: {
    description: "List the products or services you provide. Include important limitations or conditions.",
    example: "e.g. Roof inspections, storm damage repair, gutter replacement. Free inspection. Repairs quoted after assessment.",
    info: "Only list what you are prepared to stand behind. Approved prices belong in the pricing section or your employee's instructions.",
  },
  idealCustomers: {
    description: "Describe the types of people or businesses you want to serve.",
    example: "e.g. Homeowners with houses older than ten years, mostly in suburban neighbourhoods.",
    info: "This helps AI employees prioritise and qualify work. Do not include sensitive personal data.",
  },
  brandColor: {
    description: "The accent colour used in customer-facing pages and messages.",
    example: "e.g. #2C5BFF",
  },
} satisfies Record<string, FieldGuidance>;

export const KNOWLEDGE_GUIDANCE = {
  upload: {
    description: "Upload approved company material that your authorized AI employees may reference. Avoid including information employees should not access.",
    info: "Files are processed and may be held for review if their content conflicts with AI safety policy. Uploading a file does not make it visible to customers.",
  },
  title: {
    description: "Give this note a short name your team will recognise.",
    example: "e.g. Approved service areas",
    info: "The title is for your team. Keep it specific so the right note is easy to find.",
  },
  content: {
    description: "Write short, factual reference notes. The employee treats this as information, never as instructions that can override safety rules.",
    example: "e.g. We serve Austin, Round Rock and Cedar Park. We do not serve San Antonio.",
    info: "Keep it factual and concise. Instructions and permissions belong in the employee's configuration, not in knowledge notes.",
  },
} satisfies Record<string, FieldGuidance>;

/** Maps a stored review field key to the input the user needs to fix. */
export function configFieldElementId(field: string): string | null {
  if (field.startsWith("roleAnswers.")) {
    const key = field.slice("roleAnswers.".length);
    return key ? `cfg-q-${key}` : null;
  }
  switch (field) {
    case "displayName":
      return "cfg-name";
    case "responsibilities":
      return "cfg-resp";
    case "goals":
      return "cfg-goals";
    case "targetCustomers":
      return "cfg-target";
    case "companyRules":
      return "cfg-rules";
    case "neverPromise":
      return "cfg-never";
    case "escalateWhen":
      return "cfg-esc";
    case "escalationContact":
      return "cfg-esc-contact";
    case "customInstruction":
      return "cfg-custom";
    case "disabledTools":
      return "cfg-tools";
    case "approvalPreference":
      return "cfg-approval";
    default:
      return null;
  }
}

/**
 * A safe, plain-English next step for a flagged change. It never exposes detection rules and never
 * implies a blocked change can simply be approved.
 */
export function changeFixForReason(code: string, field: string): string {
  switch (code) {
    case "override_attempt":
      return "Remove the request to ignore or replace the employee's rules. Describe the task you want it to do instead.";
    case "prompt_probe":
      return "Remove the request to reveal hidden instructions. You can ask the employee what it can help with instead.";
    case "role_hijack":
      return "Keep the employee in its assigned role. Choose a different AI employee if you need different work.";
    case "permission_grant":
      return "Remove the permission request. Tools are fixed to the role and can only be switched off in the Tools section.";
    case "secret_request":
      return "Remove any request for passwords, keys or credentials. Never share secrets with an AI employee.";
    case "cross_tenant":
      return "Refer only to your own company's information. This employee cannot access another workspace.";
    case "approval_bypass":
      return "Keep a human approval step, or describe only the internal work that may proceed without one. Customer-facing actions always need approval.";
    case "ambiguous_instruction":
      return "Make the instruction specific. Name the situation and the action the employee should take.";
    case "markup_injection":
      return "Remove tags, code or formatting that look like instructions.";
    case "guardrail_removed":
      return "Restore the previous rule, or replace it with an equally clear restriction.";
    case "guardrail_weakened":
      return "Keep the original restriction and add your new wording after it.";
    case "approval_scope_reduced":
      return "The approval preference is fixed by platform policy and cannot be reduced here.";
    case "escalation_destination_changed":
      return "Use the existing escalation contact. If the change is intentional, submit it for review and explain why in the version.";
    case "tool_reenabled":
      return "Leave the tool switched off. If the role genuinely needs it, submit the change so a reviewer can assess it.";
    case "impersonation_risk":
      return "Choose a name that cannot be mistaken for iAcquire support, an administrator or another authority.";
    default:
      if (field === "displayName") return "Use a clear employee name that describes the role.";
      return "Adjust this field to remove the flagged wording, then check the change again.";
  }
}
