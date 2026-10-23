CONFIRMED 66; refuted 3

#1 [critical (claimed critical)] publisher-durability :: A job whose result was saved as done is replayed after a crash, creating a second provider post
   src/server/social/publisher.ts:241  votes=['confirmed', 'confirmed']
   SCENARIO: The worker's step succeeds and persist() saves state {sendingAt, providerPostId, done:true}. Then the process dies (serverless timeout) or succeedJob throws before it commits. The lease expires and recoverExpiredLeases (lines 101-109) only treats a job as 'maybe sent' when providerPostId is absent.�
   FIX: In runClaimedJob (src/server/social/publisher.ts), right after the post-version/status guard at line 217 and BEFORE prepare(), add: if (job.state?.done && job.state?.providerPostId) { await withSystem((db) => succeedJob(db, job, post, job.state, clock(deps), "published")); update social_accounts.last_success_at; return "succeeded"; }. Placing it before prepare() also keeps an �

#2 [high (claimed high)] integration-rollout :: Social publisher, health and metrics jobs ignore suspended/archived workspaces and the agency automation pause
   src/server/social/publisher.ts:114  votes=['partly', 'confirmed']
   SCENARIO: A super admin suspends a client workspace (setTenantStatus sets organizations.status='suspended' for abuse, non-payment or a compromised account) or sets the agency pause. claimNext joins only social_accounts, so approved posts whose run_at has arrived are still published to the client's live Page.�
   FIX: Gate only the claim step, `claimNext` in `src/server/social/publisher.ts` around lines 118-120. - Add `join organizations o on o.id = q.org_id`. - Add `o.status not in ('suspended','archived')`. - Add `and not exists (select 1 from automation_pauses p join organizations po on po.id = p.org_id where p.active and p.scope = 'agency' and (p.org_id = q.org_id or po.kind = 'agency')�

#3 [medium (claimed medium)] ai-analytics-honesty :: Social AI calls have no rate limit, usage cap, usage record or credit charge
   src/server/social/ai.ts:92  votes=['partly']
   SCENARIO: Any member with social.create can call suggestIdeasAction or suggestCaptionsAction in a loop. ready() only checks that getBalance().availableMicros > 0 once. There is no consumeRateLimit, no assertWithinLimits, no recordUsage and no chargeUsage. Every comparable LLM feature has these: inbox-ai.ts u�
   FIX: Add a per-user hourly rule to RATE_LIMITS (for example socialAiByUser: { name: "social:ai:user", limit: 40, windowSeconds: 3600 }, mirroring inboxAiByUser). Call consumeRateLimit in ready() (src/server/social/ai.ts:92) before the model call, keyed on ctx.user.id, and throw AppError("rate_limited", ..., { retryAfterSeconds }) when it is not allowed. Optionally add an org-level �

#4 [medium (claimed medium)] ai-analytics-honesty :: Invented prices pass the grounding check because it compares digits as a substring of the whole knowledge text
   src/server/social/ai.ts:52  votes=['confirmed']
   SCENARIO: unsupportedClaims delegates amounts to ungroundedAmounts (src/server/webchat/generator.ts:60), which accepts an amount if its digit string appears anywhere in the corpus (corpus.includes(digits)). I ran it with knowledge 'Tune-ups start at $120. Open Monday to Friday, 9am-5pm. Established 2012.'. T�
   FIX: Ground amounts by whole-number match, not substring. In ungroundedAmounts (src/server/webchat/generator.ts), extract the numeric tokens from the knowledge with a boundary-aware regex such as /(?<![\d.,])\d[\d,]*(?:\.\d+)?(?![\d])/g. Strip commas and normalise (parseFloat or Number). Build a Set, and require the reply's amount to be a member. Better still, ground against the kn�

#5 [medium (claimed medium)] ai-analytics-honesty :: Duplicating an AI draft produces a human-origin post that skips the always-approve rule
   src/server/social/posts.ts:493  votes=['confirmed']
   SCENARIO: duplicatePost calls insertDraft(..., 'human') for any status, including an AI draft that was never approved. The AI caption is copied verbatim, but origin becomes 'human', ai_run_id becomes null and the AI badge and history entry are lost. In the default setting (approvalForPublishers false), an ow�
   FIX: In src/server/social/posts.ts duplicatePost (line 493), carry the origin and AI run forward: call insertDraft(..., row.origin, row.origin === "ai" ? row.ai_run_id : null). That keeps the AI badge and the always-approve rule on the copy. The (ai_run_id, org_id) foreign key is satisfied because the run is in the same org. The 'ai_drafted' event that insertDraft writes for origin�

#6 [medium (claimed medium)] ai-analytics-honesty :: Lead outcomes are credited to a post even when the deal, appointment or qualification predates the post-tagged visit
   src/server/social/analytics.ts:77  votes=['confirmed']
   SCENARIO: recordFormTouch also records touches for existing matched contacts. An existing customer (lead_status 'customer', with a deal won in 2024) clicks a post's tracked link and submits a website form, so a lead_touch with content = the post's code is written. byCode then counts that contact as Lead, Qua�
   FIX: In the `hits` CTE, group by (code, contact) and take min(t.occurred_at) as first_touch_at. Count appointments, deals and won deals only when the row was created after that touch: appointment_refs.created_at >= first_touch_at, and crm_opportunities.created_at >= first_touch_at (o.created_at exists; it is used in opportunities.ts:500). For "won", also require closed_at >= first_�

#7 [medium (claimed medium)] approval-authz :: Suspended or offboarded workspaces keep auto-publishing approved posts, and their Page tokens stay stored
   src/server/social/publisher.ts:119  votes=['confirmed']
   SCENARIO: claimNext joins only social_accounts, and prepare() and runClaimedJob() never look at organizations.status or the automation pauses. The platform's own kill switch (automationGate in src/server/automation/gate.ts) blocks suspended or archived workspaces and honours agency/messaging/outbound pauses.�
   FIX: 1. Gate the publisher on organization state. - In claimNext (src/server/social/publisher.ts:118), join organizations and require o.status not in ('suspended', 'archived'). - Also require that no active automation_pauses row exists for scope 'agency', either on the org itself or on an agency-kind org (the same predicate as automationGate and checkOrgAutomation in src/server/aut�

#8 [medium (claimed medium)] approval-authz :: cancelPost can mark a post whose outcome is unknown as 'Cancelled before it was published'
   src/server/social/posts.ts:436  votes=['confirmed']
   SCENARIO: stopPublishingFor (accounts.ts, on disconnect, revoke or needs_reauth) sets a post to status 'failed' with failure_code 'unknown_outcome' when a job had already written sendingAt, so the post may be live. NEXT allows failed to cancelled, and cancelPost checks only canTransition and canEditRow. It n�
   FIX: In cancelPost (src/server/social/posts.ts, before the canTransition check or right after it), refuse when row.status === "failed" && row.failure_code === "unknown_outcome", with the same conflict message used in updatePost/retryPost (look at the Page and say whether it was posted, via the resolve flow). Add a test next to social-publisher.test.ts:280: disconnect an account whi�

#9 [medium (claimed high)] integration-rollout :: META_GRAPH_VERSION regex lost its backslashes, so the documented value v26.0 makes env() throw for the whole app
   src/server/env.ts:107  votes=['partly', 'confirmed']
   SCENARIO: The schema line is z.string().regex(/^vd{1,2}.d$/) (the \d and \. escapes were stripped). That pattern matches only strings like 'vdd.d'. Anyone who copies .env.example (META_GRAPH_VERSION=v26.0) into .env.local or Vercel, or follows docs/messaging-providers.md:580, which says every call uses v26.0�
   FIX: In src/server/env.ts:107 restore the escapes: z.string().regex(/^v\d{1,2}\.\d$/).default("v26.0"), with `\d` and `\.` written with real backslashes. Add a small env test that sets META_GRAPH_VERSION=v26.0 and expects success, and sets "latest" and expects "Invalid server environment configuration: META_GRAPH_VERSION". The test is what would have caught this, because the QA env�

#10 [medium (claimed medium)] integration-rollout :: A transient health-check failure flips the account to 'error', and queued posts are then permanently failed at claim time
   src/server/social/publisher.ts:182  votes=['partly']
   SCENARIO: socialAccountHealth runs every 6 hours. If debug_token times out, returns 5xx or is rate limited, checkAccountHealth (accounts.ts:342) sets status 'error' because needsReauth is false, with no notification. claimNext does not look at account status, so a post due before the next check (up to 6 hour�
   FIX: Do not treat a retryable health failure as a status change. In checkAccountHealth (src/server/social/accounts.ts:340-343), when the caught ProviderError is not needsReauth and its kind is transient or rate_limited, keep the account's current status and record only status_detail and last_checked_at. If a visible 'error' state is still wanted, set it only after several consecuti�

#11 [medium (claimed medium)] integration-rollout :: Social jobs have no time budget and sit before the message dispatcher in a 120 s tick
   src/server/ops/tick.ts:108  votes=['partly']
   SCENARIO: The tick route has maxDuration=120 and runs jobs in order. socialPublisher (up to 20 jobs, each up to 6 Graph calls with a 25 s timeout), socialAccountHealth (up to 200 sequential accounts) and socialMetrics (up to 100 sequential posts) run before missedCallRecovery and messagesDispatched, and befo�
   FIX: Give the three social jobs a deadline, as the calendar, workflow, webhook and event-dispatch jobs already have. - processDueSocialPosts: accept budgetMs (about 20 s). Check Date.now() before each claimNext and before each reconcile iteration, and stop claiming once it passes. Leave unclaimed jobs queued for the next run. Do the same inside reconcileUnknownJobs. - checkAllAccou�

#12 [medium (claimed medium)] integration-rollout :: Offboarding shutdown neither stops scheduled social posts nor disconnects the client's Page tokens
   src/server/offboarding/service.ts:196  votes=['confirmed']
   SCENARIO: shutdownClient pauses agency/messaging/outbound, cancels messages, reminders and approvals, and disconnects integration_connections ('a live token would still be live'). Social accounts live in social_accounts, not integration_connections, so they are untouched. During the retention period the work�
   FIX: In shutdownClient, add a "social" step after the integrations step, inside withSystem. For every social_accounts row of the org with status in ('connected','needs_reauth','error'), run the same SQL as disconnectAccount without the OrgContext permission check. That means: update social_accounts set status='disconnected', credentials=null, token_expires_at=null, status_detail='W�

#13 [medium (claimed medium)] integration-rollout :: Client data export omits all social media data and the social-media bucket files, which are then deleted
   src/server/offboarding/export.ts:28  votes=['confirmed']
   SCENARIO: The TABLES spec has no social_posts, social_post_events, social_campaigns, social_media_assets or social_settings. The file query at line 211 is limited to buckets company-documents and brand-assets, so the client's uploaded pictures and videos in the new 'social-media' bucket are skipped. docs/off�
   FIX: In src/server/offboarding/export.ts, add entries to TABLES: social/settings.json (social_settings), social/campaigns.json (social_campaigns), social/media-assets.json (social_media_assets), social/posts.json (social_posts, order created_at), social/post-history.json (social_post_events), social/post-metrics.json (social_post_metrics), and optionally social/publish-jobs.json. A�

#14 [medium (claimed medium)] media-tenancy :: A failed storage cleanup leaves a 'ready' media asset on a deleted file that can never be removed and can still be attached to posts
   src/server/social/media.ts:115  votes=['confirmed']
   SCENARIO: removeMedia calls removePrivateFile before it sets the asset to 'removed'. removePrivateFile (src/server/storage/private.ts:150) sets private_files.status='deleted' first, then removes the Supabase object. If that remove call returns an error once, it throws integration_unavailable, so removeMedia �
   FIX: In removeMedia, mark the asset 'removed' first, ideally in the same transaction as the in-use check. The in-use check currently runs in a separate query from the later update, so a post could also attach the asset in between. After the asset is 'removed' (so checkMedia and the platform checks already reject it), do the storage deletion as best-effort cleanup. Catch the integra�

#15 [medium (claimed medium)] media-tenancy :: An error while signing a post's media URL escapes runClaimedJob, so the job never reaches a terminal state and the post stays 'scheduled' forever
   src/server/social/publisher.ts:206  votes=['confirmed']
   SCENARIO: prepare() awaits signAuthorizedPrivateFile(...) with no try/catch. That function throws AppError not_found when private_files.status<>'ready' (the stuck asset above) and integration_unavailable when Supabase createSignedUrl errors, which it does for a missing object. runClaimedJob also has no try/c�
   FIX: 1. In prepare (src/server/social/publisher.ts:206), wrap the media signing in try/catch. For AppError code 'not_found', call fail("media_unavailable", "A picture or video on this post is no longer available, so it was not published.", "invalid_content"). For integration_unavailable or any other error, requeue with retryDelayMs backoff. Increment the attempt and honour max_atte�

#16 [medium (claimed medium)] migration-database :: Offboarding shutdown, agency pause and suspended workspaces do not stop scheduled social posts
   src/server/social/publisher.ts:114  votes=['confirmed']
   SCENARIO: A post is approved and scheduled for Oct 5. On Oct 1 a super admin runs shutdownClient, which sets the 'agency', 'messaging' and 'outbound' pauses and reports that automation is stopped. A suspended or archived organization behaves the same way. `claimNext` joins only social_accounts and `prepare` �
   FIX: 1. Gate the publisher on the workspace, with the same rule as `checkOrgAutomation`: - In `claimNext`, join `organizations`. - Exclude orgs with status in ('suspended','archived'). - Exclude orgs with an active 'agency' pause. Include the pause set on the agency-kind org, as in the gate.ts subquery. - Leave such jobs queued. Do the same in `prepare` or `runClaimedJob`, as a rac�

#17 [medium (claimed medium)] migration-database :: The client data export omits every Phase 4 table and the social-media files
   src/server/offboarding/export.ts:28  votes=['confirmed']
   SCENARIO: buildExport reads only the hard-coded TABLES allowlist, and its file query is limited to the company-documents and brand-assets buckets. None of social_posts, social_post_events, social_campaigns, social_media_assets, social_accounts (without credentials) or social_settings is listed, and the socia�
   FIX: In src/server/offboarding/export.ts, add TABLES entries and widen the files query: - social/accounts.json: table social_accounts, `pick` of non-secret columns only (platform, adapter, external_id, name, username, status, status_detail, capabilities, connected_at, disconnected_at, created_at). That excludes credentials, provider_user_id, rate_state, scopes and the token expiry �

#18 [medium (claimed medium)] migration-database :: Sealed Page tokens in social_oauth_states.pending are never purged, and deletion or deauthorization callbacks ignore them
   src/server/social/accounts.ts:143  votes=['confirmed']
   SCENARIO: completeMetaConnect stores the sealed list of every Page the person manages (up to 100), with each Page's access token and the Meta user id and name, in social_oauth_states.pending. The migration comment promises this lasts ten minutes. It is cleared only at the end of connectChosenPages (line 233)�
   FIX: 1. Add a daily scheduler job in src/server/ops/tick.ts (the same pattern as phase2Retention): `update social_oauth_states set pending = null where pending is not null and expires_at < now()`, and `delete from social_oauth_states where expires_at < now() - interval '1 day'`. 2. In completeMetaConnect, clear the pending data on any failure after it is stored. In connectChosenPag�

#19 [medium (claimed low)] migration-database :: META_GRAPH_VERSION validation regex lost its backslashes, so any real override crashes env()
   src/server/env.ts:107  votes=['confirmed']
   SCENARIO: The schema reads `/^vd{1,2}.d$/` instead of `/^v\d{1,2}\.\d$/`. With zod 4.6.5 the unset default 'v26.0' skips validation, so the app boots. Any value an operator sets, such as META_GRAPH_VERSION=v26.0 or v25.0 (documented as changeable without code), fails with 'must match pattern'. env() then thr�
   FIX: In src/server/env.ts:107 use `z.string().regex(/^v\d{1,2}\.\d$/, "must look like v26.0")`. Add a test that env() accepts META_GRAPH_VERSION=v26.0 and v25.0 and rejects "x". Avoid writing the file through a shell heredoc or a path that mangles backslashes.

#20 [medium (claimed high)] oauth-credentials :: META_GRAPH_VERSION validator is a mangled regex that rejects every real value, including the one .env.example documents
   src/server/env.ts:107  votes=['confirmed', 'partly']
   SCENARIO: The regex was written as /^vd{1,2}.d$/, with the backslashes lost. It matches only the literal text 'v' + 1-2 'd' + any character + 'd', such as 'vdd.d'. I ran it against the installed Zod 4.6.5: unset and blank pass because the default short-circuits, but 'v26.0' and 'v21.0' fail with 'must match �
   FIX: In src/server/env.ts line 107, restore the escapes: `z.string().regex(/^v\d{1,2}\.\d$/).default("v26.0")`. Add a test in tests/ that sets process.env.META_GRAPH_VERSION to `v26.0` and `v9.0` and expects env() to accept them. Add another case where `junk` or `26.0` makes env() throw.

#21 [medium (claimed medium)] publisher-durability :: Reconciliation with an empty caption matches any recent post on the Page and records it as ours
   src/server/social/providers/meta.ts:222  votes=['confirmed']
   SCENARIO: Image and video posts may have an empty caption, because draftProblems only blocks empty text for text and link posts. After an unknown outcome, reconcileUnknownJobs builds input.message as ''. In meta.reconcile, text = ''.slice(0,80) = '', and String(p.message ?? '').startsWith('') is true for eve�
   FIX: Keep the suggested direction, with one correction: do NOT make `meta.reconcile` return `{found:false}` for an empty or short message. In `reconcileUnknownJobs` (publisher.ts:334) a `found:false` after the 10-minute grace period writes `confirmed_not_posted` ("the platform confirmed this post was not published, you can try again"). If the post did go out, that invites a duplica�

#22 [medium (claimed medium)] publisher-durability :: A transient health-check failure (account status 'error') permanently fails posts that come due, telling the owner to reconnect
   src/server/social/publisher.ts:182  votes=['confirmed']
   SCENARIO: checkAccountHealth (every 6 hours) sets status='error' whenever the provider call throws something other than needsReauth, for example a Graph 5xx or a timeout on debug_token. claimNext does not look at account status, and prepare() fails any job whose account.status !== 'connected'. A post due whi�
   FIX: In publisher.ts prepare(), split the check at line 182. - Keep the immediate failure for `!account` and for status 'needs_reauth', 'revoked' or 'disconnected'. - For status 'error' (the platform could not be reached), requeue the job instead of failing it: - If `job.attempt < job.max_attempts`, call requeue(job.id, workerId, job.state, now + retryDelayMs(job.attempt, null, jit�

#23 [medium (claimed medium)] publisher-durability :: Instagram health check overwrites rate_state, erasing the publish block (blockedUntil)
   src/server/social/accounts.ts:351  votes=['confirmed']
   SCENARIO: On a 'blocked' failure (Graph code 368), handleFailure writes rate_state.blockedUntil = now+24h, and prepare() re-queues every other job for that account until then. checkAccountHealth runs every 6 hours, and checkMyAccount can run it at any time. For Instagram, when content_publishing_limit is rea�
   FIX: In src/server/social/accounts.ts around line 351, merge instead of replace and keep the publish block. For example: rate_state = case when $9::jsonb is null then rate_state else ((rate_state - 'quotaUsage' - 'quotaTotal' - 'checkedAt') || $9::jsonb) end. That keeps blockedUntil when it is in the future. publisher.ts already ignores a past blockedUntil, so it does not need to b�

#24 [medium (claimed medium)] publisher-durability :: A post waiting out a retry or rate-limit back-off cannot be cancelled, edited or rescheduled
   src/server/social/posts.ts:436  votes=['confirmed']
   SCENARIO: After a transient or rate_limited failure, runClaimedJob has already set the post to 'publishing' and handleFailure re-queues the job with sendingAt cleared. The wait is minutes, or up to 24h when the platform sends Retry-After (retryDelayMs honours up to 86,400s). Nothing is in flight, but canTran�
   FIX: The suggested fix is right in direction, but it needs these extra changes, otherwise edits strand the post in `publishing`. 1. In `cancelPost`, `updatePost` and `reschedulePost`, when `row.status === 'publishing'`, call `cancelQueuedJob(db, id)` first. If it returns false (a job is running, unknown, or has `sendingAt`), keep the current refusal. If it returns true, nothing is �

#25 [medium (claimed medium)] ui-a11y-honest-states :: Posts on a person-disconnected account cannot be edited, retried, duplicated or rescheduled after the Page is reconnected
   src/components/social/composer.tsx:41  votes=['confirmed']
   SCENARIO: An owner disconnects their only Facebook Page. stopPublishingFor fails the scheduled post with 'Reconnect it and schedule it again'. They reconnect the same Page. connectChosenPages (src/server/social/accounts.ts:208) only reuses rows whose status is not 'disconnected', so it INSERTS a new social_a�
   FIX: Fix on both the server and the UI. 1. Server (preferred): when `connectChosenPages` inserts a new row for a (org, platform, external_id) that has older `disconnected` rows, repoint that Page's non-terminal posts (draft, pending_approval, changes_requested, approved, failed) from the old row to the new row. Do this in the same transaction and write a post event. The Page is the�

#26 [medium (claimed medium)] ui-a11y-honest-states :: Every social server action refuses in the agency workspace although the pages, nav and OAuth routes allow it
   src/app/actions/social.ts:25  votes=['confirmed']
   SCENARIO: act() calls studioContext(null, permission), which throws 'Choose a client to work on.' when ctx.org.kind !== 'client' (src/server/websites/studio-ctx.ts:44-49). The pages use requireOrgContext('social.view'), the sidebar item has no kind gate, and /api/social/oauth/meta/start and /callback use req�
   FIX: Decide the intent and make pages, nav, OAuth routes and actions agree. (a) If social is a client-tenant-only feature, which matches the client-only gating in shell.ts and automation-studio views: - Hide the Social Media nav item when ctx.org.kind !== 'client'. - Add a kind check in src/app/(portal)/social/layout.tsx that redirects or shows an honest "Social media is managed pe�

#27 [low (claimed medium)] ai-analytics-honesty :: Claim filter misses common phrasings, and hashtags and bare web addresses are never checked
   src/server/social/ai.ts:40  votes=['partly']
   SCENARIO: I replayed the filter against knowledge that states no offers or statistics. These all returned [] and would be kept as draft options: 'Over 500 happy customers trust us.' (the pattern needs the noun right after the number), 'Trusted by 1,200 local families.', 'Rated 4.9 stars by homeowners.', 'Our�
   FIX: Treat as low severity, since a person always reviews AI drafts. Optional hardening in src/server/social/ai.ts: 1. Run the claim check on the hashtags too. Join them with spaces after splitting camelCase, so that #AwardWinning becomes 'Award Winning'. For example: unsupportedClaims(caption + ' ' + hashtags.map(h => h.replace(/([a-z])([A-Z])/g, '$1 $2')).join(' '), knowledge). A�

#28 [low (claimed medium)] ai-analytics-honesty :: Newest-100-platform-wide batch means most published posts never get engagement numbers
   src/server/social/analytics.ts:123  votes=['partly']
   SCENARIO: The socialMetrics job runs every 360 minutes and runJob claims it by start-to-start gap, so each run happens at least 6 hours after the previous one. A row fetched last run is therefore already older than METRICS_MAX_AGE_HOURS (6) and is eligible again. Selection is 'order by p.published_at desc li�
   FIX: Keep the finding but retitle it as a scalability and fairness limit: the fixed 100-read batch per 6h run (about 400 reads/day platform-wide) is ordered only by published_at, with no fairness and no back-off. To fix it, order by "oldest latest read first, never-read first" (for example coalesce(max fetched_at, '-infinity') asc, then published_at desc), and add per-org round-rob�

#29 [low (claimed medium)] ai-analytics-honesty :: Performance Analyst engagement advice zero-fills absent counts and always reports a difference
   src/server/workforce/social-review.ts:75  votes=['partly']
   SCENARIO: engagementAdvice computes coalesce(likes,0)+coalesce(comments,0) for every post whose metrics row is merely non-empty. Instagram omits like_count when the owner hides likes, and Facebook returns only the fields it has. A post with {comments:4} or {shares:2} is therefore averaged as if likes (or bot�
   FIX: In src/server/workforce/social-review.ts engagementAdvice: 1. Select only posts whose latest metrics row has both keys, by adding "and m.metrics ? 'likes' and m.metrics ? 'comments'" to the where clause. Alternatively, drop the coalesce and exclude NULL sums. Count only those posts toward MIN_POSTS_FOR_ADVICE, and say in the detail how many posts were left out because the plat�

#30 [low (claimed low)] ai-analytics-honesty :: Per-post and total lead figures show 0 for untracked posts and double-count contacts across posts
   src/server/social/analytics.ts:99  votes=['partly']
   SCENARIO: A post with no link (text, image or video), or one published while tracking links were off, has tracking_code null. PostPerformance carries no 'tracked' flag, and the page cells (analytics/page.tsx:89-91) print '0' for Leads, Qualified and Appointments. A post that cannot be measured is shown as on�
   FIX: Return a trackedLink boolean (tracking_code is not null) on each PostPerformance. In page.tsx:89-91 render "Not tracked" instead of 0 when it is false. Compute the headline lead totals with one extra query that counts distinct contacts across all tracking codes of published posts in the window, with qualified, appointment, opportunity and won each counted once per contact. Run�

#31 [low (claimed low)] ai-analytics-honesty :: A link that already carries utm_content keeps it, so leads are lost or credited to another post
   src/lib/social/rules.ts:176  votes=['confirmed']
   SCENARIO: trackedLink only sets utm_content when the link has none. A person pastes a link copied from an earlier published post, with ?utm_content=ab12cd34 from that post. The new post still gets its own tracking_code and shows 'Tracking code xyz' on its page, but the posted link keeps ab12cd34. Every lead �
   FIX: In src/lib/social/rules.ts trackedLink, always set utm_content to the post's tracking code, overwriting any existing value, because that tag is the only linkage key. Keep the keep-existing behaviour for utm_source, utm_medium and utm_campaign. Alternatively, add a draftProblems warning when link_url already contains utm_content that differs from the post's tracking_code. That �

#32 [low (claimed low)] ai-analytics-honesty :: Analyst counts soft-deleted contacts as post leads and its failed-posts evidence link hides the posts it counts
   src/server/workforce/social-review.ts:111  votes=['confirmed']
   SCENARIO: leadsFromPosts joins lead_touches directly and never excludes contacts with deleted_at set, while socialOverview excludes them (c.deleted_at is null). After a contact is deleted, the analyst's 'N leads arrived through tracked links' disagrees with the analytics page. Separately, failedPosts counts �
   FIX: In `leadsFromPosts`, join `contacts` and require `deleted_at is null`: `join contacts c on c.id = t.contact_id and c.org_id = t.org_id and c.deleted_at is null`. This matches `socialOverview`. Optionally, in the merge path, move the merged contact's `lead_touches` to the kept contact, or document that merged contacts are dropped. For the failed-posts link, give the calendar a �

#33 [low (claimed low)] ai-analytics-honesty :: Engagement for posts older than 30 days is frozen but shown as current
   src/server/social/analytics.ts:126  votes=['confirmed']
   SCENARIO: syncPostMetrics only reads posts published within 30 days, but the 90-day range lists older posts with their last stored row. socialOverview returns metricsAt per post, but the page shows only the single latest fetch time across all posts ('last read ...'), so a 60-day-old post's likes are the coun�
   FIX: In src/app/(portal)/social/analytics/page.tsx, show each post's metricsAt as an 'as of <date>' note in the table, or at least when metricsAt is older than METRICS_MAX_AGE_HOURS or the post is older than METRICS_WINDOW_DAYS. Alternatively, mark totals as 'includes figures last read on <date>' when any post's metricsAt is stale. Optionally add a staleness flag to PostPerformance�

#34 [low (claimed low)] approval-authz :: saveSocialSettings reports success and writes an audit entry when a concurrent save silently updates nothing
   src/server/social/settings.ts:37  votes=['confirmed']
   SCENARIO: The version check is a plain read (readSettings), and the upsert's 'on conflict do update ... where social_settings.version = $8' simply skips the row when the version has moved on. It raises no error and the affected-row count is never checked. Two saves arriving together with the same expectedVer�
   FIX: In src/server/social/settings.ts, change the upsert to end with "returning version" and capture the result: const res = await db.query(...); if (!res.rows[0]) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again."); and only then call recordAudit and readSettings. The throw rolls back the withSystem transaction. Optio�

#35 [low (claimed low)] approval-authz :: duplicatePost turns an AI-origin post into a human-origin one, bypassing 'AI drafts always need approval'
   src/server/social/posts.ts:493  votes=['confirmed']
   SCENARIO: approvalRequired() forces origin 'ai' posts through an explicit approval, and the tests assert an AI draft 'is never approved by being scheduled, even by the owner'. duplicatePost copies the text with origin hard-coded to 'human' (and drops ai_run_id), with the duplicator as author. In the default �
   FIX: In src/server/social/posts.ts duplicatePost (line 493), pass the source row's origin and ai_run_id through instead of the hard-coded "human": insertDraft(db, actor, input, row.origin, row.ai_run_id). Carrying origin over always is simplest. Restricting it to unpublished sources would work, but a published AI post that a person already approved can reasonably keep the AI flag w�

#36 [low (claimed low)] approval-authz :: Database check constraints are stricter than the Zod and draftProblems limits, so common input fails with a generic 'Something went wrong' error
   src/server/social/posts.ts:218  votes=['confirmed']
   SCENARIO: social_posts enforces link_url ~ '^https://' (case-sensitive) and caption length <= 63206. postInput (actions/social.ts line 33) allows any string up to 1,000 characters for linkUrl and a caption up to 70,000, and rules.ts accepts '/^https:\/\//i'. The composer's Save is not blocked by blocking pro�
   FIX: Validate before the insert or update, in a shared helper used by insertDraft and by updatePost. Alternatively add a Zod refinement on postInput. - Link: trim it. Require `/^https:\/\//i` and length <= 1000, throwing `new AppError("invalid_input", "Links must start with https://.")`. Then normalise the scheme to lower case, so rules.ts and the DB agree, or relax the CHECK to `~�

#37 [low (claimed medium)] integration-rollout :: Overdue approved posts are published in a burst when live publishing or the scheduler is switched on
   src/server/social/publisher.ts:114  votes=['partly']
   SCENARIO: claimNext uses only 'run_at <= now' with no upper bound. The Social page tells users that with writes off 'posts for them will wait here and nothing will be sent until iAcquire switches it on'. When the founder later sets META_SOCIAL_WRITES_ENABLED=true, starts the scheduler, or an outage ends, eve�
   FIX: Measure lateness from the post's original schedule (social_posts.scheduled_at), not job.run_at, and apply it only to a job that has not started. In prepare() in src/server/social/publisher.ts, after the approval_stale check, add: if job.attempt === 1 (or job.started_at was null at claim), job.state has no sendingAt or provider ids, and now - post.scheduled_at > a configured wi�

#38 [low (claimed low)] integration-rollout :: Phase 4 runbook and ledger are missing or stale, and the new write switch is absent from the staging and dev env files
   docs/roadmap/phases-3-to-7/handoff.md:11  votes=['partly']
   SCENARIO: Four Phase 4 commits changed no docs. handoff.md:11 still says 'start Phase 4 ... (nothing is in the tree), then write the migration ... as 0089', and implementation-checklist.md:33 says Not Started. A session resuming from the ledger, as README.md says it should, would collide with the existing 00�
   FIX: Downgrade this to a documentation housekeeping item (low, not a defect). It will be done in the normal Phase 4 checkpoint commit, same as ad7dc55 did for Phase 3. Update handoff.md, implementation-checklist.md, blockers.md (Meta permission list and App Review steps) and decisions.md. Add the three social jobs to the scheduler staging order in the roadmap docs (optionally produ�

#39 [low (claimed low)] integration-rollout :: Data-deletion and deauthorize callbacks leave sealed Page tokens in abandoned social_oauth_states rows
   src/server/social/accounts.ts:312  votes=['confirmed']
   SCENARIO: completeMetaConnect stores the person's Meta user id and every Page's long-lived token (encrypted) in social_oauth_states.pending and clears it only when a Page is chosen (line 233). If the person abandons the chooser, the row is deleted only the next time that same user starts a connection (line 9�
   FIX: Keep severity low. Two changes together close it: 1. Add an expiry purge, for example in `checkAllAccounts`/`socialAccountHealth` or a small dedicated job: `update social_oauth_states set pending = null where pending is not null and expires_at < now() - interval '0'` plus `delete from social_oauth_states where expires_at < now() - interval '1 day'`. This bounds retention of ab�

#40 [low (claimed low)] integration-rollout :: A link that already carries utm_content is posted without the post's tracking code, but the UI still claims tracking
   src/lib/social/rules.ts:176  votes=['confirmed']
   SCENARIO: trackedLink only sets utm_content when absent. A post whose link is, for example, https://site.example/offer?utm_content=spring still stores tracking_code abc12345 and shows 'Tracking code abc12345'. The composer says visitors 'are recorded as coming from it', but the posted URL carries 'spring'. N�
   FIX: Keep severity low. Pick one of these: 1. Make the code real. In trackedLink (src/lib/social/rules.ts:176), set utm_content unconditionally to the tracking code, because it is the only join key. Keep the keep-existing behaviour for utm_source, utm_medium and utm_campaign. 2. Make the state honest. In insertDraft and updatePost (src/server/social/posts.ts:217 and 282), set track�

#41 [low (claimed low)] integration-rollout :: AQi's curated route registry has no /social entry, so AQi cannot describe or link to the new section
   src/lib/aqi/routes.ts:46  votes=['confirmed']
   SCENARIO: AQI_ROUTES lists /website but not /social. matchAqiRoute('/social') returns null and safeAqiHref('/social/approvals') returns null, so AQi has no page context on the Social screens and cannot offer a permission-checked link to Social, Approvals or Accounts in answers. The sidebar adds Social Media �
   FIX: Add `{ path: '/social', label: 'Social media', description: 'Plan, draft and approve social posts, and review connected accounts.', permission: 'social.view' }` (and optionally /social/approvals with the matching approval permission) to AQI_ROUTES in src/lib/aqi/routes.ts. Do not just append it after /website. aqiNavigationFor's `.slice(0, 30)` in src/server/aqi/service.ts:147�

#42 [low (claimed low)] integration-rollout :: Repeat conditions are silent because notification and event dedupe keys never expire
   src/server/social/publisher.ts:151  votes=['confirmed']
   SCENARIO: The failure notification is keyed social-failed:<post>:<version>, and announce() keys social.post_failed the same way. retryPost keeps the same version, so a post that fails, is retried and fails again produces no second notification and no second Automation Studio event. In accounts.ts:321 the key�
   FIX: In src/server/social/publisher.ts failJob, make the three keys per job, since each retry creates a new social_publish_jobs row: use `social-failed:${post.id}:${post.version}:${job.id}` and `social-failed-author:${post.id}:${post.version}:${job.id}`. Pass the job id into announce() so its key becomes `social.post_failed:${post.id}:${post.version}:${job.id}`. A job fails only on�

#43 [low (claimed low)] integration-rollout :: Owner/admin who authored a failed post gets the same failure notice twice
   src/server/social/publisher.ts:152  votes=['confirmed']
   SCENARIO: failJob first calls notifyOrgRoles for every active owner and admin (key social-failed:<post>:<v>), then notifyUser for the author under a different key (social-failed-author:...). In a small business where the owner wrote the post, the owner receives two identical in-app notifications per failure.
   FIX: In failJob, notify the author only if they were not already notified as an owner or admin. For example, skip notifyUser when the author holds an active owner or admin membership in post.org_id. Alternatively use the same dedupeKey (social-failed:<post>:<v>) for both calls, so the existing (user_id, dedupe_key) unique index collapses the second insert to a no-op.

#44 [low (claimed low)] integration-rollout :: Performance Analyst's failed-posts finding links to a filter that hides the unconfirmed posts it counts
   src/server/workforce/social-review.ts:23  votes=['confirmed']
   SCENARIO: failedPosts counts status in ('failed','needs_reconciliation') and says 'N posts failed or could not be confirmed', but evidenceHref is /social?status=failed. listPosts filters status = any([failed]), so posts in needs_reconciliation, the ones a person most needs to check on the Page, do not appear�
   FIX: Make the link and the page agree. Preferred fix: in src/app/(portal)/social/page.tsx (line 26 and the line 30 call), accept a comma-separated status list. Split the value, keep only members of POST_STATUSES, and pass the resulting array to listPosts. Then set evidenceHref in src/server/workforce/social-review.ts:23 to "/social?view=list&status=failed,needs_reconciliation". Use�

#45 [low (claimed low)] media-tenancy :: Instagram aspect-ratio check uses raw JPEG pixel dimensions and ignores EXIF orientation
   src/lib/social/image-size.ts:19  votes=['confirmed']
   SCENARIO: jpeg() returns the SOF width and height and never reads the EXIF Orientation tag. A phone portrait photo is typically stored as 4032x3024 with Orientation=6. The validator computes 1.33 and the library shows 'Instagram: can be used', while browsers display the picture as 3024x4032 (3:4 = 0.75), whi�
   FIX: Keep it as low. Have jpeg() in src/lib/social/image-size.ts parse the APP1 'Exif\0\0' TIFF header (II/MM byte order, IFD0 tag 0x0112) and swap width and height when Orientation is 5-8. Alternatively add a non-blocking warning when an EXIF Orientation of 5-8 is present and the shape could not account for rotation. Optionally make the publish-time ERROR message mention the aspec�

#46 [low (claimed low)] migration-database :: 0089 rollback deletes from storage.buckets directly, which hosted Supabase's storage delete-protection rejects
   supabase/rollbacks/0089_social_media_manager.down.sql:45  votes=['confirmed']
   SCENARIO: `delete from storage.buckets where id = 'social-media'` is a direct SQL delete on a storage table. As I recall, hosted Supabase's storage.protect_delete trigger raises 'Direct deletion from storage tables is not allowed. Use the Storage API instead.' I could not check this here: PGlite's compat stu�
   FIX: In supabase/rollbacks/0089_social_media_manager.down.sql, before line 45, add a transaction-local override: `select set_config('storage.allow_delete_query', 'true', true);`. Keep the `delete from storage.buckets where id = 'social-media';` after it. The override only lasts for the transaction, so it does not leave the protection weakened. Apply the same change to 0049_aqi_atta�

#47 [low (claimed low)] migration-database :: saveSocialSettings reports success when its optimistic-concurrency update matches no row
   src/server/social/settings.ts:40  votes=['confirmed']
   SCENARIO: Two owners open settings at version 3 and both save. The version check reads without a lock, so both pass `cur.version === expectedVersion`. The first save moves the row to version 4. The second statement's `on conflict ... do update ... where social_settings.version = 3` then affects 0 rows, and t�
   FIX: In src/server/social/settings.ts, capture the upsert result and add `returning org_id` to the statement (or check `result.rowCount`). If it is 0, throw `new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.")` before calling recordAudit. The throw rolls back the withSystem transaction. Alternatively, make the read at line 2�

#48 [low (claimed low)] migration-database :: Draft save of a link or caption the form and Zod accept hits a raw check violation shown as 'Something went wrong'
   src/server/social/posts.ts:216  votes=['confirmed']
   SCENARIO: The composer's Save is not blocked by problems. `<input type=url>` accepts http://shop.example, and the app's own rule `/^https:\/\//i` accepts HTTPS://Shop.example. insertDraft and updatePost pass the trimmed value straight to social_posts, whose check is the case-sensitive `link_url ~ '^https://'�
   FIX: Make the application and the database agree. For the link, either change the check in 0089 to a case-insensitive match (`link_url ~* '^https://'`), which is acceptable because 0089 is not yet released, or lower-case the scheme in `insertDraft` and `updatePost`. In `insertDraft` and `updatePost`, throw `AppError("invalid_input", ...)` for a non-https link and for a caption over�

#49 [low (claimed medium)] oauth-credentials :: A transient health-check failure sets the account to 'error', and the publisher then permanently fails approved posts that come due
   src/server/social/publisher.ts:182  votes=['partly']
   SCENARIO: The 6-hourly socialAccountHealth sweep (or a click on 'Test connection') calls debug_token and gets a timeout, a 5xx or a rate-limit answer. checkAccountHealth (accounts.ts 340-343) turns any non-reauth ProviderError into status 'error', and stopPublishingFor is not run, so the jobs stay queued. Wh�
   FIX: Real, low severity. In prepare() (src/server/social/publisher.ts:182), treat account.status === 'error' as retryable. For example, requeue the job with a short delay and the existing requeue(...) helper, or run one fresh checkAccountHealth first, and only fail immediately for needs_reauth, revoked, disconnected or a missing account. Cap the waiting so a persistently broken acc�

#50 [low (claimed medium)] oauth-credentials :: Deauthorize and data-deletion leave the person's sealed sign-in blob and Meta user id behind, and abandoned sign-ins are never purged
   src/server/social/accounts.ts:312  votes=['partly']
   SCENARIO: completeMetaConnect stores `pending`, an AES-GCM blob holding the Meta userId, the userName and every managed Page's access token, and clears it only when connectChosenPages finishes. If the person closes the tab on the choice screen, the row keeps that blob after it expires. Nothing purges it: the�
   FIX: Downgrade to low. It is a real retention and data-minimisation gap, not a credential leak. 1. Add a small scheduled job beside the other retention jobs in src/server/ops/tick.ts, for example daily or every few minutes: `update social_oauth_states set pending = null where pending is not null and expires_at < now()`, then `delete from social_oauth_states where expires_at < now()�

#51 [low (claimed low)] oauth-credentials :: checkAccountHealth writes its result back with no status guard, so it can undo a concurrent disconnect or revoke
   src/server/social/accounts.ts:347  votes=['confirmed']
   SCENARIO: checkAccountHealth reads the row, then awaits a Graph call (up to 25 s) outside any lock, then runs `update social_accounts set status = $2, status_detail = $3 ... where id = $1`. If an owner clicks Disconnect, or Meta's deauthorize callback runs revokeByProviderUser, during that call, the later up�
   FIX: Guard the write and gate the follow-up on it, in src/server/social/accounts.ts around lines 345-360. Add `and status in ('connected','needs_reauth','error')` to the update's where clause and add `returning id`. If no row comes back, return without running the `next.status === "needs_reauth"` branch (stopPublishingFor and notifyOrgRoles). Gating the branch matters: with only th�

#52 [low (claimed low)] oauth-credentials :: The accounts page prints the ?skipped= query parameter inside a trusted warning banner
   src/app/(portal)/social/accounts/page.tsx:40  votes=['confirmed']
   SCENARIO: `skipped = one(sp.skipped)` is rendered as 'Not connected: {skipped}' with no check that it came from the app. The panel only builds that URL client-side after a connect. A crafted link such as /social/accounts?skipped=Your+Meta+account+is+locked,+call+... sent to a workspace owner shows attacker-w�
   FIX: Do not take the message text from the URL. `connectChosenAction` already returns the `skipped` reasons and runs server-side, so have it set the httpOnly notice cookie (`SOCIAL_NOTICE_COOKIE` with `encodeSocialNotice({kind: "warning" or "error", message})`, like the OAuth callback route). The page then renders it through the existing `decodeSocialNotice` banner, and `router.rep�

#53 [low (claimed low)] oauth-credentials :: A non-UUID ?choose= value crashes the accounts page with a database error
   src/app/(portal)/social/accounts/page.tsx:22  votes=['confirmed']
   SCENARIO: A signed-in owner or manager opens /social/accounts?choose=abc. The value is passed unvalidated to pendingChoices, then openPending runs `where id = $1` on a uuid column. Postgres raises 22P02, which is a plain Error. The page only treats AppError as 'expired' and rethrows everything else, so the p�
   FIX: In src/app/(portal)/social/accounts/page.tsx, check `stateId` against a UUID pattern (for example the same `uuid` Zod schema used in src/app/actions/social.ts, via `safeParse`) before calling `pendingChoices`. When it does not match, set `expired = true` and skip the call. Alternatively, make `openPending` in src/server/social/accounts.ts throw the existing `AppError("not_foun�

#54 [low (claimed low)] oauth-credentials :: The authorize URL never sets auth_type=rerequest, so the 'Reconnect and allow it' advice can loop for a declined permission
   src/server/social/providers/meta-oauth.ts:26  votes=['confirmed']
   SCENARIO: The person unticks pages_manage_posts, or instagram_content_publish, in Meta's permission dialog. Health reports 'Missing permission: ... Reconnect and allow it.', and the page is skipped or marked needs_reauth. They click Connect again and authorizeUrl sends the same dialog request with no auth_ty�
   FIX: In src/server/social/providers/meta-oauth.ts authorizeUrl (after line 33), add u.searchParams.set("auth_type", "rerequest"). Meta documents it as only re-asking permissions the person previously declined, so setting it on every connect is harmless on a first connection and avoids needing a separate reconnect flag. Extend the test at tests/social-meta.test.ts:215-222 to assert �

#55 [low (claimed low)] publisher-durability :: A post confirmed as not posted by reconciliation fails silently: no notification and no social.post_failed event
   src/server/social/publisher.ts:335  votes=['confirmed']
   SCENARIO: A lost answer puts the post in needs_reconciliation (handleFailure sends no notification). After the grace period, reconcileUnknownJobs marks the job and post failed 'confirmed_not_posted' and only adds a history event. Every other terminal failure goes through failJob, which notifies owners and th�
   FIX: Route the confirmed_not_posted branch through failJob instead of the hand-written updates at publisher.ts:335-340. failJob already includes 'needs_reconciliation' in its post status guard (line 146). So call `await failJob(db, job, post, "confirmed_not_posted", msg, "unknown_outcome", now)` inside the withSystem block, then keep `addEvent(..., "reconciled_not_posted", ...)` so�

#56 [low (claimed low)] publisher-durability :: Failure notification and automation event are deduplicated per post version, so a retry that fails again is silent
   src/server/social/publisher.ts:151  votes=['confirmed']
   SCENARIO: failJob uses dedupeKey 'social-failed:<post>:<version>', and announce uses 'social.post_failed:<post>:<version>' (post-core.ts line 80), both ON CONFLICT DO NOTHING. retryPost does not change the version. A post fails (gave_up after 5 transient errors, or a platform refusal) and the owner is told o�
   FIX: Make the failure dedupe keys unique to the failed job instead of the post version. In src/server/social/publisher.ts failJob, use job.id (a uuid, so the notification keys stay well under the 160-character limit): `social-failed:${post.id}:${job.id}` and `social-failed-author:${post.id}:${job.id}`. For the event, add an optional dedupe suffix to announce() in src/server/social/�

#57 [low (claimed medium)] ui-a11y-honest-states :: Calendar is replaced by 'Connect an account to start' when every account is disconnected, hiding existing posts
   src/app/(portal)/social/page.tsx:57  votes=['partly']
   SCENARIO: The only account is disconnected by the owner. listAccounts(ctx) (line 27) excludes disconnected rows, so accounts.length === 0 and the EmptyState is rendered instead of CalendarView. The business's published history, drafts and the posts just failed by the disconnect still exist in social_posts bu�
   FIX: In src/app/(portal)/social/page.tsx, load the full list with listAccounts(ctx, { includeDisconnected: true }) and use it for the account filter. It must also drive the ?account= validation at line 28 and the CalendarView accounts prop. Keep the banner and canCreate on the active subset, e.g. active = accounts.filter(a => a.status !== 'disconnected'). Otherwise a permanently di�

#58 [low (claimed medium)] ui-a11y-honest-states :: Post page never says that live publishing is off or that the account is a test account
   src/components/social/post-actions.tsx:54  votes=['partly']
   SCENARIO: (a) A real (adapter 'meta') account exists and META_SOCIAL_WRITES_ENABLED is false. On /social/posts/[id] a publisher clicks 'Publish as soon as possible' and gets the toast 'Queued to publish now.' (line 54). schedulePost does not check the switch, and claimNext only claims meta jobs when live is �
   FIX: Downgrade to low and limit it to the meta, writes-off case. Pass a boolean such as liveBlocked (adapter === 'meta' && !livePublishingEnabled()) from page.tsx into PostActions. When it is true, show the same one-line notice as the calendar banner above the schedule controls. Change the 'Publish as soon as possible' toast to something like "Queued. It will be sent once publishin�

#59 [low (claimed low)] ui-a11y-honest-states :: Manually entered 'It is on the Page' permalink is stored unvalidated and rendered as a link
   src/app/actions/social.ts:87  votes=['confirmed']
   SCENARIO: resolveUnknownAction passes `permalink` straight through (no zod URL or https check); resolveUnknown stores trim().slice(0,500) (posts.ts:477). post-actions.tsx:74 then renders <a href={post.permalink}> to every viewer. The input is type=url but is not inside a <form>, so browser validation never r�
   FIX: Validate in resolveUnknown (src/server/social/posts.ts:477), or in a zod schema in resolveUnknownAction (src/app/actions/social.ts:87). Trim the value. Treat an empty string as null. Require `new URL(v)` to parse with `protocol === "https:"`. Optionally also require the hostname to equal or end with facebook.com, fb.com or instagram.com, depending on the account's platform. Th�

#60 [low (claimed low)] ui-a11y-honest-states :: 'New post on <day>' links drop the chosen date
   src/app/(portal)/social/posts/new/page.tsx:12  votes=['confirmed']
   SCENARIO: Month and week cells link to /social/posts/new?date=2026-10-30 with aria-label 'New post on Friday, October 30' (calendar-view.tsx:128,154), and the empty-state button does the same (calendar-view.tsx:107). The new-post page reads sp.date only to build the Back link (line 20); PostComposer has no d�
   FIX: Cheapest honest fix: change the three link labels to something that does not promise a date, such as "Start a new post" (they already open a general composer), or label them "Start a post for <day>" only if the date is carried. To actually carry the date, validate `sp.date` as `^\d{4}-\d{2}-\d{2}$` and not before today in the workspace zone. Pass it through the redirect in com�

#61 [low (claimed low)] ui-a11y-honest-states :: Buttons are offered that the server will always refuse
   src/components/social/post-actions.tsx:76  votes=['confirmed']
   SCENARIO: (1) A member or sales rep (social.create only) opens a teammate's draft: `can.create` is true so 'Send for approval' (line 85) is shown enabled, but submitForApproval requires canEditRow (author, or approve/publish) and returns 'Only the person who wrote this post, or a manager, can send it for app�
   FIX: At src/components/social/post-actions.tsx:76, gate the draft and changes_requested block on can.edit instead of can.create. Where a non-editor sees nothing, show the line 'Only the person who wrote this post, or a manager, can send it for approval.' The Duplicate button at line 140 can stay on can.create. For Approve (line 98), pass isAuthor and settings.approvalForPublishers �

#62 [low (claimed low)] ui-a11y-honest-states :: Accounts page trusts raw query parameters: ?choose= non-UUID crashes it and ?skipped= is shown as a system warning
   src/app/(portal)/social/accounts/page.tsx:25  votes=['confirmed']
   SCENARIO: pendingChoices runs `select ... from social_oauth_states where id = $1` (accounts.ts:149) with id uuid. For /social/accounts?choose=abc by an owner/admin, Postgres throws invalid input syntax for type uuid, which is not an AppError, so line 28 rethrows and the whole Accounts page 500s instead of sh�
   FIX: For `choose`, validate it as a UUID before querying. In page.tsx, use `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` and set `expired = true` when it fails. Better, put the same check at the top of openPending in src/server/social/accounts.ts, throwing AppError("not_found", "That connection expired. Start it again."), so every caller is covered (connectCho�

#63 [low (claimed low)] ui-a11y-honest-states :: Calendar filter selects can overflow the 375px viewport
   src/components/social/calendar-view.tsx:86  votes=['partly']
   SCENARIO: The Account and Status <select>s have no w-full/max-w-full/min-w-0 and sit in flex-wrap labels. Native selects size to their longest option, so with a Page named like 'Smith and Sons Plumbing, Heating and Air Conditioning of Springfield (Facebook Page)' the control is wider than the 343px content a�
   FIX: Keep it low. Reword the impact: a long account name makes the Account select wider than the phone viewport, so its right edge and chevron are clipped by body overflow-x:hidden (it does not scroll the page). In src/components/social/calendar-view.tsx lines 84-97, add `min-w-0 max-w-full` to both labels and `w-full max-w-full sm:w-auto` to both selects. Alternatively give the fo�

#64 [low (claimed low)] ui-a11y-honest-states :: Posts a person marked as posted are explained as 'Confirmed published by the platform'
   src/lib/social/state.ts:29  votes=['confirmed']
   SCENARIO: resolveUnknown('posted') sets status 'published' with provider_post_id 'manual:<id>' (posts.ts:477) on a person's word, with no platform confirmation. PostActions shows STATUS_EXPLAIN.published ('Confirmed published by the platform.') at line 68 and the StatusBadge tooltip, with a 'View the post' l�
   FIX: Make the explanation depend on how the post became published. Add a helper in `src/lib/social/state.ts`, for example `statusExplain(status, providerPostId)`, which returns "Marked as published by a person after checking the Page; the platform did not confirm it." when `status === 'published'` and `providerPostId?.startsWith('manual:')`. Otherwise it returns `STATUS_EXPLAIN[sta�

#65 [low (claimed low)] ui-a11y-honest-states :: After a stale-version conflict the page is not refreshed and the reviewer keeps seeing the old text
   src/components/social/post-actions.tsx:98  votes=['confirmed']
   SCENARIO: A reviewer opens a pending post at version 5; the author edits and resubmits (version 6). Approve sends version 5 and decide() throws 'The post changed while you were reviewing it. Review the new version.' useCrmAction.run shows the toast and returns null on failure without router.refresh(), so pro�
   FIX: In useCrmAction (src/components/crm/ui.tsx, the !res.ok branch), call router.refresh() when res.code === "conflict" before returning null. ActionResult already carries code, and actionError passes it through. This also fixes the "not waiting for approval" conflict and conflicts from the composer's updatePostAction. Alternatively, do it only for the social post screens: in post�

#66 [low (claimed low)] ui-a11y-honest-states :: Composer allows 60 hashtags but the server silently keeps 30
   src/components/social/composer.tsx:57  votes=['confirmed']
   SCENARIO: The composer builds hashtags with normalizeHashtags(..., 60) and, for Facebook (hashtagMax null), flags no problem for 31-60 tags and the preview shows all of them. insertDraft/updatePost store normalizeHashtags(input.hashtags, 30) (posts.ts:210,~275). The saved and later approved/published caption�
   FIX: Align the three caps on one constant (30, matching the DB check). Use that cap in the composer's normalizeHashtags call (composer.tsx:57) and lower the action schema's .max(60) to match, or reject over-cap input on the server with an invalid_input error instead of truncating. Also show a visible warning in the composer when more than 30 tags are entered, for example "Only the �
