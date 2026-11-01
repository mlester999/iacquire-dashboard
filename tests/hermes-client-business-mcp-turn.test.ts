// The turn rule of the client tier: a valid credential alone reads nothing. A read needs exactly one running Chat turn of that employee, in that workspace, on its active configuration,
// started by a person who still belongs to the workspace and may use AI employees. The employee's health is read now; its tool-inventory proof only has to have been valid when the turn
// began. Two synthetic workspaces; every refusal is also checked for side effects (no token, approval, run or record).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { addMember, createUser } from "./support/fixtures";
import {
  callBody, clientSideEffects, endClientTurns, postClient, provisionedClient, refused, setClientTier, startClientTurn, temporarily, tenantRows, toolText, withoutAudit, type ClientTenant,
} from "./support/client-business-mcp";

let a: ClientTenant;
let b: ClientTenant;

const TURN = /active, authenticated Chat turn/;
const context = (t: ClientTenant, role: AgentRoleKey) => postClient(t.credentials[role], callBody("get_role_workspace_context"));
// The analyst has no contact tool; its one read is the report.
const read = (t: ClientTenant, role: AgentRoleKey) => postClient(t.credentials[role], role === "performance_analyst" ? callBody("crm_summary_report") : callBody("find_contacts", { query: t.tag }));

/** A refused turn is an ordinary answer (200) that says it is an error, names the rule and carries none of the workspace's records. Nothing is created. */
async function expectNoTurn(t: ClientTenant, role: AgentRoleKey, label: string) {
  const before = await clientSideEffects();
  for (const ask of [context, read]) {
    const rpc = await ask(t, role);
    expect(rpc.status, label).toBe(200);
    expect(refused(rpc), label).toBe(true);
    expect(toolText(rpc), label).toMatch(TURN);
    expect(toolText(rpc), label).not.toContain(t.tag);
  }
  expect(withoutAudit(await clientSideEffects()), label).toEqual(withoutAudit(before));
}

beforeAll(async () => {
  a = await provisionedClient({ name: "Chicago Roofing", timezone: "America/Chicago", tag: "Chicagoan", phone: "+13125550101" });
  b = await provisionedClient({ name: "Manila Dental", timezone: "Asia/Manila", tag: "Manilan", phone: "+639171234501", entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") });
}, 180_000);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
  setClientTier(true);
});

afterEach(async () => {
  for (const t of [a, b]) for (const role of AGENT_ROLE_KEYS) await endClientTurns(t, role);
  vi.unstubAllEnvs();
  resetEnvCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("a valid credential alone reads nothing", () => {
  it("refuses without any turn, and the refusal creates no token, approval or record", async () => {
    await expectNoTurn(a, "appointment_setter", "no turn");
  });

  it("refuses another employee's turn, a turn of another kind, one that is too old, and two at once", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    await expectNoTurn(a, "lead_hunter", "another employee's turn");

    await startClientTurn(a, "lead_hunter", a.owner.id, { purpose: "lead_research" });
    await expectNoTurn(a, "lead_hunter", "a turn of another kind");

    await startClientTurn(a, "lead_hunter", a.owner.id, { ageMinutes: 25 });
    await expectNoTurn(a, "lead_hunter", "a turn that is too old");

    await startClientTurn(a, "lead_hunter", a.owner.id);
    expect(refused(await read(a, "lead_hunter"))).toBe(false);
    await withSystem((db) => db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at, hermes_run_id, config_version_id)
       select org_id, agent_instance_id, user_id, purpose, idempotency_key || '-twin', status, started_at, hermes_run_id || '-twin', config_version_id
         from agent_runs where agent_instance_id = $1 and status = 'running'`, [a.agents.lead_hunter],
    ));
    await expectNoTurn(a, "lead_hunter", "two turns at once");
  });

  it("refuses a turn that began on an older configuration than the employee's active one", async () => {
    await startClientTurn(a, "sales_assistant", a.owner.id);
    expect(refused(await read(a, "sales_assistant"))).toBe(false);
    const previous = (await withSystem((db) => db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [a.agents.sales_assistant]))).rows[0].active_config_version_id;
    const newer = (await withSystem((db) => db.query<{ id: string }>(
      `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), '{}', 's', '# newer', 'p', 'onboarding', 'applied') returning id`, [a.org.id, a.agents.sales_assistant],
    ))).rows[0].id;
    try {
      await withSystem((db) => db.query("update agent_instances set active_config_version_id = $2 where id = $1", [a.agents.sales_assistant, newer]));
      await expectNoTurn(a, "sales_assistant", "older configuration");
    } finally {
      await withSystem((db) => db.query("update agent_instances set active_config_version_id = $2 where id = $1", [a.agents.sales_assistant, previous]));
    }
    expect(refused(await read(a, "sales_assistant"))).toBe(false);
  });

  it("refuses when the employee is unhealthy now, however healthy it was when the turn began", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    expect(refused(await read(a, "crm_manager"))).toBe(false);
    const id = a.agents.crm_manager;
    await temporarily("update agent_instances set last_health_ok = false where id = $1", "update agent_instances set last_health_ok = true where id = $1", [id], () => expectNoTurn(a, "crm_manager", "failed check"));
    await temporarily("update agent_instances set status = 'offline' where id = $1", "update agent_instances set status = 'online' where id = $1", [id], () => expectNoTurn(a, "crm_manager", "offline"));
    expect(refused(await read(a, "crm_manager"))).toBe(false);
  });

  it("judges the tool-inventory proof at the turn's start: a proof that lapsed mid-turn is fine, one that had already lapsed at the start is refused", async () => {
    const id = a.agents.performance_analyst;
    const lapse = "update agent_instances set tool_inventory_expires_at = now() - interval '1 minute' where id = $1";
    const renew = "update agent_instances set tool_inventory_expires_at = now() + interval '2 minutes' where id = $1";
    // The turn began five minutes ago, on a proof that was good then and ran out a minute ago: the turn goes on.
    await startClientTurn(a, "performance_analyst", a.owner.id, { ageMinutes: 5 });
    await temporarily(lapse, renew, [id], async () => {
      const rpc = await postClient(a.credentials.performance_analyst, callBody("crm_summary_report"));
      expect(refused(rpc)).toBe(false);
    });
    // The turn began just now, on a proof that had already run out: it never had one, so nothing is read.
    await startClientTurn(a, "performance_analyst", a.owner.id);
    await temporarily(lapse, renew, [id], () => expectNoTurn(a, "performance_analyst", "proof already lapsed at the start"));
    // And an employee with no recorded proof at all is refused.
    await temporarily("update agent_instances set tool_inventory_expires_at = null where id = $1", renew, [id], () => expectNoTurn(a, "performance_analyst", "no proof"));
  });

  it("refuses when the person running the turn lost their membership after it began, for the snapshot and for a tool alike", async () => {
    const temp = await createUser({ name: "Short Lived" });
    await addMember(a.org.id, temp.id, "support");
    await startClientTurn(a, "appointment_setter", temp.id);
    expect(refused(await context(a, "appointment_setter"))).toBe(false);
    expect(refused(await read(a, "appointment_setter"))).toBe(false);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [a.org.id, temp.id]));
    await expectNoTurn(a, "appointment_setter", "membership removed");
  });

  it("refuses when the person may not use AI employees at all (a viewer), or is not a member of this workspace", async () => {
    await startClientTurn(a, "appointment_setter", a.crm.people.viewer.id);
    await expectNoTurn(a, "appointment_setter", "a viewer");
    // A person of the OTHER workspace running a turn on this workspace's employee has no standing here.
    await startClientTurn(a, "appointment_setter", b.owner.id);
    await expectNoTurn(a, "appointment_setter", "a person of another workspace");
    // A turn nobody started (no person) is no turn.
    await startClientTurn(a, "appointment_setter", a.owner.id);
    await withSystem((db) => db.query("update agent_runs set user_id = null where agent_instance_id = $1 and status = 'running'", [a.agents.appointment_setter]));
    await expectNoTurn(a, "appointment_setter", "no person");
  });
});

describe("one workspace's turn never authorises another's credential", () => {
  it("does not let B's running turn authorise A's credential, nor A's the B's, and reads nothing for either", async () => {
    await startClientTurn(b, "appointment_setter", b.owner.id);
    const beforeA = await tenantRows(a.org.id);
    await expectNoTurn(a, "appointment_setter", "only B has a turn");
    expect(await tenantRows(a.org.id)).toEqual(beforeA);
    await endClientTurns(b, "appointment_setter");

    await startClientTurn(a, "appointment_setter", a.owner.id);
    const beforeB = await tenantRows(b.org.id);
    await expectNoTurn(b, "appointment_setter", "only A has a turn");
    expect(await tenantRows(b.org.id)).toEqual(beforeB);
  });

  it("cannot even record a turn whose workspace differs from its employee's: the database refuses it, and no turn of another workspace matches", async () => {
    const { rows } = await withSystem((db) => db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [a.agents.appointment_setter]));
    await expect(withSystem((db) => db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, hermes_run_id, config_version_id)
       values ($1, $2, $3, 'chat', $4, 'running', 'run-mismatch', $5)`, [b.org.id, a.agents.appointment_setter, b.owner.id, `mismatch-${Math.random()}`, rows[0].active_config_version_id],
    ))).rejects.toThrow();
    // B's own turn for the same role, with A's credential presented: not matched.
    await startClientTurn(b, "appointment_setter", b.owner.id);
    await expectNoTurn(a, "appointment_setter", "a turn of the same role in another workspace");
  });

  it("does not let one employee's turn open another role's credential in the same workspace", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    expect(refused(await read(a, "crm_manager"))).toBe(false);
    await expectNoTurn(a, "operations_manager", "another role's turn");
  });
});

describe("a captured request is no good after its turn", () => {
  it("is refused when replayed after the turn ended, and the second answer carries none of the records the first did", async () => {
    await startClientTurn(a, "lead_hunter", a.owner.id);
    const captured = callBody("find_contacts", { query: "Chicagoan" });
    const first = await postClient(a.credentials.lead_hunter, captured);
    expect(refused(first)).toBe(false);
    expect(toolText(first)).toContain("Chicagoan Prospect");
    await endClientTurns(a, "lead_hunter");
    const replay = await postClient(a.credentials.lead_hunter, captured);
    expect(refused(replay)).toBe(true);
    expect(toolText(replay)).not.toContain("Chicagoan Prospect");
    // A new turn of the same employee is a new authorisation: the same request works again, for that turn only.
    await startClientTurn(a, "lead_hunter", a.owner.id);
    expect(toolText(await postClient(a.credentials.lead_hunter, captured))).toContain("Chicagoan Prospect");
  });

  it("reads for the person whose turn it is, and for nobody else", async () => {
    // The same credential, the same request, two different turns by two different people of the workspace: each answer follows that person's own standing.
    await startClientTurn(a, "appointment_setter", a.owner.id);
    expect(refused(await read(a, "appointment_setter"))).toBe(false);
    await withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, 'contacts.view', 'revoke') on conflict do nothing", [a.org.id, a.crm.people.support.id]));
    await startClientTurn(a, "appointment_setter", a.crm.people.support.id);
    const rpc = await read(a, "appointment_setter");
    expect(refused(rpc)).toBe(true);
    expect(toolText(rpc)).not.toContain("Chicagoan Prospect");
    await withSystem((db) => db.query("delete from member_permission_overrides where org_id = $1 and user_id = $2", [a.org.id, a.crm.people.support.id]));
  });
});
