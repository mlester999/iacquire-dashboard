import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { createDirect, createGroup, leaveConversation, setArchived } from "@/server/staff-messages/conversations";
import { cleanupStagedAttachments, discardStaged, downloadAttachment, stageAttachment } from "@/server/staff-messages/attachments";
import { deleteMessage, listMessages, sendMessage } from "@/server/staff-messages/messages";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_STAGED_PER_PERSON } from "@/lib/staff-messages/limits";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { resetRateLimits } from "./support/support-world";
import { count, disable, freshId, override, pdfBytes, pngBytes, rows, seedRateHits, staffWorld, type Person, type World } from "./support/staff-messages";

// Files on staff messages (migration 0096 and the bucket of 0090): staged, bound to a message when it is sent, downloaded only by members, removed when unsent or deleted.
// Files are written to a temporary folder (the local storage mode); nothing leaves the machine.

let uploads: string;
let w: World;
beforeAll(async () => {
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), "iacquire-staff-messages-"));
  vi.stubEnv("UPLOAD_DIR", uploads);
  resetEnvCache();
});
afterAll(async () => {
  if (uploads && path.dirname(path.resolve(uploads)) === path.resolve(os.tmpdir()) && path.basename(uploads).startsWith("iacquire-staff-messages-")) await fs.rm(uploads, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetEnvCache();
});
beforeEach(async () => {
  await resetRateLimits();
  w = await staffWorld();
});

const refused = async (p: Promise<unknown>) => p.then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
const group = async (owner: Person, ...others: Person[]) => (await createGroup(owner, { name: `g-${freshId().slice(0, 6)}`, memberIds: others.map((o) => o.id) })).id;
const onDisk = async (attachmentId: string) => {
  const [r] = await rows<{ bucket: string; storage_key: string }>("select f.bucket, f.storage_key from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.id = $1", [attachmentId]);
  return existsSync(path.join(uploads, r.bucket, ...r.storage_key.split("/")));
};
const status = async (attachmentId: string) => (await rows<{ a: string; f: string }>("select a.status as a, f.status as f from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.id = $1", [attachmentId]))[0];

describe("staging a file", () => {
  it("saves it privately in the staff bucket, for the person who chose it, attached to nothing", async () => {
    const id = await group(w.staff, w.staff2);
    const staged = await stageAttachment(w.staff, id, { name: "Plan v2.pdf", bytes: pdfBytes("plan") });
    expect(staged).toMatchObject({ filename: "Plan v2.pdf", mimeType: "application/pdf", sizeBytes: pdfBytes("plan").length });
    const [row] = await rows<{ status: string; message_id: string | null; uploaded_by: string; expires_at: Date; org_id: string; bucket: string; storage_key: string; visibility: string; fstatus: string }>(
      `select a.status, a.message_id, a.uploaded_by, a.expires_at, a.org_id, f.bucket, f.storage_key, f.visibility, f.status as fstatus
         from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.id = $1`, [staged.id]);
    expect(row).toMatchObject({ status: "staged", message_id: null, uploaded_by: w.staff.id, org_id: w.agencyId, bucket: "staff-messages", fstatus: "ready" });
    expect(row.storage_key.startsWith(`${w.agencyId}/`)).toBe(true);
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await onDisk(staged.id)).toBe(true);
  });

  it("makes the file's name safe whatever the person called it", async () => {
    const id = await group(w.staff, w.staff2);
    const staged = await stageAttachment(w.staff, id, { name: "..\\..\\etc/pass wd<script>.pdf", bytes: pdfBytes() });
    expect(staged.filename).toMatch(/^[\w.\- ()]+$/);
    expect(staged.filename.endsWith(".pdf")).toBe(true);
    expect(staged.filename).not.toContain("/");
    expect(staged.filename).not.toContain("<");
  });

  it("refuses a type that is not allowed, bytes that do not match the type, an empty file and a file that is too big", async () => {
    const id = await group(w.staff, w.staff2);
    for (const name of ["run.exe", "page.html", "logo.svg", "archive.zip", "noextension", "clip.mp4"]) {
      expect((await refused(stageAttachment(w.staff, id, { name, bytes: pdfBytes() })))?.code, name).toBe("invalid_input");
    }
    // A PNG called a PDF, a program called a picture, a binary file called text.
    expect((await refused(stageAttachment(w.staff, id, { name: "fake.pdf", bytes: pngBytes() })))?.code).toBe("invalid_input");
    expect((await refused(stageAttachment(w.staff, id, { name: "fake.png", bytes: Buffer.from("MZ not a picture") })))?.code).toBe("invalid_input");
    expect((await refused(stageAttachment(w.staff, id, { name: "fake.txt", bytes: Buffer.from([65, 0, 66]) })))?.code).toBe("invalid_input");
    expect((await refused(stageAttachment(w.staff, id, { name: "empty.pdf", bytes: Buffer.alloc(0) })))?.code).toBe("invalid_input");
    expect((await refused(stageAttachment(w.staff, id, { name: "big.pdf", bytes: Buffer.concat([pdfBytes(), Buffer.alloc(MAX_ATTACHMENT_BYTES)]) })))?.code).toBe("invalid_input");
    expect(await count("select 1 from staff_message_attachments where conversation_id = $1", [id])).toBe(0);
    expect(await count("select 1 from private_files where uploaded_by = $1 and bucket = 'staff-messages'", [w.staff.id])).toBe(0);
  });

  it("is for members of the conversation only, and not into an archived one", async () => {
    const id = await group(w.staff, w.staff2);
    for (const outsider of [w.staff3, w.manager, w.superAdmin]) expect((await refused(stageAttachment(outsider, id, { name: "a.pdf", bytes: pdfBytes() })))?.code).toBe("not_found");
    await setArchived(w.staff, id, true);
    expect((await refused(stageAttachment(w.staff, id, { name: "a.pdf", bytes: pdfBytes() })))?.code).toBe("conflict");
    expect(await count("select 1 from staff_message_attachments where conversation_id = $1", [id])).toBe(0);
  });

  it("is refused to a person denied Messages or a disabled account", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    await override(w.staff2.id, "agency.messages.use", "deny");
    await disable(w.staff3.id);
    expect((await refused(stageAttachment(w.staff2, id, { name: "a.pdf", bytes: pdfBytes() })))?.code).toBe("forbidden");
    expect((await refused(stageAttachment(w.staff3, id, { name: "a.pdf", bytes: pdfBytes() })))?.code).toBe("forbidden");
  });

  it("holds a person to twenty unsent files and to a number of uploads an hour", async () => {
    const id = await group(w.staff, w.staff2);
    for (let i = 0; i < MAX_STAGED_PER_PERSON; i++) await stageAttachment(w.staff, id, { name: `f${i}.txt`, bytes: Buffer.from(`file ${i}`) });
    expect((await refused(stageAttachment(w.staff, id, { name: "one-too-many.txt", bytes: Buffer.from("x") })))?.code).toBe("rate_limited");
    await seedRateHits(RATE_LIMITS.staffMessageUploadByUser, w.staff2.id, RATE_LIMITS.staffMessageUploadByUser.limit);
    expect(await refused(stageAttachment(w.staff2, id, { name: "a.txt", bytes: Buffer.from("x") }))).toMatchObject({ code: "rate_limited" });
  });

  it("can be taken back by the person who staged it, and by nobody else", async () => {
    const id = await group(w.staff, w.staff2);
    const staged = await stageAttachment(w.staff, id, { name: "oops.pdf", bytes: pdfBytes() });
    expect((await refused(discardStaged(w.staff2, staged.id)))?.code).toBe("not_found");
    expect((await refused(discardStaged(w.staff, freshId())))?.code).toBe("not_found");
    expect((await refused(discardStaged(w.staff, "nope")))?.code).toBe("not_found");
    await discardStaged(w.staff, staged.id);
    expect(await status(staged.id)).toEqual({ a: "removed", f: "deleted" });
    expect(await onDisk(staged.id)).toBe(false);
    expect((await refused(discardStaged(w.staff, staged.id)))?.code).toBe("not_found");
  });
});

describe("sending a message with files", () => {
  it("attaches the staged files to the message, and members can download them", async () => {
    const id = await group(w.staff, w.staff2);
    const a = await stageAttachment(w.staff, id, { name: "plan.pdf", bytes: pdfBytes("a") });
    const b = await stageAttachment(w.staff, id, { name: "chart.png", bytes: pngBytes() });
    const sent = await sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Here you go", attachmentIds: [a.id, b.id, a.id] });
    expect(sent.message.attachments.map((x) => [x.filename, x.mimeType])).toEqual([["plan.pdf", "application/pdf"], ["chart.png", "image/png"]]);
    expect(await status(a.id)).toEqual({ a: "attached", f: "ready" });
    const page = await listMessages(w.staff2, id);
    expect(page.messages[0].attachments.map((x) => x.id)).toEqual([a.id, b.id]);
    const got = await downloadAttachment(w.staff2, a.id);
    expect(got.filename).toBe("plan.pdf");
    expect(got.mimeType).toBe("application/pdf");
    expect(got.bytes.equals(pdfBytes("a"))).toBe(true);
    expect((await downloadAttachment(w.staff, b.id)).bytes.equals(pngBytes())).toBe(true);
  });

  it("is not for a stranger: a person outside the conversation, even the Super Admin, finds nothing to download", async () => {
    const id = await group(w.staff, w.staff2);
    const a = await stageAttachment(w.staff, id, { name: "plan.pdf", bytes: pdfBytes() });
    await sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Private", attachmentIds: [a.id] });
    for (const outsider of [w.staff3, w.manager, w.superAdmin]) expect((await refused(downloadAttachment(outsider, a.id)))?.code, outsider.name).toBe("not_found");
    expect((await refused(downloadAttachment(w.staff2, freshId())))?.code).toBe("not_found");
    expect((await refused(downloadAttachment(w.staff2, "nope")))?.code).toBe("not_found");
  });

  it("stops at once for a member who leaves, is denied Messages, is demoted or disabled", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    const a = await stageAttachment(w.staff, id, { name: "plan.pdf", bytes: pdfBytes() });
    await sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Files", attachmentIds: [a.id] });
    expect((await downloadAttachment(w.staff2, a.id)).filename).toBe("plan.pdf");
    expect((await downloadAttachment(w.staff3, a.id)).filename).toBe("plan.pdf");
    await leaveConversation(w.staff2, id);
    expect((await refused(downloadAttachment(w.staff2, a.id)))?.code).toBe("not_found");
    await override(w.staff3.id, "agency.messages.use", "deny");
    expect((await refused(downloadAttachment(w.staff3, a.id)))?.code).toBe("forbidden");
    expect((await downloadAttachment(w.staff, a.id)).filename).toBe("plan.pdf");
    await withSystem((db) => db.query("update users set platform_role = 'none' where id = $1", [w.staff.id]));
    expect((await refused(downloadAttachment(w.staff, a.id)))?.code).toBe("forbidden");
  });

  it("refuses a file that is someone else's, already sent, expired, from another conversation, or more than five", async () => {
    const id = await group(w.staff, w.staff2);
    const other = await group(w.staff, w.staff2);
    const theirs = await stageAttachment(w.staff2, id, { name: "theirs.pdf", bytes: pdfBytes("t") });
    const sentFile = await stageAttachment(w.staff, id, { name: "sent.pdf", bytes: pdfBytes("s") });
    await sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "First", attachmentIds: [sentFile.id] });
    const wrongPlace = await stageAttachment(w.staff, other, { name: "elsewhere.pdf", bytes: pdfBytes("e") });
    const old = await stageAttachment(w.staff, id, { name: "old.pdf", bytes: pdfBytes("o") });
    await withSystem((db) => db.query("update staff_message_attachments set expires_at = now() - interval '1 minute' where id = $1", [old.id]));
    for (const bad of [theirs.id, sentFile.id, wrongPlace.id, old.id, freshId()]) {
      expect((await refused(sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Again", attachmentIds: [bad] })))?.code, bad).toBe("invalid_input");
    }
    // Nothing was posted by the refused sends, and the other person's staged file is still theirs.
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(1);
    expect((await status(theirs.id)).a).toBe("staged");
    const six = [];
    for (let i = 0; i < MAX_ATTACHMENTS + 1; i++) six.push((await stageAttachment(w.staff, id, { name: `f${i}.txt`, bytes: Buffer.from(`file ${i}`) })).id);
    expect((await refused(sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Six", attachmentIds: six })))?.code).toBe("invalid_input");
    expect((await sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Five", attachmentIds: six.slice(0, MAX_ATTACHMENTS) })).message.attachments).toHaveLength(MAX_ATTACHMENTS);
  });

  it("keeps a staged file to its uploader: another member can neither see it nor download it", async () => {
    const id = await group(w.staff, w.staff2);
    const staged = await stageAttachment(w.staff, id, { name: "draft.pdf", bytes: pdfBytes("d") });
    expect((await refused(downloadAttachment(w.staff2, staged.id)))?.code).toBe("not_found");
    expect((await downloadAttachment(w.staff, staged.id)).bytes.equals(pdfBytes("d"))).toBe(true);
    const seen = await rows<{ id: string }>("select a.id from staff_message_attachments a where a.id = $1", [staged.id]);
    expect(seen).toHaveLength(1);
  });

  it("removes the file when its message is deleted: access first, then the stored bytes", async () => {
    const id = await group(w.staff, w.staff2);
    const a = await stageAttachment(w.staff, id, { name: "regret.pdf", bytes: pdfBytes("r") });
    const sent = await sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Oops", attachmentIds: [a.id] });
    expect(await onDisk(a.id)).toBe(true);
    await deleteMessage(w.staff, sent.message.id);
    expect(await status(a.id)).toEqual({ a: "removed", f: "deleted" });
    expect(await onDisk(a.id)).toBe(false);
    expect((await refused(downloadAttachment(w.staff2, a.id)))?.code).toBe("not_found");
    expect((await listMessages(w.staff2, id)).messages[0].attachments).toEqual([]);
  });
});

describe("the bucket is closed to browsers", () => {
  it("is invisible to the application role through private_files, even to a member who may download the file", async () => {
    const id = await group(w.staff, w.staff2);
    const a = await stageAttachment(w.staff, id, { name: "plan.pdf", bytes: pdfBytes() });
    await sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Files", attachmentIds: [a.id] });
    for (const who of [w.staff, w.staff2, w.manager, w.superAdmin]) {
      const seen = await withSystem(async (db) => {
        await db.query("select set_config('app.user_id', $1, true), set_config('role', 'iaq_app_user', true)", [who.id]);
        return (await db.query("select id from private_files where bucket = 'staff-messages'")).rows;
      });
      expect(seen, who.name).toEqual([]);
    }
  });

  it("cannot be read by any browser: the rule says no to everyone for a read, and yes to a write only for an agency person who may use Messages", async () => {
    const read = async (who: Person) => withSystem(async (db) => {
      await db.query("select set_config('app.user_id', $1, true), set_config('role', 'iaq_app_user', true)", [who.id]);
      return (await db.query<{ ok: boolean }>("select app.file_permission($1, 'staff-messages', false, 'client') as ok", [w.agencyId])).rows[0].ok;
    });
    const write = async (who: Person) => withSystem(async (db) => {
      await db.query("select set_config('app.user_id', $1, true), set_config('role', 'iaq_app_user', true)", [who.id]);
      return (await db.query<{ ok: boolean }>("select app.file_permission($1, 'staff-messages', true, 'client') as ok", [w.agencyId])).rows[0].ok;
    });
    for (const who of [w.staff, w.manager, w.superAdmin]) {
      expect(await read(who), `read ${who.name}`).toBe(false);
      expect(await write(who), `write ${who.name}`).toBe(true);
    }
    await override(w.staff3.id, "agency.messages.use", "deny");
    expect(await write(w.staff3)).toBe(false);
  });
});

describe("unsent files", () => {
  it("are removed once their time is up, the stored bytes too, and recent ones are left alone", async () => {
    // Files other tests left past their time are cleared first, so the counts below are this test's own.
    await cleanupStagedAttachments({ now: new Date(Date.now() + 365 * 24 * 3_600_000) });
    const id = await group(w.staff, w.staff2);
    const old = await stageAttachment(w.staff, id, { name: "old.pdf", bytes: pdfBytes("old") });
    const fresh = await stageAttachment(w.staff, id, { name: "fresh.pdf", bytes: pdfBytes("fresh") });
    const sent = await stageAttachment(w.staff, id, { name: "sent.pdf", bytes: pdfBytes("sent") });
    await sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Sent one", attachmentIds: [sent.id] });
    await withSystem((db) => db.query("update staff_message_attachments set expires_at = now() - interval '1 hour' where id = any($1::uuid[])", [[old.id, sent.id]]));
    expect(await cleanupStagedAttachments()).toBe(1);
    expect(await status(old.id)).toEqual({ a: "removed", f: "deleted" });
    expect(await onDisk(old.id)).toBe(false);
    expect((await status(fresh.id)).a).toBe("staged");
    expect(await onDisk(fresh.id)).toBe(true);
    expect((await status(sent.id)).a).toBe("attached");
    expect(await onDisk(sent.id)).toBe(true);
    // A later moment makes the fresh one old too.
    expect(await cleanupStagedAttachments({ now: new Date(Date.now() + 25 * 3_600_000) })).toBe(1);
    expect((await status(fresh.id)).a).toBe("removed");
    expect(await cleanupStagedAttachments()).toBe(0);
  });
});

describe("the same person in two conversations", () => {
  it("can stage in each and send each, without the files crossing", async () => {
    const a = (await createDirect(w.staff, w.staff2.id)).id;
    const b = await group(w.staff, w.staff3);
    const fa = await stageAttachment(w.staff, a, { name: "a.txt", bytes: Buffer.from("for a") });
    const fb = await stageAttachment(w.staff, b, { name: "b.txt", bytes: Buffer.from("for b") });
    expect((await refused(sendMessage(w.staff, { conversationId: a, clientMessageId: freshId(), body: "X", attachmentIds: [fb.id] })))?.code).toBe("invalid_input");
    await sendMessage(w.staff, { conversationId: a, clientMessageId: freshId(), body: "A", attachmentIds: [fa.id] });
    await sendMessage(w.staff, { conversationId: b, clientMessageId: freshId(), body: "B", attachmentIds: [fb.id] });
    expect((await refused(downloadAttachment(w.staff3, fa.id)))?.code).toBe("not_found");
    expect((await downloadAttachment(w.staff2, fa.id)).bytes.toString()).toBe("for a");
    expect((await refused(downloadAttachment(w.staff2, fb.id)))?.code).toBe("not_found");
  });
});
