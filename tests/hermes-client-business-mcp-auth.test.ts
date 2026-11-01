// The client tier's authentication: what opens the endpoint for a client's employee and what does not. Driven through the real handler against two synthetic workspaces (Chicago roofing with
// six employees, Manila dental with five in its plan). Every refusal is also checked for side effects: a refused request creates no token, approval, run or record, and does not count as a use
// of the credential. The credential carries no claims, so what these prove is that the application's own records decide everything.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import {
  allocateClientCredentialId, formatClientCredential, generateClientCredentialSecret, hashClientSecret, registerClientBusinessCredential, revokeClientBusinessCredential,
  revokeClientBusinessCredentialsForOrg,
} from "@/server/workforce/hermes-client-business-credential";
import { suggestedProfileName } from "@/server/workforce/service";
import { createOrg } from "./support/fixtures";
import {
  auditRows, callBody, clientSideEffects, endClientTurns, postClient, provisionedClient, refused, reissueCredential, setClientTier, startClientTurn, temporarily, tenantRows, toolText, withoutAudit,
  type ClientTenant, type Rpc,
} from "./support/client-business-mcp";

let a: ClientTenant;
let b: ClientTenant;
/** Every answer the endpoint gave in this file, and every secret ever issued, so the last check can prove none of them appears in another. */
const transcript: string[] = [];
const issuedSecrets = new Set<string>();

async function post(token: string | null | undefined, body?: Record<string, unknown>, ip?: string): Promise<Rpc> {
  const rpc = await postClient(token, body, ip);
  transcript.push(rpc.text);
  return rpc;
}

const ledger = async (id: string) => (await withSystem((db) => db.query<{ use_count: number; status: string; revoked_reason: string | null }>("select use_count, status, revoked_reason from agent_business_credentials where id = $1", [id]))).rows[0];
const works = async (token: string) => (await post(token)).status === 200;

beforeAll(async () => {
  a = await provisionedClient({ name: "Chicago Roofing", timezone: "America/Chicago", tag: "Chicagoan", phone: "+13125550101" });
  b = await provisionedClient({ name: "Manila Dental", timezone: "Asia/Manila", tag: "Manilan", phone: "+639171234501", entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") });
  for (const t of [a, b]) for (const role of AGENT_ROLE_KEYS) issuedSecrets.add(t.secrets[role]);
}, 180_000);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
  setClientTier(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("a credential opens the endpoint for its own employee", () => {
  it("opens it for each of the six employees of a workspace, and for the five its plan includes in the other", async () => {
    for (const role of AGENT_ROLE_KEYS) expect(await works(a.credentials[role]), `A ${role}`).toBe(true);
    for (const role of AGENT_ROLE_KEYS) {
      if (role === "sales_assistant") continue;
      expect(await works(b.credentials[role]), `B ${role}`).toBe(true);
    }
  });

  it("records each use: the first genuine use stamps the ledger row, and a refused request does not", async () => {
    const before = (await ledger(a.credentialIds.crm_manager)).use_count;
    expect((await post(a.credentials.crm_manager)).status).toBe(200);
    expect((await ledger(a.credentialIds.crm_manager)).use_count).toBe(before + 1);
    expect((await post(`${a.credentials.crm_manager.slice(0, -1)}${a.credentials.crm_manager.endsWith("A") ? "B" : "A"}`)).status).toBe(401);
    expect((await ledger(a.credentialIds.crm_manager)).use_count).toBe(before + 1);
  });
});

describe("what does not open the endpoint (and changes nothing)", () => {
  const id = (t: ClientTenant, role: (typeof AGENT_ROLE_KEYS)[number]) => t.credentialIds[role];
  const cases: Array<[string, () => string | null]> = [
    ["no credential at all", () => null],
    ["an empty credential", () => ""],
    ["a 64-character hexadecimal key, the shape of a Hermes profile key", () => "a".repeat(64)],
    ["the right id with a secret made up", () => formatClientCredential(id(a, "crm_manager"), generateClientCredentialSecret())],
    ["workspace A's id with workspace B's secret", () => formatClientCredential(id(a, "crm_manager"), b.secrets.crm_manager)],
    ["workspace B's id with workspace A's secret", () => formatClientCredential(id(b, "crm_manager"), a.secrets.crm_manager)],
    ["an id no row has, with a well-formed secret", () => formatClientCredential("11111111-1111-4111-8111-111111111111", generateClientCredentialSecret())],
    ["another employee's secret under this employee's id", () => formatClientCredential(id(a, "crm_manager"), a.secrets.lead_hunter)],
    ["a credential with another version prefix", () => a.credentials.crm_manager.replace("iamcpc1", "iamcpc2")],
    ["a credential cut short", () => a.credentials.crm_manager.slice(0, -4)],
    ["a credential with an extra part", () => `${a.credentials.crm_manager}.x`],
    ["the credential's id alone", () => a.credentialIds.crm_manager],
    ["a very long value", () => "x".repeat(20_000)],
  ];
  for (const [label, token] of cases) {
    it(`refuses ${label}, with no detail, no log entry and no side effect`, async () => {
      const before = await clientSideEffects();
      const used = (await ledger(a.credentialIds.crm_manager)).use_count;
      const rpc = await post(token());
      expect(rpc.status).toBe(401);
      expect(rpc.headers.get("www-authenticate")).toMatch(/^Bearer realm=/);
      expect(rpc.headers.get("cache-control")).toBe("no-store");
      expect(rpc.text).toBe("Unauthorized");
      // A request nobody can be named for is only counted. It writes no log entry and records no use.
      expect(await clientSideEffects()).toEqual(before);
      expect((await ledger(a.credentialIds.crm_manager)).use_count).toBe(used);
      expect(await auditRows("hermes.business_mcp.auth_denied")).toHaveLength(0);
    });
  }

  it("refuses a credential whose id was handed out but whose secret was never reported (still pending), exactly like an unknown one", async () => {
    const pending = await withSystem((db) => allocateClientCredentialId(db, { orgId: a.org.id, agentId: a.agents.lead_hunter }));
    const before = await clientSideEffects();
    const guess = await post(formatClientCredential(pending, generateClientCredentialSecret()));
    const unknown = await post(formatClientCredential("22222222-2222-4222-8222-222222222222", generateClientCredentialSecret()));
    expect(guess.status).toBe(401);
    expect({ status: guess.status, text: guess.text }).toEqual({ status: unknown.status, text: unknown.text });
    expect(await clientSideEffects()).toEqual(before);
  });

  it("answers the same for a wrong secret as for an unknown id, so the answer says nothing about which ids exist", async () => {
    const wrong = await post(formatClientCredential(a.credentialIds.crm_manager, generateClientCredentialSecret()));
    const unknown = await post(formatClientCredential("33333333-3333-4333-8333-333333333333", generateClientCredentialSecret()));
    expect({ status: wrong.status, text: wrong.text, challenge: wrong.headers.get("www-authenticate") }).toEqual({ status: unknown.status, text: unknown.text, challenge: unknown.headers.get("www-authenticate") });
  });

  it("slows a client address that keeps failing, and still serves a genuine credential from it", async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) statuses.push((await post("not-a-credential", undefined, ip)).status);
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    expect((await post("not-a-credential", undefined, ip)).headers.get("retry-after")).toMatch(/^\d+$/);
    // A good credential is never counted against the address that is failing.
    expect((await post(a.credentials.crm_manager, undefined, ip)).status).toBe(200);
  });
});

describe("a genuine credential that cannot be honoured is refused, recorded and not counted as a use", () => {
  const denied = (orgId: string, jti: string) => auditRows("hermes.business_mcp.auth_denied", orgId).then((rows) => rows.filter((row) => row.metadata.jti === jti));

  it("expired: refused, and the refusal is audited in the employee's own workspace with the credential's id and a reason code only", async () => {
    const credential = a.credentialIds.lead_hunter;
    const used = (await ledger(credential)).use_count;
    const original = (await withSystem((db) => db.query<{ expires_at: string }>("select expires_at::text from agent_business_credentials where id = $1", [credential]))).rows[0].expires_at;
    await temporarily("update agent_business_credentials set expires_at = issued_at + interval '1 millisecond' where id = $1", `update agent_business_credentials set expires_at = '${original}' where id = $1`, [credential], async () => {
      const rpc = await post(a.credentials.lead_hunter);
      expect(rpc.status).toBe(401);
    });
    const rows = await denied(a.org.id, credential);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: a.org.id, result: "denied", agent_instance_id: a.agents.lead_hunter, metadata: { tier: "client", reason: "expired", role: "lead_hunter", jti: credential } });
    expect(JSON.stringify(rows[0])).not.toContain(a.secrets.lead_hunter);
    expect(JSON.stringify(rows[0])).not.toContain(hashClientSecret(a.secrets.lead_hunter));
    expect((await ledger(credential)).use_count).toBe(used);
    expect(await works(a.credentials.lead_hunter)).toBe(true);
  });

  it("revoked by its id: only that credential fails, and the refusal is audited", async () => {
    const victim = a.credentials.lead_hunter;
    const victimId = a.credentialIds.lead_hunter;
    expect(await works(victim)).toBe(true);
    expect(await withSystem((db) => revokeClientBusinessCredential(db, a.org.id, victimId, "test_revoked"))).toBe(true);
    const before = await clientSideEffects();
    expect((await post(victim)).status).toBe(401);
    expect(withoutAudit(await clientSideEffects())).toEqual(withoutAudit(before));
    expect((await denied(a.org.id, victimId)).map((row) => row.metadata.reason).at(-1)).toBe("revoked");
    // Nobody else is affected: the same workspace's other employees, and the other workspace's same role.
    expect(await works(a.credentials.crm_manager)).toBe(true);
    expect(await works(b.credentials.lead_hunter)).toBe(true);
    // Another workspace cannot end it either: its id is simply not found there.
    expect(await withSystem((db) => revokeClientBusinessCredential(db, b.org.id, a.credentialIds.crm_manager, "test_revoked"))).toBe(false);
    expect(await works(a.credentials.crm_manager)).toBe(true);
    issuedSecrets.add((await reissueCredential(a, "lead_hunter")).split(".")[2]);
    expect(await works(a.credentials.lead_hunter)).toBe(true);
  });

  it("revoked for the whole workspace: all six of its employees fail at once and the other workspace is unaffected", async () => {
    for (const role of AGENT_ROLE_KEYS) expect(await works(a.credentials[role]), role).toBe(true);
    const ended = await withSystem((db) => revokeClientBusinessCredentialsForOrg(db, a.org.id, "org_suspended"));
    expect(ended.length).toBeGreaterThanOrEqual(6);
    for (const role of AGENT_ROLE_KEYS) expect((await post(a.credentials[role])).status, role).toBe(401);
    for (const role of AGENT_ROLE_KEYS) {
      if (role === "sales_assistant") continue;
      expect(await works(b.credentials[role]), `B ${role}`).toBe(true);
    }
    expect((await denied(a.org.id, a.credentialIds.crm_manager)).map((row) => row.metadata.reason)).toEqual(["revoked"]);
    expect(await auditRows("hermes.business_mcp.auth_denied", b.org.id)).toHaveLength(0);
    for (const role of AGENT_ROLE_KEYS) issuedSecrets.add((await reissueCredential(a, role)).split(".")[2]);
    for (const role of AGENT_ROLE_KEYS) expect(await works(a.credentials[role]), role).toBe(true);
  });

  it("rotation: the old credential works while the new one is installed, and the first use of the new one ends it", async () => {
    const oldCredential = a.credentials.performance_analyst;
    const oldId = a.credentialIds.performance_analyst;
    const fresh = await reissueCredential(a, "performance_analyst");
    issuedSecrets.add(fresh.split(".")[2]);
    expect((await ledger(oldId)).status).toBe("rotating_out");
    expect(await works(oldCredential)).toBe(true);
    expect(await works(fresh)).toBe(true);
    // The profile now holds the new credential: the old one has done its job.
    expect((await ledger(oldId)).status).toBe("revoked");
    expect((await post(oldCredential)).status).toBe(401);
    expect(await works(fresh)).toBe(true);
  });

  it("re-mapped: an employee that moved to another Hermes profile ends the credentials issued for the old one", async () => {
    const id = a.agents.sales_assistant;
    const original = suggestedProfileName(a.org.slug, "sales_assistant");
    await temporarily("update agent_instances set hermes_profile = 'c-remapped-profile-0000' where id = $1", `update agent_instances set hermes_profile = '${original}' where id = $1`, [id], async () => {
      expect((await post(a.credentials.sales_assistant)).status).toBe(401);
    });
    expect((await denied(a.org.id, a.credentialIds.sales_assistant)).map((row) => row.metadata.reason)).toContain("profile_changed");
    expect(await works(a.credentials.sales_assistant)).toBe(true);
  });

  it("a profile that is not the one this code would name for the workspace and role is refused, even when the ledger agrees with the employee's row", async () => {
    // Both records say the same wrong thing (the employee's row and a ledger credential issued for that profile). The profile is recomputed from the workspace and the role, so neither is trusted.
    const id = a.agents.appointment_setter;
    const original = suggestedProfileName(a.org.slug, "appointment_setter");
    const custom = "c-someone-elses-profile-0000";
    const keep = a.credentials.appointment_setter;
    await withSystem((db) => db.query("update agent_instances set hermes_profile = $2 where id = $1", [id, custom]));
    try {
      const secret = generateClientCredentialSecret();
      const registered = await withSystem((db) => registerClientBusinessCredential(db, { orgId: a.org.id, agentId: id, profile: custom, secretSha256: hashClientSecret(secret) }));
      issuedSecrets.add(secret);
      const before = await clientSideEffects();
      expect((await post(formatClientCredential(registered.id, secret))).status).toBe(401);
      expect(withoutAudit(await clientSideEffects())).toEqual(withoutAudit(before));
      expect((await denied(a.org.id, registered.id)).map((row) => row.metadata.reason)).toEqual(["profile_mismatch"]);
    } finally {
      await withSystem((db) => db.query("update agent_instances set hermes_profile = $2 where id = $1", [id, original]));
    }
    // Back on its own profile, the credential issued for it (stepped aside to its overlap window by the one above) is the genuine one again.
    expect(await works(keep)).toBe(true);
    issuedSecrets.add((await reissueCredential(a, "appointment_setter")).split(".")[2]);
    expect(await works(a.credentials.appointment_setter)).toBe(true);
  });

  it("a c- prefix alone is not enough, and neither is another workspace's c- profile name", async () => {
    const id = a.agents.crm_manager;
    const original = suggestedProfileName(a.org.slug, "crm_manager");
    const others = suggestedProfileName(b.org.slug, "crm_manager");
    // The other workspace's employee holds that name on the same gateway, so the database itself refuses to give it to a second employee.
    await expect(withSystem((db) => db.query("update agent_instances set hermes_profile = $2 where id = $1", [id, others]))).rejects.toThrow();
    expect(await works(a.credentials.crm_manager)).toBe(true);
    expect((await withSystem((db) => db.query<{ hermes_profile: string }>("select hermes_profile from agent_instances where id = $1", [id]))).rows[0].hermes_profile).toBe(original);
  });
});

describe("the application's own records decide, every request", () => {
  const cred = (t: ClientTenant, role: (typeof AGENT_ROLE_KEYS)[number]) => t.credentials[role];
  const refusedWhile = async (change: string, restore: string, params: unknown[], token: string, reason?: string, restoreParams?: unknown[]) => {
    const before = await clientSideEffects();
    await temporarily(change, restore, params, async () => {
      expect((await post(token)).status).toBe(401);
    }, restoreParams);
    expect(withoutAudit(await clientSideEffects())).toEqual(withoutAudit(before));
    if (reason) expect((await auditRows("hermes.business_mcp.auth_denied", a.org.id)).some((row) => row.metadata.reason === reason)).toBe(true);
    expect((await post(token)).status).toBe(200);
  };

  it("an employee the plan no longer includes is refused immediately, while the same workspace's other employees keep working", async () => {
    await refusedWhile("update agent_instances set enabled = false where id = $1", "update agent_instances set enabled = true where id = $1", [a.agents.operations_manager], cred(a, "operations_manager"), "employee_not_active");
    expect(await works(cred(a, "crm_manager"))).toBe(true);
  });

  it("a plan that never included the role: its employee's credential is refused while the other employees of that workspace work", async () => {
    expect((await post(b.credentials.sales_assistant)).status).toBe(401);
    for (const role of AGENT_ROLE_KEYS) {
      if (role !== "sales_assistant") expect(await works(b.credentials[role]), role).toBe(true);
    }
  });

  it("a suspended, archived or demo workspace is refused", async () => {
    const token = cred(a, "crm_manager");
    for (const status of ["suspended", "archived"]) {
      await refusedWhile("update organizations set status = $2 where id = $1", "update organizations set status = 'active' where id = $1", [a.org.id, status], token, undefined, [a.org.id]);
    }
    await refusedWhile("update organizations set is_demo = true where id = $1", "update organizations set is_demo = false where id = $1", [a.org.id], token);
  });

  it("an employee whose Hermes credential, or the stored reference behind it, was revoked is refused", async () => {
    const id = a.agents.lead_hunter;
    await refusedWhile(
      "update integration_credentials set revoked_at = now() where id = (select credential_id from agent_instances where id = $1)",
      "update integration_credentials set revoked_at = null where id = (select credential_id from agent_instances where id = $1)", [id], cred(a, "lead_hunter"),
    );
    await refusedWhile(
      "update credential_references set revoked_at = now() where id = (select credential_reference_id from integration_credentials where id = (select credential_id from agent_instances where id = $1))",
      "update credential_references set revoked_at = null where id = (select credential_reference_id from integration_credentials where id = (select credential_id from agent_instances where id = $1))", [id], cred(a, "lead_hunter"),
    );
  });

  it("an employee with no profile on a verified client-only gateway is refused: the gateway must be connected, restricted-service verified and isolation verified", async () => {
    const token = cred(a, "crm_manager");
    const gateway = a.gatewayId;
    await refusedWhile("update hermes_gateways set status = 'needs_attention' where id = $1", "update hermes_gateways set status = 'connected' where id = $1", [gateway], token);
    await refusedWhile("update hermes_gateways set provisioner_isolation_verified_at = null where id = $1", "update hermes_gateways set provisioner_isolation_verified_at = now() where id = $1", [gateway], token);
    await refusedWhile("update hermes_gateways set profile_creation_status = 'operator_cli_only' where id = $1", "update hermes_gateways set profile_creation_status = 'restricted_service_verified' where id = $1", [gateway], token);
    await refusedWhile("update agent_instances set hermes_gateway_id = null where id = $1", `update agent_instances set hermes_gateway_id = '${gateway}' where id = $1`, [a.agents.crm_manager], token);
  });

  it("a gateway that also holds an agency profile is never a client-only gateway, so nothing on it is honoured", async () => {
    const agency = await createOrg({ name: "Agency Of The Test", kind: "agency" });
    const agencyAgent = (await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'lead_hunter'", [agency.id]))).rows[0].id;
    const gateway = (await withSystem((db) => db.query<{ base_url: string }>("select base_url from hermes_gateways where id = $1", [a.gatewayId]))).rows[0].base_url;
    await refusedWhile(
      "update agent_instances set hermes_base_url = $2, hermes_profile = $3, hermes_gateway_id = $4 where id = $1",
      "update agent_instances set hermes_gateway_id = null, hermes_profile = null, hermes_base_url = null where id = $1",
      [agencyAgent, gateway, AGENCY_HERMES_PROFILE_IDS.lead_hunter, a.gatewayId], cred(a, "crm_manager"), undefined, [agencyAgent],
    );
  });

  it("a workspace whose setup payment is no longer confirmed is refused", async () => {
    await refusedWhile(
      "update billing_accounts set setup_payment_status = 'not_invoiced', waiver_reason = null, waived_at = null where org_id = $1",
      "update billing_accounts set setup_payment_status = 'waived', waiver_reason = 'Test fixture: setup payment cleared', waived_at = now() where org_id = $1", [a.org.id], cred(a, "crm_manager"),
    );
  });

  it("a workspace switch-off is refused by the very next request, with no cache delay, for that workspace only", async () => {
    const token = cred(a, "crm_manager");
    expect(await works(token)).toBe(true);
    // A raw write, so nothing clears any cache: the endpoint must read the switch in its own transaction.
    await withSystem((db) => db.query("update org_features set enabled = false where org_id = $1 and feature = 'client_business_tools'", [a.org.id]));
    try {
      const rpc = await post(token);
      expect(rpc.status).toBe(401);
      for (const role of AGENT_ROLE_KEYS) expect((await post(cred(a, role))).status, role).toBe(401);
      expect(await works(cred(b, "crm_manager"))).toBe(true);
      expect((await auditRows("hermes.business_mcp.auth_denied", a.org.id)).some((row) => row.metadata.reason === "workspace_switch_off")).toBe(true);
    } finally {
      await withSystem((db) => db.query("update org_features set enabled = true where org_id = $1 and feature = 'client_business_tools'", [a.org.id]));
    }
    expect(await works(token)).toBe(true);
  });
});

describe("a credential reads its own workspace and never another", () => {
  it("is not given the other workspace's records by pasting their names or ids into the arguments, and leaves that workspace unchanged", async () => {
    await startClientTurn(a, "appointment_setter", a.owner.id);
    await startClientTurn(b, "appointment_setter", b.owner.id);
    const beforeB = await tenantRows(b.org.id);
    const asks: Array<[string, Record<string, unknown>]> = [
      ["find_contacts", { query: "Manilan" }],
      ["find_contacts", { query: b.contact.name }],
      ["get_contact", { contactId: b.contact.id }],
      ["get_conversation_history", { conversationId: b.conversationId }],
      ["get_conversation_history", { contactId: b.contact.id }],
    ];
    for (const [tool, args] of asks) {
      const rpc = await post(a.credentials.appointment_setter, callBody(tool, args));
      expect(toolText(rpc), `${tool} ${JSON.stringify(args)}`).not.toMatch(/Manilan|Manila Dental/);
      // Either nothing is found, or the id is simply not there: never the other workspace's record.
      if (tool === "find_contacts") expect(refused(rpc)).toBe(false);
      else expect(`${refused(rpc)}${toolText(rpc)}`).toMatch(/not found|isn't one this AI employee handles|"conversation":null/i);
    }
    const context = await post(a.credentials.appointment_setter, callBody("get_role_workspace_context"));
    expect(toolText(context)).not.toMatch(/Manilan/);
    expect(await tenantRows(b.org.id)).toEqual(beforeB);
    await endClientTurns(a, "appointment_setter");
    await endClientTurns(b, "appointment_setter");
  });

  it("is not given the other workspace's deals through the deals read, whatever pipeline is named", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    for (const args of [{}, { pipelineId: b.pipelineId }, { status: "open", limit: 25 }]) {
      const rpc = await post(a.credentials.crm_manager, callBody("list_opportunities", args));
      expect(toolText(rpc)).not.toContain(b.dealName);
    }
    const own = await post(a.credentials.crm_manager, callBody("list_opportunities", {}));
    expect(toolText(own)).toContain(a.dealName);
    await endClientTurns(a, "crm_manager");
  });

  it("refuses a tool the role does not have, as an unknown tool, with nothing created", async () => {
    await startClientTurn(a, "appointment_setter", a.owner.id);
    const before = await clientSideEffects();
    for (const name of ["crm_summary_report", "list_opportunities", "update_contact", "create_task", "request_appointment", "prepare_message", "request_send_approval"]) {
      expect(refused(await post(a.credentials.appointment_setter, callBody(name, { contactId: a.contact.id, query: "x", changes: { city: "x" } }))), name).toBe(true);
    }
    expect(withoutAudit(await clientSideEffects())).toEqual(withoutAudit(before));
    await endClientTurns(a, "appointment_setter");
  });

  it("keeps the Appointment Setter from the report tool and the Performance Analyst from contacts, whichever workspace asks", async () => {
    for (const t of [a, b]) {
      await startClientTurn(t, "appointment_setter", t.owner.id);
      await startClientTurn(t, "performance_analyst", t.owner.id);
      expect(refused(await post(t.credentials.appointment_setter, callBody("crm_summary_report"))), `${t.tag} setter`).toBe(true);
      expect(refused(await post(t.credentials.performance_analyst, callBody("find_contacts", { query: t.tag }))), `${t.tag} analyst`).toBe(true);
      expect(refused(await post(t.credentials.performance_analyst, callBody("crm_summary_report"))), `${t.tag} analyst report`).toBe(false);
      await endClientTurns(t, "appointment_setter");
      await endClientTurns(t, "performance_analyst");
    }
  });
});

describe("no secret is ever written down", () => {
  it("appears in no answer, no audit row and no tool log: not a credential, its secret, or the hash that is stored", async () => {
    const [{ rows: audit }, { rows: tools }, { rows: ledgerRows }] = await Promise.all([
      withSystem((db) => db.query<{ metadata: unknown; target_id: string | null; ip_hash: string | null }>("select metadata, target_id, ip_hash from audit_logs")),
      withSystem((db) => db.query<{ tool_name: string; label: string }>("select tool_name, label from tool_executions")),
      withSystem((db) => db.query<{ secret_sha256: string | null }>("select secret_sha256 from agent_business_credentials")),
    ]);
    const written = JSON.stringify([audit, tools]) + transcript.join("\n");
    expect(transcript.length).toBeGreaterThan(50);
    for (const secret of issuedSecrets) {
      expect(written, "a secret").not.toContain(secret);
      expect(written, "a secret's hash").not.toContain(hashClientSecret(secret));
    }
    for (const t of [a, b]) for (const role of AGENT_ROLE_KEYS) expect(written, "a credential").not.toContain(t.credentials[role]);
    // What the ledger stores is a hash and only a hash.
    expect(ledgerRows.every((row) => row.secret_sha256 === null || /^[0-9a-f]{64}$/.test(row.secret_sha256))).toBe(true);
  });
});
