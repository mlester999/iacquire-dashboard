# Fair use and inactivity

Migration `0025_commercial_operations.sql`. Code: `src/lib/fair-use.ts`, `src/server/fairuse/service.ts`, `src/server/inactivity/service.ts`,
`src/components/fairuse/fair-use-card.tsx`, `src/components/admin/fair-use-admin.tsx`, `/admin/usage`, `/settings/usage`.
Tests: `tests/fair-use-inactivity.test.ts` (19). Status: **Implemented locally, tested with mocks.**

## Fair use is measured, not invented

The product has no monthly platform fee, and is described as fair use, not "unlimited". **No limit ships.** Until the agency has measured real provider
costs and chosen numbers, every measure reads **"No limit set"** to the client and to staff. Six measures are recorded from real data per workspace:
file storage, website bandwidth (30 days), website requests (30 days), AI employee runs (30 days, which now include the replies the employees prepared for
customers, recorded since migration 0104), lead research requests (30 days), and stored messages.

Separately from fair use, the usage limits an agency Super Admin sets per client (`/admin/clients/<id>`, Usage tab) gained an optional **monthly cap on AI
replies to customers**. It is blank by default (shown as "No cap set", never "unlimited"); when set and hard stop is on, the AI employee makes no further
model call for a customer message once the month's count is reached, leaves an internal note, and asks a person to reply. No number is shipped: it is the
founder's decision.

| Setting | Behaviour |
| --- | --- |
| Threshold | A warning level and/or a limit, for all clients or one client (a client's own setting wins). Super admins only. Optional note (for example the provider cost it is based on) |
| Warning only | Default. Crossing a threshold notifies the owner and managers (plain words, once per worsening per month) and the agency |
| Refuse new uploads | **Storage only.** Past the limit, new uploads are refused with a clear message. Nothing already stored is deleted and the website is never touched |
| Everything else | Reported, never switched off |

The hourly `fairUseChecks` job records where each workspace stands (`fair_use_status`). The agency sees a fleet view and manages thresholds at
`/admin/usage`; clients see their own measurements on Settings → Usage.

## Inactivity review

A workspace with no sign of activity for **180 days** gets a review (`account_activity_reviews`). Activity means a sign-in, a portal action, a customer message,
a website enquiry, a payment, an earlier review decision, or a **live, healthy website** (a business whose site is working is not inactive):

1. The owner is reminded at day 0, +30 and +60 (at most three notices). The wording says nothing has been switched off.
2. The agency sees it under **Quiet accounts** at `/admin/usage` and on the client's offboarding page.
3. Any activity closes the review as reactivated. Otherwise staff decide: **keep the account** (a note is recorded and the clock restarts) or start offboarding.

**Nothing is paused, deleted or billed automatically because an account is quiet.**

## Needs your decision

- The numbers: thresholds per measure, and whether to refuse new uploads for storage. Base them on actual hosting and storage cost.
- Whether 180 days and the three-notice cadence match your terms of service.
