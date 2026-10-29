# Restricted Hermes inference worker

This package is a temporary, inference-only path for six existing internal AI Employees. It does
not call the normal Hermes run API, run employee tools, activate schedules, or perform business
actions. The code is disabled in the application until `HERMES_INFERENCE_WORKER_ENABLED=true`.

## Isolation and request limits

- Build from the Hermes image pinned by digest in `Dockerfile`. The image build runs the Python
  unit suite and `pinned_runtime_smoke.py`; that smoke uses a synthetic local API endpoint and
  the real pinned Hermes `AIAgent`, not a DeepSeek credential or external request.
- Run six worker containers from the same image. Each container has one fixed role, one read-only
  Hermes profile mount, and one exact role path. No worker can read another employee's profile.
- The workers have no published host ports. Each has only its own internal ingress network and
  internal policy network. The existing `cloudflared` connector is attached to the six ingress
  networks only. The DeepSeek proxy is the only container with an external egress network.
- The proxy allows `CONNECT api.deepseek.com:443` only and rejects non-public resolved addresses.
  No VPS firewall rule changes are part of this design.
- Requests require a timestamped HMAC signature, expire after 30 seconds, reject replayed request
  IDs, and are limited to six requests per actor per minute, two per actor/profile per minute,
  and one active call per profile.
- The combined text content of all effective provider messages is capped at 6,144 UTF-8 bytes
  before the provider call. The request sets `max_tokens=128`, disables reasoning, omits tool
  schemas, permits exactly one upstream request, and has a 25-second provider timeout. The runtime
  rejects responses reporting over 6,144 input or 128 output tokens. The input-token check uses
  provider-reported usage after the call; the pre-request bound is the 6,144-byte limit on the
  complete message content, including profile instructions.
- Worker and app requests time out at 32 and 36 seconds respectively. Chat and provider-only routes
  declare a 45-second maximum. Logs contain request/actor/role IDs, model and token counts only;
  prompt, SOUL, model response, API key and HMAC secret are not logged.

## Fixed role routing

Use the existing Hermes gateway hostname and preserve its current catch-all route. Add these exact
path rules before the existing catch-all. The path expressions use Cloudflare Tunnel's Go regular
expression syntax and are anchored so a similar path cannot match. The existing Cloudflare Access
service-token policy must protect all six paths.

| Path | Private origin |
| --- | --- |
| `^/internal/inference/v1/operations_manager/infer$` | `http://iacquire-hermes-inference-worker-operations-manager:8786` |
| `^/internal/inference/v1/lead_hunter/infer$` | `http://iacquire-hermes-inference-worker-lead-hunter:8786` |
| `^/internal/inference/v1/appointment_setter/infer$` | `http://iacquire-hermes-inference-worker-appointment-setter:8786` |
| `^/internal/inference/v1/sales_assistant/infer$` | `http://iacquire-hermes-inference-worker-sales-assistant:8786` |
| `^/internal/inference/v1/crm_manager/infer$` | `http://iacquire-hermes-inference-worker-crm-manager:8786` |
| `^/internal/inference/v1/performance_analyst/infer$` | `http://iacquire-hermes-inference-worker-performance-analyst:8786` |

The single server-only application setting is the URL prefix, not a role URL:
`HERMES_INFERENCE_WORKER_URL=https://<existing-Hermes-host>/internal/inference/v1`.
The application appends the role path itself and verifies that the hostname matches the employee's
existing Hermes connection. The application also needs `HERMES_INFERENCE_WORKER_SECRET` and the
feature flag. The DeepSeek API key stays in the matching read-only VPS profile; it is never copied
to Vercel.

## Build and pre-deployment checks

Run the following on a Docker-capable non-production runner. It does not require the VPS profile
path or any secret and does not call DeepSeek:

```powershell
docker build --pull -f services/hermes-inference-worker/Dockerfile -t iacquire/hermes-inference-worker:0.22.5-v1 .
```

Do not proceed to deployment unless the build reports the pinned Hermes version, passes all
worker tests, and ends with a successful pinned-runtime synthetic smoke. The reconciled candidate
passed GitHub Actions run #9 (`40783282406`) at
`9744ca778dfd1d74e36602243088fc92925c810b` on a temporary Ubuntu 24.04 Docker runner:
<https://github.com/mlester999/iacquire-dashboard/actions/runs/40783282406>. It built the pinned
v0.22.5 image; the real pinned Hermes `AIAgent` smoke used a synthetic local provider under
`--network none`, `--read-only`, and UID/GID `10000:10000`; all 10 worker policy/failure tests
passed; and Compose validation confirmed six one-profile workers, no published ports, and external
egress only on the proxy. The smoke reported one provider request, zero tool schemas, zero tool
dispatches, and a 128-token output cap. No real DeepSeek call, production credential, employee
profile, or published image artifact was used. Docker remains unavailable in the local Windows
workspace.

Before any production change, perform read-only checks without printing file contents or secrets:

1. Verify the six existing profile directories and their exact role mapping. Confirm the configured
   provider is DeepSeek and the model is one of the supported IDs without emitting key material.
2. Confirm the six existing profile files are readable by UID/GID `10000:10000` through their
   individual read-only mounts. This was checked for the existing files; the running worker mounts
   still require deployment-time verification. The HMAC secret does not exist yet: create it only
   during approved worker deployment, then verify that its read-only secret mount is readable by
   UID/GID `10000:10000` without printing its value. Do not broaden profile permissions globally;
   stop if this cannot be achieved with a narrowly scoped ACL or owner mapping.
3. Confirm free VPS memory and disk can accommodate six worker limits (3 GiB total), the proxy
   (64 MiB), and the image. These are caps, not reservations. Do not resize the VPS for this test.
4. Confirm the existing Tunnel type, current route order, Access service-token coverage, and
   `cloudflared` version. Test the six anchored routes and preserve the existing Hermes route.
   Do not edit or restart the existing gateway or change the VPS firewall.
5. Confirm the current Vercel deployment supports the route's declared 45-second maximum. Keep the
   flag off until the worker and route health checks pass.
6. Recheck the production code SHA and verify the internal profiles/configurations have not changed
   since their readiness attestations.

Read-only preflight snapshot taken on 2026-10-29:

- Production deployment `8KUKY1cDUB5mcqNQzCEGbmtrHLDj` is Ready from `master` SHA
  `5171595a0597cf5dab38ae5cc0174b35dd3d141f`. This is the rollback target for this release; do not
  use the older `a870841` deployment.
- The Vercel project is on Hobby with Fluid Compute enabled. Both restricted routes declare
  `maxDuration = 45`; Vercel's current Hobby Fluid Compute maximum is 300 seconds, so the declared
  limit fits. The Production environment search returned no `HERMES_INFERENCE_WORKER` variables.
- The production VPS runs Hermes Agent v0.21.5 and cloudflared 2026.10.1. Its six profile directories
  map to the six application roles. All six resolve to DeepSeek with the existing `deepseek-flash`
  model; Hermes reports provider credentials configured and logged in for each profile. Only
  provider/model identifiers and boolean credential statuses were inspected; no key or profile
  contents were printed.
- At the time of inspection, the VPS had 6.1 GiB available memory and 88 GiB free disk. The worker
  Compose limits total 3 GiB for six workers plus 64 MiB for the proxy; these are caps, not reserved
  memory. No worker or proxy containers are running.
- The existing tunnel is token-managed and has no local configuration mount. The Cloudflare
  dashboard required a separate sign-in, so current route order and Access service-token coverage
  could not be independently verified. Do not add routes until those existing protections are
  inspected in the authenticated Cloudflare account. The worker HMAC secret does not exist yet; its
  required signature, replay window and failure behavior are covered by code and synthetic CI, not
  by a live request.
- The isolated worker uses Hermes v0.22.5 in its own container and does not call the running v0.21.5
  gateway API. The v0.21.5 Python package lacks one helper used by v0.22.5, so the two Python
  runtimes must not be mixed. The separate-container design preserves the existing gateway; validate
  each read-only profile using the pinned worker at deployment time before enabling a canary.

## Approval-gated deployment order

1. Deploy only the reviewed focused app diff from the reconciled isolated branch through the existing
   Vercel release path, with `HERMES_INFERENCE_WORKER_ENABLED=false`,
   `HERMES_BUSINESS_MCP_ENABLED=false`, `HERMES_BUSINESS_MCP_WRITES_ENABLED=false`, and no worker
   URL, HMAC secret, or DeepSeek credential in Vercel. Recheck Production is still at
   `8KUKY1cDUB5mcqNQzCEGbmtrHLDj` / `5171595a0597cf5dab38ae5cc0174b35dd3d141f` immediately
   before release; if it has changed, stop and re-review the rollback target.
2. Build the pinned image on the existing VPS only after its non-production image smoke passes.
   Create one private HMAC secret for the app-to-worker call and install it with mode `0400`, owned
   so UID/GID `10000:10000` can read it. Do not display it in command output or shell history.
3. Start the six worker services and the proxy with the exact six read-only profile mounts. Check
   service health, confirm no host port is published, verify that each container sees only its one
   profile mount, and test that unrelated CONNECT destinations are denied.
4. Attach the existing tunnel connector to the six private ingress networks and add only the six
   anchored path routes under the existing Access policy. Validate route matching before applying.
   If the current Tunnel setup cannot do this without changing the existing Hermes route or causing
   a gateway outage, stop and return with that exact dependency.
5. Set the URL prefix and HMAC secret in Vercel while keeping the flag false. Verify unauthenticated,
   non-Super-Admin, wrong-role, replayed and oversized requests are denied. Then enable the flag for
   the approved canary window.
6. After explicit canary approval and all route/auth checks, run up to one fixed provider-only
   request per profile, followed by one fixed no-tool Chat canary per employee through the normal
   authenticated Chat view. Run sequentially. Verify provider/model,
   actual usage, zero tool schemas/calls, and persisted message/run IDs for the Chat canary. Turn
   the inference flag off when this acceptance pass ends.
7. Only after the no-tool Chat pass, verify one role-authorized business read per employee through
   the application MCP bridge. Keep HERMES_BUSINESS_MCP_WRITES_ENABLED=false, use internal agency
   data only, and do not allow schedules, outreach, bookings, CRM edits, or other writes. Before
   adding the MCP entry to the six existing profile configs, record each original file hash and
   prepare/review each complete diff and restore copy; preserve every unrelated setting. The bridge
   remains off until HERMES_BUSINESS_MCP_ENABLED is explicitly enabled.

Each request rejects combined effective message text above 6,144 UTF-8 bytes before the provider
call, requests at most 128 output tokens, and rejects any response reporting over 6,144 input
tokens. Across twelve approved calls, the requested output cap totals 1,536 tokens. The input-token
ceiling is validated against provider-reported usage after the call, so it is not a strict
pre-call token or dollar cap; the complete-message byte limit is the pre-call bound. Report actual
token usage for every response. Recheck the six configured models and current DeepSeek pricing
immediately before approval. No real provider request has been made. This worker adds no paid
hosting product and does not publish an image to a registry.

## Rollback

1. Turn `HERMES_INFERENCE_WORKER_ENABLED` off first and verify the application rejects the canary.
2. Remove only the six inference path rules. Preserve the existing Hermes route and Access policy.
3. Disconnect the existing tunnel connector from the six private ingress networks.
4. Stop and remove only the six `iacquire-hermes-inference-worker-*` services and
   `iacquire-deepseek-egress-proxy` using this Compose file. Remove the new private networks only
   after confirming they have no remaining endpoints. Do not stop or reconfigure the Hermes gateway.
5. Remove the inference URL and HMAC environment value from Vercel. If the focused app deployment
   itself must be reverted, restore the Vercel Production deployment recorded immediately before
   release: deployment `8KUKY1cDUB5mcqNQzCEGbmtrHLDj` at commit
   `5171595a0597cf5dab38ae5cc0174b35dd3d141f`, after confirming it is still the latest known
   healthy Production deployment.
6. Delete the new HMAC file after the workers are stopped. The existing Hermes profile directories,
   keys, SOULs, tools and employee records are not changed by this worker.
