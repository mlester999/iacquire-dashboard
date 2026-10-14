# Website Studio

Migration `0021_websites.sql`. Code: `src/lib/website/*` (templates, schema, generation, linting), `src/server/websites/*`,
`src/components/website/*` (shared renderer, Studio, portal views), `src/app/(portal)/website/*`, `src/app/(admin)/admin/clients/[id]/website`,
`src/app/site-runtime/*`. Tests: `tests/website-*.test.ts` (six files).
Status: **Implemented locally, tested with mocks and local PostgreSQL.** No site has been served from a real host, no DNS record, certificate or
domain purchase has been made, and no website has been published for a real client.

## What a client gets

- A website built **inside the portal** from one shared renderer. Sites are never built or hosted in GoHighLevel.
- **50 designs**: ten families (Meridian, Haven, Forge, Atlas, Pulse, Local, Ledger, Bloom, Summit, Canvas) with five variations each
  (`template_key` = `family.variation`). Every family can be used for any business; onboarding industry only changes the order they are shown in.
- A first draft **generated from the onboarding answers and approved knowledge** (`src/lib/website/generate.ts`), then edited in the Studio:
  structure panel, inspector, image library (brand assets from onboarding), live preview.
- A free address `<label>.SITES_BASE_DOMAIN`, and up to six custom domains per site.
- Contact-form enquiries that arrive as **website leads** (`/website/leads`) and are processed by the scheduler (`websiteEnquiries`).

## Draft, versions, approval, publication

| Concept | Rule |
| --- | --- |
| Draft | The working copy (`draft_content`, capped at 300 KB). Saves use an expected-revision check, so two editors never silently overwrite each other |
| Version | Immutable snapshot of a draft. Restoring a version makes it the new draft; history is never rewritten |
| Approval | The business owner approves an exact draft. Any later edit resets approval. The owner may publish directly (they are the approver); anyone else, including a super admin acting for a managed client, needs the owner's approval of that exact draft |
| Readiness | `checkReadiness` **blocks** publishing on real problems: leftover sample or placeholder text, testimonials not confirmed as a real customer's words or without a name, empty testimonial sections, and no way for visitors to reach the business. It **warns** about claims (figures, superlatives, guarantees) and gaps (no headline section, no search description). The owner must acknowledge the claim warnings before publishing |
| Publication | Immutable, numbered, with its own copy of the content and of every image. The live one is a single row. **Rollback** republishes an earlier publication as a new one |
| "Live" | Claimed only after a **post-publish probe** requests the site as a visitor would and finds the publication's own marker. Until then it reads as not yet confirmed. The scheduler re-checks live sites (`websiteHealth`) and opens an incident when one stops answering |

## Trust boundary

The public runtime serves the open internet, so it connects as `iaq_site_runtime`, which has **no table privileges**. It can only call a handful of
`SECURITY DEFINER` functions: resolve a verified host to its live publication, read that publication's assets, accept an enquiry, rate-limit, and record
usage. It cannot read a draft, another tenant, a credential or a customer record, even if compromised. Run it as its own deployment
(`DEPLOYMENT_ROLE=sites`) with its own `SITES_FORM_SECRET`.

## Domains

- **Included address:** `<label>.SITES_BASE_DOMAIN`. Reserved names (`www`, `api`, `admin`, `billing`, `ghl`, `hermes`, …) are refused. Wildcard DNS and
  the wildcard certificate are infrastructure the agency provides.
- **Customer-owned domain:** the client adds a hostname, then creates a TXT record (`_iacquire-verify`) to prove control and a CNAME to
  `SITES_CNAME_TARGET` for routing. Verification, routing, SSL and "live" are **separate checks**, each with its own result. A domain is not called
  connected until DNS verification passes, and not called secure until a certificate is actually observed.
- **Purchase:** a client can *request* a domain. The agency quotes the real cost; the client approves it; the agency records the purchase after
  buying it. **The platform never buys a domain.** Registrar renewals are tracked and reminders are sent (`domainRenewals`).
- **Ownership:** a domain registered for the client, or one they connected, is theirs and is never held back (see [offboarding-and-export.md](offboarding-and-export.md)).

## Needs your decision or access

- Wildcard DNS and certificate for `SITES_BASE_DOMAIN`, a separate sites deployment, and a CNAME target. Until then, sites exist only locally.
- Whether and how to resell domains (cost, markup, registrar account). Nothing is priced in code.
- The generated copy and the claims checker are guardrails, not legal review.

Sample data: `/dev/website-preview`.
