# A1 preflight results and the A1 request

Date: 2026-10-29 (UTC 08:08 for the VPS run). Branch: `integration/hermes-bridge-final`. Sections 1 to 5 were read-only; nothing was installed, started, attached, routed, edited or called when they were written.

**Status (updated 2026-10-29 ~12:10 UTC): A1 is complete and verified (section 6.1). A2 was attempted and stopped at its first audit (section 7): the worker cannot run Hermes against a read-only profile. Everything is back to dormant.** Next gate: a worker fix (section 7.4), then A2 again; both need approval.

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

### 6.1 Continuation ("Continue A1", corrected Compose file)

| Step | Result |
| --- | --- |
| 3d. Corrected Compose | Fetched from `f09227b5`, `sha256sum` = `99cd7096...` OK. `docker compose up -d`: proxy Healthy, six workers Started. Seven containers, all `healthy` after about an hour |
| 4. Isolation checks | **PASS.** Names are `iacquire-hermes-inference-iacquire-hermes-inference-worker-<role>-1` (the Compose project prefix is added); the origin names in the routes use the service alias, which resolves (see below). No port is published on any container (`8786/tcp` and `3128/tcp` are only exposed). Each worker: user `10000:10000`, read-only root, `cap_drop ALL`, `pids 64`, exactly one profile mount (`rw=false`) plus the secret (`rw=false`). `/tmp` inside a worker: `rw,nosuid,nodev,noexec,size=32768k`, so the tmpfs fix works. Proxy `CONNECT example.com:443` from a worker: **`403 Forbidden`**. Direct connection from a worker to `example.com:443`: name resolution fails (internal networks). Network membership: each `<role>-ingress` holds only that worker; each `<role>-policy` holds that worker and the proxy; `deepseek-egress` holds only the proxy. Lead Hunter's worker resolves its own alias; it cannot resolve the Sales Assistant's or Zeng's |
| 5. Tunnel attachment | `docker network connect` of `iacquire-hermes-tunnel` to the six `-ingress` networks, all six succeeded. The tunnel is on `hermes-agent-wpwm_default` plus the six ingress networks and was not restarted (still "Up 10 days") |
| 6. Cloudflare routes | Six published-application routes added for `hermes-api.iacquire.online`, one per role, each with its anchored path `^/internal/inference/v1/<role>/infer$` and origin `http://iacquire-hermes-inference-worker-<role>:8786`; every value was read back from the form before saving. They were added below the gateway route first (so nothing changed while it was incomplete), then the gateway route was moved to the bottom. After a page reload the order is: 1 to 6 the six workers, 7 the gateway (`hermes-api.iacquire.online` to `http://hermes-agent:8642`, unchanged). The tunnel log shows the configuration updated twice (10:21:27 and 10:22:36 UTC) with no error lines in the last 30 minutes |
| 7. Unauthenticated route check | **PASS.** An unauthenticated `POST` to each of the six worker paths returned `403` from Cloudflare Access (HTML body with `Cf-Access-Aud` and `Cf-Access-Domain` headers), identical to the gateway root and `/health`. Nothing reached a worker or the gateway, and no credential was sent |
| 8. Baseline comparison | **PASS, nothing changed.** All six `SOUL.md` hashes, the shared `config.yaml` hash, and each `.env` size (521 bytes) and mtime match the baseline. The gateway answers `{"status":"ok","platform":"hermes-agent","version":"0.21.5"}`; the production app (`https://www.iacquire.online/api/health`) answers `{"status":"ok","database":"ok","scheduler":"never_ran"}` |

**A1 is complete.** Six isolated workers and one allow-list proxy run on the VPS, reachable only through Cloudflare Access paths and the tunnel. No inference worker has been called: no signed request was sent, no DeepSeek call was made, no Vercel setting was changed, and no profile, gateway or tunnel configuration was touched.

**Findings from this run**

- **O3 (new, low): each worker has a writable anonymous volume at `/opt/data`.** The Hermes base image declares `VOLUME /opt/data`, so Docker created one anonymous volume per worker (rw). It holds only the image's default home skeleton (20 files, 28,345 bytes, identical in all six, including a generic `SOUL.md`), and nothing in any of them is newer than the secret. The worker runs the model with `HERMES_HOME` set to its own read-only profile (`worker.py:325`), so the volume is not used for inference. It is private to one worker (no sharing), but it is writable storage outside the 32 MB tmpfs and survives container recreation. Proposed, not applied: mask it with a tmpfs at `/opt/data` in `compose.internal.yaml` (change, CI smoke and a restart of the workers, each needing approval). Until then the A2 audit can run as is.
- **Not proven yet:** that the tunnel container reaches a worker's port. The attachment and the alias resolution are verified separately, but the first end-to-end request (tunnel to worker, through Access with the service token) is the A2 audit. Cloudflare's confirmation after each route said "DNS record created" for `hermes-api.iacquire.online` pointing at the tunnel; that is the same name and target the gateway route already uses, but I did not read the DNS record before, so I cannot show it was unchanged. The hostname still resolves and is answered by Cloudflare Access.
- **Still open:** W2 (the Access service token does not expire), O1 (gateway host port 32771 is public, `ufw` inactive), O2 (workers mount whole profile directories, decision (d)), the prompt budget (section 2).

**Rollback if needed** (reverses A1 only, nothing else depends on it yet): delete the six worker routes in the Cloudflare tunnel (leave the gateway route), then on the VPS `docker network disconnect iacquire-hermes-inference-<role>-ingress iacquire-hermes-tunnel` for each role, then `docker compose -f compose.internal.yaml down`, then remove the secret file. The profiles, gateway and Vercel need no change.

## 7. A2 attempt (approved: "Approve A2", then "Approve rotation"; 2026-10-29 ~11:00-12:10 UTC)

**Outcome: stopped at the first audit, on a surprise; production returned to dormant.** No DeepSeek call was made, and none was possible by design: the audit child gets no key and no proxy setting, the worker networks are internal, and the only provider is a loopback synthetic listener. The egress proxy keeps no connection log (it logged nothing, not even the denied test from A1), so this rests on that design, not on a log.

### 7.1 What was done, in order

1. **Secret.** The approved "pipe the A1 secret from the VPS to Vercel" was not possible from this PC: there is no SSH identity, the Hostinger console ignores clipboard writes (OSC 52), the page blocks `navigator.clipboard.readText`, and a synthetic Ctrl+V does not paste. With the founder's approval ("Approve rotation") a fresh 64-hex secret was generated locally and never displayed. It went to Vercel as a sensitive variable and to the clipboard (excluded from clipboard history and cloud sync). The founder pasted it into a no-echo prompt in the VPS console, which wrote `/etc/iacquire-hermes-inference/inference_hmac` in place only if the input was exactly 64 hex characters. Result: mode 400, owner 10000:10000, 65 bytes. The clipboard was cleared afterwards. The A1 secret is retired.
2. **Vercel.** `HERMES_INFERENCE_WORKER_URL` = `https://hermes-api.iacquire.online/internal/inference/v1` and `HERMES_INFERENCE_WORKER_SECRET` were added to Production. Later `HERMES_PROMPT_AUDIT_ENABLED=true` was added and the current production deployment (`38oremflx`, `bd843d27`) was rebuilt with `vercel redeploy` (same source, new environment): `jv6amn3fo`, Ready in 5 minutes, `/api/health` ok.
3. **Workers.** `IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED=true` was set and the six workers were recreated. A `--dry-run` came first and showed exactly six workers recreating and no network, volume or image change; the proxy was untouched. After the update: all healthy, flag true, no published ports, one profile mount each, tunnel still attached to the six ingress networks.
4. **First audit** (Operations Manager, from the signed-in Super Admin session): HTTP 502 "could not complete its identity checks" after 2.2 s. The worker log shows `prompt_audit_result ... "status":"inference_failed"`.

### 7.2 What the failure already proves

The signed path works end to end: Vercel, Cloudflare Access (service token), tunnel, worker port, HMAC signature accepted, role allowed, child process started. This closes the "tunnel to worker not proven" item from section 6.1 for the signed path. No tunnel errors were logged.

### 7.3 Cause

Reproduced inside the worker container with synthetic text and no network: `OSError [Errno 30] Read-only file system: '/profiles/iacquire-operations-manager/logs/agent.log'`. Hermes v0.22.5 opens `logs/agent.log` and creates its skeleton directories under `HERMES_HOME`. The worker points `HERMES_HOME` at the read-only profile mount (A1 decision d), so **every audit and every inference would fail the same way for all six roles**. CI did not catch it because the synthetic profile it uses is writable. The runner deliberately discards child errors (it returns only `{"ok": false}`), so the only visible signal was the generic code.

### 7.4 Fix direction, verified with synthetic data only

With `HERMES_HOME` set to a throwaway directory in the container's `/tmp` holding only copies of `SOUL.md` and `config.yaml`, the same audit returned: `ok`, Hermes 0.22.5, `soulBytes` 2,291, `providerOnlyMessageBytes` 3,570, `chatMessageBytes` 3,566, 2 synthetic requests, 0 tool schemas, 0 tool calls. Hermes created 11 skeleton directories beside the two copied files (`audio_cache`, `backups`, `cache`, `cron`, `hooks`, `image_cache`, `logs`, `memories`, `pairing`, `sessions`, `skills`), all in tmpfs. This design also fixes O2 for the audit: no `.env`, `state.db` or session history is mounted into or readable by the child. Inference (A3) additionally needs the DeepSeek key; it should be supplied as a minimal `.env` containing only that one variable, built per request, never the whole profile file.

Needed change (not started): build the throwaway home in `run_pinned_hermes` (worker.py) and remove it afterwards; unit tests; make the CI smoke mount a profile read-only so this class of failure is caught; new image tag; roll-out to the VPS (rebuild, recreate) as its own approved step; then re-run A2.

### 7.5 Budget implication (provisional, not the real audit)

The synthetic provider message was 3,570 bytes with a 34-byte instruction and a 24-byte input, so the fixed overhead per call is about 3.5 KB (the 2,291-byte SOUL plus about 1.2 KB of Hermes framing). The real instruction text is 5.6 to 10.9 KB. If that holds, **every role exceeds 6,144 bytes, not only Lead Hunter**, so decision D2 concerns all six. Only the real audit can confirm this; the worker accepts over-limit instructions in audit mode for measurement.

### 7.6 End state (verified)

- Vercel Production: `HERMES_PROMPT_AUDIT_ENABLED` removed and the site redeployed; `HERMES_INFERENCE_WORKER_URL` and the sensitive `HERMES_INFERENCE_WORKER_SECRET` remain (inert while both flags are off). `HERMES_INFERENCE_WORKER_ENABLED` was never set.
- VPS: six workers recreated with the audit flag false (all healthy, no published ports, tunnel attached to six ingress networks); the secret file holds the new secret; the throwaway test directory was removed.
- Unchanged: all profile files (Operations Manager `SOUL.md` prefix `1e02f4c8226b` and `.env` mtime `1792203915` match the baseline), the gateway, the tunnel configuration, the Cloudflare routes and Access policy.
- Rollback of A2 only: remove the two Vercel variables and redeploy; the worker secret file can stay (it is only read by the workers).

## 8. Fix roll-out and A2 re-run (approved: "Approve rollout"; 2026-10-30)

**Outcome: the audit now works for all six roles, and all six are over the 6,144-byte budget.** Every request returned HTTP 200 with `deepseekCalls` 0, `toolSchemas` 0, `toolCalls` 0 and 2 synthetic provider requests (loopback listener only; the audit child has no key and no proxy).

### 8.1 The fix (review branch `integration/hermes-bridge-final`, head `41b0580a`, CI green on both jobs)

- **Cause 1 (section 7.3):** Hermes writes under `HERMES_HOME`, which pointed at the read-only profile mount. The worker now builds a per-request throwaway home in `/tmp` holding copies of `SOUL.md` and `config.yaml` (mode 0600, removed in `finally`); inference adds a `.env` limited to the two DeepSeek settings.
- **Cause 2 (found by CI diagnostics, not by the first audit):** `inference_runner.py` never imported `Path`, so `main()` raised `NameError` and every real request ended as `inference_failed`. No test or smoke had ever executed `main()`. It now imports `Path`, and the in-image tests execute `main()` and reject any undefined global in any module.
- Image tag moved to `0.22.5-v2` so it cannot be confused with the running v1.

### 8.2 Roll-out on the VPS

1. The nine service files were fetched from the commit into `/root/v2-stage`, every sha256 matched the hashes computed from the commit, the v1 files were backed up to `/root/v1-backup-0.22.5`, and the v2 files were installed and re-verified in place.
2. Image `iacquire/hermes-inference-worker:0.22.5-v2` = `d22cf79d90c9` was built (the v1 image `4ee41de3b352` is kept for rollback). In-image unit tests: 23 OK with `--network none`.
3. A `--dry-run` showed that a plain `up` would also recreate the egress proxy (its image tag changed). Only the six workers were approved, so they were recreated with `up -d --no-build --no-deps <six services>`; **the proxy was not touched and still runs the v1 image** (`deepseek_egress_proxy.py` is byte-identical in both). The compose file names v2 for it, so the next plain `up` will recreate it on v2.
4. Verified after the roll-out: six workers healthy on v2; read-only root; no published ports; user 10000; all capabilities dropped; profile mount and secret mount read-only; `/tmp` is a 32 MB `nosuid,nodev,noexec` tmpfs; the proxy answered `403 Forbidden` to `CONNECT example.com:443`; unauthenticated calls to the public worker routes return 403; the tunnel stayed attached to all six ingress networks (the networks persist when only the workers are recreated, so no re-attach was needed).
5. `/opt/data` is still a writable volume on each worker (open item O3).

### 8.3 The six measurements (real instructions, pinned Hermes 0.22.5, limit 6,144 bytes)

| Role | App instruction | SOUL | Provider-only message | Chat message | Chat over limit by | App instruction that would fit |
|---|---:|---:|---:|---:|---:|---:|
| Operations Manager | 11,037 | 2,291 | 14,785 | 14,822 | 8,678 | about 2,360 |
| Lead Hunter | 14,091 | 2,404 | 17,873 | 17,910 | 11,766 | about 2,330 |
| Sales Assistant | 8,638 | 2,346 | 12,362 | 12,399 | 6,255 | about 2,380 |
| CRM Manager | 8,349 | 2,323 | 12,129 | 12,166 | 6,022 | about 2,410 |
| Appointment Setter | 8,518 | 2,361 | 12,257 | 12,294 | 6,150 | about 2,370 |
| Performance Analyst | 8,281 | 2,349 | 12,008 | 12,045 | 5,901 | about 2,380 |

What this means for decision D2: the fixed part of every call is the SOUL (about 2.3 KB) plus about 1.4 KB of Hermes framing (the chat call adds 37 bytes more). That leaves about 2.4 KB of the 6,144 for the app's business instructions, against 8.3 to 14.1 KB today. Fitting the current budget would mean cutting each role's instructions by about 71% to 84%, which conflicts with "no silent truncation of security rules or business knowledge". The alternative is a larger, deliberately chosen budget. Both are the founder's call (D2); nothing was truncated or changed.

### 8.4 End state (verified 2026-10-30)

- Vercel Production: `HERMES_PROMPT_AUDIT_ENABLED` removed again and the site redeployed (`m613jymv7`, Ready in 5 minutes, aliased to `www.iacquire.online`). `/api/health` answers `{"status":"ok","database":"ok","scheduler":"never_ran"}`. From the signed-in Super Admin session, `POST /api/internal/hermes-inference/prompt-audit` answers 503 "The no-call prompt audit is disabled." and `.../canary` answers 503 "Restricted Hermes inference is not enabled." `HERMES_INFERENCE_WORKER_URL` and the sensitive `HERMES_INFERENCE_WORKER_SECRET` remain (inert while the flags are off). `HERMES_INFERENCE_WORKER_ENABLED` was never set.
- VPS: six workers healthy on `0.22.5-v2` with `IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED` false; proxy untouched on the v1 image; tunnel attached to six ingress networks (runtime attachment, not durable if the tunnel container is recreated); `/root/v2-stage` and `/root/v1-backup-0.22.5` left in place (repository files only, no secrets).
- Unchanged: all profile files, the gateway, the Cloudflare routes and the Access policy. No DeepSeek call was made at any point.
- Rollback of this roll-out only: restore the v1 files from `/root/v1-backup-0.22.5` and recreate the six workers on the v1 image (kept locally); not recommended, because v1 cannot run any audit or inference.

### 8.5 What is still open

D2 (prompt budget, all six roles), A3 (real-model canaries) and A4 (business-tool acceptance) each need their own approval. Also open: W2 (non-expiring Access token), O1 (gateway port 32771 public), O2 (whole profile directories mount), O3 (writable `/opt/data` volume), the proxy still on the v1 image, and the review branch changes (including this section) not yet merged to master.
