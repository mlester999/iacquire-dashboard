# A1 preflight results and the A1 request

Date: 2026-10-29 (UTC 08:08 for the VPS run). Branch: `integration/hermes-bridge-final`. Everything below was read-only; nothing was installed, started, attached, routed, edited or called.

## 1. Result: no STOP, two WARN. A1 can be requested.

How it was run: the reviewed script (`scripts/hermes-a1-preflight.sh`, pinned to commit `5bcab319`, SHA-256 `52645f19380c975b1025e4970a3360b4f3ae6bdf00a84423cfe2d5bbd2a7fb9b`, hash verified before it ran) was run in the founder's open Hostinger VPS web console at the founder's request. Summary line: `ok=75 warn=1 fail=0`. Cloudflare was read in the signed-in dashboard, view only, with no Save, Add or Reorder pressed. Vercel and production were read with the CLI (names only). Sanitized: no key, env value, SOUL text or customer data appears in this file.

Status key: PASS, WARN (decide or note it), STOP (blocks A1).

| # | Check | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Clock skew 5 s or less | PASS | NTP synchronised, UTC, skew 0 s |
| 2 | Memory | PASS | 6,226 MiB available of 7,940 (caps total 3,136 MiB). **No swap**, so a worker that hits its cap is killed by its cgroup limit, not paged |
| 3 | Disk | PASS | 83 GiB free under `/var/lib/docker` and `/docker` |
| 4 | Docker engine | PASS | Docker 29.8.1, Compose 5.5.1, Ubuntu 24.04.5, kernel 6.8, 2 CPUs, no user-namespace remapping, no cgroup or swap-limit warnings |
| 5 | No worker, proxy, network or image of ours | **WARN** | No worker or proxy container, no `iacquire-hermes-inference-*` network. **But the image `iacquire/hermes-inference-worker:0.22.5-v1` already exists** (id `b0370f416f37`, 4.31 GB, created 2026-10-29 07:41:03 UTC, amd64, `USER 10000:10000`, version label `0.22.5-iacquire-inference.v1`, base-source label `bf0203a7...`, built from the pinned base digest and the reviewed file set including the prompt-audit smoke). This session did not build it; the preflight cannot. It was built shortly after the master push, by someone else. Nothing runs from it. See W1 |
| 6 | Gateway and tunnel running | PASS | Both up 10 days, 0 restarts, same Docker network `hermes-agent-wpwm_default`, no health checks defined. Traefik is also up (12 days) |
| 7 | Tunnel token-managed, routes readable | PASS | Container is token-managed; the dashboard lists and orders its routes. Tunnel `iacquire-hermes` is Healthy, 1 replica, cloudflared 2026.10.1 |
| 8 | Six profile directories, UID/GID 10000 access | PASS | All six exist, owned 10000:10000, mode `drwxr-xr-x`, enterable and readable by 10000, no symlinks flagged, no ACL warning |
| 9 | `SOUL.md` regular file, 1 to 16,384 bytes | PASS | Zeng 2,291; Lead Hunter 2,404; Appointment Setter 2,361; Sales Assistant 2,346; CRM Manager 2,323; Performance Analyst 2,349 bytes. Readable by 10000 |
| 10 | `config.yaml` provider and model | PASS | All six: `model:` block, provider `deepseek`, model `deepseek-flash` (in the worker allow-list) |
| 11 | Per-profile DeepSeek key | PASS | Each profile's own `.env` holds a key of 12 or more characters (value never shown), readable by 10000, no `DEEPSEEK_BASE_URL` override. No credential remediation is needed |
| 12 | `api.deepseek.com` resolves publicly | PASS | One public address; the egress proxy's private-address rule will not trigger |
| 13 | Pinned base digest resolves | PASS | Registry lists amd64 and arm64; the host is amd64 |
| 14 | Cloudflare routes | PASS | One route: #1 `hermes-api.iacquire.online` to `http://hermes-agent:8642`, no path, default settings. No `internal/inference` route. Simulated with the reviewed analysis code, with the six planned rules placed above it: each path reaches only its own worker, 30 near-miss paths (trailing slash, suffix, prefix, case) stay on the gateway, no role reaches another role's worker. The automatic 404 fallback rule is assumed, not shown by the dashboard |
| 15 | Cloudflare Access coverage | PASS | One application, `hermes-api` (self-hosted, `hermes-api.iacquire.online`, whole hostname, so every path is covered). One reusable policy, `iAcquire Vercel Service Access`, action Service Auth, include rule: Service Token `iacquire-hermes-vercel` only. No bypass, everyone, email or any-token rule. See W2 |
| 16 | Vercel Production variables | PASS | No `HERMES_INFERENCE_*`, `HERMES_PROMPT_AUDIT_*` or `HERMES_BUSINESS_MCP_*`; the only HERMES-named variable is `HERMES_RUN_TIMEOUT_MS` |
| 17 | Production healthy and unchanged | PASS | `master` and the review branch are `bd843d27` (docs, two scripts, one test on top of the A0 code; no migrations). Production deployment `iacquire-dashboard-38oremflx` Ready, `/api/health` ok. Rollback anchor: `iacquire-dashboard-n1wmpca5g` (`836ab4cb`) |

**Warnings**
- **W1, unexplained image.** The worker image was built before any A1 approval. It carries the reviewed pins, so it is probably the reviewed build, but it is unverified provenance. Handled in the request below by rebuilding from the verified source rather than trusting it. Please say who built it.
- **W2, non-expiring service token.** `iacquire-hermes-vercel` never expires (created 2026-10-17, last seen about 3 hours before the check). That is normal for a live integration but worth a rotation policy. A1 does not touch it.

**Observations that A1 does not change (for your awareness)**
- **O1.** The gateway container publishes container port 4860 on host port 32771 on all interfaces (IPv4 and IPv6), and `ufw` is inactive. That is the existing state, not something A1 adds. Confirm that port is meant to be public and protected by its own key.
- **O2.** The design mounts each profile directory read-only in full. Each directory also holds `state.db`, `sessions`, `memories` and `.env.backup-*` files. The workers are no-tool and egress-limited, but they could read that data in principle. See decision (d).

## 2. Explicit blocker for A2 and A3: the 6,144-byte prompt budget (sharpened by this run)

Preserved from the release package (C7) and strengthened, not resolved.

| Role | App instruction bytes | `SOUL.md` bytes (measured now) | Sum if Hermes sends both | Headroom against 6,144 |
| --- | --- | --- | --- | --- |
| Zeng (operations manager) | 5,699 | 2,291 | 7,990 | -1,846 |
| **Lead Hunter** | **10,874** | 2,404 | **13,278** | **-7,134** |
| Appointment Setter | 5,785 | 2,361 | 8,146 | -2,002 |
| Sales Assistant | 5,898 | 2,346 | 8,244 | -2,100 |
| CRM Manager | 5,666 | 2,323 | 7,989 | -1,845 |
| Performance Analyst | 5,611 | 2,349 | 7,960 | -1,816 |

- The previous picture was: Lead Hunter over by 4,872 and five roles with 104 to 391 bytes of headroom, before the SOUL. The SOUL files are now measured at 2.3 to 2.4 KB each. **If the pinned Hermes composes the SOUL together with the app instructions, as the release package expects, all six roles exceed the budget**, Lead Hunter by far the most. This is arithmetic on two measurements, not an observed prompt; only the A2 no-call audit measures the real effective prompt.
- **Nothing is to be truncated, shortened or dropped to make a role fit.** Security rules and business knowledge stay intact. The worker refuses an over-budget request before any provider call, so an over-budget role fails safe.
- A deliberate decision (release package D2) is required after the A2 audit and before any live-model canary. Options, none applied: a purpose-built short canary instruction that carries the security rules but not the full role text (recommended, since the canary only proves provider, model and usage); a larger worker budget, which is a code and cost change; or a reviewed change to the role instructions, which alters employee behaviour and needs its own review.

## 3. The A1 request (ready for your decision; nothing here is approved)

**Scope.** Install the six inference workers and the proxy with inference disabled. **Changes:** seven containers (six workers capped at 512 MiB and 0.5 CPU each, one proxy at 64 MiB), thirteen Docker networks (twelve internal, one egress network only the proxy joins), a rebuilt image, two directories, one secret file, six runtime tunnel attachments and six Cloudflare path routes. **Does not change:** any Hermes profile or `.env`, the gateway or tunnel container configuration, the firewall, any Vercel setting, any DeepSeek call, any employee, schedule, contact or booking. No request can reach a worker, because the application flag is off and no worker variable exists in Vercel.

**Who runs it.** With your approval, I run it in your open Hostinger console and Cloudflare dashboard one step at a time, showing each command and its output, never displaying the secret. Or you run the same commands. Stop at the first unexpected result.

| Step | Where | Exact action |
| --- | --- | --- |
| 1 | VPS | Create `/docker/iacquire-hermes-inference/services/hermes-inference-worker/` and download the eight files from `raw.githubusercontent.com/mlester999/iacquire-dashboard/bd843d270231cc8700979df83f45b9d0e566f345/services/hermes-inference-worker/<file>`. Verify each SHA-256 against the table below before anything is built |
| 2 | VPS | `install -d -m 0700 /etc/iacquire-hermes-inference`; generate the secret there with `umask 077` and `openssl rand -hex 32`; `chown 10000:10000`, `chmod 0400`. Expect a 65-byte file, mode 400, owner 10000:10000. Never print it. At A2 it is piped to Vercel without display |
| 3 | VPS | In that directory with `HERMES_PROFILE_BASE=/docker/hermes-agent-wpwm/data/profiles` and `IACQUIRE_INFERENCE_HMAC_FILE=/etc/iacquire-hermes-inference/inference_hmac`: `docker compose -f compose.internal.yaml build` (rebuilds from the verified source and replaces the unexplained image, W1), then `up -d`. Prompt audit stays off (Compose default) |
| 4 | VPS | Verify: seven containers healthy; each worker has exactly one `ro` profile mount plus the secret; no published host port; from a worker, a `CONNECT example.com:443` to the proxy returns 403 (refused locally, no external traffic) |
| 5 | VPS | Six times: `docker network connect iacquire-hermes-inference-<role>-ingress iacquire-hermes-tunnel` (runtime only) |
| 6 | Cloudflare dashboard | Tunnel `iacquire-hermes`, Routes: add six published-application routes for `hermes-api.iacquire.online` with the anchored paths and origins below, then Reorder so all six sit above the existing route |
| 7 | anywhere | Without credentials, request each of the six worker paths: expect an Access refusal (redirect or 403), never a worker or gateway response |
| 8 | VPS | Re-run the preflight: all six profile hash lines identical to this run, gateway and tunnel unchanged and healthy |

Source hashes at commit `bd843d27` (`services/hermes-inference-worker/`, unchanged since the A0 deployment):

| File | SHA-256 |
| --- | --- |
| `Dockerfile` | `97618cee1538014c04ae6304ee2ed1821d8364dc9d1020eeef1bcd96f2aa0294` |
| `compose.internal.yaml` | `68f714fc1d4970e972394d492a3b77beb5777be02ba84dd543d9e660862f8afa` (superseded: see section 6, corrected hash `99cd7096e6f893ad1bf46ff531aec395104ad0859fee78dd8cbcbde882cc62a6` at commit `f09227b5`) |
| `worker.py` | `772cfe2e131d9625304e8cd4c32bad936e3e6ef116962a683f5b4f61729d9d27` |
| `inference_runner.py` | `47a72768652124776cf69fca62c1e59f5ff92aed35d073c6de14eac763219788` |
| `deepseek_egress_proxy.py` | `2736719066901cc50f5b740578ab2d7d1a07f380a84ff6e79640e2fd8fd2eb45` |
| `pinned_runtime_smoke.py` | `75e8109d83e027aa01f401cba5959ecfb44546e0b3def62a8da8dbbfc48a8bb0` |
| `pinned_prompt_audit_smoke.py` | `6cac81af6d163f8f56c83b9d79f8048ab05970281961da8d468fadd4af9dd7ff` |
| `test_worker.py` | `0d74477152a70a88789df8cfcc9b36a1fadc2891fc5fe7511fd2a7fd4869a6d7` |

Routes (path is the anchored regex; origin is the worker on its private network):

| Role | Path | Origin |
| --- | --- | --- |
| Zeng | `^/internal/inference/v1/operations_manager/infer$` | `http://iacquire-hermes-inference-worker-operations-manager:8786` |
| Lead Hunter | `^/internal/inference/v1/lead_hunter/infer$` | `http://iacquire-hermes-inference-worker-lead-hunter:8786` |
| Appointment Setter | `^/internal/inference/v1/appointment_setter/infer$` | `http://iacquire-hermes-inference-worker-appointment-setter:8786` |
| Sales Assistant | `^/internal/inference/v1/sales_assistant/infer$` | `http://iacquire-hermes-inference-worker-sales-assistant:8786` |
| CRM Manager | `^/internal/inference/v1/crm_manager/infer$` | `http://iacquire-hermes-inference-worker-crm-manager:8786` |
| Performance Analyst | `^/internal/inference/v1/performance_analyst/infer$` | `http://iacquire-hermes-inference-worker-performance-analyst:8786` |

**Rollback** (needs no profile restore, because no profile changes): delete the six routes in Cloudflare; `docker network disconnect` the six ingress networks from `iacquire-hermes-tunnel`; `docker compose -f compose.internal.yaml down` (removes the seven containers and thirteen networks); `docker rmi iacquire/hermes-inference-worker:0.22.5-v1`; delete `/etc/iacquire-hermes-inference` and `/docker/iacquire-hermes-inference`; re-run the preflight to confirm the baseline. Vercel anchors are unaffected because A1 changes no Vercel setting.

**Decisions to make with the approval** (recommended defaults in bold; "approve with defaults" is enough)
- (a) Tunnel attachment: **runtime `docker network connect`** (fails closed if the tunnel is recreated) or a permanent edit of how the tunnel is declared.
- (b) Route proof: **unauthenticated check only at A1** (step 7). The authenticated, signed path is first exercised by the A2 audit, so no temporary Access token is created and the existing Access policy is not edited.
- (c) Where the secret is generated: **on the VPS**.
- (d) What each worker can see: **the full read-only profile directory as designed**, or worker-only copies holding just `SOUL.md`, `config.yaml` and `.env` (hides `state.db`, `sessions`, `memories` and the `.env` backups from the workers; costs a second key location and drift to re-sync; the live profiles stay untouched either way).

## 4. Remediation proposal

Not needed. Checks 8 to 11 all passed, so no profile, permission or credential change is proposed. The worker-only-copy design remains available as decision (d).

## 5. After A1

1. A1 is run only after your separate approval. A2 (no-call prompt audit) is then requested separately: it needs `HERMES_INFERENCE_WORKER_URL`, `HERMES_INFERENCE_WORKER_SECRET` and both audit flags set in Vercel, and is switched off after six measurements.
2. After A2, the prompt-budget decision in section 2 is requested before any live-model test. No canary runs before it.
3. The consultation calendar and client provisioning milestones are unaffected.

## 6. A1 execution log (approved by the founder: "Approve A1", recommended defaults)

Run one step at a time in the founder's Hostinger console. Stopped at the first surprise.

| Step | Result |
| --- | --- |
| Baseline | Containers: tunnel, gateway, Traefik only. The earlier worker image (W1) had been removed since 08:08 UTC. Profile baseline recorded in a shell variable (no file written): SHA-256 of all six `SOUL.md` and `config.yaml` plus size and mtime of each `.env` (18 lines). All six `config.yaml` are byte-identical (`2b469fa1...`); the `.env` files are 521 bytes each, last modified 2026-10-17 |
| 1. Source | Eight files fetched from `raw.githubusercontent.com` at `bd843d27` into `/docker/iacquire-hermes-inference/services/hermes-inference-worker/`. `sha256sum -c`: all eight OK |
| 2. Secret | `/etc/iacquire-hermes-inference/inference_hmac` created on the VPS: owner 10000:10000, mode 400, 65 bytes, never printed |
| 3a. Compose check | `docker compose config`: valid, seven services |
| 3b. Build | Exit 0, a complete cache hit: the image kept its original creation time (07:41:03 UTC) and labels. A cache hit requires byte-identical inputs, so the earlier image (W1) was built from exactly these verified sources. **W1 is resolved** |
| 3c. Start | **Failed, nothing started.** Networks created (13); no container created: `Error response from daemon: invalid mount path: 'nodev' mount path must be absolute`. Containers afterwards: the original three only |

**Cause (a defect in the reviewed Compose file, not the VPS).** `tmpfs: [/tmp:rw,noexec,nosuid,nodev,size=32m]` is a YAML flow list, so each comma started a new item. Parsed before the fix: `["/tmp:rw","noexec","nosuid","nodev","size=32m"]`; after: `["/tmp:rw,noexec,nosuid,nodev,size=32m"]`. CI only parsed and rendered the Compose file and never started the services, so it passed. Two lines were affected (workers 32m, proxy 8m).

**Fix** (commit `f09227b5`, review branch): quote both values (the intended options are unchanged); CI now asserts the rendered tmpfs value of every worker and the proxy; `tests/hermes-worker-compose.test.ts` guards the quoting. The corrected `compose.internal.yaml` has SHA-256 `99cd7096e6f893ad1bf46ff531aec395104ad0859fee78dd8cbcbde882cc62a6`; the other seven files are unchanged.

**State on the VPS now (stopped here):** source files, secret and rebuilt image in place; thirteen empty Docker networks (`iacquire-hermes-inference-*`); no worker or proxy container; no tunnel attachment; no Cloudflare route; Hermes profiles, gateway and tunnel untouched. The thirteen networks are harmless and are reused by the next `up` or removed by `down`.

**To continue (needs your confirmation, since the compose file differs from the one approved by hash):** fetch the corrected `compose.internal.yaml` from commit `f09227b5`, verify `99cd7096...`, then `up -d` and steps 4 to 8 as approved. Real container start is the first time this Compose file runs for real, so further surprises are possible; the same rule applies: stop at the first one.
