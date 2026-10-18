# Connected calendars (Native CRM)

People in a client workspace can connect the calendar they already use, so iAcquire's booking pages never offer a time they're busy, and
so the appointments they host show up in that calendar. This page covers what is supported, how to register the OAuth apps, what each
person needs to do, and how sync behaves. The screen lives at **CRM → Scheduling → Calendar connections** (`/crm/calendar-connections`).

Code: `src/server/calendars/adapters/*` (one adapter per provider plus the iCalendar engine), `src/server/calendars/connections.ts`
(connect, options, disconnect, permissions), `src/server/calendars/sync.ts` (busy sync and write-back jobs), OAuth routes under
`src/app/api/crm/calendar-oauth/[provider]/`, and tests in `tests/crm-calendar-connections.test.ts`.

## What is and isn't supported

| | Google Calendar | Microsoft Outlook / 365 | Apple iCloud | Other CalDAV | ICS feed |
|---|---|---|---|---|---|
| How it connects | OAuth 2.0 + PKCE | OAuth 2.0 + PKCE | Apple ID + app-specific password | Server address + username + password | An `https://` (or `webcal://`) link |
| Busy times kept off booking pages | Yes | Yes | Yes | Yes | Yes |
| Choose which calendars count | Yes (any on the account's list) | Yes (the account's own calendars) | Yes | Yes | One feed = one calendar |
| Appointments added to a calendar | Yes, opt out per connection (calendars the person owns) | Yes, opt out per connection | Opt in | Opt in | No (read-only) |
| Meeting links | Google Meet, for types set to Google Meet | Teams, for types set to Microsoft Teams, where the account allows `teamsForBusiness` | No | No | No |
| How fresh | About every `CALENDAR_SYNC_INTERVAL_MINUTES` (default 10) | Same | Same | Same | About every `CALENDAR_ICS_POLL_MINUTES` (default 30); **not instant** |

Not supported (by design or not yet):

- Push notifications (Google watch channels, Graph subscriptions, CalDAV push). Everything is polled, so a change made in the last few
  minutes may not be reflected yet. iAcquire's own bookings are always checked instantly (`crm_busy_blocks`).
- Connecting a calendar on someone else's behalf. Only the person can connect their own; managers can only see and disconnect.
  iAcquire support sessions can't connect anyone's calendar.
- Microsoft calendars shared with the person from another mailbox, and Google calendars the person isn't subscribed to.
- Adding appointments to a Google calendar someone else owns, even one shared with "Make changes to events": the write scope requested is
  `calendar.events.owned`, which only covers calendars the person owns (their primary calendar and the ones they created). Only those
  are offered as the calendar to add appointments to; shared calendars still count for busy times.
- Google calendars over CalDAV (use the Google option), Exchange on-premises (EWS), and CalDAV servers that need anything but HTTP Basic
  authentication over HTTPS on port 443.
- Recurrence rules with `BYHOUR`, `BYMINUTE`, `BYSECOND`, `BYWEEKNO`, `BYYEARDAY` or a sub-daily `FREQ` in ICS/CalDAV data: the event's
  first occurrence and listed dates (`RDATE`) are used and the run's history says how many such events there were. `RANGE=THISANDFUTURE`
  overrides apply to the one instance they name. Attendee `PARTSTAT=DECLINED` isn't read from ICS/CalDAV data (Google and Microsoft
  declines are honoured).
- Adding customers as attendees. Nothing iAcquire writes sends an invitation (`sendUpdates=none` for Google; no attendees anywhere).
- One event per group session: a group appointment type writes one event per booking (so a full five-seat session shows five events at
  the same time). Collective calendars write one event to each host's own calendar; only the assigned host's calendar creates the
  meeting link, and the other hosts' events carry it in their description once it exists.

## Rules the code enforces

- **Who:** connecting needs `calendars.connect` and is always for the signed-in member themself (`assertConnector`). Options can only be
  changed by the connection's owner. Disconnecting: the owner, or anyone with `calendars.manage` (the owner is notified). Agency support
  write sessions have `calendars.manage`, so they can see and disconnect, never connect. Reads go through row-level security: a member
  sees their own connections; `calendars.manage` sees everyone's (status only).
- **"Connected" means tested.** A connection is saved as `connected` only after an authenticated read worked: Google = calendar list +
  `freebusy.query` on the main calendar; Microsoft = calendar list + `getSchedule` (or, for personal accounts where Graph doesn't offer
  `getSchedule`, a one-day `calendarView` read); CalDAV = full discovery + a `calendar-query` REPORT; ICS = a fetch that parses as
  iCalendar. If the test fails nothing is saved (and a freshly issued Google grant is revoked).
- **Secrets:** OAuth tokens, CalDAV passwords and feed links are stored AES-256-GCM encrypted (`encryptSecret`, `APP_ENCRYPTION_KEY`) in
  `crm_calendar_connections.credentials`, a column the application database role can't read. They are never logged, returned to the
  browser, put in audit metadata or shown again. Disconnecting deletes them (and revokes the Google grant).
- **OAuth state:** 32 random bytes, stored only as SHA-256 in `crm_calendar_oauth_states`, bound to the person, single use (consumed
  before anything else happens, so a failed or foreign attempt burns it), valid 10 minutes. The PKCE verifier (S256) is stored
  encrypted. The callback refuses a state started by a different signed-in person. The start route only runs for same-origin or typed
  navigations (`Sec-Fetch-Site`), so another site can't start a sign-in in someone's name.
- **Busy data:** only start and end times (`crm_external_busy`), keyed `external_ref = sha256(connectionId:providerEventId:instanceStart)`.
  No titles, attendees, locations or descriptions are stored. Events this workspace wrote are excluded from busy times, otherwise an
  appointment would block its own reschedule and group sessions could never fill. They are recognised on every one of the person's
  connections in the workspace, not only the one that wrote them (so a Google calendar that is also subscribed as an ICS feed doesn't
  report our appointments back as busy): by the stored provider event id; by the UIDs our writes carry (`iaq-<key>@iacquire` for
  CalDAV, `<event id>@google.com` in Google's iCalendar export); and by markers naming the appointment and the workspace (Google private
  extended properties; `X-IACQUIRE-APPOINTMENT` and `X-IACQUIRE-WORKSPACE` in CalDAV events, which ICS and CalDAV reads check per
  event). Outlook's published ICS feeds use their own UIDs and drop our markers, so an Outlook calendar should be connected as Microsoft,
  not also as a feed.
- **Addresses people type (CalDAV, ICS):** `https` only, port 443, no embedded credentials, not a local name (`localhost`, `.local`,
  `.internal`, …), and every address the name resolves to must be public (no loopback, private, CGNAT, link-local/metadata, multicast or
  unique-local IPv6). IPv6 addresses are parsed to numbers: IPv4-mapped (`::ffff:0:0/96`, however it's written, e.g. `[::ffff:7f00:1]`),
  IPv4-translated and NAT64 (`64:ff9b::/96`) forms are judged by the IPv4 address they reach; only global unicast (`2000::/3`) is
  otherwise public, and 6to4, Teredo and the documentation ranges are refused. Redirects are followed by hand (at most three) and each hop
  is checked again. A CalDAV password is only sent to the
  host the person entered (for iCloud: any `*.icloud.com` host, because iCloud hands out calendar homes on `pNN-caldav.icloud.com`).
  Responses are capped at 5 MB and 15 s. Known residual risk: the DNS check and the connection are separate lookups, so a hostile DNS
  server answering differently within seconds (DNS rebinding) isn't fully excluded; Node's built-in `fetch` has no supported way to pin
  the checked address (that needs an `undici` dispatcher with a checking `lookup`, and `undici` isn't a dependency). HTTPS on port 443
  with certificate checks limits such a connection to a TLS handshake with an internal port-443 service.
- **Rate limits:** 12 connection attempts per person per 15 minutes; "Sync now" at most once a minute per connection.

## Registering the Google OAuth app (Google Cloud)

1. In Google Cloud console create (or choose) a project for iAcquire, and enable **Google Calendar API** (APIs & Services → Library).
2. **OAuth consent screen** (Google Auth Platform → Branding/Audience/Data access): user type **External**; app name "iAcquire", support
   email, the portal's domain as an authorized domain, links to the privacy policy and terms.
3. **Data access → scopes** — add exactly these (they are what the code requests, `GOOGLE_SCOPES` in `adapters/oauth.ts`):
   - `openid`, `email` — which account signed in (for the connection's label and to recognise a reconnect)
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly` — list the person's calendars
   - `https://www.googleapis.com/auth/calendar.events.freebusy` — read availability (`events.list`, `freebusy.query`)
   - `https://www.googleapis.com/auth/calendar.events.owned` — create, change and delete events on calendars the person owns
   Google classifies Calendar scopes as sensitive. Until the app passes Google's verification the consent screen shows an "unverified
   app" warning and is limited to 100 users. While the publishing status is **Testing**, only listed test users can sign in and
   **refresh tokens expire after 7 days** (connections will then show "Reconnect needed"); publish to **In production** and complete
   verification (brand verification plus the scope justification and a demo video) before customers use it.
4. **Clients → Create client → Web application.** Authorized redirect URI (exact, per environment):
   - `https://<portal host>/api/crm/calendar-oauth/google/callback` (from `APP_URL`)
   - `http://localhost:3000/api/crm/calendar-oauth/google/callback` for local development only
5. Put the client ID and secret in the deployment's secret settings as `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET`.
   Until both are set, the screen shows Google as "Not set up by iAcquire yet" and offers no connect button.

The sign-in requests `access_type=offline` and `prompt=consent` (so a refresh token is always issued) with PKCE S256. If the person
unticks the calendar list or availability boxes on Google's granular consent screen, nothing is connected and the grant is revoked; if
they untick only the events permission, the connection works for busy times and "add appointments" stays unavailable.

## Registering the Microsoft app (Microsoft Entra ID)

1. Entra admin center → **App registrations → New registration**. Name "iAcquire". Supported account types: **Accounts in any
   organizational directory and personal Microsoft accounts** (matches `MICROSOFT_CALENDAR_TENANT=common`). Choose a narrower option and
   set the tenant variable to `organizations`, `consumers` or one tenant ID if iAcquire should only accept those.
2. **Redirect URI**, platform **Web**: `https://<portal host>/api/crm/calendar-oauth/microsoft/callback` (and
   `http://localhost:3000/api/crm/calendar-oauth/microsoft/callback` for local development).
3. **Certificates & secrets → New client secret.** Secrets expire (at most 24 months); put a reminder in to rotate it.
4. **API permissions → Microsoft Graph → Delegated:** `openid`, `offline_access`, `User.Read`, `Calendars.ReadWrite`. These don't
   normally need admin consent, but a customer tenant that blocks user consent will need its administrator to approve iAcquire.
   Completing **publisher verification** avoids the "unverified" label and is required for user consent in many tenants.
5. Set `MICROSOFT_CALENDAR_CLIENT_ID`, `MICROSOFT_CALENDAR_CLIENT_SECRET` (and optionally `MICROSOFT_CALENDAR_TENANT`, default `common`).

Microsoft has no endpoint to revoke one app's delegated grant, so disconnecting deletes the tokens and tells the person they can also
remove iAcquire under their Microsoft account's app permissions (or My Apps for work accounts). Teams links are requested only when the
chosen calendar lists `teamsForBusiness` in `allowedOnlineMeetingProviders` (normally work and school accounts).

## Apple iCloud

Each person creates an **app-specific password**: sign in at account.apple.com (two-factor authentication must be on) → Sign-In and
Security → App-Specific Passwords → create one named "iAcquire", then paste it with their Apple ID email. iAcquire talks to
`https://caldav.icloud.com/`, follows the principal to the calendar home Apple returns (a `pNN-caldav.icloud.com` host), and lists the
calendars that hold events. The password is stored encrypted; revoking it at account.apple.com cuts iAcquire off (the connection then
shows "Reconnect needed"). iCloud can't create meeting links.

## Other CalDAV servers

The person enters the server's HTTPS address, username and password (an app password where the provider has them). Discovery uses
`DAV:current-user-principal` at that address, then `/.well-known/caldav` (RFC 6764), then `CALDAV:calendar-home-set`, then the calendar
collections whose `supported-calendar-component-set` includes `VEVENT` (or doesn't say). Writable calendars are those whose
`current-user-privilege-set` includes `write`, `write-content`, `bind` or `all` (or that don't report privileges). Servers that follow
these RFCs (for example Fastmail, Nextcloud, Radicale, Baïkal, Synology) should work, but none of them has been tested live yet.
Requirements: HTTPS on port 443, a public DNS name, HTTP Basic authentication.

## ICS feeds (read-only)

Any calendar's "subscribe" / "secret address in iCal format" link. Rules: `https://` (a `webcal://` link is read as `https://`), a
public host, at most 5 MB. The feed is fetched and parsed once before it's saved, then polled about every `CALENDAR_ICS_POLL_MINUTES`
minutes with `If-None-Match` (an unchanged feed costs one short `304`) and re-read in full every six hours so the rolling window moves.
Changes appear at the next poll, **not instantly**. Feeds are read-only: nothing is ever written back. A feed answering `401`/`403`
shows "Reconnect needed" (the link was probably reset); the person adds the new link under the same name to replace it.

## How sync works

- **Busy sync** (`calendarBusySync` job, `syncDueConnections`): connections whose `next_sync_at` has passed are claimed with
  `FOR UPDATE SKIP LOCKED` (a 10-minute lease), read, and their `crm_external_busy` rows replaced for the window **yesterday → the furthest
  any of the person's appointment types can be booked** (62–366 days). A full read happens on the first sync, every six hours, and when
  the person changes which calendars count; in between: Google checks each calendar's `syncToken` (no changes → nothing is read; `410
  Gone`, or a calendar that is gone (`404`) or no longer readable (`403` that isn't a rate limit) → a full read, which treats those as no
  busy times or falls back to `freebusy.query`, instead of failing every calendar on the connection), CalDAV compares the collection tag
  (`getctag` / `sync-token`), ICS uses the ETag. Microsoft is
  read with `calendarView` each time (no delta). Recurring events are expanded by the provider (Google `singleEvents=true`, Graph
  `calendarView`) or by `adapters/ical.ts` (CalDAV, ICS), with time zones (IANA names, vendor paths, Windows names, else the calendar's
  `VTIMEZONE` rules, including Outlook/Exchange ones whose onsets are dated 1601) and daylight-saving changes handled per instance.
- **Failures:** `401` / `invalid_grant` → one token refresh; if that fails the connection becomes **Reconnect needed** (its busy times
  stop counting) and the person gets one notification per break. `429` / `5xx` / timeouts → retry with backoff (`Retry-After` honoured,
  doubling up to six hours); busy times from the last good sync keep counting. After a day without a successful sync (and at least six
  failures) the connection shows **Not syncing**, its busy times stop counting, and the person is told once.
- **Write-back** (`calendarWriteBack` job, `writeBackDue`): for connections with "add appointments" on, native appointments the person
  hosts are created, updated when they change (a new time or status within a few minutes; anything else, such as a renamed appointment
  type, at the next six-hourly check) and deleted when cancelled or moved to another host. "Changed" means the appointment's version
  differs from the version the last write was built from (`crm_external_events.written_version`), never a comparison of clock times, so a
  reschedule that commits while a write is in flight is sent on the next pass. Updates always send the location (empty when it was
  removed), because Google and Graph updates are `PATCH`es that keep any field left out.
  What is written: the title "‹type› with ‹customer first name›", the time, the location text, "Booked with iAcquire", and a link to the
  appointment in the CRM. Never the customer's answers, contact details, notes or manage link. A SHA-256 of that content is stored, so an
  unchanged appointment is never re-sent. Creates are idempotent: Google gets a stable event id per connection and appointment (a retry is
  a `409`, then an update), Graph a `transactionId`, CalDAV a stable resource name with `If-None-Match: *` (updates and deletes use
  `If-Match` with the stored ETag). Meeting links: only the assigned host's calendar asks for one (`conferenceData.createRequest` with
  `hangoutsMeet`, or `isOnlineMeeting` with `teamsForBusiness`), and `appointment_refs.meeting_link` is set **only** when the provider
  actually returned an `https` join link (a pending Google request is re-checked for up to an hour). Turning "add appointments" off, or
  disconnecting, stops all changes to that calendar; events already there stay. Rows in `crm_external_events` are kept as history.
- **Kill switch:** `CALENDAR_SYNC_DISABLED=true` stops both jobs and "Sync now" without disconnecting anyone; the screen says sync is
  paused. Connecting still works (it only tests the calendar).
- **History:** each sync, write pass, connect and disconnect is recorded in `crm_calendar_sync_runs` with counts only (the last 60 per
  connection are kept) and shown on the screen.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` | unset | Google OAuth web client. Both needed to offer Google. |
| `MICROSOFT_CALENDAR_CLIENT_ID` / `MICROSOFT_CALENDAR_CLIENT_SECRET` | unset | Entra app registration. Both needed to offer Microsoft. |
| `MICROSOFT_CALENDAR_TENANT` | `common` | `common`, `organizations`, `consumers`, or one tenant ID/domain. |
| `CALENDAR_SYNC_DISABLED` | `false` | Pauses busy sync and write-back everywhere. |
| `CALENDAR_SYNC_INTERVAL_MINUTES` | `10` | Google, Microsoft and CalDAV polling interval (2–1440). |
| `CALENDAR_ICS_POLL_MINUTES` | `30` | ICS feed polling interval (5–1440). |

`APP_URL` decides the OAuth redirect URIs; `APP_ENCRYPTION_KEY` encrypts the stored credentials (rotating it without re-encrypting
makes every connection show "Reconnect needed"). The jobs run from the scheduler (`POST /api/internal/tick` with `CRON_SECRET`).

## Provider contracts verified (2026-10-16)

Read from the providers' own machine-readable sources, not from memory:

- **Google Calendar API v3** discovery document (`https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest`, revision 20261012):
  base `https://www.googleapis.com/calendar/v3/`; `calendarList.list` (GET `users/me/calendarList`, `minAccessRole`, `pageToken`);
  `freebusy.query` (POST `freeBusy`, `FreeBusyRequest.items[].id`, `timeMin`, `timeMax`; response `calendars{id: {busy[], errors[]}}`);
  `events.list` (`syncToken`, `singleEvents`, `timeMin`/`timeMax` — not allowed together with `syncToken`; `410` means the token expired
  and a full sync is needed; `nextSyncToken` only on the last page); `events.insert`/`patch`/`delete` (`conferenceDataVersion` 0–1,
  `sendUpdates` all/externalOnly/none); `Event` fields used: `id` (base32hex, 5–1024 chars, client-chosen allowed), `status`,
  `transparency`, `start`/`end` (`date` | `dateTime` + `timeZone`), `originalStartTime`, `attendees[].self/responseStatus`,
  `eventType`, `extendedProperties.private`, `conferenceData.createRequest{requestId, conferenceSolutionKey.type: "hangoutsMeet",
  status.statusCode: pending|success|failure}`, `conferenceData.entryPoints[]{entryPointType: "video", uri}`, `hangoutLink`, `etag`;
  `CalendarListEntry.conferenceProperties.allowedConferenceSolutionTypes`; the scope list and each method's accepted scopes.
- **Google OAuth / OpenID** (`https://accounts.google.com/.well-known/openid-configuration`): authorization
  `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, revocation
  `https://oauth2.googleapis.com/revoke`, userinfo `https://openidconnect.googleapis.com/v1/userinfo` (`sub`, `email`), PKCE `S256`.
- **Microsoft identity platform v2** (`https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration`):
  `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` and `/token`, `offline_access` scope, `response_mode=query`.
- **Microsoft Graph v1.0** `$metadata` and the OpenAPI description in `microsoftgraph/msgraph-metadata` (`openapi/v1.0/openapi.yaml`):
  `/me` (`id`, `mail`, `userPrincipalName`), `/me/calendars` (`isDefaultCalendar`, `canEdit`, `allowedOnlineMeetingProviders`),
  `/me/calendars/{id}/calendarView` (`startDateTime`, `endDateTime` required, `@odata.nextLink`), `/me/calendar/getSchedule`
  (returns `scheduleInformation[].scheduleItems[]{status, start, end}`; `freeBusyStatus` = unknown|free|tentative|busy|oof|workingElsewhere),
  `POST /me/calendars/{id}/events`, `PATCH`/`DELETE /me/events/{id}` (DELETE takes `If-Match`), `event` fields `showAs`, `isCancelled`,
  `originalStart`, `transactionId`, `isOnlineMeeting`, `onlineMeetingProvider` (`teamsForBusiness`), `onlineMeeting.joinUrl`,
  `responseStatus.response`. From the Graph documentation source (`microsoftgraph/microsoft-graph-docs-contrib`): the `getSchedule`
  body uses `schedules`, `startTime`, `endTime`, `availabilityViewInterval` (the CSDL declares the same parameters in PascalCase; we send
  the documented camelCase); times come back in UTC unless `Prefer: outlook.timezone` says otherwise; `getSchedule` is **not supported for
  personal Microsoft accounts** (hence the `calendarView` fallback); `calendarView` `$top` is at most 1000; `transactionId` is how Graph
  drops a repeated create.
- **CalDAV / WebDAV / iCalendar RFCs:** RFC 4791 (calendar-home-set, supported-calendar-component-set, calendar-query REPORT with
  `time-range`, calendar-data), RFC 4918 (PROPFIND/multistatus/propstat, ETags), RFC 5397 (current-user-principal), RFC 6764
  (`/.well-known/caldav`), RFC 6578 (sync-token), RFC 5545 (content lines, folding at 75 octets, TEXT escaping, DATE/DATE-TIME/TZID,
  DURATION, RRULE semantics including "DTSTART is always the first instance and counts toward COUNT", EXDATE/RDATE, RECURRENCE-ID,
  STATUS, TRANSP, VTIMEZONE observances, gap/overlap handling).

## Not verified yet

Everything above is covered by tests against a fetch mock built from those contracts. None of it has been run against a live Google,
Microsoft, Apple or other CalDAV account, because no OAuth apps are registered and the rules forbid live calls in tests. Before relying
on it, someone should connect a real account of each kind on a staging deployment and check: Google `events.list` results under the
`calendar.events.freebusy` scope include `id`, `transparency` and `start`/`end` for shared calendars (if not, those calendars fall back
to `freebusy.query`, which works but can't skip iAcquire's own events there); Graph `getSchedule` accepts the camelCase body; iCloud
discovery and `PUT` with an app-specific password; and Meet/Teams link creation on real accounts.
