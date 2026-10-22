# Unified Inbox: performance risks at scale

Measured on 2026-10-22 with the opt-in probe `tests/perf/inbox-scale.perf.test.ts` (`CRM_PERF=1 INBOX_PERF_CONVERSATIONS=30000 npx vitest run tests/perf/inbox-scale.perf.test.ts`): one workspace with
**30,000 conversations and 150,000 messages** (timestamps spread over 90 days, 100 conversations changed in the last minute) next to a smaller one, the real service functions, as a workspace member under
row-level security (RLS), embedded Postgres, median of 5 runs. **Indicative only**: in memory, one process, no network, no concurrency. Hosted Postgres was not measured and no staging exists. Results are written to
`.data/perf/inbox-scale.json`, `inbox-search-attribution.json` and `inbox-rls-candidate.json`.

## 1. What it costs now

| Read | 30,000 conversations | 2,000 conversations | Grows with |
| --- | --- | --- | --- |
| A view's first page (Priority sort 109 ms; Needs attention 59; Assigned to AI 50; Resolved 54) | 50 to 116 ms | 13 to 19 ms | the workspace's conversations |
| Second page by cursor | 173 ms | 18 ms | same |
| Counts for every tab | 76 ms (owner), 38 ms (sales rep) | 10 ms | same |
| **Change poll** (every open tab, every 5 s) | **73 to 76 ms**, three statements | 23 ms | conversations changed recently, not the workspace |
| Scheduled "customer waiting" scan | 31 ms, at most 10 notices and one summary per workspace | 4 ms | workspaces with waiting customers |
| **Search** | **611 ms** | 51 ms | **messages in the workspace** (section 3) |

Pages are always at most 50 rows (about 31 KB); nothing reads a whole workspace into the application.

## 2. The risks, in the order I would worry about them

1. **Search (611 ms), and why.** See section 3. It is the only read that is slow enough to feel at this size, and it gets worse with every message the workspace stores, not with the number of people looking.
2. **The poll's database time, summed over open tabs.** 75 ms every 5 s is about 1.5 % of one database core per open tab. 100 tabs (50 people with two tabs) would be about 1.5 cores of poll work. This is the number that decides whether the database size is enough for the first customer waves; it must be measured under real concurrency on staging. The poll's rate limit is per process by design (a database-backed counter would add a write per poll).
3. **List reads that scan the workspace's conversations.** Every plan reads the workspace's conversations sequentially at 30,000 (the planner's choice at this size), so a first page costs 50 to 116 ms and grows roughly linearly. Fine for workspaces of hundreds to low thousands; worth re-measuring beyond about 10,000.
4. **The scheduled scan** is bounded (10 notices per workspace per scan, round-robin across workspaces) and is not a risk at this size.

## 3. Where the search time goes (measured, not guessed)

The same predicate the list uses, one branch at a time, term "viewing 12", first page of 51, as the workspace owner under RLS and as the system role (no RLS):

| Branch | Owner (RLS) | System (no RLS) |
| --- | --- | --- |
| No search (the first page, for comparison) | 32 ms | 24 ms |
| Contact name | 23 ms | 21 ms |
| Preview and subject | 37 ms | 35 ms |
| Phone and email identities | 1.4 ms | 0.9 ms |
| **Message text** | **425 ms** | **1.8 ms** |
| All five, as the list runs them | **469 ms** | **74 ms** |

* The predicate itself is cheap: **74 ms** with RLS off, and the trigram index on message text **is used** (1.8 ms).
* About **400 ms** of the search is **row-level security on `conversation_messages`**. Its policy says a message is visible when an `EXISTS` lookup finds its conversation, and because `ILIKE` is not safe to run ahead of a policy check, the
  database does that lookup for **every message in the workspace (150,000 here) before the text filter can narrow anything**. That is roughly **2.5 to 3 ms per 1,000 messages** in a workspace, whatever the term.
* So the fix, if it is needed, is about **the policy or about keeping the messages table out of the search path**, not about indexes or the predicate.

## 4. What was tried, and what was only measured

| Change | Result | Status |
| --- | --- | --- |
| Rewrite the five conditions as a `UNION` of five indexable queries | **About 2,700 ms** (4 to 5 times slower), because under RLS each branch is evaluated for every row of the workspace | **Tried and reverted** |
| **Candidate:** a `conversation_messages` policy with the same meaning that short-circuits for people who can see every conversation (`org_id = any(permitted view_all orgs) or exists (...)`) | Owner's message-text search **393 → 126 ms** (3 times faster). **A sales rep (sees own and assigned conversations only) is unchanged at about 365 ms.** Every role sees exactly the same message rows (owner and manager 150,000, support 50,000, sales rep 37,500, viewer 0) | **Measured only, not applied.** A change to an RLS policy needs its own security review and a migration (0083 is unapplied, so it could ride in it); I will not make it unreviewed |
| Search only customers, previews, subjects and identities by default, message text on request | About 70 ms for the default search (name, preview, subject and identity measured at 69 ms with RLS) | **A product choice**, not applied; it changes what "search" finds |
| A stored search column per conversation (contact name, identities, recent message text), kept by trigger, with a trigram index | Not built. It would remove the messages table from the search path and serve restricted roles too | The larger fix; schema change and its own review |

## 5. What this means for the rollout

* **First waves (internal workspace, test clients):** search is fine. A workspace with thousands of conversations is far below the size where it matters (about 70 to 80 ms at 5,000 conversations and 25,000 messages, extrapolating the 2.5 to 3 ms per 1,000 messages).
* **Before a large customer (tens of thousands of conversations):** decide between the candidate policy (owners and admins), the default-search split, or the stored column, with staging numbers in hand.
* **Do not** add an index or rewrite the predicate for this: the measurements say neither helps.

## 6. To check on staging

1. Re-run the probe's statements with `EXPLAIN (ANALYZE, BUFFERS)` on a staging copy with realistic volume, as a member (the JSON files name the statements). Compare the owner's and a restricted role's search.
2. Poll under concurrency: several tabs polling at once, and the connection pool's headroom.
3. Whether hosted Postgres plans the policy's `EXISTS` the same way (planner choices differ with real statistics and a buffer cache).
4. Re-run the candidate policy experiment (last test in the probe file) and confirm the same rows for every role.
