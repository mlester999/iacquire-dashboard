# Website template discovery

The agency library and client gallery share `discoverTemplates` and `GalleryFilters`. Search words compose with industry, family, style, theme, layout and heading typography. Search includes the displayed industry labels as well as template name, description and tags. The layout and heading typography facets derive from the rendered template document through `contentFacets`.

The agency collection controls include all templates, featured, published, drafts and review, hidden and archived. Their counts use the current secondary filters and only the records supplied by the authorized server query. Client discovery receives published records only. Featured first, recently added, recently updated and alphabetical sorting operate on the final matching collection; popularity is intentionally absent because the client gallery has no reliable popularity dataset. Unknown catalog dates remain unknown and sort after dated records.

Featured status is an explicit agency choice stored in `website_templates.featured`, introduced by the existing `0026_website_studio_admin.sql` migration. The catalog has no implicit featured defaults. `updateTemplateMeta` checks template design permission and additionally checks template publication permission when changing featured status. The server action also requires an agency session. Featured status never makes an unpublished template available to clients.

No schema migration is required for these discovery changes and no hosted migration is applied. Removing a featured choice uses the same authorized metadata action with `featured: false`; it does not edit any website document or template version. The tests use the isolated in-memory PGLite driver.

Card descriptions and design tags lead the card presentation. Version, usage count, internal reference, publication information and updater information are available in the admin Details dialog. The obsolete arbitrary card-picture upload control is removed from the library so thumbnails follow the canonical renderer; previously saved image records and the underlying media storage remain intact.

Verification lives in `tests/website-gallery.test.ts` and `tests/website-featured.test.ts`. Actual local browser screenshots and the discovery interaction report are development-only output in `.data/studio-qa/discovery/`. Browser checks against development preview routes use invented fixtures and do not prove authenticated persistence; the latter requires a separately authenticated run.
