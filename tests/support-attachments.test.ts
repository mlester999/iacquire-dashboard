import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { addMember,createOrg,createUser,ctxFor } from "./support/fixtures";
import { withSystem } from "@/server/db";
import { createTicket } from "@/server/support/service";
import { attachSupportFile,listSupportAttachments,supportAttachmentDownload } from "@/server/support/attachments";

let uploads:string;
beforeAll(async()=>{
  uploads=await fs.mkdtemp(path.join(os.tmpdir(),"iacquire-support-attachments-"));
  vi.stubEnv("UPLOAD_DIR",uploads);resetEnvCache();
});
afterAll(async()=>{
  if(uploads && path.dirname(path.resolve(uploads))===path.resolve(os.tmpdir()) && path.basename(uploads).startsWith("iacquire-support-attachments-")) {
    await fs.rm(uploads,{recursive:true,force:true});
  }
  vi.unstubAllEnvs();resetEnvCache();
});

describe("private support attachments — local PostgreSQL",()=>{
  it("persists authorized files while rejecting foreign tenants and hidden agency files",async()=>{
    const org=await createOrg();const owner=await createUser();const otherOrg=await createOrg();const other=await createUser();
    await addMember(org.id,owner.id,"owner");await addMember(otherOrg.id,other.id,"owner");
    const ticket=await createTicket(ctxFor(owner,org,"owner"),{subject:"Calendar connection",message:"Please review the connection status."});
    const attachment=await attachSupportFile(owner.id,ticket.id,{name:"details.txt",bytes:Buffer.from("Calendar details")});
    expect((await listSupportAttachments(owner.id,ticket.id)).map((a)=>a.id)).toEqual([attachment.id]);
    expect(await supportAttachmentDownload(owner.id,attachment.id)).toMatch(/^\/api\/files\//);
    expect(await listSupportAttachments(other.id,ticket.id)).toEqual([]);
    await expect(supportAttachmentDownload(other.id,attachment.id)).rejects.toThrow(/not found/);
    await expect(attachSupportFile(other.id,ticket.id,{name:"attack.txt",bytes:Buffer.from("attack")})).rejects.toThrow(/not found/);
    await expect(attachSupportFile(owner.id,ticket.id,{name:"private.txt",bytes:Buffer.from("private")},true)).rejects.toThrow(/agency/);
    const staff=await createUser({platformRole:"agency_staff"});
    await expect(attachSupportFile(staff.id,ticket.id,{name:"staff.txt",bytes:Buffer.from("private")},true)).rejects.toThrow(/not found/);
    await withSystem((db)=>db.query("insert into staff_assignments(org_id,user_id) values($1,$2)",[org.id,staff.id]));
    const internal=await attachSupportFile(staff.id,ticket.id,{name:"agency.txt",bytes:Buffer.from("Agency diagnostics")},true);
    expect((await listSupportAttachments(staff.id,ticket.id))).toHaveLength(2);
    expect((await listSupportAttachments(owner.id,ticket.id))).toHaveLength(1);
    await expect(supportAttachmentDownload(owner.id,internal.id)).rejects.toThrow(/not found/);
    expect(await supportAttachmentDownload(staff.id,internal.id)).toMatch(/^\/api\/files\//);
    await withSystem((db)=>db.query("update support_tickets set status='closed' where id=$1",[ticket.id]));
    await expect(attachSupportFile(owner.id,ticket.id,{name:"late.txt",bytes:Buffer.from("late")})).rejects.toThrow(/closed/);
  });
  it("rejects malformed content and unsupported files",async()=>{
    const org=await createOrg();const owner=await createUser();await addMember(org.id,owner.id,"owner");
    const ticket=await createTicket(ctxFor(owner,org,"owner"),{subject:"Document question",message:"Please review this attachment."});
    await expect(attachSupportFile(owner.id,ticket.id,{name:"fake.png",bytes:Buffer.from("fake")})).rejects.toThrow(/contents/);
    await expect(attachSupportFile(owner.id,ticket.id,{name:"script.exe",bytes:Buffer.from("MZ")})).rejects.toThrow(/Choose/);
  });
});
