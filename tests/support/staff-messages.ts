// Fixtures for the staff Messages tests (migration 0096). Synthetic people only. The database holds ONE agency workspace, so it is made once per test file and shared; every test
// makes its own people, so conversations never touch each other.
import crypto from "node:crypto";
import { withSystem, withUser, type Queryable } from "@/server/db";
import type { PlatformRole } from "@/lib/permissions";
import { agencyUser, createOrg, createUser, uid } from "./fixtures";
import { STAFF_MESSAGES_FEATURE } from "@/lib/staff-messages/limits";

export type AgencyRole = "agency_staff" | "agency_manager" | "agency_super_admin";

/** What the services take: the session's id and role, like a signed-in person's. */
export interface Person {
  id: string;
  email: string;
  platformRole: PlatformRole;
  name: string;
}

export const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
export const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(`select count(*)::text as n from (${sql}) x`, params))[0].n);

let agency: string | undefined;
/** The agency workspace, made on first use (a fresh database has none). */
export async function agencyOrgId(): Promise<string> {
  if (agency) return agency;
  const found = await rows<{ id: string }>("select id from organizations where kind = 'agency'");
  agency = found[0]?.id ?? (await createOrg({ name: "iAcquire Agency", kind: "agency" })).id;
  return agency;
}

/** Switches staff Messages on or off the way a Super Admin does (a row in org_features on the agency workspace; no row means off). */
export async function setMessages(on: boolean | null): Promise<void> {
  const org = await agencyOrgId();
  await withSystem(async (db) => {
    if (on === null) await db.query("delete from org_features where org_id = $1 and feature = $2", [org, STAFF_MESSAGES_FEATURE]);
    else await db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, $3) on conflict (org_id, feature) do update set enabled = excluded.enabled", [org, STAFF_MESSAGES_FEATURE, on]);
  });
}

export async function staffPerson(role: AgencyRole | "none" = "agency_staff", name?: string): Promise<Person> {
  const label = name ?? `${role === "agency_super_admin" ? "Super" : role === "agency_manager" ? "Manager" : role === "none" ? "Client" : "Staff"} ${uid()}`;
  const user = await createUser({ platformRole: role, name: label });
  return { ...agencyUser(user, role === "none" ? "agency_staff" : role), platformRole: role, name: label, email: user.email };
}

export interface World {
  agencyId: string;
  superAdmin: Person;
  manager: Person;
  staff: Person;
  staff2: Person;
  staff3: Person;
}

/** The agency workspace with Messages switched on, a Super Admin, a manager and three staff members. */
export async function staffWorld(): Promise<World> {
  const agencyId = await agencyOrgId();
  await setMessages(true);
  return {
    agencyId,
    superAdmin: await staffPerson("agency_super_admin"),
    manager: await staffPerson("agency_manager"),
    staff: await staffPerson("agency_staff"),
    staff2: await staffPerson("agency_staff"),
    staff3: await staffPerson("agency_staff"),
  };
}

/** A per-person override, the way the team page records a deny or an allow. */
export async function override(userId: string, permission: string, effect: "allow" | "deny"): Promise<void> {
  await withSystem((db) =>
    db.query("insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, $2, $3) on conflict (user_id, permission) do update set effect = excluded.effect", [userId, permission, effect]),
  );
}
export const clearOverride = (userId: string, permission: string) => withSystem((db) => db.query("delete from agency_user_permission_overrides where user_id = $1 and permission = $2", [userId, permission]));

export const disable = (userId: string) => withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [userId]));
export const enable = (userId: string) => withSystem((db) => db.query("update users set status = 'active' where id = $1", [userId]));
export const setRole = (userId: string, role: PlatformRole) => withSystem((db) => db.query("update users set platform_role = $2 where id = $1", [userId, role]));

/** Rows as the signed-in person sees them: the application role under row-level security, which is what a server read uses. */
export async function asUser<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []): Promise<Array<T & Record<string, unknown>>> {
  return withUser(userId, async (db: Queryable) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);
}

export const freshId = () => crypto.randomUUID();

/** Splits a SQL script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}

/**
 * Starts a fixed-window rate limit counter at `hits` for the window that is running now, after waiting (if the window is about to end) for the next one, so the counter cannot
 * roll over in the middle of a test. The key is the person's id, as the services use it.
 */
export async function seedRateHits(rule: { name: string; windowSeconds: number }, key: string, hits: number): Promise<void> {
  const windowMs = rule.windowSeconds * 1000;
  const left = windowMs - (Date.now() % windowMs);
  if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  await withSystem((db) =>
    db.query("insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, $3) on conflict (bucket_key, window_start) do update set hits = excluded.hits", [`${rule.name}:${key}`, start, hits]),
  );
}

/** A name no other test uses, for a channel (names are unique among live channels). */
export const channelName = (prefix = "ch") => `${prefix}-${uid()}`;

/** A small PDF that passes the signature check (the first four bytes) and is otherwise nothing. */
export const pdfBytes = (extra = "") => Buffer.from(`%PDF-1.4\n% staff messages test ${extra}\n%%EOF\n`);
export const pngBytes = () => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("0000000000000000", "hex")]);
