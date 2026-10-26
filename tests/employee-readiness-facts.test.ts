// The workspace facts behind each role's prerequisites are read from real rows, and the same answer reaches every screen through the employee loaders. A fresh workspace has none of
// them; each fact flips only when its own evidence appears; one workspace's evidence never counts for another.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { blockingUnmet } from "@/lib/employee-requirements";
import { loadWorkspaceFacts, readinessExtrasFor } from "@/server/workforce/readiness-facts";
import { getAgentByRole, listAgents } from "@/server/workforce/service";
import { createPipeline } from "@/server/crm/pipelines";
import { createCalendar } from "@/server/calendars/setup";
import { crmOrg, type CrmOrg } from "./support/crm";
import { insertPublishedBlueprint, sampleContent } from "./support/blueprints";

let w: CrmOrg;
let other: CrmOrg;
const facts = (orgId: string) => withSystem((db) => loadWorkspaceFacts(db, orgId));

beforeAll(async () => {
  w = await crmOrg({ name: "Facts Co" });
  other = await crmOrg({ name: "Other Facts Co" });
});

describe("workspace facts", () => {
  it("are all false for a workspace that has set nothing up", async () => {
    expect(await facts(w.org.id)).toEqual({ knowledgeApproved: false, calendarReady: false, crmReady: false, pipelineReady: false, leadTargetingSet: false, customerChannelReady: false });
  });

  it("count approved company knowledge, not knowledge held for review or left empty", async () => {
    await withSystem((db) => db.query("insert into company_knowledge (org_id, section, content, review_status) values ($1, 'faq', 'held text', 'pending_agency_review'), ($1, 'policies', '', 'approved')", [w.org.id]));
    expect((await facts(w.org.id)).knowledgeApproved).toBe(false);
    await withSystem((db) => db.query("insert into company_knowledge (org_id, section, content, review_status) values ($1, 'business_description', 'We repair roofs.', 'approved')", [w.org.id]));
    expect((await facts(w.org.id)).knowledgeApproved).toBe(true);
    expect((await facts(other.org.id)).knowledgeApproved).toBe(false);
  });

  it("count saved lead targeting, an enabled customer channel, a pipeline with stages and a calendar with a host", async () => {
    await withSystem((db) => db.query("insert into lead_targeting_profiles (org_id, criteria) values ($1, '{}'::jsonb)", [w.org.id]));
    expect((await facts(w.org.id)).leadTargetingSet).toBe(false);
    await withSystem((db) => db.query("update lead_targeting_profiles set criteria = $2::jsonb where org_id = $1", [w.org.id, JSON.stringify({ industries: ["roofing"] })]));
    expect((await facts(w.org.id)).leadTargetingSet).toBe(true);

    await withSystem((db) => db.query("insert into messaging_channels (org_id, channel, enabled, sender_verified_at, registration_status) values ($1, 'email', true, now(), 'not_required')", [w.org.id]));
    expect((await facts(w.org.id)).customerChannelReady).toBe(true);
    expect((await facts(other.org.id)).customerChannelReady).toBe(false);

    expect((await facts(w.org.id)).pipelineReady).toBe(false);
    await createPipeline(w.actor("owner"), { name: "Sales", stages: [{ name: "New" }, { name: "Won", kind: "won" }] });
    expect((await facts(w.org.id)).pipelineReady).toBe(true);
    expect((await facts(other.org.id)).pipelineReady).toBe(false);

    expect((await facts(w.org.id)).calendarReady).toBe(false);
    await createCalendar(w.actor("owner"), { name: "Consults" });
    expect((await facts(w.org.id)).calendarReady).toBe(true);
    expect((await facts(other.org.id)).calendarReady).toBe(false);
  });

  it("count the CRM as set up once a Blueprint is applied, and not for another workspace", async () => {
    expect((await facts(w.org.id)).crmReady).toBe(false);
    const bp = await insertPublishedBlueprint(sampleContent());
    await withSystem((db) => db.query(
      `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, status, plan_digest, idempotency_key)
       values ($1, $2, $3, 1, 'Home services', 'initial', 'add_missing', 'applied', $4, 'facts-test-key-1')`,
      [w.org.id, bp.blueprintId, bp.versionId, "a".repeat(64)],
    ));
    expect((await facts(w.org.id)).crmReady).toBe(true);
    expect((await facts(other.org.id)).crmReady).toBe(false);
  });
});

describe("the loaders hand every screen the same extras", () => {
  it("attach each role's prerequisites to listAgents and getAgentByRole, and they match the facts", async () => {
    const agents = await listAgents(w.people.owner.id, w.org.id);
    expect(agents).toHaveLength(6);
    for (const a of agents) {
      expect(a.readiness_extras?.requirements?.length, a.role_key).toBeGreaterThan(0);
      expect(a.readiness_extras?.suspended ?? null, a.role_key).toBeNull();
      // Everything was set up above, so no role is blocked by a prerequisite.
      expect(blockingUnmet(a.readiness_extras?.requirements), a.role_key).toEqual([]);
    }
    const setter = await getAgentByRole(w.people.owner.id, w.org.id, "appointment_setter");
    expect(setter?.readiness_extras?.requirements?.find((r) => r.key === "calendar")?.met).toBe(true);
    const bare = await getAgentByRole(other.people.owner.id, other.org.id, "appointment_setter");
    expect(bare?.readiness_extras?.requirements?.find((r) => r.key === "calendar")?.met).toBe(false);
    expect(blockingUnmet(bare?.readiness_extras?.requirements).map((r) => r.key)).toEqual(["knowledge", "calendar"]);
  });

  it("make a connected employee read 'Configuration incomplete', never 'Ready', until its prerequisites exist", async () => {
    const agent = (await getAgentByRole(other.people.owner.id, other.org.id, "sales_assistant"))!;
    const now = new Date().toISOString();
    const r = deriveEmployeeReadiness({
      displayName: agent.display_name, enabled: true, status: "online", configVersion: 1, lastHealthCheckAt: now, lastHealthOk: true, credentialCurrent: true,
      inventoryContract: "hermes.api_server.tool_catalog.v1", inventoryDigest: "a".repeat(64), inventoryVerifiedAt: now, inventoryExpiresAt: new Date(Date.now() + 120_000).toISOString(), inventoryToolCount: 6,
      extras: agent.readiness_extras,
    });
    expect(r.state).toBe("configuration_incomplete");
    expect(r.workReady).toBe(false);
    expect(r.blocking.map((b) => b.key)).toEqual(["knowledge", "pipeline"]);
  });

  it("marks every employee of a suspended workspace suspended, and only that workspace", async () => {
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [other.org.id]));
    const suspended = await readinessExtrasFor(other.org.id, (await withSystem((db) => db.query<{ id: string; role_key: never }>("select id, role_key from agent_instances where org_id = $1", [other.org.id]))).rows);
    expect(suspended.size).toBe(AGENT_ROLE_KEYS.length);
    for (const e of suspended.values()) expect(e.suspended?.reason).toMatch(/suspended/);
    const fine = await readinessExtrasFor(w.org.id, (await withSystem((db) => db.query<{ id: string; role_key: never }>("select id, role_key from agent_instances where org_id = $1", [w.org.id]))).rows);
    for (const e of fine.values()) expect(e.suspended).toBeNull();
  });
});

