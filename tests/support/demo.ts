// Fixtures for the prospect demo tests. Synthetic people only: no provider is contacted (the email provider is the capturing outbox) and the language model is never involved.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import type { SessionUser } from "@/server/auth/service";
import { agencyUser, createUser, uid } from "./fixtures";
import { registerProspect, confirmVerification, type DemoContext, type RegisterInput } from "@/server/demo/public";
import { readDemoSettings, saveDemoSettings } from "@/server/demo/settings";
import { reserveDemoMessage, completeDemoMessage, type ReserveResult } from "@/server/demo/chat";
import type { DemoSettings } from "@/lib/demo/settings";

export const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
export const count = async (table: string, where = "true", params: unknown[] = []) => Number((await rows<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params))[0].n);

/** The switches the demo needs on in this process: the deployment's own (DEMO_ENABLED) and none of the stops. The Super Admin's switch is the database row (openDemo). */
export function demoEnv(over: Record<string, string | undefined> = {}) {
  const wanted: Record<string, string | undefined> = { DEMO_ENABLED: "true", DEMO_PUBLIC_DISABLED: "false", ...over };
  for (const [k, v] of Object.entries(wanted)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

// The pace rules of the chat count in real time (not in the clock a test passes), so a test that sends many messages in a few milliseconds would meet them. Such a test relaxes
// them; the test of the pace itself puts the real values back.
const REAL_PACE = { prospect: RATE_LIMITS.demoMessageByProspect.limit, ip: RATE_LIMITS.demoMessageByIp.limit };
export function messagePace(mode: "real" | "relaxed") {
  RATE_LIMITS.demoMessageByProspect.limit = mode === "real" ? REAL_PACE.prospect : 100_000;
  RATE_LIMITS.demoMessageByIp.limit = mode === "real" ? REAL_PACE.ip : 100_000;
}

export interface Team {
  superAdmin: SessionUser;
  manager: SessionUser;
  staff: SessionUser;
}

/** The agency's people. The database allows one agency organization, but people with an agency role need none. */
export async function team(): Promise<Team> {
  const make = async (role: "agency_super_admin" | "agency_manager" | "agency_staff", name: string) => {
    const u = await createUser({ platformRole: role, name, email: `${role}-${uid()}@agency.test` });
    return agencyUser(u, role);
  };
  return { superAdmin: await make("agency_super_admin", "Sam Super"), manager: await make("agency_manager", "Mia Manager"), staff: await make("agency_staff", "Stu Staff") };
}

/** Saves the settings through the real service, as a Super Admin (the first save inserts the row). Saving what is already there is skipped: the service refuses an empty change. */
export async function openDemo(superAdmin: SessionUser, patch: Partial<DemoSettings> = {}): Promise<DemoSettings> {
  const stored = await withSystem((db) => readDemoSettings(db));
  const wanted: Partial<DemoSettings> = { enabled: true, ...patch };
  const current = stored.settings as unknown as Record<string, unknown>;
  const changed = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => JSON.stringify(current[k]) !== JSON.stringify(v)));
  if (!Object.keys(changed).length && stored.version > 0) return stored.settings;
  // The very first save has to write the row, even when every value is the default.
  const saved = await saveDemoSettings(superAdmin, Object.keys(changed).length ? changed : { enabled: true }, stored.version);
  return saved.settings;
}

// A fresh address for every call, so no test is slowed by another's rate limit (each test file has a database of its own, so a counter is enough).
let nextIp = 0;
export const ipFor = () => {
  nextIp += 1;
  return `10.${(nextIp >> 16) & 255}.${(nextIp >> 8) & 255}.${nextIp & 255}`;
};
let sequence = 0;
export const emailFor = (label = "p") => `${label}-${uid()}-${(sequence += 1)}@prospect.test`;

export const formInput = (over: Partial<RegisterInput> = {}): RegisterInput => ({
  name: "Pat Prospect",
  email: emailFor(),
  business: "Pat's Roofing",
  industry: "home_services",
  consent: true,
  ...over,
});

/** The newest demo link email sent to an address, as the token inside it. The capturing outbox keeps the text of every email. */
export async function linkTokenFor(email: string): Promise<string | null> {
  const r = await rows<{ body_text: string }>("select body_text from email_outbox where template = 'demo_link' and to_email = $1 order by created_at desc, id desc limit 1", [email]);
  const m = /\/demo\/verify\?token=([A-Za-z0-9_-]{43})/.exec(r[0]?.body_text ?? "");
  return m ? m[1] : null;
}

export const hashOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export interface Started {
  email: string;
  token: string;
  sessionToken: string;
  prospectId: string;
  ip: string;
  ctx: (over?: Partial<DemoContext>) => DemoContext;
}

/** Registers, reads the emailed link and presses its button: a prospect inside an open window with a session. */
export async function startDemo(over: Partial<RegisterInput> = {}, at: Date = new Date()): Promise<Started> {
  const input = formInput(over);
  const ip = ipFor();
  const registered = await registerProspect(input, { ip, now: at });
  if (!registered.ok) throw new Error(`registration refused: ${registered.reason}`);
  const email = String(input.email).trim().toLowerCase();
  const token = await linkTokenFor(email);
  if (!token) throw new Error("no link was emailed");
  const confirmed = await confirmVerification(token, { ip, now: at, userAgent: "vitest" });
  if (!confirmed.ok) throw new Error(`confirmation refused: ${confirmed.reason}`);
  const p = (await rows<{ id: string }>("select id from demo_prospects where email_normalized = $1 or work_email = $2", [email, email]))[0];
  return { email, token, sessionToken: confirmed.sessionToken, prospectId: p.id, ip, ctx: (extra = {}) => ({ ip, sessionToken: confirmed.sessionToken, now: at, ...extra }) };
}

let ids = 0;
export const messageId = () => `msg-${uid()}-${(ids += 1)}`.padEnd(12, "x");

/** Sends one chat message to the end: reserved, answered. */
export async function say(s: Started, text: string, over: { at?: Date; employeeRole?: string } = {}): Promise<ReserveResult> {
  const reserved = await reserveDemoMessage({ text, clientMessageId: messageId(), employeeRole: over.employeeRole }, s.ctx(over.at ? { now: over.at } : {}));
  if (!reserved.ok) throw new Error(`message refused: ${reserved.reason}`);
  if (reserved.kind === "reserved") await completeDemoMessage({ prospectId: reserved.prospectId, messageId: reserved.messageId, reply: `Answer to: ${text}`, now: over.at });
  return reserved;
}

export const prospectRow = async (id: string) => (await rows<Record<string, unknown>>("select * from demo_prospects where id = $1", [id]))[0];
