import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

// Migration 0090 gives app.file_permission two more branches (proposal documents, staff message attachments) and widens the bucket list. app.file_permission has been
// re-created in full by every migration that added a bucket, so the thing to prove is that no EARLIER bucket's answer changed for anybody, and that the two new buckets are
// inert until the modules that own their permissions exist. Each case runs inside a transaction that is always rolled back.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0090_document_buckets.down.sql", "utf8");

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

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
const OLD_BUCKETS = ["company-documents", "support-attachments", "project-files", "project-uploads", "portfolio-assets", "brand-assets", "aqi-attachments", "social-media"];

/** The proposals and staff-message modules seed their own permissions in later migrations; each case starts from "none seeded" so it keeps proving the bucket rule itself. */
const withoutModulePermissions = (db: Db) => db.query("delete from role_permissions where permission like 'proposals.%' or permission like 'agency.messages.%'");

async function world() {
  const org = await createOrg({ name: "Buckets Co" });
  const other = await createOrg({ name: "Other Buckets Co" });
  // The database allows one agency workspace: reuse it when an earlier case already made it.
  const existing = (await withSystem((db) => db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))).rows[0];
  const agencyOrg = existing ?? (await createOrg({ name: "Agency Buckets Co", kind: "agency" }));
  const people: Record<string, { id: string; org: string }> = {};
  for (const [who, role] of [["owner", "owner"], ["admin", "admin"], ["member", "member"], ["sales", "sales_rep"], ["viewer", "viewer"], ["support", "support"]] as const) {
    const u = await createUser();
    await addMember(org.id, u.id, role);
    people[who] = { id: u.id, org: org.id };
  }
  const stranger = await createUser();
  people.stranger = { id: stranger.id, org: org.id };
  const otherOwner = await createUser();
  await addMember(other.id, otherOwner.id, "owner");
  people.otherOwner = { id: otherOwner.id, org: org.id };
  const staff = await createUser({ platformRole: "agency_staff" });
  people.agencyStaff = { id: staff.id, org: agencyOrg.id };
  const manager = await createUser({ platformRole: "agency_manager" });
  people.agencyManager = { id: manager.id, org: agencyOrg.id };
  return { org, agencyOrg, people };
}

async function truth(db: Db, people: Record<string, { id: string; org: string }>, buckets: string[]) {
  const out: Record<string, boolean> = {};
  for (const [who, p] of Object.entries(people)) {
    await db.query("select set_config('app.user_id', $1, true)", [p.id]);
    for (const bucket of buckets) {
      for (const write of [false, true]) {
        const r = await db.query<{ ok: boolean }>("select app.file_permission($1, $2, $3, 'client') as ok", [p.org, bucket, write]);
        out[`${who}|${bucket}|${write ? "write" : "read"}`] = r.rows[0].ok;
      }
    }
  }
  return out;
}

describe("migration 0090: the document buckets", () => {
  it("leaves every earlier bucket's answer unchanged for every person, and the new buckets say no until their permissions exist", async () => {
    const w = await world();
    let before: Record<string, boolean> = {};
    let after: Record<string, boolean> = {};
    let fresh: Record<string, boolean> = {};
    await expect(
      withSystem(async (db) => {
        await withoutModulePermissions(db);
        fresh = await truth(db, w.people, ["proposal-documents", "staff-messages"]);
        before = await truth(db, w.people, OLD_BUCKETS);
        for (const stmt of statements(down)) await db.query(stmt);
        after = await truth(db, w.people, OLD_BUCKETS);
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(Object.keys(before).length).toBe(OLD_BUCKETS.length * Object.keys(w.people).length * 2);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed, `answers that changed: ${changed.slice(0, 6).join(", ")}`).toEqual([]);
    // Something must be true, or the comparison above proves nothing.
    expect(Object.values(before).filter(Boolean).length).toBeGreaterThan(10);
    // Until the proposals and staff-message modules seed their permissions, nobody may read or write either new bucket.
    expect(Object.entries(fresh).filter(([, ok]) => ok).map(([k]) => k)).toEqual([]);
  });

  it("gives proposal documents to the roles that hold the proposals permissions, read-only for a viewer, and nothing to anyone else", async () => {
    const w = await world();
    let t: Record<string, boolean> = {};
    await expect(
      withSystem(async (db) => {
        await withoutModulePermissions(db);
        await db.query("insert into role_permissions (role, permission) values ('owner', 'proposals.view'), ('owner', 'proposals.create'), ('viewer', 'proposals.view')");
        t = await truth(db, w.people, ["proposal-documents"]);
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect([t["owner|proposal-documents|read"], t["owner|proposal-documents|write"]]).toEqual([true, true]);
    expect([t["viewer|proposal-documents|read"], t["viewer|proposal-documents|write"]]).toEqual([true, false]);
    for (const who of ["admin", "member", "sales", "support", "stranger", "otherOwner"]) {
      expect([t[`${who}|proposal-documents|read`], t[`${who}|proposal-documents|write`]], who).toEqual([false, false]);
    }
  });

  it("lets an agency person read proposal documents only inside an active support session on that client (founder decision: the audited-session rule covers the files too)", async () => {
    const w = await world();
    const other = await createOrg({ name: "Other Session Co" });
    const staff = await createUser({ platformRole: "agency_staff" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const unassigned = await createUser({ platformRole: "agency_staff" });
    const read = (db: Db, userId: string, orgId: string, write = false) => db.query<{ ok: boolean }>("select app.file_permission($1, 'proposal-documents', $2, 'client') as ok", [orgId, write]).then((r) => r.rows[0].ok);
    const as = (db: Db, userId: string) => db.query("select set_config('app.user_id', $1, true)", [userId]);
    const session = (db: Db, userId: string, orgId: string, mode: "read" | "write", when: "active" | "ended" | "expired" = "active") =>
      db.query(
        `insert into crm_support_sessions (org_id, user_id, mode, reason, started_at, expires_at, ended_at)
         values ($1, $2, $3, 'Looking at a signed copy for the client', ${when === "expired" ? "now() - interval '3 hours'" : "now()"}, ${when === "expired" ? "now() - interval '1 hour'" : "now() + interval '1 hour'"}, ${when === "ended" ? "now()" : "null"})`,
        [orgId, userId, mode],
      );
    const out: Record<string, boolean | [boolean, boolean]> = {};
    await expect(
      withSystem(async (db) => {
        await withoutModulePermissions(db);
        // The same grants 0091 seeds: the client's team and the three agency roles can view; only the client's own roles create.
        await db.query(
          `insert into role_permissions (role, permission) values ('owner', 'proposals.view'), ('owner', 'proposals.create'), ('viewer', 'proposals.view'),
             ('agency_staff', 'proposals.view'), ('agency_manager', 'proposals.view'), ('agency_super_admin', 'proposals.view')`,
        );
        await db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [w.org.id, staff.id]);
        // No session: the person is assigned (or, for a manager and a Super Admin, may reach every client), holds the permission, and still cannot read the files.
        for (const [name, id] of [["staff", staff.id], ["manager", manager.id], ["admin", admin.id], ["unassigned", unassigned.id]] as const) {
          await as(db, id);
          out[`${name}|none`] = await read(db, id, w.org.id);
        }
        // The client's own people are not affected: no session is involved for them.
        await as(db, w.people.owner.id);
        out["owner|none"] = [await read(db, w.people.owner.id, w.org.id), await read(db, w.people.owner.id, w.org.id, true)];
        await as(db, w.people.viewer.id);
        out["viewer|none"] = await read(db, w.people.viewer.id, w.org.id);
        // A read session on that client opens the read, for each of the three roles, and opens nothing for writing.
        for (const [name, id] of [["staff", staff.id], ["manager", manager.id], ["admin", admin.id]] as const) {
          await session(db, id, w.org.id, "read");
          await as(db, id);
          out[`${name}|read-session`] = [await read(db, id, w.org.id), await read(db, id, w.org.id, true)];
        }
        // A session on another client, one that has ended and one that has run out open nothing; neither does a session for a person who is not assigned.
        await session(db, unassigned.id, w.org.id, "read");
        await as(db, unassigned.id);
        out["unassigned|read-session"] = await read(db, unassigned.id, w.org.id);
        await db.query("delete from crm_support_sessions");
        await session(db, staff.id, other.id, "read");
        await as(db, staff.id);
        out["staff|other-client-session"] = await read(db, staff.id, w.org.id);
        await db.query("delete from crm_support_sessions");
        await session(db, staff.id, w.org.id, "read", "ended");
        out["staff|ended-session"] = await read(db, staff.id, w.org.id);
        await db.query("delete from crm_support_sessions");
        await session(db, staff.id, w.org.id, "read", "expired");
        out["staff|expired-session"] = await read(db, staff.id, w.org.id);
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(out).toEqual({
      "staff|none": false, "manager|none": false, "admin|none": false, "unassigned|none": false,
      "owner|none": [true, true], "viewer|none": true,
      "staff|read-session": [true, false], "manager|read-session": [true, false], "admin|read-session": [true, false],
      "unassigned|read-session": false,
      "staff|other-client-session": false, "staff|ended-session": false, "staff|expired-session": false,
    });
  });

  it("lets only an agency user holding the messages permission write staff attachments, on the agency workspace, and lets nobody read them directly", async () => {
    const w = await world();
    let t: Record<string, boolean> = {};
    let onClientOrg: boolean | null = null;
    await expect(
      withSystem(async (db) => {
        await withoutModulePermissions(db);
        await db.query("insert into role_permissions (role, permission) values ('agency_staff', 'agency.messages.use')");
        t = await truth(db, w.people, ["staff-messages"]);
        // The same agency user against a client workspace: the rule is about the agency's own workspace.
        await db.query("select set_config('app.user_id', $1, true)", [w.people.agencyStaff.id]);
        onClientOrg = (await db.query<{ ok: boolean }>("select app.file_permission($1, 'staff-messages', true, 'client') as ok", [w.org.id])).rows[0].ok;
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(t["agencyStaff|staff-messages|write"]).toBe(true);
    expect(t["agencyStaff|staff-messages|read"]).toBe(false);
    expect(onClientOrg).toBe(false);
    // A manager without the grant, every client role, a stranger: nothing.
    for (const who of ["agencyManager", "owner", "admin", "member", "sales", "viewer", "support", "stranger", "otherOwner"]) {
      expect([t[`${who}|staff-messages|read`], t[`${who}|staff-messages|write`]], who).toEqual([false, false]);
    }
  });

  it("accepts files in the two buckets, refuses an unknown bucket, and its rollback refuses while a file is stored", async () => {
    const w = await world();
    const probe = async (db: Db, bucket: string) => {
      try {
        await db.query("savepoint probe");
        await db.query("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, $2, $3, 'a.pdf', 'application/pdf', 100, 'ready')", [w.org.id, bucket, `${w.org.id}/${bucket}/a.pdf`]);
        await db.query("rollback to savepoint probe");
        return true;
      } catch {
        await db.query("rollback to savepoint probe");
        return false;
      }
    };
    let accepted: boolean[] = [];
    let unknown = true;
    await expect(
      withSystem(async (db) => {
        accepted = [await probe(db, "proposal-documents"), await probe(db, "staff-messages"), await probe(db, "social-media")];
        unknown = await probe(db, "scrapbook");
        await db.query("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'proposal-documents', $2, 'p.pdf', 'application/pdf', 100, 'ready')", [w.org.id, `${w.org.id}/proposals/p.pdf`]);
        for (const stmt of statements(down)) await db.query(stmt);
        throw new Done();
      }),
    ).rejects.toThrow(/Rollback refused/);
    expect(accepted).toEqual([true, true, true]);
    expect(unknown).toBe(false);
  });
});
