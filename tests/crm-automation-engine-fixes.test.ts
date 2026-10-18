// Regression tests for the Phase 4 review findings 1-12 (workflow engine correctness and automation security). Every outside call is
// mocked: the n8n call, the HTTPS transport and DNS. Nothing leaves the machine.
import crypto from "node:crypto";
import https from "node:https";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/integrations/n8n-actions", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/integrations/n8n-actions")>();
  return { ...mod, callN8nWorkflow: vi.fn(async () => ({ status: "sent", retryable: false, detail: "n8n accepted the request (HTTP 200).", httpStatus: 200 })) };
});

import { withSystem } from "@/server/db";
import { decideApproval } from "@/server/approvals/service";
import { callN8nWorkflow } from "@/server/integrations/n8n-actions";
import { type CrmActor } from "@/server/crm/actor";
import { createContact } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { createAssignmentRule } from "@/server/crm/assignment";
import { createCustomField, setCustomFieldArchived, setRecordFields, updateCustomField } from "@/server/crm/fields";
import { crmEventDispatch, SUBSCRIBERS, type Subscriber } from "@/server/crm/dispatch";
import { createWorkflow, publishWorkflow, requestWorkflowApproval, saveWorkflowDraft, setWorkflowStatus, updateWorkflowSettings, getWorkflow } from "@/server/crm/workflows/definitions";
import { getRun, startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { handleInboundWebhook, inboundToken } from "@/server/crm/workflows/inbound";
import { hostResolver } from "@/server/calendars/adapters/http";
import { checkedLookup, pinnedHttps, UnsafeAddressError } from "@/server/security/pinned-https";
import { createApiKey } from "@/server/crm/api-keys";
import { createWebhookSubscription, sendTestWebhook, updateWebhookSubscription } from "@/server/crm/webhooks";
import { issueAgentToolToken } from "@/server/crm/agent-tools/tokens";
import { AGENT_TOOL_SCOPES } from "@/server/crm/agent-tools/catalog";
import { callAgentTool } from "@/server/crm/agent-tools/service";
import { GET as listContactsRoute } from "@/app/api/v1/crm/contacts/route";
import { GET as getContactRoute } from "@/app/api/v1/crm/contacts/[id]/route";
import { POST as contactTagsRoute } from "@/app/api/v1/crm/contacts/[id]/tags/route";
import type { Permission } from "@/lib/permissions";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { agentId, ctxFor, uid } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

const n8nMock = vi.mocked(callN8nWorkflow);
afterEach(() => {
  n8nMock.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;
const chain = (...steps: WorkflowStep[]): WorkflowStep[] => steps.map((s, i) => (s.kind === "branch" || s.kind === "end" || s.next ? s : { ...s, next: steps[i + 1]?.key ?? null }));

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows[0] as T;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);

async function runsOf(workflowId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; status: string; version_id: string; contact_id: string | null; context: Record<string, unknown>; last_error: string | null; attempts: number; next_run_at: Date; trigger_event_id: string | null }>(
      "select id, status, version_id, contact_id, context, last_error, attempts, next_run_at, trigger_event_id from crm_workflow_runs where workflow_id = $1 order by created_at, id",
      [workflowId],
    ),
  );
  return rows;
}

async function stepsOf(runId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ step_key: string; status: string; result: Record<string, unknown>; error: string | null }>("select step_key, status, result, error from crm_workflow_run_steps where run_id = $1 order by id", [runId]),
  );
  return rows;
}

async function liveWorkflow(o: CrmOrg, definition: WorkflowDefinition, opts: { name?: string; hourlyRunLimit?: number; actor?: CrmActor } = {}) {
  const actor = opts.actor ?? o.actor("owner");
  const { id } = await createWorkflow(actor, { name: opts.name ?? `Workflow ${uid()}`, definition });
  if (opts.hourlyRunLimit) await updateWorkflowSettings(actor, id, { hourlyRunLimit: opts.hourlyRunLimit });
  const published = await publishWorkflow(actor, id);
  if (!published.needsApproval) await setWorkflowStatus(actor, id, "active");
  return { id, published };
}

async function ownerApproves(o: CrmOrg, workflowId: string) {
  const req = await requestWorkflowApproval(o.actor("manager"), workflowId, null, { activate: true });
  expect(req.status).toBe("requested");
  const decided = await decideApproval(ctxFor(o.people.owner, o.org, "owner"), req.approvalId!, "approve");
  expect(decided.outcome?.status).toBe("succeeded");
}

async function verifiedN8nMapping(o: CrmOrg) {
  return withSystem(async (db) => {
    const conn = await db.query<{ id: string }>(
      `insert into integration_connections (org_id, provider, label, config, status) values (null, 'n8n', 'Agency n8n', '{}'::jsonb, 'connected')
       on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider) do update set status = 'connected' returning id`,
    );
    const m = await db.query<{ id: string }>(
      "insert into automation_template_mappings (org_id, global_connection_id, workflow_id, status, last_verified_at) values ($1, $2, $3, 'verified', now()) returning id",
      [o.org.id, conn.rows[0].id, `wf${uid()}`],
    );
    return m.rows[0].id;
  });
}

const contactIn = async (o: CrmOrg, over: Parameters<typeof createContact>[1] = {}) => (await createContact(o.actor("owner"), { firstName: "Lead", lastName: uid(), ...over })).id;
const eventFor = async (orgId: string, type: string, entityId: string) =>
  Number((await one<{ id: string }>("select id::text as id from crm_events where org_id = $1 and type = $2 and entity_id = $3", [orgId, type, entityId])).id);

// ---------------------------------------------------------------------------
// 1. One broken trigger filter doesn't block the other workflows on the event
// ---------------------------------------------------------------------------

describe("finding 1: trigger filters are checked one workflow at a time", () => {
  it("skips (and reports once) a workflow whose filter stopped working, and still starts the others", async () => {
    const o = await crmOrg({ name: "Broken Filter Co" });
    const owner = o.actor("owner");
    const field = await createCustomField(owner, { entity: "contact", label: `Renewal ${uid()}`, type: "date" });
    const tag = await createTag(owner, { name: `Started ${uid()}` });
    const a = await liveWorkflow(o, {
      trigger: { type: "contact.created", contactFilter: { op: "and", conditions: [{ field: `cf:${field.id}`, op: "is_not_empty" }] } },
      steps: [step("tag", "add_tag", { tagIds: [tag.id] })],
    }, { name: "Filtered" });
    const b = await liveWorkflow(o, { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] }, { name: "Unfiltered" });

    // The field can't be archived while an active workflow checks it.
    await expect(setCustomFieldArchived(owner, field.id, true)).rejects.toThrow(/Filtered/);
    // Archived anyway (as by an older build): the filter no longer compiles.
    await withSystem((db) => db.query("update crm_custom_fields set archived_at = now() where id = $1", [field.id]));

    const contactId = await contactIn(o);
    const ev = await eventFor(o.org.id, "contact.created", contactId);
    await crmEventDispatch();
    const row = await one<{ dispatched_at: Date | null; dispatch_error: string | null }>("select dispatched_at, dispatch_error from crm_events where id = $1", [ev]);
    expect(row.dispatch_error).toBeNull();
    expect(row.dispatched_at).not.toBeNull();
    expect(await runsOf(a.id)).toHaveLength(0);
    expect((await runsOf(b.id)).map((r) => r.contact_id)).toEqual([contactId]);
    const notes = await withSystem((db) => db.query<{ title: string; body: string; link: string }>(
      "select title, body, link from notifications where org_id = $1 and kind = 'crm_workflow_failed' and dedupe_key like 'crm-wf-trigger-broken:%'",
      [o.org.id],
    ));
    expect(notes.rows.length).toBeGreaterThan(0);
    expect(notes.rows[0].title).toMatch(/Filtered/);
    expect(notes.rows[0].body).toMatch(/trigger filter no longer works/);
    expect(notes.rows[0].link).toBe(`/crm/workflows/${a.id}`);
    // A second event: still isolated, and the owners aren't told again.
    const before = notes.rows.length;
    await contactIn(o);
    await crmEventDispatch();
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and dedupe_key like 'crm-wf-trigger-broken:%'", [o.org.id])).toBe(before);
    expect(await runsOf(b.id)).toHaveLength(2);
  });

  it("refuses to remove a choice an active workflow's filter checks", async () => {
    const o = await crmOrg({ name: "Choice Co" });
    const owner = o.actor("owner");
    const field = await createCustomField(owner, { entity: "contact", label: `Plan ${uid()}`, type: "select", options: ["Gold", "Silver"] });
    const [gold, silver] = field.options.map((x) => x.value);
    const tag = await createTag(owner, { name: `Gold ${uid()}` });
    await liveWorkflow(o, {
      trigger: { type: "contact.created", contactFilter: { op: "and", conditions: [{ field: `cf:${field.id}`, op: "in", value: [gold] }] } },
      steps: [step("tag", "add_tag", { tagIds: [tag.id] })],
    }, { name: "Gold members" });
    await expect(updateCustomField(owner, field.id, { options: field.options.filter((x) => x.value !== gold) })).rejects.toThrow(/Gold members/);
    // A choice nothing checks can go.
    await updateCustomField(owner, field.id, { options: field.options.filter((x) => x.value !== silver) });
  });
});

// ---------------------------------------------------------------------------
// 2. "Assign through a rule" decides afresh, not from the dispatcher's earlier decision
// ---------------------------------------------------------------------------

describe("finding 2: an assign-through-rule step applies its rule", () => {
  it("isn't answered with the auto-assignment decision recorded for the same event", async () => {
    const o = await crmOrg({ name: "Rule Step Co" });
    const owner = o.actor("owner");
    const rule = await createAssignmentRule(owner, { name: "Working hours", entity: "contact", strategy: "round_robin", respectWorkingHours: true, members: [{ userId: o.people.setter.id }], active: true });
    const { id } = await liveWorkflow(o, { trigger: { type: "contact.created" }, steps: [step("route", "assign", { subject: "contact", to: "rule", ruleId: rule.id, onlyIfUnassigned: true })] });
    const contactId = await contactIn(o);
    const ev = await eventFor(o.org.id, "contact.created", contactId);
    await crmEventDispatch();
    // The dispatcher's auto-assignment found nobody working and recorded that for this event.
    expect(await one<{ outcome: string }>("select outcome from crm_assignment_history where entity_id = $1 and event_id = $2", [contactId, ev])).toMatchObject({ outcome: "unassigned" });
    await withSystem((db) => db.query("update crm_assignment_rules set respect_working_hours = false where id = $1", [rule.id]));
    await processWorkflowRuns();
    const [run] = await runsOf(id);
    const [s] = await stepsOf(run.id);
    expect(s.status).toBe("completed");
    expect(s.result).toMatchObject({ outcome: "assigned", userId: o.people.setter.id });
    expect(s.result.duplicate).toBeFalsy();
    expect((await one<{ assigned_user_id: string | null }>("select assigned_user_id from contacts where id = $1", [contactId])).assigned_user_id).toBe(o.people.setter.id);
  });
});

// ---------------------------------------------------------------------------
// 3. A call refused by the hourly limit can be retried with the same Idempotency-Key
// ---------------------------------------------------------------------------

describe("finding 3: inbound idempotency ignores calls the hourly limit refused", () => {
  it("starts a retried call once the limit allows it", async () => {
    const o = await crmOrg({ name: "Inbound Limit Co" });
    const owner = o.actor("owner");
    const tag = await createTag(owner, { name: `Inbound ${uid()}` });
    const nonce = `n${crypto.randomBytes(12).toString("hex")}`;
    const { id } = await liveWorkflow(o, { trigger: { type: "inbound_webhook", inbound: { nonce, match: "none", createContact: false } }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] }, { hourlyRunLimit: 1 });
    const token = inboundToken(id, nonce);
    expect(await handleInboundWebhook({ token, body: { n: 1 }, idempotencyKey: "k1" })).toMatchObject({ httpStatus: 202 });
    expect(await handleInboundWebhook({ token, body: { n: 2 }, idempotencyKey: "k2" })).toMatchObject({ httpStatus: 429, body: { status: "not_started" } });
    await updateWorkflowSettings(owner, id, { hourlyRunLimit: 100 });
    const retried = await handleInboundWebhook({ token, body: { n: 2 }, idempotencyKey: "k2" });
    expect(retried).toMatchObject({ httpStatus: 202, body: { status: "accepted" } });
    // And an accepted call is still answered as a duplicate.
    expect(await handleInboundWebhook({ token, body: { n: 2 }, idempotencyKey: "k2" })).toMatchObject({ httpStatus: 200, body: { status: "duplicate", runId: retried.body.runId } });
  });
});

// ---------------------------------------------------------------------------
// 4. Date-only waits are 9:00 on that day in the workspace's time zone
// ---------------------------------------------------------------------------

describe("finding 4: waits until a date-only value", () => {
  for (const [timezone, expected] of [["UTC", "2027-03-10T09:00:00.000Z"], ["America/Los_Angeles", "2027-03-10T17:00:00.000Z"], ["Asia/Tokyo", "2027-03-10T00:00:00.000Z"]] as const) {
    it(`wait until 9:00 on the date in ${timezone}`, async () => {
      const o = await crmOrg({ name: `Dates ${timezone}`, timezone });
      const owner = o.actor("owner");
      const field = await createCustomField(owner, { entity: "contact", label: `Renewal ${uid()}`, type: "date" });
      const tag = await createTag(owner, { name: `Renewed ${uid()}` });
      const { id } = await liveWorkflow(o, {
        trigger: { type: "manual" },
        steps: chain(
          step("wait", "wait", { mode: "until_date", source: "contact_field", fieldId: field.id, offset: { amount: 0, unit: "days", direction: "before" }, ifMissing: "continue" }),
          step("tag", "add_tag", { tagIds: [tag.id] }),
        ),
      });
      const contactId = await contactIn(o);
      await setRecordFields(owner, "contact", contactId, { [field.id]: "2027-03-10" });
      const { runId } = await startManualRun(owner, id, { contactId });
      await processWorkflowRuns({ now: new Date("2027-01-05T12:00:00Z") });
      const run = await getRun(owner, runId);
      expect(run.status).toBe("waiting");
      expect(run.waitingUntil).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. n8n steps are held (not failed) while n8n's own gate would refuse them
// ---------------------------------------------------------------------------

describe("finding 5: n8n steps under a pause or a passing refusal", () => {
  let o: CrmOrg;
  let workflowId: string;
  beforeAll(async () => {
    o = await crmOrg({ name: "n8n Hold Co" });
    const mappingId = await verifiedN8nMapping(o);
    const tag = await createTag(o.actor("owner"), { name: `After n8n ${uid()}` });
    workflowId = (await liveWorkflow(o, { trigger: { type: "manual" }, steps: chain(step("n8n", "n8n", { mappingId, includeContact: false }), step("tag", "add_tag", { tagIds: [tag.id] })) })).id;
    await ownerApproves(o, workflowId);
  });

  it("holds the run under a messaging pause without calling n8n, and continues when it lifts", async () => {
    const owner = o.actor("owner");
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason, set_at) values ($1, 'messaging', true, 'Quiet week', now()) on conflict (org_id, scope) do update set active = true", [o.org.id]));
    // What n8n's own gate answers under that pause.
    n8nMock.mockResolvedValue({ status: "blocked", retryable: true, detail: "Outbound automation is paused for this workspace." });
    const { runId } = await startManualRun(owner, workflowId, { contactId: await contactIn(o) });
    const t = Date.now();
    await processWorkflowRuns({ now: new Date(t) });
    let run = await getRun(owner, runId);
    expect(run.status).toBe("queued");
    expect(run.lastError).toMatch(/^On hold: /);
    expect(n8nMock).not.toHaveBeenCalled();
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'crm_workflow_failed'", [o.org.id])).toBe(0);
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1 and scope = 'messaging'", [o.org.id]));
    n8nMock.mockReset();
    n8nMock.mockResolvedValue({ status: "sent", retryable: false, detail: "n8n accepted the request (HTTP 200).", httpStatus: 200 });
    await processWorkflowRuns({ now: new Date(t + 16 * 60_000) });
    run = await getRun(owner, runId);
    expect(run.status).toBe("completed");
    expect(n8nMock).toHaveBeenCalledTimes(1);
  });

  it("holds the run (without using up an attempt) when n8n refuses for a reason that can pass", async () => {
    const owner = o.actor("owner");
    n8nMock.mockReset();
    n8nMock.mockResolvedValueOnce({ status: "blocked", retryable: true, detail: "The agency n8n connection needs attention." });
    n8nMock.mockResolvedValue({ status: "sent", retryable: false, detail: "n8n accepted the request (HTTP 200).", httpStatus: 200 });
    const { runId } = await startManualRun(owner, workflowId, { contactId: await contactIn(o) });
    const t = Date.now();
    await processWorkflowRuns({ now: new Date(t) });
    const held = (await runsOf(workflowId)).find((r) => r.id === runId)!;
    expect(held.status).toBe("queued");
    expect(held.attempts).toBe(0);
    expect(held.last_error).toMatch(/On hold: .*needs attention/);
    expect(new Date(held.next_run_at).getTime()).toBeGreaterThan(t + 10 * 60_000);
    expect(held.context.inflight).toBeUndefined();
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'crm_workflow_failed'", [o.org.id])).toBe(0);
    await processWorkflowRuns({ now: new Date(t + 16 * 60_000) });
    expect((await getRun(owner, runId)).status).toBe("completed");
    expect(n8nMock).toHaveBeenCalledTimes(2);
    expect(n8nMock.mock.calls[1][0].idempotencyKey).toBe(n8nMock.mock.calls[0][0].idempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// 6. A redelivered event starts a workflow once, even after a new version is published
// ---------------------------------------------------------------------------

describe("finding 6: one run per workflow and event", () => {
  it("doesn't start the new version for an event the old version already took", async () => {
    const o = await crmOrg({ name: "Redelivery Co" });
    const owner = o.actor("owner");
    const tag = await createTag(owner, { name: `Once ${uid()}` });
    const other = await createTag(owner, { name: `Twice ${uid()}` });
    const { id } = await liveWorkflow(o, { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] });
    let failed = false;
    const flaky: Subscriber = { name: "flaky", run: async () => {
      if (!failed) {
        failed = true;
        throw new Error("flaky");
      }
    } };
    const subscribers = [SUBSCRIBERS[0], flaky];
    await crmEventDispatch({ limit: 500 });
    const contactId = await contactIn(o);
    const t = Date.now();
    await crmEventDispatch({ subscribers, now: new Date(t) });
    expect(await runsOf(id)).toHaveLength(1);
    // An internal-only edit published in between keeps the workflow on, with a new version.
    const w = await getWorkflow(owner, id);
    await saveWorkflowDraft(owner, id, { definition: { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [other.id] })] }, expectedRevision: w.draftRevision });
    const v2 = await publishWorkflow(owner, id);
    expect(v2.created).toBe(true);
    expect((await getWorkflow(owner, id)).status).toBe("active");
    await crmEventDispatch({ subscribers, now: new Date(t + 6 * 60_000) });
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].contact_id).toBe(contactId);
  });
});

// ---------------------------------------------------------------------------
// 7. API keys and webhooks never do more than the person who set them up
// ---------------------------------------------------------------------------

/** The person's role minus permissions withdrawn individually (the override row is written too, as the owner's screen would). */
async function withdraw(o: CrmOrg, who: "manager" | "sales", permissions: Permission[]): Promise<CrmActor> {
  for (const p of permissions) {
    await withSystem((db) => db.query(
      "insert into member_permission_overrides (org_id, user_id, permission, effect, reason) values ($1, $2, $3, 'revoke', 'test') on conflict (org_id, user_id, permission) do update set effect = 'revoke'",
      [o.org.id, o.people[who].id, p],
    ));
  }
  const base = o.actor(who);
  return { ...base, can: (p: Permission) => !permissions.includes(p) && base.can(p) };
}
const restore = (o: CrmOrg, who: "manager" | "sales") => withSystem((db) => db.query("delete from member_permission_overrides where org_id = $1 and user_id = $2", [o.org.id, o.people[who].id]));

const API = "http://localhost/api/v1/crm";
const apiReq = (path: string, key: string, init: { body?: unknown } = {}) =>
  new Request(`${API}${path}`, {
    method: init.body !== undefined ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const idParam = (id: string) => ({ params: Promise.resolve({ id }) });

describe("finding 7: API keys and webhook subscriptions are bounded by their creator's access", () => {
  const originalLookup = hostResolver.lookup;
  beforeAll(() => {
    hostResolver.lookup = async (host: string) => {
      if (host.endsWith(".example.test")) return ["93.184.216.34"];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    };
  });
  afterAll(() => {
    hostResolver.lookup = originalLookup;
  });

  it("refuses a key with scopes its creator doesn't fully hold", async () => {
    const o = await crmOrg({ name: "Key Scope Co" });
    const restricted = await withdraw(o, "manager", ["contacts.view", "contacts.export"]);
    await expect(createApiKey(restricted, { name: "Export", scopes: ["contacts.read"] })).rejects.toThrow(/permissions you have yourself.*read contacts/);
    await expect(createApiKey(restricted, { name: "Sync", scopes: ["contacts.write"] })).rejects.toThrow(/create and update contacts/);
    // Deal scopes are within what they hold.
    expect((await createApiKey(restricted, { name: "Deals", scopes: ["opportunities.read"] })).key.scopes).toEqual(["opportunities.read"]);
    await restore(o, "manager");
    // Tag changes edit contacts, so they need that too.
    const noEdit = await withdraw(o, "manager", ["contacts.edit"]);
    await expect(createApiKey(noEdit, { name: "Tags", scopes: ["tags.write"] })).rejects.toThrow(/tag contacts/);
    await restore(o, "manager");
  });

  it("suspends a key's scopes once its creator loses the access, and restores them when it comes back", async () => {
    const o = await crmOrg({ name: "Key Revoke Co" });
    await contactIn(o, { email: `someone-${uid()}@example.test` });
    const { secret } = await createApiKey(o.actor("manager"), { name: "Bridge", scopes: ["contacts.read"] });
    expect((await listContactsRoute(apiReq("/contacts", secret))).status).toBe(200);
    await withdraw(o, "manager", ["contacts.view"]);
    const refused = await listContactsRoute(apiReq("/contacts", secret));
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { code: string; message: string; details: { suspended?: string[] } } };
    expect(body.error).toMatchObject({ code: "insufficient_scope", details: { suspended: ["contacts.read"] } });
    expect(body.error.message).toMatch(/suspended/);
    await restore(o, "manager");
    expect((await listContactsRoute(apiReq("/contacts", secret))).status).toBe(200);
    // A creator who left the workspace leaves the key with nothing.
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [o.org.id, o.people.manager.id]));
    expect((await listContactsRoute(apiReq("/contacts", secret))).status).toBe(403);
    await withSystem((db) => db.query("update organization_memberships set status = 'active' where org_id = $1 and user_id = $2", [o.org.id, o.people.manager.id]));
  });

  it("refuses webhook events its creator can't see, and stops queueing them when the creator loses access", async () => {
    const o = await crmOrg({ name: "Hook Scope Co" });
    const restricted = await withdraw(o, "manager", ["contacts.view"]);
    const input = { name: "CRM sync", url: "https://hooks.example.test/in", eventTypes: ["contact.created"] };
    await expect(createWebhookSubscription(restricted, input)).rejects.toThrow(/contacts events/);
    await expect(createWebhookSubscription(restricted, { ...input, eventTypes: ["note.added"] })).rejects.toThrow(/notes events/);
    const deals = await createWebhookSubscription(restricted, { ...input, eventTypes: ["opportunity.created"] });
    await expect(updateWebhookSubscription(restricted, deals.id, { ...input, eventTypes: ["opportunity.created", "contact.updated"] })).rejects.toThrow(/contacts events/);
    await restore(o, "manager");

    const sub = await createWebhookSubscription(o.actor("manager"), input);
    await crmEventDispatch({ limit: 500 });
    await contactIn(o);
    await crmEventDispatch();
    expect(await count("select count(*)::text as n from crm_webhook_deliveries where subscription_id = $1", [sub.id])).toBe(1);
    await withdraw(o, "manager", ["contacts.view"]);
    await contactIn(o);
    await crmEventDispatch();
    expect(await count("select count(*)::text as n from crm_webhook_deliveries where subscription_id = $1", [sub.id])).toBe(1);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'crm_webhook_failing' and dedupe_key like $2", [o.org.id, `crm-webhook-withheld:${sub.id}:%`])).toBeGreaterThan(0);
    await restore(o, "manager");
    await withSystem((db) => db.query("update crm_webhook_deliveries set status = 'dead' where subscription_id = $1", [sub.id]));
  });
});

// ---------------------------------------------------------------------------
// 8. A workflow can't do more than the people who publish and switch it on
// ---------------------------------------------------------------------------

describe("finding 8: publishing and switching on need the permissions the steps use", () => {
  it("refuses an assign-to-self workflow from someone who can't assign, at publish and at switch-on", async () => {
    const o = await crmOrg({ name: "Workflow Rights Co" });
    // A sales rep given "Build and change automations", but not "Assign contacts and deals to others".
    const base = o.actor("sales");
    const rep: CrmActor = { ...base, can: (p) => p === "workflows.manage" || p === "workflows.view" || base.can(p) };
    expect(rep.can("contacts.assign")).toBe(false);
    const definition: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("me", "assign", { subject: "contact", to: "user", userId: o.people.sales.id, onlyIfUnassigned: false })] };
    const { id } = await createWorkflow(rep, { name: "Route to me", definition });
    await expect(publishWorkflow(rep, id)).rejects.toThrow(/“Assign contacts and deals to others” permission, because the step "Assign owner" assigns owners/);
    // Published by the owner, it still can't be switched on by the rep.
    await publishWorkflow(o.actor("owner"), id);
    await expect(setWorkflowStatus(rep, id, "active")).rejects.toThrow(/Turning on this workflow needs the “Assign contacts and deals to others”/);
    expect((await getWorkflow(o.actor("owner"), id)).status).toBe("draft");
    await setWorkflowStatus(o.actor("owner"), id, "active");
    expect((await getWorkflow(o.actor("owner"), id)).versions[0].publishedByName).toBe("Owner Person");
  });

  it("refuses contact details in team-facing text, and contact checks, from someone who can't see contacts", async () => {
    const o = await crmOrg({ name: "Workflow PII Co" });
    const manager = await withdraw(o, "manager", ["contacts.view"]);
    const leak = await createWorkflow(manager, { name: "Leak", definition: { trigger: { type: "contact.created" }, steps: [step("n", "notify_team", { roles: ["admin"], title: "{{contact.email}} {{contact.phone}}" })] } });
    await expect(publishWorkflow(manager, leak.id)).rejects.toThrow(/“See contacts” permission, because the step "Notify team" fills in contact details/);
    const check = await createWorkflow(manager, { name: "Check", definition: { trigger: { type: "contact.created", contactFilter: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["new"] }] } }, steps: [step("n", "notify_team", { roles: ["admin"], title: "A new lead" })] } });
    await expect(publishWorkflow(manager, check.id)).rejects.toThrow(/its trigger checks contact details/);
    // Without contact details or checks it publishes.
    const plain = await createWorkflow(manager, { name: "Plain", definition: { trigger: { type: "contact.created" }, steps: [step("n", "notify_team", { roles: ["admin"], title: "A new lead came in" })] } });
    expect((await publishWorkflow(manager, plain.id)).created).toBe(true);
    // Asking the owner to approve a version needs the same.
    const mappingId = await verifiedN8nMapping(o);
    const ext = await createWorkflow(o.actor("owner"), { name: "Ext", definition: { trigger: { type: "manual" }, steps: [step("x", "n8n", { mappingId, includeContact: true })] } });
    await publishWorkflow(o.actor("owner"), ext.id);
    await expect(requestWorkflowApproval(manager, ext.id, null, { activate: true })).rejects.toThrow(/Asking for approval of this workflow needs the “See contacts”/);
    await restore(o, "manager");
  });
});

// ---------------------------------------------------------------------------
// 9. Tagging through the API doesn't answer with contact details
// ---------------------------------------------------------------------------

describe("finding 9: the tags endpoint and a tags-only key", () => {
  it("answers a tags-only key with the contact's id and tags, and a contact-reading key with the contact", async () => {
    const o = await crmOrg({ name: "Tags API Co" });
    const email = `private-${uid()}@example.test`;
    const contactId = await contactIn(o, { email });
    const tagsOnly = (await createApiKey(o.actor("owner"), { name: "Tagger", scopes: ["tags.write"] })).secret;
    expect((await getContactRoute(apiReq(`/contacts/${contactId}`, tagsOnly), idParam(contactId))).status).toBe(403);
    const res = await contactTagsRoute(apiReq(`/contacts/${contactId}/tags`, tagsOnly, { body: { remove: ["no-such-tag"], add: ["Imported"] } }), idParam(contactId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>; added: number };
    expect(body.added).toBe(1);
    expect(Object.keys(body.data).sort()).toEqual(["id", "tags"]);
    expect(body.data.tags).toEqual([expect.objectContaining({ name: "Imported" })]);
    expect(JSON.stringify(body)).not.toContain(email);
    const both = (await createApiKey(o.actor("owner"), { name: "Both", scopes: ["tags.write", "contacts.read"] })).secret;
    const full = (await (await contactTagsRoute(apiReq(`/contacts/${contactId}/tags`, both, { body: { remove: ["no-such-tag"] } }), idParam(contactId))).json()) as { data: { email: string } };
    expect(full.data.email).toBe(email);
  });
});

// ---------------------------------------------------------------------------
// 10. Run history doesn't show record details to people who can't see the records
// ---------------------------------------------------------------------------

describe("finding 10: run detail for someone who can see automations but not contacts", () => {
  it("leaves out step text that names the contact", async () => {
    const o = await crmOrg({ name: "Run Privacy Co" });
    const owner = o.actor("owner");
    const tag = await createTag(owner, { name: `Seen ${uid()}` });
    const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] });
    const contactId = await contactIn(o);
    await withSystem((db) => db.query("update contacts set display_name = 'Hidden Name' where id = $1", [contactId]));
    const test = await startTestRun(owner, id, { contactId });
    expect(JSON.stringify(await getRun(owner, test.runId!))).toContain("Hidden Name");
    const restricted = await withdraw(o, "manager", ["contacts.view"]);
    const run = await getRun(restricted, test.runId!);
    expect(JSON.stringify(run)).not.toContain("Hidden Name");
    expect(run.steps[0].result).toMatchObject({ dryRun: true, outcome: "would_run", detail: expect.stringMatching(/hidden/) });
    await restore(o, "manager");
  });
});

// ---------------------------------------------------------------------------
// 11. An agent-tool call id reused for another tool isn't bound to the first tool's approval
// ---------------------------------------------------------------------------

describe("finding 11: agent-tool approvals are keyed by tool and arguments", () => {
  it("doesn't answer create_task with apply_tag's approval when the employee reuses a call id", async () => {
    const o = await crmOrg({ name: "Agent Key Co" });
    const agent = await agentId(o.org.id, "crm_manager");
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where id = $1", [agent]));
    const run = (await withSystem((db) => db.query<{ id: string }>("insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status) values ($1, $2, 'crm_tool', $3, 'running') returning id", [o.org.id, agent, `test:${crypto.randomUUID()}`]))).rows[0].id;
    const t = await withSystem((db) => issueAgentToolToken(db, { orgId: o.org.id, agentInstanceId: agent, runId: run, scopes: [...AGENT_TOOL_SCOPES] }));
    const x = await contactIn(o);
    const y = await contactIn(o);
    await createTag(o.actor("owner"), { name: "Bulk" });
    const call = (tool: string, args: unknown) => callAgentTool({ token: t.token, tool, readArgs: async () => args, callId: "k1" });
    const tagged = await call("apply_tag", { contactIds: [x, y], tags: ["Bulk"] });
    expect(tagged).toMatchObject({ ok: true, status: "pending_approval" });
    const task = await call("create_task", { title: `Call back ${uid()}`, contactId: x });
    expect(task).toMatchObject({ ok: true, status: "done" });
    expect(task.ok && task.approvalId).not.toBe(tagged.ok && tagged.approvalId);
    expect(await count("select count(*)::text as n from tasks where org_id = $1 and contact_id = $2", [o.org.id, x])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12. Webhook deliveries connect only to the address that passed the check
// ---------------------------------------------------------------------------

describe("finding 12: the delivery's connection is pinned to checked addresses (no DNS rebinding)", () => {
  const originalLookup = hostResolver.lookup;
  let connected: string[] = [];
  afterEach(() => {
    hostResolver.lookup = originalLookup;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  type FakeRes = EventEmitter & { statusCode: number; resume: () => void };
  type LookupCb = (err: Error | null, addresses: Array<{ address: string }>) => void;
  /** https.request double: runs the request's own lookup the way a socket would, records where it would connect, answers 200. */
  function fakeHttps() {
    connected = [];
    vi.spyOn(https, "request").mockImplementation(((options: https.RequestOptions, onResponse: (res: FakeRes) => void) => {
      const req = Object.assign(new EventEmitter(), {
        end: () => {
          const lookup = options.lookup as unknown as (h: string, o: { all: boolean }, cb: LookupCb) => void;
          lookup(String(options.hostname), { all: true }, (err, addresses) => {
            if (err) return void req.emit("error", err);
            connected.push(...addresses.map((a) => a.address));
            onResponse(Object.assign(new EventEmitter(), { statusCode: 200, resume: () => undefined }));
          });
        },
      });
      return req;
    }) as unknown as typeof https.request);
    // A tripwire: nothing may go out through fetch any more.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  }

  it("refuses a host that resolves to a private address at connect time, even though the check passed", async () => {
    const o = await crmOrg({ name: "Rebind Co" });
    // Saving checks it (public), the delivery's check passes (public), then the name rebinds to an internal address.
    const answers = [["93.184.216.34"], ["93.184.216.34"], ["10.0.0.5"]];
    hostResolver.lookup = async () => answers.shift() ?? ["10.0.0.5"];
    const sub = await createWebhookSubscription(o.actor("owner"), { name: "Rebind", url: "https://rebind.example.test/hook", eventTypes: ["contact.created"] });
    fakeHttps();
    const out = await sendTestWebhook(o.actor("owner"), sub.id);
    expect(out.status).toBe("failed");
    expect(out.detail).toMatch(/private, local or internal network/);
    expect(connected).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("connects to exactly the address its own lookup checked", async () => {
    const o = await crmOrg({ name: "Pinned Co" });
    hostResolver.lookup = async () => ["93.184.216.34"];
    const sub = await createWebhookSubscription(o.actor("owner"), { name: "Pinned", url: "https://pinned.example.test/hook", eventTypes: ["contact.created"] });
    fakeHttps();
    const out = await sendTestWebhook(o.actor("owner"), sub.id);
    expect(out).toMatchObject({ status: "delivered", responseStatus: 200 });
    expect(connected).toEqual(["93.184.216.34"]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("checks every answer of the lookup it gives the socket", async () => {
    const lookup = (addrs: string[]) => new Promise<{ err: Error | null; result: unknown }>((resolve) => checkedLookup(async () => addrs)("h.example.test", { all: true }, (err, result) => resolve({ err, result })));
    expect((await lookup(["127.0.0.1"])).err).toBeInstanceOf(UnsafeAddressError);
    expect((await lookup(["93.184.216.34", "169.254.169.254"])).err).toBeInstanceOf(UnsafeAddressError);
    expect((await lookup(["::ffff:7f00:1"])).err).toBeInstanceOf(UnsafeAddressError);
    expect((await lookup(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])).result).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
    const single = await new Promise<{ address: unknown; family: unknown }>((resolve) => checkedLookup(async () => ["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"])("h.example.test", { family: 4 }, (_e, address, family) => resolve({ address, family })));
    expect(single).toEqual({ address: "93.184.216.34", family: 4 });
    await expect(pinnedHttps.post({ url: "https://10.1.2.3/x", headers: {}, body: "{}", timeoutMs: 1000 })).rejects.toBeInstanceOf(UnsafeAddressError);
  });
});
