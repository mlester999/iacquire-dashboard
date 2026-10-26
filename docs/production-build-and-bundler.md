# The production build and the Webpack investigation

Last measured: 2026-10-26, worktree `.data/wt-release-candidate`, on `integrate/phases-3-7-workforce`. Every number below comes from `node scripts/measure-build.mjs`, which samples the whole build process tree every three seconds and appends one JSON line per run to `tmp/build-measurements.jsonl` (untracked). Nothing here is an estimate.

## What was wrong, and what was not

The previous record said `next build --webpack` "runs out of memory at 3, 4 and 7 GB, and also at older commits that passed before", and left it as an open investigation. **That conclusion was half right, and the half that was wrong hid the half that was right.** The failure at the head the previous session measured was a *compile error*, not memory, and that is fixed. But a later run of the same gate (2026-10-26, 17:23) **did run out of memory at the machine's default cap**, so the old reports were not imaginary: the Webpack compiler keeps about 4 GB of V8 heap for this application, which is within a few percent of Node's default limit here, and it passes or fails by chance at the default. The first failure's signature was a *compile error*: an import trace from `src/components/invoices/credit-notes-panel.tsx` through `src/lib/invoices/credit-notes.ts` to `node:crypto`. A client component imported a module that reads `node:crypto`, which a browser bundle cannot contain. Turbopack had already refused the same shape in an earlier release (`tests/client-bundle-safety.test.ts` exists for exactly this), and the credit-note work shipped without a full suite run, so nothing caught it a second time.

The fix (commit `b2bff4c3`) moved the content hash into `src/lib/invoices/credit-hash.ts`, which only server code and tests import. With that one change, Webpack compiles.

## Measurements

| Build | Heap cap | Result | Wall time | Peak tree memory | Sampled at |
| --- | --- | --- | ---: | ---: | ---: |
| Turbopack (the deployment bundler), `node scripts/build-clean.mjs` | default | **passed** | 196 s | 4,470 MB | 193 s |
| Webpack, `--webpack` | default (before the fix) | failed — **compile error**, not memory | 290 s | 5,488 MB | 233 s |
| Webpack | 4,096 MB | **passed** | 384 s | 4,608 MB | 184 s |
| Webpack | 8,192 MB | **passed** | 383 s | 6,239 MB | 181 s |
| Webpack | default | **passed** | 405 s | 5,301 MB | 206 s |
| Webpack, the same default, at the release-candidate gate (17:23) | default (about 4.1 GB) | **failed: `FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory`, exit 134** | 248 s | n/a (log) | heap at 4,050 MB when it died |
| Webpack, `node scripts/build-clean.mjs --webpack` after the script sets an 8 GB cap itself | 8,192 MB (set by the script) | **passed** (first full gate chain of the verification session) | 320 s | 8,053 MB | 163 s |
| Webpack, the same capped script, one earlier attempt | 8,192 MB (set by the script) | compiled in 5.7 min, then **failed: `ENOSPC: no space left` writing `.tsbuildinfo`** (the disk was full; not memory, not code) | 467 s | 6,561 MB | 253 s |
| Turbopack, first full gate chain of the verification session | default | **passed** | 116 s | 4,954 MB | 114 s |
| Webpack, the capped script, second full gate chain (after the last code change; the table's last word) | 8,192 MB (set by the script) | **passed** | 416 s | 7,885 MB | 212 s |
| Turbopack, second full gate chain | default | **passed** | 147 s | 5,057 MB | 145 s |
| Webpack, final gate chain on the merged tree (release head `fa27b5bd`) | 8,192 MB (set by the script) | **passed** | 345 s | 8,489 MB | n/a |
| Turbopack, final gate chain on the merged tree | default | **passed** | 119 s | 5,902 MB | n/a |

Read together: the compile error is fixed, and what remains is a **margin of a few percent**. Webpack built at a 4 GB cap, at the default cap once and at 8 GB; at the default cap it also died once, 248 seconds in, with the heap at 4,050 MB. The earlier "3, 4 and 7 GB" reports are not reproduced as stated (a 3 GB cap was not retested, and 7 GB was never seen to fail again), but "Webpack passes at the default cap" is **not** a claim this document can make. The build script now gives Webpack an 8 GB cap itself (`scripts/build-clean.mjs`, only when the caller has not chosen one); Turbopack, which a deployment uses, needs none. Webpack needs roughly 4.5 to 6.2 GB of process-tree memory for this application, which is why a cap below that could genuinely fail on a smaller machine.

## Classification

* **Not a product defect.** The bundler is a build tool; a deployment uses Next's default (Turbopack) build, which passed in 196 s, in 215 s, in 116 s and in 147 s at the release-candidate gates, at 4.5 to 5.1 GB. Webpack builds only the QA app's output and the optional second check.
* **Not a reason to block a release.** Both builders now compile the same tree.
* **A test gap that is closed.** The credit-note defect was invisible to the suite because the suite was not run at that head. `tests/client-bundle-safety.test.ts` would have named the file and the import; it is in the full suite and is part of the gates.
* **A host fact worth keeping.** This machine builds Webpack in 5 to 8 minutes and peaks between 4.6 and 8.1 GB depending on the cap (the heap grows into whatever cap it is given), so two heavy builds must not run at once; `scripts/run-locked.mjs heavy` serialises them.

## Reproducing

```
node scripts/run-locked.mjs heavy -- node scripts/measure-build.mjs --label webpack-heap-8192 --heap 8192 --out tmp/build-measurements.jsonl -- node scripts/build-clean.mjs --webpack
node scripts/run-locked.mjs heavy -- node scripts/measure-build.mjs --label turbopack-default --out tmp/build-measurements.jsonl -- node scripts/build-clean.mjs
```

`--heap N` sets `NODE_OPTIONS=--max-old-space-size=N` for the build only. The script writes its output to `.next-clean-build` (never `.next`), pins the environment so no secret or hosted value is loaded, and type-checks with `tsconfig.clean.json`.

## Bundle size at this head (Webpack output, `.next-clean-build/static`)

| Measure | Value |
| --- | --- |
| JavaScript files | 672 |
| JavaScript, raw | 10.98 MB |
| Largest single chunk | 237 KB |
| CSS files | 7 |
| CSS, raw | 0.40 MB |

Raw sizes are what the browser downloads compressed; they are recorded so a future change has a baseline, not as a performance claim. No hosted measurement exists, and a measurement of the built assets is not a measurement of a page under load.
