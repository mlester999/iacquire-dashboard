// The client-only gateway attestation (src/server/workforce/hermes-provisioner-attest.ts): dry-run by default, the same checks the provisioner's claim makes, one audit row when applied,
// idempotent, and wired to nothing in the application. Embedded Postgres; the gateway rows are fixtures, nothing talks to a runtime.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { defaultSettings } from "@/server/workforce/compiler";
import { claimHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { createConfigVersion } from "@/server/workforce/service";
import {
  attestClientGateway, checkGatewayAttestation, GATEWAY_ATTESTED_ACTION, pinnedGatewayIdFromEnv,
} from "@/server/workforce/hermes-provisioner-attest";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

/** The agency super admin who applies the attestation: the audit row names them. */
let operator: { id: string; email: string };
beforeAll(async () => {
  operator = await createUser({ platformRole: "agency_super_admin" });
});

type GatewayOptions = { status?: string; gatewayType?: string; profileCreationStatus?: string };

async function gateway(options: GatewayOptions = {}) {
  const id = randomUUID();
  await withSystem((db) => db.query(
    "insert into hermes_gateways (id,label,environment,base_url,gateway_type,status,profile_creation_status) values ($1,'Attest test runtime','development',$2,$3,$4,$5)",
    [id, `https://attest-${id.replaceAll("-", "")}.hermes.test`, options.gatewayType ?? "multiplexed_profiles", options.status ?? "connected", options.profileCreationStatus ?? "unverified"],
  ));
  return id;
}

const pin = (id: string | null) => {
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", id ?? "");
  resetEnvCache();
};

const row = async (id: string) => (await withSystem((db) => db.query<{ profile_creation_status: string; verified: string | null; revision: number; status: string }>(
  "select profile_creation_status,provisioner_isolation_verified_at::text as verified,revision,status from hermes_gateways where id=$1", [id]))).rows[0];
const audits = async (id: string) => (await withSystem((db) => db.query<{ result: string; actor_kind: string; actor_user_id: string | null; org_id: string | null; target_type: string; metadata: Record<string, unknown> }>(
  "select result,actor_kind,actor_user_id,org_id,target_type,metadata from audit_logs where action=$1 and target_id=$2 order by id", [GATEWAY_ATTESTED_ACTION, id]))).rows;

/** Maps one agency employee to the gateway the way a real internal profile would be. There is only ever one agency workspace, so the fixture reuses it. */
async function mapAgencyEmployee(gatewayId: string) {
  const existing = await withSystem((db) => db.query<{ id: string }>("select id from organizations where kind='agency' limit 1"));
  const agency = existing.rows[0] ?? await createOrg({ name: "Agency " + randomUUID().slice(0, 6), kind: "agency" });
  await withSystem((db) => db.query(
    "update agent_instances set hermes_gateway_id=$2,hermes_base_url=(select base_url from hermes_gateways where id=$2),hermes_profile='iacquire-attest-test' where org_id=$1 and role_key='lead_hunter'",
    [agency.id, gatewayId]));
  return agency;
}
const unmapAgencyEmployee = (orgId: string) => withSystem((db) => db.query("update agent_instances set hermes_gateway_id=null,hermes_base_url=null,hermes_profile=null where org_id=$1", [orgId]));

beforeEach(async () => {
  // A queued job left by another test file's world would be claimed by this file's gateway in the claim cross-check below.
  await withSystem((db) => db.query("delete from agent_provisioning_jobs"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  await withSystem((db) => db.query("update agent_instances set hermes_gateway_id=null,hermes_base_url=null,hermes_profile=null where hermes_profile='iacquire-attest-test'"));
});

describe("the attestation dry run", () => {
  it("reports every check, changes nothing and writes no audit row", async () => {
    const id = await gateway();
    pin(id);
    const before = await row(id);
    const result = await attestClientGateway({ gatewayId: id, pinnedGatewayId: pinnedGatewayIdFromEnv(), apply: false, confirmClientOnlyRuntime: false });
    expect(result).toMatchObject({ mode: "dry_run", outcome: "would_apply" });
    expect(result.report.checks.map((check) => [check.id, check.ok])).toEqual([
      ["gateway_exists", true], ["gateway_connected", true], ["gateway_multiplexed", true], ["worker_pinned_to_gateway", true], ["no_agency_employee_on_gateway", true],
    ]);
    expect(result.report).toMatchObject({ eligible: true, attested: false });
    expect(await row(id)).toEqual(before);
    expect(await audits(id)).toEqual([]);
  });

  it("is the default even when the confirmation is given without --apply", async () => {
    const id = await gateway();
    const result = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: false, confirmClientOnlyRuntime: true });
    expect(result.mode).toBe("dry_run");
    expect(await row(id)).toMatchObject({ profile_creation_status: "unverified", verified: null });
  });

  it("says would_refuse for a gateway that fails a check, naming each failure", async () => {
    const id = await gateway({ status: "needs_attention", gatewayType: "single_profile" });
    const result = await attestClientGateway({ gatewayId: id, pinnedGatewayId: null, apply: false, confirmClientOnlyRuntime: false });
    expect(result.outcome).toBe("would_refuse");
    expect(result.report.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual(["gateway_connected", "gateway_multiplexed", "worker_pinned_to_gateway"]);
    expect(await row(id)).toMatchObject({ profile_creation_status: "unverified", verified: null });
  });
});

describe("applying the attestation", () => {
  it("is refused without the confirmation, before the database is touched", async () => {
    const id = await gateway();
    await expect(attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: false, operatorEmail: operator.email })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await row(id)).toMatchObject({ profile_creation_status: "unverified", verified: null });
    expect(await audits(id)).toEqual([]);
  });

  it("needs an operator who is an active agency super admin: without one, or with anyone else, nothing is changed and nothing is written", async () => {
    const id = await gateway();
    await expect(attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: "   " })).rejects.toMatchObject({ code: "invalid_input" });
    const staff = await createUser({ platformRole: "agency_staff" });
    const client = await createUser();
    const disabled = await createUser({ platformRole: "agency_super_admin" });
    await withSystem((db) => db.query("update users set status='disabled' where id=$1", [disabled.id]));
    for (const email of [staff.email, client.email, disabled.email, "nobody@example.test"]) {
      await expect(attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: email }), email).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await row(id)).toMatchObject({ profile_creation_status: "unverified", verified: null });
    expect(await audits(id)).toEqual([]);
    // The operator's email matches whatever its case.
    expect((await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email.toUpperCase() })).outcome).toBe("applied");
  });

  it("sets both columns once, bumps the revision and writes exactly one audit row with ids and check names only", async () => {
    const id = await gateway();
    const before = await row(id);
    const result = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
    expect(result).toMatchObject({ mode: "apply", outcome: "applied" });
    expect(result.report).toMatchObject({ eligible: true, attested: true });
    const after = await row(id);
    expect(after.profile_creation_status).toBe("restricted_service_verified");
    expect(after.verified).not.toBeNull();
    expect(after.revision).toBe(before.revision + 1);
    const rows = await audits(id);
    expect(rows).toHaveLength(1);
    // The row names the person who confirmed the runtime, and the pinned id the check compared.
    expect(rows[0]).toMatchObject({ result: "success", actor_kind: "agency", actor_user_id: operator.id, org_id: null, target_type: "hermes_gateway" });
    expect(rows[0].metadata).toMatchObject({ gatewayId: id, pinnedGatewayId: id, previousProfileCreationStatus: "unverified", employeesMapped: 0 });
    expect(JSON.stringify(rows[0].metadata)).not.toMatch(/https?:\/\//);
    expect(rows[0].metadata.checks).toEqual(["gateway_exists", "gateway_connected", "gateway_multiplexed", "worker_pinned_to_gateway", "no_agency_employee_on_gateway"]);
  });

  it("is idempotent: a second apply changes nothing and writes nothing", async () => {
    const id = await gateway();
    await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
    const first = await row(id);
    const second = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
    expect(second.outcome).toBe("already_attested");
    expect(await row(id)).toEqual(first);
    expect(await audits(id)).toHaveLength(1);
    const dry = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: false, confirmClientOnlyRuntime: false });
    expect(dry.outcome).toBe("already_attested");
  });

  it("refuses while an agency employee is mapped to the gateway, records the refusal, and applies once the mapping is gone", async () => {
    const id = await gateway();
    const agency = await mapAgencyEmployee(id);
    const refused = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
    expect(refused.outcome).toBe("refused");
    expect(refused.report.checks.find((check) => check.id === "no_agency_employee_on_gateway")).toMatchObject({ ok: false });
    expect(await row(id)).toMatchObject({ profile_creation_status: "unverified", verified: null });
    const rows = await audits(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "denied", actor_kind: "agency", actor_user_id: operator.id });
    expect(rows[0].metadata).toMatchObject({ pinnedGatewayId: id, failedChecks: ["no_agency_employee_on_gateway"], alreadyAttested: false });
    expect((await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: false, confirmClientOnlyRuntime: false })).outcome).toBe("would_refuse");

    await unmapAgencyEmployee(agency.id);
    expect((await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email })).outcome).toBe("applied");
    expect(await audits(id)).toHaveLength(2);
  });

  it("refuses an unconnected gateway and a single-profile gateway", async () => {
    for (const options of [{ status: "needs_attention" }, { status: "credentials_saved" }, { status: "disconnected" }, { gatewayType: "single_profile" }]) {
      const id = await gateway(options);
      const result = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
      expect(result.outcome, JSON.stringify(options)).toBe("refused");
      expect(await row(id)).toMatchObject({ profile_creation_status: "unverified", verified: null });
    }
    const connected = await gateway({ status: "needs_attention" });
    await withSystem((db) => db.query("update hermes_gateways set status='connected' where id=$1", [connected]));
    expect((await attestClientGateway({ gatewayId: connected, pinnedGatewayId: connected, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email })).outcome).toBe("applied");
  });

  it("refuses when the worker is pinned to another gateway or to none", async () => {
    const id = await gateway();
    for (const pinned of [randomUUID(), null]) {
      const result = await attestClientGateway({ gatewayId: id, pinnedGatewayId: pinned, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
      expect(result.outcome).toBe("refused");
      expect(result.report.checks.find((check) => check.id === "worker_pinned_to_gateway")).toMatchObject({ ok: false });
    }
    expect(await row(id)).toMatchObject({ profile_creation_status: "unverified", verified: null });
  });

  it("refuses an unknown gateway id without creating anything", async () => {
    const id = randomUUID();
    const result = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
    expect(result.outcome).toBe("refused");
    expect(result.report.checks).toEqual([{ id: "gateway_exists", ok: false, detail: "No gateway has this id." }]);
    expect(await withSystem((db) => db.query("select 1 from hermes_gateways where id=$1", [id]))).toMatchObject({ rows: [] });
  });

  it("does not undo an attestation that no longer holds: it reports it and leaves the columns alone", async () => {
    const id = await gateway();
    await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
    const attested = await row(id);
    await mapAgencyEmployee(id);
    const dry = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: false, confirmClientOnlyRuntime: false });
    expect(dry.outcome).toBe("would_refuse");
    expect(dry.report.attested).toBe(true);
    const applied = await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email });
    expect(applied.outcome).toBe("refused");
    expect(await row(id)).toEqual(attested);
    expect((await audits(id)).at(-1)).toMatchObject({ result: "denied" });
    expect((await audits(id)).at(-1)?.metadata).toMatchObject({ alreadyAttested: true });
  });

  it("reads the pinned id from the server settings the claim reads", () => {
    const id = randomUUID();
    pin(id);
    expect(pinnedGatewayIdFromEnv()).toBe(id);
    pin(null);
    expect(pinnedGatewayIdFromEnv()).toBeNull();
  });
});

describe("the checks are the claim's own checks", () => {
  /** A paid, onboarded client with one approved employee and its provision job queued. */
  async function queuedClient() {
    const org = await createOrg({ name: `Attest Roofing ${randomUUID().slice(0, 8)}` });
    await clearSetupPayment(org.id);
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    await withSystem((db) => db.query("update organizations set onboarding_completed_at=now() where id=$1", [org.id]));
    const agents = (await withSystem((db) => db.query<{ id: string; role_key: "lead_hunter" }>("select id,role_key from agent_instances where org_id=$1 order by role_key", [org.id]))).rows;
    await withSystem(async (db) => {
      await createConfigVersion(db, { orgId: org.id, agentId: agents[0].id, settings: defaultSettings(agents[0].role_key), source: "onboarding", userId: owner.id, apply: true });
      for (const agent of agents.slice(1)) await db.query("update agent_instances set enabled=false where id=$1", [agent.id]);
    });
    await withSystem((db) => requestProvisioning(db, org.id, owner.id));
    return org;
  }

  it("a gateway the attestation has just approved is claimable, and one it refused stays unclaimable even if the columns are forced", async () => {
    const org = await queuedClient();
    const id = await gateway();
    pin(id);
    await expect(claimHermesProvisionerJob(id)).resolves.toBeNull();
    expect((await attestClientGateway({ gatewayId: id, pinnedGatewayId: id, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email })).outcome).toBe("applied");
    const claimed = await claimHermesProvisionerJob(id);
    expect(claimed).toMatchObject({ orgId: org.id, kind: "provision", gatewayId: id });

    // The same refusal as the claim's: with an agency employee mapped the attestation refuses, and forcing the columns by hand does not make the claim hand out a job.
    await withSystem((db) => db.query("update agent_provisioning_jobs set status='requested',lease_token=null,lease_expires_at=null,attempt_count=0 where org_id=$1", [org.id]));
    const mixed = await gateway();
    pin(mixed);
    const agency = await mapAgencyEmployee(mixed);
    expect((await attestClientGateway({ gatewayId: mixed, pinnedGatewayId: mixed, apply: true, confirmClientOnlyRuntime: true, operatorEmail: operator.email })).outcome).toBe("refused");
    await withSystem((db) => db.query("update hermes_gateways set profile_creation_status='restricted_service_verified',provisioner_isolation_verified_at=now() where id=$1", [mixed]));
    await expect(claimHermesProvisionerJob(mixed)).resolves.toBeNull();
    await unmapAgencyEmployee(agency.id);
    await expect(claimHermesProvisionerJob(mixed)).resolves.toMatchObject({ orgId: org.id });
  });

  it("checkGatewayAttestation alone writes nothing", async () => {
    const id = await gateway();
    const before = await row(id);
    const report = await withSystem((db) => checkGatewayAttestation(db, id, id));
    expect(report.eligible).toBe(true);
    expect(await row(id)).toEqual(before);
    expect(await audits(id)).toEqual([]);
  });
});

describe("nothing in the application calls the attestation", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

  it("only the operator script imports it, and the script cannot apply without both flags", () => {
    const importers = walk("src").filter((file) => /hermes-provisioner-attest/.test(readFileSync(file, "utf8")) && !file.endsWith("hermes-provisioner-attest.ts"));
    expect(importers).toEqual([]);
    const script = readFileSync("scripts/hermes-client-gateway-attest.ts", "utf8");
    expect(script).toContain("--apply");
    expect(script).toContain("--confirm-client-only-runtime");
    expect(script).toMatch(/apply && !confirm\) throw/);
    expect(script).toContain("--operator");
    expect(script).toMatch(/apply && !operator\.includes\("@"\)\) throw/);
    // The module's only write is the one gateway update; the dry run opens a read-only transaction first.
    const source = readFileSync("src/server/workforce/hermes-provisioner-attest.ts", "utf8");
    expect(source.match(/"(?:insert into|update|delete from)\s/gi)?.map((statement) => statement.toLowerCase().trimEnd())).toEqual(['"update']);
    expect(source).toContain('"set transaction read only"');
    expect(source.indexOf("set transaction read only")).toBeLessThan(source.indexOf("checkGatewayAttestation(db, input.gatewayId, input.pinnedGatewayId)"));
  });
});
