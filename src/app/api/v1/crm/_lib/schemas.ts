import "server-only";
import { z } from "zod";
import { LEAD_STATUSES, PREFERRED_CHANNELS } from "@/lib/crm/types";
import type { ContactInput, ContactPatch } from "@/server/crm/contacts";
import type { OpportunityInput } from "@/server/crm/opportunities";

// Request bodies of the public CRM API. Schemas are strict: an unknown field is an error, so a typo never silently does nothing. Values are
// then normalized and validated again by the CRM services themselves (emails, phone numbers with the workspace's calling code, duplicates).

const text = (max: number) => z.string().max(max, `Use at most ${max} characters.`).nullable().optional();

const address = z.object({ line1: text(200), line2: text(200), city: text(100), region: text(100), postalCode: text(20), country: text(2) }).strict();

const contactFields = {
  firstName: text(100),
  lastName: text(100),
  displayName: text(200),
  email: text(320),
  phone: text(40),
  address: address.optional(),
  timezone: text(64),
  preferredLanguage: text(35),
  preferredChannel: z.enum(PREFERRED_CHANNELS).nullable().optional(),
  source: text(60),
  leadStatus: z.enum(LEAD_STATUSES).optional(),
  leadScore: z.number().int("leadScore must be a whole number.").min(0).max(100).nullable().optional(),
};

export const contactCreateSchema = z
  .object({
    ...contactFields,
    emails: z.array(z.string().max(320)).max(10, "Send at most 10 extra email addresses.").optional(),
    phones: z.array(z.string().max(40)).max(10, "Send at most 10 extra phone numbers.").optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20, "Send at most 20 tags.").optional(),
  })
  .strict();

export const contactUpdateSchema = z
  .object({ ...contactFields, version: z.number().int().min(1).optional() })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "version"), "Send at least one field to change.");

function addressFields(a: z.infer<typeof address> | undefined) {
  if (!a) return {};
  const out: Partial<ContactInput> = {};
  if ("line1" in a) out.addressLine1 = a.line1 ?? null;
  if ("line2" in a) out.addressLine2 = a.line2 ?? null;
  if ("city" in a) out.city = a.city ?? null;
  if ("region" in a) out.region = a.region ?? null;
  if ("postalCode" in a) out.postalCode = a.postalCode ?? null;
  if ("country" in a) out.country = a.country ?? null;
  return out;
}

export function toContactInput(b: z.infer<typeof contactCreateSchema>, tagIds: string[]): ContactInput {
  return {
    firstName: b.firstName, lastName: b.lastName, displayName: b.displayName, email: b.email, phone: b.phone, emails: b.emails, phones: b.phones, ...addressFields(b.address),
    timezone: b.timezone, preferredLanguage: b.preferredLanguage, preferredChannel: b.preferredChannel, source: b.source, leadStatus: b.leadStatus, leadScore: b.leadScore,
    tagIds: tagIds.length ? tagIds : undefined,
  };
}

/** Only the fields the caller sent are changed; null clears a field. */
export function toContactPatch(b: z.infer<typeof contactUpdateSchema>): ContactPatch {
  const patch: ContactPatch = {};
  for (const k of ["firstName", "lastName", "displayName", "email", "phone", "timezone", "preferredLanguage", "preferredChannel", "source", "leadStatus", "leadScore"] as const) {
    if (k in b) (patch as Record<string, unknown>)[k] = b[k] ?? null;
  }
  Object.assign(patch, addressFields(b.address));
  return patch;
}

export const tagChangeSchema = z
  .object({
    add: z.array(z.string().trim().min(1).max(60)).max(20, "Add at most 20 tags at once.").optional(),
    remove: z.array(z.string().trim().min(1).max(60)).max(20, "Remove at most 20 tags at once.").optional(),
  })
  .strict()
  .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, "Send tags to add or remove.");

const uuid = z.string().uuid("Use the id the API returned.");

export const opportunityCreateSchema = z
  .object({
    name: z.string().trim().min(1, "Give the deal a name.").max(200),
    pipelineId: uuid.optional(),
    stageId: uuid.optional(),
    contactId: uuid.nullable().optional(),
    companyId: uuid.nullable().optional(),
    value: z.number().min(0).max(999_999_999_999).nullable().optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code.").optional(),
    expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-30.").nullable().optional(),
    probability: z.number().int().min(0).max(100).nullable().optional(),
    source: text(120),
    description: text(2000),
  })
  .strict();

export function toOpportunityInput(b: z.infer<typeof opportunityCreateSchema>): OpportunityInput {
  return {
    name: b.name, pipelineId: b.pipelineId ?? null, stageId: b.stageId ?? null, contactId: b.contactId ?? null, companyId: b.companyId ?? null, value: b.value ?? null,
    currency: b.currency ?? null, expectedCloseDate: b.expectedCloseDate ?? null, probability: b.probability ?? null, source: b.source ?? null, description: b.description ?? null,
  };
}

export const stageMoveSchema = z
  .object({ stageId: uuid, lostReason: text(300), version: z.number().int().min(1).optional() })
  .strict();

export const OPPORTUNITY_STATUSES = ["open", "won", "lost"] as const;
export const APPOINTMENT_STATUSES = ["new", "confirmed", "showed", "no_show", "cancelled"] as const;
