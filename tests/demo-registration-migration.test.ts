// Migration 0113: the replay ledger of the signed marketing registration, and the database rule that a demo's first access is written once. Each rollback case runs inside a
// transaction that is always rolled back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { rows } from "./support/demo";

class Done extends Error {}
const up = readFileSync("supabase/migrations/0113_demo_registration_requests.sql", "utf8");
const down = readFileSync("supabase/rollbacks/0113_demo_registration_requests.down.sql", "utf8");

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
function statements(sql: string): string[] {
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

const hash = (c: string) => c.repeat(64);
const insertRequest = (idHash = hash("a"), bodyHash = hash("b")) =>
  rows("insert into demo_registration_requests (request_id_hash, body_sha256) values ($1, $2) returning received_at", [idHash, bodyHash]);

let seq = 0;
async function newProspect(): Promise<string> {
  seq += 1;
  const email = `mig-reg-${seq}-${Math.random().toString(36).slice(2)}@mig.test`;
  return (await rows<{ id: string }>("insert into demo_prospects (name, work_email, email_normalized, business_name, industry) values ('Mig Person', $1, $1, 'Mig Co', 'other') returning id", [email]))[0].id;
}

describe("the replay ledger", () => {
  it("is server-only: row-level security on, no policy, and no grant to any role", async () => {
    const meta = (await rows<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'demo_registration_requests'"))[0];
    expect(meta.relrowsecurity).toBe(true);
    expect(await rows("select 1 from pg_policies where tablename = 'demo_registration_requests'")).toEqual([]);
    for (const role of ["public", "anon", "authenticated", "iaq_app_user", "iaq_site_runtime"]) {
      const exists = await rows<{ n: number }>("select count(*)::int as n from pg_roles where rolname = $1", [role]);
      if (!exists[0].n) continue;
      for (const privilege of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
        expect((await rows<{ ok: boolean }>("select has_table_privilege($1, 'demo_registration_requests', $2) as ok", [role, privilege]))[0].ok, `${role} ${privilege}`).toBe(false);
      }
    }
  });

  it("holds two SHA-256 hashes only: a raw id, an upper-case digest and a short digest are all refused", async () => {
    await expect(rows("insert into demo_registration_requests (request_id_hash, body_sha256) values ('a-raw-request-id', $1)", [hash("b")])).rejects.toThrow(/check/);
    await expect(insertRequest(hash("A"), hash("b"))).rejects.toThrow(/check/);
    await expect(insertRequest(hash("a"), "abc")).rejects.toThrow(/check/);
    await expect(insertRequest(hash("a"), hash("b"))).resolves.toBeTruthy();
  });

  it("remembers one row per request id, so the second claim collides", async () => {
    await insertRequest(hash("c"), hash("d"));
    await expect(insertRequest(hash("c"), hash("e"))).rejects.toThrow(/duplicate key/);
    // The same id with the same body is the caller retrying; the application treats the conflict as that retry.
    await expect(insertRequest(hash("c"), hash("d"))).rejects.toThrow(/duplicate key/);
  });

  it("keeps a received time and an index for the 24-hour sweep", async () => {
    const inserted = await insertRequest(hash("f"), hash("0"));
    expect(inserted[0].received_at).toBeInstanceOf(Date);
    const index = await rows("select 1 from pg_indexes where tablename = 'demo_registration_requests' and indexname = 'demo_registration_requests_received_idx'");
    expect(index).toHaveLength(1);
  });
});

describe("the first-access rule in the database", () => {
  const confirmed = async () => {
    const id = await newProspect();
    await rows("update demo_prospects set status = 'active', verified_at = now(), window_ends_at = now() + interval '24 hours' where id = $1", [id]);
    return id;
  };

  it("refuses to move first access once it is written", async () => {
    const id = await confirmed();
    await expect(rows("update demo_prospects set verified_at = now() + interval '1 hour' where id = $1", [id])).rejects.toThrow(/first access cannot be changed/);
    await expect(rows("update demo_prospects set verified_at = now() - interval '1 hour' where id = $1", [id])).rejects.toThrow(/first access cannot be changed/);
    await expect(rows("update demo_prospects set verified_at = null where id = $1", [id])).rejects.toThrow(/first access cannot be changed/);
  });

  it("refuses to remove the window, and refuses to shorten it except by ending the demo now", async () => {
    const id = await confirmed();
    await expect(rows("update demo_prospects set window_ends_at = null where id = $1", [id])).rejects.toThrow(/cannot lose its window/);
    await expect(rows("update demo_prospects set window_ends_at = window_ends_at - interval '1 hour' where id = $1", [id])).rejects.toThrow(/cannot be shortened/);
    await expect(rows("update demo_prospects set window_ends_at = verified_at - interval '1 minute' where id = $1", [id])).rejects.toThrow(/cannot be shortened/);
    // Ending the demo now is allowed even when the prospect asked for a consultation or pressed Buy (the service keeps that status).
    await rows("update demo_prospects set status = 'consultation_requested', consultation_requested_at = now() where id = $1", [id]);
    await rows("update demo_prospects set window_ends_at = now() where id = $1", [id]);
    expect((await rows<{ status: string }>("select status from demo_prospects where id = $1", [id]))[0].status).toBe("consultation_requested");
    // Extending it again moves the end forward and opens it.
    await rows("update demo_prospects set window_ends_at = now() + interval '2 hours', status = 'active' where id = $1", [id]);
  });

  it("does not stop the rest of a prospect's life: messages, status, details and erasure still change", async () => {
    const id = await confirmed();
    await rows("update demo_prospects set messages_used = 10 where id = $1", [id]);
    await rows("update demo_prospects set extra_messages = 5, messages_used = 12 where id = $1", [id]);
    await rows("update demo_prospects set status = 'consultation_requested', consultation_requested_at = now() where id = $1", [id]);
    await rows("update demo_prospects set status = 'purchase_started', purchase_started_at = now() where id = $1", [id]);
    await rows("update demo_prospects set name = null, work_email = null, email_normalized = null, business_name = null, erased_at = now() where id = $1", [id]);
    expect((await rows<{ verified_at: Date | null; window_ends_at: Date | null }>("select verified_at, window_ends_at from demo_prospects where id = $1", [id]))[0]).toMatchObject({ verified_at: expect.any(Date), window_ends_at: expect.any(Date) });
  });
});

describe("the rollback", () => {
  const rollBack = (before: (db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>) =>
    withSystem(async (db) => {
      await before(db);
      for (const stmt of statements(down)) await db.query(stmt);
      const table = await db.query<{ n: number }>("select count(*)::int as n from pg_class where relname = 'demo_registration_requests'");
      const fn = await db.query<{ n: number }>("select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'app' and p.proname = 'demo_first_access_guard'");
      const trigger = await db.query<{ n: number }>("select count(*)::int as n from pg_trigger where tgname = 'demo_first_access_guard'");
      throw Object.assign(new Done(), { table: table.rows[0].n, fn: fn.rows[0].n, trigger: trigger.rows[0].n });
    });

  it("refuses while the ledger holds a request (the endpoint must be off and the rows gone first)", async () => {
    await expect(rollBack(async (db) => { await db.query("insert into demo_registration_requests (request_id_hash, body_sha256) values (repeat('9', 64), repeat('8', 64))"); })).rejects.toThrow(/rollback refused/);
  });

  it("drops the ledger, the trigger and the function when it is safe, and nothing else", async () => {
    const result = await rollBack(async (db) => {
      await db.query("delete from demo_registration_requests");
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Done);
    expect(result).toMatchObject({ table: 0, fn: 0, trigger: 0 });
    // The rules live in the service as well, so removing the database guard takes nothing else with it.
    expect(up).toContain("demo_first_access_guard");
    expect(down).toContain("drop trigger if exists demo_first_access_guard");
  });
});
