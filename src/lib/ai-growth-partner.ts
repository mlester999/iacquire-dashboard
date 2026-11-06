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
  businessIdentity: ["companyName", "industry", "businessModel", "localBusinessType", "website", "locations", "serviceAreas", "background", "positioning", "differentiators"],
  productsServicesOffers: ["products", "services", "industrySpecificServices", "engagementTypes", "approvedDescriptions", "pricing", "pricingPolicy", "discountRules", "restrictions", "guarantees", "promotionRules", "consultationOffers", "conversionDestinations"],
  idealCustomers: ["targetTypes", "clientSegments", "propertyTypes", "industries", "companySize", "locations", "decisionMakerRoles", "needs", "painPoints", "qualification", "minimumBudget", "disqualifiers", "excludedProspects"],
  acquisitionStrategy: ["bestFitProspects", "buyingSignals", "discoverySources", "qualificationApproach", "salesFunnel", "salesModel", "outreachMethods", "followUpStrategy", "conversionGoals", "bookingStrategy", "leadPriorities", "otherPriorities"],
  salesKnowledge: ["talkingPoints", "valueProposition", "commonQuestions", "discoveryQuestions", "verifiedDifferentiators", "objectionHandling", "proposalRules", "escalationRequirements", "communicationBoundaries"],
  brandCommunication: ["tone", "language", "formality", "style", "responseLength", "terminology", "brandVoice", "topicsToAvoid"],
  businessOperations: ["operatingHours", "timeZone", "teamResponsibilities", "crmProcesses", "leadRouting", "pipelineDefinitions", "appointmentProcedures", "appointmentTypes", "appointmentAvailability", "appointmentHost", "busyCalendar", "bookingNotice", "bookingBuffer", "bookingConfirmation", "appointmentChanges", "videoAppointmentRules", "videoMeetingLink", "propertyViewingProcedures", "emergencyProcedures", "supportProcedures", "internalHandoffs", "escalationContacts"],
  policies: ["customerPolicies", "cancellation", "rescheduling", "refunds", "privacy", "legalBoundaries", "authorizedPromises", "prohibitedPromises", "emergencyCoverage", "insuranceRequirements", "requiredApprovals", "handoffRules"],
  employeeGoals: ["acquisitionTargets", "qualifiedLeadTargets", "bookingTargets", "conversionObjectives", "reportingCadence", "priorities", "constraints"],
  productOperations: ["crmUsage", "calendarUsage", "inboxUsage", "enabledChannels", "smsSender", "whatsappNumber", "emailSender", "responseWindow", "websitePlan", "campaignRules", "automationEntitlements", "workBoardUsage", "jobScheduling", "reporting", "approvalProcess"],
  employeeBehavior: ["personality", "reliability", "initiative", "planning", "assistantBehavior", "companyOperatingRules", "escalationBehavior", "reportingPreferences", "workingPriorities", "operatingLimits"],
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

const CANONICAL_BRAIN_FIELDS: Record<string, { section: (typeof BUSINESS_BRAIN_SECTIONS)[number]; key: string }> = {
  "a.business_name": { section: "businessIdentity", key: "companyName" },
  "a.industry": { section: "businessIdentity", key: "industry" },
  "a.local_kind": { section: "businessIdentity", key: "localBusinessType" },
  "a.business_model": { section: "businessIdentity", key: "businessModel" },
  "a.website": { section: "businessIdentity", key: "website" },
  "a.location": { section: "businessIdentity", key: "locations" },
  "a.territories": { section: "businessIdentity", key: "serviceAreas" },
  "a.timezone": { section: "businessOperations", key: "timeZone" },
  "a.hours": { section: "businessOperations", key: "operatingHours" },
  "a.description": { section: "businessIdentity", key: "background" },
  "a.target_customers": { section: "idealCustomers", key: "targetTypes" },
  "b.goals": { section: "employeeGoals", key: "priorities" },
  "b.goal_other": { section: "acquisitionStrategy", key: "otherPriorities" },
  "b.lead_target": { section: "employeeGoals", key: "acquisitionTargets" },
  "b.ideal_customer": { section: "idealCustomers", key: "needs" },
  "b.lead_sources": { section: "acquisitionStrategy", key: "discoverySources" },
  "b.sales_model": { section: "acquisitionStrategy", key: "salesModel" },
  "b.appointments": { section: "productOperations", key: "calendarUsage" },
  "b.appointment_goal": { section: "acquisitionStrategy", key: "bookingStrategy" },
  "b.re_property_types": { section: "idealCustomers", key: "propertyTypes" },
  "b.re_buyers": { section: "idealCustomers", key: "decisionMakerRoles" },
  "b.hc_services": { section: "productsServicesOffers", key: "industrySpecificServices" },
  "b.hs_emergency": { section: "policies", key: "emergencyCoverage" },
  "b.ag_target_clients": { section: "idealCustomers", key: "clientSegments" },
  "b.ag_min_budget": { section: "idealCustomers", key: "minimumBudget" },
  "b.pr_engagements": { section: "productsServicesOffers", key: "engagementTypes" },
  "b.services": { section: "productsServicesOffers", key: "services" },
  "b.qualification": { section: "idealCustomers", key: "qualification" },
  "c.tone": { section: "brandCommunication", key: "tone" },
  "c.language": { section: "brandCommunication", key: "language" },
  "c.reply_length": { section: "brandCommunication", key: "responseLength" },
  "c.channels": { section: "productOperations", key: "enabledChannels" },
  "c.sms_sender": { section: "productOperations", key: "smsSender" },
  "c.whatsapp_number": { section: "productOperations", key: "whatsappNumber" },
  "c.email_sender": { section: "productOperations", key: "emailSender" },
  "c.response_hours": { section: "productOperations", key: "responseWindow" },
  "c.ai_behavior": { section: "employeeBehavior", key: "assistantBehavior" },
  "c.sensitive_topics": { section: "salesKnowledge", key: "communicationBoundaries" },
  "c.never_promise": { section: "policies", key: "prohibitedPromises" },
  "c.human_escalation": { section: "salesKnowledge", key: "escalationRequirements" },
  "c.company_rules": { section: "employeeBehavior", key: "companyOperatingRules" },
  "d.team": { section: "businessOperations", key: "teamResponsibilities" },
  "d.appt_types": { section: "businessOperations", key: "appointmentTypes" },
  "d.appt_availability": { section: "businessOperations", key: "appointmentAvailability" },
  "d.appt_host": { section: "businessOperations", key: "appointmentHost" },
  "d.appt_busy_calendar": { section: "businessOperations", key: "busyCalendar" },
  "d.appt_notice": { section: "businessOperations", key: "bookingNotice" },
  "d.appt_buffer": { section: "businessOperations", key: "bookingBuffer" },
  "d.appt_confirmation": { section: "businessOperations", key: "bookingConfirmation" },
  "d.appt_changes": { section: "businessOperations", key: "appointmentChanges" },
  "d.appt_video": { section: "businessOperations", key: "videoAppointmentRules" },
  "d.appt_video_link": { section: "businessOperations", key: "videoMeetingLink" },
  "d.appt_cancellation": { section: "policies", key: "cancellation" },
  "d.re_viewings": { section: "businessOperations", key: "propertyViewingProcedures" },
  "d.hc_insurance": { section: "policies", key: "insuranceRequirements" },
  "d.hc_emergency": { section: "businessOperations", key: "emergencyProcedures" },
  "d.hs_quote": { section: "salesKnowledge", key: "proposalRules" },
  "d.ag_discovery": { section: "salesKnowledge", key: "discoveryQuestions" },
  "d.sales_process": { section: "acquisitionStrategy", key: "salesFunnel" },
  "d.handoff_requirements": { section: "businessOperations", key: "internalHandoffs" },
  "d.followup": { section: "acquisitionStrategy", key: "followUpStrategy" },
  "d.pricing_policy": { section: "productsServicesOffers", key: "pricingPolicy" },
  "d.pricing_info": { section: "productsServicesOffers", key: "pricing" },
  "d.discount_rules": { section: "productsServicesOffers", key: "discountRules" },
  "d.handoff_rules": { section: "policies", key: "handoffRules" },
  "e.products": { section: "productsServicesOffers", key: "products" },
  "e.faqs": { section: "salesKnowledge", key: "commonQuestions" },
  "e.policies": { section: "policies", key: "customerPolicies" },
  "e.support_info": { section: "businessOperations", key: "supportProcedures" },
  "b.website_need": { section: "productOperations", key: "websitePlan" },
};

/**
 * Builds a structured starting Business Brain from saved questionnaire answers only. Unconfirmed
 * suggestions remain marked as drafts, skipped and unmapped questions are ignored, and no fact
 * is inferred from missing data. File references and presentation assets remain in their own
 * subsystems instead of becoming employee instructions. The caller supplies the answer ledger.
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
    if (!canonical) continue;
    const { section, key } = canonical;
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
