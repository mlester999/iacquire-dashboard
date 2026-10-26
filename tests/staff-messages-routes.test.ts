import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/errors";
import { resetEnvCache } from "@/server/env";
import { createChannel, createDirect, createGroup } from "@/server/staff-messages/conversations";
import { deleteMessage, sendMessage } from "@/server/staff-messages/messages";
import { stageAttachment } from "@/server/staff-messages/attachments";
import { openStreams } from "@/server/staff-messages/stream";
import { resetSnapshotBrake } from "@/server/staff-messages/http";
import { MAX_ATTACHMENT_BYTES, PAGE_SIZE } from "@/lib/staff-messages/limits";
import { resetRateLimits } from "./support/support-world";
import { channelName, clearOverride, disable, enable, freshId, override, pdfBytes, pngBytes, rows, setMessages, setRole, staffPerson, staffWorld, type Person, type World } from "./support/staff-messages";

// The four Messages routes (snapshot, stream, upload, download) as the browser meets them: who gets in, what they get, what is never said. The signed-in person is handed to
// the route; everything below it is the real service on embedded Postgres. Files go to a temporary folder. Nothing leaves the machine.

const session = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUserOrThrow: async () => {
    if (!session.user) throw new (await import("@/server/errors")).AppError("unauthenticated", "Your session has ended. Please sign in again.");
    return session.user;
  },
}));

import { GET as snapshotRoute } from "@/app/api/admin/messages/snapshot/route";
import { GET as streamRoute } from "@/app/api/admin/messages/stream/route";
import { POST as uploadRoute } from "@/app/api/admin/messages/upload/route";
import { GET as fileRoute } from "@/app/api/admin/messages/files/[id]/route";

let uploads: string;
let w: World;
beforeAll(async () => {
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), "iacquire-staff-routes-"));
  vi.stubEnv("UPLOAD_DIR", uploads);
  resetEnvCache();
});
afterAll(async () => {
  if (uploads && path.dirname(path.resolve(uploads)) === path.resolve(os.tmpdir()) && path.basename(uploads).startsWith("iacquire-staff-routes-")) await fs.rm(uploads, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetEnvCache();
});
beforeEach(async () => {
  await resetRateLimits();
  resetSnapshotBrake();
  w = await staffWorld();
  session.user = null;
});

const as = (who: Person | null) => {
  session.user = who;
};
const url = (p: string) => `http://localhost:3000${p}`;
const snapshot = (qs = "") => snapshotRoute(new Request(url(`/api/admin/messages/snapshot${qs ? `?${qs}` : ""}`)));
const group = async (owner: Person, ...others: Person[]) => (await createGroup(owner, { name: `g-${freshId().slice(0, 6)}`, memberIds: others.map((o) => o.id) })).id;
const send = (who: Person, conversationId: string, body: string) => sendMessage(who, { conversationId, clientMessageId: freshId(), body });
const NO_STORE = "private, no-store";

const upload = (form: FormData, headers: Record<string, string> = {}) => uploadRoute(new Request(url("/api/admin/messages/upload"), { method: "POST", body: form, headers }));
const pdfForm = (conversationId: string | null, name = "Plan.pdf", bytes: Buffer = pdfBytes("route")) => {
  const form = new FormData();
  if (conversationId) form.set("conversationId", conversationId);
  form.set("file", new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
  return form;
};
const download = (id: string) => fileRoute(new Request(url(`/api/admin/messages/files/${id}`)), { params: Promise.resolve({ id }) });

describe("the snapshot route", () => {
  it("answers a signed-out request with 401 and a client's or a made-up person's with 403, and reads nothing for either", async () => {
    as(null);
    const out = await snapshot();
    expect(out.status).toBe(401);
    expect(await out.json()).toMatchObject({ code: "unauthenticated" });
    as(await staffPerson("none"));
    const client = await snapshot();
    expect(client.status).toBe(403);
    expect(await client.json()).toEqual({ error: "Agency access is required.", code: "forbidden", reason: "forbidden" });
    for (const r of [out, client]) expect(r.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("answers with the person's own conversations, no-store, and the revision to ask from next time", async () => {
    const mine = await group(w.staff, w.staff2);
    const theirs = await group(w.staff2, w.staff3);
    await send(w.staff2, mine, "For staff");
    await send(w.staff2, theirs, "Not for staff");
    as(w.staff);
    const res = await snapshot(`conversation=${mine}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const body = await res.json();
    expect(body.rail.map((r: { id: string }) => r.id)).toEqual([mine]);
    expect(body.page.messages.map((m: { body: string }) => m.body)).toEqual(["For staff"]);
    expect(JSON.stringify(body)).not.toContain("Not for staff");
    const same = await (await snapshot(`conversation=${mine}&since=${body.revision}`)).json();
    expect(same).toEqual({ unchanged: true, revision: body.revision });
  });

  it("gives the same answer for a conversation the person is not in as for one that does not exist, including to the Super Admin", async () => {
    const dm = (await createDirect(w.staff2, w.staff3.id)).id;
    await send(w.staff2, dm, "Between the two of us");
    for (const who of [w.staff, w.manager, w.superAdmin]) {
      as(who);
      const real = await (await snapshot(`conversation=${dm}`)).json();
      const fake = await (await snapshot(`conversation=${freshId()}`)).json();
      expect({ ...real, revision: 0 }, who.name).toEqual({ ...fake, revision: 0 });
      expect(real.conversation).toBeNull();
      expect(JSON.stringify(real)).not.toContain("Between the two");
    }
  });

  it("answers a badge-only request with the number", async () => {
    const id = await group(w.staff, w.staff2);
    await send(w.staff2, id, "x");
    as(w.staff);
    expect(await (await snapshot("badge=1")).json()).toEqual({ revision: expect.any(Number), unread: 1 });
  });

  it("refuses a malformed request with 400 and the reason, before it touches the database", async () => {
    as(w.staff);
    for (const qs of ["since=abc", "conversation=nope", "thread=" + freshId(), "before=5", "around=5", `conversation=${freshId()}&before=0`]) {
      const res = await snapshot(qs);
      expect(res.status, qs).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_input" });
    }
  });

  it("tells a person who lost access, or when the module is off, with the reason for the page to show", async () => {
    as(w.staff);
    await setMessages(false);
    const off = await snapshot();
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: "not_enabled", reason: "not_enabled" });
    await setMessages(true);
    await override(w.staff.id, "agency.messages.use", "deny");
    const denied = await snapshot();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason: "forbidden" });
    await clearOverride(w.staff.id, "agency.messages.use");
    await disable(w.staff.id);
    expect((await snapshot()).status).toBe(403);
    await enable(w.staff.id);
    await setRole(w.staff2.id, "agency_manager");
    // The session still says staff: a stale role is refused, not trusted.
    as(w.staff2);
    expect((await snapshot()).status).toBe(403);
    await setRole(w.staff2.id, "agency_staff");
  });

  it("slows a runaway page down with 429 and a wait, and lets a normal one through", async () => {
    as(w.staff);
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await snapshot("badge=1")).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes.slice(30)).toEqual([429, 429]);
    const slow = await snapshot("badge=1");
    expect(slow.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    expect(await slow.json()).toMatchObject({ code: "rate_limited" });
    // Another person is not affected.
    as(w.staff2);
    expect((await snapshot("badge=1")).status).toBe(200);
  });
});

describe("the stream route", () => {
  it("refuses a signed-out request, a client, a person denied Messages, and a deployment with the module off, as a plain refusal and not an open stream", async () => {
    as(null);
    expect((await streamRoute(new Request(url("/api/admin/messages/stream")))).status).toBe(401);
    as(await staffPerson("none"));
    expect((await streamRoute(new Request(url("/api/admin/messages/stream")))).status).toBe(403);
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    as(denied);
    const res = await streamRoute(new Request(url("/api/admin/messages/stream")));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(openStreams(denied.id)).toBe(0);
    await setMessages(false);
    as(w.staff);
    const off = await streamRoute(new Request(url("/api/admin/messages/stream")));
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ reason: "not_enabled" });
    await setMessages(true);
  });

  it("opens an event stream with the right headers, the first frame is the revision, and a fifth stream is refused", async () => {
    as(w.staff);
    const opened: Response[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await streamRoute(new Request(url("/api/admin/messages/stream")));
      expect(res.status).toBe(200);
      opened.push(res);
    }
    expect(opened[0].headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(opened[0].headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(openStreams(w.staff.id)).toBe(4);
    const reader = (opened[0].body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("event: ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toMatch(/event: ready\ndata: \{"revision":[0-9]+\}/);
    const fifth = await streamRoute(new Request(url("/api/admin/messages/stream")));
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toMatchObject({ code: "rate_limited" });
    // The first stream has a reader holding it, so give it back through that reader; the others have never been read.
    await reader.cancel();
    for (const r of opened.slice(1)) await r.body?.cancel();
    expect(openStreams(w.staff.id)).toBe(0);
    // A slot given back can be used again.
    const again = await streamRoute(new Request(url("/api/admin/messages/stream")));
    expect(again.status).toBe(200);
    await again.body?.cancel();
  });
});

describe("the upload route", () => {
  it("saves a file for a member of the conversation and answers with its id, name, type and size, and nothing else", async () => {
    const id = await group(w.staff, w.staff2);
    as(w.staff);
    const res = await upload(pdfForm(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({ id: expect.any(String), filename: "Plan.pdf", mimeType: "application/pdf", sizeBytes: pdfBytes("route").length });
    const [row] = await rows<{ status: string; uploaded_by: string; bucket: string }>("select a.status, a.uploaded_by, f.bucket from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.conversation_id = $1", [id]);
    expect(row).toEqual({ status: "staged", uploaded_by: w.staff.id, bucket: "staff-messages" });
  });

  it("refuses a request from another site, a signed-out one, a client, and a person who is not in the conversation, the last in the words of a made-up id", async () => {
    const id = await group(w.staff, w.staff2);
    as(w.staff);
    const cross = await upload(pdfForm(id), { "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ error: "Cross-site requests are not allowed." });
    expect((await upload(pdfForm(id), { origin: "http://evil.example" })).status).toBe(403);
    // The no-referrer case: a browser form from this very site sends Origin: null with Sec-Fetch-Site: same-origin.
    expect((await upload(pdfForm(id), { origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(200);
    as(null);
    expect((await upload(pdfForm(id))).status).toBe(401);
    as(await staffPerson("none"));
    expect((await upload(pdfForm(id))).status).toBe(403);
    as(w.staff3);
    const outsider = await upload(pdfForm(id));
    const fake = await upload(pdfForm(freshId()));
    expect(outsider.status).toBe(404);
    expect(await outsider.json()).toEqual(await fake.json());
    as(w.superAdmin);
    expect((await upload(pdfForm(id))).status).toBe(404);
  });

  it("refuses what is plainly wrong before keeping anything: no file, no conversation, the wrong type, a body that is too large, a file that is not what its name says", async () => {
    const id = await group(w.staff, w.staff2);
    as(w.staff);
    const before = (await rows<{ n: string }>("select count(*)::text as n from staff_message_attachments"))[0].n;
    const none = new FormData();
    none.set("conversationId", id);
    expect((await upload(none)).status).toBe(400);
    expect((await upload(pdfForm(null))).status).toBe(404);
    const exe = pdfForm(id, "tool.exe");
    expect((await upload(exe)).status).toBe(400);
    expect((await upload(pdfForm(id), { "content-length": String(MAX_ATTACHMENT_BYTES + 70_000) })).status).toBe(400);
    const lie = await upload(pdfForm(id, "photo.png", pdfBytes("a pdf named png")));
    expect(lie.status).toBe(400);
    expect((await rows<{ n: string }>("select count(*)::text as n from staff_message_attachments"))[0].n).toBe(before);
    expect((await upload(pdfForm(id, "photo.png", pngBytes()))).status).toBe(200);
  });

  it("is refused when the module is off, and for a person denied Messages", async () => {
    const id = await group(w.staff, w.staff2);
    as(w.staff);
    await setMessages(false);
    const off = await upload(pdfForm(id));
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: "not_enabled" });
    await setMessages(true);
    await override(w.staff.id, "agency.messages.use", "deny");
    expect((await upload(pdfForm(id))).status).toBe(403);
    await clearOverride(w.staff.id, "agency.messages.use");
  });
});

describe("the download route", () => {
  const sentFile = async (inChannel = false) => {
    const id = inChannel ? (await createChannel(w.manager, { name: channelName(), visibility: "private", memberIds: [w.staff.id] })).id : await group(w.staff, w.staff2);
    const owner = inChannel ? w.manager : w.staff;
    const file = await stageAttachment(owner, id, { name: "Plan v2.pdf", bytes: pdfBytes("download") });
    const { message } = await sendMessage(owner, { conversationId: id, clientMessageId: freshId(), body: "See the plan", attachmentIds: [file.id] });
    return { id, file, message, owner };
  };

  it("gives a member the file as a download, never shown in a page, with every header that keeps it that way", async () => {
    const s = await sentFile();
    for (const who of [w.staff, w.staff2]) {
      as(who);
      const res = await download(s.file.id);
      expect(res.status, who.name).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(pdfBytes("download"))).toBe(true);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Plan v2\.pdf"; filename\*=UTF-8''Plan%20v2\.pdf$/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      expect(res.headers.get("content-length")).toBe(String(pdfBytes("download").length));
    }
  });

  it("says a file in a conversation the person is not in is not found, in the same words as one that never existed, including to the Super Admin", async () => {
    const s = await sentFile();
    for (const who of [w.staff3, w.manager, w.superAdmin]) {
      as(who);
      const real = await download(s.file.id);
      const fake = await download(freshId());
      expect(real.status, who.name).toBe(404);
      expect(await real.json()).toEqual(await fake.json());
    }
    as(w.staff);
    expect((await download("not-an-id")).status).toBe(404);
    expect((await download("../../etc/passwd")).status).toBe(404);
  });

  it("stops giving the file to someone who left the conversation, was demoted or disabled, or when the module is off, and to anyone once the message is deleted", async () => {
    const s = await sentFile(true);
    as(w.staff);
    expect((await download(s.file.id)).status).toBe(200);
    await setMessages(false);
    expect((await download(s.file.id)).status).toBe(403);
    await setMessages(true);
    await disable(w.staff.id);
    expect((await download(s.file.id)).status).toBe(403);
    await enable(w.staff.id);
    await override(w.staff.id, "agency.messages.use", "deny");
    expect((await download(s.file.id)).status).toBe(403);
    await clearOverride(w.staff.id, "agency.messages.use");
    expect((await download(s.file.id)).status).toBe(200);
    as(null);
    expect((await download(s.file.id)).status).toBe(401);
    as(s.owner);
    await deleteMessage(s.owner, s.message.id);
    as(w.staff);
    expect((await download(s.file.id)).status).toBe(404);
    as(s.owner);
    expect((await download(s.file.id)).status).toBe(404);
  });

  it("gives a staged file to the person who chose it and to nobody else, even in the same conversation", async () => {
    const id = await group(w.staff, w.staff2);
    const staged = await stageAttachment(w.staff, id, { name: "Draft.pdf", bytes: pdfBytes("staged") });
    as(w.staff);
    expect((await download(staged.id)).status).toBe(200);
    as(w.staff2);
    expect((await download(staged.id)).status).toBe(404);
  });
});

describe("what the routes never do", () => {
  it("do not read the workspace, the organisation or the person's id from the request", async () => {
    const id = await group(w.staff, w.staff2);
    await send(w.staff2, id, "x");
    as(w.staff3);
    const body = await (await snapshot(`conversation=${id}&org=${freshId()}&user=${w.staff.id}`)).json();
    expect(body.conversation).toBeNull();
    expect(body.rail).toEqual([]);
    const error = new AppError("forbidden", "x");
    expect(error.status).toBe(403);
  });

  it("show a page's worth at most, however many messages exist", async () => {
    const id = await group(w.staff, w.staff2);
    for (let i = 0; i < PAGE_SIZE + 3; i++) await send(w.staff2, id, `m${i}`);
    as(w.staff);
    const body = await (await snapshot(`conversation=${id}`)).json();
    expect(body.page.messages).toHaveLength(PAGE_SIZE);
    expect(body.page.hasMore).toBe(true);
  }, 60_000);
});
