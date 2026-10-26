// "Online" and "ready" for an AI employee's runtime are defined once (src/lib/employee-runtime.ts). The fragment is checked against a matrix of rows that each miss ONE thing the
// run gate looks for, and the code is scanned so a new private shortcut ("status in ('online', 'busy')" in a dashboard count) cannot come back.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { TOOL_INVENTORY_CONTRACT } from "@/lib/hermes-tool-inventory";
import { RUNTIME_ONLINE_STATUSES, isRuntimeOnline, runtimeReadySql } from "@/lib/employee-runtime";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { agentId, createOrg, createUser } from "./support/fixtures";

const DIGEST = "a".repeat(64);
let org: { id: string };
let credentialId: string;
let userId: string;

async function reset(role = "crm_manager") {
  const id = await agentId(org.id, role as never);
  await withSystem(async (db) => {
    const existing = await db.query<{ active_config_version_id: string | null }>("select active_config_version_id from agent_instances where id = $1", [id]);
    if (!existing.rows[0].active_config_version_id) await createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role as never), source: "onboarding", userId: userId, apply: true });
    const versionId = (await db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [id])).rows[0].active_config_version_id;
    await db.query(
      `update agent_instances set enabled = true, active_config_version_id = $2, status = 'online', last_health_ok = true, last_health_check_at = now(), credential_id = $3,
         tool_inventory_contract = $4, tool_inventory_digest = $5, tool_inventory_tool_count = 5, tool_inventory_verified_at = now(), tool_inventory_expires_at = now() + interval '2 minutes'
       where id = $1`,
      [id, versionId, credentialId, TOOL_INVENTORY_CONTRACT, DIGEST],
    );
  });
  return id;
}

const isReady = async (id: string, revocation = false) => (await withSystem((db) => db.query<{ ok: boolean }>(
  `select ${runtimeReadySql("a", { credentialRevocation: revocation })} as ok from agent_instances a where a.id = $1`, [id]))).rows[0].ok;

beforeAll(async () => {
  org = await createOrg({ name: "Runtime Definition Co" });
  userId = (await createUser()).id;
  credentialId = (await withSystem((db) => db.query<{ id: string }>(
    "insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'fixture', 'x', 'f') returning id", [org.id]))).rows[0].id;
});

describe("runtimeReadySql is the recorded half of the run gate", () => {
  it("is true for a row that has everything, and names exactly the two online statuses", async () => {
    const id = await reset();
    expect(await isReady(id)).toBe(true);
    expect(await isReady(id, true)).toBe(true);
    expect([...RUNTIME_ONLINE_STATUSES]).toEqual(["online", "busy"]);
    expect(isRuntimeOnline("online")).toBe(true);
    expect(isRuntimeOnline("busy")).toBe(true);
    for (const s of ["offline", "error", "setup_required", "provisioning", "disabled", "", null, undefined]) expect(isRuntimeOnline(s), String(s)).toBe(false);
  });

  const MISSING: Array<[string, string]> = [
    ["the employee is switched off", "enabled = false"],
    ["no configuration has been applied", "active_config_version_id = null"],
    ["the recorded status is offline", "status = 'offline'"],
    ["the recorded status is provisioning", "status = 'provisioning'"],
    ["the last check did not pass", "last_health_ok = false"],
    ["no check ever ran", "last_health_ok = null"],
    ["no credential is named", "credential_id = null"],
    ["the inventory contract is not the reviewed one", "tool_inventory_contract = 'something.else'"],
    ["the inventory digest is missing", "tool_inventory_digest = null"],
    // A malformed digest cannot be stored at all: the column refuses anything but 64 hex characters (migration 0059).
    ["the inventory lists no tools", "tool_inventory_tool_count = 0"],
    ["the inventory was never verified", "tool_inventory_verified_at = null"],
    ["the inventory has no expiry", "tool_inventory_expires_at = null"],
  ];
  for (const [what, set] of MISSING) {
    it(`is false when ${what}`, async () => {
      const id = await reset();
      await withSystem((db) => db.query(`update agent_instances set ${set} where id = $1`, [id]));
      expect(await isReady(id)).toBe(false);
    });
  }

  it("lets trusted code also require an unrevoked credential, which a person's own query cannot see", async () => {
    const id = await reset();
    await withSystem((db) => db.query("update integration_credentials set revoked_at = now() where id = $1", [credentialId]));
    expect(await isReady(id, false)).toBe(true); // names a credential: all a person's query can tell
    expect(await isReady(id, true)).toBe(false);
    await withSystem((db) => db.query("update integration_credentials set revoked_at = null where id = $1", [credentialId]));
    expect(await isReady(id, true)).toBe(true);
  });

  it("does not let a table alias carry SQL", () => {
    expect(() => runtimeReadySql("a; drop table x")).toThrow();
    expect(() => runtimeReadySql("a b")).toThrow();
  });
});

describe("no private copy of the shortcut", () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
  // The one definition, the status vocabulary, the screens' prose, and the two writers that MOVE an employee offline after a live failure (a state change, not a readiness test).
  const ALLOWED = new Set(["src/lib/employee-runtime.ts", "src/lib/agents.ts", "src/server/help/articles.ts", "src/app/(admin)/admin/page.tsx"]);
  const WRITERS = /update\s+agent_instances\s+set\s+status\s*=\s*'offline'/;

  it("keeps `status in ('online', 'busy')` and `[\"online\", \"busy\"]` out of the code", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const rel = file.split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (WRITERS.test(line)) return;
        if (/status\s+in\s*\(\s*'online'\s*,\s*'busy'\s*\)/.test(line) || /\[\s*"online"\s*,\s*"busy"\s*\]/.test(line) || /new Set\(\s*\[\s*"online"/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders, "use isRuntimeOnline / RUNTIME_ONLINE_STATUSES / runtimeReadySql from src/lib/employee-runtime.ts").toEqual([]);
  });
});
