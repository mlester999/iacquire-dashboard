// The question asked before a paid model call: may this workspace use it now? Real services on the embedded database.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { adjustCredits } from "@/server/billing/ledger";
import { modelGate } from "@/server/llm/gate";
import { crmOrg } from "./support/crm";

const credit = (orgId: string, userId: string, usd: number) => withSystem((db) => adjustCredits(db, { orgId, deltaMicros: Math.round(usd * 1_000_000), reason: "seed credit for tests", userId }));

describe("modelGate", () => {
  it("allows an active workspace with credit, and refuses one with none when credit is asked for", async () => {
    const w = await crmOrg();
    expect(await modelGate(w.org.id, { credit: true })).toMatchObject({ allowed: false, reason: "no_credits" });
    expect(await modelGate(w.org.id, { credit: false })).toEqual({ allowed: true });
    await credit(w.org.id, w.people.owner.id, 1);
    expect(await modelGate(w.org.id, { credit: true })).toEqual({ allowed: true });
  });

  it("counts only credit that is available: what is held for other work does not count", async () => {
    const w = await crmOrg();
    await credit(w.org.id, w.people.owner.id, 1);
    await withSystem((db) => db.query("update credit_accounts set reserved_micros = balance_micros where org_id = $1", [w.org.id]));
    expect(await modelGate(w.org.id, { credit: true })).toMatchObject({ allowed: false, reason: "no_credits" });
  });

  it.each(["suspended", "archived"])("refuses a %s workspace whatever else is asked", async (status) => {
    const w = await crmOrg();
    await credit(w.org.id, w.people.owner.id, 1);
    await withSystem((db) => db.query("update organizations set status = $2 where id = $1", [w.org.id, status]));
    expect(await modelGate(w.org.id, { credit: false })).toMatchObject({ allowed: false, reason: "org_inactive" });
    expect(await modelGate(w.org.id, { credit: true, automation: "workflows" })).toMatchObject({ allowed: false, reason: "org_inactive" });
  });

  it("refuses a workspace that does not exist", async () => {
    expect(await modelGate(crypto.randomUUID(), { credit: false })).toMatchObject({ allowed: false, reason: "org_inactive" });
  });

  it("stops a background job during the agency's pause, but not a call a person started", async () => {
    const w = await crmOrg();
    await credit(w.org.id, w.people.owner.id, 1);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, set_at) values ($1, 'agency', true, now())", [w.org.id]));
    expect(await modelGate(w.org.id, { credit: true, automation: "workflows" })).toMatchObject({ allowed: false, reason: "agency_paused" });
    expect(await modelGate(w.org.id, { credit: true })).toEqual({ allowed: true });
  });
});
