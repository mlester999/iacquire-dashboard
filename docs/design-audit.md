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
