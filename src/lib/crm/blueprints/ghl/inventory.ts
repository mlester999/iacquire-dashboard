// GoHighLevel configuration, as read through GoHighLevel's official, documented, read-only API v2, normalized into plain typed records the
// conversion engine (convert.ts) turns into Blueprint assets. Pure: no I/O. The HTTP reader is src/server/crm/blueprints/ghl-read.ts.
//
// Every endpoint, scope, Version header and response key below was checked against the official OpenAPI specs in the GoHighLevel/
// highlevel-api-docs repository (apps/*.json). What the API does NOT expose is stated as a limitation, never guessed:
//   * Smart Lists: no endpoint exists. Snapshots: listing and share links need an agency token, a share link is an install link for
//     another GoHighLevel account (not an export), and nothing returns a snapshot's contents.
//   * Forms, surveys and workflows: only id, name (and a workflow's status) are returned, never questions or steps.
//   * SMS / email snippet templates: GET /locations/{locationId}/templates requires an `originId` query parameter whose meaning is not
//     documented, so iAcquire does not call it (the conversion rules still exist for when it can be read).
//   * Email builder designs and funnels / websites: names only; their content is not exposed.
//
// GoHighLevel record IDs live only in these records (as `id`). The converter keeps them in the import's source_refs (provenance) and never
// in Blueprint content.

export const GHL_API_ORIGIN = "https://services.leadconnectorhq.com" as const;

/** The two documented Version header values used here. Funnel endpoints document none, so none is sent. */
export type GhlApiVersion = "2021-07-28" | "2021-04-15";

/** The locations iAcquire never reads: Aster Homes, and iAcquire's own agency location (which is not a tenant). */
export const GHL_PROTECTED_LOCATIONS = ["u69CVh0ZlAofUmRoj1zF", "SQvVnld5MBHdMQ1qnSfw"] as const;
export const GHL_LOCATION_RE = /^[A-Za-z0-9]{10,40}$/;
export const isProtectedGhlLocation = (locationId: string) => (GHL_PROTECTED_LOCATIONS as readonly string[]).includes(locationId);

export const GHL_KINDS = [
  "pipelines", "tags", "customFields", "customValues", "calendarGroups", "calendars", "forms", "surveys", "workflows", "messageTemplates", "emailDesigns",
  "funnels", "smartLists", "snapshots",
] as const;
export type GhlKind = (typeof GHL_KINDS)[number];

export type GhlPagination = { mode: "none" } | { mode: "skip"; limit: number; maxPages: number } | { mode: "offset"; limit: number; maxPages: number };

export interface GhlEndpoint {
  /** Path on the official host. `{locationId}` is replaced with the encoded location ID. */
  path: string;
  /** Query parameters besides pagination. `{locationId}` is replaced. */
  query: Record<string, string>;
  version: GhlApiVersion | null;
  pagination: GhlPagination;
}

export interface GhlKindInfo {
  label: string;
  /** The read-only scope GoHighLevel documents for the endpoint (docs/oauth/Scopes.md). */
  scope: string | null;
  /** Null: iAcquire does not call any endpoint for this kind (see `limitation`). */
  endpoint: GhlEndpoint | null;
  /** Why nothing (or only part) can be read, in plain words. */
  limitation: string | null;
}

/** The exact reason the SMS / email template endpoint is not called. */
export const GHL_TEMPLATES_UNAVAILABLE =
  "GoHighLevel's templates endpoint (GET /locations/{locationId}/templates) requires an originId parameter that its API documentation doesn't explain, so iAcquire doesn't call it. Recreate SMS and email templates in iAcquire, or start from a Blueprint starter's wording.";

export const GHL_KIND_INFO: Record<GhlKind, GhlKindInfo> = {
  pipelines: {
    label: "Pipelines & stages", scope: "opportunities.readonly",
    endpoint: { path: "/opportunities/pipelines", query: { locationId: "{locationId}" }, version: "2021-07-28", pagination: { mode: "none" } },
    limitation: null,
  },
  tags: {
    label: "Tags", scope: "locations/tags.readonly",
    endpoint: { path: "/locations/{locationId}/tags", query: {}, version: "2021-07-28", pagination: { mode: "none" } },
    limitation: null,
  },
  customFields: {
    label: "Custom fields", scope: "locations/customFields.readonly",
    endpoint: { path: "/locations/{locationId}/customFields", query: { model: "all" }, version: "2021-07-28", pagination: { mode: "none" } },
    limitation: null,
  },
  customValues: {
    label: "Custom values", scope: "locations/customValues.readonly",
    endpoint: { path: "/locations/{locationId}/customValues", query: {}, version: "2021-07-28", pagination: { mode: "none" } },
    limitation: null,
  },
  calendarGroups: {
    label: "Calendar groups", scope: "calendars/groups.readonly",
    endpoint: { path: "/calendars/groups", query: { locationId: "{locationId}" }, version: "2021-04-15", pagination: { mode: "none" } },
    limitation: null,
  },
  calendars: {
    label: "Calendars", scope: "calendars.readonly",
    endpoint: { path: "/calendars/", query: { locationId: "{locationId}" }, version: "2021-04-15", pagination: { mode: "none" } },
    limitation: null,
  },
  forms: {
    label: "Forms", scope: "forms.readonly",
    endpoint: { path: "/forms/", query: { locationId: "{locationId}" }, version: "2021-07-28", pagination: { mode: "skip", limit: 50, maxPages: 20 } },
    limitation: "GoHighLevel's API returns only each form's name, never its questions, layout or settings.",
  },
  surveys: {
    label: "Surveys", scope: "surveys.readonly",
    endpoint: { path: "/surveys/", query: { locationId: "{locationId}" }, version: "2021-07-28", pagination: { mode: "skip", limit: 50, maxPages: 20 } },
    limitation: "GoHighLevel's API returns only each survey's name, never its questions or logic.",
  },
  workflows: {
    label: "Workflows", scope: "workflows.readonly",
    endpoint: { path: "/workflows/", query: { locationId: "{locationId}" }, version: "2021-07-28", pagination: { mode: "none" } },
    limitation: "GoHighLevel's API returns only each workflow's name and status, never its triggers, actions or steps.",
  },
  messageTemplates: { label: "SMS & email templates", scope: "locations/templates.readonly", endpoint: null, limitation: GHL_TEMPLATES_UNAVAILABLE },
  emailDesigns: {
    label: "Email builder designs", scope: "emails/builder.readonly",
    endpoint: { path: "/emails/builder", query: { locationId: "{locationId}" }, version: "2021-07-28", pagination: { mode: "offset", limit: 25, maxPages: 8 } },
    limitation: "GoHighLevel's API returns only each email design's name and a preview link, never its content.",
  },
  funnels: {
    label: "Funnels & websites", scope: "funnels/funnel.readonly",
    endpoint: { path: "/funnels/funnel/list", query: { locationId: "{locationId}" }, version: null, pagination: { mode: "offset", limit: 25, maxPages: 8 } },
    limitation: "GoHighLevel's API returns funnel and website names and their steps, never page content. They are listed as Website Studio rebuild candidates; nothing is published.",
  },
  smartLists: {
    label: "Smart Lists", scope: null, endpoint: null,
    limitation: "Smart Lists can't be read: GoHighLevel's API has no Smart List endpoint. Rebuild them in iAcquire (Contacts → Smart Lists) or start from a Blueprint starter.",
  },
  snapshots: {
    label: "Snapshots", scope: null, endpoint: null,
    limitation:
      "GoHighLevel snapshots can't be exported. A snapshot share link installs the snapshot into another GoHighLevel account; it is not a file, and no API returns what a snapshot contains. Install the snapshot into a template sub-account and import from that sub-account instead.",
  },
};

/** The order the reader reads kinds in (groups before calendars, so folders exist for them). */
export const GHL_READ_ORDER: readonly GhlKind[] = ["pipelines", "tags", "customFields", "customValues", "calendarGroups", "calendars", "forms", "surveys", "workflows", "emailDesigns", "funnels"];

/** Every read scope an import uses: the identity check plus each readable kind's scope. Shown as "missing" when a source lacks one. */
export const GHL_IMPORT_SCOPES: readonly string[] = ["locations.readonly", ...GHL_READ_ORDER.map((k) => GHL_KIND_INFO[k].scope!).filter(Boolean)];

// ---------------------------------------------------------------------------
// Normalized records
// ---------------------------------------------------------------------------

export interface GhlStage { id: string; name: string; position: number }
export interface GhlPipeline { id: string; name: string; stages: GhlStage[] }
export interface GhlTag { id: string; name: string }
export interface GhlCustomField {
  id: string;
  name: string;
  /** "contact.pincode". */
  fieldKey: string;
  /** Upper-cased GoHighLevel data type ("TEXT", "SINGLE_OPTIONS" …). */
  dataType: string;
  model: "contact" | "opportunity" | null;
  placeholder: string | null;
  position: number;
  options: string[];
  imageOptions: number;
  allowCustomOption: boolean;
}
export interface GhlCustomValue {
  id: string;
  name: string;
  /** "{{ custom_values.custom_field }}". */
  fieldKey: string;
  /** The stored value. Held in memory only; the converter copies it only when asked to and when it is safe. */
  value: string | null;
}
export interface GhlCalendarGroup { id: string; name: string; description: string | null; isActive: boolean }
export interface GhlHoursRange { openHour: number; openMinute: number; closeHour: number; closeMinute: number }
export interface GhlOpenHours { days: number[]; hours: GhlHoursRange[] }
export interface GhlLocationConfig { kind: string; location: string | null }
export interface GhlTeamMember { userId: string; priority: number | null; isPrimary: boolean; locations: GhlLocationConfig[] }
export interface GhlCalendar {
  id: string;
  name: string;
  description: string | null;
  /** round_robin, event, class_booking, collective, service_booking, personal (or what GoHighLevel sent). */
  calendarType: string;
  eventType: string | null;
  groupId: string | null;
  isActive: boolean;
  teamMembers: GhlTeamMember[];
  locations: GhlLocationConfig[];
  /** In minutes (units already applied). */
  slotDuration: number | null;
  slotInterval: number | null;
  slotBuffer: number | null;
  preBuffer: number | null;
  appointmentsPerSlot: number | null;
  appointmentsPerDay: number | null;
  /** Minimum notice in minutes. */
  allowBookingAfter: number | null;
  /** How far ahead, in days. */
  allowBookingFor: number | null;
  openHours: GhlOpenHours[];
  /** 0: weekly open hours. 1: custom (date-specific) availability. */
  availabilityType: number | null;
  dateAvailabilities: number;
  enableRecurring: boolean;
  formId: string | null;
  autoConfirm: boolean | null;
  allowReschedule: boolean | null;
  allowCancellation: boolean | null;
  formSubmitType: string | null;
  thanksMessage: string | null;
  eventColor: string | null;
  /** Options iAcquire doesn't carry, by name, for the report ("sticky contact", "tracking pixel" …). */
  dropped: string[];
}
export interface GhlForm { id: string; name: string }
export interface GhlSurvey { id: string; name: string }
export interface GhlWorkflow { id: string; name: string; status: string | null }
export interface GhlMessageTemplate {
  id: string;
  name: string;
  type: "sms" | "email" | "whatsapp" | "other";
  body: string | null;
  subject: string | null;
  html: string | null;
  attachments: number;
}
export interface GhlEmailDesign { id: string; name: string; templateType: string | null }
export interface GhlFunnel { id: string; name: string; type: string | null; steps: number }

export interface GhlRecordMap {
  pipelines: GhlPipeline;
  tags: GhlTag;
  customFields: GhlCustomField;
  customValues: GhlCustomValue;
  calendarGroups: GhlCalendarGroup;
  calendars: GhlCalendar;
  forms: GhlForm;
  surveys: GhlSurvey;
  workflows: GhlWorkflow;
  messageTemplates: GhlMessageTemplate;
  emailDesigns: GhlEmailDesign;
  funnels: GhlFunnel;
  smartLists: never;
  snapshots: never;
}

export type GhlKindStatus = "ok" | "forbidden" | "unavailable" | "error";

/** What happened when one kind was read. One kind failing never fails the import. */
export interface GhlKindResult {
  kind: GhlKind;
  status: GhlKindStatus;
  /** Plain-language reason when not ok. Never contains a token or a raw response. */
  reason: string | null;
  count: number;
  /** More existed than the bounded pagination read. */
  truncated: boolean;
  /** Rows that named another location and were ignored. */
  droppedForeign: number;
  /** Rows without an id or name, ignored. */
  malformed: number;
}

export interface GhlInventory {
  locationId: string;
  /** From the verified identity response. */
  locationName: string | null;
  /** IANA time zone of the location, when GoHighLevel reported a valid one. */
  timezone: string | null;
  kinds: Record<GhlKind, GhlKindResult>;
  pipelines: GhlPipeline[];
  tags: GhlTag[];
  customFields: GhlCustomField[];
  customValues: GhlCustomValue[];
  calendarGroups: GhlCalendarGroup[];
  calendars: GhlCalendar[];
  forms: GhlForm[];
  surveys: GhlSurvey[];
  workflows: GhlWorkflow[];
  messageTemplates: GhlMessageTemplate[];
  emailDesigns: GhlEmailDesign[];
  funnels: GhlFunnel[];
}

export type GhlRecordKind = Exclude<GhlKind, "smartLists" | "snapshots">;

/** An inventory with nothing read yet: every kind starts as "unavailable" with its limitation (or "not read"). */
export function emptyGhlInventory(locationId: string, opts: { locationName?: string | null; timezone?: string | null } = {}): GhlInventory {
  const kinds = Object.fromEntries(GHL_KINDS.map((k) => [k, {
    kind: k, status: "unavailable", reason: GHL_KIND_INFO[k].endpoint ? "Not read." : GHL_KIND_INFO[k].limitation, count: 0, truncated: false, droppedForeign: 0, malformed: 0,
  } satisfies GhlKindResult])) as Record<GhlKind, GhlKindResult>;
  return {
    locationId, locationName: opts.locationName ?? null, timezone: opts.timezone ?? null, kinds,
    pipelines: [], tags: [], customFields: [], customValues: [], calendarGroups: [], calendars: [], forms: [], surveys: [], workflows: [], messageTemplates: [],
    emailDesigns: [], funnels: [],
  };
}

// ---------------------------------------------------------------------------
// Normalizers: one documented response page → typed records
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((x): x is Row => !!x && typeof x === "object" && !Array.isArray(x)) : []);
const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Where each kind's list lives in the documented response body. */
const RESPONSE_KEY: Record<GhlRecordKind, string> = {
  pipelines: "pipelines", tags: "tags", customFields: "customFields", customValues: "customValues", calendarGroups: "groups", calendars: "calendars", forms: "forms",
  surveys: "surveys", workflows: "workflows", messageTemplates: "templates", emailDesigns: "builders", funnels: "funnels",
};

/** The list of rows a response holds, or null when the body doesn't have the documented shape. */
function listOf(kind: GhlRecordKind, body: Row): Row[] | null {
  const v = body[RESPONSE_KEY[kind]];
  if (Array.isArray(v)) return rows(v);
  // Two endpoints are documented with an object where a list is expected: /funnels/funnel/list types `funnels` as one object (its example is
  // a single funnel), and /emails/builder declares the response as a single design. Accept exactly those documented shapes as one row.
  if (kind === "funnels" && v && typeof v === "object") return [v as Row];
  if (kind === "emailDesigns") {
    if (Array.isArray(body.templates)) return rows(body.templates);
    if (typeof body.id === "string" && typeof body.name === "string") return [body];
  }
  return null;
}

/** The total a paginated response reports, when it reports one. */
export function pageTotal(kind: GhlRecordKind, body: Row): number | null {
  if (kind === "forms" || kind === "surveys") return num(body.total);
  if (kind === "funnels") return num(body.count);
  if (kind === "messageTemplates") return num(body.totalCount);
  if (kind === "emailDesigns") return num(body.total) ?? num(body.count);
  return null;
}

const MINUTES: Record<string, number> = { mins: 1, min: 1, minutes: 1, hours: 60, hour: 60, days: 1440, day: 1440, weeks: 10080, week: 10080, months: 43200, month: 43200 };
function minutes(value: unknown, unit: unknown, fallbackUnit = "mins"): number | null {
  const n = num(value);
  if (n === null || n < 0) return null;
  const factor = MINUTES[typeof unit === "string" ? unit.toLowerCase() : fallbackUnit] ?? MINUTES[fallbackUnit];
  return Math.round(n * factor);
}

function locationConfigs(v: unknown): GhlLocationConfig[] {
  return rows(v).flatMap((c) => {
    const kind = str(c.kind, 40);
    return kind ? [{ kind, location: str(c.location, 500) }] : [];
  });
}

const DROPPED_CALENDAR_OPTIONS: Array<[string, string]> = [
  ["stickyContact", "sticky contact"], ["lookBusyConfig", "look-busy"], ["pixelId", "tracking pixel"], ["notifications", "calendar notifications"],
  ["consentLabel", "consent label"], ["guestType", "guest settings"], ["shouldAssignContactToTeamMember", "assign the contact to the host"],
  ["widgetType", "widget style"], ["calendarCoverImage", "cover image"], ["notes", "appointment notes template"], ["eventTitle", "appointment title template"],
];

function normalizeCalendar(r: Row): GhlCalendar {
  const dropped: string[] = [];
  for (const [key, label] of DROPPED_CALENDAR_OPTIONS) {
    const v = r[key];
    if (v === true || (typeof v === "string" && v.trim()) || (Array.isArray(v) && v.length) || (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).some((x) => x === true))) dropped.push(label);
  }
  const openHours = rows(r.openHours).map((o): GhlOpenHours => ({
    days: (Array.isArray(o.daysOfTheWeek) ? o.daysOfTheWeek : []).map(num).filter((d): d is number => d !== null && Number.isInteger(d) && d >= 0 && d <= 6),
    hours: rows(o.hours).flatMap((h) => {
      const openHour = num(h.openHour), openMinute = num(h.openMinute), closeHour = num(h.closeHour), closeMinute = num(h.closeMinute);
      return openHour === null || closeHour === null ? [] : [{ openHour, openMinute: openMinute ?? 0, closeHour, closeMinute: closeMinute ?? 0 }];
    }),
  }));
  return {
    id: str(r.id, 80)!,
    name: str(r.name, 200)!,
    description: str(r.description, 2000),
    calendarType: str(r.calendarType, 40) ?? "event",
    eventType: str(r.eventType, 80),
    groupId: str(r.groupId, 80),
    isActive: r.isActive !== false,
    teamMembers: rows(r.teamMembers).flatMap((m) => {
      const userId = str(m.userId, 80);
      return userId ? [{ userId, priority: num(m.priority), isPrimary: m.isPrimary === true, locations: locationConfigs(m.locationConfigurations) }] : [];
    }),
    locations: locationConfigs(r.locationConfigurations),
    slotDuration: minutes(r.slotDuration, r.slotDurationUnit),
    slotInterval: minutes(r.slotInterval, r.slotIntervalUnit),
    slotBuffer: minutes(r.slotBuffer, r.slotBufferUnit),
    preBuffer: minutes(r.preBuffer, r.preBufferUnit),
    appointmentsPerSlot: num(r.appoinmentPerSlot),
    appointmentsPerDay: num(r.appoinmentPerDay),
    allowBookingAfter: minutes(r.allowBookingAfter, r.allowBookingAfterUnit, "hours"),
    allowBookingFor: (() => {
      const m = minutes(r.allowBookingFor, r.allowBookingForUnit, "days");
      return m === null ? null : Math.round(m / 1440);
    })(),
    openHours,
    availabilityType: num(r.availabilityType),
    dateAvailabilities: rows(r.availabilities).filter((a) => a.deleted !== true).length,
    enableRecurring: r.enableRecurring === true,
    formId: str(r.formId, 80),
    autoConfirm: bool(r.autoConfirm),
    allowReschedule: bool(r.allowReschedule),
    allowCancellation: bool(r.allowCancellation),
    formSubmitType: str(r.formSubmitType, 40),
    thanksMessage: str(r.formSubmitThanksMessage, 2000),
    eventColor: str(r.eventColor, 20),
    dropped,
  };
}

function normalizeRow(kind: GhlRecordKind, r: Row): GhlRecordMap[GhlRecordKind] | null {
  const id = str(kind === "funnels" ? (r._id ?? r.id) : r.id, 80);
  const name = str(r.name, 200);
  if (!id || !name) return null;
  switch (kind) {
    case "pipelines":
      return {
        id, name,
        stages: rows(r.stages).flatMap((s, i) => {
          const sid = str(s.id, 80), sname = str(s.name, 200);
          return sid && sname ? [{ id: sid, name: sname, position: num(s.position) ?? i }] : [];
        }),
      };
    case "tags":
      return { id, name };
    case "customFields": {
      const model = r.model === "contact" || r.model === "opportunity" ? r.model : null;
      const options = (Array.isArray(r.picklistOptions) ? r.picklistOptions : [])
        .map((o) => (typeof o === "string" ? o : o && typeof o === "object" ? (o as Row).label ?? (o as Row).key : null))
        .map((o) => str(o, 200))
        .filter((o): o is string => o !== null);
      return {
        id, name, fieldKey: str(r.fieldKey, 120) ?? "", dataType: (str(r.dataType, 40) ?? "TEXT").toUpperCase(), model, placeholder: str(r.placeholder, 500),
        position: num(r.position) ?? 0, options, imageOptions: Array.isArray(r.picklistImageOptions) ? r.picklistImageOptions.length : 0,
        allowCustomOption: r.isAllowedCustomOption === true,
      };
    }
    case "customValues":
      return { id, name, fieldKey: str(r.fieldKey, 200) ?? "", value: typeof r.value === "string" ? r.value.slice(0, 5000) : null };
    case "calendarGroups":
      return { id, name, description: str(r.description, 1000), isActive: r.isActive !== false };
    case "calendars":
      return normalizeCalendar(r);
    case "forms":
    case "surveys":
      return { id, name };
    case "workflows":
      return { id, name, status: str(r.status, 40) };
    case "messageTemplates": {
      const t = r.template && typeof r.template === "object" && !Array.isArray(r.template) ? (r.template as Row) : {};
      const type = r.type === "sms" || r.type === "email" || r.type === "whatsapp" ? r.type : "other";
      const attachments = (Array.isArray(t.attachments) ? t.attachments.length : 0) + (Array.isArray(r.urlAttachments) ? r.urlAttachments.length : 0);
      return { id, name, type, body: typeof t.body === "string" ? t.body.slice(0, 20000) : null, subject: str(t.subject, 1000), html: typeof t.html === "string" ? t.html.slice(0, 200000) : null, attachments };
    }
    case "emailDesigns":
      return { id, name, templateType: str(r.templateType, 40) };
    case "funnels":
      return { id, name, type: str(r.type, 40), steps: Array.isArray(r.steps) ? r.steps.length : 0 };
  }
}

export interface NormalizedPage<K extends GhlRecordKind> {
  /** Null when the body doesn't have the documented shape. */
  records: Array<GhlRecordMap[K]> | null;
  /** Raw rows in the page (before anything was dropped), for pagination. */
  rawCount: number;
  droppedForeign: number;
  malformed: number;
  total: number | null;
}

/**
 * Normalizes one response page. Rows that name another location (locationId / location_id) are dropped and counted, never kept: a
 * response can only ever contribute the verified location's own configuration. Rows without an id or a name are dropped too.
 */
export function normalizeGhlPage<K extends GhlRecordKind>(kind: K, body: Record<string, unknown>, locationId: string): NormalizedPage<K> {
  const list = listOf(kind, body);
  if (!list) return { records: null, rawCount: 0, droppedForeign: 0, malformed: 0, total: null };
  let droppedForeign = 0;
  let malformed = 0;
  const records: Array<GhlRecordMap[K]> = [];
  for (const r of list) {
    const owner = typeof r.locationId === "string" ? r.locationId : typeof r.location_id === "string" ? r.location_id : null;
    if (owner !== null && owner !== locationId) {
      droppedForeign++;
      continue;
    }
    const rec = normalizeRow(kind, r);
    if (!rec) malformed++;
    else records.push(rec as GhlRecordMap[K]);
  }
  return { records, rawCount: list.length, droppedForeign, malformed, total: pageTotal(kind, body) };
}

/** The verified location's name and time zone from GET /locations/{locationId}, or null when the body names another location. */
export function normalizeGhlLocation(body: Record<string, unknown>, locationId: string): { name: string | null; timezone: string | null } | null {
  const loc = body.location && typeof body.location === "object" && !Array.isArray(body.location) ? (body.location as Row) : null;
  if (!loc || loc.id !== locationId) return null;
  const tz = str(loc.timezone, 64) ?? str((loc.business as Row | undefined)?.timezone, 64);
  return { name: str(loc.name, 200), timezone: tz && isIanaZone(tz) ? tz : null };
}

function isIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return /\//.test(tz) || tz === "UTC";
  } catch {
    return false;
  }
}
