// The workspace facts behind each role's prerequisites are read from real rows, and the same answer reaches every screen through the employee loaders. A fresh workspace has none of
// them; each fact flips only when its own evidence appears; one workspace's evidence never counts for another.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { blockingUnmet } from "@/lib/employee-requirements";
import { loadWorkspaceFacts, readinessExtrasFor } from "@/server/workforce/readiness-facts";
import { loadLaunchFactsForOrg } from "@/server/setup/launch-readiness";
import { getAgentByRole, listAgents } from "@/server/workforce/service";
import { createPipeline } from "@/server/crm/pipelines";
import { createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { crmOrg, type CrmOrg } from "./support/crm";
import { insertPublishedBlueprint, sampleContent } from "./support/blueprints";

let w: CrmOrg;
let other: CrmOrg;
const facts = (orgId: string) => withSystem((db) => loadWorkspaceFacts(db, orgId));
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

beforeAll(async () => {
  w = await crmOrg({ name: "Facts Co" });
  other = await crmOrg({ name: "Other Facts Co" });
});

describe("workspace facts", () => {
  it("treats the default native CRM as available even when the workspace has no records", async () => {
    expect(await facts(w.org.id)).toMatchObject({ knowledgeApproved: false, calendarReady: false, crmReady: true, pipelineReady: false, leadTargetingSet: false, customerChannelReady: false });
    expect((await facts(w.org.id)).knowledge).toMatchObject({ total: 9, supplied: 0, heldForReview: 0 });
  });

  it("count approved company knowledge, not knowledge held for review or left empty", async () => {
    await withSystem((db) => db.query("insert into company_knowledge (org_id, section, content, review_status) values ($1, 'faq', 'held text', 'pending_agency_review'), ($1, 'policies', '', 'approved')", [w.org.id]));
    expect((await facts(w.org.id)).knowledgeApproved).toBe(false);
    expect((await facts(w.org.id)).knowledge).toMatchObject({ total: 9, supplied: 0, heldForReview: 1 });
    await withSystem((db) => db.query("insert into company_knowledge (org_id, section, content, review_status) values ($1, 'business_description', 'We repair roofs.', 'approved')", [w.org.id]));
    expect((await facts(w.org.id)).knowledgeApproved).toBe(true);
    // The minimum flag is on, and the counts say how far from complete it is: one supplied, one held, seven still empty (an empty row is not "supplied").
    const summary = (await facts(w.org.id)).knowledge!;
    expect(summary).toMatchObject({ total: 9, supplied: 1, heldForReview: 1, suppliedNames: ["Business description"] });
    expect(summary.missing).toHaveLength(7);
    expect(summary.missing).toContain("Policies");
    expect((await facts(other.org.id)).knowledgeApproved).toBe(false);
    expect((await facts(other.org.id)).knowledge).toMatchObject({ supplied: 0, heldForReview: 0 });
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
    // An active calendar with a host but no weekly hours offers no time, so it is not "ready" yet.
    await createCalendar(w.actor("owner"), { name: "Consults" });
    expect((await facts(w.org.id)).calendarReady).toBe(false);
    await setHostAvailability(w.actor("owner"), w.people.owner.id, { timezone: "UTC", rules: WEEKDAYS });
    expect((await facts(w.org.id)).calendarReady).toBe(true);
    expect((await facts(other.org.id)).calendarReady).toBe(false);
  });

  it("does not count a calendar connection on its own as a calendar that takes bookings", async () => {
    const c = await crmOrg();
    await withSystem((db) => db.query(
      "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, write_events, external_calendar_id) values ($1, $2, 'google', $3, 'connected', true, 'primary')",
      [c.org.id, c.people.owner.id, `${c.org.id}@example.test`],
    ));
    expect((await facts(c.org.id)).calendarReady).toBe(false);
    // A read-only feed is the same: busy times are not a place to book.
    await withSystem((db) => db.query(
      "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, write_events) values ($1, $2, 'ics', $3, 'connected', false)",
      [c.org.id, c.people.sales.id, `${c.org.id}-feed@example.test`],
    ));
    expect((await facts(c.org.id)).calendarReady).toBe(false);
    // The connection does not stop a real, ready calendar from counting.
    await setHostAvailability(c.actor("owner"), c.people.owner.id, { timezone: "UTC", rules: WEEKDAYS });
    await createCalendar(c.actor("owner"), { name: "Visits", members: [{ userId: c.people.owner.id }] });
    expect((await facts(c.org.id)).calendarReady).toBe(true);
  });

  it("needs the calendar to be active, not archived, with a current host who has weekly hours", async () => {
    const c = await crmOrg();
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "UTC", rules: WEEKDAYS });
    const cal = await createCalendar(owner, { name: "Visits", members: [{ userId: c.people.owner.id }] });
    expect((await facts(c.org.id)).calendarReady).toBe(true);

    // A draft calendar plus a host (with hours) is not ready.
    await withSystem((db) => db.query("update crm_calendars set status = 'draft', public = false, is_default = false where id = $1", [cal.id]));
    expect((await facts(c.org.id)).calendarReady).toBe(false);
    await withSystem((db) => db.query("update crm_calendars set status = 'active' where id = $1", [cal.id]));
    expect((await facts(c.org.id)).calendarReady).toBe(true);

    // The only host loses their hours, leaves the workspace or is suspended: nobody could take a booking.
    const saved = await withSystem((db) => db.query<{ weekday: number; start_minute: number; end_minute: number }>("select weekday, start_minute, end_minute from crm_availability_rules where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    await withSystem((db) => db.query("delete from crm_availability_rules where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    expect((await facts(c.org.id)).calendarReady).toBe(false);
    for (const r of saved.rows) await withSystem((db) => db.query("insert into crm_availability_rules (org_id, user_id, weekday, start_minute, end_minute) values ($1, $2, $3, $4, $5)", [c.org.id, c.people.owner.id, r.weekday, r.start_minute, r.end_minute]));
    expect((await facts(c.org.id)).calendarReady).toBe(true);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    expect((await facts(c.org.id)).calendarReady).toBe(false);
    await withSystem((db) => db.query("update organization_memberships set status = 'active' where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [c.people.owner.id]));
    expect((await facts(c.org.id)).calendarReady).toBe(false);
    await withSystem((db) => db.query("update users set status = 'active' where id = $1", [c.people.owner.id]));
    expect((await facts(c.org.id)).calendarReady).toBe(true);

    // Archived: gone.
    await withSystem((db) => db.query("update crm_calendars set archived_at = now() where id = $1", [cal.id]));
    expect((await facts(c.org.id)).calendarReady).toBe(false);
  });

  it("does not count a pipeline whose stages are all archived or all closing stages", async () => {
    const c = await crmOrg();
    const pipeline = await createPipeline(c.actor("owner"), { name: "Sales", stages: [{ name: "New" }, { name: "Won", kind: "won" }] });
    expect((await facts(c.org.id)).pipelineReady).toBe(true);
    // The only open stage is archived: what is left is Won, which holds no deals.
    await withSystem((db) => db.query("update crm_pipeline_stages set archived_at = now() where pipeline_id = $1 and kind = 'open'", [pipeline.id]));
    expect((await facts(c.org.id)).pipelineReady).toBe(false);
    await withSystem((db) => db.query("update crm_pipeline_stages set archived_at = null where pipeline_id = $1 and kind = 'open'", [pipeline.id]));
    expect((await facts(c.org.id)).pipelineReady).toBe(true);
    // Every stage archived.
    await withSystem((db) => db.query("update crm_pipeline_stages set archived_at = now() where pipeline_id = $1", [pipeline.id]));
    expect((await facts(c.org.id)).pipelineReady).toBe(false);
    // An archived pipeline never counts, whatever its stages.
    await withSystem((db) => db.query("update crm_pipeline_stages set archived_at = null where pipeline_id = $1", [pipeline.id]));
    await withSystem((db) => db.query("update crm_pipelines set archived_at = now() where id = $1", [pipeline.id]));
    expect((await facts(c.org.id)).pipelineReady).toBe(false);
  });

  it("asks for the same pipeline the launch panel does: two or more stages, one of them open, so the two screens agree", async () => {
    const launchSays = async (orgId: string) => (await loadLaunchFactsForOrg(orgId))!.crm.pipelineReady;
    // A board with one stage is a list: neither screen counts it.
    const one = await crmOrg();
    await createPipeline(one.actor("owner"), { name: "Only stage", stages: [{ name: "New" }] });
    expect((await facts(one.org.id)).pipelineReady).toBe(false);
    expect(await launchSays(one.org.id)).toBe(false);
    // An open stage and a closing one is a board, and both screens say so.
    const two = await crmOrg();
    const pipeline = await createPipeline(two.actor("owner"), { name: "Sales", stages: [{ name: "New" }, { name: "Won", kind: "won" }] });
    expect((await facts(two.org.id)).pipelineReady).toBe(true);
    expect(await launchSays(two.org.id)).toBe(true);
    // Archive the closing stage and one stage is left: both go back to false together.
    await withSystem((db) => db.query("update crm_pipeline_stages set archived_at = now() where pipeline_id = $1 and kind = 'won'", [pipeline.id]));
    expect((await facts(two.org.id)).pipelineReady).toBe(false);
    expect(await launchSays(two.org.id)).toBe(false);
    // Two stages that are both closing hold no deals, so neither counts them.
    const closing = await crmOrg();
    const closed = await createPipeline(closing.actor("owner"), { name: "Closed only", stages: [{ name: "New" }, { name: "Won", kind: "won" }, { name: "Lost", kind: "lost" }] });
    expect(await launchSays(closing.org.id)).toBe(true);
    await withSystem((db) => db.query("update crm_pipeline_stages set archived_at = now() where pipeline_id = $1 and kind = 'open'", [closed.id]));
    expect((await facts(closing.org.id)).pipelineReady).toBe(false);
    expect(await launchSays(closing.org.id)).toBe(false);
  });

  it("counts native CRM readiness independently of Blueprint applications and record counts", async () => {
    expect((await facts(w.org.id)).crmReady).toBe(true);
    const bp = await insertPublishedBlueprint(sampleContent());
    await withSystem((db) => db.query(
      `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, status, plan_digest, idempotency_key)
       values ($1, $2, $3, 1, 'Home services', 'initial', 'add_missing', 'applied', $4, 'facts-test-key-1')`,
      [w.org.id, bp.blueprintId, bp.versionId, "a".repeat(64)],
    ));
    expect((await facts(w.org.id)).crmReady).toBe(true);
    expect((await facts(other.org.id)).crmReady).toBe(true);
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

