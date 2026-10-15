# Website Studio: canonical thumbnail and visual QA workflow

The gallery thumbnail is a screenshot of the same `sampleSite(templateKey)` document used by the full preview. It is captured at 1440 × 900 CSS pixels, with reduced motion, loaded fonts, decoded visible images, and two animation frames for layout to settle. The capture route is `/dev/frame/template?key=family.variation`; it is a development route, not a hosted publishing endpoint.

## Identity and freshness contract

`src/lib/website/template-thumbnails.json` records the exact template key, `origin.version`, SHA-256 content signature, renderer revision, renderer hash, and capture viewport. It points to two WebP derivatives per template:

- 720 × 450 for ordinary gallery cards.
- 1080 × 675 for higher-density displays.

The asset filename includes the template key and the leading characters of both content and renderer hashes. A changed document therefore receives a different URL. `canonicalThumbnail()` returns no thumbnail if its content signature, template version, or declared renderer revision does not match. A stale screenshot must fall back to the gallery's honest preview state instead of representing a different design.

The generator hashes sorted `.ts`, `.tsx`, and `.css` files immediately inside `src/components/website/render`, including each filename and its file bytes, then the file bytes of `src/lib/website/css.ts`, `fonts.ts`, and `font-keys.ts`, in that order. Regression tests recompute this hash so visual renderer changes require regeneration even if the revision constant was accidentally left unchanged.

Built-in starter content currently declares revision 2 in `starter-content-catalog.ts`. Changing starter content requires a new built-in revision. Changing the renderer requires updating `TEMPLATE_RENDER_REVISION` in `thumbnail-contract.ts` and regenerating captures. Existing customer documents and published custom-template snapshots keep their own saved content and versions.

## Generate and validate locally

Use the isolated local application. The scripts reject a hosted URL and do not migrate a hosted database, publish a website, change DNS, or deploy the application.

1. Start `npm run studio:qa` in a development terminal. It uses port 3210, its own Next output directory, and local PGLite/upload directories.
2. When Playwright is provided by the Codex dependency runtime rather than this repository, set `PLAYWRIGHT_MODULE` to the absolute `playwright/index.mjs` path. This avoids adding a production browser dependency. `STUDIO_QA_URL` defaults to `http://localhost:3210`.
3. Finish changes to starter content, image mappings, renderer styles, and fonts before capturing. Verify all generated source image assets exist.
4. Run `npm run thumbnails:generate`. It writes the complete manifest only after all 50 captures succeed. If it stops early, keep the last complete manifest; do not present a partial collection as current.
5. Run `npx vitest run tests/website-thumbnail-contract.test.ts tests/website-template-copy.test.ts tests/website-variations.test.ts`. The contract checks all 50 keys, versions, content signatures, renderer hash, local paths, file existence, actual decoded dimensions, and rejection of stale documents.
6. Run the normal typecheck, lint, test, and production-build checks. Do not edit generated screenshots or hashes by hand to make a failing freshness check pass.

The generated gallery derivatives live in `public/website-thumbnails`. The full-resolution comparison captures live in `.data/studio-qa/thumbnail-comparisons` and remain development evidence outside the production bundle. The `.data` directory is ignored by Git; copy only deliberately selected evidence into a reviewed documentation artifact when needed.

## Compare the thumbnail with the preview

For each key, open the real preview at the canonical viewport. Compare it against `.data/studio-qa/thumbnail-comparisons/{key}-canonical.png` and the decoded 720-pixel gallery image. Compare the visible first 900 pixels at proportional scale, rather than comparing a full-page screenshot against a cropped card.

Confirm the same brand name, headline, typography, image crop, palette, navigation, first-section order, and button text. The only expected differences are image compression, proportional scaling, and a different layout when the preview genuinely uses a different viewport. Check the manifest signature against the preview's `data-template-signature` when investigating a mismatch.

Review the actual gallery at 1440, 1024, 768, and 390 pixels. Check that its loaded card sources reference the manifest derivatives, offscreen cards load as they approach the viewport, stable dimensions prevent reflow, and Preview/Customize actions still identify the same template. Review keyboard focus and the preview's close-and-return behaviour as interactions, not screenshot assertions.

## Full-page responsive checks

Run `npm run studio:qa:matrix` against the same isolated server. The matrix navigates all 50 templates, all six pages, and widths 390, 768, 1024, and 1440: 1,200 cases. It records HTTP status, horizontal overflow, heading/main landmarks, scroll position, footer reachability after actual wheel scrolling, and image failures. The machine-readable record is `.data/studio-qa/responsive-results.json`.

Representative full-page screenshots are written to `.data/studio-qa/responsive/{family.firstVariation}-{width}.png`. Inspect them at native or readable scale, including their middle sections and footer. A contact sheet is useful for comparing composition, but it does not replace a readable crop when judging typography or controls.

Pay particular attention to long CTAs, sticky headers, narrow text columns, empty sections, image fallback states, colour contrast, and the distance between the last section and the footer. A footer present in the DOM is insufficient: it must be reachable and visible. A zero horizontal-overflow result does not prove that text is readable.

Image failures, console errors, or screenshots captured before assets exist require investigation and a fresh run. Record any unresolved failure explicitly. Do not describe an early or incomplete matrix as final verification.

## Authenticated editor checks

Seed only the isolated local fixtures with `npm run studio:qa:seed`, then run `npm run studio:qa:editor`. Keep generated credentials under `.data`; do not include session tokens in screenshots or documentation. This exercise is separate from anonymous template rendering and should cover actual selection, contextual styles, image replacement/default restoration, draft saving, refresh persistence, history restoration, and tenant permissions.

Local fixture results establish behaviour in the isolated environment. They do not establish hosted storage, production login, hosted tenant boundaries, or publishing-provider integration unless those paths were explicitly exercised and documented.

## Evidence and honest reporting

Record the command, completion status, number of cases, actual failing rows, and representative screenshot paths. Separate completed checks from pending runs. Report transfer-size or timing measurements only when the browser/network capture supports them, and compare equivalent cold/warm conditions. Never infer successful browser QA from a source inspection, static render, unit test, or thumbnail alone.
