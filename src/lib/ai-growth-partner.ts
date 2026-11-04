import { z } from "zod";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import type { StoredAnswers } from "@/lib/onboarding/types";

export const AI_GROWTH_PARTNER_NAME = "AI Growth Partner" as const;

export const AI_GROWTH_PARTNER_CAPABILITIES = [
  "lead_discovery_qualification",
  "sales_outreach",
  "calendar_appointments",
  "crm_pipeline",
  "business_operations",
  "performance_analytics",
] as const;

export const AI_GROWTH_PARTNER_CAPABILITY_INFO: Record<(typeof AI_GROWTH_PARTNER_CAPABILITIES)[number], { title: string; description: string }> = {
  lead_discovery_qualification: {
    title: "Lead Discovery & Qualification",
    description: "Find relevant prospects, preserve source evidence, and check fit against client-approved criteria.",
  },
  sales_outreach: {
    title: "Sales & Outreach",
    description: "Prepare relevant customer communication and keep external contact behind the required approval.",
  },
  calendar_appointments: {
    title: "Calendar & Appointment Management",
    description: "Use connected availability and booking rules to prepare appointment actions for review.",
  },
  crm_pipeline: {
    title: "CRM & Pipeline Management",
    description: "Work with authorized contact and opportunity records while checking for duplicates and preserving history.",
  },
  business_operations: {
    title: "Business Operations",
    description: "Coordinate approved tasks, schedules, handoffs, and blockers in the workspace.",
  },
  performance_analytics: {
    title: "Performance & Analytics",
    description: "Explain recorded acquisition activity and outcomes with their evidence and limits.",
  },
};

export const BUSINESS_BRAIN_SECTIONS = [
  "businessIdentity",
  "productsServicesOffers",
  "idealCustomers",
  "acquisitionStrategy",
  "salesKnowledge",
  "brandCommunication",
  "businessOperations",
  "policies",
  "employeeGoals",
  "productOperations",
  "employeeBehavior",
] as const;

export const BusinessBrainProvenanceSchema = z.object({
  source: z.enum([
    "onboarding",
    "client_confirmed",
    "company_knowledge",
    "knowledge_document",
    "website",
    "integration",
    "crm",
    "calendar",
    "client_edit",
    "draft_suggestion",
    "historical_record",
  ]),
  sourceId: z.string().trim().min(1).max(240).nullable().default(null),
  evidenceUrl: z.string().url().max(2048).nullable().default(null),
  observedAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export const BusinessBrainFactSchema = z.object({
  value: z.unknown(),
  state: z.enum(["verified", "client_confirmed", "draft_suggestion", "unknown", "historical", "superseded"]),
  provenance: z.array(BusinessBrainProvenanceSchema).max(50),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  clientOverride: z.boolean().default(false),
}).superRefine((fact, ctx) => {
  if (fact.state === "unknown" && fact.value !== null) {
    ctx.addIssue({ code: "custom", message: "Unknown Business Brain facts must have a null value.", path: ["value"] });
  }
  if (fact.clientOverride && fact.state !== "client_confirmed") {
    ctx.addIssue({ code: "custom", message: "A manual client override must remain client-confirmed.", path: ["state"] });
  }
});

const BusinessBrainSectionSchema = z.record(z.string().min(1).max(120), BusinessBrainFactSchema);

export const BusinessBrainSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }).nullable(),
  sections: z.object({
    businessIdentity: BusinessBrainSectionSchema,
    productsServicesOffers: BusinessBrainSectionSchema,
    idealCustomers: BusinessBrainSectionSchema,
    acquisitionStrategy: BusinessBrainSectionSchema,
    salesKnowledge: BusinessBrainSectionSchema,
    brandCommunication: BusinessBrainSectionSchema,
    businessOperations: BusinessBrainSectionSchema,
    policies: BusinessBrainSectionSchema,
    employeeGoals: BusinessBrainSectionSchema,
    productOperations: BusinessBrainSectionSchema,
    employeeBehavior: BusinessBrainSectionSchema,
  }).strict(),
}).strict();

export type BusinessBrain = z.infer<typeof BusinessBrainSchema>;
export type BusinessBrainFact = z.infer<typeof BusinessBrainFactSchema>;

const REQUIRED_UNKNOWN_FACTS: Record<(typeof BUSINESS_BRAIN_SECTIONS)[number], readonly string[]> = {
  businessIdentity: ["companyName", "industry", "businessModel", "website", "locations", "serviceAreas", "background", "positioning", "differentiators"],
  productsServicesOffers: ["products", "services", "approvedDescriptions", "pricing", "restrictions", "guarantees", "promotionRules", "consultationOffers", "conversionDestinations"],
  idealCustomers: ["targetTypes", "industries", "companySize", "locations", "decisionMakerRoles", "needs", "painPoints", "qualification", "disqualifiers", "excludedProspects"],
  acquisitionStrategy: ["bestFitProspects", "buyingSignals", "discoverySources", "qualificationApproach", "salesFunnel", "outreachMethods", "followUpStrategy", "conversionGoals", "bookingStrategy", "leadPriorities"],
  salesKnowledge: ["talkingPoints", "valueProposition", "commonQuestions", "verifiedDifferentiators", "objectionHandling", "proposalRules", "escalationRequirements", "communicationBoundaries"],
  brandCommunication: ["tone", "language", "formality", "style", "responseLength", "terminology", "brandVoice", "topicsToAvoid"],
  businessOperations: ["operatingHours", "timeZone", "teamResponsibilities", "crmProcesses", "leadRouting", "pipelineDefinitions", "appointmentProcedures", "supportProcedures", "internalHandoffs", "escalationContacts"],
  policies: ["customerPolicies", "cancellation", "rescheduling", "refunds", "privacy", "legalBoundaries", "authorizedPromises", "requiredApprovals"],
  employeeGoals: ["acquisitionTargets", "qualifiedLeadTargets", "bookingTargets", "conversionObjectives", "reportingCadence", "priorities", "constraints"],
  productOperations: ["crmUsage", "calendarUsage", "inboxUsage", "campaignRules", "automationEntitlements", "workBoardUsage", "jobScheduling", "reporting", "approvalProcess"],
  employeeBehavior: ["personality", "reliability", "initiative", "planning", "escalationBehavior", "reportingPreferences", "workingPriorities", "operatingLimits"],
};

function unknownFact(): BusinessBrainFact {
  return { value: null, state: "unknown", provenance: [], updatedAt: null, clientOverride: false };
}

export function emptyBusinessBrain(): BusinessBrain {
  const sections = Object.fromEntries(BUSINESS_BRAIN_SECTIONS.map((section) => [
    section,
    Object.fromEntries(REQUIRED_UNKNOWN_FACTS[section].map((key) => [key, unknownFact()])),
  ])) as BusinessBrain["sections"];
  return {
    schemaVersion: 1,
    generatedAt: null,
    sections,
  };
}

export function parseBusinessBrain(input: unknown): BusinessBrain {
  return BusinessBrainSchema.parse(input);
}

/**
 * Regeneration may add or revise system-derived facts, but a client-approved field is preserved
 * byte-for-byte until the client changes it. The caller must save the result as a new version.
 */
export function preserveClientOverrides(existingInput: unknown, generatedInput: unknown): BusinessBrain {
  const existing = parseBusinessBrain(existingInput);
  const generated = parseBusinessBrain(generatedInput);
  const sections = { ...generated.sections };

  for (const section of BUSINESS_BRAIN_SECTIONS) {
    const merged = { ...sections[section] };
    for (const [key, fact] of Object.entries(existing.sections[section])) {
      if (fact.clientOverride) merged[key] = fact;
    }
    sections[section] = merged;
  }

  return parseBusinessBrain({ ...generated, sections });
}

function brainSectionForQuestion(id: string): (typeof BUSINESS_BRAIN_SECTIONS)[number] {
  if (["a.target_customers", "b.ideal_customer", "b.qualification", "b.re_property_types", "b.re_buyers", "b.hc_patient_types"].includes(id)) return "idealCustomers";
  if (["b.services", "e.products", "e.faqs", "b.hc_services", "b.hs_services"].includes(id)) return "productsServicesOffers";
  if (["b.goals", "b.goal_other", "b.lead_target"].includes(id)) return "employeeGoals";
  if (["a.hours", "a.timezone", "a.location", "a.contact_email", "a.contact_phone", "d.team", "d.appt_types", "d.appt_availability", "d.appt_host", "d.appt_busy_calendar", "d.appt_notice", "d.appt_buffer", "d.appt_confirmation", "d.appt_changes", "d.appt_video", "d.appt_video_link"].includes(id)) return "businessOperations";
  if (["c.never_promise", "c.sensitive_topics", "c.human_escalation", "d.handoff_rules", "d.appt_cancellation", "d.pricing_policy", "d.pricing_info", "d.discount_rules", "e.policies", "b.hs_emergency", "d.hc_emergency"].includes(id)) return "policies";
  if (["c.tone", "c.reply_length", "c.language", "c.company_rules"].includes(id)) return "brandCommunication";
  if (["d.sales_process", "d.handoff_requirements", "d.hs_quote", "d.ag_discovery", "d.hc_insurance"].includes(id)) return "salesKnowledge";
  if (["a.hours", "a.timezone", "e.support_info"].includes(id)) return "businessOperations";
  if (["c.channels", "c.sms_sender", "c.whatsapp_number", "c.email_sender", "c.response_hours", "c.ai_behavior", "e.documents"].includes(id)) return "productOperations";
  if (["d.followup", "b.lead_sources", "b.sales_model", "b.appointments", "b.appointment_goal"].includes(id)) return "acquisitionStrategy";
  if (id.startsWith("a.")) return "businessIdentity";
  if (id.startsWith("b.")) return "acquisitionStrategy";
  if (id.startsWith("c.")) return "employeeBehavior";
  if (id.startsWith("d.")) return "businessOperations";
  if (id.startsWith("e.")) return "businessIdentity";
  return "employeeBehavior";
}

const CANONICAL_BRAIN_FIELDS: Record<string, { section: (typeof BUSINESS_BRAIN_SECTIONS)[number]; key: string }> = {
  "a.business_name": { section: "businessIdentity", key: "companyName" },
  "a.industry": { section: "businessIdentity", key: "industry" },
  "a.business_model": { section: "businessIdentity", key: "businessModel" },
  "a.website": { section: "businessIdentity", key: "website" },
  "a.location": { section: "businessIdentity", key: "locations" },
  "a.territories": { section: "businessIdentity", key: "serviceAreas" },
  "a.description": { section: "businessIdentity", key: "background" },
  "a.target_customers": { section: "idealCustomers", key: "targetTypes" },
  "b.services": { section: "productsServicesOffers", key: "services" },
  "b.qualification": { section: "idealCustomers", key: "qualification" },
  "c.tone": { section: "brandCommunication", key: "tone" },
  "c.language": { section: "brandCommunication", key: "language" },
  "c.reply_length": { section: "brandCommunication", key: "responseLength" },
  "e.products": { section: "productsServicesOffers", key: "products" },
  "e.faqs": { section: "salesKnowledge", key: "commonQuestions" },
  "e.policies": { section: "policies", key: "customerPolicies" },
};

/**
 * Builds a structured starting Business Brain from saved questionnaire answers only. Unconfirmed
 * suggestions remain marked as drafts, skipped and unknown question IDs are ignored, and no fact
 * is inferred from missing data. The caller supplies the existing onboarding answer ledger.
 */
export function generateBusinessBrainFromOnboarding(storedAnswers: StoredAnswers, generatedAt = new Date()): BusinessBrain {
  const brain = emptyBusinessBrain();
  brain.generatedAt = generatedAt.toISOString();

  for (const [questionId, answer] of Object.entries(storedAnswers)) {
    if (!QUESTION_BY_ID[questionId] || answer.skipped || answer.value === null || answer.value === undefined) continue;
    const source = answer.source === "user" ? "onboarding"
      : answer.source === "prefill" ? "historical_record"
        : answer.source === "website_analysis" ? "website"
          : "draft_suggestion";
    const state = answer.source === "prefill" ? "historical"
      : answer.source === "user" || !answer.needsConfirmation ? "client_confirmed"
        : "draft_suggestion";
    const canonical = CANONICAL_BRAIN_FIELDS[questionId];
    const section = canonical?.section ?? brainSectionForQuestion(questionId);
    const key = canonical?.key ?? questionId;
    brain.sections[section][key] = {
      value: answer.value,
      state,
      provenance: [{ source, sourceId: questionId, evidenceUrl: null, observedAt: answer.updatedAt }],
      updatedAt: answer.updatedAt,
      clientOverride: false,
    };
  }

  return parseBusinessBrain(brain);
}
