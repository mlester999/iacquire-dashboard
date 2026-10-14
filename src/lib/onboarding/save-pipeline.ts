// Autosave for the questionnaire. It never claims "saved" until the server has confirmed the write,
// writes one request at a time (so an older save can never overwrite a newer one), retries with
// bounded backoff, and lets the caller wait for everything pending before moving on.
import type { AnswerSource, AnswerValue } from "./types";

export interface PipelineAnswer {
  value?: AnswerValue;
  skipped?: boolean;
  source?: Exclude<AnswerSource, "prefill">;
  confirmed?: boolean;
}
export interface PipelinePayload {
  answers: Record<string, PipelineAnswer>;
  currentQuestionId?: string;
  baseRevision?: number;
}
export interface PipelineSaved {
  revision: number;
  rejected: Record<string, string>;
  staleBase: boolean;
}
export type PipelineSaveResult = { ok: true; data: PipelineSaved } | { ok: false; error: string };

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
export interface PipelineState {
  status: SaveStatus;
  error: string | null;
  savedAt: number | null;
  /** Server-side validation messages for answers that were refused, by question id. */
  rejected: Record<string, string>;
  staleBase: boolean;
}

export interface PipelineOptions {
  save: (payload: PipelinePayload) => Promise<PipelineSaveResult>;
  onChange: (state: PipelineState) => void;
  baseRevision?: number;
  debounceMs?: number;
  /** Delays before each automatic retry of a failed background save. */
  retryDelaysMs?: number[];
}

export function createSavePipeline(opts: PipelineOptions) {
  const debounceMs = opts.debounceMs ?? 600;
  const retryDelays = opts.retryDelaysMs ?? [1500, 4000, 10000];
  let pending: Record<string, PipelineAnswer> = {};
  let position: string | undefined;
  let revision = opts.baseRevision;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  let attempt = 0;
  let state: PipelineState = { status: "idle", error: null, savedAt: null, rejected: {}, staleBase: false };

  const set = (patch: Partial<PipelineState>) => {
    state = { ...state, ...patch };
    opts.onChange(state);
  };
  const hasPending = () => Object.keys(pending).length > 0 || position !== undefined;

  /** One request: take what is pending, send it, and put it back if the server did not confirm it. */
  const writeOnce = async (): Promise<boolean> => {
    if (!hasPending()) return true;
    const sent = pending;
    const sentPosition = position;
    pending = {};
    position = undefined;
    inFlight += 1;
    set({ status: "saving", error: null });
    let result: PipelineSaveResult;
    try {
      result = await opts.save({ answers: sent, currentQuestionId: sentPosition, baseRevision: revision });
    } catch {
      result = { ok: false, error: "Your progress couldn't be saved. Check your connection and try again." };
    }
    inFlight -= 1;
    if (!result.ok) {
      // Keep the unsent changes, but never overwrite anything the user changed while this request was out.
      pending = { ...sent, ...pending };
      position = position ?? sentPosition;
      set({ status: "error", error: result.error });
      return false;
    }
    revision = result.data.revision;
    const rejected = result.data.rejected;
    set({
      status: Object.keys(rejected).length ? "error" : hasPending() ? "dirty" : "saved",
      error: Object.keys(rejected).length ? "Some answers need attention before they can be saved." : null,
      savedAt: Date.now(),
      rejected: { ...state.rejected, ...rejected },
      staleBase: result.data.staleBase,
    });
    return Object.keys(rejected).length === 0;
  };

  const serial = (): Promise<boolean> => {
    const run = chain.then(writeOnce, writeOnce) as Promise<boolean>;
    chain = run.catch(() => false);
    return run;
  };

  const scheduleRetry = () => {
    if (retryTimer || attempt >= retryDelays.length) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      attempt += 1;
      if (await serial()) attempt = 0;
      else scheduleRetry();
    }, retryDelays[attempt]);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (await serial()) attempt = 0;
      else scheduleRetry();
    }, debounceMs);
  };

  return {
    /** Records the latest value for a question. Later calls for the same question replace earlier ones. */
    queue(id: string, answer: PipelineAnswer) {
      pending = { ...pending, [id]: answer };
      const { [id]: _cleared, ...rest } = state.rejected;
      void _cleared;
      set({ status: "dirty", error: null, rejected: rest });
      schedule();
    },
    setPosition(id: string) {
      position = id;
      if (state.status === "idle" || state.status === "saved") set({ status: "dirty" });
      schedule();
    },
    /**
     * Saves everything pending right now and resolves true only if the server confirmed it all.
     * One immediate retry covers a brief network hiccup; longer outages leave the state as "error".
     */
    async flush(): Promise<boolean> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      let ok = await serial();
      if (!ok && hasPending() && !Object.keys(state.rejected).length) ok = await serial();
      if (ok) attempt = 0;
      return ok && !hasPending() && inFlight === 0;
    },
    hasUnsaved: () => hasPending() || inFlight > 0 || state.status === "error",
    getState: () => state,
    dispose() {
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
    },
  };
}
export type SavePipeline = ReturnType<typeof createSavePipeline>;
