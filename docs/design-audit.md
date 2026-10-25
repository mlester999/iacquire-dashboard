# Design and accessibility audit

A measured pass over the operational screens that exist in this worktree, not a claim that the whole product has been visually approved.

## Method

* Chromium through Playwright against the isolated QA app at **1440 × 1000** and **375 × 812**, light theme, a real Super Admin session.
* For each page: the rendered `h1`, horizontal overflow (`scrollWidth` vs `innerWidth`), the number of visible text elements below 12 px, axe-core WCAG 2.0/2.1 A + AA violations, page errors and console errors, plus a full-page screenshot.
* Pages: dashboard, clients, AI workforce, Messages, workload, Requests, purchase intents, demo prospects, module rollout, usage.
* Screenshots and the machine-readable report are kept in the git-ignored `.data/design-audit/`.

## Result at the first pass

* **No horizontal overflow and no axe violations on any of the ten pages at either width.**
* **Tiny text was concentrated in the shell and dense tables.** The clearest offenders were the sidebar role line (`Super admin access`, 11 px), the account role (`Agency Super Admin`, 10 px) and the top-right role badge (`Super admin`, 10 px).
* The mobile **Requests** screen put the floating AQi launcher over the reply composer. The same class of overlap had already been fixed on staff Messages.

## Changes made

1. The shell's microcopy was raised to a readable floor: sidebar role line **12 px**, account role **11 px**, top-right role badge **11 px**, compact-navigation control **11.5 px**. This removes the smallest text from the global frame without changing layout or density elsewhere.
2. A request detail (agency and client) now marks the page as having a bottom composer through `document.body.dataset.aqiComposer`. On screens narrower than 640 px, a CSS rule lifts `[data-aqi-launcher]` **150 px** above the safe-area bottom so it cannot sit on the Send button. Removing the page restores the normal position.

## What this pass did not establish

* It is not a page-by-page aesthetic approval. It measures overflow, accessibility and text size; it does not judge composition, colour balance or brand feel for a human reviewer.
* It covers the light theme and the ten agency screens above. Client portal screens, public pages, dark theme, 390 px and tablet widths need the same measured pass.
* It is not a substitute for the full Phase 7 design scorecard, which still has to cover every module and the public purchase/demo/onboarding surfaces.

## Next design gates

1. Run the same audit on the client portal (`/crm`, `/inbox`, `/projects`, `/proposals`, `/invoices`, `/onboarding`) and the public surfaces (`/demo`, `/purchase/<token>`, `/pay/<token>`).
2. Review the captured full-page screenshots page by page at 1440, 1280, 390 and 375 px, in light and dark, and record concrete fixes rather than impressions.
3. Fix the remaining small-text clusters in dense tables (`clients`, `employees`, `support`) where the label is load-bearing rather than metadata.
4. Re-run the audit after every design change and keep the report with the commit.

## Second pass (2026-10-25 and 26): type scale, the whole portal and admin, both themes, public pages

**Method.** The same isolated QA app (simulated providers, seeded workspaces with proposals, invoices, reviews, missed calls, web chat and social data), Chromium through Playwright, one fresh page per route. Per page and width and theme: HTTP errors, console and page errors, requests that left the QA origin, horizontal overflow (the document, **and** content the shell clips, **and** the element that widens the page), cut-off tab strips at desktop widths, text clipped mid-word, axe-core WCAG 2 A/AA, and the sizes of all visible text. Routes: 150 signed-in routes of the client portal and the agency admin (about 100 and 50), 11 public pages (sign-in, forgot password, get started, demo, three pay links, three proposal links, no-workspace). Widths 1280, 768 and 375 px in light; 1280 and 375 px in dark. About 1,000 page views in all, in batches of about 30 routes per server session, because the dev server grows to 8 GB and restarts itself and the disk is small (the build cache is cleared between batches).

**The type scale** is now 12px for labels and metadata, 13px for secondary text, 14px for working text, 15 to 17px for section titles, 16px for form fields (so iOS does not zoom), larger above. A measured census of text by size (`scripts/type-scale-census.mjs`) is the tool for the next review; the floor is held by `tests/type-scale-floor.test.ts`.

**Defects the pass found, all fixed and re-swept:**

| Where | What | Fix |
| --- | --- | --- |
| Whole app | 1,263 uses of 8 to 11.5px text | Raised to 12px; guarded |
| Notification bell | The count badge covered the bell | Sits on the corner, 18px |
| Report blocks (`/crm/reports`) | In a 163px column the bars had width 0 (the grid answered to the window, not its own width) | Container queries; the bar list stacks when narrow |
| `/crm/reports/sources`, `/admin/crm` | The whole page scrolled sideways at 375px (hidden header text outside its scroller) | One global rule for hidden text in table cells |
| `/admin/support/settings`, `/admin/team` | Cards ran 4 to 5px past the screen edge and were clipped | Fieldsets and grids shrink |
| 20 filter and tab strips | At desktop width the last tab was cut in half ("Eve" for "Everything") | They wrap at `lg`; a strip that draws an edge fade is left alone |
| Admin employees (dark) | White text on the primary fill, 3.48:1 | 33 places use the on-primary token |
| Notifications | "Mark all read" button named "Mark all notifications as read" (WCAG 2.5.3) | Names match |
| 31 tables | Scrolled sideways but could not take keyboard focus | They take focus; guarded |
| Template library | Count chip 4.35:1 | Darker text |
| `/admin/team` | `<p>` inside a definition list | `<dd>` |
| 20 components | Reduced-motion hydration mismatch (server and client rendered different first frames) | One first frame for everyone |
| `/invoices/settings` | Two sibling panels with the same key | Distinct keys |

**What it does not establish.** It is measurement plus my own reading of about 40 full-page screenshots; it is not a designer's approval of composition, colour or brand. 390 and 1440 px were not swept (768 stands for tablet; 1280 for desktop); the dark theme was swept at two widths; client websites' own stylesheet is untouched (D66); the Automation Studio canvas and the Website Studio editor were swept only as pages, not interacted with. The dev server's occasional "text/plain" chunk errors and connection resets while it recompiles are not product defects and were not counted.
