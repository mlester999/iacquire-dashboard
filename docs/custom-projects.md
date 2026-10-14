# Custom Projects, Add-ons, Portfolio and Maintenance

Everything here is **optional**. It sits beside the core iAcquire system and never gates it.

| Offer | Price | Notes |
| --- | --- | --- |
| Core: iAcquire AI-Powered Client Acquisition System | $1,499 one-time setup | Not an add-on. Standard AI employees in the package are never charged separately. |
| Optional managed maintenance | $299/month | Opt-in only. Starts after the core system is activated and the plan is accepted and activated. |
| Ready-to-use automations | $499–$999 | Published range; final price confirmed in writing. |
| Ready-to-use AI agents | $699–$1,499 | Same. |
| Websites, funnels, Shopify starter | $899–$1,799 | Same. |
| Custom automation system | from $1,500 (2–4 weeks) | Quoted after discovery. |
| Custom AI agent | from $2,000 (3–6 weeks) | Quoted after discovery. |
| Custom web / SaaS / Shopify | from $2,500 (4–10 weeks) | Quoted after discovery. |

These numbers live in the database (`service_catalog` + `service_price_versions`), **not** in components.
The client UI, the help assistant and the public feed all read them from there. The founder's own
$300/month support rate on automatewithmarky.com is deliberately **not** used: iAcquire's plan is $299.

## Source of the catalog

Read from the live site (https://www.automatewithmarky.com/systems and `/services/ai-automation`) on
2026-10-14: the 12 ready-to-use systems with their published ranges, delivery windows, "what you get",
platforms and "built on real work" references, plus the three custom-build tiers with typical scope and
timelines. Migration `0015_custom_projects.sql` seeds them as `founder_portfolio` price version 1.
Example use cases and "what it can accomplish" lines are plain restatements of the published
"what you get" / "problem it solves" text; no results or testimonials were added. Admins can edit all of it.

## Client portal

| Route | Purpose |
| --- | --- |
| `/add-ons` (alias `/dashboard/add-ons`) | Marketplace: category filters, search, cards, details, "Need something more specific?" |
| `/projects/new` | Request wizard (title, problem, current process, desired outcome, tools; optional deadline, budget, files). Live suggestions from published services. |
| `/projects` (alias `/dashboard/projects`) | Every requested project, with attention flags |
| `/projects/[id]` | Progress stepper, quote review/decision, milestones with approvals, updates, conversation, files, project-linked support |
| `/maintenance` | Optional plan, scope, allowance, the four help lanes, requests |
| `/our-work`, `/our-work/[slug]` | "Selected Work from Our Founder" gallery and case studies |

Permissions (mirrored in `src/lib/permissions.ts` and migration 0015, verified by test):

| Permission | Roles |
| --- | --- |
| `projects.view` | all client roles, agency staff, super admin |
| `projects.request` | owner, admin (request, message, upload, approve milestones, request quote changes) |
| `projects.approve_quote` | owner only (accept or decline a quote) |
| `projects.manage`, `quotes.manage` | agency staff (assigned clients), super admin |
| `catalog.manage`, `portfolio.manage` | super admin |
| `maintenance.view` / `.request` / `.manage_plan` / `.manage` | owner+admin / owner+admin / owner / staff+super |

## Agency admin

`/admin/projects` (queue, filters by status, client, mine, needs review) and `/admin/projects/[id]`
(assign, status workflow with enforced transitions, information requests, internal notes, quote builder,
milestones, deliverables, progress updates, handover). `/admin/services` (catalog + categories + price
history), `/admin/portfolio` (review gate, images, import), `/admin/maintenance` (plans and requests).

## Lifecycle rules (enforced in code and, where marked, in the database)

* A request is filed under the authenticated tenant, gets a `PRJ-` reference, notifies the agency
  (in-app, and Slack with no content if configured) and creates an admin review task. **Nothing is charged.**
* Status moves only through `STATUS_TRANSITIONS`. `Approved` is reached only by a client accepting a quote;
  `Completed` only by recording the handover from *Ready for Review* (client-approval milestones must be done).
* Quotes: drafts are invisible to clients (RLS). Sending computes a SHA-256 of the client-visible terms.
  The client's decision re-checks that hash, so a decision is always tied to the exact terms shown.
  Decisions are append-only (`quote_approvals`, trigger-enforced) and record account, time and an
  acknowledgement text. **It is not an electronic signature** and no payment is started.
* Only agency staff set prices. Clients have no write grants; agency-only columns (`internal_notes`) are
  not granted to the app role at all, so clients cannot read or change them.
* Every significant change writes an audit entry (never message bodies, internal-note contents or secrets).

## Maintenance

* Eligibility: the tenant's setup instance must be `activated`.
* The owner explicitly accepts the terms; the agency then activates it and sets the billing start date.
* Allowance: **4 managed requests per calendar month** (editable on the maintenance plan in the catalog).
  A request is one focused change or fix; unused requests don't roll over.
* The four lanes stay separate: core defect corrections (free, never counted; the database refuses to
  charge one to the allowance), basic support (always available), managed maintenance, and new custom projects.
* Requests land in the existing support inbox as tickets.
* **The scope text and the 4-per-month allowance are proposed defaults for the founder to confirm.**

## Portfolio

* `content/founder-portfolio.json` holds the eleven selected projects read from the live site: real
  titles, summaries, technologies, challenge, what was built, contribution, the source's own status labels
  and its "what this case study does not claim" notes. Results are quoted statements, never metrics.
* `npm run portfolio:import` (or the admin button) loads them **hidden and pending review**.
  Publishing requires an explicit confirmation that public disclosure is permitted; the database also
  forbids `visible` without an approved review and that confirmation.
* Image entries are references to the source site. They are **not downloaded automatically**. An admin
  can import an optimized private copy or upload screenshots (converted to WebP, 1600 px and 640 px, EXIF
  stripped, stored in the private `portfolio-assets` bucket). Only stored images can be published. This
  matters because the app's Content-Security-Policy only allows same-origin images.

## Public marketing site

The partner's website repository was not available, so no replacement site was created. Instead:

* `GET /api/public/services`: the core offer, the optional maintenance plan and the optional add-ons,
  kept apart, with starting prices and typical ranges. Published and available items only.
* `GET /api/public/portfolio`: reviewed, disclosure-confirmed projects only, with the founder label and
  disclaimer. No images.
* Both are unauthenticated, rate limited per IP, cacheable, and carry no internal fields.

## Assistant

The floating assistant now answers from the live catalog (articles are generated from the database, so
prices cannot go stale), points custom-build requests to `/projects/new` (or `/add-ons` for members),
and reports the signed-in user's **own** project status through the same tenant-scoped queries as the
pages. It never invents quotes or deadlines, and human help still goes to the support inbox.

## Remaining / not verified

* Not run against a live provider: Stripe or any payment, e-signature, email delivery of quote notices.
  Payment is intentionally not integrated.
* The authenticated pages were checked with unit/integration tests and a no-login preview
  (`/dev/projects-preview`, development only, sample data); they were not driven in a signed-in browser.
* Portfolio screenshots still need an admin to import or upload them before they can be published.
