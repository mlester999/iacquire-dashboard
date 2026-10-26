import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STREAMS_PER_USER, openStreams, reserveStaffStream, staffInboxStream } from "@/server/staff-messages/stream";
import { snapshotBrake, resetSnapshotBrake, errorResponse } from "@/server/staff-messages/http";
import { inboxStatus, type InboxStatus } from "@/server/staff-messages/inbox";
import { createGroup } from "@/server/staff-messages/conversations";
import { sendMessage } from "@/server/staff-messages/messages";
import { AppError } from "@/server/errors";
import { frameRevision } from "@/lib/staff-messages/live";
import { resetRateLimits } from "./support/support-world";
import { freshId, override, setRole, staffWorld, type World } from "./support/staff-messages";

// The server-sent stream behind an open Messages page: what a frame says (a revision number and nothing else), when it ends (a minute, the page leaving, or the person's
// standing changing) and how many a person may hold. Frames are read from the real ReadableStream. The brake on the snapshot endpoint is here too.

const USER = { id: "11111111-1111-4111-8111-111111111111", platformRole: "agency_staff" as const };

/** Reads a stream until it ends (or `until` says enough) and returns the frames as {event, data} plus the raw comment lines. */
async function drain(stream: ReadableStream<Uint8Array>, until?: (frames: Frame[]) => boolean): Promise<{ frames: Frame[]; raw: string; ended: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let ended = false;
  const frames: Frame[] = [];
  const parse = () => {
    frames.length = 0;
    for (const block of raw.split("\n\n")) {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) frames.push({ event, data });
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    raw += decoder.decode(value, { stream: true });
    parse();
    if (until?.(frames)) {
      await reader.cancel();
      break;
    }
  }
  parse();
  return { frames, raw, ended };
}
interface Frame {
  event: string;
  data: string;
}

/** A status source that answers from a script, one answer per tick, repeating the last. */
const scripted = (...answers: Array<InboxStatus | Error>) => {
  let i = 0;
  const calls = vi.fn(async () => {
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return calls;
};

describe("the frames", () => {
  it("opens with a retry hint and the current revision, then says a revision only when it went up, and nothing else", async () => {
    const status = scripted({ access: "ok", revision: 5 }, { access: "ok", revision: 5 }, { access: "ok", revision: 6 }, { access: "ok", revision: 6 }, { access: "ok", revision: 9 });
    const { frames, raw } = await drain(staffInboxStream({ user: USER, initial: { access: "ok", revision: 5 }, status, pollMs: 20, maxMs: 600 }));
    expect(raw.startsWith("retry: 3000\n\n")).toBe(true);
    expect(frames.map((f) => f.event)).toEqual(["ready", "revision", "revision"]);
    expect(frames.map((f) => frameRevision(f.data))).toEqual([5, 6, 9]);
    for (const f of frames) expect(Object.keys(JSON.parse(f.data))).toEqual(["revision"]);
    expect(raw).not.toMatch(/conversation|message|name|body|@/i);
  });

  it("never goes back to a smaller number", async () => {
    const status = scripted({ access: "ok", revision: 8 }, { access: "ok", revision: 7 }, { access: "ok", revision: 8 }, { access: "ok", revision: 9 });
    const { frames } = await drain(staffInboxStream({ user: USER, initial: { access: "ok", revision: 8 }, status, pollMs: 20, maxMs: 300 }));
    expect(frames.map((f) => frameRevision(f.data))).toEqual([8, 9]);
  });

  it("keeps going through a hiccup in the database", async () => {
    const status = scripted(new Error("connection reset"), new Error("connection reset"), { access: "ok", revision: 4 });
    const { frames } = await drain(staffInboxStream({ user: USER, initial: { access: "ok", revision: 3 }, status, pollMs: 20, maxMs: 600 }));
    expect(frames.map((f) => f.event)).toEqual(["ready", "revision"]);
    expect(frames.map((f) => frameRevision(f.data))).toEqual([3, 4]);
  });
});

describe("when it ends", () => {
  it("tells the page and closes at once when the person's standing changes, with the reason, and gives its slot back", async () => {
    const release = vi.fn();
    const status = scripted({ access: "ok", revision: 1 }, { access: "changed", reason: "forbidden" });
    const { frames, ended } = await drain(staffInboxStream({ user: USER, initial: { access: "ok", revision: 1 }, status, release, pollMs: 15, maxMs: 5_000 }));
    expect(ended).toBe(true);
    expect(frames.map((f) => f.event)).toEqual(["ready", "access_changed"]);
    expect(JSON.parse(frames[1].data)).toEqual({ reason: "forbidden" });
    expect(release).toHaveBeenCalledTimes(1);
    // It does not ask again after it has ended.
    const asked = status.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(status.mock.calls.length).toBe(asked);
  });

  it("says the module was switched off with that reason", async () => {
    const status = scripted({ access: "changed", reason: "not_enabled" });
    const { frames } = await drain(staffInboxStream({ user: USER, initial: { access: "ok", revision: 1 }, status, pollMs: 15, maxMs: 1_000 }));
    expect(JSON.parse(frames.at(-1)?.data ?? "{}")).toEqual({ reason: "not_enabled" });
  });

  it("refuses to open for a person who already lost access: one frame, closed, slot returned", async () => {
    const release = vi.fn();
    const status = scripted({ access: "ok", revision: 1 });
    const { frames, ended } = await drain(staffInboxStream({ user: USER, initial: { access: "changed", reason: "forbidden" }, status, release, pollMs: 15, maxMs: 1_000 }));
    expect(ended).toBe(true);
    expect(frames.map((f) => f.event)).toEqual(["access_changed"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("ends by itself after its time and gives its slot back once", async () => {
    const release = vi.fn();
    const started = Date.now();
    const { ended } = await drain(staffInboxStream({ user: USER, initial: { access: "ok", revision: 1 }, status: scripted({ access: "ok", revision: 1 }), release, pollMs: 20, maxMs: 90 }));
    expect(ended).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("ends when the page goes away, and when the reader cancels, each giving the slot back once", async () => {
    const aborted = new AbortController();
    const release = vi.fn();
    const stream = staffInboxStream({ user: USER, initial: { access: "ok", revision: 1 }, status: scripted({ access: "ok", revision: 1 }), release, signal: aborted.signal, pollMs: 20, maxMs: 10_000 });
    const pending = drain(stream);
    await new Promise((r) => setTimeout(r, 40));
    aborted.abort();
    expect((await pending).ended).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);

    const release2 = vi.fn();
    await drain(staffInboxStream({ user: USER, initial: { access: "ok", revision: 1 }, status: scripted({ access: "ok", revision: 1 }), release: release2, pollMs: 20, maxMs: 10_000 }), (f) => f.length >= 1);
    expect(release2).toHaveBeenCalledTimes(1);

    const gone = new AbortController();
    gone.abort();
    const release3 = vi.fn();
    expect((await drain(staffInboxStream({ user: USER, initial: { access: "ok", revision: 1 }, status: scripted({ access: "ok", revision: 1 }), release: release3, signal: gone.signal, pollMs: 20, maxMs: 10_000 }))).ended).toBe(true);
    expect(release3).toHaveBeenCalledTimes(1);
  });
});

describe("how many a person may hold", () => {
  it("allows four, refuses the fifth, and counts a slot again once it is given back (giving it back twice changes nothing)", () => {
    const id = freshId();
    const slots = Array.from({ length: MAX_STREAMS_PER_USER }, () => reserveStaffStream(id));
    expect(slots.every((s) => typeof s === "function")).toBe(true);
    expect(openStreams(id)).toBe(MAX_STREAMS_PER_USER);
    expect(reserveStaffStream(id)).toBeNull();
    slots[0]?.();
    slots[0]?.();
    expect(openStreams(id)).toBe(MAX_STREAMS_PER_USER - 1);
    const again = reserveStaffStream(id);
    expect(again).not.toBeNull();
    expect(reserveStaffStream(id)).toBeNull();
    for (const s of [...slots.slice(1), again]) s?.();
    expect(openStreams(id)).toBe(0);
  });

  it("counts people separately", () => {
    const a = freshId();
    const b = freshId();
    const held = Array.from({ length: MAX_STREAMS_PER_USER }, () => reserveStaffStream(a));
    expect(reserveStaffStream(b)).not.toBeNull();
    for (const s of held) s?.();
  });
});

describe("with a real database", () => {
  let w: World;
  beforeEach(async () => {
    await resetRateLimits();
    w = await staffWorld();
  });

  it("says a new revision after a colleague writes, and only the number", async () => {
    const id = (await createGroup(w.staff, { name: `g-${freshId().slice(0, 6)}`, memberIds: [w.staff2.id] })).id;
    const initial = await inboxStatus(w.staff2);
    expect(initial.access).toBe("ok");
    const stream = staffInboxStream({ user: w.staff2, initial, pollMs: 25, maxMs: 4_000 });
    const writing = new Promise<void>((resolve) => setTimeout(() => void sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: "Secret words in a message" }).then(() => resolve()), 60));
    const { frames, raw } = await drain(stream, (f) => f.some((x) => x.event === "revision"));
    await writing;
    expect(frames.map((f) => f.event)).toEqual(["ready", "revision"]);
    expect((frameRevision(frames[1].data) as number) > (frameRevision(frames[0].data) as number)).toBe(true);
    expect(raw).not.toContain("Secret");
  });

  it("ends with access_changed when the person is demoted, or denied, while it is open", async () => {
    for (const change of [(id: string) => setRole(id, "none"), (id: string) => override(id, "agency.messages.use", "deny")]) {
      const person = w.staff3;
      const initial = await inboxStatus(person);
      const stream = staffInboxStream({ user: person, initial, pollMs: 25, maxMs: 4_000 });
      const changing = new Promise<void>((resolve) => setTimeout(() => void change(person.id).then(() => resolve()), 60));
      const { frames, ended } = await drain(stream);
      await changing;
      expect(ended).toBe(true);
      expect(frames.at(-1)?.event).toBe("access_changed");
      // Put them back for the next round.
      await setRole(person.id, "agency_staff");
      await withClear(person.id);
    }
  });
});

async function withClear(userId: string) {
  const { clearOverride } = await import("./support/staff-messages");
  await clearOverride(userId, "agency.messages.use");
}

describe("the brake on the snapshot endpoint", () => {
  beforeEach(() => resetSnapshotBrake());

  it("lets a normal page through and asks a runaway one to slow down, then lets it through again", () => {
    const id = freshId();
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) expect(snapshotBrake(id, t0 + i * 10), String(i)).toBeNull();
    const wait = snapshotBrake(id, t0 + 400);
    expect(wait).not.toBeNull();
    expect(wait as number).toBeGreaterThanOrEqual(1);
    expect(wait as number).toBeLessThanOrEqual(10);
    expect(snapshotBrake(id, t0 + 10_050)).toBeNull();
    // Another person is not slowed down by it.
    expect(snapshotBrake(freshId(), t0 + 400)).toBeNull();
  });

  it("writes a refusal as JSON with the reason the page gives, and a wait for rate limits", async () => {
    const forbidden = errorResponse(new AppError("forbidden", "Agency access is required; authorization has changed."));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Agency access is required; authorization has changed.", code: "forbidden", reason: "forbidden" });
    expect(forbidden.headers.get("cache-control")).toBe("private, no-store");
    const off = errorResponse(new AppError("not_enabled", "Off."));
    expect(await off.json()).toMatchObject({ code: "not_enabled", reason: "not_enabled" });
    const slow = errorResponse(new AppError("rate_limited", "Slow down.", { retryAfterSeconds: 12 }));
    expect(slow.status).toBe(429);
    expect(slow.headers.get("retry-after")).toBe("12");
    expect(await slow.json()).toEqual({ error: "Slow down.", code: "rate_limited" });
    const internal = errorResponse(new Error("password=hunter2 at /srv/app"));
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await internal.json())).not.toMatch(/hunter2|srv/);
  });
});
