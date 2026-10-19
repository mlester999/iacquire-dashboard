// Client-facing integration cards, derived only from the workspace's CRM ownership and real recorded state.
// Pure (no I/O): the Integrations page and its tests derive the same cards.
//
// Native-first rule: a workspace on iAcquire CRM sees iAcquire CRM and iAcquire Calendar as its own tools. GoHighLevel
// appears only when that workspace owns a GoHighLevel capability or has a recorded GoHighLevel check, and the page offers
// it as an optional add-on otherwise. Nothing here claims a connection that was not recorded.
import type { CapabilityProvider, CrmMode } from "@/lib/crm/types";

export interface ClientCardStatus {
  provider: string;
  status: string;
  detail: string | null;
  last_checked_at: string | null;
}

export interface ClientIntegrationCard {
  key: string;
  name: string;
  body: string;
  fact?: string;
  status?: ClientCardStatus;
  /** Replaces the generic status label where "Connected" would overstate a built-in tool or a draft. */
  statusLabel?: string;
  /** The footer evidence, replacing "Managed by iAcquire" / "Service check passed". */
  check?: string;
  link?: { href: string; label: string };
}

export interface ClientCrmCounts {
  contacts: number;
  pipelines: number;
  activeCalendars: number;
  connectedCalendars: number;
  enabledChannels: number;
  testedChannels: number;
  activeWorkflows: number;
}

export interface ClientGhlFacts {
  locationName: string | null;
  mappingStatus: string | null;
  verifiedAt: string | null;
  crmCheck: ClientCardStatus | null;
  calendarCheck: ClientCardStatus | null;
}

export interface ClientCrmFacts {
  mode: CrmMode;
  owners: { crm: CapabilityProvider; calendars: CapabilityProvider };
  counts: ClientCrmCounts;
  ghl: ClientGhlFacts;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ghlStatus(f: ClientGhlFacts, provider: "ghl" | "ghl_calendar"): ClientCardStatus {
  const recorded = provider === "ghl" ? f.crmCheck : f.calendarCheck;
  if (recorded) return recorded;
  const mapped = f.mappingStatus !== null;
  const status = !mapped ? "not_configured" : f.mappingStatus === "connected" && f.verifiedAt ? "connected" : f.mappingStatus === "error" ? "error" : "pending";
  return { provider, status, detail: null, last_checked_at: null };
}

function ghlLabel(status: string, f: ClientGhlFacts): string {
  if (status === "connected") return "Connected";
  if (status === "error") return "Error";
  if (status === "not_configured") return f.mappingStatus ? "Not configured" : "Not mapped";
  return "Not verified";
}

/**
 * Cards for the workspace's CRM and calendar. The page adds the other tools (AI workforce, messaging, automation)
 * because their evidence lives elsewhere.
 */
export function buildClientCrmCards(facts: ClientCrmFacts): ClientIntegrationCard[] {
  const cards: ClientIntegrationCard[] = [];
  const c = facts.counts;

  if (facts.owners.crm === "native") {
    const records = c.contacts > 0 || c.pipelines > 0;
    cards.push({
      key: "native_crm",
      name: "iAcquire CRM",
      body: "Contacts, companies, pipelines, deals and tasks live in iAcquire. No GoHighLevel account is needed.",
      fact: records ? `${plural(c.contacts, "contact")} · ${plural(c.pipelines, "pipeline")}` : "Ready for your first contact",
      status: { provider: "native_crm", status: "connected", detail: null, last_checked_at: null },
      statusLabel: "Active",
      check: "Built into iAcquire",
      link: { href: "/crm", label: "Open CRM" },
    });
  }

  if (facts.owners.calendars === "native") {
    const active = c.activeCalendars;
    const outside = c.connectedCalendars;
    cards.push({
      key: "native_calendar",
      name: "iAcquire Calendar",
      body: active
        ? "Appointment types, availability, booking pages and conflict-checked bookings, kept in iAcquire."
        : "Create a calendar, set working hours and take bookings without an outside calendar provider.",
      fact: active
        ? `${plural(active, "active calendar")}${outside ? ` · ${plural(outside, "outside calendar")} connected` : ""}`
        : "No calendar set up yet",
      status: { provider: "native_calendar", status: active ? "connected" : "not_configured", detail: null, last_checked_at: null },
      statusLabel: active ? "Active" : "Not set up",
      check: "Built into iAcquire",
      link: { href: "/crm/calendars", label: active ? "Manage calendars" : "Create a calendar" },
    });
  }

  if (facts.owners.crm === "ghl" || facts.ghl.crmCheck) {
    const status = ghlStatus(facts.ghl, "ghl");
    const verified = status.status === "connected";
    cards.push({
      key: "ghl_crm",
      name: "GoHighLevel CRM",
      body: "Optional: your contacts and pipelines stay in your own GoHighLevel location, and iAcquire reads from it.",
      fact: facts.ghl.locationName ?? "Location assigned",
      status,
      statusLabel: ghlLabel(status.status, facts.ghl),
      check: verified ? "Service check passed" : "Managed by iAcquire",
      link: { href: "/settings/provider", label: "CRM provider settings" },
    });
  }

  if (facts.owners.calendars === "ghl" || facts.ghl.calendarCheck) {
    const status = ghlStatus(facts.ghl, "ghl_calendar");
    const verified = status.status === "connected";
    cards.push({
      key: "ghl_calendar",
      name: "GoHighLevel Calendar",
      body: "Appointment availability and bookings from your GoHighLevel calendar.",
      status,
      statusLabel: ghlLabel(status.status, facts.ghl),
      check: verified ? "Service check passed" : "Managed by iAcquire",
      link: { href: "/settings/provider", label: "CRM provider settings" },
    });
  }

  return cards;
}
