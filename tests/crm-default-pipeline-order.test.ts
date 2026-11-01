// The workspace's starting pipeline ("Sales pipeline", created the first time somebody opens the board) against the industry pipeline the automatic setup adds. What it proves: an
// unused starting pipeline is replaced so the industry pipeline is the default; one that anybody has used is kept and the industry pipeline is added beside it; and the board creating
// its pipeline at the same moment as the setup never leaves two defaults (the database allows one, so an unlocked race would fail one of them).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem, type Queryable } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { provisionClientCrm, type ClientCrmSetup } from "@/server/onboarding/crm-provisioning";
import { createPipeline, ensureDefaultPipeline, listPipelines, lockDefaultPipeline, untouchedDefaultPipelineId, updateStage } from "@/server/crm/pipelines";
import { closeOpportunity, createOpportunity } from "@/server/crm/opportunities";
import { createContact } from "@/server/crm/contacts";
import type { Answers } from "@/lib/onboarding/types";
import { agencyUser, createUser, uid } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";
import { clearSetupPayment } from "./support/billing";

const before = process.env.CLIENT_CRM_AUTO_SETUP_ENABLED;
beforeAll(() => {
  process.env.CLIENT_CRM_AUTO_SETUP_ENABLED = "true";
  resetEnvCache();
});
afterAll(() => {
  if (before === undefined) delete process.env.CLIENT_CRM_AUTO_SETUP_ENABLED;
  else process.env.CLIENT_CRM_AUTO_SETUP_ENABLED = before;
  resetEnvCache();
});

const ANSWERS: Answers = { "a.business_name": "Order Roofing", "a.industry": "home_services", "a.timezone": "America/Chicago", "a.territories": "Austin" };

async function paidClient(): Promise<CrmOrg> {
  const c = await crmOrg({ name: `Order ${uid()}`, timezone: "America/Chicago" });
  const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  await withSystem(async (db) => {
    await db.query("update organizations set created_by = $2, onboarding_completed_at = now() where id = $1", [c.org.id, admin.id]);
    for (const [id, value] of Object.entries(ANSWERS)) await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, $2, $3::jsonb)", [c.org.id, id, JSON.stringify(value)]);
  });
  await clearSetupPayment(c.org.id);
  return c;
}

const pipelines = async (orgId: string) =>
  (await withSystem((db) => db.query<{ id: string; name: string; is_default: boolean; archived_at: Date | null }>("select id, name, is_default, archived_at from crm_pipelines where org_id = $1 order by created_at, name", [orgId]))).rows;
const defaults = async (orgId: string) => (await pipelines(orgId)).filter((p) => p.is_default && p.archived_at === null);
const generic = async (orgId: string) => (await pipelines(orgId)).find((p) => p.name === "Sales pipeline");
const applied = (s: ClientCrmSetup) => {
  expect(s.state).toBe("applied");
  return s as Extract<ClientCrmSetup, { state: "applied" }>;
};

describe("the starting pipeline made first by the board", () => {
  it("is archived when untouched, so the industry pipeline becomes the default", async () => {
    const c = await paidClient();
    const owner = c.actor("owner");
    const board = await listPipelines(owner, { ensureDefault: true });
    expect(board.map((p) => [p.name, p.isDefault])).toEqual([["Sales pipeline", true]]);
    const startingId = board[0].id;
    expect(await withSystem((db) => untouchedDefaultPipelineId(db, c.org.id))).toBe(startingId);

    expect(applied(await provisionClientCrm(c.org.id))).toMatchObject({ retiredGenericPipeline: true });
    expect((await defaults(c.org.id)).map((p) => p.name)).toEqual(["Jobs"]);
    expect((await generic(c.org.id))?.archived_at).not.toBeNull();
    expect((await generic(c.org.id))?.is_default).toBe(false);
    // The board now shows the industry pipelines and not the archived one.
    const after = await listPipelines(owner, { ensureDefault: true });
    expect(after.map((p) => p.name)).toEqual(["Jobs", "Maintenance plan renewals"]);
    expect(after[0].isDefault).toBe(true);
    const audit = await withSystem((db) => db.query<{ metadata: { reason: string } }>("select metadata from audit_logs where org_id = $1 and action = 'crm.pipeline_archived' and target_id = $2", [c.org.id, startingId]));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.reason).toBe("replaced_by_industry_pipeline");
  });

  it("is kept, and stays the default, when it holds a deal", async () => {
    const c = await paidClient();
    const owner = c.actor("owner");
    const board = await listPipelines(owner, { ensureDefault: true });
    const contact = await createContact(owner, { firstName: "Dana", lastName: "Reyes", email: `dana-${uid()}@example.test` });
    await createOpportunity(owner, { contactId: contact.id, name: "Roof repair", pipelineId: board[0].id });

    expect(await withSystem((db) => untouchedDefaultPipelineId(db, c.org.id))).toBeNull();
    expect(applied(await provisionClientCrm(c.org.id))).toMatchObject({ retiredGenericPipeline: false, status: "applied" });
    const all = await pipelines(c.org.id);
    expect(all.filter((p) => p.archived_at === null).map((p) => p.name).sort()).toEqual(["Jobs", "Maintenance plan renewals", "Sales pipeline"]);
    expect((await defaults(c.org.id)).map((p) => p.name)).toEqual(["Sales pipeline"]);
    const deals = await withSystem((db) => db.query("select 1 from crm_opportunities where org_id = $1 and pipeline_ref = $2 and archived_at is null", [c.org.id, board[0].id]));
    expect(deals.rows).toHaveLength(1);
  });

  it("is kept when its only deal was already closed", async () => {
    const c = await paidClient();
    const owner = c.actor("owner");
    const board = await listPipelines(owner, { ensureDefault: true });
    const contact = await createContact(owner, { firstName: "Lee", lastName: "Park", email: `lee-${uid()}@example.test` });
    const deal = await createOpportunity(owner, { contactId: contact.id, name: "Old job", pipelineId: board[0].id });
    await closeOpportunity(owner, deal.id, "won");
    expect(applied(await provisionClientCrm(c.org.id))).toMatchObject({ retiredGenericPipeline: false });
    expect((await defaults(c.org.id)).map((p) => p.name)).toEqual(["Sales pipeline"]);
  });

  it("is kept when a stage was renamed or given a probability, because somebody made it their own", async () => {
    const renamed = await paidClient();
    const board = await listPipelines(renamed.actor("owner"), { ensureDefault: true });
    await updateStage(renamed.actor("owner"), board[0].stages[0].id, { name: "Fresh enquiry" });
    expect(await withSystem((db) => untouchedDefaultPipelineId(db, renamed.org.id))).toBeNull();
    expect(applied(await provisionClientCrm(renamed.org.id))).toMatchObject({ retiredGenericPipeline: false });
    expect((await defaults(renamed.org.id)).map((p) => p.name)).toEqual(["Sales pipeline"]);

    const weighted = await paidClient();
    const board2 = await listPipelines(weighted.actor("owner"), { ensureDefault: true });
    await updateStage(weighted.actor("owner"), board2[0].stages[1].id, { probability: 20 });
    expect(await withSystem((db) => untouchedDefaultPipelineId(db, weighted.org.id))).toBeNull();
  });

  it("is kept when the client already has a second pipeline", async () => {
    const c = await paidClient();
    await listPipelines(c.actor("owner"), { ensureDefault: true });
    await createPipeline(c.actor("owner"), { name: "Referrals" });
    expect(await withSystem((db) => untouchedDefaultPipelineId(db, c.org.id))).toBeNull();
  });
});

describe("the board and the setup at the same moment", () => {
  it("leave exactly one default pipeline, whichever gets there first", async () => {
    for (let i = 0; i < 4; i += 1) {
      const c = await paidClient();
      const owner = c.actor("owner");
      const [setup] = await Promise.all([provisionClientCrm(c.org.id), listPipelines(owner, { ensureDefault: true }), withSystem((db) => ensureDefaultPipeline(db, c.system))]);
      applied(setup);
      const all = await pipelines(c.org.id);
      expect(await defaults(c.org.id), `run ${i}`).toHaveLength(1);
      // The industry pipelines exist once each and the starting pipeline is either gone (archived) or the only default beside them, never a duplicate.
      expect(all.filter((p) => p.name === "Jobs")).toHaveLength(1);
      expect(all.filter((p) => p.name === "Sales pipeline" && p.archived_at === null).length).toBeLessThanOrEqual(1);
      const board = await listPipelines(owner, { ensureDefault: true });
      expect(board.filter((p) => p.isDefault)).toHaveLength(1);
    }
  });

  it("a board that opens after the setup finds the industry pipeline and creates nothing", async () => {
    const c = await paidClient();
    applied(await provisionClientCrm(c.org.id));
    const before = await pipelines(c.org.id);
    await listPipelines(c.actor("owner"), { ensureDefault: true });
    expect(await pipelines(c.org.id)).toEqual(before);
  });
});

describe("the lock", () => {
  // The embedded database runs one transaction at a time, so a race cannot be staged in it. What can be pinned is that both sides take the SAME advisory lock, which is what makes the
  // real database queue them: the board's first creation and the setup's replacement of it.
  const heldKeys = async (db: Queryable) =>
    (await db.query<{ k: string }>("select ((classid::bigint << 32) | objid::bigint)::text as k from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()")).rows.map((r) => r.k);
  const expectedKey = async (db: Queryable, orgId: string) =>
    (await db.query<{ k: string }>("select hashtext('crm-default-pipeline:' || $1::text)::bigint::text as k", [orgId])).rows[0].k;

  it("is the lock the board takes when it creates its starting pipeline", async () => {
    const c = await paidClient();
    await withSystem(async (db) => {
      await ensureDefaultPipeline(db, c.system);
      expect(await heldKeys(db)).toContain(await expectedKey(db, c.org.id));
    });
  });

  it("is the lock the automatic setup takes, and it is held for the workspace it names only", async () => {
    const c = await paidClient();
    const other = await paidClient();
    await withSystem(async (db) => {
      await lockDefaultPipeline(db, c.org.id);
      const held = await heldKeys(db);
      expect(held).toContain(await expectedKey(db, c.org.id));
      expect(held).not.toContain(await expectedKey(db, other.org.id));
    });
  });
});
