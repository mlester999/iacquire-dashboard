import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftSaver, type SaveOutcome, type SaverState } from "@/lib/website/draft-saver";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(save: (c: string, rev: number) => Promise<SaveOutcome>, extra: { retryDelaysMs?: number[] } = {}) {
  const states: SaverState[] = [];
  const saver = createDraftSaver<string>({ save, onChange: (s) => states.push(s), revision: 5, ...extra });
  return { saver, states, last: () => states.at(-1)! };
}

describe("website draft autosave", () => {
  it("saves only the newest content after a pause, using the confirmed revision", async () => {
    const save = vi.fn(async (c: string, rev: number) => {
      void c;
      return { ok: true as const, revision: rev + 1 };
    });
    const { saver, last } = setup(save);
    saver.queue("a");
    saver.queue("ab");
    saver.queue("abc");
    expect(last().status).toBe("dirty");
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abc", 5);
    expect(last()).toMatchObject({ status: "saved", revision: 6 });
    expect(saver.hasUnsaved()).toBe(false);
  });

  it("never says saved while the request is out, and saves edits made during it afterwards with the new revision", async () => {
    let release!: () => void;
    const save = vi.fn(async (c: string, rev: number) => {
      if (c === "first") await new Promise<void>((r) => (release = r));
      return { ok: true as const, revision: rev + 1 };
    });
    const { saver, states, last } = setup(save);
    saver.queue("first");
    await vi.advanceTimersByTimeAsync(800);
    expect(last().status).toBe("saving");
    saver.queue("second");
    release();
    await vi.advanceTimersByTimeAsync(0);
    // The newer edit is saved straight after, with the revision the server just confirmed.
    expect(save).toHaveBeenNthCalledWith(1, "first", 5);
    expect(save).toHaveBeenNthCalledWith(2, "second", 6);
    // "Saved" appears exactly once, and only after the newest content was confirmed.
    const saved = states.filter((s) => s.status === "saved");
    expect(saved).toHaveLength(1);
    expect(saved[0].revision).toBe(7);
    expect(last()).toMatchObject({ status: "saved", revision: 7 });
  });

  it("reports an outage honestly, keeps the content and retries with backoff", async () => {
    const save = vi.fn().mockResolvedValueOnce({ ok: false, error: "offline" }).mockResolvedValueOnce({ ok: false, error: "offline" }).mockResolvedValue({ ok: true, revision: 6 });
    const { saver, last } = setup(save, { retryDelaysMs: [1000, 2000] });
    saver.queue("draft");
    await vi.advanceTimersByTimeAsync(800);
    expect(last()).toMatchObject({ status: "error", error: "offline" });
    expect(saver.hasUnsaved()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().status).toBe("error");
    await vi.advanceTimersByTimeAsync(2000);
    expect(last().status).toBe("saved");
    expect(save).toHaveBeenCalledTimes(3);
    expect(saver.hasUnsaved()).toBe(false);
  });

  it("stops saving the moment someone else has changed the document, and never overwrites theirs", async () => {
    const save = vi.fn().mockResolvedValueOnce({ ok: false, error: "changed elsewhere", conflict: true }).mockResolvedValue({ ok: true, revision: 99 });
    const { saver, last } = setup(save);
    saver.queue("mine");
    await vi.advanceTimersByTimeAsync(800);
    expect(last()).toMatchObject({ status: "conflict", error: "changed elsewhere" });
    saver.queue("more of mine");
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await saver.flush()).toBe(false);
    // After the editor reloads the other person's version, saving resumes from its revision.
    saver.reset(12);
    saver.queue("rebased");
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith("rebased", 12);
  });

  it("flush waits for everything and reports failure after one quick retry", async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: "down" }));
    const { saver } = setup(save, { retryDelaysMs: [] });
    saver.queue("x");
    expect(await saver.flush()).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    const ok = vi.fn(async (c: string, rev: number) => {
      void c;
      return { ok: true as const, revision: rev + 1 };
    });
    const b = setup(ok);
    b.saver.queue("y");
    expect(await b.saver.flush()).toBe(true);
    expect(await b.saver.flush()).toBe(true); // nothing pending: no extra request
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown request like a failed one and stops timers on dispose", async () => {
    const save = vi.fn().mockRejectedValue(new Error("boom"));
    const { saver, last } = setup(save, { retryDelaysMs: [] });
    saver.queue("x");
    await vi.advanceTimersByTimeAsync(800);
    expect(last().status).toBe("error");
    expect(last().error).toMatch(/couldn't be saved/);
    const idle = setup(vi.fn(async () => ({ ok: true as const, revision: 6 })));
    idle.saver.queue("z");
    idle.saver.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(idle.last().status).toBe("dirty");
  });
});
