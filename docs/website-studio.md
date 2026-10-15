# Website Studio

Migrations `0021_websites.sql` (sites, versions, publications, domains, forms) and `0026_website_studio_admin.sql` (template library, saved sections,
review comments, archive and edit lock, per-form enquiry details). Code: `src/lib/website/*` (document model, operations, CSS engine, 50 templates,
editor logic, assistant), `src/components/website/*` (renderer, editor, gallery, agency screens), `src/server/websites/*`, `src/app/(portal)/website/*`,
`src/app/(admin)/admin/website-studio/*`, `src/app/site-runtime/*`.

**Status: implemented locally, tested with mocks and an in-memory PostgreSQL, and browser-checked on labelled sample data.** Nothing has been served from a
real host, no DNS record, certificate or domain purchase exists, nothing has been published for a real client, the hosted Supabase project now has migrations `0001`–`0026` (`0026` applied 2026-10-15, see
`docs/website-studio-migration-0026.md`; the hosted database is still empty, so no hosted data exercises it), and the agency screens have **not** been driven in a browser while signed in (see "What was and wasn't verified").

## The two sides

**Agency Website Studio** (`/admin/website-studio`, in the sidebar under Client experience; staff see only the clients they are assigned to, super admins see all):

| Screen | What it does |
| --- | --- |
| Overview | Counts from real records only: managed, published and draft websites, waiting for owner approval, domains needing attention, failed publications, 30-day hosting usage, recent activity. Actions: create a website, browse templates, manage client websites, open the Template Designer, review pending changes |
| Client websites | Search, filter and sort every site you may see, with a still of the current draft, template, status, domain, last edit, last publication, warnings and who is editing. Preview, Edit, Review |
| Client website | Compare the draft with what is live, ask for changes, comment, publish (super admin or owner), roll back, archive and restore, domain status, and open the editor on that client's site. Every action is audited |
| Template library | Create (blank or from any design), duplicate, rename, describe, set industries and tags, feature, hide, publish, archive, version history and restore. Thumbnails come from the canonical template renderer. Only published templates are ever offered to clients |
| Template Designer | The same visual editor on the agency's own template. Working copy and published copy are separate; publishing is a super-admin action and runs template checks |
| Reviews and publishing | Waiting for the owner, approved, changes requested, needs attention, open comments |
| Domains and hosting | Every domain with its separate DNS, routing, certificate and live-check results, hosting usage, and the exact records that must exist outside the application |
| Media library | A client's images (private to that client), add, describe, remove. An image still in use can't be removed |

**Client Website Studio** (`/website`): a template gallery (large still of the real renderer, search, industry and style filters, featured and recently added,
grid or list, full-page preview on desktop/tablet/phone), then the visual editor, then preview, approval and publishing.

## Templates are a starting point

Choosing a template **copies** it. The site keeps its own content, and editing, hiding or unpublishing the template never changes a client's website
(`tests/website-admin.test.ts` publishes a new template version and checks the client's draft is byte-identical). The site records `origin {key, templateId,
version}`. When the agency later publishes a newer version that changes the look, the owner is offered **the newer look only** (colours, fonts, shapes,
spacing) with a list of what would change; taking it saves a restore point first and is one undo step. Words, pictures and sections are never rebased
automatically. Section-level template upgrades are not implemented.

## The 50 designs

Ten families of five (`luxe`, `tech`, `bold`, `corp`, `minimal`, `local`, `care`, `meridian`, `host`, `agency`). They are built from composable section
builders, not recoloured copies. `tests/website-variations.test.ts` reduces each design to six things that give a site its character (type pair, header
structure, shape of the first screen, what is on it, the rhythm of sections down the page, colour) and requires every pair of the 50, including siblings,
to differ on at least four; today about three quarters of all pairs differ on all six. This measures structure; it is not a substitute for looking.

**Every design has its own editable starter photography.** The 50 built-in variations ship with 50 locally served WebP hero images; supporting photo slots use a varied set from the same design family. Nothing is scraped or hotlinked, and the files don't contain client uploads. Portrait artwork remains visibly illustrated rather than inventing customers or staff. A starter photo makes a template preview feel complete, but it is not evidence of the client's work, location or people: the editor labels it as a starter and lets the owner replace it or restore it later. Starter images in ordinary sections or backgrounds require the owner to acknowledge the warning before publication. Images used as proof (gallery, collage, team, testimonials) block publication until replaced with the client's own images.

## The document model

A site is pages → items (a section, or a reference to a shared site-wide section) → columns (12-grid spans) → elements (29 types; `group` and `card` nest,
to a depth of three). Everything is a whitelisted value: there is no HTML, script or free CSS anywhere in the model, and `parseContent` validates the whole
tree (size, ids, depth, links, unique page addresses). Responsive behaviour is **structural**: columns stack, spans and spacing have per-device overrides,
elements can be hidden per device. There is no unrestricted absolute positioning. Pure operations (`src/lib/website/ops.ts`) do every edit, so the editor,
the assistant and the tests share one implementation.

One renderer draws template previews, the editor canvas and published sites. Its CSS uses **container queries**, so any frame width behaves like a device and
several sites can share a page. Editor code is never part of a public site's bundle.

## The visual editor

- Left panel: Pages, Add (sections with live previews, layouts, elements, saved sections), Layers, Media, Design, Settings. Right panel: Edit (content, style,
  motion, per-screen), Comments, Assistant. Top bar: back, save status, Desktop/Tablet/Mobile, zoom, undo/redo, preview, save version, publish or send for
  approval.
- Click selects the innermost item; breadcrumbs select its parents; text is edited in place (inline marks `**bold**`, `*emphasis*`, `[label](link)`).
- Drag and drop on pointer events (mouse, pen and touch) with insertion indicators and valid/invalid feedback; **every drag has a keyboard alternative**
  (Alt+arrows to reorder or move across containers, Ctrl+D duplicate, Delete remove, Esc selects the parent, Enter edits). Column widths and section
  height resize by handle.
- Saved sections (per website, or shared by the agency; copied in, never linked), shared site-wide sections with explicit propagation, copied sections.
- Pages: add (from starters), duplicate, rename, reorder, set homepage, hide from navigation, per-page SEO, delete with confirmation; address collisions
  are impossible.
- Autosave with an explicit status (Saving, Saved, Not saved · Retry, Changed elsewhere), manual save, undo/redo (coalesced, 120 steps), named versions,
  version history with preview and compare, restore (as a new draft, history is never rewritten), and a **revision check** on every save so two editors
  never silently overwrite each other. A soft edit lock tells the second person who is already in, and read-only mode follows until they take over.
- Design panel: colours, fonts, type scale, corners, buttons, spacing, shadows, motion, light/dark. Image fields label starter, uploaded and built-in artwork sources, preserve a starter when an upload replaces it, and offer **Restore default**. A failed upload falls back to that starter; if both sources fail, the slot shows a styled placeholder. Image fields and section backgrounds have a focal-point picker (click, drag or arrow keys). The media library handles upload, alt text and delete protection (an image still used on the site can't be removed; swap it on the site first). Logos can use an optional background-removed copy, with the original as the fallback.

Keyboard shortcuts are listed in the editor (the `?` button).

## The assistant (optional)

Right panel → Assistant. Describe a change in plain English; it shows **exactly what would change** (a list of edits, a short comparison, an optional
preview of the page) before anything happens. Apply saves a restore point (version source `ai`) and then makes the change as **one undoable step**.

- It can only emit edits from a closed list (`src/lib/website/assistant/ops.ts`): design settings, section style, element style, rewording of a heading,
  paragraph or button, adding a section from the library, moving, removing (needs an explicit tick), columns, hiding on a device, per-device tuning, adding a
  page, entrance animation. Each is validated (zod, strict) and applied with the editor's own operations, then the whole site is re-validated; an edit that
  would break the site is dropped and reported.
- It **never invents** testimonials, reviews, awards, certifications, figures, prices, years in business or guarantees. Sections that need them are added
  as bracketed placeholders that block publishing until the owner replaces them, and rewording that contains such a claim is refused unless the owner
  wrote those words themselves. No HTML, script or CSS can be produced.
- Two planners. The **built-in** planner reads common requests (brand colours or hex codes, luxurious, modern, bold, warm or professional looks, dark or
  light, rounder or squarer, spacing, add or move or remove FAQ, testimonials, pricing, gallery, team, process, contact and so on, columns on a selected
  section, a quoted headline or button, phone tuning, add a page) with no network and nothing leaving the browser. When the agency has connected an AI provider
  (Integrations → LLM), **open-ended requests** can use it. It is sent a short outline (business name, tagline, areas, section names and headlines, design
  keywords), **never phone numbers, emails, addresses or page text**; its reply is parsed as JSON, reduced to the closed list, and checked again in the
  browser. It is rate-limited per workspace and falls back to the built-in planner, labelled as such.
- Manual editing never depends on it.

## Draft, versions, approval, publication

| Concept | Rule |
| --- | --- |
| Draft | The working copy (`draft_content`, capped at 240 KB). Saves use an expected-revision check |
| Version | Immutable snapshot (`editor`, `generated`, `checkpoint`, `ai`, `submit`, `publish`, `rollback`). Restoring makes a version the new draft |
| Lifecycle | Draft → Ready for review → Changes requested or Approved → Published, or Publication failed, or Archived. Separate from domain verification. Publishing is one database transaction followed by a probe, so there is no long-running "Publishing" state: a publication whose probe has not succeeded yet reads as "not yet confirmed" |
| Approval | The business owner approves an exact draft; any later edit resets approval. The owner may publish directly. Anyone else, including a super admin acting for a managed client, needs the owner's approval of that exact draft |
| Readiness | `checkReadiness` **blocks** on sample or placeholder text (including `[brackets]` and `{{tokens}}`), unconfirmed or unattributed testimonials, empty testimonial sections, dead internal links and anchors, a disabled or hidden enquiry form, no way to reach the business, and generated starter imagery or built-in art used as proof. It **warns** about claims, starter imagery or illustrations in ordinary sections and backgrounds, missing alt text and missing search description; claim and imagery warnings must be acknowledged |
| Publication | Immutable and numbered, with its own copy of the content and every image. **Rollback** republishes an earlier one as a new one |
| "Live" | Claimed only after a post-publish probe finds the publication's own marker. The scheduler re-checks live sites and opens an incident when one stops answering |

## Trust boundary and security

The public runtime connects as `iaq_site_runtime`, which has **no table privileges**; it can only call a few `SECURITY DEFINER` functions (resolve a verified
host to its live publication, read that publication's images, accept an enquiry, rate-limit, record usage). It cannot read a draft, another tenant or a
credential. Notes specific to this stage:

- **Tenant scoping is decided by the server.** `studioContext` gives a client user their own workspace (a different `orgId` is refused); an agency user must
  be assigned to the client or be a super admin. Staff permissions follow the permission matrix (`website.edit` and `website.review` yes, `website.publish`
  no), mirrored in SQL and checked by a parity test.
- Images and the frames (`/frame/*`) are tenant-scoped and sandboxed (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`, per-request CSP nonce).
- Uploads are re-encoded with `sharp` and size-capped; templates and shared sections can't reference a client's uploaded images (the server refuses).
- Published pictures are served at a few fixed widths (`/_a/<sha>?w=480|768|1080|1440|1920`, WebP, immutable caching); arbitrary sizes are refused.
- The assistant's output is data, not instructions: it is parsed, reduced to the closed list, validated and re-checked, and page text never reaches a
  privileged action. Forged host headers cannot route across tenants (the sites proxy only trusts the verified host).
- No credentials are stored or logged by the Studio. The LLM key is the agency's existing, vaulted connection.

## Forms and CRM

A website enquiry becomes a lead through the provider-independent service layer; the GoHighLevel adapter is unchanged and writes stay behind the existing
flag. Each form element has its own fields, services and **purpose** (contact, consultation, lead, appointment), stored with the enquiry and shown in the
CRM note.

## Domains

(Unchanged from the first stage.) Included address `<label>.SITES_BASE_DOMAIN`; customer-owned domains need a TXT record (`_iacquire-verify`) and a CNAME to
`SITES_CNAME_TARGET`. Verification, routing, SSL and "live" are separate checks; a domain is not called connected or secure until each has actually passed.
The platform never buys a domain and never assumes wildcard DNS exists.

## What was and wasn't verified

| Verified how | What |
| --- | --- |
| Unit and integration tests (local PostgreSQL, mocks) | Document model, operations, history, geometry, diff, presets, publish checks, legacy upgrade, assistant (validation, claim guard, planners, model-reply parsing, AI boundary), server modules (template lifecycle and permissions, client independence, agency scoping, comments, lock, archive, saved sections, template-update, responsive pictures), 50-design differentiation, runtime and domains |
| Browser, sample data, no sign-in | `/dev/studio-preview` (editor with an in-memory API): selection, inline editing, drag reorder and insertion, undo/redo, autosave state, assistant propose/apply/undo and removal confirmation. `/dev/gallery-preview`. `/dev/admin-studio-preview?view=overview|websites|workspace|library|reviews|domains` (agency screens with invented data). Every one of the 50 designs loaded in an isolated frame at 390, 768, 1024 and 1440 px with **no horizontal overflow** |
| **Not verified** | Signed-in agency and client flows against a real database in a browser; real hosted Supabase; real DNS, certificates, domain purchases, publishing to a real host; the AI provider (mocked only); screen-reader walkthroughs by a person; touch hardware |

## Needs your decision or access

- Wildcard DNS and certificate for `SITES_BASE_DOMAIN`, a separate sites deployment and a CNAME target. Until then, sites exist only locally.
- An AI provider connection if the assistant should handle open-ended requests.
- The client should replace starter photography with approved images before using galleries, collages, team photos or testimonials as proof. Starter imagery in ordinary sections can be reviewed and explicitly acknowledged.
- Whether and how to resell domains. Nothing is priced in code.

Sample data: `/dev/studio-preview`, `/dev/gallery-preview`, `/dev/admin-studio-preview`, `/dev/website-preview` (all 404 in production).
