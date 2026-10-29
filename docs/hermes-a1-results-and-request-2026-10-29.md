# A1 preflight results and the A1 request (draft)

Date: 2026-10-29. Branch: `integration/hermes-bridge-final`. Scope of this document: read-only. Nothing in it was applied.

## 1. Where the preflight stands

**Overall: PARTIAL. A1 cannot be requested yet.** The checks that need the VPS and the Cloudflare account have not run, because this session has no authorized path to either: there is no SSH identity or configured host on this machine, and the Cloudflare dashboard in the browser pane is signed out (the sign-in page, with single sign-on, is what loads). Credentials are not entered on your behalf, so these two inspections are yours to run with the scripts from commit `5bcab319` (`docs/hermes-a1-preflight-2026-10-29.md`, sections 2 and 3).

Status key: PASS (verified), WARN (look at it), STOP (blocks A1), PENDING (not yet measured, who runs it is named).

| # | Check | Status | Evidence or what is needed |
| --- | --- | --- | --- |
| A0 | Production is master `836ab4cb`, CI passed | PASS | CI run `40818417650` succeeded on both jobs; `origin/master` is `836ab4cb`; production deployment `iacquire-dashboard-n1wmpca5g` is Ready |
| A1-p | Preflight commit available to run | PASS | `origin/integration/hermes-bridge-final` is `5bcab319`; its diff against production touches only docs, two scripts and one test (no `src/`, `supabase/` or package file) |
| 16 | Vercel Production has no worker, audit or MCP variable | PASS | `vercel env ls production` (names only, values not read): the only variable whose name contains HERMES is `HERMES_RUN_TIMEOUT_MS`. No `HERMES_INFERENCE_*`, `HERMES_PROMPT_AUDIT_*` or `HERMES_BUSINESS_MCP_*` exists |
| 17 | Production healthy and unchanged | PASS | `/api/health` is `{"status":"ok","database":"ok","scheduler":"never_ran"}`; the three newest Production deployments are `n1wmpca5g` (A0), then `d2n7hvc05` and `hgt3cwaas` (the rollback anchors). Two newer deployments exist but are Preview, not Production |
| 1 | Clock skew 5 s or less | PENDING (you, VPS script) | |
| 2 | Memory available 4096 MiB or more | PENDING (you, VPS script) | Last seen 6.1 GiB on the 2026-10-29 snapshot; not a measurement now |
| 3 | Disk free 15 GiB or more | PENDING (you, VPS script) | Last seen 88 GiB; not a measurement now |
| 4 | Docker and Compose v2, no user-namespace remapping, no cgroup warnings | PENDING (you, VPS script) | |
| 5 | No worker, proxy, network or image of ours exists | PENDING (you, VPS script) | The 2026-10-29 snapshot saw none |
| 6 | Gateway and tunnel containers running | PENDING (you, VPS script) | |
| 7 | Tunnel is token-managed, routes readable remotely | PENDING (you, VPS script and Cloudflare script) | |
| 8 | Six profile directories exist, no symlinks, readable by UID/GID 10000 | PENDING (you, VPS script) | Needs the real file modes |
| 9 | Each `SOUL.md` is a regular file of 1 to 16384 bytes | PENDING (you, VPS script) | |
| 10 | Each `config.yaml` has a `model:` block, DeepSeek provider, allowed model | PENDING (you, VPS script) | 2026-10-29 snapshot: all six resolve to `deepseek-flash` |
| 11 | Each profile has its own `.env` with a usable DeepSeek key | PENDING (you, VPS script) | The most likely STOP; see section 4 |
| 12 | `api.deepseek.com` resolves to public addresses only | PENDING (you, VPS script) | |
| 13 | Pinned base digest resolves for the host architecture | PENDING (you, VPS script) | |
| 14 | Cloudflare: Hermes catch-all found, no `internal/inference` rule, planned rules isolate | PENDING (you, Cloudflare script, or sign in to the browser pane) | |
| 15 | Cloudflare: Access covers the worker paths with service-token-only policies | PENDING (you, Cloudflare script, or sign in to the browser pane) | |

Two quicker ways to unblock the Cloudflare half without creating an API token: sign in to Cloudflare yourself in the browser pane of this app (I can then read the tunnel routes and Access pages, read-only, and I will not type any credential), or run the Cloudflare script locally with a one-day read-only token.

## 2. Explicit blocker for A2 and A3: the 6,144-byte prompt budget

Preserved from the release package (section 6, finding C7). It does not block A1, but it blocks any live-model test.

| Role | App run instructions (bytes) | With the 142-byte chat canary | Headroom against 6,144 |
| --- | --- | --- | --- |
| Zeng (operations manager) | 5,699 | 5,841 | 303 |
| **Lead Hunter** | **10,874** | **11,016** | **-4,872** |
| Appointment Setter | 5,785 | 5,927 | 217 |
| Sales Assistant | 5,898 | 6,040 | 104 |
| CRM Manager | 5,666 | 5,808 | 336 |
| Performance Analyst | 5,611 | 5,753 | 391 |

- **Lead Hunter is over budget by 4,872 bytes on its own app instructions**, before the worker adds the SOUL file and Hermes's message wrapping.
- The other five fit by 104 to 391 bytes on instruction text alone. The SOUL and Hermes's wrapping are not counted here and may exceed that headroom, so none of the six can be assumed to pass. Only the no-call audit (A2) measures the effective prompt.
- **Nothing is to be truncated, shortened or dropped to make a role fit.** Security rules and business knowledge stay as they are. The worker already refuses an over-budget request before any provider call, so an over-budget role fails safe.
- Before any live-model canary (A3) a deliberate decision is needed (release package D2). The options, none applied: a purpose-built short canary instruction that carries the security rules but not the full role text (recommended, because the canary only needs to prove provider, model and usage); a larger worker budget, which is a code and cost change; or a reviewed reduction of Lead Hunter's default instructions, which changes the employee's behaviour and needs its own review.

## 3. Draft A1 request (valid only if rows 1 to 15 are all PASS; nothing here is approved)

**What A1 changes.** Seven containers (six workers capped at 512 MiB and 0.5 CPU each, one proxy capped at 64 MiB), thirteen Docker networks (twelve internal, one egress network that only the proxy joins), one image built on the VPS, two directories, one secret file, six tunnel network attachments (runtime only) and six Cloudflare path routes. **What it does not change:** any Hermes profile, the gateway container, the tunnel container's configuration, the VPS firewall, any Vercel setting, any DeepSeek call, any employee, schedule, contact or booking. Inference stays off: the application flag is off and no Vercel variable exists, so no request can reach a worker.

| Step | Where | Exact action |
| --- | --- | --- |
| 1 | your machine to VPS | `git archive 5bcab319301285f65951a7ad61c515160c3dbaf9 services/hermes-inference-worker \| ssh root@<vps> 'install -d -m 0755 /docker/iacquire-hermes-inference && tar -x -C /docker/iacquire-hermes-inference'`. Then compare file hashes with `git ls-tree` |
| 2 | VPS | `install -d -m 0700 /etc/iacquire-hermes-inference`, then create the secret there with `umask 077` and `openssl rand -hex 32`, `chown 10000:10000`, `chmod 0400`. It is 65 bytes, printable, mode with no group or other bits, as the worker requires. It is never printed. At A2 it is piped to Vercel without display |
| 3 | VPS | In `/docker/iacquire-hermes-inference/services/hermes-inference-worker` with `HERMES_PROFILE_BASE=<data>/profiles` and `IACQUIRE_INFERENCE_HMAC_FILE=/etc/iacquire-hermes-inference/inference_hmac`: `docker compose -f compose.internal.yaml build`, then `up -d`. Prompt audit stays off (the Compose default) |
| 4 | VPS | Verify: all seven containers healthy; each worker shows exactly one `ro` profile mount and the secret; no published host port; from a worker, a `CONNECT example.com:443` to the proxy returns 403 |
| 5 | VPS | For each role: `docker network connect iacquire-hermes-inference-<role>-ingress iacquire-hermes-tunnel` (six commands) |
| 6 | Cloudflare dashboard | Add the six anchored path routes from `services/hermes-inference-worker/DEPLOYMENT.md` above the Hermes catch-all, under the existing Access policy. The Cloudflare script has already simulated the order |
| 7 | anywhere | An unauthenticated request to each worker path is refused by Access. A request with a temporary service token but no valid signature is refused by the worker. Needs decision (b) below |
| 8 | VPS | Re-run the preflight: profile hashes identical to the baseline, gateway and tunnel unchanged and healthy |

**Rollback** (the order matters, and it needs no profile restore because no profile changes): delete the six routes in Cloudflare; `docker network disconnect` the six ingress networks from the tunnel container; `docker compose -f compose.internal.yaml down` (this removes the seven containers and the thirteen networks); `docker rmi iacquire/hermes-inference-worker:0.22.5-v1`; delete `/etc/iacquire-hermes-inference` and `/docker/iacquire-hermes-inference`; re-run the preflight to confirm the baseline. The Vercel rollback anchors are unaffected because A1 changes no Vercel setting.

**Decisions to make with the request**
- (a) Tunnel attachment: runtime `docker network connect` (recommended for the first window; it fails closed if the tunnel is recreated) or a permanent edit of how the tunnel is declared.
- (b) Route proof: a temporary Cloudflare Access service token created for the test and deleted afterwards (recommended), or no authenticated test until A2.
- (c) Where the secret is generated: on the VPS (recommended; it never leaves it until A2).

## 4. Isolated remediation proposal (only if check 8, 9, 10 or 11 is STOP; nothing authorized)

No live profile is edited. Instead of changing the live profile directories, A1 would use **worker-only copies**:

1. Create `/docker/iacquire-hermes-inference/profiles/iacquire-<role>/` for each of the six roles (the analyst's directory is `iacquire-analyst`).
2. Copy only `SOUL.md` and `config.yaml` from the live profile, owned by 10000:10000, mode 0440, and verify each copy's SHA-256 equals the live file's.
3. Add a worker-only `.env` holding only `DEEPSEEK_API_KEY`, mode 0400, owned by 10000:10000, **typed or pasted by you on the VPS** (it does not pass through chat or through me). A dedicated DeepSeek key for the workers is recommended, so it can be revoked without touching Hermes.
4. Set `HERMES_PROFILE_BASE` to the copy directory. The Compose file needs no change, because it builds each mount as `<base>/iacquire-<role>`.

Cost of this approach: a second place a key lives, and the copies must be re-synced if a live SOUL or config changes (the preflight's hash lines detect drift). Benefit: the six live profiles, the gateway and every existing employee stay byte-for-byte unchanged, and rollback is deleting one directory. The narrower alternative for a pure permission problem, a read ACL for UID 10000 on one live profile, edits live permissions and would need its own approval.

## 5. Next steps, in order

1. You run the VPS script and either sign in to Cloudflare in the browser pane or run the Cloudflare script. Send the two outputs.
2. I fill in section 1, say PASS, WARN or STOP for every row, and either finalize section 3 as the single A1 approval request or hand you section 4 with the exact failing rows.
3. A1 is installed only after you approve it separately. Then A2 (no-call prompt audit) is requested separately. Then the prompt-budget decision in section 2 is requested before any live-model test.
