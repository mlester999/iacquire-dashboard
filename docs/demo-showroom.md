# The prospect demo showroom

What a prospect sees at `/demo/room` after they confirm their email: a full-width workspace about their own business, built from the real portal's design language (the navy navigation rail, the themed page, cards and buttons), in light, dark or system theme. It replaces the old
room (a tour of six `<details>`, a price box and two buttons). Nothing behind it changed: the 24-hour window, the ten-message allowance, session isolation, the single-use link, the
Super Admin controls and the event record are the same code (`src/server/demo/*`) with the same tests.

## What is where

| Piece | File |
| --- | --- |
| The page (server): reads the room from the record, builds the state, passes it on | `src/app/demo/room/page.tsx` |
| The workspace (client): navigation, tour strip, AI guide dock/sheet, view switching | `src/components/demo/showroom/workspace.tsx` |
| The eight views and the four-step journey | `src/components/demo/showroom/views/*`, `journey.tsx` |
| Calls to action (the only two things that can be recorded) | `src/components/demo/showroom/cta.tsx`, `context.tsx` |
| The AI guide (same behaviour as before, restyled; `draft`, `suggestions`, `closedFooter` added) | `src/components/demo/chat.tsx` |
| "Why iAcquireOS?" (shared by the room and the public page) | `src/components/demo/showroom/why-content.tsx`, `src/app/demo/why/page.tsx` |
| Words and sample data (the six employees, the sample CRM, the plans, the FAQs) | `src/lib/demo/showroom/*` |
| A few token-only helper classes (panel, chip, button). No theme of its own: it reads the portal's tokens in `globals.css` | `src/components/demo/showroom/showroom.css` |
| The light/dark/system control (the portal's own ThemeProvider) | `src/components/demo/showroom/theme-switch.tsx` |
| The confirmation dialog for both requests, and its words | `src/components/demo/showroom/cta.tsx` (`ConfirmHost`), `src/lib/demo/showroom/confirm-copy.ts` |
| Design-QA preview with sample state (development only) | `/dev/showroom-preview` |

The landing page and the emailed-link page keep their narrow frame (`PublicFrame` in `shell.tsx`); the room and `/demo/why` take the full width.

## Where each fact comes from

* Name, business, industry: the visitor's own demo session, as before. The headline says "Meet the AI team that could help run [Business Name]" and nothing else about the business: the
  sample leads, deals and prospects are invented per industry (`industry.ts`) and labelled as samples on the page.
* Window, messages left, whether the chat can send, the transcript: `getRoom`. The countdown is drawn toward the server's end time; at zero the page asks the server again and the record decides.
* Prices: `src/lib/billing.ts` through `RoomView.pricing` (US$1,499 once; optional US$299 a month). The plan's own list and change-request allowance come from the published catalog when it can be read.
* Studio belongs to the optional Managed Maintenance plan; the CRM, the AI Employees, the inbox, booking and the website never wait on it; a core client can connect n8n, Zapier or Make
  through APIs and webhooks. No tier, discount or number of employees is stated beyond what the code and the catalog say.

## The request page (`/demo`)

Where a prospect asks for a demo. Two columns on a laptop (the pitch on the left, the form on the right, sticky while the page scrolls) and one on a phone, where the form comes straight after
the headline. Left: a "Free guided demo" chip, the headline, the three things a demo is (a tour, the AI chat with its real allowance or a note that it is closed, the 24-hour window) and a small
invented "one enquiry, three AI Employees" hand-off labelled "Sample preview". Right: the form (field icons, a three-step strip, the consent box in its own panel, a gradient button, the notice
lines), then "Already started? Get a new link". Below: the six AI Employees by role name, what else is inside, and a link to `/demo/why`. Everything the old page said is still there, and the
form's fields, labels, consent text, hidden campaign fields, trap field and JSON/native behaviour are unchanged (`tests/demo-interactive.test.tsx`, `tests/demo-pages.test.tsx`). It is built
only from the form's own view: the allowance and window come from the settings in force, so it cannot promise more than they do. The closed and stopped states show only the message.
Design QA without a database: `/dev/demo-landing-preview` (`state=open|full|ai_off|session|closed|stopped`, `r=`, `f=`, `theme=`).

## Theme and typography

The showroom has no colour scheme of its own. The page background, cards, text and chart colours are the portal's tokens (`--bg`, `--surface`, `--ink`, `--primary`, `--violet`, ...), so the
shared `data-theme` on `<html>` (set by the root layout's script before first paint and by `ThemeProvider`, preference `iaq-theme`) switches everything, including dialogs and charts.
The navigation rail is the portal's `workspace-nav` (navy in both themes); content placed on it uses `.sx-on-nav`, which restates the tokens for dark chrome. Headings use the product's
sans typeface; the serif display face is no longer used here.

## AI Employee names

A role is universal; a display name belongs to one company (`agent_instances.display_name`, one row per organisation and role, set through the Configure screen's version flow). The public
demo shows role labels only: `alias: "Zeng"` was removed from the showroom's role data, and the workforce chat's "no task-assignment action" message now uses the company's own employee
name (or "The Operations Manager"), where it used to say Zeng for everyone. `tests/employee-name-isolation.test.ts` holds this: the agency's Zeng, a client's Alex and another's Nova stay
in their own company; renaming one employee changes nothing else (same ids, roles, profiles, switches); names survive provisioning retries. `tests/demo-pages.test.tsx` renames the
agency's Operations Manager to Zeng and checks that no demo view shows it.

## The two confirmations

"Book a free consultation" (and every equivalent: Talk to a person, Ask about Managed Maintenance, Get this AI team for my business) and "I'm ready to get started" open a dialog first.
Nothing is recorded until the visitor presses the confirming button; a failure keeps the dialog open with the message; a success is drawn only after the server's answer. Consultation:
free, what it is for, what happens next, and, when a real https scheduling page is set, a "Choose a meeting time" button after recording (confirming interest does not reserve a meeting).
Implementation: US$1,499 starting price, optional US$299/month, usage and provider costs separate, and that confirming only informs the team (no payment, subscription or workspace). Without
scripts the button is a link to `?confirm=...`, which shows the same confirmation on the page with a real form.

## Rules the code keeps (tests: `tests/demo-showroom.test.tsx`, `tests/demo-pages.test.tsx`)

* Moving between views, replaying a simulation, moving a sample lead or approving a sample reply uses no AI message and sends nothing. Only pressing Send in the guide counts a message.
* "Book a free consultation" and "I'm ready to get started" record one event each (`/api/public/demo/cta`) and say plainly that nothing is booked or charged. The scheduling link appears only
  when the Super Admin has set a real https address.
* No price, percentage, hour saved or result is written about the AI Employees' work; the sample report's figures are labelled invented; comparisons with doing it yourself are in words.
* The tour's progress is four step numbers in this browser's `localStorage`; nothing about the visitor is stored there or sent anywhere.
* The public `/demo/why` page needs no session, shows nothing about anyone, records nothing, and stays open after a window ends.
* `/dev/showroom-preview` is development-only (404 in production, guarded twice like every `/dev` page).

## Looking at it

`npm run dev`, then `/dev/showroom-preview` with `?view=`, `theme=light|dark|system`, `confirm=consultation|buy`, `state=open|ended|ai_off|exhausted`, `left=`, `hours=`, `industry=`, `consult=1`, `buy=1`, `link=1`, `history=1`, `plan=0`.
Sending a message or pressing a request there posts to the real endpoints, which answer "no session": that is the error path.

## What was and was not checked

Checked: type-check, ESLint on every changed folder, 49 test files (806 tests: the demo, naming, chat and source-guard suites), a production build (`npm run build:clean`, exit 0), and a
browser pass at 390, 820, 1440 and 1920 px in light and dark: every view, the confirmation dialogs (open, Escape, focus returning to the button, a refused request keeping the dialog open
with its message, no success shown), the scenario player, the pipeline interaction, the AI guide, ended / AI-off / exhausted / consultation-requested states, `?view=` and Back, and
axe-core with no violations on all nine views in both themes and on both dialogs. Full-resolution screenshots (light and dark) were taken with headless Chromium and compared with a real
portal page for typeface, eyebrows, cards and buttons.

Not checked: a real demo session end to end (a real email, a real model answer, a real recorded request, the success state of a dialog against the real server); Safari and Firefox; a
screen reader; the no-script confirmation page was covered by tests but not driven in a browser with scripts off.
