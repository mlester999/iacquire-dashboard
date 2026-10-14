// Synthetic database + mocked provider HTTP only. This suite is not live infrastructure proof.
import { beforeAll,afterAll,afterEach,describe,it,expect,vi } from "vitest";
import { withSystem,withUser } from "@/server/db";
import { saveCredential,resolveCredential } from "@/server/security/credentials";
import { saveIntegrationConnection,listIntegrationManager,testIntegrationConnection,disconnectIntegration,mapAgencyWorkflows,integrationSaveSchema,syncGhlMetadata,mapGhlAssets } from "@/server/integrations/manager";
import { inspectGhl,inspectN8n,readN8nExecutions } from "@/server/integrations/inspection";
import { validateIntegrationEndpoint } from "@/server/integrations/safety";
import { createUser,createOrg,agencyUser,addMember } from "./support/fixtures";
import { startMockHermes,type MockHermes } from "./support/mock-hermes";

const SECRET="synthetic-integration-key-"+"k".repeat(32);
const LOCATION="syntheticLocation1234";
let admin:ReturnType<typeof agencyUser>;let staff:ReturnType<typeof agencyUser>;let owner:Awaited<ReturnType<typeof createUser>>;
let orgA:Awaited<ReturnType<typeof createOrg>>;let orgB:Awaited<ReturnType<typeof createOrg>>;let hermes:MockHermes;
const ghlInput=()=>({provider:"ghl" as const,label:"Synthetic CRM",environment:"development" as const,secret:SECRET,config:{locationId:LOCATION,scopes:["locations.readonly","opportunities.readonly"] as Array<"locations.readonly"|"opportunities.readonly">}});
beforeAll(async()=>{
  const a=await createUser({platformRole:"agency_super_admin"});admin=agencyUser(a,"agency_super_admin");
  staff=agencyUser(await createUser({platformRole:"agency_staff"}),"agency_staff");owner=await createUser();
  orgA=await createOrg();orgB=await createOrg();await addMember(orgA.id,owner.id,"owner");
  await withSystem(db=>db.query("insert into staff_assignments(org_id,user_id) values($1,$2)",[orgA.id,staff.id]));
  hermes=await startMockHermes({"c-synthetic-sales":{key:SECRET},"c-synthetic-danger":{key:SECRET,tools:["terminal","read_file"]}});
});
afterAll(()=>hermes.close());afterEach(()=>vi.restoreAllMocks());

describe("managed credential boundaries",()=>{
  it("blocks ordinary clients, agency staff and a forged super-admin claim before secret storage",async()=>{
    await expect(saveIntegrationConnection(staff,orgA.id,ghlInput())).rejects.toMatchObject({code:"forbidden"});
    await expect(saveIntegrationConnection({...admin,id:owner.id},orgA.id,ghlInput())).rejects.toMatchObject({code:"forbidden"});
    await expect(withSystem(db=>saveCredential(db,{orgId:null,provider:"n8n",label:"No",secret:SECRET,actorId:staff.id}))).rejects.toMatchObject({code:"forbidden"});
  });
  it("persists references, never plaintext, and saved credentials are not connected",async()=>{
    await saveIntegrationConnection(admin,orgA.id,ghlInput());
    const view=await listIntegrationManager(admin,orgA.id);const c=view.connections.find(c=>c.provider==="ghl")!;
    expect(c.status).toBe("credentials_saved");expect(c.lastSuccessAt).toBeNull();expect(JSON.stringify(view)).not.toContain(SECRET);
    const {rows}=await withSystem(db=>db.query<{ciphertext:string;credential_reference_id:string}>("select ciphertext,credential_reference_id from integration_credentials where id=(select credential_id from integration_connections where org_id=$1 and provider='ghl')",[orgA.id]));
    expect(rows[0].ciphertext).toMatch(/^vault-ref:/);expect(rows[0].ciphertext).not.toContain(SECRET);expect(rows[0].credential_reference_id).toBeTruthy();
  });
  it("validates tenant and provider before resolving a credential",async()=>{
    const {rows}=await withSystem(db=>db.query<{credential_id:string}>("select credential_id from integration_connections where org_id=$1 and provider='ghl'",[orgA.id]));
    await expect(withSystem(db=>resolveCredential(db,rows[0].credential_id,orgB.id,"ghl"))).rejects.toMatchObject({code:"forbidden"});
    await expect(withSystem(db=>resolveCredential(db,rows[0].credential_id,orgA.id,"hermes"))).rejects.toMatchObject({code:"forbidden"});
  });
  it("records actual resolution outcomes without treating a missing secret as a success",async()=>{
    const credential=await withSystem(db=>saveCredential(db,{orgId:orgA.id,provider:"n8n",label:"Synthetic audit reference",secret:SECRET,actorId:admin.id}));
    expect(await withSystem(db=>resolveCredential(db,credential.id,orgA.id,"n8n"))).toBe(SECRET);
    await withSystem(db=>db.query("update credential_references set vault_secret_id=gen_random_uuid() where id=(select credential_reference_id from integration_credentials where id=$1)",[credential.id]));
    expect(await withSystem(db=>resolveCredential(db,credential.id,orgA.id,"n8n"))).toBeNull();
    const {rows}=await withSystem(db=>db.query<{result:string;metadata:unknown}>("select result,metadata from audit_logs where target_id=$1 and action='credential.resolved' order by created_at",[credential.id]));
    expect(rows.map(r=>r.result)).toEqual(["success","failure"]);expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
  it("RLS hides manager metadata from clients and unrelated agency staff, and grants no credential reads",async()=>{
    expect((await withUser(owner.id,db=>db.query("select * from integration_connections where org_id=$1",[orgA.id]))).rows).toHaveLength(0);
    expect((await withUser(staff.id,db=>db.query("select * from integration_connections where org_id=$1",[orgB.id]))).rows).toHaveLength(0);
    expect((await withUser(staff.id,db=>db.query("select * from integration_connections where org_id=$1",[orgA.id]))).rows).toHaveLength(1);
    await expect(withUser(staff.id,db=>db.query("select * from credential_references"))).rejects.toThrow(/permission denied/);
    await expect(withUser(owner.id,db=>db.query("update integration_connections set status='connected' where org_id=$1",[orgA.id]))).rejects.toThrow(/permission denied/);
  });
  it("rejects unapproved endpoints, URL credentials and write scopes",()=>{
    expect(()=>validateIntegrationEndpoint("https://unapproved.example.com")).toThrow(/not approved/);
    expect(()=>validateIntegrationEndpoint("https://username:password@evil.example.com")).toThrow(/credentials/);
    expect(()=>validateIntegrationEndpoint("http://169.254.169.254/latest/meta-data")).toThrow(/HTTPS/);
    expect(integrationSaveSchema.safeParse({...ghlInput(),config:{locationId:LOCATION,scopes:["opportunities.write"]}}).success).toBe(false);
    expect(integrationSaveSchema.safeParse({...ghlInput(),config:{locationId:LOCATION,token:SECRET}}).success).toBe(false);
  });
  it("rotates old portal references and revokes access immediately",async()=>{
    const old=(await withSystem(db=>db.query<{credential_id:string}>("select credential_id from integration_connections where org_id=$1 and provider='ghl'",[orgA.id]))).rows[0].credential_id;
    await saveIntegrationConnection(admin,orgA.id,{...ghlInput(),secret:SECRET+"-rotated"});
    expect(await withSystem(db=>resolveCredential(db,old,orgA.id,"ghl"))).toBeNull();
    await disconnectIntegration(admin,orgA.id,"ghl");
    expect((await listIntegrationManager(admin,orgA.id)).connections.find(c=>c.provider==="ghl")?.status).toBe("disconnected");
    await expect(testIntegrationConnection(admin,orgA.id,"ghl")).rejects.toMatchObject({code:"integration_unavailable"});
    const reconnect={...ghlInput(),secret:undefined};
    await expect(saveIntegrationConnection(admin,orgA.id,reconnect)).rejects.toMatchObject({code:"invalid_input"});
  });
});

describe("read-only verification and installed contract",()=>{
  it("verifies dedicated Hermes identity and capabilities; preserves credentials-saved until a test",async()=>{
    await saveIntegrationConnection(admin,orgA.id,{provider:"hermes",label:"Synthetic employee",environment:"development",secret:SECRET,config:{baseUrl:hermes.url,profile:"c-synthetic-sales",roleKey:"sales_assistant"}});
    expect((await listIntegrationManager(admin,orgA.id)).connections.find(c=>c.provider==="hermes")?.status).toBe("credentials_saved");
    const result=await testIntegrationConnection(admin,orgA.id,"hermes");expect(result.status).toBe("connected");expect(result.capabilities.identityVerified).toBe(true);expect(result.capabilities.packageVersion).toBe("not_reported");
    expect(hermes.requests.every(r=>r.method==="GET")).toBe(true);
    const view=await listIntegrationManager(admin,orgA.id);expect(view.connections.find(c=>c.provider==="hermes")?.checks[0].mode).toBe("mock");expect(JSON.stringify(view)).not.toContain(SECRET);
  });
  it("rejects dangerous Hermes tool permissions and shared agency identities",async()=>{
    await expect(saveIntegrationConnection(admin,orgB.id,{provider:"hermes",label:"Reserved",environment:"development",secret:SECRET,config:{baseUrl:hermes.url,profile:"iacquire-sales-assistant",roleKey:"sales_assistant"}})).rejects.toThrow(/dedicated profiles/);
    await saveIntegrationConnection(admin,orgB.id,{provider:"hermes",label:"Unsafe test profile",environment:"development",secret:SECRET,config:{baseUrl:hermes.url,profile:"c-synthetic-danger",roleKey:"sales_assistant"}});
    expect((await testIntegrationConnection(admin,orgB.id,"hermes")).status).toBe("needs_attention");
  });
  it("rejects GHL location mismatch before metadata reads",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({location:{id:"anotherLocation1234"}}));
    await expect(inspectGhl({locationId:LOCATION,token:SECRET,orgKind:"client"},["opportunities.readonly"])).rejects.toThrow(/location mismatch/);
    expect(spy).toHaveBeenCalledTimes(1);expect(String(spy.mock.calls[0][0])).toContain(`/locations/${LOCATION}`);
  });
  it("never accesses either protected GHL client location",async()=>{
    const spy=vi.spyOn(globalThis,"fetch");
    for(const locationId of ["u69CVh0ZlAofUmRoj1zF","SQvVnld5MBHdMQ1qnSfw"])await expect(inspectGhl({locationId,token:SECRET,orgKind:"client"},[])).rejects.toMatchObject({code:"forbidden"});
    expect(spy).not.toHaveBeenCalled();
  });
  it("records permission-limited GHL results honestly and never claims snapshot or webhook readiness",async()=>{
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>String(url).includes("/locations/")?Response.json({location:{id:LOCATION}}):new Response("not permitted",{status:403}));
    const result=await inspectGhl({locationId:LOCATION,token:SECRET,orgKind:"client"},["locations.readonly","opportunities.readonly"]);
    expect(result.status).toBe("permission_limited");expect(result.capabilities.snapshotInstallation).toBe("unverified");expect(result.capabilities.marketplaceWebhooks).toBe("separate_unconfigured_connection");
  });
  it("does not claim requested event-read permission that was not probed",async()=>{
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>String(url).includes("/locations/")?Response.json({location:{id:LOCATION}}):Response.json({pipelines:[]}));
    const result=await inspectGhl({locationId:LOCATION,token:SECRET,orgKind:"client"},["locations.readonly","opportunities.readonly","calendars/events.readonly"]);
    expect(result.status).toBe("permission_limited");expect(result.capabilities.unverifiedPermissions).toEqual(["calendars/events.readonly"]);
    expect(result.capabilities.provenReadPermissions).not.toContain("calendars/events.readonly");
  });
  it("n8n fails safely when unavailable and rejects arbitrary workflow IDs before HTTP",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network error containing "+SECRET));
    await expect(inspectN8n({baseUrl:"http://127.0.0.1:9999",apiKey:SECRET},[])).rejects.toThrow(/could not be reached/);
    spy.mockClear();await expect(readN8nExecutions({baseUrl:"http://127.0.0.1:9999",apiKey:SECRET},"arbitrary",["approved"])).rejects.toMatchObject({code:"forbidden"});expect(spy).not.toHaveBeenCalled();
  });
  it("filters workflow payloads and execution details; broad key privileges remain unverified",async()=>{
    const spy=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>String(url).includes("executions")?Response.json({data:[{id:"e1",workflowId:"wf-safe",status:"success",startedAt:"2026-01-01",data:{secret:SECRET}}]}):Response.json({data:[{id:"wf-safe",name:"Approved",active:false,nodes:[{credentials:SECRET}],pinData:{secret:SECRET}}]}));
    const result=await inspectN8n({baseUrl:"http://127.0.0.1:9999",apiKey:SECRET},["wf-safe"]);
    expect(result.status).toBe("connected");expect(result.capabilities.edition).toBe("unverified");expect(result.capabilities.packageVersion).toBe("not_reported");expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(spy.mock.calls.every(([,init])=>init?.method==="GET")).toBe(true);expect(String(spy.mock.calls[1][0])).toContain("includeData=false");
  });
  it("agency workflow mappings prevent duplicate client assignment and read only approved IDs",async()=>{
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>String(url).includes("executions")?Response.json({data:[]}):Response.json({data:[{id:"wf-safe",name:"Approved",active:false}]}));
    await saveIntegrationConnection(admin,null,{provider:"n8n",label:"Synthetic n8n",environment:"development",secret:SECRET,config:{baseUrl:"http://127.0.0.1:9999",approvedWorkflowIds:["wf-safe"]}});
    await testIntegrationConnection(admin,null,"n8n");await mapAgencyWorkflows(admin,orgA.id,["wf-safe"]);
    await expect(mapAgencyWorkflows(admin,orgB.id,["wf-safe"])).rejects.toMatchObject({code:"conflict"});
    await expect(mapAgencyWorkflows(admin,orgB.id,["arbitrary"])).rejects.toMatchObject({code:"forbidden"});
    const result=await testIntegrationConnection(admin,orgA.id,"n8n");expect(result.status).toBe("connected");
    const {rows}=await withSystem(db=>db.query<{status:string}>("select status from automation_template_mappings where org_id=$1",[orgA.id]));expect(rows[0].status).toBe("verified");
  });
});

describe("GHL guided steps: metadata sync and verified mapping",()=>{
  // Mocked GoHighLevel HTTP: proves portal rules, not live GoHighLevel behavior.
  const GL="syntheticGhlSecond5678";const PIPELINE="pipelineAbcdef12";const CALENDAR="calendarAbcdef12";
  const ghlFetch=()=>vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
    const u=String(url);
    if(u.includes(`/locations/${GL}`))return Response.json({location:{id:GL}});
    if(u.includes("/opportunities/pipelines"))return Response.json({pipelines:[{id:PIPELINE,name:"Sales",stages:[{id:"stageAbcdef123",name:"New"}]}]});
    if(u.includes("/calendars/"))return Response.json({calendars:[{id:CALENDAR,name:"Consultation"}]});
    return new Response("{}",{status:404});
  });
  const input={...ghlInput(),config:{locationId:GL,scopes:["locations.readonly","opportunities.readonly","calendars.readonly"] as Array<"locations.readonly"|"opportunities.readonly"|"calendars.readonly">}};
  let org:Awaited<ReturnType<typeof createOrg>>;
  beforeAll(async()=>{org=await createOrg();});

  it("refuses to sync or map before a successful read-only test",async()=>{
    await saveIntegrationConnection(admin,org.id,input);
    const spy=ghlFetch();
    await expect(syncGhlMetadata(admin,org.id)).rejects.toMatchObject({code:"integration_unavailable"});
    await expect(mapGhlAssets(admin,org.id,{pipelineId:PIPELINE})).rejects.toMatchObject({code:"integration_unavailable"});
    expect(spy).not.toHaveBeenCalled();
    expect((await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="ghl")?.status).toBe("credentials_saved");
  });
  it("syncs verified reference metadata, stamps it, audits it and uses only GET",async()=>{
    const spy=ghlFetch();
    expect((await testIntegrationConnection(admin,org.id,"ghl")).status).toBe("connected");
    const synced=await syncGhlMetadata(admin,org.id);
    expect(synced.status).toBe("connected");expect(synced.syncedAt).toBeTruthy();
    expect(spy.mock.calls.every(([,init])=>init?.method==="GET")).toBe(true);
    const view=(await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="ghl")!;
    expect(view.capabilities.metadataSyncedAt).toBe(synced.syncedAt);expect(JSON.stringify(view)).not.toContain(SECRET);
    const audit=await withSystem(db=>db.query("select 1 from audit_logs where org_id=$1 and action='integration.metadata_synced'",[org.id]));
    expect(audit.rows).toHaveLength(1);
  });
  it("does not report a sync when the location identity no longer matches",async()=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({location:{id:"anotherLocation1234"}}));
    const result=await syncGhlMetadata(admin,org.id);
    expect(result.status).toBe("error");expect(result.syncedAt).toBeNull();
    expect((await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="ghl")?.status).toBe("error");
    ghlFetch();await testIntegrationConnection(admin,org.id,"ghl");
  });
  it("maps only pipelines and calendars from the verified inventory, never writing to GoHighLevel",async()=>{
    const spy=ghlFetch();
    await expect(mapGhlAssets(admin,org.id,{pipelineId:"forgedPipeline99"})).rejects.toMatchObject({code:"invalid_input"});
    await expect(mapGhlAssets(admin,org.id,{calendarIds:["forgedCalendar99"]})).rejects.toMatchObject({code:"invalid_input"});
    await expect(mapGhlAssets(admin,org.id,{pipelineId:"../../etc"})).rejects.toThrow();
    await mapGhlAssets(admin,org.id,{pipelineId:PIPELINE,calendarIds:[CALENDAR]});
    expect(spy).not.toHaveBeenCalled();
    const {rows}=await withSystem(db=>db.query<{pipeline_id:string;calendar_ids:string[]}>("select pipeline_id,calendar_ids from ghl_location_mappings where org_id=$1",[org.id]));
    expect(rows[0]).toEqual({pipeline_id:PIPELINE,calendar_ids:[CALENDAR]});
    const view=(await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="ghl")!;
    expect(view.status).toBe("connected");expect(view.config).toMatchObject({pipelineId:PIPELINE,calendarIds:[CALENDAR]});
    await mapGhlAssets(admin,org.id,{calendarIds:[]});
    expect((await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="ghl")?.config.pipelineId).toBeUndefined();
  });
  it("is limited to agency super admins",async()=>{
    await withSystem(db=>db.query("insert into staff_assignments(org_id,user_id) values($1,$2) on conflict do nothing",[org.id,staff.id]));
    await expect(syncGhlMetadata(staff,org.id)).rejects.toMatchObject({code:"forbidden"});
    await expect(mapGhlAssets(staff,org.id,{pipelineId:PIPELINE})).rejects.toMatchObject({code:"forbidden"});
    await expect(syncGhlMetadata({...admin,id:owner.id},org.id)).rejects.toMatchObject({code:"forbidden"});
    await expect(syncGhlMetadata(admin,null)).rejects.toMatchObject({code:"invalid_input"});
  });
});

describe("agency workflow authorization and verification invalidation",()=>{
  // All HTTP is mocked; stored connection states here are synthetic portal evidence only.
  const BASE="http://127.0.0.1:9999";const IDS=["wf-audit-old","wf-audit-new"];
  const inventory=()=>Response.json({data:IDS.map(id=>({id,name:`Synthetic ${id}`,active:false}))});
  const fetchMock=()=>vi.spyOn(globalThis,"fetch").mockImplementation(async url=>String(url).includes("executions")?Response.json({data:[]}):inventory());
  const configure=()=>saveIntegrationConnection(admin,null,{provider:"n8n",label:"Synthetic audit n8n",environment:"development",secret:SECRET,config:{baseUrl:BASE,approvedWorkflowIds:IDS}});
  let org:Awaited<ReturnType<typeof createOrg>>;
  beforeAll(async()=>{org=await createOrg();await withSystem(db=>db.query("insert into staff_assignments(org_id,user_id) values($1,$2)",[org.id,staff.id]));});

  it("uses the active database role when returning global workflow metadata",async()=>{
    fetchMock();await configure();await testIntegrationConnection(admin,null,"n8n");
    expect((await listIntegrationManager(admin,org.id)).agencyWorkflows).toHaveLength(2);
    expect((await listIntegrationManager({...staff,platformRole:"agency_super_admin"},org.id)).agencyWorkflows).toEqual([]);
    await expect(listIntegrationManager({...staff,platformRole:"agency_super_admin"},null)).rejects.toMatchObject({code:"forbidden"});
  });

  it("clears client Connected health on global rotation, failure and disconnect",async()=>{
    fetchMock();await mapAgencyWorkflows(admin,org.id,[IDS[0]]);await testIntegrationConnection(admin,org.id,"n8n");
    expect((await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="n8n")?.status).toBe("connected");
    await configure();
    expect((await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="n8n")?.status).toBe("credentials_saved");
    expect((await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="n8n")?.lastSuccessAt).toBeNull();
    await testIntegrationConnection(admin,null,"n8n");await testIntegrationConnection(admin,org.id,"n8n");
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("synthetic unavailable"));
    await testIntegrationConnection(admin,null,"n8n");
    expect((await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="n8n")?.status).toBe("needs_attention");
    await disconnectIntegration(admin,null,"n8n");
    expect((await listIntegrationManager(admin,org.id)).connections.find(c=>c.provider==="n8n")?.status).toBe("disconnected");
  });

  it("does not certify newly mapped workflow IDs with an older in-flight result",async()=>{
    fetchMock();await configure();await testIntegrationConnection(admin,null,"n8n");await mapAgencyWorkflows(admin,org.id,[IDS[0]]);
    let release!:()=>void;let markStarted!:()=>void;
    const started=new Promise<void>(resolve=>{markStarted=resolve;});const pending=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      if(String(url).includes("executions"))return Response.json({data:[]});
      markStarted();await pending;return inventory();
    });
    const testing=testIntegrationConnection(admin,org.id,"n8n");
    await started;await mapAgencyWorkflows(admin,org.id,[IDS[1]]);release();
    await expect(testing).rejects.toMatchObject({code:"conflict"});
    const {rows}=await withSystem(db=>db.query<{workflow_id:string;status:string;last_verified_at:Date|null}>("select workflow_id,status,last_verified_at from automation_template_mappings where org_id=$1",[org.id]));
    expect(rows).toEqual([{workflow_id:IDS[1],status:"unverified",last_verified_at:null}]);
  });
});

describe("secrets never reach logs, audit records or stored diagnostics",()=>{
  // Mocked provider HTTP. Proves the portal's own persistence and logging paths; not hosted logs.
  it("keeps a reflected or leaked key out of console output and every table that stores diagnostics",async()=>{
    const org=await createOrg();
    const spies=(["log","info","warn","error","debug"] as const).map(m=>vi.spyOn(console,m).mockImplementation(()=>undefined));
    const location="syntheticLogLocat9";
    await saveIntegrationConnection(admin,org.id,{...ghlInput(),config:{locationId:location,scopes:["locations.readonly"]}});
    // 1) A network error whose message contains the credential.
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error(`upstream failed for Bearer ${SECRET}`));
    expect((await testIntegrationConnection(admin,org.id,"ghl")).status).toBe("error");
    // 2) An upstream that reflects the key in an error body.
    vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({message:`bad token ${SECRET}`}),{status:500}));
    expect((await testIntegrationConnection(admin,org.id,"ghl")).status).toBe("error");
    // 3) An upstream that reflects the key inside a successful, matching location response.
    vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({location:{id:location,name:`Echo ${SECRET}`},note:SECRET}));
    await testIntegrationConnection(admin,org.id,"ghl");
    await disconnectIntegration(admin,org.id,"ghl");

    const printed=spies.flatMap(s=>s.mock.calls).map(args=>args.map(a=>a instanceof Error?`${a.message} ${a.stack}`:typeof a==="string"?a:JSON.stringify(a)).join(" ")).join("\n");
    expect(printed).not.toContain(SECRET);

    const {rows}=await withSystem(db=>db.query<{blob:string}>(`select
      (select coalesce(string_agg(action||' '||metadata::text,' '),'') from audit_logs where org_id=$1)
      ||' '||(select coalesce(string_agg(k.detail||' '||k.capabilities::text,' '),'') from integration_connection_checks k join integration_connections c on c.id=k.connection_id where c.org_id=$1)
      ||' '||(select coalesce(string_agg(coalesce(last_error,'')||' '||config::text||' '||capabilities::text,' '),'') from integration_connections where org_id=$1)
      ||' '||(select coalesce(string_agg(label||' '||fingerprint||' '||scopes::text||' '||ciphertext,' '),'') from integration_credentials where org_id=$1)
      ||' '||(select coalesce(string_agg(label||' '||fingerprint||' '||scopes::text,' '),'') from credential_references where org_id=$1)
      ||' '||(select coalesce(string_agg(coalesce(detail,''),' '),'') from integration_status where org_id=$1) as blob`,[org.id]));
    expect(rows[0].blob.length).toBeGreaterThan(50); // the scan really covered stored records
    expect(rows[0].blob).not.toContain(SECRET);
    expect(rows[0].blob).toMatch(/credential\.(saved|revoked)/); // and the audit trail really exists
    expect(JSON.stringify(await listIntegrationManager(admin,org.id))).not.toContain(SECRET);
  });
});
