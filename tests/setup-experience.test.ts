import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { ensureInstanceStandalone } from "@/server/setup/core";
import { authorizedSetupRevision } from "@/server/setup/access";
import { setupEventStream } from "@/server/setup/hub";
import { attachSetupDocument, setupDocumentLink } from "@/server/setup/documents";
import { getClientSetupSnapshot, listClientSetupOverview } from "@/server/setup/snapshots";
import { removeTaskAttachment, setServices, createCustomTask, requestClientAction, updateTaskStatus } from "@/server/setup/agency";
import { submitClientResponse } from "@/server/setup/client";
import { attestTask, runAllChecks } from "@/server/setup/automation";
import { CONNECTORS } from "@/server/setup/connectors";
import { resetEnvCache } from "@/server/env";
import { setupDate, setupHttpsUrl } from "@/server/setup/validation";
import { listSetupTemplates, reorderTemplateTasks, updateTemplateTask } from "@/server/setup/templates";
import { agencyUser, addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

// Private-file fixtures use an isolated temporary directory, never the workspace's saved data.
const uploads = path.join(os.tmpdir(), `iacquire-setup-files-${crypto.randomUUID()}`);
const previousUploads = process.env.UPLOAD_DIR;
beforeAll(() => { process.env.UPLOAD_DIR = uploads; resetEnvCache(); });
afterAll(async () => {
  if (path.dirname(path.resolve(uploads)) !== path.resolve(os.tmpdir()) || !path.basename(uploads).startsWith("iacquire-setup-files-")) throw new Error("Unexpected test upload path");
  await fs.rm(uploads, { recursive: true, force: true });
  if (previousUploads === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = previousUploads;
  resetEnvCache();
});

async function fixture() {
  const org = await createOrg();
  const owner = await createUser({ name: "Client contact" });
  await addMember(org.id, owner.id, "owner");
  await ensureInstanceStandalone(org.id);
  const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from client_setup_tasks where org_id=$1 and template_key='website_built'", [org.id]));
  return { org, owner, admin, taskId: rows[0].id, ctx: ctxFor(owner, org, "owner") };
}

describe("optional scope and honest overview", () => {
  it("excludes optional custom websites and funnels until the agency selects them", async () => {
    const { org, ctx, admin } = await fixture();
    let snap = (await getClientSetupSnapshot(ctx))!;
    expect(snap.tasks.some((t) => /website|funnel/i.test(t.title))).toBe(false);
    await setServices(admin, org.id, ["crm", "funnel"]);
    snap = (await getClientSetupSnapshot(ctx))!;
    expect(snap.tasks.some((t) => /funnel/i.test(t.title))).toBe(true);
    expect(snap.tasks.some((t) => /custom website/i.test(t.title))).toBe(false);
  });

  it("returns the tenant's contact, registration, outstanding work and unconfigured workflow health", async () => {
    const { org, owner, admin } = await fixture();
    const row = (await listClientSetupOverview(admin)).find((r) => r.id === org.id)!;
    expect(row.contact).toEqual({ name: "Client contact", email: owner.email });
    expect(row.createdAt).toBeTruthy();
    expect(row.setup.outstanding).toBeGreaterThan(0);
    expect(row.health.n8n).toBeNull();
    expect(row.health.level).toBe("not_connected");
  });

  it("rejects forged or stale super-admin claims instead of listing unrelated clients", async () => {
    const {admin,owner}=await fixture();
    await expect(listClientSetupOverview({...admin,id:owner.id})).rejects.toThrow(/authorization/);
    await withSystem(db=>db.query("update users set platform_role='agency_staff' where id=$1",[admin.id]));
    await expect(listClientSetupOverview(admin)).rejects.toThrow(/authorization/);
    await withSystem(db=>db.query("update users set status='disabled' where id=$1",[admin.id]));
    await expect(listClientSetupOverview({...admin,platformRole:"agency_staff"})).rejects.toThrow(/authorization/);
  });
});

describe("current authorization and verification snapshots", () => {
  it("rejects a cached owner response after demotion without changing the request or recording a reply", async () => {
    const {org,admin,owner,ctx}=await fixture();
    const task=await createCustomTask(admin,org.id,{title:"Confirm the project contact"});
    await requestClientAction(admin,org.id,task.result.taskId,{type:"provide_info",label:"Confirm your contact",instructions:"Tell us the name of your project contact."});
    await withSystem(db=>db.query("update organization_memberships set role='member' where org_id=$1 and user_id=$2",[org.id,owner.id]));
    expect((await getClientSetupSnapshot(ctx))!.canRespond).toBe(false);
    await expect(submitClientResponse(ctx,task.result.taskId,{message:"A changed contact"})).rejects.toThrow(/current workspace owners/);
    const saved=await withSystem(db=>db.query("select status,client_response from client_setup_tasks where id=$1",[task.result.taskId]));
    expect(saved.rows[0]).toMatchObject({status:"waiting_for_client",client_response:null});
    const events=await withSystem(db=>db.query("select 1 from client_setup_task_events where task_id=$1 and event='client_responded'",[task.result.taskId]));
    expect(events.rows).toHaveLength(0);
  });

  it("does not persist verification results when agency access is revoked while a connector is running", async () => {
    const {org,admin}=await fixture();
    const original=CONNECTORS.onboarding.evaluate;
    CONNECTORS.onboarding.evaluate=async()=>{
      await withSystem(db=>db.query("update users set platform_role='none' where id=$1",[admin.id]));
      return {status:"verified",detail:"Injected connector result after role revocation."};
    };
    try {
      await expect(runAllChecks(admin,org.id)).rejects.toThrow(/authorization/);
      const checks=await withSystem(db=>db.query("select 1 from client_setup_checks where org_id=$1",[org.id]));
      expect(checks.rows).toHaveLength(0);
    } finally { CONNECTORS.onboarding.evaluate=original; }
  });

  it("rejects stale verification when another setup edit commits during the check", async () => {
    const {org,admin}=await fixture();
    const custom=await createCustomTask(admin,org.id,{title:"Prepare the launch notes"});
    const original=CONNECTORS.onboarding.evaluate;
    CONNECTORS.onboarding.evaluate=async()=>{
      await updateTaskStatus(admin,org.id,custom.result.taskId,{status:"in_progress"});
      return {status:"verified",detail:"Injected connector result for the previous revision."};
    };
    try {
      await expect(runAllChecks(admin,org.id)).rejects.toThrow(/changed while verification/);
      const checks=await withSystem(db=>db.query("select 1 from client_setup_checks where org_id=$1",[org.id]));
      expect(checks.rows).toHaveLength(0);
    } finally { CONNECTORS.onboarding.evaluate=original; }
  });

  it("withdraws obsolete successes for unsupported checks during live verification and preserves their previous evidence", async () => {
    const {org,admin}=await fixture();
    await setServices(admin,org.id,["website"]);
    await withSystem(db=>db.query("insert into client_setup_checks (org_id,check_key,status,source,detail,checked_at) values ($1,'website_live','verified','connector','Historical provider success',now())",[org.id]));
    const result=await runAllChecks(admin,org.id);
    expect(result.ran.find(c=>c.key==="website_live")).toMatchObject({status:"unverified"});
    const checks=await withSystem(db=>db.query("select status from client_setup_checks where org_id=$1 and check_key='website_live'",[org.id]));
    expect(checks.rows[0].status).toBe("unverified");
    const event=await withSystem(db=>db.query<{metadata:{previous:{website_live:{status:string;detail:string}}}}>("select metadata from client_setup_task_events where org_id=$1 and event='check_run' order by id desc limit 1",[org.id]));
    expect(event.rows[0].metadata.previous.website_live).toEqual({status:"verified",detail:"Historical provider success"});
  });

  it("cannot replace a failed check with agency evidence or accept secret-bearing evidence URLs", async () => {
    const {org,admin}=await fixture();
    await setServices(admin,org.id,["email"]);
    const task=await withSystem(db=>db.query<{id:string}>("select id from client_setup_tasks where org_id=$1 and template_key='email_domain'",[org.id]));
    await withSystem(db=>db.query("insert into client_setup_checks (org_id,check_key,status,source,detail) values ($1,'email_domain','failed','connector','Saved provider failure')",[org.id]));
    await expect(attestTask(admin,org.id,task.rows[0].id,{note:"Reviewed the provider settings in the console."})).rejects.toThrow(/failed provider check/);
    await expect(attestTask(admin,org.id,task.rows[0].id,{note:"Reviewed the provider settings in the console.",evidenceUrl:"https://example.test/proof?access_token=secret"})).rejects.toThrow();
    const check=await withSystem(db=>db.query("select status,detail from client_setup_checks where org_id=$1 and check_key='email_domain'",[org.id]));
    expect(check.rows[0]).toEqual({status:"failed",detail:"Saved provider failure"});
  });
});

describe("private setup documents", () => {
  it("persists client-visible private evidence and blocks other tenants, internal files and revoked access", async () => {
    const { org, owner, admin, taskId, ctx } = await fixture();
    const outsider = await createUser();
    const other = await createOrg();
    await addMember(other.id, outsider.id, "owner");
    const shared = await attachSetupDocument(admin, org.id, taskId, { file: new File(["approved project brief"], "brief.txt", { type: "text/plain" }), label: "Approved brief", visibility: "client" });
    const attachmentId = shared.result.attachmentId;
    expect((await getClientSetupSnapshot(ctx))!.tasks.some((t) => t.attachments.some((a) => a.id === attachmentId && a.url === `/api/setup/attachments/${attachmentId}`))).toBe(false); // optional website excluded
    await setServices(admin, org.id, ["website"]);
    expect((await getClientSetupSnapshot(ctx))!.tasks.find((t) => t.id === taskId)!.attachments[0].url).toBe(`/api/setup/attachments/${attachmentId}`);
    expect(await setupDocumentLink(owner.id, attachmentId)).toMatch(/^\/api\/files\//);
    await expect(setupDocumentLink(outsider.id, attachmentId)).rejects.toThrow(/not found/i);
    const internal = await attachSetupDocument(admin, org.id, taskId, { file: new File(["internal agency notes"], "internal.txt", { type: "text/plain" }), label: "Agency notes", visibility: "internal" });
    await expect(setupDocumentLink(owner.id, internal.result.attachmentId)).rejects.toThrow(/not found/i);
    await withSystem((db) => db.query("update organization_memberships set status='revoked' where user_id=$1 and org_id=$2", [owner.id, org.id]));
    await expect(setupDocumentLink(owner.id, attachmentId)).rejects.toThrow(/not found/i);
    await removeTaskAttachment(admin, org.id, attachmentId);
    await expect(setupDocumentLink(admin.id, attachmentId)).rejects.toThrow(/not found/i);
    await removeTaskAttachment(admin, org.id, internal.result.attachmentId);
  });

  it("rejects non-agency uploads and mismatched file contents before persisting an attachment", async () => {
    const { org, owner, admin, taskId } = await fixture();
    await expect(attachSetupDocument({ ...admin, id: owner.id }, org.id, taskId, { file: new File(["text"], "file.txt", { type: "text/plain" }), label: "File", visibility: "client" })).rejects.toThrow(/authorization|agency/i);
    await expect(attachSetupDocument(admin, org.id, taskId, { file: new File(["not a pdf"], "file.pdf", { type: "application/pdf" }), label: "File", visibility: "client" })).rejects.toThrow(/contents matching/i);
  });
});

describe("stream permission refresh", () => {
  it("checks current membership and agency assignment rather than cached role claims", async () => {
    const { org, owner } = await fixture();
    expect(await authorizedSetupRevision(owner.id, org.id, false)).toBeGreaterThan(0);
    await expect(authorizedSetupRevision(owner.id, org.id, true)).rejects.toThrow(/access.*changed/i);
    await withSystem((db) => db.query("update organization_memberships set status='revoked' where org_id=$1 and user_id=$2", [org.id, owner.id]));
    await expect(authorizedSetupRevision(owner.id, org.id, false)).rejects.toThrow(/access.*changed/i);
  });

  it("closes an existing stream on permission revocation instead of publishing later revisions", async () => {
    let allowed = true;
    const stream = setupEventStream({ orgId: "revocation", pollMs: 20, getRevision: async () => { if (!allowed) throw new AppError("forbidden", "Access changed"); return 4; } });
    const reader = stream.getReader();
    let text = "";
    while (!text.includes("event: ready")) text += new TextDecoder().decode((await reader.read()).value);
    allowed = false;
    const revoked = new TextDecoder().decode((await reader.read()).value);
    expect(revoked).toContain("event: access_changed");
    expect(await reader.read()).toMatchObject({ done: true });
  });
});

describe("setup form validation", () => {
  it("rejects impossible dates, embedded passwords and token links", () => {
    expect(setupDate.safeParse("2026-02-30").success).toBe(false);
    expect(setupDate.safeParse("2028-02-29").success).toBe(true);
    expect(setupHttpsUrl.safeParse("https://user:password@example.test/review").success).toBe(false);
    expect(setupHttpsUrl.safeParse("https://example.test/review?access_token=private").success).toBe(false);
    expect(setupHttpsUrl.safeParse("https://example.test/review?id=123").success).toBe(true);
    expect(setupHttpsUrl.safeParse("not a URL").success).toBe(false);
  });
});

describe("configurable master setup templates", () => {
  it("persists edits and order for new checklists while preserving existing client work", async () => {
    const { admin, ctx, taskId } = await fixture();
    const template = (await listSetupTemplates(admin))[0];
    const task = template.tasks.find((t) => t.key === "website_built")!;
    const data = { title: task.title,clientTitle: task.clientTitle ?? "",description: task.description,required: task.required,requiresEvidence: task.requiresEvidence,requiresClientResponse: task.requiresClientResponse,dependsOn: task.dependsOn,clientAction: task.clientAction };
    try {
      await updateTemplateTask(admin, task.id, { ...data, clientTitle: "Your custom company website", description: "A website tailored to your company package." });
      const next = await fixture();
      await setServices(admin, next.org.id, ["website"]);
      expect((await getClientSetupSnapshot(next.ctx))!.tasks.find((t) => t.id === next.taskId)!.title).toBe("Your custom company website");
      await setServices(admin, ctx.org.orgId, ["website"]);
      expect((await getClientSetupSnapshot(ctx))!.tasks.find((t) => t.id === taskId)!.title).toBe(data.clientTitle);
      const ids = template.tasks.map((t) => t.id).reverse();
      await reorderTemplateTasks(admin, template.id, ids);
      expect((await listSetupTemplates(admin))[0].tasks.map((t) => t.id)).toEqual(ids);
      const outsider = await createUser();
      await expect(updateTemplateTask({ ...admin,id: outsider.id },task.id,data)).rejects.toThrow(/authorized super admins/i);
      await expect(updateTemplateTask(admin,task.id,{...data,dependsOn:["final_review"]})).rejects.toThrow(/loop/i);
      await reorderTemplateTasks(admin,template.id,template.tasks.map((t) => t.id));
    } finally { await updateTemplateTask(admin,task.id,data); }
  });
});
