// Pins the portal's Hermes adapter to the wire contract in the Hermes Agent source
// (gateway/platforms/api_server.py, api_server_runs.py, tools/approval.py, toolsets.py).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getCapabilities, getProfileModels, getToolsets, normalizeEvent, resolveRunApproval, restrictedToolsIn, startRun, hasVerifiedCompleteToolInventory } from "@/server/integrations/hermes/client";
import { inspectHermes } from "@/server/integrations/inspection";
import { validateHermesBaseUrl } from "@/server/workforce/service";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

describe("Hermes event normalization", () => {
  const ev = (event: string, data: Record<string, unknown>) => normalizeEvent({ event, data: JSON.stringify(data) });

  it("reads approval requests by request_id, description and pattern_key", () => {
    expect(
      ev("approval.request", { event: "approval.request", request_id: "req_9", pattern_key: "crm_write", description: "Update a contact", command: "[redacted]" }),
    ).toEqual({ type: "approval_request", approvalId: "req_9", tool: "crm_write", summary: "Update a contact" });
  });

  it("converts tool durations from seconds and flags failures", () => {
    expect(ev("tool.completed", { tool: "web_search", duration: 1.25, error: false })).toMatchObject({ type: "tool_completed", durationMs: 1250, error: false });
    expect(ev("tool.failed", { tool: "web_search" })).toMatchObject({ type: "tool_completed", error: true });
  });

  it("ignores interim commentary that was already streamed", () => {
    expect(ev("message.interim", { text: "x", already_streamed: true })).toBeNull();
  });
});

describe("Hermes verification fails closed",()=>{
  // Fully intercepted synthetic HTTP. These assertions do not contact an installed gateway.
  const conn={baseUrl:"http://127.0.0.1:9999",profile:"c-synthetic-profile",apiKey:"synthetic-credential"};
  afterEach(()=>vi.restoreAllMocks());

  it.each([
    null,
    {name:"terminal",enabled:true},
    {name:"core",enabled:"false",tools:["terminal"]},
    {name:"core",enabled:true,tools:["web_search",{name:"terminal"}]},
    {name:"core",enabled:true,tools:[]},
  ])("refuses incomplete tool permissions %#",async entry=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({object:"list",platform:"api_server",data:[entry]}));
    await expect(getToolsets(conn)).rejects.toMatchObject({kind:"bad_response"});
  });

  it("does not treat an empty tool inventory as verified permissions",async()=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({object:"list",data:[]}));
    await expect(getToolsets(conn)).rejects.toMatchObject({kind:"bad_response"});
  });

  it("does not accept an alias as the profile's primary identity",async()=>{
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      if(String(url).endsWith("/v1/capabilities"))return Response.json({object:"hermes.api_server.capabilities",auth:{required:true,type:"bearer"},features:{run_submission:true,run_events_sse:true}});
      if(String(url).endsWith("/v1/models"))return Response.json({object:"list",data:[{id:"agency-profile",owned_by:"hermes",root:"agency-profile",parent:null},{id:conn.profile,owned_by:"hermes",root:"underlying-model",parent:"agency-profile"}]});
      return Response.json({object:"list",data:[{name:"web",enabled:true,tools:["web_search"]}]});
    });
    expect(await getProfileModels(conn)).toEqual(["agency-profile"]);
    const result=await inspectHermes(conn,true);
    expect(result.status).toBe("needs_attention");expect(result.capabilities.identityVerified).toBe(false);
  });

  it("never treats the advertised public inventory as complete live permissions",async()=>{
    expect(hasVerifiedCompleteToolInventory({...conn,baseUrl:"https://gateway.example.test"})).toBe(false);
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      if(String(url).endsWith("/v1/capabilities"))return Response.json({object:"hermes.api_server.capabilities",auth:{required:true,type:"bearer"},features:{run_submission:true,run_events_sse:true}});
      if(String(url).endsWith("/v1/models"))return Response.json({object:"list",data:[{id:conn.profile,owned_by:"hermes",root:conn.profile,parent:null}]});
      return Response.json({object:"list",data:[{name:"web",enabled:true,tools:["web_search"]}]});
    });
    vi.stubEnv("SECRET_STORE","vault");
    try {
      const result=await inspectHermes(conn,true);
      expect(result.status).toBe("permission_limited");expect(result.capabilities.completeToolInventoryVerified).toBe(false);
      expect(result.detail).toMatch(/Client use stays blocked/);
      const spy=vi.mocked(globalThis.fetch);spy.mockClear();
      await expect(startRun(conn,{input:"blocked",idempotencyKey:"blocked-live-run"})).rejects.toMatchObject({kind:"bad_response"});
      expect(spy).not.toHaveBeenCalled();
    }finally{vi.unstubAllEnvs();}
  });

  it("applies deployment host approval to legacy configuration and credential-bearing adapter calls",async()=>{
    const spy=vi.spyOn(globalThis,"fetch");
    expect(()=>validateHermesBaseUrl("https://unapproved.example.test")).toThrow(/not approved/);
    await expect(getCapabilities({...conn,baseUrl:"https://unapproved.example.test"})).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends Cloudflare Access and Hermes profile credentials in separate headers",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({object:"hermes.api_server.capabilities",auth:{required:true,type:"bearer"},features:{run_submission:true,run_events_sse:true}}));
    const connection={...conn,accessClientId:"synthetic-access-id",accessClientSecret:"synthetic-access-secret"};
    expect((await getCapabilities(connection)).authenticated).toBe(true);
    const [url,init]=spy.mock.calls[0];const sent=new Headers(init?.headers);
    expect(String(url)).toContain("/p/c-synthetic-profile/v1/capabilities");
    expect(sent.get("Authorization")).toBe("Bearer synthetic-credential");
    expect(sent.get("CF-Access-Client-Id")).toBe("synthetic-access-id");
    expect(sent.get("CF-Access-Client-Secret")).toBe("synthetic-access-secret");
  });

  it("refuses a partial Cloudflare Access credential pair before making a request",async()=>{
    const spy=vi.spyOn(globalThis,"fetch");
    await expect(getCapabilities({...conn,accessClientId:"synthetic-access-id"})).rejects.toMatchObject({kind:"bad_response"});
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("restricted tool detection", () => {
  it("blocks unknown plugin tools until their client permissions are reviewed",()=>{
    expect(restrictedToolsIn([{name:"custom",enabled:true,tools:["mcp_read_system_secrets","new_admin_operation","read_terminal"]}])).toEqual(["mcp_read_system_secrets","new_admin_operation","read_terminal"]);
  });

  it("catches every tool from the terminal, file, code, browser, cron, delegation and connection toolsets", () => {
    const tools = ["terminal", "process_manage", "read_file", "write_file", "patch", "search_files", "execute_code", "computer_use", "cronjob_manage", "delegate_task", "manage_connections", "manage_catalog", "skill_manage", "browser_navigate", "kanban_complete"];
    expect(restrictedToolsIn([{ name: "x", enabled: true, tools }])).toEqual([...tools].sort());
  });

  it("allows research and memory tools and ignores disabled toolsets", () => {
    expect(restrictedToolsIn([{ name: "web", enabled: true, tools: ["web_search", "web_extract", "memory", "session_search", "todo_list"] }])).toEqual([]);
    expect(restrictedToolsIn([{ name: "terminal", enabled: false, tools: ["terminal", "process_manage"] }])).toEqual([]);
  });
});

describe("Hermes HTTP contract", () => {
  let mock: MockHermes;
  const conn = () => ({ baseUrl: mock.url, profile: "acme-sales", apiKey: "k-acme" });

  beforeAll(async () => {
    mock = await startMockHermes({
      "acme-sales": { key: "k-acme", respond: () => ({ steps: [{ approval: "crm_write" }, { delta: "ok" }], output: "ok" }) },
    });
  });
  afterAll(() => mock.close());

  it("reads approval support from run_approval_response", async () => {
    const caps = await getCapabilities(conn());
    expect(caps).toMatchObject({ supportsRuns: true, supportsEvents: true, supportsStop: true, supportsApproval: true });
  });

  it("reads toolsets from the { object: 'list', data } envelope", async () => {
    const sets = await getToolsets(conn());
    expect(sets[0]?.tools).toContain("web_search");
  });

  it("routes through the profile prefix and resolves approvals with { choice, request_id }", async () => {
    const { runId } = await startRun(conn(), { input: "hi", idempotencyKey: "contract-1" });
    expect(mock.requests.at(-1)).toMatchObject({ path: "/v1/runs", profile: "acme-sales" });
    await resolveRunApproval(conn(), runId, "deny", "appr_1");
    expect(mock.runs.get(runId)?.approvalResolved).toBe("deny");
  });
});
