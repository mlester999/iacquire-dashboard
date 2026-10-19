# AQi Phase 3: UX polish, performance and navigation fixes

This pass polishes the existing AQi implementation. It adds no migration, no new table and no new
feature area. Everything from Phase 2 and the Phase 3 hardening (`d6204e6`) is preserved.

**Status words used below.** *Implemented locally* means the code is in the working tree and
committed on a local branch. *Unit/integration verified* means a vitest test runs it against the real
migrations on PGlite. *Browser verified* means the isolated QA server in real Chromium. *Staging
verified* and *Production deployed* are **not claimed anywhere in this document**: nothing was
pushed, deployed, or applied to a hosted database in this pass.

## 1. Git, branch and migration state (verified at the start, then re-checked)

| Fact from the brief | What was found |
| --- | --- |
| Hardening is commit `d6204e6` on `aqi/phase3-hardening` | True. `git merge-base --is-ancestor d6204e6 HEAD` succeeded at the start and at the end, so it was **not re-integrated or duplicated**. |
| Hardening was not pushed or deployed | **Not current.** At the end of this pass `origin/master` (`f2165c4`) contains `d6204e6`, and `docs/aqi-phase3.md` says the hardening merge is deployed to production on 2026-10-19. That happened in another session during this work; **this pass pushed nothing, deployed nothing and applied nothing.** |
| Migration `0063` is local/pending | **Not current.** `docs/verification-status.md` and `docs/aqi-phase3-staging-acceptance.md` record `0061` and `0063` as applied to hosted Supabase on 2026-10-19 after custom-format backups. This was read from the repository's own records; the hosted ledger was **not** queried here. No migration was added, renumbered or applied by this pass. |
| Master pushes deploy production | Respected: this branch is not on `master` and was not pushed. |

While this work ran, another Claude session in the same checkout merged `origin/master` into
`aqi/phase3-hardening`, fast-forwarded local `master`, switched the checkout to `master`, committed
the native-first client-surface work and release docs there, and pushed it. Those commits and the
unrelated untracked files (`docs/hermes-production-cutover.md`, `scripts/hermes-cutover/`, `dist/`,
`output/`, `tmp/`, `scripts/__pycache__/`, `scripts/build_iacquire_system_guide.py`) were left alone.
The AQi polish is committed on its own branch, `aqi/phase3-ux-polish`, cut from that `master`, so it
can be reviewed, tested on staging, or discarded independently. One unmerged commit exists on
`aqi/conversation-lifecycle` (a docs-only verification note in another worktree); it was not touched.

## 2. Root causes (each reproduced before fixing)

Baseline screenshots and timings are in `.data/aqi-ux-qa/before*/` (git-ignored).

| # | Symptom | Confirmed root cause |
| --- | --- | --- |
| A | Large tutorial card in the top-left corner | A step on another page has no highlight target, so the card had **no coordinates** and no width: it rendered absolutely at (0, 0) at its natural width (808 px at 1440, the full viewport at 768). Measured on the unmodified build: card at x=0, y=0, 808 x 192. |
| A2 | Card hidden or flashing at (24, 24) | When a target existed but the position was not yet computed the card was given `opacity: 0` in its style, but the animation library then animated opacity to 1, overriding it: the card was visible at the default position before jumping. |
| A3 | The tour card was not visible at all after "Take a quick guided tour" | The chat panel (z-index raised above the spotlight on purpose) stayed open and sat on top of the card: over the target area on desktop, over the whole screen on a phone. Playwright could not even click Next on mobile. |
| B | Starting guidance feels slow | Measured breakdown after the server replied (about 70 ms): the stage took a further **~320 ms** to mount. That constant is React's 300 ms Suspense reveal throttle: `next/dynamic` suspends on first render even when the chunk is already loaded. The Next button also waited for a server round trip before the screen changed. |
| C | Welcome popup cramped | 12 px type, three actions wrapping onto two lines, a 12 px gap to the launcher, no relationship to it, 3.7 to 4.0 s before it appeared (a 1.8 s timer plus a second request), and a hard-coded offset that overlapped the launcher on chat pages (where the launcher is raised). |
| D, E | `[Team]`, `[Integrations](Settings → Integrations)`, `[AI Workforce](AI Workforce)` shown raw | Three causes. (1) **Prompt**: the model was told to "use a markdown link with the human page name", but the list of real routes was only supplied for navigation-style questions, so for everything else it invented destinations. (2) **Stored knowledge** (`0047_aqi_assistant.sql`) names pages as "Settings → Team", which the model copied into the parentheses. (3) **Rendering**: CommonMark does not parse a destination containing spaces, so these were printed literally, and both the server normaliser and the browser only handled `(/path)` links without spaces, and never bare `[Label]`. |
| F | Unstable positioning and transitions | The placement was recomputed in a layout effect that re-created its observers on every scroll frame, did not account for a pinned header or the launcher, ignored a target moving without a DOM mutation (a collapsing sidebar), and revealed the spotlight while a smooth scroll was still moving. |

## 3. What changed

### Chat: navigation and Markdown

* `src/lib/aqi/navigation-links.ts` (new, pure, shared by server and browser). Maps page references
  to verified links. Rules: only routes from the curated registry that this person can open can
  become links; a model-supplied destination is never trusted; prose destinations ("Settings → Team",
  "AI Workforce") and bare `[Team]` are mapped **only when unambiguous** (a page that exists in both
  the workspace and the agency area, such as Integrations, resolves only with a hint or a matching
  current page); anything else becomes readable words. Code spans, fenced blocks and images are
  never touched. `javascript:`, `data:`, `vbscript:`, protocol-relative and external URLs never
  become links (external links are removed, as before). A redundant "(Settings → Team)" after a
  linked page name is dropped. Handles an unfinished link while streaming by holding the tail back.
* `src/server/aqi/service.ts`. `normalizeAqiLinks` now delegates to the shared module (so saved
  answers **and** the history loader are normalised the same way, and a stored message is never
  rewritten: tested). The welcome payload carries `navigation` (the pages this person may open) so the
  browser can show verified links while an answer is still streaming.
* `src/components/aqi/aqi-widget.tsx`. New memoised `AqiAnswer`; compact `prose-aqi` typography
  (13.5 px, tighter lists and headings, links with a thin underline and a visible focus ring); long
  words and code wrap or scroll inside the bubble; auto-scroll no longer animates per token; the
  writing cursor is decorative with a real status for assistive technology (axe flagged
  `aria-label` on a bare span); on a phone, following an in-app link closes the sheet that covers
  the page.
* `src/components/markdown.tsx`. Keyboard-reachable code blocks and tables (axe
  `scrollable-region-focusable`), tables keep real table semantics inside a scroll wrapper, a
  hardened `safeHref`.
* `src/lib/aqi/routes.ts`. Added Contacts, Pipelines, Calendar and Inbox with the same permissions the
  pages enforce (`contacts.view`, `sales.view`, `appointments.view`, `inbox.view`), so "Contacts" can
  be linked.

### DeepSeek / model instructions (non-editable, below the immutable policy)

Super Admin draft, publish and version history are unchanged; the editable `instructions`, tone and
role guidance are still applied. Three fixed blocks were added so editable text cannot reintroduce
the problem:

* The authorized pages list is now supplied for **every substantive turn** (not greeting, thanks or a
  clarification), compactly, with descriptions only when links were asked for.
* A navigation rule: link the page name using a path copied exactly from the list, nothing else in
  the parentheses (no names, no breadcrumbs, no URLs), never a bracketed name without a path, never a
  raw route (`never write a raw route` is retained for the existing test), and rephrase menu paths
  from knowledge ("Settings → Team") in words.
* Conversation rules: answer the actual question first in plain words; match length to the question
  (a greeting is one or two short sentences; a how-to is a few steps; "explain the CRM" gets a full,
  well-organised answer); no filler, no re-introduction, no pasted documentation; Markdown only for
  bold, simple lists and page links; one clarifying question when unclear; never claim an action
  or a capability the knowledge does not support.

**Not verified:** real DeepSeek output. The QA environment has no provider (AQi reports it as
unavailable), so the prompt is verified by tests that capture the exact system prompt and by the
pipeline tests that feed a malformed model reply through the real server code. How a live model
responds to the new rules needs a staging check (section 8).

### Walkthrough card, spotlight and positioning

* `placement.ts` (new, pure, unit-tested): chooses right, below, left, above by the real space,
  never covers the target when any side can hold the card, parks in a corner that avoids the
  launcher when none can, keeps clear of a pinned header, and returns a pointer offset.
* `target-observer.ts`: waits for the target rectangle to hold still for two frames before the first
  report (a dialog or sidebar animating in is not highlighted mid-move), follows transitions and
  scrolling with an observer that samples briefly and then idles, reports a target that leaves the
  page, measures a pinned header, scrolls into the free band (below the header, above a phone sheet).
* `tutorial-stage.tsx` (rewritten): the card has **no default position**. It stays `visibility:
  hidden` until measured, is positioned with a transform, fades in, slides only when a step changes,
  and the spotlight (a cut-out via a spread shadow, so the control itself stays bright; positioned
  with a transform) appears only after the page has stopped scrolling. A step on another page
  highlights the real navigation item when it is on screen and otherwise docks beside the launcher;
  a phone gets a bottom sheet with safe-area padding and the target scrolled above it. A compact
  design: tutorial title, "Step n of N" with progress, one heading, one or two lines, Exit and
  Back/Next. Missing-target, error and update states use friendly copy with Retry, Skip (only when the
  step is optional) and Exit, and no stack traces.
* Starting a walkthrough closes the chat panel (it reopens from the launcher, above the spotlight, as
  before) and shows a "Starting your walkthrough" card within about 20 ms that hands over to the
  walkthrough card. It gives up after 10 s rather than spinning.

### Welcome, tip and "resume" prompts

* `guidance-card.tsx` (new shared shell) anchored to the launcher through CSS variables the launcher
  publishes (so it follows the raised position on chat pages), 14 px gap, a pointer toward the
  launcher, 13 to 14 px type, a primary action, a ghost action and a quiet third action, a short fade
  (none under reduced motion).
* Copy: "New to iAcquireOS?" / "Want a quick tour? I'll show you around." / Start tour, Maybe later,
  Don't show again.
* The welcome now uses the eligibility the guidance request already returns (it previously made a
  second request and re-ran the same eligibility), no longer waits a fixed 1.8 s, is offered at most
  once per page session, waits out a form being edited or a modal dialog, never shows over an open
  chat panel, a walkthrough, or a resume prompt, and closes immediately on a choice (the choice is
  saved in the background).

### Performance (server and client)

* The stage chunk is fetched while the browser is idle and rendered directly instead of through
  `next/dynamic` (removes the 300 ms Suspense throttle).
* Next and Previous show the new step in the same tick; the server stays the record. A failed save
  returns to the last confirmed step with a retry, so the screen never claims saved progress. The
  last step is **not** optimistic: completion still waits for the server (and for the CRM for a
  created-contact walkthrough). Pause and Exit wait behind an in-flight save instead of being
  dropped (a race found by the regression suite).
* The chat widget subscribes to the two guidance fields it uses instead of the whole snapshot, and
  the "panel open" flag lives in its own tiny store, so opening the panel or stepping a tour no
  longer re-renders the large widget (a second render on open was measured and removed).
* Server: the guidance bootstrap computes tutorial eligibility once instead of three times, looks up
  CRM ownership only when a tutorial actually needs it and with its two reads together, and the
  start events are written in the same transaction as the progress row. None of this changes who can
  see what. Measured only on local PGlite, where each query is microseconds; the benefit on a hosted
  database is fewer round trips and is **not measured**.

## 4. Measured performance

Setup: isolated QA server (`scripts/crm-qa.mjs`, Next **development** server, embedded PGlite, local
synthetic sign-in), headless Chromium, 1440x900 and 390x844, fictional data, routes and every AQi API
route called once before measuring (a dev server compiles on first request). Timings are taken in
the page (`performance.now()`, per-frame probes and User Timing marks). "Throttled" is Chromium's
4x CPU slowdown plus 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up, applied after the page loads (a dev
server ships several MB of unminified script, so throttling the load itself measures the dev bundle).
Absolute numbers are inflated by the dev server; compare before to after only. **Before** is a single
clean run on the unmodified build; **after** is the median (min to max) of three runs.

All values are milliseconds unless stated. "n/a" means the baseline could not measure it (on the
unmodified phone layout the walkthrough card sat underneath the open chat panel, so Next could not
even be clicked).

**Desktop, 1440 x 900**

| Measure | Before | After | Before, throttled | After, throttled |
| --- | --- | --- | --- | --- |
| Cold AQi open (panel visible) | 46 | 47 (43-48) | 263 | 147 (147-158) |
| Warm reopen | 44 | 41 (32-42) | 137 | 102 (101-103) |
| Start tour: first visible feedback | n/a (none) | 8 (8-9) | n/a (none) | 65 (61-78) |
| Start tour: walkthrough card visible | n/a (card hidden behind chat panel) | 141 (141-163) | n/a | 593 (588-596) |
| Start tour: first spotlight | 444 | 109 (108-142) | 1489 | 494 (494-505) |
| Next step: new step shown | 188 | 11 (11-12) | 674 | 91 (91-92) |
| Next step: new spotlight | 188 | 54 (53-55) | 674 | 194 (191-201) |
| Pause then resume | 140 | 139 | 745 | 333 (322-333) |
| Layout shift (CLS) | 0.0818 | 0.0002 | 0.0818 | 0.0002 |

**Phone, 390 x 844**

| Measure | Before | After | Before, throttled | After, throttled |
| --- | --- | --- | --- | --- |
| Cold AQi open (panel visible) | 74 | 46 (44-48) | 186 | 148 (144-148) |
| Warm reopen | 55 | 43 (33-46) | 144 | 116 (115-117) |
| Start tour: first visible feedback | 508 (the covered card) | 9 | 1813 | 61 (61-62) |
| Start tour: walkthrough card visible and **not covered** | n/a (covered) | 439 (424-441) | n/a (covered) | 834 (810-887) |
| Start tour: first spotlight | 450 | 407 (393-409) | 1563 | 789 (763-833) |
| Next step: new step shown | n/a | 12 (11-14) | n/a | 89 (79-102) |
| Next step: new spotlight (includes the page scrolling the target above the sheet) | n/a | 572 (569-573) | n/a | 721 (708-757) |
| Pause then resume | n/a | 138 (137-138) | n/a | 339 (337-374) |
| Layout shift (CLS) | n/a | 0.0013 | n/a | 0.0013 |

**Where the time went (desktop, ms after the click, before this change):** server replied at about
70, the stage mounted at about 390 (React's 300 ms Suspense throttle plus rendering), the spotlight
appeared at about 444. **After:** server replied at 50 to 73, stage mounted at 62 to 86, target found
at 89 to 122, card shown at 101 to 136. The stage chunk is already in memory about 4.2 s before the
click (idle preload).

**What these numbers do and do not show.** They show a large, consistent improvement in start-up
and step changes, an elimination of the unplaced-card flash (no frame in which the card was visible
near the top-left corner, maximum jump 0 px over every sampled run) and a drop in layout shift. The
open-panel numbers are essentially unchanged on a normal CPU. Under CPU throttling the "after" cold
open is lower than the single "before" sample, but that baseline is one sample and throttled
samples vary by hundreds of milliseconds between identical runs, so this is not claimed as an
improvement. One real regression introduced and fixed during the work: publishing "panel open" through
the shared guidance store re-rendered the large widget a second time on open (cold open under
throttle went from 263 to 646 ms); it now lives in its own store. The phone spotlight time is
dominated by the page scrolling the target above the bottom sheet (smooth, about 270 ms plus a
160 ms settle) and is unchanged in kind from before.

## 5. Tests and browser acceptance

### Automated (vitest, real migrations on PGlite)

* Full suite: **184 files, 3,042 tests, all passing**. `tsc --noEmit` clean. `npm run build` passes. `eslint .`: 0 errors
  (one warning in another session's untracked `tmp/sales-diag.mjs`).
* New: `aqi-navigation-links.test.ts` (16: tests A to E, H and the streaming prefix property F,
  ambiguity, idempotence, raw paths, pathological input), `aqi-answer-pipeline.test.ts` (6: a real
  server turn with a replaced model: malformed references become verified links before saving, the
  stored row equals what is shown, a greeting gets no route list and no sources, a member gets no
  link to a page they cannot open, history shows old malformed messages readably **without changing
  the stored row** (test G), the browser receives the same page list as the server),
  `aqi-tutorial-placement.test.ts` (12), `aqi-tutorial-store.test.ts` (5: Next is shown at once, a
  failed save returns to the confirmed step, a Pause pressed during a save is never dropped, the last
  step is never optimistic, a start is acknowledged immediately).

### Browser (Chromium against the isolated QA server, fictional data)

* `scripts/aqi-ux-qa.mjs`: **62/62** (cross-page card at 390, 768, 1024 and 1440 is compact, inside the
  viewport, never near the top-left in any frame, does not cover its own target, axe clean;
  onboarding popup does not overlap the launcher, sits at least 8 px above it, stays on screen, axe
  clean; chat Markdown through a streamed reply split at arbitrary byte boundaries: no raw
  `[Label]` or `(Settings → …)`, only real routes link, an unauthorized admin route is not a link,
  `javascript:` is not a link, brackets inside code stay literal, `[bracket]` is preserved,
  external links open with `noopener`, list/bold/code/quote/table render, axe clean).
* The existing Phase 3 suite `scripts/aqi-guidance-browser-qa.mjs`, run per scenario group because
  the dev QA server restarts itself under memory pressure: desktop 14/14 (including a **real CRM
  contact created and "Action verified" only after the contact page exists**), resume 5/5, mobile
  6/6, 1024 and 768 tablet 16/16 including the KPI highlight, tablet modal 4/4, keyboard 5/5 (Enter
  advances, Escape pauses without losing progress, focus returns, live region), network failure 3/3
  (friendly error, retry completes), admin 12/12. **65/65**. That suite's expectations were updated for
  the new copy ("New to iAcquireOS?", "That didn't save") and to measure the card after its short
  slide has settled; no assertion was weakened.
* Screenshots were inspected by eye, not only asserted (`.data/aqi-ux-qa/before*` and
  `.data/aqi-ux-qa/final-ui/screens/`): the reported top-left panel, the cramped welcome and the raw
  `[Team]` text were reproduced on the unmodified build and are gone.

### Requirement status

| Requirement | Status | Level of evidence |
| --- | --- | --- |
| Reconcile git state, preserve `d6204e6` | PASS | Already an ancestor; nothing duplicated |
| Malformed page references (D, E) | PASS | Unit/integration + browser |
| Verified, authorized clickable navigation | PASS | Unit/integration + browser |
| Reliable Markdown, streaming, history | PASS | Unit/integration + browser (history through the real loader, not clicked through the History screen) |
| Natural DeepSeek replies and instructions | PARTIAL | Prompt content tested; **no live model run** |
| Chat presentation | PASS | Browser + screenshots |
| Tutorial card position, compact design, positioning engine | PASS | Unit (pure placement) + browser at 4 widths |
| Welcome popup | PASS | Browser at 4 widths |
| Mobile and tablet guidance | PASS | Browser at 390, 768, 1024; phone is a bottom sheet |
| Loading performance | PASS (dev server only) | Measured before/after, see section 4 |
| Flicker and unstable transitions | PASS | Per-frame trace: no unplaced frame, 0 px jump; CLS 0.0818 to 0.0002 |
| Error recovery | PASS | Browser (missing target and failed save paths); friendly copy, Retry/Skip/Exit |
| Accessibility | PARTIAL | Automated and keyboard verified; **no manual screen-reader run** |
| Preserve hardening and Phase 2/3 features | PASS | Full suite plus the 65-check Phase 3 browser suite |
| Production build | PASS | `npm run build` compiles and type-checks. A first attempt failed only in the type-check step because the live QA dev server's transient `.next-crm-qa` type files are matched by `tsconfig.json`; stop that server before building |
| Staging verified / Production deployed | **Not claimed** | No staging run; nothing deployed by this pass |

## 6. Accessibility

* axe-core (WCAG 2.0/2.1 A and AA, serious and critical) on: the cross-page card, the anchored card, a
  modal-target step, the onboarding popup, the chat with rich Markdown, at 390, 768, 1024 and 1440
  where the scenario applies: **0 violations**. Baseline had two real ones (a scrollable `pre` that
  keyboard users could not reach, and `aria-label` on a bare span); both fixed.
* Keyboard: Enter on Next, Escape pauses without losing progress, focus returns to the AQi surface
  (`aqi-guidance-browser-qa.mjs`, with reduced motion on). Code blocks and tables take focus.
* The card is a non-modal `dialog` with a title and description, announces each step through a live
  region that is outside the card (so it speaks even while the card is being placed), honours
  `prefers-reduced-motion` (no fade, no slide, instant scroll), and uses a visible focus ring.
* **Not done:** manual screen-reader testing (NVDA, VoiceOver, TalkBack) and touch hardware. Do not
  read this as screen-reader verified.

## 7. Limitations

* Dev-server timings only; no production build was driven in a browser (the isolated QA guard
  refuses production mode by design).
* Real DeepSeek behaviour is untested (no provider in the QA environment).
* Hosted database effect of the server changes is unmeasured; hosted migration state was taken from
  the repository's records, not queried.
* Run-to-run noise is large under CPU throttling (cold open ranged several hundred milliseconds
  between identical runs), so small differences there are not evidence either way.
* The Next.js development indicator overlaps the bottom-left of screenshots; it does not exist in a
  production build.
* A history message that already contains `[Label](Settings → Team)` is displayed readably, but a
  conversation saved before this change keeps its stored text; copying it copies the normalised
  display text.

## 8. Staging acceptance requirements

Nothing below has been run. Deploy this branch to a **staging** environment (never production), then:

1. `npm ci && npm run build` on the branch; confirm the build is clean. No migration is part of this
   change; do not apply or renumber anything (`0061`, `0063` are recorded as applied hosted already;
   run the read-only check in `aqi-phase3-staging-acceptance.md` section 3 against the staging copy).
2. With a **real DeepSeek key in staging only**, as an owner: ask "hey" (one short sentence, no
   links, no Sources block), "Where do I manage integrations?" (one sentence, Integrations is a link
   that opens Settings → Integrations), "How do I add a contact?" (concise steps plus a Show me how
   offer and a Contacts link), "Explain the complete CRM" (a full, structured answer). Confirm no raw
   `[Label]`, no `(Settings → …)`, no `[K1]`, no route string.
3. As a member without Integrations access, repeat "Where do I manage integrations?": plain words, no
   link. As a client, ask for an admin page: no link.
4. Reload old saved conversations that contain malformed links: readable, and the database row is
   unchanged.
5. Real browser, desktop and a real phone: start the tour from the chat; the chat closes, the card
   appears beside its target, Next is instant, a cross-page step highlights the menu item, Pause,
   Resume, refresh and Exit restore the right step, a missing control shows the friendly message.
6. Create a real contact through the walkthrough and confirm "Action verified" only after the CRM
   record exists.
7. Production build timings: repeat the Section 4 measurements against the staging build with
   realistic latency.
8. A person using a screen reader walks the tour and the chat.

## 9. Reproducing the evidence

```bash
node scripts/crm-qa.mjs                      # isolated QA server on :3230 (seed first: scripts/run-crm-qa-seed.mjs)
AQI_UX_LABEL=run node scripts/aqi-ux-qa.mjs  # card, onboarding, markdown, perf; add AQI_UX_THROTTLE=1, AQI_UX_REPEAT=3
PLAYWRIGHT_MODULE=<playwright/index.mjs> node scripts/aqi-guidance-browser-qa.mjs   # the existing Phase 3 suite
```

Output goes to `.data/aqi-ux-qa/<label>/` (git-ignored): `metrics.json`, `report.md`, `screens/`.
