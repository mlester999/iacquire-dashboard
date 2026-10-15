# Website Studio: canonical thumbnail and visual QA workflow

The gallery thumbnail is a screenshot of the same `sampleSite(templateKey)` document used by the full preview. It is captured at 1440 × 900 CSS pixels, with reduced motion, loaded fonts, decoded visible images, and two animation frames for layout to settle. The capture route is `/dev/frame/template?key=family.variation`; it is a development route, not a hosted publishing endpoint.

## Identity and freshness contract

`src/lib/website/template-thumbnails.json` records the exact template key, `origin.version`, SHA-256 content signature, renderer revision, renderer hash, and capture viewport. It points to two WebP derivatives per template:

- 720 × 450 for ordinary gallery cards.
- 1080 × 675 for higher-density displays.

The asset filename includes the template key and the leading characters of both content and renderer hashes. A changed document therefore receives a different URL. `canonicalThumbnail()` returns no thumbnail if its content signature, template version, or declared renderer revision does not match. A stale screenshot must fall back to the gallery's honest preview state instead of representing a different design.

The generator hashes sorted `.ts`, `.tsx`, and `.css` files immediately inside `src/components/website/render`, including each filename and its file bytes, then the file bytes of `src/lib/website/css.ts`, `fonts.ts`, and `font-keys.ts`, in that order. Regression tests recompute this hash so visual renderer changes require regeneration even if the revision constant was accidentally left unchanged.

Built-in starter content currently declares revision 3 in `starter-content-catalog.ts` (the history is in the comment above it). Changing starter content requires a new built-in revision. Changing the renderer requires updating `TEMPLATE_RENDER_REVISION` in `thumbnail-contract.ts` (currently `studio-2026-10-15-v3`) and regenerating captures. Existing customer documents and published custom-template snapshots keep their own saved content and versions; a built-in revision only reaches new websites.

The renderer hash is taken over file bytes, so it is sensitive to line endings. Several files in this repository are committed with CRLF line endings; keep them that way (a scripted edit that rewrites a CRLF file as LF changes the hash and bloats the diff), and do not enable `core.autocrlf` conversion on a machine that regenerates or verifies thumbnails.

## Generate and validate locally

Use the isolated local application. The scripts reject a hosted URL and do not migrate a hosted database, publish a website, change DNS, or deploy the application.

1. Start `npm run studio:qa` in a development terminal. It uses port 3210, its own Next output directory, and local PGLite/upload directories.
2. When Playwright is provided by the Codex dependency runtime rather than this repository, set `PLAYWRIGHT_MODULE` to the absolute `playwright/index.mjs` path (a plain file path, not a `file://` URL; the scripts convert it themselves). This avoids adding a production browser dependency. `STUDIO_QA_URL` defaults to `http://localhost:3210`, and every script refuses any other host.
3. Finish changes to starter content, image mappings, renderer styles, and fonts before capturing. Verify all generated source image assets exist.
4. Run `npm run thumbnails:generate`. It writes the complete manifest only after all 50 captures succeed. If it stops early, keep the last complete manifest; do not present a partial collection as current.
5. Run `npx vitest run tests/website-thumbnail-contract.test.ts tests/website-template-copy.test.ts tests/website-variations.test.ts`. The contract checks all 50 keys, versions, content signatures, renderer hash, local paths, file existence, actual decoded dimensions, and rejection of stale documents.
6. Run `npm run studio:qa:thumbnails` (see below) to compare every screenshot with the preview a client actually opens.
7. Run the normal typecheck, lint, test, and production-build checks. Do not edit generated screenshots or hashes by hand to make a failing freshness check pass.

The generated gallery derivatives live in `public/website-thumbnails`. The full-resolution comparison captures live in `.data/studio-qa/thumbnail-comparisons` and remain development evidence outside the production bundle. The `.data` directory is ignored by Git; copy only deliberately selected evidence into a reviewed documentation artifact when needed.

## Compare the thumbnail with the preview

`npm run studio:qa:thumbnails` does this for all 50 templates in a real browser, the way a client does it: it finds the card in the gallery, checks that the card shows the stored screenshot and not the live fallback, opens Preview, and compares the top of the framed website with that screenshot. It checks three things:

1. **Identity.** The card's `data-thumbnail-signature` and version, the manifest entry, and the framed website's `data-template-signature`, `data-template-version` and `data-template-frame` must all name the same template, version and content.
2. **The card.** It must show the file the manifest names, fully decoded, with no live `iframe` standing in for it.
3. **The picture.** The screenshot and the top 1440 × 900 of the preview are resized to 720 × 450 and compared. The threshold is not guessed: the same screenshot is also compared with the previews of *other* templates (every other design of its family, which are the nearest look-alikes, plus a deterministic sample of the rest), and a real pair must sit below a quarter of the way from the worst real pair to the closest wrong pair. If real and wrong pairs cannot be told apart on the data, the run fails because it would prove nothing.

The preview is compared in a window in which the framed website sees a 900-pixel-tall viewport, exactly as the screenshots are taken. This matters: a section sized in `vh` (a 90vh hero) follows the window, so comparing a 900px screenshot with a preview in a taller window produced differences of 9 to 18% for a dozen templates that were not defects. Evidence is written to `.data/studio-qa/thumbnail-compare.json` and, for each template, `.data/studio-qa/thumbnail-comparisons/{key}-compare.jpg` (screenshot, preview, and a four-times-amplified difference side by side).

To see the check do its job, run it before regenerating after any renderer or content change: every card falls back to a live frame, the identity lines name different signatures, and the pictures differ.

Manual review still matters for taste. Confirm the same brand name, headline, typography, image crop, palette, navigation, first-section order, and button text. Review the actual gallery at 1440, 1024, 768, and 390 pixels. Check that its loaded card sources reference the manifest derivatives, offscreen cards load as they approach the viewport, stable dimensions prevent reflow, and Preview/Customize actions still identify the same template. Review keyboard focus and the preview's close-and-return behaviour as interactions, not screenshot assertions.

## Full-page responsive checks

Run `npm run studio:qa:matrix` against the same isolated server. The matrix navigates all 50 templates, all six pages, and widths 390, 768, 1024, and 1440: 1,200 cases. It records HTTP status, horizontal overflow, heading/main landmarks, scroll position, footer reachability after actual wheel scrolling, and image failures. The machine-readable record is `.data/studio-qa/responsive-results.json`.

Representative full-page screenshots are written to `.data/studio-qa/responsive/{family.firstVariation}-{width}.png`. Inspect them at native or readable scale, including their middle sections and footer. A contact sheet is useful for comparing composition, but it does not replace a readable crop when judging typography or controls.

Pay particular attention to long CTAs, sticky headers, narrow text columns, empty sections, image fallback states, colour contrast, and the distance between the last section and the footer. A footer present in the DOM is insufficient: it must be reachable and visible. A zero horizontal-overflow result does not prove that text is readable.

Image failures, console errors, or screenshots captured before assets exist require investigation and a fresh run. Record any unresolved failure explicitly. Do not describe an early or incomplete matrix as final verification.

## Authenticated editor checks

Seed only the isolated local fixtures with `npm run studio:qa:seed`, then run `npm run studio:qa:editor`. Keep generated credentials under `.data`; do not include session tokens in screenshots or documentation. This exercise is separate from anonymous template rendering and should cover actual selection, contextual styles, image replacement/default restoration, draft saving, refresh persistence, history restoration, and tenant permissions.

Local fixture results establish behaviour in the isolated environment. They do not establish hosted storage, production login, hosted tenant boundaries, or publishing-provider integration unless those paths were explicitly exercised and documented.

## Browser QA suites

All of them run against the isolated local application (`npm run studio:qa`, port 3210), refuse any other host, need no network and no hosted service, and write development evidence under `.data/studio-qa` (ignored by Git). Several can run against a frozen copy of the source instead, because editing files while a development server is serving them produces transient chunk-load errors that look like defects. Start that copy on another port, and point `STUDIO_QA_URL` at it.

| Command | What it proves | Evidence |
| --- | --- | --- |
| `npm run studio:qa:preview-scroll` | In the real flow (gallery, Preview, framed website) at 1440, 1024, 768 and 390: a mouse wheel reaches the footer over the website and over the empty area beside it, Page Down, End and Home work from the dialog's own controls and from inside the website, switching width keeps the reader in the same section, all pages scroll to their footers, Escape closes the dialog, returns focus and releases the scroll lock. Touch is exercised for a sample (synthetic gestures). The bug it was written for (a footer in the page that a wheel could not reach in the dialog) is detected by reading the position after real wheel events, not by looking for the footer. | `preview-scroll-results.json` |
| `npm run studio:qa:text-fit` | Every page of every template at 390, 768, 1024 and 1440 (1,200 views): no horizontal overflow, no word split across lines, no text clipped by a box, no body text under 12px, no header button squeezed onto three lines, nothing starting behind a floating header, and (with `AXE_SOURCE=/path/to/axe.min.js`, a QA tool that is not an application dependency) every text colour meets WCAG AA contrast. | `text-fit-results.json` |
| `npm run studio:qa:image-text` | Text laid over a photograph stays readable: the text is made invisible, the section is photographed, and at least 90% of the pixels behind each line must give it WCAG contrast (3:1 large, 4.5:1 body). A colour-contrast checker cannot judge this because the background is a picture. `OVERLAY=dark:66` repaints every overlay to find the weakest one that works. | `image-text-results.json`, marked images in `image-text/` |
| `npm run studio:qa:a11y` | axe-core in a real browser (WCAG 2.0/2.1 A and AA plus best practice, with `AXE_SOURCE` set) on the client gallery, its Preview dialog and every design's home page at two widths: names, roles, landmarks, headings, contrast. It is necessary, not sufficient: reading order, focus management and what a screen reader says are checked through the keyboard behaviours in the other suites. | `a11y-results.json` |
| `npm run studio:qa:anchors` | A link to a section on the page lands below a sticky or floating header on every template, at 1440 and 390. `CONTROL=1` removes the anchor offset and the check must then fail. | `anchor-results.json` |
| `npm run studio:qa:thumbnails` | Screenshot, card, manifest and preview agree (above). | `thumbnail-compare.json`, `thumbnail-comparisons/` |
| `npm run studio:qa:visual` | Full-page captures of every template at 1440 and 390 and a contact sheet per family, for human review of composition. | `visual-review/` |
| `npm run studio:qa:library` | The agency Template Library: filters, search, sort and their URL state, Featured (durable, super-admin only, never automatic), usage counts hidden from staff, breadcrumbs, empty state and focus return, in a real browser with real sessions. | `library/` (screenshots and `results.json`) |
| `npm run studio:qa:editor` | The visual editor with a real signed-in session: selection, contextual properties, image replace and restore, autosave, version restore, master/client isolation, phone and tablet layouts. | `editor/` |
| `npm run studio:qa:publish-seed`, then `npm run studio:qa:published` | Publishes three fixture sites through the real service calls (with the QA server stopped, because PGLite is single-process), then drives the *published runtime* as a visitor: status, one `h1`, skip link, security headers, no overflow, no broken pictures, wheel and End reach the footer, anchors under a pinned header, the header never crowds the logo, the phone menu opens and navigates, robots and sitemap. | `published-site-results.json` |
| `npm run studio:qa:perf`, `npm run studio:qa:frame-weight` | Gallery and per-template image weight, request counts, layout shift and preview-ready time. | `gallery-perf-*.json`, `frame-weight-*.json` |

Why these exist: each one was written after something the earlier suites passed turned out to be wrong in a browser. A footer in the DOM was not a footer a reader could reach; a heading with no horizontal overflow still split a word across lines; a colour-contrast pass said nothing about white words on a bright photograph; a header that fit at 1440 crushed its call to action at 1024. Add a check, and a negative control for it, when the next such thing is found.

### Fixtures

All of these write only to the isolated local database under `.data/studio-premium-qa`, refuse to run against anything else, and need the QA server **stopped** (PGLite is single-process): `npm run studio:qa:seed` (accounts, two client organisations with websites, a master template, a fresh client with no website), `npm run studio:qa:fresh-seed` (one more single-use fresh client; a client who has made a website is sent straight to it, so the library QA's "start a website from a design" step uses the first fresh client that still has none, and says so when it has run out), `npm run studio:qa:publish-seed` (three published sites) and `npm run studio:qa:inspect` (read-only: which template version each website started from, and which templates are Featured). Nothing is Featured unless an agency person chose it; the library QA features one design to test the flow and restores it even if it fails.

### What the checks cannot see

They do not replace looking. They cannot judge taste, spacing rhythm or whether a photograph suits a business. Text over images is measured against the pixels, not against how the picture feels. The published-site run uses the isolated local runtime, so real hosting, DNS, certificates and a CDN are unverified. The fixture sites were published by removing the galleries, collages, team and testimonial sections first, because the publish check correctly refuses starter photographs there. Touch is exercised by synthetic gestures, not on hardware, and screen-reader behaviour was checked from the accessibility tree and keyboard order, not with a screen reader.

## Responsive photographs and caching

Built-in starter photographs are offered at 640, 1024 and 1536 pixels (`templateImageSrcSet`), so a phone is not sent the full-size file. The smaller copies are made by `node scripts/generate-template-image-sizes.mjs` into `public/template-images-sized` from the originals in `public/template-images`, which are never modified; `tests/website-template-image-sizes.test.ts` fails if an original is replaced without regenerating, if a copy has the wrong width or is not far lighter than its original, or if a file is left over. The starter photographs keep their names when replaced, so they are cached for a day and revalidated quietly for a week (`next.config.ts`); gallery screenshots carry their content and renderer hashes in the file name and are cached as immutable.

### Measured effect (2026-10-15)

Measured with `npm run studio:qa:perf` and `npm run studio:qa:frame-weight` against two development servers started from the same machine, one from the original commit and one from this tree, in a real Chromium with a cold cache. A development server compiles on demand and serves unminified code, so the page totals below include development JavaScript and are only meaningful as a **comparison between the two**; the image bytes are what a production server sends. The page measured is the client gallery at `/dev/gallery-preview` (the same `TemplateGallery` component as `/website/new`, without a sign-in), median of three runs, at 1440 × 900. A production-build timing was not taken.

| Gallery | Original commit | This tree |
| --- | --- | --- |
| Screenshots used by the cards | 0 of 50 (every stored screenshot was stale, so every card fell back to a live frame) | 50 of 50 |
| Live preview frames mounted | 6 on the first screen, 9 at the peak | 0 |
| First load | 151 requests, 30,569 KB (images 4,113 KB) | 32 requests, 3,938 KB (images 530 KB) |
| Scrolled through all 50 cards | 323 requests, 48,681 KB (images 6,131 KB), 51 documents | 64 requests, 7,871 KB (images 1,252 KB), 1 document |
| First-screen thumbnails visible | never settled (live frames, still loading when the 25 s limit ended the wait) | about 1.1 s |
| Layout shift (CLS) | 0.0003 | 0.0003 |
| Click Preview until the website is usable | 9.8 s; 24.6 s on a 9 Mbit/s, 150 ms profile | 2.2 s; 5.1 s on the same profile |

The original commit's stored screenshots were stale because the starter content and photographs changed after they were captured; nothing detected it, and the gallery quietly drew fifty live websites instead. `tests/website-thumbnail-contract.test.ts` now fails the build's tests when a screenshot is out of date, which is the lasting fix; regenerating them is what produced these numbers.

Image weight to read one template's home page, every lazy picture fetched (all 50 templates, original commit against this tree):

| Window | Mean | Median | Heaviest |
| --- | --- | --- | --- |
| 390 px, 2x screen | 652 KB to 228 KB (-65%) | 483 KB to 167 KB | 1,712 KB to 974 KB |
| 1440 px, 1x screen | 682 KB to 287 KB (-58%) | 483 KB to 243 KB | 1,712 KB to 1,019 KB |

A 3x phone asks for a picture wide enough for 1,170 pixels and is therefore still sent the full-size file for a picture that fills its width; the saving there is smaller, and was not measured.

## Evidence and honest reporting

Record the command, completion status, number of cases, actual failing rows, and representative screenshot paths. Separate completed checks from pending runs. Report transfer-size or timing measurements only when the browser/network capture supports them, and compare equivalent cold/warm conditions. Never infer successful browser QA from a source inspection, static render, unit test, or thumbnail alone.
