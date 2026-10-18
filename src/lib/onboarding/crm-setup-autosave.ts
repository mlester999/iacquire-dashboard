// The CRM setup guide's autosave queue, free of React so it can be tested on its own. The screen (src/components/setup/crm-setup-guide.tsx)
// keeps one per mount.
//
//   - Saves run one after another, and each reads the guide revision only when it actually runs. Two quick "Next" clicks therefore send the
//     revision the first save returned, so the second isn't reported as coming from a stale tab.
//   - The guide's own actions that move the revision (the initial provider choice, the review hand-off) run in the same queue, after any
//     pending save, and the revision they return is adopted, so the next autosave isn't mistaken for a stale tab either.
//   - A page refresh never resets the revision: the screen keeps its own answers across a refresh, so taking the newer revision from the
//     refreshed page would hide a real change made in another tab.
import type { CrmSetupAnswers, CrmSetupStepKey } from "@/lib/onboarding/crm-setup";

export interface GuidePatch {
  currentStep?: CrmSetupStepKey;
  answers?: CrmSetupAnswers;
}

export type GuideSaveResult = { ok: true; revision: number; staleBase: boolean } | { ok: false; error: string };
export type GuideSaveState = "saving" | "saved" | "error";

export interface GuideAutosaveOptions {
  /** The revision the screen was rendered with (0 before the guide was first saved). */
  revision: number;
  save: (body: GuidePatch & { baseRevision: number }) => Promise<GuideSaveResult>;
  onState?: (state: GuideSaveState) => void;
  /** Someone else saved the guide in between (another tab or person). */
  onStale?: () => void;
  onError?: (message: string) => void;
}

export interface GuideAutosave {
  /** Adds to what will be saved, and saves after `delayMs` (0: as soon as the queue is free). */
  queue(patch: GuidePatch, delayMs: number): void;
  /** Saves whatever is queued now, after any save already running. Resolves when that save has finished. */
  flush(): Promise<void>;
  /**
   * Runs one of the guide's own actions in the save queue: after any pending save, and before any save queued meanwhile. The revision
   * `revisionOf` reads from its result (null when it failed) is adopted for the next save.
   */
  action<T>(run: () => Promise<T>, revisionOf: (result: T) => number | null | undefined): Promise<T>;
  /** The revision the next save will send. */
  readonly revision: number;
  /** What is queued and not yet saved. */
  pending(): GuidePatch;
}

/** Newer wins per field; answers merge, so answering one question never drops another that is still waiting. */
function merge(older: GuidePatch, newer: GuidePatch): GuidePatch {
  const out: GuidePatch = {};
  const step = newer.currentStep ?? older.currentStep;
  if (step) out.currentStep = step;
  if (older.answers || newer.answers) out.answers = { ...older.answers, ...newer.answers };
  return out;
}

export function createGuideAutosave(opts: GuideAutosaveOptions): GuideAutosave {
  let revision = opts.revision;
  let queued: GuidePatch = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // Never move backwards: a late, older result must not undo a newer revision.
  const adopt = (r: number | null | undefined) => {
    if (typeof r === "number" && Number.isFinite(r)) revision = Math.max(revision, r);
  };

  async function saveQueued(): Promise<void> {
    clearTimer();
    const body = queued;
    if (!body.currentStep && !body.answers) return;
    queued = {};
    opts.onState?.("saving");
    let res: GuideSaveResult;
    try {
      res = await opts.save({ ...body, baseRevision: revision });
    } catch {
      res = { ok: false, error: "Couldn't save. Check your connection and try again." };
    }
    if (!res.ok) {
      // Keep what wasn't saved for the retry; anything queued meanwhile is newer and wins.
      queued = merge(body, queued);
      opts.onState?.("error");
      opts.onError?.(res.error);
      return;
    }
    adopt(res.revision);
    opts.onState?.("saved");
    if (res.staleBase) opts.onStale?.();
  }

  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  }

  const flush = () => enqueue(saveQueued);

  return {
    get revision() {
      return revision;
    },
    pending: () => ({ ...queued }),
    queue(patch, delayMs) {
      queued = merge(queued, patch);
      clearTimer();
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    action(run, revisionOf) {
      return enqueue(async () => {
        await saveQueued();
        const out = await run();
        adopt(revisionOf(out));
        return out;
      });
    },
  };
}
