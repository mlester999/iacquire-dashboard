# Client-only Hermes runtime

This package builds an isolated Hermes runtime and the restricted worker from one immutable official Hermes image. It is staged for review only. The worker service is Compose-profile gated (`provisioner`) and iAcquireOS must remain `HERMES_PROVISIONER_ENABLED=false` until the runtime passes isolated acceptance and receives explicit production approval.

## Layout and trust boundaries

- `hermes_home` holds only the default runtime home and its gateway state.
- `client_profiles` holds only named client profiles at `/opt/data/profiles/<profile>`.
- `worker_home` is separate from the Hermes home. It holds the worker's recovery journal and audit log. The worker gets a secret-free `config.yaml` and the client-profile volume, but it does not mount the Hermes home or its `.env`.
- The Hermes API has no published host port. It is reachable by the worker over loopback and by the approved Cloudflare Tunnel only through `hermes_private`. The API listener uses its per-profile bearer key; the public application also uses its Cloudflare Access service token.
- The provisioner process runs as UID/GID 10000 with a read-only root filesystem, no Linux capabilities, no Docker socket, and only explicit config/secret mounts plus the dedicated named volumes. The official Hermes supervisor follows its root-started s6 entrypoint inside a standard non-privileged container; it has no host root, privileged mode, host PID/network mode, or host data directory.
- All direct messages, chat-platform adapters, and client communication credentials must remain disabled in this client runtime. Do not attach the agency data volume or any existing iAcquire profile.

The profile root and routing follow Hermes' documented layout: the default profile uses the Hermes home directly, named profiles live under `profiles/<name>`, and named API calls use `/p/<profile>/...` with that profile's own `API_SERVER_KEY`. Only the default profile starts the API listener; named profiles store their scoped keys but do not enable a second listener. The same gateway multiplexes profiles, but the portal still verifies each profile separately. See the [Hermes profile guide](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways) and [Docker guide](https://hermes-agent.nousresearch.com/docs/user-guide/docker).

## Image and compatibility gate

`HERMES_BASE_IMAGE` must be the exact official `nousresearch/hermes-agent` image with an immutable `@sha256:<64 hex>` digest. The Dockerfile rejects tags and other image repositories. Do not build or start the worker against Hermes v0.22.4: the [official v0.22.4 API server source](https://github.com/NousResearch/hermes-agent/blob/v0.22.4/gateway/platforms/api_server.py) registers `/v1/toolsets` but does not register `/v1/tools`. The upstream complete-inventory proposal remains [open as PR #92729](https://github.com/NousResearch/hermes-agent/pull/92729), so no compatible stable digest has been qualified.

Even after selecting a candidate digest, startup performs two authenticated, challenged reads of the default profile's full `/v1/tools?platform=api_server` catalog before the worker writes audit/heartbeat state or sends a portal claim. An absent endpoint, unsupported contract, unsafe tools, stale challenge, invalid HMAC, or changing catalog exits before any job is claimed. Each new or synchronized client profile is then checked again with its own key before a success callback.

## Private files

Keep all files outside the repository. On the Linux host, files supplied to the worker must be regular files owned by UID 10000 and mode `0400` or `0600`; do not put their contents in Compose environment values or logs.

1. Copy `client-config.yaml.example` to a private deployment path. Replace the model identifier with a reviewed value supported by the pinned Hermes build. Keep credentials out of YAML; the worker refuses secret-looking model fields. The same secret-free config is mounted into Hermes and the worker.
2. Create `hermes-api-key` as exactly 64 lowercase hexadecimal characters. This key is used only for the default profile's read-only startup inventory probe. The Hermes API wrapper reads it from a mounted file and keeps it out of Docker's declared environment.
3. Create `profile-model-env.json` with exactly `schemaVersion`, `environment`, and `value`, for example `{"schemaVersion":1,"environment":"OPENAI_API_KEY","value":"<secret>"}`. The environment name must be one of the explicit model-provider API-key names supported by the worker; bot, CRM, customer, messaging and Hermes API key names are rejected. The worker copies this one approved model-provider key into each client profile's private `.env`, because Hermes resolves provider keys from the owning profile rather than falling back to another profile. The value is never returned to iAcquireOS or written to audit logs.
4. Create `provisioner-token` with the same dedicated random token configured server-side as `HERMES_PROVISIONER_TOKEN`. Pin the matching `HERMES_PROVISIONER_GATEWAY_ID` on iAcquireOS and in the Compose env file. The token is bound to one gateway and is not a Docker or SSH credential.
5. Copy `client.env.example` to a private Compose env file and replace its placeholders. The production application also needs an approved exact HTTPS hostname in `INTEGRATION_ALLOWED_HOSTS`, a Cloudflare Access service-token credential in Vault, and a Cloudflare Tunnel route into the private network. Do not open port 8642 on the VPS firewall or publish it in Compose.

For example, an operator can create key files locally using a secret manager or an approved secure shell. Never enable shell tracing. Before using a profile-model secret, review which model provider's key format and environment name the selected Hermes version supports.

## Resource and health limits

The initial acceptance caps are 1 CPU and 2 GiB for Hermes and 0.5 CPU and 512 MiB for the worker; the API server is limited to one concurrent run. These caps are starting limits for the verified KVM 2 host, not a load-tested production capacity claim. The Hermes container health check reads `/health`; the worker health check requires a fresh private heartbeat. Both services rotate container logs. The JSONL worker audit remains mode `0600` on the persistent worker volume and fails closed if it cannot be written.

## Enablement sequence

1. Verify the Hostinger target, disk and memory headroom, the private network, Cloudflare Tunnel routing, and firewall egress rules. Allow outbound HTTPS only to the portal, approved model provider, and required Hermes web-search service. Do not mount `/docker/hermes-agent-wpwm/data`.
2. Obtain a compatible official Hermes digest and review its profile creation, storage, multiplexing, API authentication and reload behavior. The current v0.22.4 digest fails the complete-catalog gate.
3. Create and permission the private files above; check the Compose interpolation with the secret-free env file. Do not include the worker Compose profile yet.
4. Build and start only `hermes-client` in an isolated acceptance project. Verify the mounted `client_profiles` volume is separate and empty, no host port is published, an external probe cannot reach the API directly, and the private tunnel route authenticates through Cloudflare Access. The tunnel connector must join `hermes_private` and route the approved hostname to `http://hermes-client:8642`; do not publish or firewall-open port 8642.
5. In an isolated non-production iAcquireOS database, set up the approved gateway and test token; set the worker gateway ID, but keep the production provisioner switch off. Start the worker profile only for a fictional two-tenant test after isolated acceptance is explicitly authorized.
6. Verify both tenants' six role profiles, API identities and keys; prove cross-tenant access fails; run fresh-session SOUL canaries and a role smoke test; test sync, repeated claims, interrupted creation, audit recovery, and missing/expired integration behavior. Do not send real messages.
7. Reconcile migration 0084 against the live ledger and the release checklist. Apply it only after the separate production approval. Keep the production worker disabled until the final consolidated checkpoint is approved.

## Rollback

Keep the client-only volumes and last known image digest. Stop only the client Hermes and provisioner services; do not stop or recreate the agency Hermes app. Revert the portal application separately, leave the provisioner disabled, and retain the job/audit history. Do not delete `client_profiles` or `worker_home` while any client profile mapping or sync history exists. Restore a prior client-only image by digest only after confirming its on-disk config compatibility. Database rollback is governed by `supabase/rollbacks/0084_restricted_hermes_provisioner.down.sql` and must not discard sync history.

No service has been installed, no named volume has been created, no database has been migrated, and no profile has been created by this package work.
