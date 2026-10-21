/**
 * Approved iAcquire internal business context.
 *
 * These facts describe the business that owns the internal agency workspace, so Lead Hunter can
 * look for plausible buyers of iAcquireOS. They are a fallback only: a confirmed value already saved
 * in the agency's company profile always wins. No client tenant ever receives this profile.
 *
 * The commercial terms are context, not a promise. Usage and third-party costs follow the actual
 * agreed offer, and the employee must not claim an unfinished or unavailable capability.
 */

export const INTERNAL_BUSINESS = {
  companyName: "iAcquire",
  productName: "iAcquireOS",
  industry: "AI-powered business operations and client acquisition software",
  description:
    "iAcquire provides an AI-powered client acquisition and business operations solution designed to help businesses organize leads, improve response and follow-up processes, coordinate appointments, manage sales activity and use authorized AI Employees to assist with business workflows.",
  services: [
    "iAcquireOS AI-powered business platform",
    "AI-assisted lead and customer acquisition workflows",
    "CRM, pipeline and operational workflow capabilities",
    "Configured AI Employees and their supported integrations",
    "Business automation implementation and onboarding",
    "Optional ongoing managed maintenance where purchased",
  ].join("\n- "),
  idealCustomers:
    "Small and growing service businesses that receive customer inquiries or sales leads; rely on consultations, appointments or follow-ups; manage contacts and opportunities; have repetitive administrative or sales processes; could reasonably benefit from approved AI/automation capabilities; and have relevant business decision-makers reachable through compliant channels.",
  operatingArea: "United States. Canada is available only as an explicitly approved expansion market.",
  commercialContext:
    "$1,499 one-time setup and an optional $299/month managed maintenance plan, subject to the actual agreed offer. Usage and third-party operating costs follow the real applicable terms.",
} as const;

/** Configurable initial prospecting defaults for the internal workspace only. */
export const INTERNAL_PROSPECTING = {
  targetCustomers:
    "Small and growing service businesses that receive customer inquiries or sales leads, rely on consultations, appointments or follow-ups, manage contacts and opportunities, and have repetitive administrative or sales processes that approved AI/automation capabilities could assist with.",
  industries: [
    "Real estate agencies and brokerages",
    "Home services: HVAC, roofing, plumbing, cleaning and remodeling",
    "Marketing and creative agencies",
    "Appointment-driven local service businesses",
  ],
  countries: ["United States"],
  qualification:
    "Require a verified industry and location match and at least one cited public source. Look for public evidence of inquiry, consultation, appointment or follow-up workflows and a plausible fit with the currently deliverable iAcquireOS offering. Do not assume an operational problem, buying intent or decision-maker. Use verified public information only, leave uncertain facts unknown, and check existing CRM records for duplicates.",
  exclusions:
    "No exclusion list has been confirmed for the internal workspace. Ask the requester before excluding an industry, competitor or segment.",
} as const;

export function internalServicesText(): string {
  return `- ${INTERNAL_BUSINESS.services}`;
}

export function internalProspectingText(): string {
  return [
    `Target customers: ${INTERNAL_PROSPECTING.targetCustomers}`,
    `Initial industries (configurable): ${INTERNAL_PROSPECTING.industries.join("; ")}.`,
    `Initial geography (configurable): ${INTERNAL_PROSPECTING.countries.join(", ")}. Canada only when explicitly approved.`,
    `Qualification: ${INTERNAL_PROSPECTING.qualification}`,
    `Exclusions: ${INTERNAL_PROSPECTING.exclusions}`,
    `Commercial context: ${INTERNAL_BUSINESS.commercialContext}`,
    "This is the iAcquire internal workspace's approved prospecting context. A different client workspace must use its own confirmed business context instead.",
  ].join("\n");
}
