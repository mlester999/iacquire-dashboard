# Current route inventory

Source inventory refreshed from the current repository: 84 UI page sources and 36 route handlers. Source inventory is not rendered visual verification. Per-module QA reports record exact observed routes, states, themes and dimensions; no page is complete merely because it inherits shared styles.

The CRM Blueprints & Snapshots rows (`/admin/crm-blueprints/*`, `/api/admin/crm-blueprints/*`, `/dev/crm-blueprints-preview`) were added on 2026-10-17 without a full refresh, so other modules' newer routes may still be missing from this list. The Blueprint editor (`[id]/edit`) and apply flow (`[id]/apply`) pages are built by their own packages; the rest of `/admin/crm-blueprints` is described in docs and in each page's source comment.

## UI pages

| Route | Source |
| --- | --- |
| /admin/audit | src/app/(admin)/admin/audit/page.tsx |
| /admin/clients/[id]/activation | src/app/(admin)/admin/clients/[id]/activation/page.tsx |
| /admin/clients/[id]/integrations | src/app/(admin)/admin/clients/[id]/integrations/page.tsx |
| /admin/clients/[id] | src/app/(admin)/admin/clients/[id]/page.tsx |
| /admin/clients/[id]/provisioning | src/app/(admin)/admin/clients/[id]/provisioning/page.tsx |
| /admin/clients/[id]/setup | src/app/(admin)/admin/clients/[id]/setup/page.tsx |
| /admin/clients/[id]/website | src/app/(admin)/admin/clients/[id]/website/page.tsx |
| /admin/clients | src/app/(admin)/admin/clients/page.tsx |
| /admin/crm-blueprints | src/app/(admin)/admin/crm-blueprints/page.tsx (library; `?new=1` opens New Blueprint, `?capture=<orgId>` opens capture for that client, `?client=<orgId>` shows the published Blueprints for applying to that client, from its page) |
| /admin/crm-blueprints/[id] | src/app/(admin)/admin/crm-blueprints/[id]/page.tsx (tabs via `?tab=overview\|assets\|versions\|applications\|details`; `?publish=1` opens publishing, removed from the address when the dialog closes) |
| /admin/crm-blueprints/[id]/edit | src/app/(admin)/admin/crm-blueprints/[id]/edit/page.tsx |
| /admin/crm-blueprints/[id]/apply | src/app/(admin)/admin/crm-blueprints/[id]/apply/page.tsx (`?client=<orgId>` preselects the client) |
| /admin/crm-blueprints/import | src/app/(admin)/admin/crm-blueprints/import/page.tsx (`?tab=ghl\|file`) |
| /admin/crm-blueprints/imports | src/app/(admin)/admin/crm-blueprints/imports/page.tsx |
| /admin/crm-blueprints/imports/[id] | src/app/(admin)/admin/crm-blueprints/imports/[id]/page.tsx |
| /admin/crm-blueprints/applications | src/app/(admin)/admin/crm-blueprints/applications/page.tsx |
| /admin/crm-blueprints/applications/[orgId]/[applicationId] | src/app/(admin)/admin/crm-blueprints/applications/[orgId]/[applicationId]/page.tsx |
| /admin/health | src/app/(admin)/admin/health/page.tsx |
| /admin/integrations | src/app/(admin)/admin/integrations/page.tsx |
| /admin/maintenance | src/app/(admin)/admin/maintenance/page.tsx |
| /admin | src/app/(admin)/admin/page.tsx |
| /admin/portfolio | src/app/(admin)/admin/portfolio/page.tsx |
| /admin/projects/[id] | src/app/(admin)/admin/projects/[id]/page.tsx |
| /admin/projects | src/app/(admin)/admin/projects/page.tsx |
| /admin/requests | src/app/(admin)/admin/requests/page.tsx |
| /admin/services | src/app/(admin)/admin/services/page.tsx |
| /admin/setup-templates | src/app/(admin)/admin/setup-templates/page.tsx |
| /admin/support/[id] | src/app/(admin)/admin/support/[id]/page.tsx |
| /admin/support | src/app/(admin)/admin/support/page.tsx |
| /admin/team | src/app/(admin)/admin/team/page.tsx |
| /admin/usage | src/app/(admin)/admin/usage/page.tsx |
| /admin/workforce | src/app/(admin)/admin/workforce/page.tsx |
| /admin/workforce/[slug] | src/app/(admin)/admin/workforce/[slug]/page.tsx (internal employee profile, SOUL.md, runtime and activity) |
| /auth/confirm | src/app/(auth)/auth/confirm/page.tsx |
| /forgot-password | src/app/(auth)/forgot-password/page.tsx |
| /get-started | src/app/(auth)/get-started/page.tsx |
| /invite/[token] | src/app/(auth)/invite/[token]/page.tsx |
| /login | src/app/(auth)/login/page.tsx |
| /no-workspace | src/app/(auth)/no-workspace/page.tsx |
| /reset-password | src/app/(auth)/reset-password/page.tsx |
| /verify-email | src/app/(auth)/verify-email/page.tsx |
| /chat/[slug] | src/app/(chat)/chat/[slug]/page.tsx |
| /chat | src/app/(chat)/chat/page.tsx |
| /activity | src/app/(portal)/activity/page.tsx |
| /add-ons | src/app/(portal)/add-ons/page.tsx |
| /analytics | src/app/(portal)/analytics/page.tsx |
| /appointments | src/app/(portal)/appointments/page.tsx |
| /approvals | src/app/(portal)/approvals/page.tsx |
| /inbox | src/app/(portal)/inbox/page.tsx |
| /knowledge | src/app/(portal)/knowledge/page.tsx |
| /leads | src/app/(portal)/leads/page.tsx |
| /maintenance | src/app/(portal)/maintenance/page.tsx |
| /notifications | src/app/(portal)/notifications/page.tsx |
| /our-work/[slug] | src/app/(portal)/our-work/[slug]/page.tsx |
| /our-work | src/app/(portal)/our-work/page.tsx |
| /overview | src/app/(portal)/overview/page.tsx |
| /projects/[id] | src/app/(portal)/projects/[id]/page.tsx |
| /projects/new | src/app/(portal)/projects/new/page.tsx |
| /projects | src/app/(portal)/projects/page.tsx |
| /retention | src/app/(portal)/retention/page.tsx |
| /sales | src/app/(portal)/sales/page.tsx |
| /settings/ai | src/app/(portal)/settings/ai/page.tsx |
| /settings/billing | src/app/(portal)/settings/billing/page.tsx |
| /settings/escalations | src/app/(portal)/settings/escalations/page.tsx |
| /settings/integrations | src/app/(portal)/settings/integrations/page.tsx |
| /settings/messaging | src/app/(portal)/settings/messaging/page.tsx |
| /settings/notifications | src/app/(portal)/settings/notifications/page.tsx |
| /settings | src/app/(portal)/settings/page.tsx |
| /settings/security | src/app/(portal)/settings/security/page.tsx |
| /settings/team | src/app/(portal)/settings/team/page.tsx |
| /settings/usage | src/app/(portal)/settings/usage/page.tsx |
| /setup | src/app/(portal)/setup/page.tsx |
| /support/[id] | src/app/(portal)/support/[id]/page.tsx |
| /support | src/app/(portal)/support/page.tsx |
| /website/domains | src/app/(portal)/website/domains/page.tsx |
| /website/edit | src/app/(portal)/website/edit/page.tsx |
| /website/history | src/app/(portal)/website/history/page.tsx |
| /website/leads | src/app/(portal)/website/leads/page.tsx |
| /website/new | src/app/(portal)/website/new/page.tsx |
| /website | src/app/(portal)/website/page.tsx |
| /workforce/[slug] | src/app/(portal)/workforce/[slug]/page.tsx |
| /workforce | src/app/(portal)/workforce/page.tsx |
| /onboarding | src/app/(setup)/onboarding/page.tsx |
| /welcome | src/app/(setup)/welcome/page.tsx |
| /dev/crm-blueprints-preview | src/app/dev/crm-blueprints-preview/page.tsx (sample data, 404 in production; `?view=` and `?role=staff`) |
| /dev/integrations-preview | src/app/dev/integrations-preview/page.tsx |
| /dev/mailbox | src/app/dev/mailbox/page.tsx |
| /dev/onboarding-preview | src/app/dev/onboarding-preview/page.tsx |
| /dev/projects-preview | src/app/dev/projects-preview/page.tsx |
| /dev/setup-preview | src/app/dev/setup-preview/page.tsx |
| /dev/site-preview | src/app/dev/site-preview/page.tsx |
| /dev/studio-preview | src/app/dev/studio-preview/page.tsx |
| /dev/website-preview | src/app/dev/website-preview/page.tsx |
| / | src/app/page.tsx |
| /site-runtime/[host]/p/[[...path]] | src/app/site-runtime/[host]/p/[[...path]]/page.tsx |

## Route handlers

| Route | Source |
| --- | --- |
| /api/admin/crm-blueprints/[id]/export | src/app/api/admin/crm-blueprints/[id]/export/route.ts (GET `?version=<n>`; agency session, export permission, rate limited) |
| /api/admin/integrations | src/app/api/admin/integrations/route.ts |
| /api/admin/portfolio/[id]/assets | src/app/api/admin/portfolio/[id]/assets/route.ts |
| /api/admin/projects/[id]/files | src/app/api/admin/projects/[id]/files/route.ts |
| /api/admin/setup/[orgId]/documents | src/app/api/admin/setup/[orgId]/documents/route.ts |
| /api/admin/setup/[orgId] | src/app/api/admin/setup/[orgId]/route.ts |
| /api/admin/setup/[orgId]/stream | src/app/api/admin/setup/[orgId]/stream/route.ts |
| /admin/workforce/open | src/app/(admin)/admin/workforce/open/route.ts (super-admin-only switch to the agency workspace, then the normal chat or employee screen) |
| /api/analytics/export | src/app/api/analytics/export/route.ts |
| /api/assets/[id] | src/app/api/assets/[id]/route.ts |
| /api/assets/upload | src/app/api/assets/upload/route.ts |
| /api/chat/runs/[runId]/stop | src/app/api/chat/runs/[runId]/stop/route.ts |
| /api/chat/runs/[runId]/stream | src/app/api/chat/runs/[runId]/stream/route.ts |
| /api/chat/send | src/app/api/chat/send/route.ts |
| /api/workforce/preview | src/app/api/workforce/preview/route.ts (real provider test against an unsaved draft, isolated session, no persistence) |
| /api/files/[id] | src/app/api/files/[id]/route.ts |
| /api/health | src/app/api/health/route.ts |
| /api/help | src/app/api/help/route.ts |
| /api/internal/tick | src/app/api/internal/tick/route.ts |
| /api/knowledge/documents/[id] | src/app/api/knowledge/documents/[id]/route.ts |
| /api/knowledge/upload | src/app/api/knowledge/upload/route.ts |
| /api/leads/export | src/app/api/leads/export/route.ts |
| /api/portfolio/assets/[id] | src/app/api/portfolio/assets/[id]/route.ts |
| /api/projects/[id]/files | src/app/api/projects/[id]/files/route.ts |
| /api/projects/files/[fileId] | src/app/api/projects/files/[fileId]/route.ts |
| /api/public/portfolio | src/app/api/public/portfolio/route.ts |
| /api/public/services | src/app/api/public/services/route.ts |
| /api/realtime/token | src/app/api/realtime/token/route.ts |
| /api/setup/attachments/[id] | src/app/api/setup/attachments/[id]/route.ts |
| /api/setup | src/app/api/setup/route.ts |
| /api/setup/stream | src/app/api/setup/stream/route.ts |
| /api/support/[ticketId]/attachments | src/app/api/support/[ticketId]/attachments/route.ts |
| /api/support/attachments/[id] | src/app/api/support/attachments/[id]/route.ts |
| /api/webhooks/ghl | src/app/api/webhooks/ghl/route.ts |
| /api/webhooks/paymongo | src/app/api/webhooks/paymongo/route.ts |
| /site-runtime/[host]/asset/[sha] | src/app/site-runtime/[host]/asset/[sha]/route.ts |
| /site-runtime/[host]/form | src/app/site-runtime/[host]/form/route.ts |
| /site-runtime/[host]/robots | src/app/site-runtime/[host]/robots/route.ts |
| /site-runtime/[host]/sitemap | src/app/site-runtime/[host]/sitemap/route.ts |

Redirect aliases are defined in next.config.ts. Development previews are inaccessible in production. Public website runtime routes have their own verified-host and publication authorization boundary; reviewing their UI never publishes a site.
