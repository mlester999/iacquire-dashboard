# The prospect demo showroom

What a prospect sees at `/demo/room` after they confirm their email: a full-width, dark-navy workspace about their own business instead of a narrow page of cards. It replaces the old
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
| One scoped dark theme; nothing leaks to the rest of the portal | `src/components/demo/showroom/showroom.css` (`.demo-stage`) |
| Design-QA preview with sample state (development only) | `/dev/showroom-preview` |

The landing page and the emailed-link page keep their narrow frame (`PublicFrame` in `shell.tsx`); the room and `/demo/why` take the full width.

## Where each fact comes from

* Name, business, industry: the visitor's own demo session, as before. The headline says "Meet the AI team that could help run [Business Name]" and nothing else about the business: the
  sample leads, deals and prospects are invented per industry (`industry.ts`) and labelled as samples on the page.
* Window, messages left, whether the chat can send, the transcript: `getRoom`. The countdown is drawn toward the server's end time; at zero the page asks the server again and the record decides.
* Prices: `src/lib/billing.ts` through `RoomView.pricing` (US$1,499 once; optional US$299 a month). The plan's own list and change-request allowance come from the published catalog when it can be read.
* Studio belongs to the optional Managed Maintenance plan; the CRM, the AI Employees, the inbox, booking and the website never wait on it; a core client can connect n8n, Zapier or Make
  through APIs and webhooks. No tier, discount or number of employees is stated beyond what the code and the catalog say.

## Rules the code keeps (tests: `tests/demo-showroom.test.tsx`, `tests/demo-pages.test.tsx`)

* Moving between views, replaying a simulation, moving a sample lead or approving a sample reply uses no AI message and sends nothing. Only pressing Send in the guide counts a message.
* "Book a free consultation" and "I'm ready to get started" record one event each (`/api/public/demo/cta`) and say plainly that nothing is booked or charged. The scheduling link appears only
  when the Super Admin has set a real https address.
* No price, percentage, hour saved or result is written about the AI Employees' work; the sample report's figures are labelled invented; comparisons with doing it yourself are in words.
* The tour's progress is four step numbers in this browser's `localStorage`; nothing about the visitor is stored there or sent anywhere.
* The public `/demo/why` page needs no session, shows nothing about anyone, records nothing, and stays open after a window ends.
* `/dev/showroom-preview` is development-only (404 in production, guarded twice like every `/dev` page).

## Looking at it

`npm run dev`, then `/dev/showroom-preview` with `?view=`, `state=open|ended|ai_off|exhausted`, `left=`, `hours=`, `industry=`, `consult=1`, `buy=1`, `link=1`, `history=1`, `plan=0`.
Sending a message or pressing a request there posts to the real endpoints, which answer "no session": that is the error path.

## What was and was not checked

Checked: type-check, ESLint on every changed folder, 28 demo and guard test files (549 tests), a production build (`npm run build:clean`, exit 0), and a browser pass at 390, 768, 1024, 1440 and 1920 px: every view,
the scenario player, the CRM pipeline interaction, the AI guide sheet and its error path, the request error path, ended / AI-off / exhausted / consultation-requested states, axe-core with
no violations on every view at desktop and phone widths, `?view=` and Back, reduced motion. Full-resolution screenshots were taken with headless Chromium.

Not checked: a real demo session end to end (a real email, a real model answer, a real recorded request) on this branch; Safari and Firefox; a screen reader; the showroom has one dark theme
by design, so there is no light variant to check.
