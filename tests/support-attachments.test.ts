import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { postClientMessage, submitRequest } from "@/server/support/service";
import { agencyPostMessage, assignRequest } from "@/server/support/agency";
import * as attachments from "@/server/support/attachments";
import { listSupportAttachments, stageSupportFile, supportAttachmentDownload } from "@/server/support/attachments";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { resetRateLimits, supportWorld, type SupportWorld } from "./support/support-world";

let uploads: string;
let w: SupportWorld;
beforeAll(async () => {
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), "iacquire-support-attachments-"));
  vi.stubEnv("UPLOAD_DIR", uploads);
  resetEnvCache();
  w = await supportWorld();
});
beforeEach(resetRateLimits);
afterAll(async () => {
  if (uploads && path.dirname(path.resolve(uploads)) === path.resolve(os.tmpdir()) && path.basename(uploads).startsWith("iacquire-support-attachments-")) {
    await fs.rm(uploads, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  resetEnvCache();
});

const deny = (userId: string, permission: string) => updateAgencyUserPermission(w.agency.superAdmin, { userId, permission: permission as never, effect: "deny" });
const clearOverrides = (userId: string) => withSystem((db) => db.query("delete from agency_user_permission_overrides where user_id = $1", [userId]));
const open = async (subject: string) => (await submitRequest(w.ctx.member, { subject, message: "Please review the connection status." })).id;
/** A file the person chose, then sent in a reply: the only way a file reaches a request now. */
const clientFile = async (ticketId: string, name = "details.txt") => {
  const staged = await stageSupportFile(w.people.member.id, w.org.id, { name, bytes: Buffer.from("Calendar details") });
  await postClientMessage(w.ctx.member, ticketId, { body: `Attached ${name}.`, attachmentIds: [staged.id] });
  return staged;
};
const internalFile = async (ticketId: string, name = "agency.txt") => {
  const staged = await stageSupportFile(w.raw.staff.id, w.org.id, { name, bytes: Buffer.from("Agency diagnostics") }, { internal: true });
  await agencyPostMessage(w.agency.staff, ticketId, { body: `Internal ${name}.`, internal: true, attachmentIds: [staged.id] });
  return staged;
};

describe("private support attachments — local PostgreSQL", () => {
  it("persists authorized files while rejecting foreign tenants and hidden agency files", async () => {
    const id = await open("Calendar connection");
    const attachment = await clientFile(id);
    expect((await listSupportAttachments(w.people.member.id, id)).map((a) => a.id)).toEqual([attachment.id]);
    expect(await supportAttachmentDownload(w.people.member.id, attachment.id)).toMatch(/^\/api\/files\//);
    expect(await listSupportAttachments(w.people.outsider.id, id)).toEqual([]);
    await expect(supportAttachmentDownload(w.people.outsider.id, attachment.id)).rejects.toThrow(/not found/);
    // Another workspace's member cannot stage a file into this workspace, and a client cannot stage an agency-only file.
    await expect(stageSupportFile(w.people.outsider.id, w.org.id, { name: "attack.txt", bytes: Buffer.from("attack") })).rejects.toThrow();
    await expect(stageSupportFile(w.people.member.id, w.org.id, { name: "private.txt", bytes: Buffer.from("private") }, { internal: true })).rejects.toThrow(/agency/);
    // Agency staff outside the client's scope cannot stage one either; staff assigned to the client can.
    await expect(stageSupportFile(w.raw.outStaff.id, w.org.id, { name: "staff.txt", bytes: Buffer.from("private") }, { internal: true })).rejects.toThrow(/agency/);
    const internal = await internalFile(id);
    expect((await listSupportAttachments(w.raw.staff.id, id))).toHaveLength(2);
    expect((await listSupportAttachments(w.people.member.id, id))).toHaveLength(1);
    await expect(supportAttachmentDownload(w.people.member.id, internal.id)).rejects.toThrow(/not found/);
    await expect(supportAttachmentDownload(w.people.owner.id, internal.id)).rejects.toThrow(/not found/);
    expect(await supportAttachmentDownload(w.raw.staff.id, internal.id)).toMatch(/^\/api\/files\//);
    try {
      await deny(w.raw.staff.id, "agency.support.view");
      const readAccess = await withUser(w.raw.staff.id, (db) => db.query<{ allowed: boolean }>("select app.file_permission($1,'support-attachments',false,'internal') as allowed", [w.org.id]));
      expect(readAccess.rows[0]?.allowed).toBe(false);
      await expect(supportAttachmentDownload(w.raw.staff.id, internal.id)).rejects.toThrow(/not found/);
      await clearOverrides(w.raw.staff.id);
      await deny(w.raw.staff.id, "agency.support.manage");
      const writeAccess = await withUser(w.raw.staff.id, (db) => db.query<{ allowed: boolean }>("select app.file_permission($1,'support-attachments',true,'internal') as allowed", [w.org.id]));
      expect(writeAccess.rows[0]?.allowed).toBe(false);
      await expect(stageSupportFile(w.raw.staff.id, w.org.id, { name: "blocked.txt", bytes: Buffer.from("No write access") }, { internal: true })).rejects.toThrow(/access to this file/);
    } finally {
      await clearOverrides(w.raw.staff.id);
    }
  });

  it("rejects malformed content and unsupported files", async () => {
    await expect(stageSupportFile(w.people.member.id, w.org.id, { name: "fake.png", bytes: Buffer.from("fake") })).rejects.toThrow(/contents/);
    await expect(stageSupportFile(w.people.member.id, w.org.id, { name: "script.exe", bytes: Buffer.from("MZ") })).rejects.toThrow(/Choose/);
  });
});

describe("a team member opens a file only where they could open the request", () => {
  it("is refused for a request outside the queue the person is limited to, and allowed for their own", async () => {
    const mine = await open("Assigned to Stan");
    const other = await open("Assigned to nobody");
    const mineFile = await clientFile(mine, "mine.txt");
    const otherFile = await clientFile(other, "other.txt");
    await assignRequest(w.agency.superAdmin, mine, w.raw.staff.id);
    // With the full queue Stan can open both.
    expect(await supportAttachmentDownload(w.raw.staff.id, otherFile.id)).toMatch(/^\/api\/files\//);
    try {
      await deny(w.raw.staff.id, "agency.support.queue");
      // Row-level security alone lets an assigned team member open any file of an in-scope client; the request-level rule narrows it to the requests assigned to them.
      await expect(supportAttachmentDownload(w.raw.staff.id, otherFile.id)).rejects.toThrow(/not found/i);
      expect(await supportAttachmentDownload(w.raw.staff.id, mineFile.id)).toMatch(/^\/api\/files\//);
      // Still not the client's other staff, nor staff of another client.
      await expect(supportAttachmentDownload(w.raw.outStaff.id, mineFile.id)).rejects.toThrow(/not found/i);
    } finally {
      await clearOverrides(w.raw.staff.id);
    }
  });

  it("is refused when the person's support view was withdrawn, even for a file they uploaded to a request they still hold", async () => {
    const id = await open("Withdrawn view");
    const file = await clientFile(id, "view.txt");
    await assignRequest(w.agency.superAdmin, id, w.raw.staff2.id);
    expect(await supportAttachmentDownload(w.raw.staff2.id, file.id)).toMatch(/^\/api\/files\//);
    try {
      await deny(w.raw.staff2.id, "agency.support.view");
      await expect(supportAttachmentDownload(w.raw.staff2.id, file.id)).rejects.toThrow(/not found/i);
    } finally {
      await clearOverrides(w.raw.staff2.id);
    }
  });

  it("keeps a client's own access exactly as it was", async () => {
    const id = await open("Client access");
    const file = await clientFile(id, "client.txt");
    expect(await supportAttachmentDownload(w.people.member.id, file.id)).toMatch(/^\/api\/files\//);
    expect(await supportAttachmentDownload(w.people.owner.id, file.id)).toMatch(/^\/api\/files\//);
    await expect(supportAttachmentDownload(w.people.member2.id, file.id)).rejects.toThrow(/not found/i);
    await expect(supportAttachmentDownload(w.people.outsider.id, file.id)).rejects.toThrow(/not found/i);
  });
});

describe("the direct upload route is gone", () => {
  it("has no route and no function that attaches a file straight to a request without a message", () => {
    // It authorized by row visibility alone and nothing in the interface called it; every file now arrives staged and is bound by the message that carries it.
    expect(existsSync(path.join("src", "app", "api", "support", "[ticketId]", "attachments", "route.ts"))).toBe(false);
    expect("attachSupportFile" in attachments).toBe(false);
  });
});
