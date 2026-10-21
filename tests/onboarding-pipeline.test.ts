import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavePipeline, type PipelinePayload, type PipelineSaveResult, type PipelineState } from "@/lib/onboarding/save-pipeline";

const ok = (revision: number, rejected: Record<string, string> = {}): PipelineSaveResult => ({ ok: true, data: { revision, rejected, staleBase: false } });

function setup(save: (p: PipelinePayload) => Promise<PipelineSaveResult>, extra: { retryDelaysMs?: number[] } = {}) {
  const states: PipelineState[] = [];
  const pipeline = createSavePipeline({ save, onChange: (s) => states.push(s), baseRevision: 0, debounceMs: 600, ...extra });
  return { pipeline, states, last: () => states.at(-1)! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("onboarding autosave", () => {
  it("blocks exit for invalid local edits and removes the older queued value", async () => {
    const save = vi.fn(async (_payload: PipelinePayload) => ok(1));
    const { pipeline, last } = setup(save);
    pipeline.queue("a.contact_email", { value: "old@example.test" });
    pipeline.invalidate("a.contact_email", "That email address doesn't look right.");
    expect(await pipeline.flush()).toBe(false);
    expect(pipeline.hasUnsaved()).toBe(true);
    expect(last().status).toBe("error");
    expect(save).not.toHaveBeenCalled();
    pipeline.queue("a.contact_email", { value: "new@example.test" });
    expect(await pipeline.flush()).toBe(true);
    expect(save.mock.calls[0][0].answers["a.contact_email"].value).toBe("new@example.test");
  });

  it("does not report Saved when an older in-flight save completes after an invalid edit", async () => {
    let complete!: (value: PipelineSaveResult) => void;
    const { pipeline, last } = setup(() => new Promise((resolve) => { complete = resolve; }));
    pipeline.queue("a.contact_email", { value: "old@example.test" });
    const flushing = pipeline.flush();
    await vi.advanceTimersByTimeAsync(0);
    pipeline.invalidate("a.contact_email", "Check this email.");
    complete(ok(1));
    expect(await flushing).toBe(false);
    expect(last().status).toBe("error");
    expect(pipeline.hasUnsaved()).toBe(true);
  });

  it("never retries an older value over a newer invalid local edit", async () => {
    let complete!: (value: PipelineSaveResult) => void;
    const save = vi.fn((_payload: PipelinePayload) => new Promise<PipelineSaveResult>((resolve) => { complete = resolve; }));
    const { pipeline } = setup(save);
    pipeline.queue("a.contact_email", { value: "old@example.test" });
    const flushing = pipeline.flush();
    await vi.advanceTimersByTimeAsync(0);
    pipeline.invalidate("a.contact_email", "Check this email.");
    complete({ ok: false, error: "Offline" });
    expect(await flushing).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    expect(pipeline.hasUnsaved()).toBe(true);
  });
  it("waits for a pause in typing and then saves the latest value only once", async () => {
    const save = vi.fn(async (p: PipelinePayload) => {
      void p;
      return ok(1);
    });
    const { pipeline, last } = setup(save);
    pipeline.queue("a.business_name", { value: "B" });
    pipeline.queue("a.business_name", { value: "Br" });
    pipeline.queue("a.business_name", { value: "Brightside" });
    expect(last().status).toBe("dirty");
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].answers).toEqual({ "a.business_name": { value: "Brightside" } });
    expect(last().status).toBe("saved");
  });

  it("shows saving while the request is out and never shows saved before the server confirms", async () => {
    let release!: (r: PipelineSaveResult) => void;
    const save = vi.fn(
      () =>
        new Promise<PipelineSaveResult>((resolve) => {
          release = resolve;
        }),
    );
    const { pipeline, states, last } = setup(save);
    pipeline.queue("a.location", { value: "Austin" });
    await vi.advanceTimersByTimeAsync(600);
    expect(last().status).toBe("saving");
    expect(states.some((s) => s.status === "saved")).toBe(false);
    release(ok(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(last().status).toBe("saved");
    expect(last().savedAt).not.toBeNull();
  });

  it("reports failure honestly, keeps the unsent answer and retries with backoff until it works", async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "offline" })
      .mockResolvedValueOnce({ ok: false, error: "offline" })
      .mockResolvedValue(ok(3));
    const { pipeline, last } = setup(save, { retryDelaysMs: [1000, 2000] });
    pipeline.queue("a.location", { value: "Austin" });
    await vi.advanceTimersByTimeAsync(600);
    expect(last()).toMatchObject({ status: "error", error: "offline" });
    expect(pipeline.hasUnsaved()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().status).toBe("error");
    await vi.advanceTimersByTimeAsync(2000);
    expect(last().status).toBe("saved");
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2][0].answers).toEqual({ "a.location": { value: "Austin" } });
    expect(pipeline.hasUnsaved()).toBe(false);
  });

  it("treats a thrown request like a failed one", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(ok(2));
    const { pipeline, last } = setup(save, { retryDelaysMs: [] });
    pipeline.queue("a.location", { value: "Austin" });
    await vi.advanceTimersByTimeAsync(600);
    expect(last().status).toBe("error");
    expect(last().error).toMatch(/couldn't be saved/);
    expect(await pipeline.flush()).toBe(true);
    expect(last().status).toBe("saved");
  });

  it("flush saves immediately and resolves true only when everything is confirmed", async () => {
    const save = vi.fn(async (p: PipelinePayload) => {
      void p;
      return ok(1);
    });
    const { pipeline } = setup(save);
    pipeline.queue("a.location", { value: "Austin" });
    pipeline.setPosition("a.contact_phone");
    const done = pipeline.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual([{ answers: { "a.location": { value: "Austin" } }, currentQuestionId: "a.contact_phone", baseRevision: 0 }]);
    expect(await pipeline.flush()).toBe(true); // nothing pending: no extra request
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush reports failure after one quick retry so the caller does not move on", async () => {
    const save = vi.fn(async () => ({ ok: false, error: "down" }) as PipelineSaveResult);
    const { pipeline, last } = setup(save, { retryDelaysMs: [] });
    pipeline.queue("a.location", { value: "Austin" });
    expect(await pipeline.flush()).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(last().status).toBe("error");
    expect(pipeline.hasUnsaved()).toBe(true);
  });

  it("never lets an older request overwrite a newer one", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const save = vi.fn(async (p: PipelinePayload) => {
      const v = (p.answers["a.location"]?.value as string) ?? "";
      if (v === "first")
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
      order.push(v);
      return ok(order.length);
    });
    const { pipeline } = setup(save);
    pipeline.queue("a.location", { value: "first" });
    await vi.advanceTimersByTimeAsync(600); // first request is now out and blocked
    pipeline.queue("a.location", { value: "second" });
    const flushed = pipeline.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]); // second must wait for first
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(await flushed).toBe(true);
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps edits made while a failing request was in flight", async () => {
    let fail!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PipelineSaveResult>((r) => {
            fail = () => r({ ok: false, error: "x" });
          }),
      )
      .mockResolvedValue(ok(2));
    const { pipeline } = setup(save, { retryDelaysMs: [] });
    pipeline.queue("a.location", { value: "old" });
    await vi.advanceTimersByTimeAsync(600);
    pipeline.queue("a.location", { value: "newer" });
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(await pipeline.flush()).toBe(true);
    expect(save.mock.calls.at(-1)![0].answers).toEqual({ "a.location": { value: "newer" } });
  });

  it("surfaces answers the server refused and clears them when the user fixes the answer", async () => {
    const save = vi.fn(async () => ok(1, { "a.contact_phone": "Include the country code." }));
    const { pipeline, last } = setup(save);
    pipeline.queue("a.contact_phone", { value: "5125550100" });
    expect(await pipeline.flush()).toBe(false);
    expect(last().rejected).toEqual({ "a.contact_phone": "Include the country code." });
    expect(last().status).toBe("error");
    pipeline.queue("a.contact_phone", { value: "+15125550100" });
    expect(pipeline.getState().rejected).toEqual({});
  });

  it("passes the last known revision so stale devices can be detected", async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { revision: 7, rejected: {}, staleBase: true } })
      .mockResolvedValue(ok(8));
    const { pipeline, last } = setup(save);
    pipeline.queue("a.location", { value: "A" });
    await pipeline.flush();
    expect(last().staleBase).toBe(true);
    pipeline.queue("a.location", { value: "B" });
    await pipeline.flush();
    expect(save.mock.calls[0][0].baseRevision).toBe(0);
    expect(save.mock.calls[1][0].baseRevision).toBe(7);
  });

  it("stops timers on dispose", async () => {
    const save = vi.fn(async () => ok(1));
    const { pipeline } = setup(save);
    pipeline.queue("a.location", { value: "A" });
    pipeline.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
  });
});
