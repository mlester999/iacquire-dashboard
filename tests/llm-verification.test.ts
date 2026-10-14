// Intercepted HTTP and in-memory synthetic credentials only; no model provider is contacted.
import {afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import {inspectLlm,fetchLlmModels} from "@/server/integrations/inspection";
import {listIntegrationManager,saveIntegrationConnection,testIntegrationConnection} from "@/server/integrations/manager";
import {withSystem} from "@/server/db";
import {createUser,agencyUser} from "./support/fixtures";

const SECRET="synthetic-model-key-"+"k".repeat(30);
const conn={baseUrl:"http://127.0.0.1:9999",model:"synthetic-chat",format:"openai" as const,apiKey:SECRET};
afterEach(()=>vi.restoreAllMocks());

describe("model verification operation boundaries",()=>{
  it("uses only model listing when the selected model is advertised",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:[{id:conn.model}]}));
    const result=await inspectLlm(conn);
    expect(result).toMatchObject({status:"connected",capabilities:{verificationOperation:"model_listing",safeReadOnlyTest:true,modelListed:true}});
    expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0][1]?.method).toBe("GET");
  });

  it("does not use completion to bypass a missing advertised model",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({data:[{id:"other-model"}]}));
    expect((await inspectLlm(conn)).status).toBe("needs_attention");expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([401,403,429,500,502])("stops on listing HTTP %s without sending a completion",async status=>{
    const spy=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(SECRET,{status}));
    await expect(inspectLlm(conn)).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0][1]?.method).toBe("GET");
  });

  it.each([{},[],{data:[]},{data:"malformed"}])("stops on malformed or empty model listings %#",async body=>{
    const spy=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json(body));
    await expect(inspectLlm(conn)).rejects.toThrow();expect(spy).toHaveBeenCalledTimes(1);
  });

  it("stops on a network failure and sanitizes the error",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network failure with "+SECRET));
    await expect(inspectLlm(conn)).rejects.toThrow("The model provider could not be reached or timed out.");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([404,405,501])("discloses a minimal response only after explicitly unsupported listing HTTP %s",async status=>{
    const spy=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response(null,{status})).mockResolvedValueOnce(Response.json({choices:[{message:{content:"OK "+SECRET}}]}));
    const result=await inspectLlm(conn);
    expect(result).toMatchObject({status:"connected",capabilities:{verificationOperation:"basic_model_response",safeReadOnlyTest:false,maxOutputTokensRequested:1}});
    expect(result.detail).toMatch(/minimal one-token response/);expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(spy.mock.calls.map(([,init])=>init?.method)).toEqual(["GET","POST"]);
    expect(JSON.parse(String(spy.mock.calls[1][1]?.body))).toMatchObject({model:conn.model,max_tokens:1,temperature:0});
    expect(spy.mock.calls.every(([,init])=>init?.redirect==="error")).toBe(true);
  });

  it("labels a failed minimal response as that operation rather than read-only proof",async()=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response(null,{status:405})).mockResolvedValueOnce(new Response(SECRET,{status:401}));
    const result=await inspectLlm(conn);
    expect(result).toMatchObject({status:"error",capabilities:{verificationOperation:"basic_model_response",safeReadOnlyTest:false}});
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("loading models alone never requests a completion",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(null,{status:404}));
    await expect(fetchLlmModels(conn)).rejects.toThrow(/does not support model listing/);expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("persisted model verification diagnostics",()=>{
  let admin:ReturnType<typeof agencyUser>;
  beforeAll(async()=>{admin=agencyUser(await createUser({platformRole:"agency_super_admin"}),"agency_super_admin");});

  it("persists the actual model operation in capabilities, audit and safe history",async()=>{
    await saveIntegrationConnection(admin,null,{provider:"llm",label:"Synthetic model",environment:"development",secret:SECRET,config:{baseUrl:conn.baseUrl,model:conn.model,apiFormat:conn.format,llmPreset:"custom"}});
    vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response(null,{status:405})).mockResolvedValueOnce(Response.json({choices:[{message:{content:"OK"}}]}));
    expect((await testIntegrationConnection(admin,null,"llm")).status).toBe("connected");
    const connection=(await listIntegrationManager(admin,null)).connections.find(c=>c.provider==="llm")!;
    expect(connection.capabilities).toMatchObject({verificationOperation:"basic_model_response",safeReadOnlyTest:false});
    expect(connection.checks[0]).toMatchObject({operation:"basic_model_response",mode:"mock"});
    const {rows}=await withSystem(db=>db.query<{metadata:{verificationOperation:string;mode:string}}>("select metadata from audit_logs where target_id=$1 and action='integration.connection_tested' order by created_at desc limit 1",[connection.id]));
    expect(rows[0].metadata).toMatchObject({verificationOperation:"basic_model_response",mode:"mock"});
    expect(JSON.stringify(connection)).not.toContain(SECRET);
    // Older checks used the verification field. Read them honestly without rewriting history.
    await withSystem(db=>db.query("update integration_connection_checks set capabilities=capabilities-'verificationOperation' where connection_id=$1",[connection.id]));
    expect((await listIntegrationManager(admin,null)).connections.find(c=>c.provider==="llm")?.checks[0].operation).toBe("basic_model_response");
  });

  it("records listing errors without promoting them to a response test",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error(SECRET));
    const result=await testIntegrationConnection(admin,null,"llm");
    expect(result).toMatchObject({status:"error",capabilities:{verificationOperation:"model_listing",safeReadOnlyTest:true}});
    expect(spy).toHaveBeenCalledTimes(1);
    const connection=(await listIntegrationManager(admin,null)).connections.find(c=>c.provider==="llm")!;
    expect(connection.checks[0]).toMatchObject({operation:"model_listing",mode:"mock"});expect(JSON.stringify(connection)).not.toContain(SECRET);
  });
});
