// Synthetic database fixtures and intercepted HTTP only. Never contacts GoHighLevel.
import {afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import {saveIntegrationConnection} from "@/server/integrations/manager";
import {syncGhl,verifyGhlConnection} from "@/server/integrations/ghl";
import {withSystem} from "@/server/db";
import {createOrg,createUser,agencyUser} from "./support/fixtures";

describe("GoHighLevel read-through response isolation",()=>{
  const LOCATION="syntheticCacheLoc123";const PIPELINE="pipelineCache1234";const CALENDAR="calendarCache1234";
  let org:Awaited<ReturnType<typeof createOrg>>;let admin:ReturnType<typeof agencyUser>;
  beforeAll(async()=>{
    org=await createOrg();admin=agencyUser(await createUser({platformRole:"agency_super_admin"}),"agency_super_admin");
    await saveIntegrationConnection(admin,org.id,{provider:"ghl",label:"Synthetic CRM cache",environment:"development",secret:"synthetic-key-"+"k".repeat(30),config:{locationId:LOCATION,pipelineId:PIPELINE,calendarIds:[CALENDAR],scopes:["locations.readonly","opportunities.readonly","calendars.readonly"]}});
  });
  afterEach(()=>vi.restoreAllMocks());
  function mockResponse(change:(path:string,body:Record<string,unknown>)=>Record<string,unknown>) {
    return vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      const u=new URL(String(url));
      const body=u.pathname.startsWith("/locations/")?{location:{id:LOCATION}}:u.pathname==="/opportunities/pipelines"?{pipelines:[{id:PIPELINE,name:"Synthetic pipeline",locationId:LOCATION,stages:[]}]}:u.pathname==="/opportunities/search"?{opportunities:[{id:"opportunityCache1",name:"Synthetic opportunity",pipelineId:PIPELINE,locationId:LOCATION}]}:{events:[{id:"eventCache1234",calendarId:CALENDAR,locationId:LOCATION,startTime:"2026-10-14T01:00:00Z",endTime:"2026-10-14T01:30:00Z"}]};
      return Response.json(change(u.pathname,body));
    });
  }

  it("refuses malformed pipeline responses rather than reporting zero verified pipelines",async()=>{
    mockResponse((path,body)=>path==="/opportunities/pipelines"?{}:body);
    expect(await verifyGhlConnection(org.id,admin.id,{skipSetupSync:true})).toMatchObject({ok:false,detail:"GoHighLevel returned an unsupported response."});
  });

  it.each(["pipeline","opportunity","calendar","mapped-pipeline"])("rejects mismatched %s metadata before any cache write",async kind=>{
    mockResponse((path,body)=>{
      if(kind==="pipeline" && path==="/opportunities/pipelines")return {pipelines:[{id:PIPELINE,name:"Other location",locationId:"otherLocation1234"}]};
      if(kind==="opportunity" && path==="/opportunities/search")return {opportunities:[{id:"forgedOpportunity",pipelineId:PIPELINE,location_id:"otherLocation1234"}]};
      if(kind==="calendar" && path==="/calendars/events")return {events:[{id:"forgedEvent1234",calendarId:"otherCalendar1234"}]};
      if(kind==="mapped-pipeline" && path==="/opportunities/search")return {opportunities:[{id:"forgedOpportunity",pipelineId:"otherPipeline1234",locationId:LOCATION}]};
      return body;
    });
    expect((await syncGhl(org.id,admin.id)).ok).toBe(false);
    const {rows}=await withSystem(db=>db.query<{count:number}>("select (select count(*) from crm_pipelines where org_id=$1)::int+(select count(*) from crm_opportunities where org_id=$1)::int+(select count(*) from appointment_refs where org_id=$1)::int as count",[org.id]));
    expect(rows[0].count).toBe(0);
  });

  it("persists scoped read-only metadata after identity verification",async()=>{
    const spy=mockResponse((_path,body)=>body);
    expect(await syncGhl(org.id,admin.id)).toMatchObject({ok:true,pipelines:1,opportunities:1,appointments:1});
    expect(spy.mock.calls.every(([,init])=>!init?.method || init.method==="GET")).toBe(true);
    const opportunities=spy.mock.calls.find(([url])=>String(url).includes("/opportunities/search"));
    expect(new URL(String(opportunities![0])).searchParams.get("location_id")).toBe(LOCATION);
    expect(spy.mock.calls.every(([url])=>new URL(String(url)).origin==="https://services.leadconnectorhq.com")).toBe(true);
  });
});
