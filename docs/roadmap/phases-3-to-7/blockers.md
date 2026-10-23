# Blockers and approvals

| Item | Blocks | Needs | What is done instead |
| --- | --- | --- | --- |
| Hosted migrations 0087 and 0088 | Anything on production that uses website chat or attribution | Founder approval, per migration set (backup, dry run, one at a time). Both rehearse clean on embedded Postgres | Local rehearsal only. Nothing applied |
| Push, merge to master, deploy | Release of Phase 3 | Founder approval | Local commits on `feat/phases-3-7` only |
| Scheduler job `webChatRetention` | Automatic deletion of old chats | Founder approval to start the scheduler stage that includes it | Tested with the clock injected; has never run live |
| Hermes (employee runtime) not provisioned in production | Real AI replies from the website chat | Founder-approved Hermes activation | The chat has an honest fallback (collects contact details, asks a person to follow up); tests use a simulated reply generator and say so |
| No live language model evaluated | Quality claims for chat replies, price grounding, instruction-leak blocking | A provider key and an evaluation | Stub and simulated generators only; labelled |
| Verified revenue and ROI | Return-on-spend figures on the Lead Sources report | Phase 5 verified payments | The report shows deal value labelled as such and says "Needs verified payments"; no ROI number is ever produced from deal value |
| Meta app, App Review and business verification | Connecting a real Facebook Page or Instagram account, and every live publish | A registered Meta app (`META_SOCIAL_APP_ID`, `META_SOCIAL_APP_SECRET`), approval of the publishing permissions the app asks for (see `providers/meta-oauth.ts`; re-read Meta's current names first), business verification, the OAuth redirect, deauthorize and data-deletion callback URLs and a privacy-policy URL registered in the app | Everything runs against the simulated platform and a replaced HTTP layer; the Accounts screen says connecting is "not available yet" |
| Live publishing switch | Any post reaching a real account | Founder approval, then `META_SOCIAL_WRITES_ENABLED=true` in the environment, a founder-approved test on a Page the business owns, and the scheduler stage that includes `socialPublisher` | Off by default; two independent gates in the publisher; never switched on in any QA |
| Hosted migration 0089 | Social media on production | Founder approval (backup, dry run, one migration). `node scripts/rehearse-phase4-migrations.mjs` passes on embedded Postgres | Not applied anywhere |
| Scheduler jobs `socialPublisher`, `socialAccountHealth`, `socialMetrics` and `socialCleanup` (the sign-in-state purge and removed-media clean-up) | Scheduled publishing, health checks, engagement numbers | Founder approval of the scheduler stage that includes them | Tested with injected clocks; never run live |
| Instagram and Facebook inquiries in the Unified Inbox (Phase 4H) | Showing social messages as conversations | Meta messaging permissions (App Review, advanced access, verified business) and webhook subscriptions | Not built: no local part was judged worth building before the permissions exist; the design is a new conversation channel like `web_chat` (decision D1) fed by a signed webhook |
| Reach, impressions and clicks | Engagement beyond likes, comments and shares | Insight permissions approved in App Review | Only returned likes, comments and shares are collected; the screens say reach and impressions are not collected |
| Google Drive and OneDrive connections | Client-owned media storage for clients without the managed plan (Phase 4D) | OAuth apps for both providers | The Media screen lists both as "not available yet"; uploads need the managed plan |
| Managed media storage cap | Telling clients how much social media storage they have | Founder confirmation of the default (2048 MB per workspace, `SOCIAL_MEDIA_STORAGE_MB`) | Proposed default in place; shown to the client on the Media screen |
| Real language model for social drafting | Quality claims about AI captions and the invented-claims filter | A provider key and an evaluation, as for the website chat | Simulated model in QA; the claim filter is a pattern list and says so |
| Agency-side social screens | Agency staff working inside a client's social calendar | A product decision (D19): today social media is a client-workspace feature | Hidden from and refused in agency workspaces |
| E-signature provider account | Signature status from a real provider (Phase 5B) | A provider account and credentials | Provider adapter interface and honest "not connected" state |
| Client payment provider connections | Verified client payments (Phase 5D) | Per-client provider authorization | Webhook handling with signed fixtures; no real payment |
| Demo funnel absent from this tree | Phase 7D verification | Locating the implementation (another branch) or a decision to build | Reported as absent |
| Sidebar link names (pre-existing) | A clean axe run on every portal page | A small fix in the shared shell: the AI-employee links' `aria-label` should start with their visible text | Not part of Phase 3; recorded so it is not mistaken for a Phase 3 regression |
| Legal and consent wording for the chat | Enabling the chat for real visitors | Founder or counsel review of the privacy notice default and the consent text recorded with a lead | The default notice says the chat is answered by an AI assistant and may be reviewed; consent is recorded with the exact wording shown; marketing consent only with a ticked box |

## Phase 4 go-live checklist: live publishing (`META_SOCIAL_WRITES_ENABLED`)

Nothing below has been done, and each step needs the founder's approval in its own right. The switch stays off until the last step.

1. **Database.** Back up, do a dry run, then apply migration 0089 on its own (`node scripts/rehearse-phase4-migrations.mjs` passes on embedded Postgres; it has not been run on a hosted project). Confirm the `social-media` storage bucket exists and is private.
2. **Meta app.** Register the app and set `META_SOCIAL_APP_ID`, `META_SOCIAL_APP_SECRET` and, only if Meta has retired v26.0, `META_GRAPH_VERSION` (the form is `v26.0`; anything else stops the application from starting). Register the OAuth redirect, the deauthorize and
   data-deletion callback URLs and a privacy-policy URL. Complete business verification and App Review for the permissions in `providers/meta-oauth.ts` (re-read Meta's current names first).
3. **Storage cap.** Confirm or change the proposed 2048 MB per workspace (`SOCIAL_MEDIA_STORAGE_MB`).
4. **Scheduler stage.** Add `socialCleanup`, then `socialAccountHealth` and `socialMetrics`, then `socialPublisher` to `SCHEDULER_JOBS_ONLY` and watch `worker_job_runs`. With the switch off, a job for a real account waits in the queue and nothing is sent.
5. **Look at the queue first.** Any post for a real account that is scheduled more than 6 hours in the past will be failed as `missed_window` when its job is picked up, not sent. List them and tell their owners before the switch, so no one is surprised and nothing old goes out.
6. **Test on a Page the business owns.** Connect it, press Test connection, schedule one post a few minutes ahead and watch it. Check there is exactly one post on the Page and that the link on the post screen opens it. Then disconnect and reconnect it, and check that
   a post left scheduled stops with a plain reason and nothing is posted.
7. **Switch on.** Set `META_SOCIAL_WRITES_ENABLED=true`. To stop again: set it to `false` (jobs wait, nothing is sent), or suspend or pause the workspace (its jobs wait and are not sent late once it is back).
8. **After.** Watch for posts that end in "checking the result" (an unknown outcome) and resolve each by looking at the Page. Metrics marker rows and `social_ai_runs` have no retention job yet; that is a recorded follow-up.
