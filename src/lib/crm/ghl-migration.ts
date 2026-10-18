// What a GoHighLevel live-record migration moves, in what order, and what it says about each record. Shared by the server
// (src/server/crm/ghl-migration.ts, src/server/crm/imports.ts) and the migration panel, so nothing here may import server code.

/** The migration steps, in the order they must be imported. Each step is one import job (source 'ghl_api'). */
export const GHL_MIGRATION_ENTITIES = ["custom_field", "tag", "pipeline", "company", "contact", "opportunity"] as const;
export type GhlMigrationEntity = (typeof GHL_MIGRATION_ENTITIES)[number];

export const GHL_ENTITY_LABELS: Record<GhlMigrationEntity, { one: string; many: string }> = {
  custom_field: { one: "custom field", many: "Custom fields" },
  tag: { one: "tag", many: "Tags" },
  pipeline: { one: "pipeline", many: "Pipelines and stages" },
  company: { one: "company", many: "Companies (GoHighLevel businesses)" },
  contact: { one: "contact", many: "Contacts" },
  opportunity: { one: "opportunity", many: "Opportunities" },
};

/** A step imports only after these steps finished importing (their records must exist so references resolve). */
export const GHL_PREREQUISITES: Record<GhlMigrationEntity, readonly GhlMigrationEntity[]> = {
  custom_field: [],
  tag: [],
  pipeline: [],
  company: [],
  contact: ["custom_field", "tag"],
  opportunity: ["custom_field", "pipeline", "contact"],
};

/** Steps that, when they were started, must have finished first (contacts link to the companies imported before them). */
export const GHL_OPTIONAL_PREREQUISITES: Record<GhlMigrationEntity, readonly GhlMigrationEntity[]> = {
  custom_field: [],
  tag: [],
  pipeline: [],
  company: [],
  contact: ["company"],
  opportunity: [],
};

/** A step can be undone only after the steps that point at its records were undone (undo runs in reverse order). */
export function ghlDependentsOf(entity: GhlMigrationEntity): GhlMigrationEntity[] {
  return GHL_MIGRATION_ENTITIES.filter((e) => GHL_PREREQUISITES[e].includes(entity) || GHL_OPTIONAL_PREREQUISITES[e].includes(entity));
}

export const isGhlMigrationEntity = (v: unknown): v is GhlMigrationEntity => typeof v === "string" && (GHL_MIGRATION_ENTITIES as readonly string[]).includes(v);

/** Notes a staged row can carry. Counted in each job's summary and shown in the gap report. */
export const IMPORT_FLAG_LABELS: Record<string, string> = {
  owner_unmapped: "Owner in GoHighLevel isn't a member of this workspace (left unassigned)",
  field_unmapped: "Custom field value whose field wasn't migrated",
  field_value_dropped: "Custom field value that doesn't fit the field's type (left out)",
  email_dropped: "Email address that isn't valid (left out)",
  phone_dropped: "Phone number without a country code (left out)",
  country_dropped: "Country that isn't a recognized country (left out)",
  timezone_dropped: "Time zone that isn't valid (left out)",
  website_dropped: "Website that isn't a valid address (left out)",
  name_truncated: "Name longer than iAcquire allows (shortened)",
  status_unknown: "Status GoHighLevel didn't document (imported as open)",
  abandoned_as_lost: "Abandoned in GoHighLevel (recorded as lost, reason kept)",
  dnd: "Do not disturb in GoHighLevel (kept as an opt-out)",
  duplicate_in_source: "Same email or phone as another GoHighLevel contact (held for review)",
  company_by_name: "Company linked by name (no GoHighLevel business id)",
  unsupported_type: "Field type iAcquire doesn't support (not created)",
  unsupported_object: "Custom object field (custom objects aren't migrated)",
  too_large: "Record too large to stage in full (custom field values left out)",
  detail_unavailable: "GoHighLevel couldn't return the full contact record (its name or phone may be missing)",
  name_phone_missing: "No name or phone came across from GoHighLevel",
};

/** What a migration does not bring across, and why. Shown in the panel and the gap report; never hidden. */
export const GHL_NOT_MIGRATED: ReadonlyArray<{ what: string; why: string }> = [
  { what: "Conversations and message history", why: "Moved by the inbox, not by this migration. Messages are never sent or re-sent by a migration." },
  { what: "Notes and tasks on contacts", why: "GoHighLevel only lists them one contact at a time; they aren't part of this migration yet." },
  { what: "Appointments and calendars", why: "Calendars are connected natively (Settings → Calendars). Past GoHighLevel appointments are not copied." },
  { what: "Workflows, campaigns, forms, surveys and funnels", why: "GoHighLevel's API exposes names only, not their steps. Rebuild them natively or apply a Blueprint." },
  { what: "Smart lists", why: "GoHighLevel has no API for them." },
  { what: "File upload and signature custom fields, and custom objects", why: "iAcquire has no matching field type; the fields are listed as unsupported." },
  { what: "Contact website, date of birth and attribution", why: "No native contact field holds them. Create a custom field and re-run the contacts step if you need them." },
  { what: "Lost reasons", why: "GoHighLevel returns an id only; lost deals are imported with the reason \"Lost in GoHighLevel\"." },
];
