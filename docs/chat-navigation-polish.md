# AI Workforce: sidebar, navigation and chat polish

Final polish pass on the AI Workforce management workspace and the dedicated chat workspace. It builds on the premium
redesign (`466c96e`); it does not restart it. No migration, no change to Hermes run authorisation, tenant RBAC, employee
activation, configuration approval or conversation storage.

Screenshots: `docs/design-qa/chat-nav-polish/before/` (the redesign as it stood) and `.../after/` (this pass), light and
dark, at 1440, 1280x720, 820 and 390 wide. Harness: `scripts/chat-navigation-qa.mjs`.

## 1. What was wrong, and the root cause

| Symptom | Root cause |
| --- | --- |
| iAcquire brand unreadable in the chat rail | `Logo` hard-coded theme tokens (`text-ink`, a primary-to-violet gradient). Every dark surface patched it at the call site (`[&_span]:!text-white`, `[&_a_span]:text-white`), and the chat rail put a `#11192c` card on a rail that is itself dark in the dark theme, so the card was a near-identical nested surface and the gradient wordmark sat at roughly 3:1. The management sidebar patched it a different way, so the two screens showed two different wordmarks. |
| Chat felt like another product | The chat rail used the light/dark theme surface (light in light mode); the management sidebar is navy in both themes. Different colours, spacing, row shapes and active states. |
| A management click opened chat | The management sidebar's employee rows linked to `/chat/<slug>` while highlighting the `/workforce/<slug>` page. |
| Footer links hid behind icons only | One unlabeled theme button and a `Help` row; no way to reach the profile or manage screens from chat except an unlabeled header icon. |
| Tablet: row actions unreachable by touch | The history row's actions were hover-only from `sm` (640px) up, but the rail is a drawer until `lg` (1024px). |
| Switching to the same employee reset the URL | `Link` to `/chat/<slug>` from `/chat/<slug>?c=<id>` navigated and dropped `?c=` while the open conversation stayed on screen. |
| A conversation id from another employee rendered under this one | `/chat/lead-hunter?c=<sales assistant conversation>` loaded the conversation by id only. (Sending was already refused server side; display was not.) |

## 2. Branding fix (shared, not per screen)

- `src/app/globals.css`: `.workspace-nav` now owns the navigation tokens (`--nav-bg`, `--nav-ink`, `--nav-ink-2`,
  `--nav-muted`, `--nav-line`, `--nav-hover`, `--nav-selected`, `--nav-accent`, `--nav-action`). The navy chrome is one
  definition used by the management shell, the agency shell and the chat rail.
- `Logo` (`src/components/brand.tsx`) gained `tone="auto" | "inverse"` and neutral class hooks (`logo`, `logo-word`,
  `logo-accent`). Inside `.workspace-nav`, or with `tone="inverse"`, the wordmark uses fixed on-dark colours: white "i"
  and a light blue-to-lavender "Acquire" (`#a8c0ff` to `#cdbcff`). Nobody overrides the text colour at a call site any more:
  the overrides were removed from `sidebar.tsx`, `admin-shell.tsx` and the auth showcase.
- The chat rail brand is no longer a card. It sits directly on the navy, like the management sidebar, with a shared hover
  treatment (`.workspace-nav-brand`).
- `StatusDot` takes its ring colour from `--dot-ring`, so dots on navy no longer get a white ring in the light theme.
- `tests/chat-navigation.test.ts` reads the real tokens from `globals.css` and fails if a navigation foreground drops
  under 7:1 on the navy (4.5:1 on its glow), or if someone reintroduces the call-site colour override.

Measured in the live pages (both themes, management, chat and the mobile drawer): "i" 19.0:1, "Acquire" gradient
10.5 to 11.1:1, section labels 7.2:1, against the rail's own background.

## 3. Two modes, one product

| | Management mode | Chat mode |
| --- | --- | --- |
| Chrome | Main iAcquire navigation (navy) | Chat navigation (the same navy, same tokens, same row shape) |
| Where | `/workforce`, `/workforce/<slug>` | `/chat/<slug>` |
| Selecting an employee | Opens that employee's **profile** (`/workforce/<slug>`) | Opens that employee's **chat** (`/chat/<slug>`) |
| Cross-over | A small **Chat with <name>** icon on the row, shown only when the employee can chat and the viewer has `agents.use` | **Back to AI Workforce**, **Profile**, and **Manage** (only with `agents.configure`) |
| Brand | Logo links to `/overview` | Logo links to `/overview` |

Routes come from `src/lib/chat-navigation.ts` (`chatNavTargets`). An agency Super Admin in the internal workspace gets
`/admin` and `/admin/workforce` for home/back; profile and manage use the same shared employee routes that
`/admin/workforce/open` already redirects to.

### Chat rail, top to bottom
1. **Workspace**: logo and wordmark (home), `Demo` marker for demo workspaces, close button in the drawer.
2. **Back to AI Workforce**.
3. **AI specialists**: avatar, name, a readiness caption (`Online`, `Working now`, `Setup required`, `Being set up`,
   `Offline`, `Needs attention`) and the status dot. The current employee uses the status the chat page computed. Only
   enabled employees are listed, as before. Choosing the current employee does nothing (no navigation).
4. **Conversations** for the current employee only (the section is labelled with the employee): `New` button, search,
   grouped list (Today, Yesterday, Previous 7 days, Previous 30 days, Older), compact relative times, long titles truncated
   with the full title and date in the tooltip, rename and delete (the only actions the backend supports).
5. **Footer**: Profile, Manage (authorised only), Settings, Help, theme, collapse.

On short laptop screens (under 760px tall) specialist captions collapse to one line so the history keeps room.

### History behaviour
- Search is the existing server search (titles and message text). New: a visible in-progress state, a "no matching
  conversations" state with a clear button, a retryable error state, and stale responses are dropped (typing `ab` can no
  longer be overwritten by the slower answer for `a`). A failed background refresh keeps the list on screen.
- Keyboard: ArrowDown from the search box enters the list; ArrowUp/Down/Home/End move between conversations; Escape clears
  the search.
- Grouping and relative times use the workspace time zone and the server's clock (`nowIso`), so the server render and the
  browser agree; the clock then advances once a minute.
- Conversation switching inside an employee still uses `history.replaceState` (unchanged). Deep links
  `/chat/<slug>?c=<id>` work; the id is honoured only for the employee that owns the conversation.

### Desktop collapse, tablet and mobile
- Desktop: a collapse control reduces the rail to an 80px icon rail (brand mark, back, specialists with tooltips and status
  dots, new conversation, profile/manage/settings/help/theme, expand). Remembered per browser (`iaq-chat-rail`) and kept
  when switching employee.
- Below 1024px the rail is a left drawer (Radix dialog: focus trap, Escape, focus returns to the opener) with an explicit
  close button, safe-area padding, and avatars loaded eagerly so it never opens with empty tiles. The header always shows the
  employee, their readiness and the open conversation title. Header profile/manage shortcuts appear from 640px; below that
  they are in the drawer footer.

## 4. Files

- New: `src/lib/chat-navigation.ts`, `src/lib/conversation-time.ts`, `tests/chat-navigation.test.ts`,
  `tests/chat-rail.test.tsx`, `tests/workforce-navigation.test.tsx`, `scripts/chat-navigation-qa.mjs`.
- Rewritten: `src/components/chat/chat-rail.tsx`.
- Changed: `src/components/chat/chat-workspace.tsx`, `src/app/(chat)/chat/[slug]/page.tsx`, `src/app/(chat)/loading.tsx`,
  `src/components/brand.tsx`, `src/components/shell/sidebar.tsx`, `src/components/admin/admin-shell.tsx`,
  `src/components/auth/showcase.tsx`, `src/app/globals.css`.

## 5. Safety

Nothing here sends a message or starts a run: choosing an employee is navigation only, and a conversation record is created
only when a message is sent (unchanged). `Manage` is rendered only when `agents.configure` is held, and the destination
page still enforces it. Employee readiness and `canChat` are unchanged, so an employee that is not set up still gets the
setup state and no composer.

## 6. Verification (2026-10-20)

- `npm run typecheck`, `npx eslint .` and `npm run build`: clean.
- `npx vitest run`: 3156 tests, 197 files. 3155 passed on the first full run; `crm-blueprints-starters` (one 31s test
  against the 30s limit) and `agency-team-ui` (worker start timeout) failed only under whole-suite load and pass in
  isolation (237 tests). New: 14 + 21 + 6 tests for targets, dates, contrast, the chat rail and the management sidebar.
- Browser QA against the isolated local app (fictional records, no provider): `CHAT_QA_MODE=behavior` ran **70 checks, 70
  passed**, 0 console errors, 0 page errors. Covered: management click opens the profile; chat selection switches
  employee and history without a send/run request; re-selecting the current employee keeps `?c=`; Back to AI Workforce,
  browser back and forward, deep link to the owning employee and a cross-employee deep link; search (no match, match,
  Escape, ArrowDown); collapse, reload and switching employee while collapsed; mobile (390px) drawer open/close, focus
  return, no horizontal scroll in light and dark; a team member (no `agents.configure`) sees no Manage link or Configure
  tab; a Super Admin opened through `/admin/workforce/open` gets agency back/manage targets; wordmark and label contrast
  measured in the live pages; axe (WCAG 2.1 AA) on the sidebar, desktop and drawer, both themes: no violations.
- Screenshots: 26 per set. Note for repeating this: write screenshots outside the repo while the dev server runs (the
  watcher reloads pages mid-run and produces ChunkLoadError/hydration noise that is not product behaviour).

## 7. Known limits

- Not driven against a live Hermes or a real provider: the isolated QA workspace has no employee that is online, so the
  "Chat with <name>" shortcut and an online chat were covered by unit tests, not a browser.
- Screen-reader testing was not done (axe reports no violations in the sidebar in both themes, desktop and drawer).
- iOS Safari safe-area insets are written with `env(safe-area-inset-*)` but were not checked on a device.
- Browser Back from a conversation switched inside one employee leaves the chat (the switch uses `replaceState`).
- Employees that are not enabled for a workspace stay out of the specialist list, as before.
