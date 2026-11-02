// Everything that makes something reach a client's CUSTOMERS starts switched off, whatever the deployment's gate says: a new client workspace has automatic replies, the website chat, the
// AI answering and booking through the chat, appointment reminders, AI booking and the public booking page all OFF until the client (or iAcquire) turns them on. The gate
// (src/server/setup/customer-facing-gate.ts, CLIENT_CUSTOMER_FACING_GATE_ENABLED) then decides WHEN a client may; this proves where they all begin. Test database only.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { loadPolicy } from "@/server/appointments/availability";
import { CUSTOMER_FACING_ACTIVITIES } from "@/server/setup/customer-facing-gate";
import { createOrg } from "./support/fixtures";

/**
 * Where each customer-facing MASTER switch lives and the column that holds it. Each is the switch that, while it is off, keeps that kind of activity from reaching a customer at all.
 */
const MASTER_SWITCHES: Array<{ activity: (typeof CUSTOMER_FACING_ACTIVITIES)[number]; table: string; column: string }> = [
  { activity: "auto_reply", table: "messaging_settings", column: "auto_reply_enabled" },
  { activity: "webchat_widget", table: "web_chat_widgets", column: "enabled" },
  { activity: "appointment_reminders", table: "appointment_settings", column: "reminders_enabled" },
  { activity: "ai_booking", table: "appointment_settings", column: "ai_booking_enabled" },
  { activity: "public_booking_page", table: "crm_calendars", column: "public" },
];

/**
 * Two options inside the website chat only matter once its master switch is on. They are recorded here as they ship so a change is noticed, not as a requirement: the chat is built
 * AI-first, so the AI answering visitors and visitors booking through it start ON inside a chat that is itself OFF, and a client who switches the chat on (which the gate holds until
 * setup is finished) gets both. Starting them off is a product decision, not a default this build changed: the whole chat flow assumes them on. See the milestone status, section 6.
 */
const CHAT_OPTIONS: Array<{ column: string; default: string }> = [
  { column: "ai_enabled", default: "true" },
  { column: "allow_booking", default: "true" },
];

describe("customer-facing activity starts off", () => {
  it("every master switch the gate guards defaults to false in the schema", async () => {
    for (const s of MASTER_SWITCHES) {
      const row = (await withSystem((db) => db.query<{ column_default: string | null; is_nullable: string }>(
        "select column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2", [s.table, s.column],
      ))).rows[0];
      expect(row, `${s.table}.${s.column} exists`).toBeDefined();
      expect(row.column_default, `${s.table}.${s.column} (${s.activity}) starts off`).toBe("false");
    }
    // All five activities the gate guards have a master switch here.
    expect(new Set(MASTER_SWITCHES.map((s) => s.activity))).toEqual(new Set(CUSTOMER_FACING_ACTIVITIES));
  });

  it("the options inside the website chat are recorded as they ship, and the chat they sit in is off", async () => {
    for (const o of CHAT_OPTIONS) {
      const row = (await withSystem((db) => db.query<{ column_default: string | null }>(
        "select column_default from information_schema.columns where table_schema = 'public' and table_name = 'web_chat_widgets' and column_name = $1", [o.column],
      ))).rows[0];
      expect(row?.column_default, `web_chat_widgets.${o.column}`).toBe(o.default);
    }
  });

  it("a new client workspace has no automatic reply, no live chat, no reminders and no AI booking", async () => {
    const org = await createOrg({ name: "Starts Off Roofing" });
    const policy = await withSystem((db) => loadPolicy(db, org.id));
    expect(policy.aiBookingEnabled).toBe(false);
    expect(policy.remindersEnabled).toBe(false);
    const messaging = (await withSystem((db) => db.query<{ auto_reply_enabled: boolean }>("select auto_reply_enabled from messaging_settings where org_id = $1", [org.id]))).rows[0];
    expect(messaging?.auto_reply_enabled ?? false).toBe(false);
    const widget = (await withSystem((db) => db.query<{ enabled: boolean }>("select enabled from web_chat_widgets where org_id = $1", [org.id]))).rows[0];
    expect(widget?.enabled ?? false).toBe(false);
    expect((await withSystem((db) => db.query("select 1 from crm_calendars where org_id = $1 and public", [org.id]))).rows).toHaveLength(0);
  });
});
