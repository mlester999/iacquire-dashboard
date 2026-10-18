// Migration 0035 (CRM Blueprints): the agency library, the per-client application records, draft calendars, permissions and notification
// kinds, and its rollback. Synthetic rows only; nothing here contacts GoHighLevel or any other provider.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { PERMISSION_MATRIX } from "@/lib/permissions";
import { createAppointmentType, createCalendar } from "@/server/calendars/setup";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { createOrg, createUser } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

class Done extends Error {}

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (as tests/crm-migrations.test.ts does). */
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

const DOWN = readFileSync("supabase/rollbacks/0054_crm_blueprints.down.sql", "utf8");
const MANAGER_GRANTS_UP = readFileSync("supabase/migrations/0061_agency_manager_blueprint_permissions.sql", "utf8");
const MANAGER_GRANTS_DOWN = readFileSync("supabase/rollbacks/0061_agency_manager_blueprint_permissions.down.sql", "utf8");
const runDown = async (db: Queryable) => {
  for (const stmt of statements(DOWN)) await db.query(stmt);
};
const hex = () => crypto.randomBytes(32).toString("hex");
const LIBRARY = ["crm_blueprint_folders", "crm_blueprints", "crm_blueprint_versions", "crm_blueprint_ghl_sources", "crm_blueprint_imports"];
const TENANT = ["crm_blueprint_applications", "crm_blueprint_application_items", "crm_blueprint_links"];
const NEW_PERMISSIONS = ["crm.blueprints.view", "crm.blueprints.design", "crm.blueprints.publish", "crm.blueprints.apply"];

/** Runs `fn` in a transaction that is always rolled back, and returns what it found. */
async function inRolledBack<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await expect(withSystem(async (db) => {
    out = await fn(db);
    throw new Done();
  })).rejects.toBeInstanceOf(Done);
  return out as T;
}

async function blueprint(db: Queryable, over: Record<string, unknown> = {}) {
  const key = (over.key as string) ?? `bp-${crypto.randomBytes(3).toString("hex")}`;
  const { rows } = await db.query<{ id: string }>(
    "insert into crm_blueprints (key, name, industry, source_kind, draft_package) values ($1, $2, $3, $4, '{}'::jsonb) returning id",
    [key, (over.name as string) ?? "Home services starter", (over.industry as string) ?? "home_services", (over.source_kind as string) ?? "native"],
  );
  const v = await db.query<{ id: string }>(
    "insert into crm_blueprint_versions (blueprint_id, version, schema_version, package, digest) values ($1, 1, 1, '{}'::jsonb, $2) returning id",
    [rows[0].id, hex()],
  );
  return { id: rows[0].id, versionId: v.rows[0].id };
}

async function application(db: Queryable, orgId: string, bp: { id: string; versionId: string }, over: Record<string, unknown> = {}) {
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, status, plan_digest, idempotency_key)
     values ($1, $2, $3, 1, 'Home services starter', 'initial', 'add_missing', 'applied', $4, $5) returning id`,
    [orgId, bp.id, (over.versionId as string) ?? bp.versionId, hex(), (over.key as string) ?? `confirm-${crypto.randomUUID()}`],
  );
  return rows[0].id;
}

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Blueprint Schema A" });
  b = await crmOrg({ name: "Blueprint Schema B" });
});

describe("rollback 0035", () => {
  it("removes everything the migration added and restores the 0032 notification kinds", async () => {
    const report = await inRolledBack(async (db) => {
      await runDown(db);
      const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
      return {
        tables: (await q("select table_name from information_schema.tables where table_schema = 'public' and table_name like 'crm\\_blueprint%'")).map((r) => r.table_name),
        calendarColumns: (await q("select column_name from information_schema.columns where table_name = 'crm_calendars' and column_name in ('status', 'verified_at', 'verification', 'folder_id', 'timezone', 'hours_template', 'origin')")).length,
        permissions: (await q("select 1 from role_permissions where permission like 'crm.blueprints.%'")).length,
        functions: (await q("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and proname in ('guard_blueprint_ghl_source', 'guard_location_not_blueprint_source')")).length,
        triggers: (await q("select 1 from pg_trigger where tgname = 'ghl_location_mappings_not_blueprint_source'")).length,
        kinds: String((await q("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_kind_check'"))[0]?.def ?? ""),
        version: (await q("select 1 from schema_migrations where version = '0054_crm_blueprints'")).length,
      };
    });
    expect(report).toMatchObject({ tables: [], calendarColumns: 0, permissions: 0, functions: 0, triggers: 0, version: 0 });
    expect(report.kinds).toContain("crm_workflow_failed");
    expect(report.kinds).toContain("crm_webhook_failing");
    expect(report.kinds).not.toContain("crm_blueprint_applied");
  });

  it("refuses while the library holds anything, while an application exists, or while a live draft calendar exists", async () => {
    await expect(withSystem(async (db) => {
      await blueprint(db);
      await runDown(db);
    })).rejects.toThrow(/library is not empty/);
    await expect(withSystem(async (db) => {
      await db.query("insert into crm_blueprint_folders (name) values ('Starters')");
      await runDown(db);
    })).rejects.toThrow(/library is not empty/);
    // An application always keeps its Blueprint and version (deleting either is restricted), so it is refused as well.
    await expect(withSystem(async (db) => {
      const bp = await blueprint(db);
      await application(db, a.org.id, bp);
      await runDown(db);
    })).rejects.toThrow(/Rollback refused/);
    const owner = a.actor("owner");
    const cal = await createCalendar(owner, { name: "Rollback draft", members: [{ userId: a.people.owner.id }] });
    await expect(withSystem(async (db) => {
      await db.query("update crm_calendars set status = 'draft', public = false, is_default = false where id = $1", [cal.id]);
      await runDown(db);
    })).rejects.toThrow(/draft calendars exist/);
    // An archived draft takes no bookings either way, so it doesn't block the rollback.
    const ok = await inRolledBack(async (db) => {
      await db.query("update crm_calendars set status = 'draft', public = false, is_default = false, archived_at = now() where id = $1", [cal.id]);
      await runDown(db);
      return (await db.query("select 1 from information_schema.tables where table_name = 'crm_blueprints'")).rows.length;
    });
    expect(ok).toBe(0);
  });
});

describe("agency library", () => {
  it("has row-level security on and no privileges for any application role", async () => {
    const r = await withSystem(async (db) => {
      const out: Record<string, unknown> = {};
      for (const t of LIBRARY) {
        out[t] = (await db.query<{ rls: boolean; app: boolean; anon: boolean; authed: boolean; site: boolean }>(
          `select c.relrowsecurity as rls,
                  has_table_privilege('iaq_app_user', c.oid, 'select') or has_table_privilege('iaq_app_user', c.oid, 'insert') or has_table_privilege('iaq_app_user', c.oid, 'update') or has_table_privilege('iaq_app_user', c.oid, 'delete') as app,
                  has_table_privilege('anon', c.oid, 'select') as anon, has_table_privilege('authenticated', c.oid, 'select') as authed, has_table_privilege('iaq_site_runtime', c.oid, 'select') as site
           from pg_class c where c.relname = $1`,
          [t],
        )).rows[0];
      }
      return out;
    });
    for (const t of LIBRARY) expect(r[t], t).toEqual({ rls: true, app: false, anon: false, authed: false, site: false });
  });

  it("can't be read by a signed-in client or agency user through the application role", async () => {
    await withSystem((db) => blueprint(db));
    const staff = await createUser({ platformRole: "agency_staff", name: "Library Staff" });
    for (const userId of [a.people.owner.id, staff.id]) {
      await expect(withUser(userId, (db) => db.query("select * from crm_blueprints"))).rejects.toThrow(/permission denied/);
      await expect(withUser(userId, (db) => db.query("select * from crm_blueprint_versions"))).rejects.toThrow(/permission denied/);
      await expect(withUser(userId, (db) => db.query("select * from crm_blueprint_ghl_sources"))).rejects.toThrow(/permission denied/);
    }
  });

  it("checks keys, statuses, sources and published versions", async () => {
    const bad = async (sql: string, params: unknown[] = []) => expect(withSystem((db) => db.query(sql, params))).rejects.toThrow();
    const ins = "insert into crm_blueprints (key, name, industry, source_kind, status, current_version, archived_at, starter_key, draft_package) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)";
    await bad(ins, ["Bad Key", "X", "consulting", "native", "draft", null, null, null, "{}"]);
    await bad(ins, ["ok-key-1", "X", "astrology", "native", "draft", null, null, null, "{}"]);
    await bad(ins, ["ok-key-2", "X", "consulting", "scraped", "draft", null, null, null, "{}"]);
    await bad(ins, ["ok-key-3", "X", "consulting", "native", "published", null, null, null, "{}"]); // published needs a version
    await bad(ins, ["ok-key-4", "X", "consulting", "native", "archived", null, null, null, "{}"]); // archived needs archived_at
    await bad(ins, ["ok-key-5", "X", "consulting", "starter", "draft", null, null, null, "{}"]); // a starter names its starter
    await bad(ins, ["ok-key-6", "X", "consulting", "native", "draft", null, null, null, "[]"]); // the draft is an object
    await withSystem((db) => db.query(ins, ["ok-key-7", "Real estate", "real_estate", "starter", "published", 1, null, "real-estate", "{}"]));
    await bad(ins, ["ok-key-8", "Real estate again", "real_estate", "starter", "draft", null, null, "real-estate", "{}"]); // one row per starter
  });

  it("freezes published versions and keeps digests well formed", async () => {
    const bp = await withSystem((db) => blueprint(db));
    await expect(withSystem((db) => db.query("update crm_blueprint_versions set change_summary = 'edited' where id = $1", [bp.versionId]))).rejects.toThrow();
    await expect(withSystem((db) => db.query("insert into crm_blueprint_versions (blueprint_id, version, schema_version, package, digest) values ($1, 2, 1, '{}', 'abc')", [bp.id]))).rejects.toThrow();
    await expect(withSystem((db) => db.query("insert into crm_blueprint_versions (blueprint_id, version, schema_version, package, digest) values ($1, 1, 1, '{}', $2)", [bp.id, hex()]))).rejects.toThrow(); // same number twice
    await expect(withSystem((db) => db.query("delete from crm_blueprints where id = $1", [bp.id]))).rejects.toThrow(); // versions keep it
  });

  it("never accepts a protected location, a client's location or a client's credential as a GoHighLevel source", async () => {
    const ins = (loc: string, cred: string | null = null) => withSystem((db) => db.query("insert into crm_blueprint_ghl_sources (label, location_id, credential_id) values ('Template account', $1, $2) returning id", [loc, cred]));
    await expect(ins("u69CVh0ZlAofUmRoj1zF")).rejects.toThrow();
    await expect(ins("SQvVnld5MBHdMQ1qnSfw")).rejects.toThrow();
    await expect(ins("not a location!")).rejects.toThrow();
    const mapped = `Map${crypto.randomBytes(6).toString("hex")}`;
    await withSystem((db) => db.query("insert into ghl_location_mappings (org_id, location_id) values ($1, $2)", [b.org.id, mapped]));
    await expect(ins(mapped)).rejects.toThrow(/blueprint_source_is_client_location/);

    const clientCred = await withSystem(async (db) => (await db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'ghl', 'Client token', 'x', 'f1') returning id", [a.org.id])).rows[0].id);
    const agencyCred = await withSystem(async (db) => (await db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values (null, 'ghl', 'Template token', 'x', 'f2') returning id")).rows[0].id);
    const n8nCred = await withSystem(async (db) => (await db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values (null, 'n8n', 'Other', 'x', 'f3') returning id")).rows[0].id);
    const source = `Tmpl${crypto.randomBytes(6).toString("hex")}`;
    await expect(ins(source, clientCred)).rejects.toThrow(/blueprint_source_credential_invalid/);
    await expect(ins(source, n8nCred)).rejects.toThrow(/blueprint_source_credential_invalid/);
    const ok = await ins(source, agencyCred);
    expect(ok.rows).toHaveLength(1);
    // And a location kept as a source can't then be mapped to a client.
    const c = await createOrg({ name: "Later client" });
    await expect(withSystem((db) => db.query("insert into ghl_location_mappings (org_id, location_id) values ($1, $2)", [c.id, source]))).rejects.toThrow(/location_is_blueprint_source/);
  });

  it("keeps import history consistent: a saved import names its Blueprint, a client import names its client", async () => {
    const ins = "insert into crm_blueprint_imports (source_kind, source_org_id, source_label, status, blueprint_id, saved_at) values ($1, $2, 'Import', $3, $4, $5)";
    const bp = await withSystem((db) => blueprint(db));
    await expect(withSystem((db) => db.query(ins, ["package_file", null, "saved", null, new Date()]))).rejects.toThrow();
    await expect(withSystem((db) => db.query(ins, ["package_file", null, "saved", bp.id, null]))).rejects.toThrow();
    await expect(withSystem((db) => db.query(ins, ["ghl_client", null, "previewed", null, null]))).rejects.toThrow();
    await expect(withSystem((db) => db.query(ins, ["ghl_agency_source", null, "previewed", null, null]))).rejects.toThrow();
    await withSystem((db) => db.query(ins, ["package_file", null, "saved", bp.id, new Date()]));
    await withSystem((db) => db.query(ins, ["ghl_client", a.org.id, "previewed", null, null]));
    await withSystem((db) => db.query(ins, ["ghl_agency_source", null, "failed", null, null]));
  });
});

describe("applications and links", () => {
  it("each client reads only what was applied to its own workspace, and can't write it", async () => {
    const bp = await withSystem((db) => blueprint(db));
    const appA = await withSystem((db) => application(db, a.org.id, bp));
    const appB = await withSystem((db) => application(db, b.org.id, bp));
    await withSystem(async (db) => {
      for (const [org, app] of [[a.org.id, appA], [b.org.id, appB]] as const) {
        await db.query("insert into crm_blueprint_application_items (org_id, application_id, asset_id, asset_type, section, name, action, outcome, native_id, position) values ($1, $2, 'tag.vip', 'tag', 'tags', 'VIP', 'create', 'applied', $3, 0)", [org, app, crypto.randomUUID()]);
        await db.query("insert into crm_blueprint_links (org_id, blueprint_id, asset_id, asset_type, native_id, applied_version, asset_hash, native_hash, application_id) values ($1, $2, 'tag.vip', 'tag', $3, 1, $4, $5, $6)", [org, bp.id, crypto.randomUUID(), hex(), hex(), app]);
      }
    });
    for (const who of ["owner", "viewer"] as const) {
      const seen = await withUser(a.people[who].id, async (db) => ({
        apps: (await db.query<{ id: string }>("select id from crm_blueprint_applications")).rows.map((r) => r.id),
        items: (await db.query<{ org_id: string }>("select org_id from crm_blueprint_application_items")).rows.map((r) => r.org_id),
        links: (await db.query<{ org_id: string }>("select org_id from crm_blueprint_links")).rows.map((r) => r.org_id),
      }));
      expect(seen.apps, who).toContain(appA);
      expect(seen.apps, who).not.toContain(appB);
      expect(new Set(seen.items), who).toEqual(new Set([a.org.id]));
      expect(new Set(seen.links), who).toEqual(new Set([a.org.id]));
    }
    const outsider = await createUser({ name: "Not a member" });
    expect((await withUser(outsider.id, (db) => db.query("select id from crm_blueprint_applications"))).rows).toEqual([]);
    for (const sql of [
      "update crm_blueprint_applications set status = 'failed'",
      "delete from crm_blueprint_links",
      `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, status, plan_digest, idempotency_key) values ('${a.org.id}', '${bp.id}', '${bp.versionId}', 1, 'X', 'initial', 'add_missing', 'applied', '${hex()}', 'forged-key-123')`,
    ]) {
      await expect(withUser(a.people.owner.id, (db) => db.query(sql))).rejects.toThrow(/permission denied/);
    }
    const privileges = await withSystem(async (db) => (await db.query<{ t: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; anon: boolean }>(
      `select c.relname as t, has_any_column_privilege('iaq_app_user', c.oid, 'select') as sel, has_table_privilege('iaq_app_user', c.oid, 'insert') as ins,
              has_table_privilege('iaq_app_user', c.oid, 'update') as upd, has_table_privilege('iaq_app_user', c.oid, 'delete') as del,
              has_any_column_privilege('anon', c.oid, 'select') as anon
       from pg_class c where c.relname = any($1::text[]) and c.relrowsecurity`,
      [TENANT],
    )).rows);
    expect(privileges).toHaveLength(TENANT.length);
    for (const p of privileges) expect(p, p.t).toMatchObject({ sel: true, ins: false, upd: false, del: false, anon: false });

    // An item's `before` (the whole record before an update) and its hash are for trusted code only: the record's own table may not let
    // every member read it (a workflow's draft needs workflows.view), so members can read every column of an item except those two.
    const columns = await withSystem(async (db) => (await db.query<{ col: string; sel: boolean }>(
      `select a.attname as col, has_column_privilege('iaq_app_user', 'crm_blueprint_application_items', a.attname, 'select') as sel
       from pg_attribute a where a.attrelid = 'crm_blueprint_application_items'::regclass and a.attnum > 0 and not a.attisdropped`,
    )).rows);
    expect(columns.filter((c) => !c.sel).map((c) => c.col).sort()).toEqual(["after_hash", "before"]);
    for (const who of ["owner", "viewer"] as const) {
      await expect(withUser(a.people[who].id, (db) => db.query("select before from crm_blueprint_application_items")), who).rejects.toThrow(/permission denied/);
      await expect(withUser(a.people[who].id, (db) => db.query("select * from crm_blueprint_application_items")), who).rejects.toThrow(/permission denied/);
      const named = await withUser(a.people[who].id, (db) => db.query<{ name: string }>("select name, outcome, native_id from crm_blueprint_application_items"));
      expect(named.rows.map((r) => r.name), who).toEqual(["VIP"]);
    }

    // A client's data export carries what was applied to it, without internal keys and hashes, and nothing of another client's.
    const out = await buildExport(a.org.id);
    expect(out.counts.crm_blueprint_applications).toBeGreaterThanOrEqual(1);
    expect(out.counts.crm_blueprint_application_items).toBeGreaterThanOrEqual(1);
    expect(out.counts.crm_blueprint_links).toBeGreaterThanOrEqual(1);
    const files = readZip(out.bytes);
    const text = (name: string) => files.find((f) => f.name.endsWith(name))?.data.toString("utf8") ?? "";
    expect(text("crm/blueprint-applications.json")).toContain(appA);
    expect(text("crm/blueprint-applications.json")).not.toContain(appB);
    expect(text("crm/blueprint-applications.json")).not.toMatch(/idempotency_key|plan_digest/);
    expect(text("crm/blueprint-links.json")).not.toMatch(/asset_hash|native_hash/);
    expect(files.some((f) => /crm_blueprints|blueprint-library|blueprint-versions/.test(f.name))).toBe(false);
  });

  it("checks versions, idempotency keys, digests, statuses and link uniqueness", async () => {
    const bp = await withSystem((db) => blueprint(db));
    const other = await withSystem((db) => blueprint(db));
    // The version must belong to the Blueprint applied.
    await expect(withSystem((db) => application(db, a.org.id, bp, { versionId: other.versionId }))).rejects.toThrow();
    // The same confirmation can't create two applications in one workspace; another workspace may use the same key.
    await withSystem((db) => application(db, a.org.id, bp, { key: "confirm-once-0001" }));
    await expect(withSystem((db) => application(db, a.org.id, bp, { key: "confirm-once-0001" }))).rejects.toThrow();
    await withSystem((db) => application(db, b.org.id, bp, { key: "confirm-once-0001" }));
    const base = "insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, status, plan_digest, idempotency_key, rolled_back_at) values ($1, $2, $3, 1, 'X', $4, $5, $6, $7, $8, $9)";
    const row = (over: Partial<{ mode: string; strategy: string; status: string; digest: string; rolled: Date | null }>) =>
      withSystem((db) => db.query(base, [a.org.id, bp.id, bp.versionId, over.mode ?? "initial", over.strategy ?? "add_missing", over.status ?? "applied", over.digest ?? hex(), `k-${crypto.randomUUID()}`, over.rolled ?? null]));
    await expect(row({ digest: "not-a-digest" })).rejects.toThrow();
    await expect(row({ mode: "overwrite" })).rejects.toThrow();
    await expect(row({ strategy: "replace_all" })).rejects.toThrow();
    await expect(row({ status: "active" })).rejects.toThrow();
    await expect(row({ status: "rolled_back" })).rejects.toThrow(); // rolled back needs when
    await row({ status: "rolled_back", rolled: new Date() });
    await expect(row({ status: "applied", rolled: new Date() })).rejects.toThrow();

    const app = await withSystem((db) => application(db, a.org.id, bp));
    const native = crypto.randomUUID();
    const link = (asset: string, type = "tag", nativeId = native, hash = hex()) =>
      withSystem((db) => db.query("insert into crm_blueprint_links (org_id, blueprint_id, asset_id, asset_type, native_id, applied_version, asset_hash, native_hash, application_id) values ($1, $2, $3, $4, $5, 1, $6, $7, $8)", [a.org.id, bp.id, asset, type, nativeId, hash, hex(), app]));
    await link("tag.vip");
    await expect(link("tag.vip", "tag", crypto.randomUUID())).rejects.toThrow(); // one link per asset
    await expect(link("tag.gold", "tag", native)).rejects.toThrow(); // one asset per record
    await expect(link("tag.bad", "Tag Type!", crypto.randomUUID())).rejects.toThrow();
    await expect(link("tag.short", "tag", crypto.randomUUID(), "abc")).rejects.toThrow();
    const item = (action: string, outcome: string) =>
      withSystem((db) => db.query("insert into crm_blueprint_application_items (org_id, application_id, asset_id, asset_type, section, name, action, outcome, position) values ($1, $2, $3, 'tag', 'tags', 'VIP', $4, $5, 0)", [a.org.id, app, `tag.${crypto.randomBytes(3).toString("hex")}`, action, outcome]));
    await item("create", "applied");
    await expect(item("delete", "applied")).rejects.toThrow(); // applying never deletes
    await expect(item("create", "done")).rejects.toThrow();
    // An application can't be attached to another workspace's items.
    await expect(withSystem((db) => db.query("insert into crm_blueprint_application_items (org_id, application_id, asset_id, asset_type, section, name, action, outcome, position) values ($1, $2, 'tag.x', 'tag', 'tags', 'X', 'create', 'applied', 0)", [b.org.id, app]))).rejects.toThrow();
  });
});

describe("draft calendars", () => {
  it("existing calendars stay active; a draft can never be public or the default", async () => {
    const owner = a.actor("owner");
    const cal = await createCalendar(owner, { name: "Schema calendar", members: [{ userId: a.people.owner.id }] });
    await createAppointmentType(owner, cal.id, { name: "Visit", durationMinutes: 30 });
    const row = await withSystem(async (db) => (await db.query<{ status: string; origin: string; verification: unknown; hours_template: unknown; verified_at: Date | null }>("select status, origin, verification, hours_template, verified_at from crm_calendars where id = $1", [cal.id])).rows[0]);
    expect(row).toEqual({ status: "active", origin: "manual", verification: {}, hours_template: [], verified_at: null });
    const set = (sql: string, params: unknown[] = []) => withSystem((db) => db.query(`update crm_calendars set ${sql} where id = $1`, [cal.id, ...params]));
    await set("is_default = false, public = false");
    await expect(set("status = 'paused'")).rejects.toThrow();
    await expect(set("status = 'draft', public = true")).rejects.toThrow();
    await expect(set("status = 'draft', is_default = true")).rejects.toThrow();
    await set("status = 'draft', origin = 'blueprint', timezone = 'Asia/Manila', hours_template = $2::jsonb", [JSON.stringify([{ weekday: 1, startMinute: 540, endMinute: 1020 }])]);
    await expect(set("public = true")).rejects.toThrow();
    await expect(set("hours_template = '{}'::jsonb")).rejects.toThrow();
    await expect(set("verification = '[]'::jsonb")).rejects.toThrow();
    await expect(set("origin = 'copied'")).rejects.toThrow();
    // A calendar can be filed in a calendar folder of its own workspace only.
    const folder = await withSystem(async (db) => (await db.query<{ id: string }>("insert into crm_folders (org_id, kind, name) values ($1, 'calendar', 'Imported') returning id", [b.org.id])).rows[0].id);
    await expect(set("folder_id = $2", [folder])).rejects.toThrow();
  });
});

describe("permissions and notification kinds", () => {
  it("repairs manager Blueprint grants on older installs and rolls back only those grants", async () => {
    const result = await inRolledBack(async (db) => {
      await db.query("delete from role_permissions where role = 'agency_manager' and permission like 'crm.blueprints.%'");
      for (const stmt of statements(MANAGER_GRANTS_UP)) await db.query(stmt);
      const manager = (await db.query<{ permission: string }>("select permission from role_permissions where role = 'agency_manager' and permission like 'crm.blueprints.%' order by permission")).rows.map((r) => r.permission);
      const otherRoles = (await db.query("select 1 from role_permissions where role <> 'agency_manager' and permission like 'crm.blueprints.%'")).rows.length;
      for (const stmt of statements(MANAGER_GRANTS_DOWN)) await db.query(stmt);
      const afterRollback = (await db.query("select 1 from role_permissions where role = 'agency_manager' and permission like 'crm.blueprints.%'")).rows.length;
      const preservedRoles = (await db.query("select 1 from role_permissions where role <> 'agency_manager' and permission like 'crm.blueprints.%'")).rows.length;
      return { manager, otherRoles, afterRollback, preservedRoles };
    });
    expect(result).toEqual({
      manager: ["crm.blueprints.design", "crm.blueprints.view"],
      otherRoles: 6,
      afterRollback: 0,
      preservedRoles: 6,
    });
  });

  it("seeds the Blueprint permissions for agency roles only, exactly as the matrix says", async () => {
    const { rows } = await withSystem((db) => db.query<{ role: string; permission: string }>("select role, permission from role_permissions where permission like 'crm.blueprints.%' order by permission, role"));
    const fromDb = rows.map((r) => `${r.permission}|${r.role}`).sort();
    const fromCode = NEW_PERMISSIONS.flatMap((p) => PERMISSION_MATRIX[p as keyof typeof PERMISSION_MATRIX].map((role) => `${p}|${role}`)).sort();
    expect(fromDb).toEqual(fromCode);
    expect(PERMISSION_MATRIX["crm.blueprints.view"]).toEqual(["agency_staff", "agency_manager", "agency_super_admin"]);
    expect(PERMISSION_MATRIX["crm.blueprints.design"]).toEqual(["agency_staff", "agency_manager", "agency_super_admin"]);
    expect(PERMISSION_MATRIX["crm.blueprints.publish"]).toEqual(["agency_super_admin"]);
    expect(PERMISSION_MATRIX["crm.blueprints.apply"]).toEqual(["agency_super_admin"]);
    // No client role ever holds them, and a client owner's has_permission says no.
    expect(rows.every((r) => r.role.startsWith("agency_"))).toBe(true);
    const can = await withUser(a.people.owner.id, (db) => db.query<{ ok: boolean }>("select app.has_permission($1, 'crm.blueprints.apply') as ok", [a.org.id]));
    expect(can.rows[0].ok).toBe(false);
  });

  it("accepts the Blueprint notification and keeps every earlier kind", async () => {
    const note = (kind: string) => withSystem((db) => db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, $3, 'T')", [a.org.id, a.people.owner.id, kind]));
    await note("crm_blueprint_applied");
    await note("crm_workflow_failed");
    await note("crm_webhook_failing");
    await note("crm_calendar_sync");
    await note("agent_task_completed");
    await expect(note("crm_blueprint_exploded")).rejects.toThrow();
  });
});
