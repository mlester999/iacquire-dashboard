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
- Each prompt is capped at 6,144 UTF-8 bytes. The provider request sets `max_tokens=128`, disables
  reasoning, omits tool schemas, permits exactly one upstream request, and has a 25-second provider
  timeout. The runtime rejects responses reporting over 8,192 input or 128 output tokens. That
  input-token check is based on the provider's returned usage; the pre-request input bound is the
  6,144-byte context limit.
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
worker tests, and ends with a successful pinned-runtime synthetic smoke. That runtime smoke has not
yet run in this workspace because Docker/Podman is unavailable here.

Before any production change, perform read-only checks without printing file contents or secrets:

1. Verify the six existing profile directories and their exact role mapping. Confirm the configured
   provider is DeepSeek and the model is one of the supported IDs without emitting key material.
2. Confirm the existing profile files and the new HMAC file are readable by UID/GID `10000:10000`
   through read-only mounts. Do not broaden profile permissions globally; stop if this cannot be
   achieved with a narrowly scoped ACL or owner mapping.
3. Confirm free VPS memory and disk can accommodate six worker limits (3 GiB total), the proxy
   (64 MiB), and the image. These are caps, not reservations. Do not resize the VPS for this test.
4. Confirm the existing Tunnel type, current route order, Access service-token coverage, and
   `cloudflared` version. Test the six anchored routes and preserve the existing Hermes route.
   Do not edit or restart the existing gateway or change the VPS firewall.
5. Confirm the current Vercel deployment supports the route's declared 45-second maximum. Keep the
   flag off until the worker and route health checks pass.
6. Recheck the production code SHA and verify the internal profiles/configurations have not changed
   since their readiness attestations.

## Approval-gated deployment order

1. Deploy only the reviewed, focused application commit from the isolated branch through the
   existing Vercel release path, with the inference flag false and no new DeepSeek environment
   variable. Roll back to production SHA `d4adb4fd8759d1206ee981d408c185d351b24364` if deployment
   health checks fail.
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
6. Run one fixed provider-only request for each profile, then one fixed persisted Chat canary for
   each employee whose normal readiness check passes. Run sequentially. Verify provider/model,
   exact actual usage, zero tool schemas/calls and persisted message/run IDs. Turn the flag off as
   soon as verification finishes.

Each request is capped at 8,192 provider-reported input tokens and 128 output tokens. Twelve calls
(one provider-only plus one Chat call per employee) therefore have a hard reported-usage ceiling of
98,304 input and 1,536 output tokens. At DeepSeek's currently published peak rates, that is about
$0.032 if all profiles use Flash or $0.136 if all use Pro; actual model configuration and published
rates must be checked again immediately before approval. This excludes Vercel usage. No additional
paid hosting product is created.

## Rollback

1. Turn `HERMES_INFERENCE_WORKER_ENABLED` off first and verify the application rejects the canary.
2. Remove only the six inference path rules. Preserve the existing Hermes route and Access policy.
3. Disconnect the existing tunnel connector from the six private ingress networks.
4. Stop and remove only the six `iacquire-hermes-inference-worker-*` services and
   `iacquire-deepseek-egress-proxy` using this Compose file. Remove the new private networks only
   after confirming they have no remaining endpoints. Do not stop or reconfigure the Hermes gateway.
5. Remove the inference URL and HMAC environment value from Vercel. If the focused app deployment
   itself must be reverted, restore the recorded previous Vercel deployment at production SHA
   `d4adb4fd8759d1206ee981d408c185d351b24364`.
6. Delete the new HMAC file after the workers are stopped. The existing Hermes profile directories,
   keys, SOULs, tools and employee records are not changed by this worker.
