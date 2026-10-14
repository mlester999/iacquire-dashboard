# UI and API route inventory

Source inventory for the full application redesign. Visual checks are recorded separately in ui-redesign-audit.md.

| Route | Source | Kind |
| --- | --- | --- |
| / | `src/app/page.tsx` | UI audit scope |
| /dev/setup-preview | `src/app/dev/setup-preview/page.tsx` | Development preview |
| /dev/projects-preview | `src/app/dev/projects-preview/page.tsx` | Development preview |
| /welcome | `src/app/(setup)/welcome/page.tsx` | UI audit scope |
| /verify-email | `src/app/(auth)/verify-email/page.tsx` | UI audit scope |
| /auth/confirm | `src/app/(auth)/auth/confirm/page.tsx` | UI audit scope |
| /chat/[slug] | `src/app/(chat)/chat/[slug]/page.tsx` | UI audit scope |
| /chat | `src/app/(chat)/chat/page.tsx` | UI audit scope |
| /dev/mailbox | `src/app/dev/mailbox/page.tsx` | Development preview |
| /onboarding | `src/app/(setup)/onboarding/page.tsx` | UI audit scope |
| /reset-password | `src/app/(auth)/reset-password/page.tsx` | UI audit scope |
| /notifications | `src/app/(portal)/notifications/page.tsx` | UI audit scope |
| /workforce/[slug] | `src/app/(portal)/workforce/[slug]/page.tsx` | UI audit scope |
| /admin/workforce | `src/app/(admin)/admin/workforce/page.tsx` | UI audit scope |
| /workforce | `src/app/(portal)/workforce/page.tsx` | UI audit scope |
| /dev/integrations-preview | `src/app/dev/integrations-preview/page.tsx` | Development preview |
| /forgot-password | `src/app/(auth)/forgot-password/page.tsx` | UI audit scope |
| /api/support/[ticketId]/attachments | `src/app/api/support/[ticketId]/attachments/route.ts` | API preserved |
| /no-workspace | `src/app/(auth)/no-workspace/page.tsx` | UI audit scope |
| /invite/[token] | `src/app/(auth)/invite/[token]/page.tsx` | UI audit scope |
| /maintenance | `src/app/(portal)/maintenance/page.tsx` | UI audit scope |
| /admin/usage | `src/app/(admin)/admin/usage/page.tsx` | UI audit scope |
| /appointments | `src/app/(portal)/appointments/page.tsx` | UI audit scope |
| /api/knowledge/upload | `src/app/api/knowledge/upload/route.ts` | API preserved |
| /get-started | `src/app/(auth)/get-started/page.tsx` | UI audit scope |
| /retention | `src/app/(portal)/retention/page.tsx` | UI audit scope |
| /admin/portfolio | `src/app/(admin)/admin/portfolio/page.tsx` | UI audit scope |
| /admin | `src/app/(admin)/admin/page.tsx` | UI audit scope |
| /login | `src/app/(auth)/login/page.tsx` | UI audit scope |
| /leads | `src/app/(portal)/leads/page.tsx` | UI audit scope |
| /admin/team | `src/app/(admin)/admin/team/page.tsx` | UI audit scope |
| /support/[id] | `src/app/(portal)/support/[id]/page.tsx` | UI audit scope |
| /support | `src/app/(portal)/support/page.tsx` | UI audit scope |
| /analytics | `src/app/(portal)/analytics/page.tsx` | UI audit scope |
| /admin/maintenance | `src/app/(admin)/admin/maintenance/page.tsx` | UI audit scope |
| /settings/usage | `src/app/(portal)/settings/usage/page.tsx` | UI audit scope |
| /api/health | `src/app/api/health/route.ts` | API preserved |
| /api/support/attachments/[id] | `src/app/api/support/attachments/[id]/route.ts` | API preserved |
| /add-ons | `src/app/(portal)/add-ons/page.tsx` | UI audit scope |
| /api/files/[id] | `src/app/api/files/[id]/route.ts` | API preserved |
| /knowledge | `src/app/(portal)/knowledge/page.tsx` | UI audit scope |
| /setup | `src/app/(portal)/setup/page.tsx` | UI audit scope |
| /api/analytics/export | `src/app/api/analytics/export/route.ts` | API preserved |
| /projects/[id] | `src/app/(portal)/projects/[id]/page.tsx` | UI audit scope |
| /projects | `src/app/(portal)/projects/page.tsx` | UI audit scope |
| /settings/team | `src/app/(portal)/settings/team/page.tsx` | UI audit scope |
| /api/help | `src/app/api/help/route.ts` | API preserved |
| /api/knowledge/documents/[id] | `src/app/api/knowledge/documents/[id]/route.ts` | API preserved |
| /admin/integrations | `src/app/(admin)/admin/integrations/page.tsx` | UI audit scope |
| /activity | `src/app/(portal)/activity/page.tsx` | UI audit scope |
| /admin/support/[id] | `src/app/(admin)/admin/support/[id]/page.tsx` | UI audit scope |
| /admin/support | `src/app/(admin)/admin/support/page.tsx` | UI audit scope |
| /projects/new | `src/app/(portal)/projects/new/page.tsx` | UI audit scope |
| /api/setup/stream | `src/app/api/setup/stream/route.ts` | API preserved |
| /api/setup | `src/app/api/setup/route.ts` | API preserved |
| /settings/security | `src/app/(portal)/settings/security/page.tsx` | UI audit scope |
| /admin/health | `src/app/(admin)/admin/health/page.tsx` | UI audit scope |
| /settings | `src/app/(portal)/settings/page.tsx` | UI audit scope |
| /approvals | `src/app/(portal)/approvals/page.tsx` | UI audit scope |
| /overview | `src/app/(portal)/overview/page.tsx` | UI audit scope |
| /api/setup/attachments/[id] | `src/app/api/setup/attachments/[id]/route.ts` | API preserved |
| /api/chat/send | `src/app/api/chat/send/route.ts` | API preserved |
| /settings/ai | `src/app/(portal)/settings/ai/page.tsx` | UI audit scope |
| /admin/requests | `src/app/(admin)/admin/requests/page.tsx` | UI audit scope |
| /api/realtime/token | `src/app/api/realtime/token/route.ts` | API preserved |
| /settings/notifications | `src/app/(portal)/settings/notifications/page.tsx` | UI audit scope |
| /admin/setup-templates | `src/app/(admin)/admin/setup-templates/page.tsx` | UI audit scope |
| /settings/billing | `src/app/(portal)/settings/billing/page.tsx` | UI audit scope |
| /admin/audit | `src/app/(admin)/admin/audit/page.tsx` | UI audit scope |
| /sales | `src/app/(portal)/sales/page.tsx` | UI audit scope |
| /our-work | `src/app/(portal)/our-work/page.tsx` | UI audit scope |
| /api/projects/[id]/files | `src/app/api/projects/[id]/files/route.ts` | API preserved |
| /our-work/[slug] | `src/app/(portal)/our-work/[slug]/page.tsx` | UI audit scope |
| /settings/integrations | `src/app/(portal)/settings/integrations/page.tsx` | UI audit scope |
| /api/admin/setup/[orgId] | `src/app/api/admin/setup/[orgId]/route.ts` | API preserved |
| /admin/clients/[id]/setup | `src/app/(admin)/admin/clients/[id]/setup/page.tsx` | UI audit scope |
| /admin/services | `src/app/(admin)/admin/services/page.tsx` | UI audit scope |
| /admin/clients/[id]/integrations | `src/app/(admin)/admin/clients/[id]/integrations/page.tsx` | UI audit scope |
| /api/admin/integrations | `src/app/api/admin/integrations/route.ts` | API preserved |
| /api/public/services | `src/app/api/public/services/route.ts` | API preserved |
| /admin/clients/[id]/provisioning | `src/app/(admin)/admin/clients/[id]/provisioning/page.tsx` | UI audit scope |
| /admin/clients/[id] | `src/app/(admin)/admin/clients/[id]/page.tsx` | UI audit scope |
| /admin/projects | `src/app/(admin)/admin/projects/page.tsx` | UI audit scope |
| /api/admin/setup/[orgId]/stream | `src/app/api/admin/setup/[orgId]/stream/route.ts` | API preserved |
| /admin/clients | `src/app/(admin)/admin/clients/page.tsx` | UI audit scope |
| /admin/projects/[id] | `src/app/(admin)/admin/projects/[id]/page.tsx` | UI audit scope |
| /admin/clients/[id]/activation | `src/app/(admin)/admin/clients/[id]/activation/page.tsx` | UI audit scope |
| /api/chat/runs/[runId]/stream | `src/app/api/chat/runs/[runId]/stream/route.ts` | API preserved |
| /api/admin/setup/[orgId]/documents | `src/app/api/admin/setup/[orgId]/documents/route.ts` | API preserved |
| /api/projects/files/[fileId] | `src/app/api/projects/files/[fileId]/route.ts` | API preserved |
| /api/public/portfolio | `src/app/api/public/portfolio/route.ts` | API preserved |
| /api/chat/runs/[runId]/stop | `src/app/api/chat/runs/[runId]/stop/route.ts` | API preserved |
| /api/leads/export | `src/app/api/leads/export/route.ts` | API preserved |
| /api/admin/portfolio/[id]/assets | `src/app/api/admin/portfolio/[id]/assets/route.ts` | API preserved |
| /api/admin/projects/[id]/files | `src/app/api/admin/projects/[id]/files/route.ts` | API preserved |
| /api/portfolio/assets/[id] | `src/app/api/portfolio/assets/[id]/route.ts` | API preserved |
