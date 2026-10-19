import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The guidance store is browser code. It needs only fetch, window.location and document.body, so it
// is exercised here with a controllable fetch rather than a browser.
interface Call {
  url: string;
  body: Record<string, unknown> | null;
  respond: (json: unknown, ok?: boolean) => void;
}

const calls: Call[] = [];

function progress(step: number, status = "in_progress") {
  return { tutorialId: "t1", slug: "tour", title: "Tour", status, currentStep: step, stepCount: 3, tutorialVersion: 1, publishedVersion: 1, startedAt: "2026-10-19T00:00:00Z", lastActivityAt: "2026-10-19T00:00:00Z", completedAt: null, verified: false, versionChanged: false };
}

const tutorial = {
  id: "t1", slug: "tour", title: "Tour", description: "", category: "Getting started", routePrefix: "/overview", roles: [], priority: 1, version: 1, versionId: "v1", stepCount: 3,
  estimatedMinutes: 2, requiresCrm: null, aliases: [], keywords: [],
  steps: [
    { key: "a", title: "A", body: "a", targetId: null, route: null },
    { key: "b", title: "B", body: "b", targetId: null, route: null },
    { key: "c", title: "C", body: "c", targetId: null, route: null },
  ],
  completion: { kind: "finish" },
};

async function loadStore() {
  vi.resetModules();
  return import("@/components/aqi/tutorial/tutorial-store");
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function started(store: Awaited<ReturnType<typeof loadStore>>) {
  const starting = store.startTutorial("tour", "library");
  await flush();
  calls[0].respond({ tutorial, progress: progress(0), resumed: false });
  await starting;
  calls.length = 0;
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("window", { location: { pathname: "/overview" } });
  vi.stubGlobal("document", { body: { dataset: {} } });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => new Promise((resolve) => {
    calls.push({
      url,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      respond: (json, ok = true) => resolve({ ok, status: ok ? 200 : 500, json: async () => json }),
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guidance store progress actions", () => {
  it("shows Next at once and keeps the server's confirmed step", async () => {
    const store = await loadStore();
    await started(store);
    const next = store.tutorialActions.next();
    // The new step is visible before the save returns.
    expect(store.currentGuidance().stepIndex).toBe(1);
    expect(store.currentGuidance().busy).toBe(true);
    await flush();
    expect(calls[0].body?.action).toBe("next");
    calls[0].respond({ progress: progress(1), status: "in_progress", verified: false });
    await next;
    expect(store.currentGuidance().stepIndex).toBe(1);
    expect(store.currentGuidance().busy).toBe(false);
    expect(store.currentGuidance().phase).toBe("active");
  });

  it("returns to the last confirmed step with a retry when the save fails", async () => {
    const store = await loadStore();
    await started(store);
    const next = store.tutorialActions.next();
    expect(store.currentGuidance().stepIndex).toBe(1);
    await flush();
    calls[0].respond({ error: "Could not save" }, false);
    await next;
    expect(store.currentGuidance().stepIndex).toBe(0);
    expect(store.currentGuidance().phase).toBe("error");
    expect(store.currentGuidance().error).toBe("Could not save");
  });

  it("never drops a Pause pressed while a Next is still being saved", async () => {
    const store = await loadStore();
    await started(store);
    const next = store.tutorialActions.next();
    // The stage reports the new step as viewed right away; that analytics call must not hide the pending save.
    void store.tutorialActions.viewed(1);
    const pause = store.tutorialActions.pause();
    await flush();
    // The Next and the fire-and-forget view have gone out; the Pause waits its turn instead of being ignored as busy.
    expect(calls.map((call) => call.body?.action)).toEqual(["next", "viewed"]);
    calls[0].respond({ progress: progress(1), status: "in_progress", verified: false });
    await next;
    await flush();
    expect(calls.map((call) => call.body?.action)).toEqual(["next", "viewed", "pause"]);
    calls[2].respond({ progress: progress(1, "paused"), status: "paused", verified: false });
    await pause;
    expect(store.currentGuidance().phase).toBe("paused");
    expect(store.currentGuidance().stepIndex).toBe(1);
  });

  it("does not move on the last step: completion always waits for the server", async () => {
    const store = await loadStore();
    await started(store);
    const first = store.tutorialActions.next();
    await flush();
    calls[0].respond({ progress: progress(1), status: "in_progress", verified: false });
    await first;
    const second = store.tutorialActions.next();
    await flush();
    calls[1].respond({ progress: progress(2), status: "in_progress", verified: false });
    await second;
    expect(store.currentGuidance().stepIndex).toBe(2);
    const finish = store.tutorialActions.next();
    // The last step is not advanced optimistically.
    expect(store.currentGuidance().stepIndex).toBe(2);
    expect(store.currentGuidance().phase).toBe("active");
    await flush();
    calls[2].respond({ progress: progress(2, "completed"), status: "completed", verified: false, message: "Walkthrough finished." });
    await finish;
    expect(store.currentGuidance().phase).toBe("completed");
    expect(store.currentGuidance().verified).toBe(false);
  });

  it("acknowledges a start immediately and hands over when the walkthrough opens", async () => {
    const store = await loadStore();
    const starting = store.startTutorial("tour", "library");
    expect(store.currentGuidance().phase).toBe("starting");
    expect(store.currentGuidance().open).toBe(false);
    await flush();
    calls[0].respond({ tutorial, progress: progress(0), resumed: false });
    await starting;
    expect(store.currentGuidance().open).toBe(true);
    expect(store.currentGuidance().phase).toBe("active");
    expect(store.currentGuidance().stageReady).toBe(false);
  });
});
