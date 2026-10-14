# Finance, billing controls and agency reporting

Migrations `0018_billing_credits.sql` (credits, payments, metering) and `0025_commercial_operations.sql` (agency finance entries).
Code: `src/server/billing/{ledger,service,finance,rates}.ts`, `src/lib/{billing,finance}.ts`, `src/app/(admin)/admin/billing`,
`src/components/admin/finance-workspace.tsx`. Tests: `tests/billing*.test.ts`, `tests/finance.test.ts` (12).
Status: **Implemented locally, tested with mocks.** PayMongo credentials are not configured; nothing has been charged.

## Pricing rules (fixed; not changed by code)

- **$1,499 one-time setup.** **$0 mandatory subscription.**
- **Metered usage = provider wholesale cost × 1.30** (`markup_bps = 13000`), taken from the client's prepaid credits. The rate that applied is stored
  with every event (immutable rate versions), so a later rate change never rewrites history.
- **Optional $299/month maintenance** is a separate, opt-in service (see [custom-projects.md](custom-projects.md)).
- Fair use replaces any "unlimited" claim: see [fair-use-and-inactivity.md](fair-use-and-inactivity.md).

## Credits are not income

A client's top-up is **prepaid service owed back**, held apart from income (`prepaid.heldForClientsMicros`) and recognised only as usage is consumed.
The ledger is append-only, in micro-dollars; reservations hold credit before a send and release it if the send is blocked or fails. Whether prepaid
credits need a particular legal or tax treatment (and any expiry or refund terms) is for your accountant and counsel. Nothing here decides it.

## Keeping the numbers distinct

The statement (`/admin/billing`, Statement tab) never merges these:

| Line | Meaning |
| --- | --- |
| Money received | Setup fees, maintenance, custom projects, domains, less refunds. Cash, not profit |
| Usage charged / provider cost / markup contribution | The 30% is a **contribution toward costs**, not a profit |
| Usage that could not be collected | A real cost: the provider was still paid |
| Payment processing fees | Recorded per payment. Payments with no fee recorded yet are counted and flagged: the figure is understated until they are entered |
| Direct costs | Belong to one client (a domain bought for them, an absorbed provider fee) |
| Overhead | Running the agency; never allocated to clients, so a client row is a *contribution*, not a profit |
| Tax set aside | Entered by you. The portal does not guess a rate. A suggestion appears only if you set a rate |
| Operating reserve | **A recommended $200 per setup payment is shown as internal planning only.** It is not charged to clients and not shown to them. You record what you actually set aside or use |
| Estimate available to distribute | Result before set-asides, less tax and reserve set aside. A planning estimate, labelled as such, shown to super admins only |

Staff assigned to some clients see only those clients; agency-wide costs, reserve and the distribution estimate are super-admin only. Entries
can be voided with a reason but never edited or deleted.

## Agency billing controls (`/admin/billing`)

FX rate (USD→PHP with its source and date), the PayMongo status (test or live; live checkout stays disabled until a super admin records the
live-payments review), unit rates by provider and unit type (publishing a new rate creates a new version), credit adjustments (correction or
goodwill, with a reason, never below zero), provider fees, the reconciliation check, and payment webhook events that matched nothing.

## Needs your decision or access

- PayMongo **test** secret key and webhook secret to exercise checkout end to end. Live keys only after the live-payments review.
- Real provider unit prices to replace the sample rates, and an FX source you trust.
- Accountant review of the reserve guidance, the tax rate, credit treatment, and receipts or invoices required for Philippine and foreign clients.
