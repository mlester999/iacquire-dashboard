// Autosave for a whole document (the website draft). Only the newest version matters, saves go one at a time with the
// revision the server last confirmed, and "saved" is claimed only after the server confirms. If someone else changed the
// document, saving stops and the editor is told, instead of overwriting their work.

export type SaverStatus = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";
export interface SaverState {
  status: SaverStatus;
  error: string | null;
  revision: number;
  savedAt: number | null;
}
export type SaveOutcome = { ok: true; revision: number } | { ok: false; error: string; conflict?: boolean };

export interface DraftSaverOptions<T> {
  save: (content: T, expectedRevision: number) => Promise<SaveOutcome>;
  onChange: (state: SaverState) => void;
  revision: number;
  debounceMs?: number;
  retryDelaysMs?: number[];
}

export function createDraftSaver<T>(opts: DraftSaverOptions<T>) {
  const debounceMs = opts.debounceMs ?? 800;
  const retryDelays = opts.retryDelaysMs ?? [2000, 5000, 12000];
  let latest: { content: T } | null = null;
  let dirtyVersion = 0;
  let savedVersion = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let attempt = 0;
  let state: SaverState = { status: "idle", error: null, revision: opts.revision, savedAt: null };

  const set = (patch: Partial<SaverState>) => {
    state = { ...state, ...patch };
    opts.onChange(state);
  };

  const writeOnce = async (): Promise<boolean> => {
    if (state.status === "conflict") return false;
    if (!latest || dirtyVersion === savedVersion) return true;
    const sending = latest.content;
    const version = dirtyVersion;
    set({ status: "saving", error: null });
    let result: SaveOutcome;
    try {
      result = await opts.save(sending, state.revision);
    } catch {
      result = { ok: false, error: "Your changes couldn't be saved. Check your connection and try again." };
    }
    if (!result.ok) {
      if (result.conflict) set({ status: "conflict", error: result.error });
      else set({ status: "error", error: result.error });
      return false;
    }
    savedVersion = Math.max(savedVersion, version);
    // Edits made while this request was out are still waiting; they save next with the new revision.
    set({ status: dirtyVersion > savedVersion ? "dirty" : "saved", error: null, revision: result.revision, savedAt: Date.now() });
    if (dirtyVersion > savedVersion) return writeOnce();
    return true;
  };

  const serial = (): Promise<boolean> => {
    const run = chain.then(writeOnce, writeOnce) as Promise<boolean>;
    chain = run.catch(() => false);
    return run;
  };

  const scheduleRetry = () => {
    if (retryTimer || attempt >= retryDelays.length || state.status === "conflict") return;
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
    queue(content: T) {
      if (state.status === "conflict") return;
      latest = { content };
      dirtyVersion += 1;
      set({ status: "dirty", error: null });
      schedule();
    },
    /** Saves right now and resolves true only if everything is confirmed. */
    async flush(): Promise<boolean> {
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
      let ok = await serial();
      if (!ok && state.status === "error") ok = await serial();
      if (ok) attempt = 0;
      return ok && dirtyVersion === savedVersion;
    },
    /** After the page reloads the latest saved document, continue from its revision. */
    reset(revision: number) {
      latest = null;
      dirtyVersion = 0;
      savedVersion = 0;
      attempt = 0;
      set({ status: "idle", error: null, revision });
    },
    hasUnsaved: () => dirtyVersion !== savedVersion || state.status === "saving" || state.status === "error",
    getState: () => state,
    dispose() {
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
    },
  };
}
export type DraftSaver<T> = ReturnType<typeof createDraftSaver<T>>;
