import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { getRequestDetail, postClientMessage, submitRequest } from "@/server/support/service";
import { agencyPostMessage, changeRequestStatus, getAgencyRequest } from "@/server/support/agency";
import { loadSupportSettings, updateSupportSettings, type SupportSettingsPatch } from "@/server/support/settings";
import { attachSupportFile, cleanupStagedUploads, discardStagedFile, listSupportAttachments, purgeRetainedAttachments, stageSupportFile, supportAttachmentDownload } from "@/server/support/attachments";
import { countRows, resetRateLimits, supportWorld, ticketRow, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
let uploads: string;

beforeAll(async () => {
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), "iacquire-support-files-"));
  vi.stubEnv("UPLOAD_DIR", uploads);
  resetEnvCache();
  w = await supportWorld();
});
beforeEach(resetRateLimits);
afterAll(async () => {
  if (path.dirname(path.resolve(uploads)) === path.resolve(os.tmpdir()) && path.basename(uploads).startsWith("iacquire-support-files-")) await fs.rm(uploads, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetEnvCache();
});

const png = (extra = 64) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(extra, 1)]);
const jpeg = () => Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.alloc(32, 2)]);
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);
const docx = () => Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.alloc(40, 3)]);
const pdf = () => Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const stage = (name: string, bytes: Buffer, who = w.people.member, ctx = w.ctx.member) => stageSupportFile(who.id, ctx.org.orgId, { name, bytes });
const configure = async (patch: SupportSettingsPatch) => updateSupportSettings(w.agency.superAdmin, patch, (await loadSupportSettings()).revision);
const attachmentRow = async (id: string) => withSystem(async (db) => (await db.query<{ status: string; ticket_id: string | null; message_id: string | null; visibility: string; storage_key: string; file_status: string }>(
  "select a.status, a.ticket_id, a.message_id, a.visibility, f.storage_key, f.status as file_status from support_attachments a join private_files f on f.id = a.private_file_id where a.id = $1", [id],
)).rows[0]);
const exists = (storageKey: string) => fs.stat(path.join(uploads, "support-attachments", storageKey)).then(() => true, () => false);

describe("attaching files to a request", () => {
  it("saves a file privately, attaches it to the message that carries it and lets the right people open it", async () => {
    const staged = await stage("screenshot.png", png());
    expect(await attachmentRow(staged.id)).toMatchObject({ status: "staged", ticket_id: null, message_id: null, visibility: "client", file_status: "ready" });
    const r = await submitRequest(w.ctx.member, { subject: "Screenshot attached", message: "See the screenshot please.", attachmentIds: [staged.id] });
    expect(await attachmentRow(staged.id)).toMatchObject({ status: "attached", ticket_id: r.id });
    const detail = await getRequestDetail(w.ctx.member, r.id);
    expect(detail!.messages[0].attachments).toEqual([{ id: staged.id, filename: "screenshot.png", mimeType: "image/png", sizeBytes: 72, visibility: "client" }]);
    // The opener, the workspace owner/manager and the team can open it; another team member and another client cannot.
    for (const who of [w.people.member, w.people.owner, w.people.admin, w.raw.staff, w.raw.superAdmin]) expect(await supportAttachmentDownload(who.id, staged.id), who.id).toMatch(/^\/api\/files\//);
    for (const who of [w.people.member2, w.people.viewer, w.people.outsider, w.raw.outStaff]) await expect(supportAttachmentDownload(who.id, staged.id), who.id).rejects.toThrow(/not found/i);
    expect(await listSupportAttachments(w.people.member2.id, r.id)).toEqual([]);
    expect((await listSupportAttachments(w.people.owner.id, r.id)).map((a) => a.id)).toEqual([staged.id]);
  });

  it("accepts business files and refuses everything else, checking the real contents", async () => {
    for (const [name, bytes] of [["photo.jpg", jpeg()], ["photo.webp", webp()], ["contract.docx", docx()], ["terms.pdf", pdf()], ["notes.txt", Buffer.from("plain notes")], ["leads.csv", Buffer.from("name,email\nA,a@example.com\n")]] as const) {
      await expect(stage(name, bytes), name).resolves.toMatchObject({ filename: name });
    }
    await expect(stage("fake.png", Buffer.from("this is not a png"))).rejects.toThrow(/contents/i);
    await expect(stage("fake.pdf", Buffer.from("MZ executable"))).rejects.toThrow(/contents/i);
    await expect(stage("binary.txt", Buffer.from([65, 0, 66, 0]))).rejects.toThrow(/contents/i);
    for (const bad of ["run.exe", "page.html", "image.svg", "macro.docm", "bundle.zip", "script.js", "noextension"]) await expect(stage(bad, Buffer.from("x")), bad).rejects.toThrow(/Choose a/i);
    await expect(stage("empty.png", Buffer.alloc(0))).rejects.toThrow(/empty/i);
  });

  it("enforces the size limit the Super Admin configured", async () => {
    await configure({ maxAttachmentMb: 1 });
    try {
      await expect(stage("big.png", png(1.5 * 1024 * 1024))).rejects.toThrow(/up to 1 MB/);
      await expect(stage("small.png", png(1000))).resolves.toBeTruthy();
    } finally {
      await configure({ maxAttachmentMb: 10 });
    }
  });

  it("keeps an unsent file private to the person who chose it", async () => {
    const staged = await stage("private.png", png());
    await expect(supportAttachmentDownload(w.people.member.id, staged.id)).resolves.toMatch(/^\/api\/files\//);
    // Even a workspace owner and the team cannot see a file nobody has sent.
    for (const who of [w.people.owner, w.people.member2, w.raw.superAdmin, w.raw.staff]) await expect(supportAttachmentDownload(who.id, staged.id), who.id).rejects.toThrow(/not found/i);
    const seen = await withUser(w.people.owner.id, (db) => db.query("select id from support_attachments where id = $1", [staged.id]));
    expect(seen.rows).toEqual([]);
  });

  it("refuses to attach somebody else's file, another workspace's file, a used file, an expired file or too many files", async () => {
    const others = await stage("theirs.png", png(), w.people.member2, w.ctx.member2);
    const foreign = await stageSupportFile(w.people.outsider.id, w.otherOrg.id, { name: "foreign.png", bytes: png() });
    const used = await stage("used.png", png());
    await submitRequest(w.ctx.member, { subject: "Using this file", message: "First use of the file.", attachmentIds: [used.id] });
    const expired = await stage("expired.png", png());
    await withSystem((db) => db.query("update support_attachments set expires_at = now() - interval '1 minute' where id = $1", [expired.id]));
    for (const [label, id] of [["someone else's", others.id], ["another workspace's", foreign.id], ["already used", used.id], ["expired", expired.id]] as const) {
      await expect(submitRequest(w.ctx.member, { subject: `Refuse ${label}`, message: "This must not attach.", attachmentIds: [id] }), label).rejects.toThrow(/no longer available/);
    }
    // A refused request creates nothing, and the files that were fine stay where they were.
    expect(await countRows("select 1 from support_tickets where subject like 'Refuse %'")).toBe(0);
    expect((await attachmentRow(others.id)).status).toBe("staged");
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => stage(`file${n}.png`, png(n))));
    await expect(submitRequest(w.ctx.member, { subject: "Too many files", message: "Six files is too many.", attachmentIds: six.map((s) => s.id) })).rejects.toThrow(/up to 5 files/);
  });

  it("does not let a client stage an agency-only file", async () => {
    await expect(stageSupportFile(w.people.member.id, w.org.id, { name: "x.png", bytes: png() }, { internal: true })).rejects.toThrow(/agency/i);
  });

  it("lets the person take back a file they decided not to send, and nobody else", async () => {
    const a = await stage("take-back.png", png());
    await expect(discardStagedFile(w.people.member2.id, a.id)).rejects.toThrow(/not found/i);
    await discardStagedFile(w.people.member.id, a.id);
    expect(await attachmentRow(a.id)).toMatchObject({ status: "removed", file_status: "deleted" });
    await expect(supportAttachmentDownload(w.people.member.id, a.id)).rejects.toThrow(/not found/i);
    const sent = await stage("sent.png", png());
    await submitRequest(w.ctx.member, { subject: "Sent before discarding", message: "Already part of a request.", attachmentIds: [sent.id] });
    await expect(discardStagedFile(w.people.member.id, sent.id)).rejects.toThrow(/not found/i);
  });

  it("removes files nobody sent once their hold has expired, and leaves the rest alone", async () => {
    const stale = await stage("stale.png", png());
    const fresh = await stage("fresh.png", png());
    const staleKey = (await attachmentRow(stale.id)).storage_key;
    expect(await exists(staleKey)).toBe(true);
    await withSystem((db) => db.query("update support_attachments set expires_at = now() - interval '1 hour' where id = $1", [stale.id]));
    expect(await cleanupStagedUploads()).toBeGreaterThanOrEqual(1);
    expect(await attachmentRow(stale.id)).toMatchObject({ status: "removed", file_status: "deleted" });
    expect(await exists(staleKey)).toBe(false);
    expect((await attachmentRow(fresh.id)).status).toBe("staged");
    expect(await cleanupStagedUploads()).toBe(0);
  });
});

describe("files inside the conversation", () => {
  it("keeps agency-only files away from the client and shows client files to everyone entitled", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Files both ways", message: "Please look at the attached file." });
    const mine = await stage("from-client.png", png());
    await postClientMessage(w.ctx.member, r.id, { body: "Here is another screenshot.", attachmentIds: [mine.id] });
    const internal = await stageSupportFile(w.raw.staff.id, w.org.id, { name: "diagnostics.txt", bytes: Buffer.from("internal diagnostics") }, { internal: true });
    await agencyPostMessage(w.agency.staff, r.id, { body: "Internal findings attached.", internal: true, attachmentIds: [internal.id] });
    const publicFile = await stageSupportFile(w.raw.staff.id, w.org.id, { name: "fix-guide.pdf", bytes: pdf() });
    await agencyPostMessage(w.agency.staff, r.id, { body: "Here is the guide.", attachmentIds: [publicFile.id] });

    const client = await getRequestDetail(w.ctx.member, r.id);
    expect(JSON.stringify(client)).not.toMatch(/diagnostics\.txt/);
    expect(client!.messages.flatMap((m) => m.attachments.map((a) => a.filename)).sort()).toEqual(["fix-guide.pdf", "from-client.png"]);
    await expect(supportAttachmentDownload(w.people.member.id, internal.id)).rejects.toThrow(/not found/i);
    await expect(supportAttachmentDownload(w.people.owner.id, internal.id)).rejects.toThrow(/not found/i);
    expect(await supportAttachmentDownload(w.raw.staff.id, internal.id)).toMatch(/^\/api\/files\//);
    const team = await getAgencyRequest(w.agency.superAdmin, r.id);
    expect(team!.messages.flatMap((m) => m.attachments.map((a) => `${a.filename}:${a.visibility}`)).sort()).toEqual(["diagnostics.txt:internal", "fix-guide.pdf:client", "from-client.png:client"]);
    // The agency cannot attach an internal file to a public reply or a client file to a note.
    const another = await stageSupportFile(w.raw.staff.id, w.org.id, { name: "another.txt", bytes: Buffer.from("x") }, { internal: true });
    await expect(agencyPostMessage(w.agency.staff, r.id, { body: "Public reply with an internal file.", attachmentIds: [another.id] })).rejects.toThrow(/no longer available/);
    expect(await countRows("select 1 from support_messages where body = 'Public reply with an internal file.'")).toBe(0);
  });

  it("refuses files on a closed request and still supports the direct upload used before", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Direct upload", message: "Using the older upload route." });
    const direct = await attachSupportFile(w.people.member.id, r.id, { name: "direct.txt", bytes: Buffer.from("direct upload") });
    expect((await listSupportAttachments(w.people.member.id, r.id)).map((a) => a.id)).toEqual([direct.id]);
    expect((await getAgencyRequest(w.agency.superAdmin, r.id))!.looseAttachments.map((a) => a.filename)).toEqual(["direct.txt"]);
    await changeRequestStatus(w.agency.superAdmin, r.id, "closed");
    await expect(attachSupportFile(w.people.member.id, r.id, { name: "late.txt", bytes: Buffer.from("late") })).rejects.toThrow(/closed/);
  });
});

describe("retention", () => {
  it("deletes the files of long-closed requests only when the Super Admin turned retention on", async () => {
    const old = await submitRequest(w.ctx.member, { subject: "Closed long ago", message: "Old request with a file." });
    const recent = await submitRequest(w.ctx.member, { subject: "Closed recently", message: "Recent request with a file." });
    const oldFile = await attachSupportFile(w.people.member.id, old.id, { name: "old.txt", bytes: Buffer.from("old") });
    const recentFile = await attachSupportFile(w.people.member.id, recent.id, { name: "recent.txt", bytes: Buffer.from("recent") });
    await changeRequestStatus(w.agency.superAdmin, old.id, "closed");
    await changeRequestStatus(w.agency.superAdmin, recent.id, "closed");
    await withSystem((db) => db.query("update support_tickets set closed_at = now() - interval '40 days' where id = $1", [old.id]));
    await withSystem((db) => db.query("update support_tickets set closed_at = now() - interval '10 days' where id = $1", [recent.id]));
    expect(await purgeRetainedAttachments()).toBe(0);
    await configure({ attachmentRetentionDays: 30 });
    try {
      expect(await purgeRetainedAttachments()).toBe(1);
      expect((await attachmentRow(oldFile.id)).status).toBe("removed");
      expect((await attachmentRow(recentFile.id)).status).toBe("attached");
      await expect(supportAttachmentDownload(w.people.member.id, oldFile.id)).rejects.toThrow(/not found/i);
    } finally {
      await configure({ attachmentRetentionDays: null });
    }
    expect((await ticketRow(old.id)).status).toBe("closed");
  });
});
