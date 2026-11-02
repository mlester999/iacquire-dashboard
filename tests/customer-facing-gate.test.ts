// When a client may switch customer-facing activity ON: automatic replies, the website chat, appointment reminders, letting the AI book, and the public booking page. Behind the
// default-off switch CLIENT_CUSTOMER_FACING_GATE_ENABLED. With it off nothing changes; with it on a client's switch-ON waits for the setup payment and, for the three calendar
// activities, a calendar that has passed its checks. The agency's own workspace and demo workspaces are never held back, switching OFF is never refused, and one workspace's state
// never decides another's answer. Synthetic workspaces only, test database only; nothing here sends a message.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { updateMessagingSettings } from "@/server/messaging/inbox";
import { ensureWidget, saveWidgetSettings } from "@/server/webchat/config";
import { savePolicy } from "@/server/appointments/settings";
import { createAppointmentType, createCalendar, setCalendarPublic, setHostAvailability, updateCalendar } from "@/server/calendars/setup";
import { CALENDAR_DEPENDENT_ACTIVITIES, CUSTOMER_FACING_ACTIVITIES, assertCustomerFacingAllowed, customerFacingAllowed, type CustomerFacingActivity } from "@/server/setup/customer-facing-gate";
import { createOrg, ctxFor } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { clearSetupPayment } from "./support/billing";
import { WEEKDAYS } from "./support/launch";

const before = process.env.CLIENT_CUSTOMER_FACING_GATE_ENABLED;
const flag = (on: boolean) => {
  process.env.CLIENT_CUSTOMER_FACING_GATE_ENABLED = on ? "true" : "false";
  resetEnvCache();
};
beforeAll(() => flag(false));
afterAll(() => {
  if (before === undefined) delete process.env.CLIENT_CUSTOMER_FACING_GATE_ENABLED;
  else process.env.CLIENT_CUSTOMER_FACING_GATE_ENABLED = before;
  resetEnvCache();
});

type CalendarState = "none" | "unverified" | "verified";

/** A client workspace with the owner, optionally with the setup payment cleared and a calendar that has, or has not, what its checks ask for. */
async function client(opts: { paid: boolean; calendar: CalendarState; demo?: boolean }) {
  const c = await crmOrg({ name: "Gate Test Client", timezone: "America/Chicago" });
  const owner = c.people.owner;
  const actor = c.actor("owner");
  if (opts.paid) await clearSetupPayment(c.org.id);
  if (opts.demo) await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [c.org.id]));
  let calendarId: string | null = null;
  if (opts.calendar !== "none") {
    // "unverified": a calendar with its host but no weekly hours and nothing to book, so its checks fail. "verified": hours, a time zone and an appointment type.
    if (opts.calendar === "verified") await setHostAvailability(actor, owner.id, { timezone: "America/Chicago", rules: WEEKDAYS });
    const calendar = await createCalendar(actor, { name: "Consultations", members: [{ userId: owner.id }], isDefault: true });
    calendarId = calendar.id;
    if (opts.calendar === "verified") await createAppointmentType(actor, calendar.id, { name: "Free consultation", durationMinutes: 30, minNoticeMinutes: 60, maxDaysAhead: 30 });
  }
  return { ...c, owner, actor, ctx: ctxFor(owner, c.org, "owner"), calendarId };
}
type Client = Awaited<ReturnType<typeof client>>;

const rows = async <T>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const autoReplyOn = async (c: Client) => (await rows<{ auto_reply_enabled: boolean }>("select auto_reply_enabled from messaging_settings where org_id = $1", [c.org.id]))[0]?.auto_reply_enabled ?? false;
const widgetRow = async (c: Client) => (await rows<{ enabled: boolean; ai_enabled: boolean; allow_booking: boolean; version: number }>("select enabled, ai_enabled, allow_booking, version from web_chat_widgets where org_id = $1", [c.org.id]))[0];
const policyRow = async (c: Client) => (await rows<{ ai_booking_enabled: boolean; reminders_enabled: boolean }>("select ai_booking_enabled, reminders_enabled from appointment_settings where org_id = $1", [c.org.id]))[0] ?? { ai_booking_enabled: false, reminders_enabled: false };
const pageOn = async (c: Client) => (await rows<{ public: boolean }>("select public from crm_calendars where id = $1", [c.calendarId]))[0].public;
const auditCount = async (c: Client) => Number((await rows<{ n: string }>("select count(*) as n from audit_logs where org_id = $1 and action in ('messaging.settings_changed', 'webchat.settings_saved', 'appointments.policy_changed', 'crm.calendar_published')", [c.org.id]))[0].n);
const widgetVersion = async (c: Client) => (await withSystem((db) => ensureWidget(db, c.org.id))).version;

/** Each way a client switches an activity ON, as the person does it. */
const SWITCH_ON: Record<CustomerFacingActivity, (c: Client) => Promise<unknown>> = {
  auto_reply: (c) => updateMessagingSettings(c.ctx, { autoReplyEnabled: true }),
  webchat_widget: async (c) => saveWidgetSettings(c.ctx, { enabled: true, allowedOrigins: ["https://shop.example.com"] }, await widgetVersion(c)),
  appointment_reminders: (c) => savePolicy(c.ctx, { remindersEnabled: true }),
  ai_booking: (c) => savePolicy(c.ctx, { aiBookingEnabled: true }),
  public_booking_page: (c) => setCalendarPublic(c.actor, c.calendarId as string, true),
};
const SWITCH_OFF: Record<CustomerFacingActivity, (c: Client) => Promise<unknown>> = {
  auto_reply: (c) => updateMessagingSettings(c.ctx, { autoReplyEnabled: false }),
  webchat_widget: async (c) => saveWidgetSettings(c.ctx, { enabled: false }, await widgetVersion(c)),
  appointment_reminders: (c) => savePolicy(c.ctx, { remindersEnabled: false }),
  ai_booking: (c) => savePolicy(c.ctx, { aiBookingEnabled: false }),
  public_booking_page: (c) => setCalendarPublic(c.actor, c.calendarId as string, false),
};
const IS_ON: Record<CustomerFacingActivity, (c: Client) => Promise<boolean>> = {
  auto_reply: autoReplyOn,
  webchat_widget: async (c) => (await widgetRow(c))?.enabled ?? false,
  appointment_reminders: async (c) => (await policyRow(c)).reminders_enabled,
  ai_booking: async (c) => (await policyRow(c)).ai_booking_enabled,
  public_booking_page: pageOn,
};
/** Puts an activity ON without the gate (as it would already be before the deployment switched the gate on), so switching it OFF can be tried. */
async function forceOn(c: Client, activity: CustomerFacingActivity) {
  await withSystem(async (db) => {
    if (activity === "auto_reply") await db.query("insert into messaging_settings (org_id, auto_reply_enabled) values ($1, true) on conflict (org_id) do update set auto_reply_enabled = true", [c.org.id]);
    if (activity === "webchat_widget") {
      await ensureWidget(db, c.org.id);
      await db.query("update web_chat_widgets set enabled = true, allowed_origins = array['shop.example.com'] where org_id = $1", [c.org.id]);
    }
    if (activity === "appointment_reminders") await db.query("insert into appointment_settings (org_id, reminders_enabled) values ($1, true) on conflict (org_id) do update set reminders_enabled = true", [c.org.id]);
    if (activity === "ai_booking") await db.query("insert into appointment_settings (org_id, ai_booking_enabled) values ($1, true) on conflict (org_id) do update set ai_booking_enabled = true", [c.org.id]);
    if (activity === "public_booking_page") await db.query("update crm_calendars set public = true where id = $1", [c.calendarId]);
  });
}

describe("the deployment switch is off (the default)", () => {
  it("every switch behaves exactly as before for a client that has paid nothing and set nothing up", async () => {
    flag(false);
    const c = await client({ paid: false, calendar: "verified" });
    for (const activity of CUSTOMER_FACING_ACTIVITIES) {
      await expect(SWITCH_ON[activity](c), activity).resolves.not.toThrow();
      expect(await IS_ON[activity](c), `${activity} is on`).toBe(true);
    }
    expect(await customerFacingAllowed(await dbOf(), c.org.id, "ai_booking")).toEqual({ allowed: true, gateOn: false, reason: null, missing: null });
  });

  it("a client with no calendar at all can still switch the calendar activities on, as always", async () => {
    flag(false);
    const c = await client({ paid: false, calendar: "none" });
    await SWITCH_ON.appointment_reminders(c);
    await SWITCH_ON.ai_booking(c);
    expect(await policyRow(c)).toEqual({ ai_booking_enabled: true, reminders_enabled: true });
  });
});

/** The database allows one agency workspace, so the first test that needs it creates it and the rest reuse it. */
async function agencyOrgId() {
  const found = await rows<{ id: string }>("select id from organizations where kind = 'agency' limit 1", []);
  return found[0]?.id ?? (await createOrg({ name: "Agency Gate Test", kind: "agency" })).id;
}

async function dbOf() {
  // A small stand-in queryable that runs each query in its own system transaction (the gate only reads).
  return { query: <R,>(sql: string, params?: unknown[]) => withSystem((db) => db.query<R & Record<string, unknown>>(sql, params)) } as unknown as import("@/server/db").Queryable;
}

describe("the deployment switch is on and the setup payment is not cleared", () => {
  for (const activity of CUSTOMER_FACING_ACTIVITIES) {
    it(`switching ${activity} ON is refused with a plain reason and changes nothing, and switching it OFF still works`, async () => {
      flag(true);
      const c = await client({ paid: false, calendar: "verified" });
      const auditBefore = await auditCount(c);
      await expect(SWITCH_ON[activity](c)).rejects.toThrow(/^Finish setup first: your setup payment has not been confirmed yet\./);
      expect(await IS_ON[activity](c)).toBe(false);
      expect(await auditCount(c), "a refusal writes no audit row").toBe(auditBefore);
      // Already on before the gate was switched on: turning it off is never held.
      await forceOn(c, activity);
      expect(await IS_ON[activity](c)).toBe(true);
      await expect(SWITCH_OFF[activity](c)).resolves.not.toThrow();
      expect(await IS_ON[activity](c)).toBe(false);
    });
  }

  it("saving something else while an activity is already on is not a switch-ON and is never held", async () => {
    flag(true);
    const c = await client({ paid: false, calendar: "verified" });
    await forceOn(c, "auto_reply");
    await expect(updateMessagingSettings(c.ctx, { autoReplyEnabled: true, followUpPreset: "gentle" })).resolves.not.toThrow();
    await forceOn(c, "ai_booking");
    await expect(savePolicy(c.ctx, { aiBookingEnabled: true, slotMinutes: 30 })).resolves.not.toThrow();
    expect(await autoReplyOn(c)).toBe(true);
  });

  it("the chat's other switches are held only while the chat is live: the AI answering visitors and visitors booking through it", async () => {
    flag(true);
    const c = await client({ paid: false, calendar: "verified" });
    // The chat is off, so nothing is live yet and these can be prepared.
    await expect(saveWidgetSettings(c.ctx, { aiEnabled: true, allowBooking: true }, await widgetVersion(c))).resolves.not.toThrow();
    await forceOn(c, "webchat_widget");
    await withSystem((db) => db.query("update web_chat_widgets set ai_enabled = false, allow_booking = false where org_id = $1", [c.org.id]));
    await expect(saveWidgetSettings(c.ctx, { aiEnabled: true }, await widgetVersion(c))).rejects.toThrow(/Finish setup first/);
    await expect(saveWidgetSettings(c.ctx, { allowBooking: true }, await widgetVersion(c))).rejects.toThrow(/Finish setup first/);
    const w = await widgetRow(c);
    expect([w.ai_enabled, w.allow_booking]).toEqual([false, false]);
  });
});

describe("the deployment switch is on, the payment is cleared, and the calendar is not ready", () => {
  it("the three calendar activities are refused with a reason about the calendar; automatic replies and the website chat are allowed", async () => {
    flag(true);
    const c = await client({ paid: true, calendar: "unverified" });
    for (const activity of ["appointment_reminders", "ai_booking"] as const) {
      await expect(SWITCH_ON[activity](c), activity).rejects.toThrow(/^Finish setup first: .* needs a working calendar\. Consultations has not passed its checks yet:/);
      expect(await IS_ON[activity](c)).toBe(false);
    }
    // The public page is refused by the calendar's own publishing checks first, and the gate says the same through the read helper.
    await expect(SWITCH_ON.public_booking_page(c)).rejects.toThrow();
    expect(await pageOn(c)).toBe(false);
    const decision = await customerFacingAllowed(await dbOf(), c.org.id, "public_booking_page", { calendarId: c.calendarId as string });
    expect(decision).toMatchObject({ allowed: false, gateOn: true, missing: "calendar" });
    expect(decision.reason).toMatch(/^Finish setup first:/);
    await expect(SWITCH_ON.auto_reply(c)).resolves.not.toThrow();
    await expect(SWITCH_ON.webchat_widget(c)).resolves.not.toThrow();
  });

  it("a workspace with no calendar at all is told there is no active calendar", async () => {
    flag(true);
    const c = await client({ paid: true, calendar: "none" });
    await expect(SWITCH_ON.appointment_reminders(c)).rejects.toThrow(/There is no active calendar yet/);
    await expect(SWITCH_ON.ai_booking(c)).rejects.toThrow(/There is no active calendar yet/);
    expect(await policyRow(c)).toEqual({ ai_booking_enabled: false, reminders_enabled: false });
  });

  it("a calendar that is still a draft does not count", async () => {
    flag(true);
    const c = await client({ paid: true, calendar: "verified" });
    await withSystem((db) => db.query("update crm_calendars set status = 'draft', is_default = false where id = $1", [c.calendarId]));
    await expect(SWITCH_ON.ai_booking(c)).rejects.toThrow(/There is no active calendar yet/);
  });
});

describe("the deployment switch is on, the payment is cleared, and the calendar has passed its checks", () => {
  it("every activity is allowed", async () => {
    flag(true);
    const c = await client({ paid: true, calendar: "verified" });
    for (const activity of CUSTOMER_FACING_ACTIVITIES) {
      await expect(SWITCH_ON[activity](c), activity).resolves.not.toThrow();
      expect(await IS_ON[activity](c), `${activity} is on`).toBe(true);
    }
  });

  it("the public page can also be switched on through the calendar's own edit", async () => {
    flag(true);
    const unpaid = await client({ paid: false, calendar: "verified" });
    await expect(updateCalendar(unpaid.actor, unpaid.calendarId as string, { public: true })).rejects.toThrow(/^Finish setup first: your setup payment/);
    expect(await pageOn(unpaid)).toBe(false);
    const paid = await client({ paid: true, calendar: "verified" });
    await expect(updateCalendar(paid.actor, paid.calendarId as string, { public: true })).resolves.toBeTruthy();
    expect(await pageOn(paid)).toBe(true);
  });
});

describe("the agency's workspace and demo workspaces are never held back", () => {
  for (const on of [false, true]) {
    it(`the agency workspace is allowed everything with the deployment switch ${on ? "on" : "off"}`, async () => {
      flag(on);
      const agencyId = await agencyOrgId();
      for (const activity of CUSTOMER_FACING_ACTIVITIES) {
        expect(await customerFacingAllowed(await dbOf(), agencyId, activity)).toMatchObject({ allowed: true, reason: null });
      }
    });

    it(`a demo workspace that has paid nothing and has no calendar switches everything on with the deployment switch ${on ? "on" : "off"}`, async () => {
      flag(on);
      const c = await client({ paid: false, calendar: "none", demo: true });
      await expect(SWITCH_ON.auto_reply(c)).resolves.not.toThrow();
      await expect(SWITCH_ON.webchat_widget(c)).resolves.not.toThrow();
      await expect(SWITCH_ON.appointment_reminders(c)).resolves.not.toThrow();
      await expect(SWITCH_ON.ai_booking(c)).resolves.not.toThrow();
      expect(await policyRow(c)).toEqual({ ai_booking_enabled: true, reminders_enabled: true });
    });
  }
});

describe("one workspace's state never decides another's answer", () => {
  it("a ready client does not open the gate for an unready one, and the other way round", async () => {
    flag(true);
    const ready = await client({ paid: true, calendar: "verified" });
    const unready = await client({ paid: false, calendar: "none" });
    // The unready client is refused although a ready client exists in the same deployment.
    await expect(SWITCH_ON.auto_reply(unready)).rejects.toThrow(/Finish setup first/);
    await expect(SWITCH_ON.appointment_reminders(unready)).rejects.toThrow(/Finish setup first/);
    // A client that has paid but has no calendar of its own is not helped by the other client's verified one.
    const paidNoCalendar = await client({ paid: true, calendar: "none" });
    await expect(SWITCH_ON.ai_booking(paidNoCalendar)).rejects.toThrow(/There is no active calendar yet/);
    // And the ready client is allowed although the others are not.
    await expect(SWITCH_ON.auto_reply(ready)).resolves.not.toThrow();
    await expect(SWITCH_ON.appointment_reminders(ready)).resolves.not.toThrow();
  });
});

describe("the gate itself", () => {
  it("lists exactly the five activities and the three that need a calendar", () => {
    expect([...CUSTOMER_FACING_ACTIVITIES]).toEqual(["auto_reply", "webchat_widget", "appointment_reminders", "ai_booking", "public_booking_page"]);
    expect([...CALENDAR_DEPENDENT_ACTIVITIES]).toEqual(["appointment_reminders", "ai_booking", "public_booking_page"]);
  });

  it("refuses a workspace that does not exist and writes nothing", async () => {
    flag(true);
    await expect(assertCustomerFacingAllowed(await dbOf(), "00000000-0000-4000-8000-000000000000", "auto_reply")).rejects.toThrow(/workspace was not found/);
  });
});
