# A1 preflight: read-only checks before the Hermes inference worker is installed

Date: 2026-10-29. Branch: `integration/hermes-bridge-final`. Production: `master` `836ab4cb`, every Hermes flag off.

This document is the checklist and the exact commands for the A1 inspections. **Nothing here changes the VPS, Cloudflare, the Vercel environment or any Hermes profile.** It is a read-only look so that A1 (the controlled worker installation with inference disabled) can be approved against measured facts instead of the 2026-10-29 snapshot in `services/hermes-inference-worker/DEPLOYMENT.md`.

Two scripts do the reading. Both were exercised here against fake data, with planted secrets, and neither printed them:

| Script | Runs where | Needs | Reads |
| --- | --- | --- | --- |
| `scripts/hermes-a1-preflight.sh` | the VPS, streamed over SSH so no file is written there | root or passwordless sudo | host capacity, Docker, the six profile directories, the existing gateway and tunnel containers |
| `scripts/hermes-a1-cloudflare-readonly.mjs` | your own machine (Node 18 or later) | a read-only Cloudflare API token | the tunnel's published routes in order, connector versions, Access applications and policies covering the Hermes host, service-token names and expiry |

`tests/hermes-a1-preflight.test.ts` keeps both honest: no mutating command, one `fetch` that only does `GET`, no secret in the output of a run against a fake profile tree and a fake tunnel container, and the same role, profile, model and image pins as the worker.

## 1. What each part can and cannot see

- The VPS script prints provider and model identifiers, file modes and owners, SHA-256 of `SOUL.md` and `config.yaml`, and yes/no for "the DeepSeek key is present and long enough". It never prints a key, an env value, the tunnel token, or file contents. Hash lines are a baseline: recompute them after A1 to prove the profiles were not touched.
- The tunnel container is only asked for its state, image, networks and mounts. Whether it is token-managed is answered by a `grep -q`, so the token is never in the output. `cloudflared --version` inside the container runs only if you set `PREFLIGHT_ALLOW_EXEC=1`.
- The Cloudflare script reads routes, not secrets. The API token is only sent as a header and is never printed.
- Neither script can prove that an unauthenticated request to a worker path is refused. That needs a real request and happens at A1.

## 2. Run the VPS check

From Git Bash on your machine, in the repository root. The `tr` strips Windows line endings; `bash -s` reads the script from stdin, so nothing is stored on the VPS:

```text
tr -d '\r' < scripts/hermes-a1-preflight.sh | ssh root@<vps> 'bash -s' | tee a1-preflight-vps.txt
```

With a non-root login that has passwordless sudo, use `'sudo bash -s'`. Settings you may need to override (prefix the remote command, for example `'HERMES_GATEWAY_CONTAINER=name bash -s'`): `HERMES_GATEWAY_CONTAINER` (default `hermes-agent-wpwm-hermes-agent-1`), `HERMES_TUNNEL_CONTAINER` (default `iacquire-hermes-tunnel`), `HERMES_DATA_DIR` (default: read from the gateway's `/opt/data` mount, then `/docker/hermes-agent-wpwm/data`), `IACQUIRE_INFERENCE_ROOT` and `IACQUIRE_INFERENCE_HMAC_FILE` (only for the "does it exist yet" checks), `PREFLIGHT_OFFLINE=1` (skip the clock, DNS and registry lookups).

It makes three outbound read lookups: a `HEAD` to `https://www.cloudflare.com` to measure clock skew, a DNS lookup of `api.deepseek.com` (no connection is opened), and `docker manifest inspect` of the pinned base-image digest. No DeepSeek request is made and nothing is pulled.

The exit code is 0 only when there are no `[FAIL]` lines. `[WARN]` means "look at it", not "stop".

## 3. Run the Cloudflare check

Create a short-lived API token in the Cloudflare dashboard (My Profile, API Tokens, Create Custom Token) with three read permissions on the one account: Cloudflare Tunnel Read, Access: Apps and Policies Read, Access: Service Tokens Read. Set an expiry of a day. Read it into your shell without echo so it stays out of history, then delete the token in the dashboard when done:

```text
read -rs CF_API_TOKEN; export CF_API_TOKEN CF_ACCOUNT_ID=<32-character account id> HERMES_HOST=<hermes hostname, for example hermes.example.com>
```

```text
node scripts/hermes-a1-cloudflare-readonly.mjs | tee a1-preflight-cloudflare.txt
```

Add `CF_TUNNEL_ID=<id>` if the account has more than one active tunnel (the script lists them). Do not paste the token into chat. If you prefer not to create a token, the dashboard path gives the same answers: Zero Trust, Networks, Tunnels, the tunnel, Published application routes (note the order and the Hermes catch-all); Access controls, Applications (the Hermes application, its policies, which service token each names); Access controls, Service credentials (token names and expiry).

## 4. Vercel, names only

Run from the repository root with the Vercel CLI signed in. It lists variable names and environments, not values (values show as encrypted). Expect no `HERMES_INFERENCE_*`, `HERMES_PROMPT_AUDIT_*` or `HERMES_BUSINESS_MCP_*` variable to exist yet:

```text
vercel env ls production | grep -iE 'HERMES_(INFERENCE|PROMPT_AUDIT|BUSINESS_MCP)' || echo "none set"
```

Production code identity (read-only):

```text
git ls-remote origin refs/heads/master
```

Expect `836ab4cb` unless something deployed since. `https://iacquire.online/api/health` should report `ok`.

## 5. Pass and stop criteria

| # | Check | Expected | If not |
| --- | --- | --- | --- |
| 1 | Clock skew against an external reference | 5 s or less (requests expire after 30 s) | Stop. Fix NTP first |
| 2 | Memory available | 4096 MiB or more (caps total 3136 MiB) | Below 3200 MiB: stop. Between: your call |
| 3 | Disk free where Docker lives | 15 GiB or more | Below 8 GiB: stop |
| 4 | Docker and Compose v2 present, no user-namespace remapping, no cgroup warnings | all true | Remapping on: stop (UID 10000 would not map). Warnings: memory and pids limits may not apply |
| 5 | No worker, proxy, network or image of ours exists | none | Stop and explain what is there |
| 6 | Gateway and tunnel containers running | both | Stop. Do not proceed on a degraded gateway |
| 7 | Tunnel is token-managed and its routes are readable remotely | yes | If locally managed, routes are edited on the VPS instead; revisit the plan |
| 8 | Six profile directories exist, no symlinks, each readable and enterable by UID/GID 10000 | all six | Fix ownership narrowly per profile; never loosen globally |
| 9 | Each `SOUL.md` is a regular file of 1 to 16384 bytes, readable | all six | The worker refuses it |
| 10 | Each `config.yaml` has a `model:` block, provider `deepseek`, `auto` or unset, model `deepseek-flash` or `deepseek-v4-pro` | all six | The worker refuses it (`configured_provider_mismatch` or `configured_model_invalid`) |
| 11 | Each profile has its own `.env` with a DeepSeek key of 12 or more characters, no `DEEPSEEK_BASE_URL` override | all six | The worker has no other credential source and refuses (`deepseek_credential_unavailable`). A key held only in the shared data-directory `.env` or in the gateway's environment does not reach the worker |
| 12 | `api.deepseek.com` resolves to public addresses only | yes | The egress proxy would reject private ones |
| 13 | Pinned base digest resolves in the registry for the host's architecture | yes | Pull would fail |
| 14 | Cloudflare: Hermes catch-all found, no `internal/inference` rule yet, worker rules can sit above it, all six planned paths isolate and 30 near-miss paths stay on the gateway | all true | Stop and show the route list |
| 15 | Cloudflare: an Access application covers the worker paths; its policies accept only a service token; no bypass, everyone, email or any-valid-token rule | yes | Stop. The worker routes would be reachable without the intended protection |
| 16 | Vercel: no `HERMES_INFERENCE_*`, `HERMES_PROMPT_AUDIT_*` or `HERMES_BUSINESS_MCP_*` variable | none | Stop and list them |
| 17 | Production is still `836ab4cb` and healthy | yes | Re-review the rollback target |

## 6. Results to send back

Paste or attach `a1-preflight-vps.txt` and `a1-preflight-cloudflare.txt` (they contain hostnames, paths, hashes and counts, no secrets; read them once before sending), plus the output of the two Vercel commands. Redact the account id if you prefer. I will then fill in this table and prepare the A1 approval request.

## 7. What A1 would do (preview only, not approved)

For orientation, so the size of the later request is visible. Each step is reversible by the rollback in `services/hermes-inference-worker/DEPLOYMENT.md`.

1. Create `/docker/iacquire-hermes-inference/` and copy the worker files (Dockerfile, Compose file, six Python files) from the reviewed commit.
2. Create one random HMAC secret outside the Hermes data directory and outside the build context (default `/etc/iacquire-hermes-inference/inference_hmac`, mode 0400, owner 10000:10000). The scripts flag a location inside either.
3. Build the pinned image and start six workers and the proxy with inference still off in the application. Verify health, one profile mount each, no published port, and that an unrelated `CONNECT` is refused.
4. Attach the tunnel container to the six private ingress networks and add six path routes above the Hermes catch-all under the existing Access policy.
5. Prove the paths refuse unauthenticated and unsigned requests.

Findings from preparing this that need a decision before A1:

- **Tunnel attachment is not durable.** `docker network connect` is lost if the tunnel container is recreated. For the first window that is acceptable (it fails closed: the routes would stop working, not open up). Making it permanent means editing how the tunnel container is declared, which is a second change to a live component.
- **Route proof needs a service token.** Step 5 needs a Cloudflare Access service token. The existing one is stored only as a Vercel secret, which this work does not read. The cleaner option is a temporary token created for the test and removed afterwards.
- **Credentials in the profiles.** Check 11 is the likeliest to surprise: the worker mounts one profile read-only and reads that profile's own `.env`. If the DeepSeek key currently reaches Hermes some other way, A1 would have to add it to six profile files, which is a live profile change and needs its own approval.

## 8. Last known facts (2026-10-29 snapshot, must be re-measured)

Hermes Agent v0.21.5 on the gateway; cloudflared 2026.10.1; about 6.1 GiB available memory and 88 GiB free disk; six profiles resolving to DeepSeek `deepseek-flash`; token-managed tunnel with no local configuration; no worker or proxy containers; Vercel Production env had no `HERMES_INFERENCE_WORKER` variable. The pinned worker uses Hermes v0.22.5 in separate containers and never shares a runtime with the v0.21.5 gateway.
