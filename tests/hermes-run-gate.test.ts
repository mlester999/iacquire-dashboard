// Every way of starting a Hermes run (chat, lead research, customer replies, draft previews) must pass the same
// readiness gate: `startAgentRun`. These tests prove an employee that never passed a health check cannot run through
// any of the entry points, and that nothing reaches the gateway when it is refused.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import type { ConfigPreviewEvent } from "@/lib/workforce-types";
import { withSystem } from "@/server/db";
import { assertAgentRunnable, startAgentRun } from "@/server/integrations/hermes/client";
import { createResearchRequest, runResearch } from "@/server/leads/service";
import { hermesReplyGenerator, type ReplyContext } from "@/server/messaging/responder";
import { runConfigPreview } from "@/server/workforce/preview";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import type { OrgContext } from "@/server/tenancy/context";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "g".repeat(40);
const HEALTH_CHECK_REQUIRED = /hasn't passed its connection and tool-inventory check/;
const CONFIG_REQUIRED = /no applied configuration/;
const INVENTORY_REQUIRED = /no verified tool inventory on record/;
const DIGEST = "a".repeat(64);
const CONFIG = "11111111-1111-4111-8111-111111111111";

describe("the readiness rules", () => {
  const ready = { enabled: true, status: "online", credential_ready: true, active_config_version_id: CONFIG, tool_inventory_digest: DIGEST };

  it("accepts an enabled, online, configured employee with a recorded digest, and returns the digest to compare against", () => {
    expect(assertAgentRunnable(ready)).toBe(DIGEST);
    expect(assertAgentRunnable({ ...ready, status: "busy" })).toBe(DIGEST);
  });

  it.each(["setup_required", "provisioning", "offline", "error", "disabled"])("refuses an employee that is %s", (status) => {
    expect(() => assertAgentRunnable({ ...ready, status })).toThrow(HEALTH_CHECK_REQUIRED);
  });

  it("refuses a disabled employee, a missing configuration, a missing digest and a malformed digest", () => {
    expect(() => assertAgentRunnable({ ...ready, enabled: false })).toThrow(/isn't enabled/);
    expect(() => assertAgentRunnable({ ...ready, active_config_version_id: null })).toThrow(CONFIG_REQUIRED);
    expect(() => assertAgentRunnable({ ...ready, tool_inventory_digest: null })).toThrow(INVENTORY_REQUIRED);
    expect(() => assertAgentRunnable({ ...ready, tool_inventory_digest: "" })).toThrow(INVENTORY_REQUIRED);
    expect(() => assertAgentRunnable({ ...ready, tool_inventory_digest: "not-a-sha256" })).toThrow(INVENTORY_REQUIRED);
  });

  it("refuses an employee whose saved Hermes credential is missing or revoked", () => {
    expect(() => assertAgentRunnable({ ...ready, credential_ready: false })).toThrow(/saved Hermes credential is missing or revoked/);
  });

  it("blocks a host-provisioned profile until its applied configuration version is synchronized", () => {
    expect(assertAgentRunnable({ ...ready, hermes_profile_config_version_id: CONFIG })).toBe(DIGEST);
    expect(() => assertAgentRunnable({
      ...ready,
      hermes_profile_config_version_id: "22222222-2222-4222-8222-222222222222",
    })).toThrow(/still synchronizing to its dedicated Hermes profile/);
  });

  it("checks status, then configuration, then inventory so the activation sequence is unambiguous", () => {
    expect(() => assertAgentRunnable({ enabled: true, status: "provisioning", credential_ready: true, active_config_version_id: null, tool_inventory_digest: null })).toThrow(HEALTH_CHECK_REQUIRED);
    expect(() => assertAgentRunnable({ enabled: true, status: "online", credential_ready: true, active_config_version_id: null, tool_inventory_digest: null })).toThrow(CONFIG_REQUIRED);
    expect(() => assertAgentRunnable({ enabled: true, status: "online", credential_ready: true, active_config_version_id: CONFIG, tool_inventory_digest: null })).toThrow(INVENTORY_REQUIRED);
  });
});

describe("no run bypasses the shared gate", () => {
  const SRC = path.resolve(import.meta.dirname, "../src");
  const CLIENT = path.resolve(SRC, "server/integrations/hermes/client.ts");

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  it("keeps the low-level startRun private to the Hermes client", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => path.resolve(file) !== CLIENT && /\bstartRun\b/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});

describe("runs through every entry point", () => {
  let mock: MockHermes;
  let agency: Awaited<ReturnType<typeof createOrg>>;
  let client: Awaited<ReturnType<typeof createOrg>>;
  let admin: { id: string };
  let agencyOwner: { id: string; email: string };
  let clientOwner: { id: string; email: string };
  const agency$: Partial<Record<AgentRoleKey, string>> = {};
  const client$: Partial<Record<AgentRoleKey, string>> = {};

  const runsSent = () => mock.requests.filter((request) => request.path === "/v1/runs").length;

  async function connectAndConfigure(org: { id: string }, role: AgentRoleKey, profile: string, userId: string, source: "agency" | "onboarding") {
    const id = await agentId(org.id, role);
    await connectHermesProfile({ agentId: id, baseUrl: mock.url, profile, apiKey: KEY, agencyUserId: admin.id });
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source, userId, apply: true }));
    return id;
  }

  async function preview(ctx: OrgContext, role: AgentRoleKey) {
    const events: ConfigPreviewEvent[] = [];
    for await (const event of runConfigPreview(ctx, { role, settings: defaultSettings(role), messages: [{ role: "user", content: "Hello" }] }, new AbortController().signal)) {
      events.push(event);
    }
    return events;
  }

  const replyContext = (orgId: string, agent: string): ReplyContext => ({
    orgId,
    agentId: agent,
    conversationId: crypto.randomUUID(),
    contactId: crypto.randomUUID(),
    inboundMessageId: crypto.randomUUID(),
    channel: "sms",
    businessName: "Gate Co",
    customerMessage: "Do you have room Thursday?",
    history: [],
    confirmedFacts: [],
  });

  async function research(ctx: OrgContext) {
    const { requestId } = await createResearchRequest(ctx, { prompt: "dentists in Austin", campaignType: "business" });
    return requestId;
  }

  async function settledResearch(requestId: string) {
    for (let i = 0; i < 200; i++) {
      const { rows } = await withSystem((db) =>
        db.query<{ status: string; failure_reason: string | null; agent_run_id: string | null }>(
          "select status, failure_reason, agent_run_id from lead_research_requests where id = $1",
          [requestId],
        ),
      );
      if (rows[0] && !["queued", "running"].includes(rows[0].status)) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("lead research did not settle");
  }

  beforeAll(async () => {
    mock = await startMockHermes({
      [AGENCY_HERMES_PROFILE_IDS.sales_assistant]: { key: KEY },
      [AGENCY_HERMES_PROFILE_IDS.lead_hunter]: { key: KEY },
      "c-gate-sales-assistant": { key: KEY },
      "c-gate-lead-hunter": { key: KEY },
    });
    admin = await createUser({ platformRole: "agency_super_admin" });
    agency = await createOrg({ name: "Gate Agency", kind: "agency" });
    client = await createOrg({ name: "Gate Client" });
    agencyOwner = await createUser();
    clientOwner = await createUser();
    await addMember(agency.id, agencyOwner.id, "owner");
    await addMember(client.id, clientOwner.id, "owner");
    // The agency employees are mapped to their profile, hold a credential and have an applied configuration, but no
    // health check has ever run: exactly the state of the six internal employees today.
    for (const role of ["sales_assistant", "lead_hunter"] as const) {
      agency$[role] = await connectAndConfigure(agency, role, AGENCY_HERMES_PROFILE_IDS[role], admin.id, "agency");
    }
    // The client employees take the real route online: configuration applied, then a passing health check.
    for (const role of ["sales_assistant", "lead_hunter"] as const) {
      client$[role] = await connectAndConfigure(client, role, `c-gate-${role.replaceAll("_", "-")}`, clientOwner.id, "onboarding");
      expect(await runHealthCheck(client$[role]!, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
    }
  }, 60000);
  afterAll(() => mock.close());

  describe("a provisioning agency employee", () => {
    it("is mapped and configured but has never been health-checked", async () => {
      const { rows } = await withSystem((db) =>
        db.query<{ status: string; credential_id: string | null; hermes_profile: string | null; active_config_version_id: string | null; tool_inventory_digest: string | null }>(
          "select status, credential_id, hermes_profile, active_config_version_id, tool_inventory_digest from agent_instances where id = any($1)",
          [[agency$.sales_assistant, agency$.lead_hunter]],
        ),
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ status: "provisioning", tool_inventory_digest: null });
        expect(row.credential_id).toBeTruthy();
        expect(row.hermes_profile).toBeTruthy();
        expect(row.active_config_version_id).toBeTruthy();
      }
    });

    it("cannot start a configuration preview run, and the gateway is never contacted", async () => {
      const requestsBefore = mock.requests.length;
      const events = await preview(ctxFor(agencyOwner, agency, "owner"), "sales_assistant");
      expect(events[0]).toMatchObject({ type: "prepared" });
      const last = events.at(-1);
      expect(last).toMatchObject({ type: "unavailable" });
      expect((last as { message: string }).message).toMatch(HEALTH_CHECK_REQUIRED);
      expect(events.some((event) => event.type === "started" || event.type === "delta" || event.type === "done")).toBe(false);
      expect(mock.requests).toHaveLength(requestsBefore);
    });

    it("cannot start a lead research run, and the stranded run row is closed", async () => {
      const requestsBefore = mock.requests.length;
      const ctx = ctxFor(agencyOwner, agency, "owner");
      const requestId = await research(ctx);
      // Not ready, so the request waits for the employee instead of queuing a run.
      expect((await settledResearch(requestId)).status).toBe("waiting_for_agent");
      // A retry that races a status change (or any direct caller) reaches runResearch itself: the job gate refuses when the worker claims the job, so no run row is ever
      // created, the request goes back to waiting with the reason, and the gateway is never contacted.
      await runResearch(agency.id, requestId, agency$.lead_hunter!, agencyOwner.id);
      const outcome = await settledResearch(requestId);
      expect(outcome.status).toBe("waiting_for_agent");
      expect(outcome.failure_reason).toMatch(/isn't connected yet/); // the reason it was already waiting with
      expect(outcome.agent_run_id).toBeNull();
      expect(mock.requests).toHaveLength(requestsBefore);
    });

    it("cannot start a customer reply run, and the gateway is never contacted", async () => {
      const requestsBefore = mock.requests.length;
      const outcome = await hermesReplyGenerator(replyContext(agency.id, agency$.sales_assistant!));
      expect(outcome).toMatchObject({ kind: "unavailable" });
      expect((outcome as { reason: string }).reason).toMatch(HEALTH_CHECK_REQUIRED);
      expect(mock.requests).toHaveLength(requestsBefore);
    });
  });

  describe("tenant authorization", () => {
    it("refuses an employee presented under another workspace before contacting the gateway", async () => {
      const requestsBefore = mock.requests.length;
      await expect(startAgentRun(client$.sales_assistant!, agency.id, { baseUrl: mock.url, profile: "c-gate-sales-assistant", apiKey: KEY }, {
        input: "cross-tenant",
        idempotencyKey: `cross-tenant-${crypto.randomUUID()}`,
      })).rejects.toMatchObject({ kind: "not_found" });
      await expect(startAgentRun(agency$.sales_assistant!, client.id, { baseUrl: mock.url, profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant, apiKey: KEY }, {
        input: "cross-tenant agency",
        idempotencyKey: `cross-tenant-agency-${crypto.randomUUID()}`,
      })).rejects.toMatchObject({ kind: "not_found" });
      expect(mock.requests).toHaveLength(requestsBefore);
    });
  });

  describe("a client employee that passed its health check", () => {
    it("can preview, research and reply, each through the gate", async () => {
      const ctx = ctxFor(clientOwner, client, "owner");
      const before = runsSent();

      const events = await preview(ctx, "sales_assistant");
      expect(events.some((event) => event.type === "started")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "done" });

      const outcome = await hermesReplyGenerator(replyContext(client.id, client$.sales_assistant!));
      expect(outcome).toMatchObject({ kind: "reply" });

      const research$ = await settledResearch(await research(ctx));
      expect(research$.status).toBe("completed");
      expect(runsSent()).toBe(before + 3);
    });
  });

  describe("an employee marked online whose inventory digest was never recorded", () => {
    it("is refused by every entry point before any run is submitted", async () => {
      await withSystem((db) => db.query("update agent_instances set tool_inventory_digest = null where id = any($1)", [[client$.sales_assistant, client$.lead_hunter]]));
      try {
        const ctx = ctxFor(clientOwner, client, "owner");
        const before = runsSent();

        const events = await preview(ctx, "sales_assistant");
        expect(events.at(-1)).toMatchObject({ type: "unavailable" });
        expect((events.at(-1) as { message: string }).message).toMatch(INVENTORY_REQUIRED);

        const outcome = await hermesReplyGenerator(replyContext(client.id, client$.sales_assistant!));
        expect(outcome).toMatchObject({ kind: "unavailable" });
        expect((outcome as { reason: string }).reason).toMatch(INVENTORY_REQUIRED);

        // `online` lets the request queue, so this is the run-time gate refusing a queued request.
        const outcomeResearch = await settledResearch(await research(ctx));
        expect(outcomeResearch.status).toBe("failed");
        expect(outcomeResearch.failure_reason).toMatch(INVENTORY_REQUIRED);

        expect(runsSent()).toBe(before);
      } finally {
        for (const id of [client$.sales_assistant!, client$.lead_hunter!]) await runHealthCheck(id, { userId: admin.id, kind: "agency" });
      }
    });
  });
});
