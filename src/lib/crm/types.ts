// Shared Native CRM vocabulary for the server and the interface. No I/O here.

export const CRM_MODES = ["native", "ghl", "hybrid"] as const;
export type CrmMode = (typeof CRM_MODES)[number];
export const CRM_MODE_LABELS: Record<CrmMode, { label: string; description: string }> = {
  native: { label: "iAcquire CRM", description: "Your contacts, pipelines, calendars, conversations and automations live in iAcquire. No GoHighLevel account is needed." },
  ghl: { label: "GoHighLevel", description: "GoHighLevel stays your system of record. iAcquire reads from your connected location." },
  hybrid: { label: "Controlled hybrid", description: "Each capability has exactly one owner, so two systems never both act on the same record. Used while migrating." },
};

/** Capabilities a provider can own. Each has exactly one owner per workspace. */
export const CRM_CAPABILITIES = ["contacts", "companies", "tags", "custom_fields", "pipelines", "opportunities", "calendars", "appointments", "conversations", "workflows", "reporting"] as const;
export type CrmCapability = (typeof CRM_CAPABILITIES)[number];
export type CapabilityProvider = "native" | "ghl";
export const CAPABILITY_LABELS: Record<CrmCapability, string> = {
  contacts: "Contacts",
  companies: "Companies",
  tags: "Tags",
  custom_fields: "Custom fields",
  pipelines: "Pipelines",
  opportunities: "Opportunities",
  calendars: "Calendars",
  appointments: "Appointments",
  conversations: "Conversations",
  workflows: "Automations",
  reporting: "Reporting",
};

export const LEAD_STATUSES = ["new", "open", "contacted", "qualified", "unqualified", "customer", "inactive"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  open: "Open",
  contacted: "Contacted",
  qualified: "Qualified",
  unqualified: "Not a fit",
  customer: "Customer",
  inactive: "Inactive",
};
export const LEAD_STATUS_TONES: Record<LeadStatus, "neutral" | "primary" | "success" | "warning" | "danger"> = {
  new: "primary",
  open: "primary",
  contacted: "neutral",
  qualified: "success",
  unqualified: "neutral",
  customer: "success",
  inactive: "warning",
};

export const PREFERRED_CHANNELS = ["email", "sms", "whatsapp", "phone"] as const;
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number];
export const PREFERRED_CHANNEL_LABELS: Record<PreferredChannel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp", phone: "Phone call" };

export const CREATED_VIA = ["inbound_message", "manual", "import", "website_form", "form", "booking", "api", "agent", "workflow", "ghl_migration", "call"] as const;
export type CreatedVia = (typeof CREATED_VIA)[number];
export const CREATED_VIA_LABELS: Record<CreatedVia, string> = {
  inbound_message: "Inbound message",
  manual: "Added by hand",
  import: "Import",
  website_form: "Website form",
  form: "Form",
  booking: "Booking page",
  api: "API",
  agent: "AI employee",
  workflow: "Automation",
  ghl_migration: "GoHighLevel migration",
  call: "Phone call",
};

export const FIELD_TYPES = ["text", "textarea", "number", "currency", "date", "datetime", "boolean", "select", "multiselect", "email", "phone", "url"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  textarea: "Multi-line text",
  number: "Number",
  currency: "Currency",
  date: "Date",
  datetime: "Date and time",
  boolean: "Yes / no",
  select: "Single choice",
  multiselect: "Multiple choice",
  email: "Email",
  phone: "Phone",
  url: "Web address",
};

export const FIELD_ENTITIES = ["contact", "company", "opportunity"] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];

export const FOLDER_KINDS = ["smart_list", "tag", "template", "workflow", "form", "calendar", "report", "campaign"] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

export const TAG_COLORS = ["#64748b", "#2563eb", "#0891b2", "#059669", "#65a30d", "#ca8a04", "#ea580c", "#dc2626", "#db2777", "#7c3aed"] as const;

export type ActorKind = "user" | "agency" | "agent" | "system" | "api" | "contact";

/** Display name from parts, never inventing one. */
export function composeDisplayName(first?: string | null, last?: string | null, fallback?: string | null): string {
  const joined = [first?.trim(), last?.trim()].filter(Boolean).join(" ");
  return (joined || fallback?.trim() || "").slice(0, 200);
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
