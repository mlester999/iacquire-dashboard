// Migration 0115: the ledger of credentials a client's AI employee presents to the client business tools. It must be server-only, refuse a row for another workspace's employee, hold at
// most one active and one rotating_out credential per employee, store only a hash, and roll back only when nothing live is left. Each rollback case runs inside a transaction that is
// always rolled back.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, type Queryable } from "@/server/db";
import { agentId, createOrg, uid } from "./support/fixtures";

class Done extends Error {}
const up = readFileSync("supabase/migrations/0115_client_business_credentials.sql", "utf8");
const down = readFileSync("supabase/rollbacks/0115_client_business_credentials.down.sql", "utf8");

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

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const hex = () => crypto.randomBytes(32).toString("hex");

/** A client employee with a Hermes profile of its own, the way the provisioner leaves it. */
async function employee(orgId: string, role = "lead_hunter") {
  const id = await agentId(orgId, role);
  const profile = `c-${uid()}-${role.slice(0, 8)}`;
  await q("update agent_instances set hermes_base_url = 'http://client-gateway.test', hermes_profile = $2 where id = $1", [id, profile]);
  return { id, profile };
}

function put(orgId: string, agent: { id: string; profile: string }, over: Record<string, unknown> = {}) {
  const row = { org_id: orgId, agent_instance_id: agent.id, profile: agent.profile, status: "active", secret_sha256: hex(), expires_at: "2026-12-01T00:00:00Z", ...over };
  const cols = Object.keys(row);
  return q<{ id: string }>(`insert into agent_business_credentials (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row));
}

async function inRolledBackTransaction(run: (db: Queryable) => Promise<void>) {
  await expect(withSystem(async (db) => {
    await run(db);
    throw new Done();
  })).rejects.toBeInstanceOf(Done);
}

describe("the ledger is server-only", () => {
  it("has row-level security on, no policy, and no grant to any signed-in role", async () => {
    const meta = (await q<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'agent_business_credentials'"))[0];
    expect(meta.relrowsecurity).toBe(true);
    expect(await q("select 1 from pg_policies where tablename = 'agent_business_credentials'")).toEqual([]);
    for (const role of ["public", "anon", "authenticated", "iaq_app_user", "iaq_site_runtime"]) {
      const exists = await q<{ n: number }>("select count(*)::int as n from pg_roles where rolname = $1", [role]);
      if (!exists[0].n) continue;
      for (const privilege of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
        expect((await q<{ ok: boolean }>("select has_table_privilege($1, 'agent_business_credentials', $2) as ok", [role, privilege]))[0].ok, `${role} ${privilege}`).toBe(false);
      }
    }
  });
});

describe("one employee, one workspace", () => {
  it("refuses a row that names an employee of another workspace (the composite foreign key)", async () => {
    const a = await createOrg({ kind: "client" });
    const b = await createOrg({ kind: "client" });
    const ofA = await employee(a.id);
    await expect(put(b.id, ofA)).rejects.toThrow(/foreign key/);
    await expect(put(a.id, ofA)).resolves.toHaveLength(1);
  });

  it("follows the employee: deleting a workspace deletes its credentials and nobody else's", async () => {
    const a = await createOrg({ kind: "client" });
    const b = await createOrg({ kind: "client" });
    const ofA = await employee(a.id);
    const ofB = await employee(b.id);
    await put(a.id, ofA);
    await put(b.id, ofB);
    await q("delete from organizations where id = $1", [a.id]);
    expect(await q("select 1 from agent_business_credentials where org_id = $1", [a.id])).toEqual([]);
    expect(await q("select 1 from agent_business_credentials where org_id = $1", [b.id])).toHaveLength(1);
  });

  it("only ever holds a credential for a client workspace's employee", async () => {
    const agency = await createOrg({ kind: "agency" });
    const ofAgency = await employee(agency.id);
    await expect(put(agency.id, ofAgency)).rejects.toThrow(/belongs to a client workspace/);
  });

  it("never holds an agency Hermes profile or the default profile", async () => {
    const org = await createOrg({ kind: "client" });
    const ofOrg = await employee(org.id);
    for (const profile of ["iacquire-lead-hunter", "iacquire-analyst", "default", "Bad Profile", "x"]) {
      await expect(put(org.id, { ...ofOrg, profile }), profile).rejects.toThrow(/check/);
    }
  });
});

describe("at most one active and one rotating_out credential per employee", () => {
  it("refuses a second active row and a second rotating_out row for one employee, but allows one of each", async () => {
    const org = await createOrg({ kind: "client" });
    const emp = await employee(org.id);
    await put(org.id, emp, { status: "active" });
    await expect(put(org.id, emp, { status: "active" })).rejects.toThrow(/duplicate key/);
    await put(org.id, emp, { status: "rotating_out" });
    await expect(put(org.id, emp, { status: "rotating_out" })).rejects.toThrow(/duplicate key/);
    // Ended and waiting rows are not limited.
    await put(org.id, emp, { status: "revoked", revoked_at: "2026-10-27T00:00:00Z" });
    await put(org.id, emp, { status: "revoked", revoked_at: "2026-10-27T00:00:00Z" });
    await put(org.id, emp, { status: "pending", secret_sha256: null });
  });

  it("does not limit different employees against each other", async () => {
    const org = await createOrg({ kind: "client" });
    const one = await employee(org.id, "lead_hunter");
    const two = await employee(org.id, "crm_manager");
    await put(org.id, one);
    await expect(put(org.id, two)).resolves.toHaveLength(1);
  });
});

describe("what a row may hold", () => {
  it("holds a lowercase sha256 hex digest or nothing: a secret, an upper-case digest and a short digest are refused", async () => {
    const org = await createOrg({ kind: "client" });
    const emp = await employee(org.id);
    for (const bad of ["iamcpc1.not-stored-in-clear", "A".repeat(64), "abc", `${"a".repeat(63)}g`]) {
      await expect(put(org.id, emp, { status: "revoked", revoked_at: "2026-10-27T00:00:00Z", secret_sha256: bad }), bad).rejects.toThrow(/check/);
    }
  });

  it("keeps the hash unique, and requires it for every live row and forbids it on a pending one", async () => {
    const org = await createOrg({ kind: "client" });
    const one = await employee(org.id, "lead_hunter");
    const two = await employee(org.id, "crm_manager");
    const shared = hex();
    await put(org.id, one, { secret_sha256: shared });
    await expect(put(org.id, two, { secret_sha256: shared })).rejects.toThrow(/duplicate key/);
    await expect(put(org.id, two, { status: "active", secret_sha256: null })).rejects.toThrow(/check/);
    await expect(put(org.id, two, { status: "rotating_out", secret_sha256: null })).rejects.toThrow(/check/);
    await expect(put(org.id, two, { status: "pending" })).rejects.toThrow(/check/);
  });

  it("limits the lifetime to 400 days and requires revoked_at exactly for revoked rows, with a short code as the reason", async () => {
    const org = await createOrg({ kind: "client" });
    const emp = await employee(org.id);
    await expect(put(org.id, emp, { expires_at: "2020-01-01T00:00:00Z" })).rejects.toThrow(/check/);
    await expect(put(org.id, emp, { expires_at: "2028-01-01T00:00:00Z" })).rejects.toThrow(/check/);
    await expect(put(org.id, emp, { status: "revoked" })).rejects.toThrow(/check/);
    await expect(put(org.id, emp, { revoked_at: "2026-10-27T00:00:00Z" })).rejects.toThrow(/check/);
    for (const reason of ["The client asked us to stop", "ORG_SUSPENDED", "x", "a".repeat(61)]) {
      await expect(put(org.id, emp, { status: "revoked", revoked_at: "2026-10-27T00:00:00Z", revoked_reason: reason }), reason).rejects.toThrow(/check/);
    }
    await expect(put(org.id, emp, { status: "revoked", revoked_at: "2026-10-27T00:00:00Z", revoked_reason: "org_suspended" })).resolves.toHaveLength(1);
  });
});

describe("the guard on a stored row", () => {
  it("writes the hash once: a pending row can be completed, a stored hash can never change", async () => {
    const org = await createOrg({ kind: "client" });
    const emp = await employee(org.id);
    const [pending] = await put(org.id, emp, { status: "pending", secret_sha256: null });
    const first = hex();
    await q("update agent_business_credentials set secret_sha256 = $2, status = 'active' where id = $1", [pending.id, first]);
    await expect(q("update agent_business_credentials set secret_sha256 = $2 where id = $1", [pending.id, hex()])).rejects.toThrow(/written once/);
    await expect(q("update agent_business_credentials set secret_sha256 = null, status = 'revoked', revoked_at = now() where id = $1", [pending.id])).rejects.toThrow(/written once/);
    expect((await q<{ secret_sha256: string }>("select secret_sha256 from agent_business_credentials where id = $1", [pending.id]))[0].secret_sha256).toBe(first);
  });

  it("never moves a credential to another employee, workspace or profile", async () => {
    const a = await createOrg({ kind: "client" });
    const b = await createOrg({ kind: "client" });
    const ofA = await employee(a.id, "lead_hunter");
    const otherOfA = await employee(a.id, "crm_manager");
    const ofB = await employee(b.id);
    const [row] = await put(a.id, ofA);
    await expect(q("update agent_business_credentials set org_id = $2, agent_instance_id = $3 where id = $1", [row.id, b.id, ofB.id])).rejects.toThrow(/cannot move/);
    await expect(q("update agent_business_credentials set agent_instance_id = $2 where id = $1", [row.id, otherOfA.id])).rejects.toThrow(/cannot move/);
    await expect(q("update agent_business_credentials set profile = 'c-someone-else' where id = $1", [row.id])).rejects.toThrow(/cannot move/);
  });

  it("keeps a revoked credential revoked", async () => {
    const org = await createOrg({ kind: "client" });
    const emp = await employee(org.id);
    const [row] = await put(org.id, emp, { status: "revoked", revoked_at: "2026-10-27T00:00:00Z", revoked_reason: "org_suspended" });
    await expect(q("update agent_business_credentials set status = 'active', revoked_at = null where id = $1", [row.id])).rejects.toThrow(/stays revoked/);
    await expect(q("update agent_business_credentials set revoked_reason = 'something_else' where id = $1", [row.id])).rejects.toThrow(/stays revoked/);
    await expect(q("update agent_business_credentials set use_count = use_count + 1 where id = $1", [row.id])).resolves.toBeTruthy();
  });
});

describe("the rollback", () => {
  const applyDown = async (db: Queryable) => {
    for (const statement of statements(down)) await db.query(statement);
  };

  it("is refused while any credential is not revoked, whatever its state", async () => {
    await q("delete from agent_business_credentials");
    const org = await createOrg({ kind: "client" });
    for (const [role, status, extra] of [
      ["lead_hunter", "active", {}],
      ["crm_manager", "rotating_out", {}],
      ["appointment_setter", "pending", { secret_sha256: null }],
    ] as const) {
      const emp = await employee(org.id, role);
      await put(org.id, emp, { status, ...extra });
      await expect(withSystem(async (db) => {
        await applyDown(db);
      }), status).rejects.toThrow(/Rollback refused: \d+ client business credential\(s\) are not revoked/);
      await q("delete from agent_business_credentials where agent_instance_id = $1", [emp.id]);
    }
  });

  it("leaves the table in place after a refusal", async () => {
    const org = await createOrg({ kind: "client" });
    const emp = await employee(org.id);
    await put(org.id, emp);
    await expect(withSystem(async (db) => {
      await applyDown(db);
    })).rejects.toThrow(/Rollback refused/);
    expect((await q<{ n: number }>("select count(*)::int as n from pg_class where relname = 'agent_business_credentials'"))[0].n).toBe(1);
  });

  it("drops the table, its guard and the function once every credential is revoked (ended rows do not hold it back), and the migration can be applied again", async () => {
    await q("delete from agent_business_credentials");
    const org = await createOrg({ kind: "client" });
    await put(org.id, await employee(org.id), { status: "revoked", revoked_at: "2026-10-27T00:00:00Z", revoked_reason: "org_suspended" });
    await inRolledBackTransaction(async (db) => {
      await applyDown(db);
      expect((await db.query("select 1 from pg_class where relname = 'agent_business_credentials'")).rows).toHaveLength(0);
      expect((await db.query("select 1 from pg_proc where proname = 'guard_agent_business_credential'")).rows).toHaveLength(0);
      for (const statement of statements(up)) await db.query(statement);
      expect((await db.query("select 1 from pg_class where relname = 'agent_business_credentials'")).rows).toHaveLength(1);
      expect((await db.query("select 1 from pg_trigger where tgname = 'agent_business_credentials_guard'")).rows).toHaveLength(1);
    });
  });
});
