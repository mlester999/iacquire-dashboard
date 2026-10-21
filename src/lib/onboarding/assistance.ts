import { z } from "zod";
import type { Answers, QuestionDef } from "./types";

/** Only these relevant business fields may leave onboarding for writing assistance. */
const identity = ["a.business_name", "a.industry", "a.business_model"];
const overview = [...identity, "a.description", "a.target_customers", "a.location", "a.territories", "b.services", "b.ideal_customer", "b.re_property_types", "b.re_buyers", "b.hc_services", "b.ag_services", "e.products"];
export const ASSISTANCE_FIELDS: Record<string, { facts: string[]; knowledge: string[]; intent: string; ask: string[] }> = {
  "a.description": { facts: overview, knowledge: ["business_description", "products_services"], intent: "Synthesize a coherent business overview: what it does, known services, known customers and relevant operating model. Do not merely concatenate field labels. With only identity facts, write a brief preliminary draft limited to those facts.", ask: ["b.services", "a.target_customers"] },
  "a.website": { facts: [...identity, "a.website"], knowledge: [], intent: "Return only a company URL already supplied as a fact. Never guess a domain or imply external research.", ask: ["a.website"] },
  "a.target_customers": { facts: overview, knowledge: ["business_description"], intent: "Describe confirmed customer groups. Never infer demographics from industry. If unknown, return null.", ask: ["a.target_customers"] },
  "b.ideal_customer": { facts: [...overview, "b.qualification"], knowledge: ["business_description"], intent: "Refine known customer fit and stated needs. Do not invent budgets, demographics or purchasing timelines.", ask: ["a.target_customers", "b.qualification"] },
  "b.qualification": { facts: [...overview, "b.qualification"], knowledge: [], intent: "Express only owner-specified qualification requirements; do not propose new business rules or targets.", ask: ["b.qualification"] },
  "b.services": { facts: overview, knowledge: ["products_services"], intent: "Describe only confirmed services or offers. Do not infer services from industry or add promotions.", ask: ["b.services"] },
  "c.tone": { facts: [...identity, "a.target_customers", "c.tone", "c.language"], knowledge: ["brand_voice"], intent: "Choose a tone only from explicit owner preferences or approved brand voice. Never choose based on stereotypes; return null if no preference is known.", ask: ["c.tone"] },
  "d.sales_process": { facts: [...overview, "b.sales_model", "b.appointments", "d.sales_process"], knowledge: ["customer_service"], intent: "Organize the stated sales steps. Do not invent follow-up promises, discounts, policies or automation permissions.", ask: ["d.sales_process"] },
  "d.pricing_info": { facts: [...identity, "d.pricing_policy", "d.pricing_info"], knowledge: [], intent: "Extract prices only from the supplied website evidence. Do not estimate or infer prices or commitments.", ask: [] },
  "d.handoff_rules": { facts: [...identity, "c.human_escalation", "d.pricing_policy", "d.handoff_rules"], knowledge: ["escalation"], intent: "Draft role-specific handoff wording only from explicit escalation decisions. Do not create new operational policies or grant new capabilities.", ask: ["d.handoff_rules"] },
  "e.products": { facts: overview, knowledge: ["products_services"], intent: "Organize known product/service details and explicit limitations. Do not invent features, benefits or guarantees.", ask: ["b.services", "e.products"] },
  "e.faqs": { facts: identity, knowledge: [], intent: "Extract FAQs and answers only from the supplied website. Do not invent questions or company policies.", ask: [] },
};

export const assistanceRequestSchema = z.object({
  questionId: z.string().max(64),
  clarifications: z.record(z.string().max(64), z.string().trim().max(800)).refine((v) => Object.keys(v).length <= 2).default({}),
  regenerate: z.boolean().default(false),
}).strict();
export type AssistanceOptions = { clarifications?: Record<string, string>; regenerate?: boolean };
export interface Clarification { fieldId: string; label: string; example: string }

export function missingDetails(q: QuestionDef, answers: Answers): Clarification[] {
  const plan = ASSISTANCE_FIELDS[q.id];
  if (!plan) return [];
  const realEstate = answers["a.industry"] === "real_estate";
  return plan.ask.filter((id) => !answers[id] || typeof answers[id] === "string" && !(answers[id] as string).trim()).slice(0, 2).map((id) => ({
    fieldId: id,
    label: id === "b.services" ? "What services do you primarily provide?" : id === "a.target_customers" ? "Who do you primarily help?" : id === "c.tone" ? "How would you like to sound?" : id === "a.website" ? "What is your company website?" : "What details would you like this answer to include?",
    example: id === "b.services" && realEstate ? "Examples only: property sales, rentals, brokerage, property management" : id === "a.target_customers" ? "Describe your actual customers, without guessing." : id === "c.tone" ? "For example: friendly, professional or direct" : "Use only details that are true for your business.",
  }));
}

/** A sparse description cannot introduce content beyond supplied identity facts and neutral prose. */
export function sparseDescriptionIsGrounded(text: string, facts: string[]): boolean {
  const words = (value: string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const neutral = "a an the is are we our us it its and or of for to in on at as with by through both your you their they that this business company customers customer people person local online remote work works working provide provides providing serve serves serving help helps helping operate operates operating from can be offering offers service services across via about focuses focused based primarily";
  const allowed = new Set(words([...facts, neutral].join(" ")));
  return words(text).every((word) => allowed.has(word));
}

/** Generated prose may connect and inflect supplied facts, but must not introduce new content words. */
export function draftUsesProvidedDetails(text: string, facts: string[]): boolean {
  const words = (value: string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const stem = (word: string) => word.replace(/ies$/, "y").replace(/(?:ments?|ing|ed|s)$/, "").replace(/e$/, "");
  const grammar = "a an the is are was were we our us it its and or of for to in on at as with by through both your you their they that this these those business company customer customers people person local online remote work provide serve help operate from can be across via about primarily focus do does what how when where why which who whom have has had will would may if then only also includes include offers offering specializes specialize known needs need team support supports contact contacts questions answers before after each any all no not without more most into whether while together";
  const vocabulary = new Set(words([...facts, grammar].join(" ")).map(stem));
  return words(text).every((word) => vocabulary.has(stem(word)));
}
