import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createOrg, createUser } from "./support/fixtures";

// A module is dormant until a Super Admin switches a workspace on (a row in org_features). The rollbacks of 0093 and 0095 delete their module's switch, so a rolled-back
// module that is applied again comes back off. The rollbacks of 0091, 0092 and 0094 must do the same: otherwise a fix-forward after a failed release turns every workspace
// that had the module back on at once. Each case runs inside a transaction that is always rolled back.

class Done extends Error {}
const script = (name: string) => readFileSync(`supabase/rollbacks/${name}.down.sql`, "utf8");

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
const FEATURES = ["proposals", "esign", "invoices", "reputation_surveys", "reputation_batches", "reputation_reviews", "inbox_labs"];

async function switches(db: Db, orgId: string): Promise<string[]> {
  return (await db.query<{ feature: string }>("select feature from org_features where org_id = $1 order by feature", [orgId])).rows.map((r) => r.feature);
}

async function world() {
  const org = await createOrg({ name: "Switch Rollback Co" });
  const other = await createOrg({ name: "Other Switch Rollback Co" });
  const admin = await createUser({ platformRole: "agency_super_admin" });
  return { org, other, admin };
}

/** Both workspaces have every switch on, as after a rollout; "inbox_labs" stands for a switch that belongs to no Wave 1 module. */
async function switchEverythingOn(db: Db, w: Awaited<ReturnType<typeof world>>) {
  for (const orgId of [w.org.id, w.other.id]) {
    for (const feature of FEATURES) await db.query("insert into org_features (org_id, feature, enabled, updated_by) values ($1, $2, true, $3)", [orgId, feature, w.admin.id]);
  }
}

describe("the rollbacks take their module's workspace switch with them", () => {
  it("0092 removes the 'esign' switch and nothing else", async () => {
    const w = await world();
    let left: string[] = [];
    let leftOther: string[] = [];
    await expect(withSystem(async (db) => {
      await switchEverythingOn(db, w);
      for (const stmt of statements(script("0092_esign"))) await db.query(stmt);
      left = await switches(db, w.org.id);
      leftOther = await switches(db, w.other.id);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(left).toEqual(FEATURES.filter((f) => f !== "esign").sort());
    expect(leftOther).toEqual(left);
  });

  it("0091 removes the 'proposals' switch and nothing else (after 0092, whose tables hang off proposals)", async () => {
    const w = await world();
    let left: string[] = [];
    await expect(withSystem(async (db) => {
      await switchEverythingOn(db, w);
      for (const stmt of statements(script("0092_esign"))) await db.query(stmt);
      for (const stmt of statements(script("0091_proposals"))) await db.query(stmt);
      left = await switches(db, w.org.id);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(left).toEqual(FEATURES.filter((f) => f !== "esign" && f !== "proposals").sort());
  });

  it("0094 removes the 'reputation_surveys' and 'reputation_batches' switches and leaves 'reputation_reviews' (0095's) and the rest", async () => {
    const w = await world();
    let left: string[] = [];
    await expect(withSystem(async (db) => {
      await switchEverythingOn(db, w);
      for (const stmt of statements(script("0094_reputation_followthrough"))) await db.query(stmt);
      left = await switches(db, w.org.id);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(left).toEqual(FEATURES.filter((f) => f !== "reputation_surveys" && f !== "reputation_batches").sort());
  });

  it("a workspace is dormant again after a rollback and a re-apply: no switch row is left to find", async () => {
    const w = await world();
    let left: string[] = [];
    await expect(withSystem(async (db) => {
      await switchEverythingOn(db, w);
      // The order an operator rolls back in: newest first. 0095 and 0093 were already correct; 0094, 0092 and 0091 are the ones that left their rows.
      for (const name of ["0095_external_reviews", "0094_reputation_followthrough", "0093_customer_invoices_payments", "0092_esign", "0091_proposals"]) {
        for (const stmt of statements(script(name))) await db.query(stmt);
      }
      left = await switches(db, w.org.id);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(left).toEqual(["inbox_labs"]);
  });
});
