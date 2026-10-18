// CRM Blueprints: importing configuration from GoHighLevel through its official read-only API, and the conversion engine.
// Synthetic data and a mocked fetch only: nothing here contacts GoHighLevel. The mock answers GET requests on the official host with
// payloads shaped exactly like the documented responses (GoHighLevel/highlevel-api-docs apps/*.json), and refuses anything else.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resolveCredential } from "@/server/security/credentials";
import { saveIntegrationConnection } from "@/server/integrations/manager";
import {
  fitImportForStorage, listGhlSources, maskLocation, parseGhlSourceRef, removeGhlTemplateSource, runGhlImport, saveGhlTemplateSource, testGhlTemplateSource,
} from "@/server/crm/blueprints/ghl";
import { GhlReadError, assertImportableLocation, createGhlReader, readGhlInventory } from "@/server/crm/blueprints/ghl-read";
import { convertGhlInventory, ghlBlueprintMeta, tagColorFor } from "@/lib/crm/blueprints/ghl/convert";
import {
  GHL_API_ORIGIN, GHL_IMPORT_SCOPES, GHL_KIND_INFO, GHL_TEMPLATES_UNAVAILABLE, emptyGhlInventory, normalizeGhlPage,
  type GhlCalendar, type GhlInventory, type GhlKind,
} from "@/lib/crm/blueprints/ghl/inventory";
import { cleanText, convertGhlTokens, htmlToText } from "@/lib/crm/blueprints/ghl/text";
import { scanText, validateContent } from "@/lib/crm/blueprints/validate";
import { listAssets } from "@/lib/crm/blueprints/refs";
import { TAG_COLORS } from "@/lib/crm/types";
import type { BlueprintContent, CompatItem } from "@/lib/crm/blueprints/types";
import { agencyUser, createOrg, createUser } from "./support/fixtures";

const TEST_STRIPE_KEY = `sk_live_${"x".repeat(10)}`;

// ---------------------------------------------------------------------------
// Synthetic GoHighLevel location, shaped like the documented responses
// ---------------------------------------------------------------------------

const TOKEN = "pit-1a2b3c4d-1111-2222-3333-444455556666";
const LOC = "TemplateLocation0001";
const CLIENT_LOC = "ClientLocationAA0002";
const OTHER_LOC = "OtherLocationZZ00009";
/** GoHighLevel-shaped record IDs (20 mixed-case letters and digits), so the tests prove none reaches converted content. */
const gid = (prefix: string, n: number) => `${prefix}${String(n).padStart(20 - prefix.length, "0")}`;
const ID = {
  pipeline: gid("Pipe", 1), pipelineEmpty: gid("Pipe", 2), pipelineForeign: gid("Pipe", 3),
  stage: (n: number) => gid("Stg", n),
  tag: (n: number) => gid("Tag", n),
  field: (n: number) => gid("Fld", n),
  value: (n: number) => gid("Val", n),
  group: gid("Grp", 1),
  cal: (n: number) => gid("Cal", n),
  user: (n: number) => gid("User", n),
  form: (n: number) => gid("Form", n),
  survey: gid("Srv", 1),
  workflow: (n: number) => `78559bb3-b920-461e-b010-7b2a2816d2a${n}`,
  design: "67334b231f2fad724062f52b",
  funnel: gid("Fun", 1),
};

const location = (id = LOC) => ({ location: { id, companyId: gid("Comp", 1), name: "Bright Smiles Template", timezone: "America/Chicago", email: "owner@brightsmiles.example" } });

const cal = (n: number, extra: Record<string, unknown>) => ({
  id: ID.cal(n), locationId: LOC, isActive: true, slug: `cal-${n}`, widgetSlug: `cal-${n}`, widgetType: "classic", notifications: [], ...extra,
});

function routes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [`/locations/${LOC}`]: location(),
    "/opportunities/pipelines": {
      pipelines: [
        {
          id: ID.pipeline, name: "Patient Journey", locationId: LOC, showInFunnel: true, showInPieChart: true,
          stages: [
            { id: ID.stage(3), name: "Won", position: 2 }, { id: ID.stage(1), name: "New Lead", position: 0 }, { id: ID.stage(2), name: "Consult Booked", position: 1 },
            { id: ID.stage(4), name: "Lost", position: 3 },
          ],
        },
        { id: ID.pipelineEmpty, name: "Empty Pipeline", locationId: LOC, stages: [] },
        { id: ID.pipelineForeign, name: "Somebody Else's Pipeline", locationId: OTHER_LOC, stages: [{ id: ID.stage(9), name: "Open", position: 0 }] },
      ],
    },
    [`/locations/${LOC}/tags`]: {
      tags: [
        { id: ID.tag(1), name: "vip", locationId: LOC }, { id: ID.tag(2), name: "VIP", locationId: LOC }, { id: ID.tag(3), name: "new-patient", locationId: LOC },
        { id: ID.tag(9), name: "foreign-tag", locationId: OTHER_LOC },
      ],
    },
    [`/locations/${LOC}/customFields`]: {
      customFields: [
        { id: ID.field(1), name: "Budget", fieldKey: "contact.budget", dataType: "TEXT", position: 0, model: "contact", placeholder: "Your budget", locationId: LOC },
        { id: ID.field(2), name: "Preferred Service", fieldKey: "contact.preferred_service", dataType: "SINGLE_OPTIONS", position: 1, picklistOptions: ["Cleaning", "Whitening"], model: "contact", locationId: LOC },
        { id: ID.field(3), name: "Newsletter", fieldKey: "contact.newsletter", dataType: "CHECKBOX", position: 2, picklistOptions: [], model: "contact", locationId: LOC },
        { id: ID.field(4), name: "Interests", fieldKey: "contact.interests", dataType: "MULTIPLE_OPTIONS", position: 3, picklistOptions: ["Braces", "Implants", "Braces"], model: "contact", locationId: LOC },
        { id: ID.field(5), name: "Last Visit", fieldKey: "contact.last_visit", dataType: "DATE", position: 4, model: "contact", locationId: LOC },
        { id: ID.field(6), name: "Deal Size", fieldKey: "opportunity.deal_size", dataType: "MONETORY", position: 5, model: "opportunity", locationId: LOC },
        { id: ID.field(7), name: "X-Ray Upload", fieldKey: "contact.xray_upload", dataType: "FILE_UPLOAD", position: 6, model: "contact", locationId: LOC },
        { id: ID.field(8), name: "Family Members", fieldKey: "contact.family_members", dataType: "TEXTBOX_LIST", position: 7, model: "contact", locationId: LOC },
        { id: ID.field(9), name: "Mystery", fieldKey: "contact.mystery", dataType: "HOLOGRAM", position: 8, model: "contact", locationId: LOC },
        { id: ID.field(10), name: "Contact Method", fieldKey: "contact.contact_method", dataType: "RADIO", position: 9, picklistOptions: ["Phone", "Email"], model: "contact", locationId: LOC },
      ],
    },
    [`/locations/${LOC}/customValues`]: {
      customValues: [
        { id: ID.value(1), name: "Booking Link", fieldKey: "{{ custom_values.booking_link }}", value: "https://book.example.com/smile", locationId: LOC },
        { id: ID.value(2), name: "API Key", fieldKey: "{{ custom_values.api_key }}", value: TEST_STRIPE_KEY, locationId: LOC },
        { id: ID.value(3), name: "Office Phone", fieldKey: "{{ custom_values.office_phone }}", value: "+1 (555) 123-4567", locationId: LOC },
        { id: ID.value(4), name: "Promo Code", fieldKey: "{{ custom_values.promo_code }}", value: "SMILE10", locationId: LOC },
        { id: ID.value(5), name: "Greeting", fieldKey: "{{ custom_values.greeting }}", value: "Hi {{contact.first_name}}", locationId: LOC },
      ],
    },
    "/calendars/groups": { groups: [{ id: ID.group, name: "Dental Team", description: "Everyone who sees patients", slug: "dental-team", isActive: true, locationId: LOC }] },
    "/calendars/": {
      calendars: [
        cal(1, {
          name: "New Patient Consult", description: "<p>A first visit for <b>new</b> patients.</p>", calendarType: "round_robin", eventType: "RoundRobin_OptimizeForEqualDistribution",
          groupId: ID.group, teamMembers: [{ userId: ID.user(1), priority: 1, isPrimary: true }, { userId: ID.user(2), priority: 0.5 }],
          locationConfigurations: [{ kind: "google_conference" }], slotDuration: 45, slotDurationUnit: "mins", slotInterval: 15, slotIntervalUnit: "mins",
          preBuffer: 10, preBufferUnit: "mins", slotBuffer: 15, slotBufferUnit: "mins", allowBookingAfter: 1, allowBookingAfterUnit: "days", allowBookingFor: 8, allowBookingForUnit: "weeks",
          appoinmentPerDay: 6, openHours: [{ daysOfTheWeek: [1, 2, 3, 4, 5], hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }, { openHour: 13, openMinute: 0, closeHour: 17, closeMinute: 0 }] }],
          formId: ID.form(1), autoConfirm: false, formSubmitType: "ThankYouMessage", formSubmitThanksMessage: "Thanks! See you soon.", eventColor: "#2563EB", stickyContact: true, pixelId: "123",
        }),
        cal(2, { name: "Zoom Check-in", calendarType: "event", teamMembers: [{ userId: ID.user(1) }], locationConfigurations: [{ kind: "zoom_conference" }], slotDuration: 1, slotDurationUnit: "hours" }),
        cal(3, { name: "Treatment Review", calendarType: "collective", teamMembers: [{ userId: ID.user(2), isPrimary: true }, { userId: ID.user(3) }], locationConfigurations: [{ kind: "ms_teams_conference" }], slotDuration: 30, slotDurationUnit: "mins" }),
        cal(4, { name: "Group Class", calendarType: "class_booking", appoinmentPerSlot: 12, teamMembers: [{ userId: ID.user(3) }], locationConfigurations: [{ kind: "physical", location: "12 Example Street" }], enableRecurring: true }),
        cal(5, { name: "Spa Services", calendarType: "service_booking" }),
        { ...cal(6, { name: "Another Location's Calendar", calendarType: "event" }), locationId: OTHER_LOC },
      ],
    },
    "/forms/": { forms: [{ id: ID.form(1), name: "New Patient Intake", locationId: LOC }, { id: ID.form(2), name: "Contact Us", locationId: LOC }], total: 2 },
    "/surveys/": { surveys: [{ id: ID.survey, name: "Satisfaction Survey", locationId: LOC }], total: 1 },
    "/workflows/": {
      workflows: [
        { id: ID.workflow(1), name: "Appointment Reminder", status: "published", version: 3, locationId: LOC },
        { id: ID.workflow(2), name: "Lead Nurture", status: "draft", version: 1, locationId: LOC },
      ],
    },
    "/emails/builder": { id: ID.design, name: "Monthly Newsletter", templateType: "builder", isPlainText: false, previewUrl: "https://example.com/preview", version: "1" },
    "/funnels/funnel/list": { funnels: [{ _id: ID.funnel, name: "Smile Landing", type: "funnel", locationId: LOC, steps: [{ id: "s1", name: "Opt-in" }, { id: "s2", name: "Thanks" }] }], count: 1, traceId: "t" },
    ...over,
  };
}

type Route = unknown | ((url: URL) => Response | Promise<Response>);
interface Call { url: URL; method: string; headers: Record<string, string> }

/** Answers documented GET routes on the official host. Anything else is recorded and refused. */
function mockGhl(table: Record<string, Route>) {
  const calls: Call[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    if (method !== "GET" || url.origin !== GHL_API_ORIGIN) return new Response("refused", { status: 405 });
    const route = table[url.pathname];
    if (route === undefined) return new Response("not found", { status: 404 });
    return typeof route === "function" ? (route as (u: URL) => Response | Promise<Response>)(url) : Response.json(route);
  });
  return { spy, calls };
}

// ---------------------------------------------------------------------------
// People and sources
// ---------------------------------------------------------------------------

let admin: ReturnType<typeof agencyUser>;
let staff: ReturnType<typeof agencyUser>;
let sourceId: string;
let client: Awaited<ReturnType<typeof createOrg>>;
const SCOPES = [...GHL_IMPORT_SCOPES];

beforeAll(async () => {
  admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
  client = await createOrg({ name: "Client With GHL" });
  ({ id: sourceId } = await saveGhlTemplateSource(admin, { label: "Dental template account", locationId: LOC, token: TOKEN, scopes: SCOPES }));
  await saveIntegrationConnection(admin, client.id, { provider: "ghl", label: "Client GHL", environment: "development", secret: TOKEN.replace("pit-1", "pit-2"), config: { locationId: CLIENT_LOC, scopes: ["locations.readonly", "opportunities.readonly"] } });
});
afterEach(() => vi.restoreAllMocks());

const imported = async (over: Record<string, unknown> = {}, opts: { includeValues?: boolean; includePlaceholders?: boolean } = {}) => {
  const mock = mockGhl(routes(over));
  const detail = await runGhlImport(admin, { sourceRef: `agency:${sourceId}`, includeValues: opts.includeValues ?? true, includePlaceholders: opts.includePlaceholders ?? true });
  return { ...mock, detail };
};
const itemNamed = (items: CompatItem[], name: string) => {
  const found = items.find((i) => i.name === name);
  if (!found) throw new Error(`No report item named ${name}: ${items.map((i) => i.name).join(", ")}`);
  return found;
};
const allIds = Object.values(ID).flatMap((v) => (typeof v === "function" ? [1, 2, 3, 4, 5, 6, 9, 10].map((n) => (v as (n: number) => string)(n)) : [v]));

// ---------------------------------------------------------------------------
// The read boundary
// ---------------------------------------------------------------------------

describe("reading GoHighLevel: GET only, official host, documented headers", () => {
  it("imports with GET requests to the official origin only, verifies identity once, and never calls an undocumented or write endpoint", async () => {
    const { calls, detail } = await imported();
    expect(detail.status).toBe("previewed");
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.every((c) => c.url.origin === "https://services.leadconnectorhq.com")).toBe(true);
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.filter((c) => c.url.pathname === `/locations/${LOC}`)).toHaveLength(1);
    expect(calls[0].url.pathname).toBe(`/locations/${LOC}`);
    // Documented Version headers: calendars 2021-04-15, the rest 2021-07-28, funnels none.
    for (const c of calls) {
      if (c.url.pathname.startsWith("/calendars")) expect(c.headers.Version).toBe("2021-04-15");
      else if (c.url.pathname.startsWith("/funnels")) expect(c.headers.Version).toBeUndefined();
      else expect(c.headers.Version).toBe("2021-07-28");
    }
    // Never: the templates endpoint (undocumented originId), snapshots, users, contacts or anything outside the documented list.
    const paths = new Set(calls.map((c) => c.url.pathname));
    expect([...paths].sort()).toEqual([
      "/calendars/", "/calendars/groups", "/emails/builder", "/forms/", "/funnels/funnel/list", `/locations/${LOC}`, `/locations/${LOC}/customFields`,
      `/locations/${LOC}/customValues`, `/locations/${LOC}/tags`, "/opportunities/pipelines", "/surveys/", "/workflows/",
    ].sort());
    expect(calls.find((c) => c.url.pathname === `/locations/${LOC}/customFields`)!.url.searchParams.get("model")).toBe("all");
    expect(calls.find((c) => c.url.pathname === "/forms/")!.url.searchParams.get("locationId")).toBe(LOC);
    // The templates kind is reported unavailable with the exact reason, without a request.
    expect(detail.report.unavailable).toContainEqual({ sourceKind: "messageTemplates", reason: GHL_TEMPLATES_UNAVAILABLE });
  });

  it("refuses both protected locations before any request, at every entry point", async () => {
    const { spy } = mockGhl(routes());
    for (const loc of ["u69CVh0ZlAofUmRoj1zF", "SQvVnld5MBHdMQ1qnSfw"]) {
      expect(() => assertImportableLocation(loc)).toThrow(/protected/);
      expect(() => createGhlReader({ locationId: loc, token: TOKEN })).toThrow(/protected/);
      await expect(readGhlInventory({ locationId: loc, token: TOKEN })).rejects.toMatchObject({ code: "forbidden" });
      await expect(saveGhlTemplateSource(admin, { label: "Nope", locationId: loc, token: TOKEN, scopes: SCOPES })).rejects.toMatchObject({ code: "forbidden" });
      // And the database refuses it as a source even if code were bypassed.
      await expect(withSystem((db) => db.query("insert into crm_blueprint_ghl_sources (label, location_id) values ('x', $1)", [loc]))).rejects.toThrow();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("stops after the identity GET when the token belongs to another location, and records a failed import", async () => {
    const { calls } = mockGhl(routes({ [`/locations/${LOC}`]: location(OTHER_LOC) }));
    await expect(runGhlImport(admin, { sourceRef: `agency:${sourceId}`, includeValues: false, includePlaceholders: true })).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/mismatch/) });
    expect(calls).toHaveLength(1);
    const { rows } = await withSystem((db) => db.query<{ status: string; error: string; package: unknown }>("select status, error, package from crm_blueprint_imports where ghl_source_id = $1 order by created_at desc limit 1", [sourceId]));
    expect(rows[0]).toMatchObject({ status: "failed", package: null });
    expect(rows[0].error).toMatch(/mismatch/);
  });

  it("drops rows that name another location and says so", async () => {
    const { detail } = await imported();
    const text = JSON.stringify(detail);
    expect(text).not.toContain("Somebody Else's Pipeline");
    expect(text).not.toContain("foreign-tag");
    expect(text).not.toContain("Another Location's Calendar");
    expect(detail.report.limitations.some((l) => /named another GoHighLevel location and was ignored/.test(l))).toBe(true);
  });

  it("isolates a refused kind: a 403 on workflows leaves every other kind imported", async () => {
    const { detail } = await imported({ "/workflows/": () => new Response("forbidden", { status: 403 }) });
    expect(detail.status).toBe("previewed");
    const wf = detail.report.unavailable.find((u) => u.sourceKind === "workflows");
    expect(wf?.reason).toMatch(/isn't allowed to read workflows \(scope workflows\.readonly\)/);
    expect(detail.content!.assets.workflows).toHaveLength(0);
    expect(detail.content!.assets.pipelines).toHaveLength(1);
    expect(detail.content!.assets.calendars.length).toBeGreaterThan(0);
  });

  it("keeps a kind with an unexpected response shape out without failing the import", async () => {
    const { detail } = await imported({ [`/locations/${LOC}/tags`]: { somethingElse: [] } });
    expect(detail.report.unavailable.find((u) => u.sourceKind === "tags")?.reason).toMatch(/documented shape/);
    expect(detail.content!.assets.tags).toHaveLength(0);
    expect(detail.content!.assets.customFields.length).toBeGreaterThan(0);
  });

  it("backs off on 429 using Retry-After, and gives up after the bounded retries", async () => {
    let n = 0;
    mockGhl({ "/workflows/": () => (++n === 1 ? new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }) : Response.json({ workflows: [] })) });
    const sleep = vi.fn(async () => undefined);
    const reader = createGhlReader({ locationId: LOC, token: TOKEN }, { sleep });
    await expect(reader.get("/workflows/", { locationId: LOC }, "2021-07-28")).resolves.toEqual({ workflows: [] });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(reader.requests).toBe(2);
    vi.restoreAllMocks();

    const always = mockGhl({ "/workflows/": () => new Response("slow down", { status: 429 }) });
    const reader2 = createGhlReader({ locationId: LOC, token: TOKEN }, { sleep, maxRetries: 2 });
    const err = await reader2.get("/workflows/", { locationId: LOC }, "2021-07-28").catch((e) => e);
    expect(err).toBeInstanceOf(GhlReadError);
    expect(err.message).toMatch(/rate-limiting/);
    expect(always.calls).toHaveLength(3);
  });

  it("bounds pagination and reports what was left unread", async () => {
    const pageOf = (url: URL) => {
      const skip = Number(url.searchParams.get("skip"));
      const limit = Number(url.searchParams.get("limit"));
      return Response.json({ forms: Array.from({ length: limit }, (_, i) => ({ id: gid("Form", skip + i + 100), name: `Form ${skip + i}`, locationId: LOC })), total: 5000 });
    };
    const { calls } = mockGhl({ [`/locations/${LOC}`]: location(), "/forms/": pageOf });
    const { inventory } = await readGhlInventory({ locationId: LOC, token: TOKEN }, { kinds: ["forms"] });
    expect(inventory.kinds.forms).toMatchObject({ status: "ok", truncated: true, count: 1000 });
    expect(calls.filter((c) => c.url.pathname === "/forms/")).toHaveLength(20);
    expect(calls.map((c) => c.url.searchParams.get("limit")).filter(Boolean).every((l) => l === "50")).toBe(true);
  });

  it("never stores, returns or audits the token", async () => {
    const { detail } = await imported();
    await testGhlTemplateSource(admin, sourceId).catch(() => undefined);
    const sources = await listGhlSources(admin);
    expect(JSON.stringify(detail)).not.toContain(TOKEN);
    expect(JSON.stringify(sources)).not.toContain(TOKEN);
    const dump = await withSystem(async (db) => {
      const tables = ["crm_blueprint_imports", "crm_blueprint_ghl_sources", "audit_logs", "integration_credentials", "credential_references", "integration_connections"];
      const out: string[] = [];
      for (const t of tables) out.push(JSON.stringify((await db.query(`select * from ${t}`)).rows));
      return out.join("\n");
    });
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(TOKEN.slice(4));
    // Audits name the masked location, never the token or a raw payload.
    const audits = await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where action = 'crm.blueprint_ghl_import' and result = 'success'"));
    expect(audits.rows.length).toBeGreaterThan(0);
    expect(audits.rows[0].metadata).toMatchObject({ source: "ghl_agency_source", location: maskLocation(LOC) });
    expect(JSON.stringify(audits.rows)).not.toMatch(/Patient Journey|book\.example\.com|SMILE10/);
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe("import sources", () => {
  it("lists agency template sub-accounts and verified client connections, masked, for super admins only", async () => {
    await expect(listGhlSources(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveGhlTemplateSource(staff, { label: "x", locationId: "StaffLocation0000001", token: TOKEN, scopes: [] })).rejects.toMatchObject({ code: "forbidden" });
    let sources = await listGhlSources(admin);
    expect(sources.find((s) => s.ref === `agency:${sourceId}`)).toMatchObject({ kind: "ghl_agency_source", label: "Dental template account", locationHint: "Tem…001" });
    // A client connection that was saved but never verified isn't offered.
    expect(sources.find((s) => s.ref === `client:${client.id}`)).toBeUndefined();
    await withSystem((db) => db.query("update integration_connections set status = 'connected' where org_id = $1 and provider = 'ghl'", [client.id]));
    sources = await listGhlSources(admin);
    const c = sources.find((s) => s.ref === `client:${client.id}`);
    expect(c).toMatchObject({ kind: "ghl_client", label: "Client With GHL", locationHint: "Cli…002" });
    expect(c!.missingScopes).toContain("calendars.readonly");
    expect(JSON.stringify(sources)).not.toContain(LOC);
  });

  it("refuses a template source that is a client's own location", async () => {
    await expect(saveGhlTemplateSource(admin, { label: "Client's", locationId: CLIENT_LOC, token: TOKEN, scopes: SCOPES })).rejects.toMatchObject({ code: "conflict" });
  });

  it("validates input without echoing the token", async () => {
    const err = await saveGhlTemplateSource(admin, { label: "Bad", locationId: "LocationBad00000001", token: "short tok", scopes: [] }).catch((e) => e);
    expect(err).toMatchObject({ code: "invalid_input" });
    expect(String(err.message)).not.toContain("short tok");
    await expect(saveGhlTemplateSource(admin, { label: "Bad", locationId: "LocationBad00000001", token: TOKEN, scopes: ["contacts.write"] })).rejects.toMatchObject({ code: "invalid_input" });
    expect(() => parseGhlSourceRef("agency:not-a-uuid")).toThrow(/source/);
  });

  it("tests a source: records which read scopes work, or the reason it can't be used", async () => {
    mockGhl(routes({ "/surveys/": () => new Response("no", { status: 401 }) }));
    const view = await testGhlTemplateSource(admin, sourceId);
    expect(view.status).toBe("permission_limited");
    expect(view.scopes).toContain("calendars.readonly");
    expect(view.scopes).not.toContain("surveys.readonly");
    expect(view.missingScopes).toEqual(["surveys.readonly"]);
    expect(view.verifiedAt).not.toBeNull();
    vi.restoreAllMocks();

    const probe = mockGhl(routes());
    expect((await testGhlTemplateSource(admin, sourceId)).status).toBe("connected");
    // A probe reads one small page per kind.
    expect(probe.calls.find((c) => c.url.pathname === "/forms/")!.url.searchParams.get("limit")).toBe("1");
    vi.restoreAllMocks();

    mockGhl(routes({ [`/locations/${LOC}`]: location(OTHER_LOC) }));
    await expect(testGhlTemplateSource(admin, sourceId)).rejects.toThrow(/mismatch/);
    const { rows } = await withSystem((db) => db.query<{ status: string; last_error: string }>("select status, last_error from crm_blueprint_ghl_sources where id = $1", [sourceId]));
    expect(rows[0].status).toBe("error");
    expect(rows[0].last_error).toMatch(/mismatch/);
  });

  it("imports from a client's verified connection only with access to that client, reading the client's own location", async () => {
    await withSystem((db) => db.query("update integration_connections set status = 'connected' where org_id = $1 and provider = 'ghl'", [client.id]));
    await expect(runGhlImport(staff, { sourceRef: `client:${client.id}`, includeValues: false, includePlaceholders: true })).rejects.toMatchObject({ code: "forbidden" });
    const clientRoutes = Object.fromEntries(Object.entries(routes()).map(([k, v]) => [k.replace(LOC, CLIENT_LOC), JSON.parse(JSON.stringify(v).replaceAll(LOC, CLIENT_LOC))]));
    const { calls } = mockGhl(clientRoutes);
    const detail = await runGhlImport(admin, { sourceRef: `client:${client.id}`, includeValues: false, includePlaceholders: true });
    expect(detail).toMatchObject({ sourceKind: "ghl_client", sourceLabel: "Client With GHL", status: "previewed" });
    expect(calls[0].url.pathname).toBe(`/locations/${CLIENT_LOC}`);
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN.replace("pit-1", "pit-2")}`)).toBe(true);
    const { rows } = await withSystem((db) => db.query<{ source_org_id: string; source_label: string }>("select source_org_id, source_label from crm_blueprint_imports where id = $1", [detail.id]));
    expect(rows[0].source_org_id).toBe(client.id);
    // The library is shared with staff who aren't assigned to this client: nothing stored or proposed names it (or its location).
    expect(rows[0].source_label).toBe("A client's GoHighLevel location");
    expect(detail.content!.blueprint).toMatchObject({ name: "GoHighLevel import", key: "ghl-import" });
    expect(detail.content!.blueprint.description).not.toContain("Client With GHL");
    expect(detail.content!.blueprint.description).not.toContain("Bright Smiles");
    const unknownClient = await createOrg();
    await expect(runGhlImport(admin, { sourceRef: `client:${unknownClient.id}`, includeValues: false, includePlaceholders: true })).rejects.toMatchObject({ code: "not_found" });
  });

  it("removes a source: its token is revoked and it disappears from the list", async () => {
    const extra = await saveGhlTemplateSource(admin, { label: "Spare template", locationId: "SpareLocation0000007", token: TOKEN, scopes: SCOPES });
    const { rows } = await withSystem((db) => db.query<{ credential_id: string }>("select credential_id from crm_blueprint_ghl_sources where id = $1", [extra.id]));
    await removeGhlTemplateSource(admin, extra.id);
    expect(await withSystem((db) => resolveCredential(db, rows[0].credential_id, null, "ghl"))).toBeNull();
    expect((await listGhlSources(admin)).some((s) => s.ref === `agency:${extra.id}`)).toBe(false);
    expect((await withSystem((db) => db.query("select 1 from crm_blueprint_ghl_sources where id = $1", [extra.id]))).rows).toHaveLength(0);
    await expect(removeGhlTemplateSource(admin, extra.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// The stored import and the converted content
// ---------------------------------------------------------------------------

describe("the recorded import", () => {
  it("stores a previewed import with the report, the GoHighLevel-free package, source refs and counts", async () => {
    const { detail } = await imported();
    const { rows } = await withSystem((db) => db.query<{ status: string; report: unknown; package: BlueprintContent; source_refs: Record<string, { kind: string; externalId: string }>; counts: unknown; source_kind: string; ghl_source_id: string }>(
      "select status, report, package, source_refs, counts, source_kind, ghl_source_id from crm_blueprint_imports where id = $1", [detail.id]));
    const row = rows[0];
    expect(row).toMatchObject({ status: "previewed", source_kind: "ghl_agency_source", ghl_source_id: sourceId });
    expect(row.package).toEqual(detail.content);
    expect(row.report).toEqual(detail.report);
    expect(row.counts).toEqual(detail.counts);
    expect(detail.counts.discovered).toBe(detail.report.items.length);
    // Provenance: logical ID → GoHighLevel item.
    expect(row.source_refs["pipeline.patient-journey"]).toEqual({ kind: "pipeline", externalId: ID.pipeline });
    expect(row.source_refs["member.calendar-host-1"]).toEqual({ kind: "user", externalId: ID.user(1) });
    expect(row.source_refs["calendar.new-patient-consult"]).toMatchObject({ kind: "calendar", externalId: ID.cal(1) });
  });

  it("keeps every GoHighLevel ID out of the content, and the content passes the contract validator with zero errors", async () => {
    const { detail } = await imported();
    const content = detail.content!;
    const text = JSON.stringify(content);
    for (const id of allIds) expect(text).not.toContain(id);
    expect(text).not.toContain(LOC);
    expect(text).not.toContain("leadconnectorhq");
    const v = validateContent(content);
    expect(v.errors).toEqual([]);
    expect(detail.validation.errors).toEqual([]);
    // Every string is clean by the contract's own scanner.
    const strings: string[] = [];
    const walk = (n: unknown) => (typeof n === "string" ? strings.push(n) : Array.isArray(n) ? n.forEach(walk) : n && typeof n === "object" ? Object.values(n).forEach(walk) : undefined);
    walk(content);
    expect(strings.flatMap(scanText).filter((f) => f.kind !== "personal")).toEqual([]);
  });

  it("never labels a placeholder converted or ready", async () => {
    const { detail } = await imported();
    const placeholders = detail.report.items.filter((i) => i.placeholder);
    expect(placeholders.length).toBeGreaterThanOrEqual(5);
    for (const p of placeholders) expect(p.status).toBe("manual_review");
    expect(detail.report.summary.manualReview).toBeGreaterThanOrEqual(placeholders.length);
    expect(detail.report.items.filter((i) => i.status === "converted").every((i) => !i.placeholder)).toBe(true);
  });

  it("refuses agency staff, and an archived or unknown agency source, before reading anything", async () => {
    const { spy } = mockGhl(routes());
    await expect(runGhlImport(staff, { sourceRef: `agency:${sourceId}`, includeValues: false, includePlaceholders: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(runGhlImport(admin, { sourceRef: `agency:${crypto.randomUUID()}`, includeValues: false, includePlaceholders: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(runGhlImport(admin, { sourceRef: "agency:nope", includeValues: false, includePlaceholders: true })).rejects.toMatchObject({ code: "invalid_input" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("fits very large imports into their columns, keeping each asset's own provenance first", () => {
    const sourceRefs = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`tag.t${i}`, { kind: "tag", externalId: gid("Tag", i), related: [{ assetId: `field.contact.f${i}`, relation: "field_token" as const }] }]));
    const fitted = fitImportForStorage({ sourceRefs, report: { items: [], summary: {} as never, limitations: [], unavailable: [] } });
    expect(fitted.trimmed).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(fitted.sourceRefs))).toBeLessThan(250_000);
    expect(fitted.sourceRefs["tag.t0"]).toEqual({ kind: "tag", externalId: gid("Tag", 0) });
  });

  it("states the limitations: no Smart List API, snapshots aren't exports, names-only kinds, WhatsApp", async () => {
    const { detail } = await imported();
    const l = detail.report.limitations.join("\n");
    expect(l).toContain(GHL_KIND_INFO.smartLists.limitation!);
    expect(l).toMatch(/share link installs the snapshot into another GoHighLevel account; it is not a file/);
    expect(l).toContain(GHL_KIND_INFO.forms.limitation!);
    expect(l).toContain(GHL_KIND_INFO.workflows.limitation!);
    expect(l).toMatch(/WhatsApp templates: GoHighLevel documents no API/);
  });
});

// ---------------------------------------------------------------------------
// Conversion rules, kind by kind
// ---------------------------------------------------------------------------

describe("conversion rules", () => {
  it("pipelines and stages: GoHighLevel's order, won / lost by exact name, pipelines without stages unsupported", async () => {
    const { detail } = await imported();
    const [p] = detail.content!.assets.pipelines;
    expect(p).toMatchObject({ id: "pipeline.patient-journey", name: "Patient Journey", isDefault: true });
    expect(p.stages.map((s) => [s.id, s.name, s.kind])).toEqual([
      ["stage.patient-journey.new-lead", "New Lead", "open"], ["stage.patient-journey.consult-booked", "Consult Booked", "open"],
      ["stage.patient-journey.won", "Won", "won"], ["stage.patient-journey.lost", "Lost", "lost"],
    ]);
    expect(itemNamed(detail.report.items, "Patient Journey").status).toBe("converted");
    expect(itemNamed(detail.report.items, "Empty Pipeline")).toMatchObject({ status: "unsupported", assetId: null });
  });

  it("tags: deterministic colours from the name; tags differing only by case become one", async () => {
    const { detail } = await imported();
    const tags = detail.content!.assets.tags;
    expect(tags.map((t) => t.name)).toEqual(["vip", "new-patient"]);
    for (const t of tags) {
      expect(TAG_COLORS).toContain(t.color);
      expect(t.color).toBe(tagColorFor(t.name));
    }
    expect(tagColorFor("VIP")).toBe(tagColorFor("vip"));
    expect(itemNamed(detail.report.items, "vip").notes.join(" ")).toMatch(/also has “VIP”/);
    expect(detail.report.summary.conflicts).toBeGreaterThanOrEqual(1);
  });

  it("custom fields by data type, with unsupported types reported", async () => {
    const { detail } = await imported();
    const fields = Object.fromEntries(detail.content!.assets.customFields.map((f) => [f.key, f]));
    expect(fields.budget).toMatchObject({ id: "field.contact.budget", entity: "contact", type: "text", label: "Budget", helpText: "Your budget", options: [] });
    expect(fields.preferred_service).toMatchObject({ type: "select", options: [{ value: "cleaning", label: "Cleaning" }, { value: "whitening", label: "Whitening" }] });
    expect(fields.newsletter).toMatchObject({ type: "boolean", options: [] });
    expect(fields.interests.type).toBe("multiselect");
    expect(fields.interests.options.map((o) => o.value)).toEqual(["braces", "implants"]);
    expect(fields.last_visit.type).toBe("date");
    expect(fields.deal_size).toMatchObject({ id: "field.opportunity.deal_size", entity: "opportunity", type: "currency" });
    expect(fields.contact_method).toMatchObject({ type: "select" });
    for (const name of ["X-Ray Upload", "Family Members", "Mystery"]) expect(itemNamed(detail.report.items, name)).toMatchObject({ status: "unsupported", assetId: null });
    expect(itemNamed(detail.report.items, "Mystery").notes[0]).toMatch(/HOLOGRAM/);
    expect(itemNamed(detail.report.items, "Interests").status).toBe("converted");
    expect(itemNamed(detail.report.items, "Interests").notes.join(" ")).toMatch(/1 repeated option was kept once/);
  });

  it("custom values: contents only when asked and safe; otherwise required and empty (needs mapping)", async () => {
    const withValues = (await imported()).detail;
    vi.restoreAllMocks();
    const values = Object.fromEntries(withValues.content!.assets.customValues.map((v) => [v.key, v]));
    expect(values.booking_link).toMatchObject({ id: "value.booking_link", value: "https://book.example.com/smile", type: "url", required: false });
    expect(values.promo_code).toMatchObject({ value: "SMILE10", required: false });
    for (const k of ["api_key", "office_phone", "greeting"]) expect(values[k]).toMatchObject({ value: "", required: true });
    expect(itemNamed(withValues.report.items, "API Key")).toMatchObject({ status: "needs_mapping" });
    expect(itemNamed(withValues.report.items, "API Key").notes.join(" ")).toMatch(/credential/);
    expect(itemNamed(withValues.report.items, "Office Phone").notes.join(" ")).toMatch(/contact details/);
    expect(itemNamed(withValues.report.items, "Greeting").notes.join(" ")).toMatch(/merge fields/);
    expect(itemNamed(withValues.report.items, "Booking Link").status).toBe("converted");
    expect(JSON.stringify(withValues)).not.toContain("sk_live_");

    const withoutValues = (await imported({}, { includeValues: false })).detail;
    for (const v of withoutValues.content!.assets.customValues) expect(v).toMatchObject({ value: "", required: true });
    expect(itemNamed(withoutValues.report.items, "Booking Link").status).toBe("needs_mapping");
    expect(itemNamed(withoutValues.report.items, "Booking Link").requirements).toContain("custom_values");
    expect(JSON.stringify(withoutValues)).not.toContain("book.example.com");
  });

  it("calendars become draft-ready calendars with an appointment type, suggested hours and host mapping slots", async () => {
    const { detail } = await imported();
    const c = detail.content!;
    const consult = c.assets.calendars.find((x) => x.name === "New Patient Consult")!;
    expect(consult).toMatchObject({
      id: "calendar.new-patient-consult", assignment: "round_robin", roundRobinMode: "balanced", color: "#2563eb", timezone: "America/Chicago",
      hosts: ["@member.calendar-host-1", "@member.calendar-host-2"], description: "A first visit for new patients.",
    });
    expect(consult.hours).toHaveLength(10);
    expect(consult.hours.filter((h) => h.weekday === 1)).toEqual([{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 780, endMinute: 1020 }]);
    expect(consult.hours.some((h) => h.weekday === 0 || h.weekday === 6)).toBe(false);
    expect(consult.types).toHaveLength(1);
    expect(consult.types[0]).toMatchObject({
      id: "apptype.new-patient-consult.new-patient-consult", durationMinutes: 45, slotIntervalMinutes: 15, bufferBeforeMinutes: 10, bufferAfterMinutes: 15,
      minNoticeMinutes: 1440, maxDaysAhead: 56, dailyLimit: 6, capacity: 1, locationKind: "video", meetingProvider: "google_meet", requiresConfirmation: true,
      confirmationMessage: "Thanks! See you soon.", public: true, requireEmail: true,
    });
    const consultItem = itemNamed(detail.report.items, "New Patient Consult");
    expect(consultItem.requirements).toEqual(expect.arrayContaining(["calendar_hosts", "calendar_verification", "google_calendar", "member_mapping"]));
    expect(consultItem.notes.join(" ")).toMatch(/Not carried: sticky contact, tracking pixel/);
    expect(consultItem.notes.join(" ")).toMatch(/draft calendar: it takes no bookings until/);

    // Team members became host slots, shared when the same person hosts several calendars. No person travels.
    expect(c.slots.map((s) => s.id)).toEqual(["member.calendar-host-1", "member.calendar-host-2", "member.calendar-host-3"]);
    expect(c.assets.calendars.find((x) => x.name === "Zoom Check-in")!.hosts).toEqual(["@member.calendar-host-1"]);

    // Microsoft Teams: needs a connection.
    const review = c.assets.calendars.find((x) => x.name === "Treatment Review")!;
    expect(review).toMatchObject({ assignment: "collective", hosts: ["@member.calendar-host-2", "@member.calendar-host-3"] });
    expect(review.types[0]).toMatchObject({ meetingProvider: "microsoft_teams", locationKind: "video", durationMinutes: 30 });
    expect(itemNamed(detail.report.items, "Treatment Review")).toMatchObject({ status: "needs_connection" });
    expect(itemNamed(detail.report.items, "Treatment Review").requirements).toContain("microsoft_calendar");

    // Zoom: a video meeting with a fixed link the workspace still has to add, so the meeting link stays a requirement (setup checklist,
    // calendar activation) instead of disappearing.
    const zoom = c.assets.calendars.find((x) => x.name === "Zoom Check-in")!;
    expect(zoom).toMatchObject({ assignment: "single" });
    expect(zoom.types[0]).toMatchObject({ locationKind: "video", meetingProvider: "custom_link", meetingLink: null, locationDetail: "Zoom", durationMinutes: 60 });
    expect(itemNamed(detail.report.items, "Zoom Check-in")).toMatchObject({ status: "needs_mapping" });
    expect(itemNamed(detail.report.items, "Zoom Check-in").requirements).toContain("meeting_link");
    expect(itemNamed(detail.report.items, "Zoom Check-in").notes.join(" ")).toMatch(/Zoom, which iAcquire doesn't create meetings in/);

    // Class booking: group capacity, manual review. Service booking: unsupported.
    const cls = c.assets.calendars.find((x) => x.name === "Group Class")!;
    expect(cls.types[0]).toMatchObject({ capacity: 12, locationKind: "in_person", locationDetail: "12 Example Street" });
    expect(itemNamed(detail.report.items, "Group Class")).toMatchObject({ status: "manual_review" });
    expect(itemNamed(detail.report.items, "Group Class").notes.join(" ")).toMatch(/recurring bookings/);
    expect(itemNamed(detail.report.items, "Spa Services")).toMatchObject({ status: "unsupported", assetId: null });
    expect(c.assets.calendars.some((x) => x.name === "Spa Services")).toBe(false);
  });

  it("calendar groups become calendar folders and each calendar is filed in its group's folder", async () => {
    const { detail } = await imported();
    expect(detail.content!.assets.folders).toEqual([{ id: "folder.calendar.dental-team", kind: "calendar", name: "Dental Team" }]);
    expect(detail.content!.assets.calendars.find((x) => x.name === "New Patient Consult")!.folder).toBe("@folder.calendar.dental-team");
    expect(itemNamed(detail.report.items, "Dental Team").status).toBe("converted");
  });

  it("forms and surveys become name-only placeholders; a calendar's booking form is linked to its placeholder", async () => {
    const { detail } = await imported();
    const { rows } = await withSystem((db) => db.query<{ source_refs: Record<string, { related?: Array<{ assetId: string; relation: string }> }> }>("select source_refs from crm_blueprint_imports where id = $1", [detail.id]));
    const forms = detail.content!.assets.forms;
    expect(forms.map((f) => [f.id, f.kind, f.purpose, f.placeholder, f.draft.questions.length])).toEqual([
      ["form.new-patient-intake", "form", "appointment_request", true, 0], ["form.contact-us", "form", "contact", true, 0], ["form.satisfaction-survey", "survey", "survey", true, 0],
    ]);
    for (const name of ["New Patient Intake", "Contact Us", "Satisfaction Survey"]) {
      expect(itemNamed(detail.report.items, name)).toMatchObject({ status: "manual_review", placeholder: true });
      expect(itemNamed(detail.report.items, name).requirements).toContain("form_rebuild");
    }
    expect(rows[0].source_refs["calendar.new-patient-consult"].related).toEqual(expect.arrayContaining([
      { assetId: "form.new-patient-intake", relation: "booking_form" }, { assetId: "folder.calendar.dental-team", relation: "calendar_folder" },
    ]));
    expect(itemNamed(detail.report.items, "New Patient Consult").notes.join(" ")).toMatch(/GoHighLevel form “New Patient Intake”, brought over as a placeholder/);
  });

  it("without placeholders, name-only items are left out and the calendar's form is a missing dependency", async () => {
    const { detail } = await imported({}, { includePlaceholders: false });
    expect(detail.content!.assets.forms).toHaveLength(0);
    expect(detail.content!.assets.workflows).toHaveLength(0);
    expect(itemNamed(detail.report.items, "Contact Us")).toMatchObject({ status: "manual_review", assetId: null, placeholder: true });
    expect(itemNamed(detail.report.items, "New Patient Consult").missingDependencies).toEqual(["form.new-patient-intake"]);
    expect(detail.report.summary.missingDependencies).toBe(1);
    expect(validateContent(detail.content).errors).toEqual([]);
  });

  it("workflows become empty draft placeholders that never run, flagged for rebuild", async () => {
    const { detail } = await imported();
    const w = detail.content!.assets.workflows;
    expect(w.map((x) => [x.id, x.key, x.placeholder])).toEqual([["workflow.appointment_reminder", "appointment_reminder", true], ["workflow.lead_nurture", "lead_nurture", true]]);
    expect(w[0].definition).toEqual({ trigger: { type: "manual" }, steps: [] });
    expect(w[0].description).toMatch(/its status there: published/);
    expect(itemNamed(detail.report.items, "Appointment Reminder")).toMatchObject({ status: "manual_review", placeholder: true });
    expect(itemNamed(detail.report.items, "Appointment Reminder").requirements).toEqual(expect.arrayContaining(["workflow_rebuild", "workflow_activation"]));
  });

  it("email builder designs and funnels are report-only rebuild candidates; nothing is created or published", async () => {
    const { detail } = await imported();
    expect(itemNamed(detail.report.items, "Monthly Newsletter")).toMatchObject({ sourceKind: "emailDesign", status: "unsupported", assetId: null });
    const funnel = itemNamed(detail.report.items, "Smile Landing");
    expect(funnel).toMatchObject({ sourceKind: "funnel", status: "unsupported", assetId: null });
    expect(funnel.notes[0]).toMatch(/Website Studio rebuild candidate \(2 steps\).*nothing is published automatically/);
    expect(JSON.stringify(detail.content)).not.toContain("Smile Landing");
  });
});

// ---------------------------------------------------------------------------
// Templates and tokens (pure: the templates endpoint isn't called, but the rules are ready for it)
// ---------------------------------------------------------------------------

function inventoryWith(parts: Partial<GhlInventory>, ok: GhlKind[]): GhlInventory {
  const inv = { ...emptyGhlInventory(LOC, { locationName: "Bright Smiles", timezone: "America/Chicago" }), ...parts };
  for (const k of ok) inv.kinds[k] = { kind: k, status: "ok", reason: null, count: 0, truncated: false, droppedForeign: 0, malformed: 0 };
  return inv;
}
const meta = ghlBlueprintMeta({ label: "Test", locationName: "Bright Smiles", importedOn: new Date("2026-10-17T00:00:00Z") });

describe("message templates and tokens", () => {
  const inv = () => inventoryWith({
    customFields: [{ id: ID.field(1), name: "Budget", fieldKey: "contact.budget", dataType: "TEXT", model: "contact", placeholder: null, position: 0, options: [], imageOptions: 0, allowCustomOption: false }],
    customValues: [{ id: ID.value(1), name: "Booking Link", fieldKey: "{{ custom_values.Booking-Link }}", value: "https://book.example.com" }],
    messageTemplates: [
      { id: gid("Tpl", 1), name: "Booking nudge", type: "sms", body: "Hi {{ contact.first_name }}, book at {{custom_values.booking-link}}. Budget: {{contact.budget}}. {{contact.loyalty_tier}} Reply STOP to opt out.", subject: null, html: null, attachments: 0 },
      { id: gid("Tpl", 2), name: "Reminder", type: "sms", body: "See you {{appointment.only_start_date}} at {{appointment.start_time}} with {{location.name}}. Manage: {{appointment.reschedule_link}}", subject: null, html: null, attachments: 0 },
      {
        id: gid("Tpl", 3), name: "Welcome email", type: "email", subject: "Welcome to {{location.name}}", body: null, attachments: 1,
        html: "<html><head><style>body{color:red}</style><title>x</title></head><body><h1>Welcome {{contact.first_name}}!</h1><p>Visit <a href=\"https://www.example.com/offer\">our offer</a> or <a href=\"javascript:alert(1)\">this</a>.</p><script>alert(1)</script><p>&lt;script&gt;steal()&lt;/script&gt; Thanks &amp; regards</p><img src=x onerror=alert(3)><p>Book: https://api.leadconnectorhq.com/widget/booking/Cal00000000000000001</p></body></html>",
      },
      { id: gid("Tpl", 4), name: "WhatsApp hello", type: "whatsapp", body: "Hello {{1}}", subject: null, html: null, attachments: 0 },
      { id: gid("Tpl", 5), name: "Unsafe text", type: "sms", body: "Tap javascript:alert(document.cookie)", subject: null, html: null, attachments: 0 },
      { id: gid("Tpl", 6), name: "No subject", type: "email", subject: "", html: "<p>Plain hello</p>", body: null, attachments: 0 },
    ],
  }, ["customFields", "customValues", "messageTemplates"]);

  it("maps merge fields: built-ins to iAcquire tokens, custom values to the imported value, custom fields and unknowns to visible markers", () => {
    const conv = convertGhlInventory(inv(), { includeValues: true, includePlaceholders: true, meta });
    const t = Object.fromEntries(conv.content.assets.messageTemplates.map((x) => [x.name, x]));
    expect(t["Booking nudge"].body).toBe("Hi {{contact.first_name}}, book at {{custom_values.booking_link}}. Budget: [Budget]. [contact.loyalty_tier] Reply STOP to opt out.");
    expect(conv.relations).toEqual(expect.arrayContaining([
      { from: t["Booking nudge"].id, to: "value.booking_link", relation: "value_token" }, { from: t["Booking nudge"].id, to: "field.contact.budget", relation: "field_token" },
    ]));
    const nudge = itemNamed(conv.report.items, "Booking nudge");
    expect(nudge.status).toBe("manual_review");
    expect(nudge.notes.join(" ")).toMatch(/custom field merge fields \(\{\{contact\.budget\}\}\)/);
    expect(nudge.notes.join(" ")).toMatch(/\{\{contact\.loyalty_tier\}\} has no iAcquire equivalent/);

    expect(t.Reminder.body).toBe("See you {{appointment.date}} at {{appointment.time}} with {{business.name}}. Manage: {{appointment.manage_link}}");
    expect(itemNamed(conv.report.items, "Reminder")).toMatchObject({ status: "needs_connection" });
    expect(itemNamed(conv.report.items, "Reminder").requirements).toEqual(expect.arrayContaining(["sms_provider", "template_approval"]));
    expect(validateContent(conv.content).errors).toEqual([]);
    expect(conv.validation.errors).toEqual([]);
  });

  it("turns email HTML into safe plain text: no scripts, no handlers, no entity-hidden markup, no GoHighLevel links or IDs", () => {
    const conv = convertGhlInventory(inv(), { includeValues: true, includePlaceholders: true, meta });
    const email = conv.content.assets.messageTemplates.find((x) => x.name === "Welcome email")!;
    expect(email.subject).toBe("Welcome to {{business.name}}");
    expect(email.body).toBe("Welcome {{contact.first_name}}!\n\nVisit our offer (https://www.example.com/offer) or this.\n\nsteal() Thanks & regards\n\nBook: [GoHighLevel link]");
    expect(email.body).not.toMatch(/<|script>|onerror|javascript:|Cal0000/);
    const item = itemNamed(conv.report.items, "Welcome email");
    expect(item.status).toBe("manual_review");
    expect(item.notes.join(" ")).toMatch(/1 attachment weren't carried|attachment/);
    const noSubject = conv.content.assets.messageTemplates.find((x) => x.name === "No subject")!;
    expect(noSubject).toMatchObject({ subject: "No subject", body: "Plain hello" });
  });

  it("WhatsApp templates are unsupported; unusable wording becomes a placeholder to rebuild", () => {
    const conv = convertGhlInventory(inv(), { includeValues: true, includePlaceholders: true, meta });
    expect(itemNamed(conv.report.items, "WhatsApp hello")).toMatchObject({ status: "unsupported", assetId: null });
    const unsafe = conv.content.assets.messageTemplates.find((x) => x.name === "Unsafe text")!;
    expect(unsafe).toMatchObject({ placeholder: true, body: "" });
    expect(itemNamed(conv.report.items, "Unsafe text")).toMatchObject({ status: "manual_review", placeholder: true });
    expect(itemNamed(conv.report.items, "Unsafe text").requirements).toContain("template_rebuild");
    const without = convertGhlInventory(inv(), { includeValues: true, includePlaceholders: false, meta });
    expect(without.content.assets.messageTemplates.some((x) => x.name === "Unsafe text")).toBe(false);
  });

  it("takes out anything the contract's own validator refuses and reports it as failed, so the package stays valid", () => {
    const values = Array.from({ length: 41 }, (_, i) => ({ id: gid("Val", 100 + i), name: `Value ${i}`, fieldKey: `{{ custom_values.v${i} }}`, value: null }));
    const crowded = inventoryWith({
      customValues: values,
      messageTemplates: [{ id: gid("Tpl", 50), name: "Too many tokens", type: "sms", body: values.map((_, i) => `{{custom_values.v${i}}}`).join(" "), subject: null, html: null, attachments: 0 }],
    }, ["customValues", "messageTemplates"]);
    const conv = convertGhlInventory(crowded, { includeValues: false, includePlaceholders: true, meta });
    const failed = itemNamed(conv.report.items, "Too many tokens");
    expect(failed).toMatchObject({ status: "failed", assetId: null });
    expect(failed.notes.join(" ")).toMatch(/at most 40 different tokens/);
    expect(conv.content.assets.messageTemplates).toHaveLength(0);
    expect(conv.relations.some((r) => r.relation === "value_token")).toBe(false);
    expect(conv.validation.errors).toEqual([]);
    expect(conv.report.summary.failed).toBe(1);
  });

  it("is deterministic: the same inventory converts to the same package and report", () => {
    const a = convertGhlInventory(inv(), { includeValues: true, includePlaceholders: true, meta });
    const b = convertGhlInventory(inv(), { includeValues: true, includePlaceholders: true, meta });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("text helpers", () => {
  it("htmlToText strips code and keeps readable structure", () => {
    expect(htmlToText("<ul><li>One</li><li>Two &amp; three</li></ul><p>Hi&nbsp;there<br>friend</p>")).toBe("• One\n\n• Two & three\n\nHi there\nfriend");
    expect(htmlToText("<style>p{}</style><p onclick=\"x()\">Safe</p><!-- hidden -->")).toBe("Safe");
  });

  it("cleanText refuses code and credentials, removes IDs and GoHighLevel links", () => {
    expect(cleanText("<script>x</script>Tap javascript:alert(1)", 200).text).toBeNull();
    expect(cleanText(`Key ${TEST_STRIPE_KEY}`, 200).text).toBeNull();
    expect(cleanText(`Form ${gid("Form", 1)} copy`, 80, { singleLine: true }).text).toBe("Form copy");
    expect(cleanText("Go to https://link.msgsndr.com/abc", 200).text).toBe("Go to [GoHighLevel link]");
  });

  it("convertGhlTokens never leaves braces behind", () => {
    const r = convertGhlTokens("{{ }} {{unknown.thing}} {% if x %}y{% endif %} }} {{", { values: new Map(), fields: new Map() });
    expect(r.text).not.toMatch(/\{\{|\}\}|\{%/);
    expect(r.removedLogic).toBe(true);
  });

  it("normalizes documented response pages and drops foreign or malformed rows", () => {
    const page = normalizeGhlPage("tags", { tags: [{ id: ID.tag(1), name: "a", locationId: LOC }, { id: ID.tag(2), name: "b", locationId: OTHER_LOC }, { name: "no id" }] }, LOC);
    expect(page).toMatchObject({ droppedForeign: 1, malformed: 1, rawCount: 3 });
    expect(page.records).toEqual([{ id: ID.tag(1), name: "a" }]);
    expect(normalizeGhlPage("tags", { nope: [] }, LOC).records).toBeNull();
    const cal: GhlCalendar = normalizeGhlPage("calendars", { calendars: [{ id: ID.cal(1), name: "C", slotDuration: 2, slotDurationUnit: "hours", allowBookingFor: 2, allowBookingForUnit: "months" }] }, LOC).records![0];
    expect(cal).toMatchObject({ slotDuration: 120, allowBookingFor: 60 });
  });

  it("the converted package from the full fixture lists every asset with a logical ID", async () => {
    const { detail } = await imported();
    for (const e of listAssets(detail.content!)) expect(e.id).toMatch(/^[a-z]+\.[a-z0-9._-]+$/);
  });
});
