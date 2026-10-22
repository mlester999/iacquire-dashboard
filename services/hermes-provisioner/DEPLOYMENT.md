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

The isolated acceptance image is pinned to the official Hermes v0.22.3 multi-platform OCI index sha256:2f305c9bdc81731f48664586d23cb6a6f838a15ad7be1bfabe0c3c269d8e09b9, from source commit 5b147ab036d6d19131bff8d20701b5001eab844a. The upstream v0.22.3 API server does not register /v1/tools; catalog-overlay-v0223 adds the narrow authenticated route using the current Hermes model-tool resolver. Its UPSTREAM_SHA256SUMS verifies the pristine source files and SHA256SUMS pins the patch. The Docker build checks the version, both checksum sets, Python compilation, and imports. The base image has not been built in this workspace because no Linux container builder is available.

The currently running production container is still Hermes v0.21.5. Its installed api_server.py, model_tools.py, and catalog helper SHA-256 values match the existing reviewed v0.21.5 overlay in this repository. This proves source parity only; no live API key was read and no authenticated inventory request was made. The v0.22.3 overlay remains an isolated acceptance candidate and is not a production upgrade authorization.

## Read-only Hostinger inspection (2026-10-22)

- The dashboard and host console identified the target as srv2039372, Hostinger plan KVM 2. The host reports 2 CPU cores, 7.8 GiB RAM (6.4 GiB available at inspection), no swap, and a 96 GiB filesystem with 7.9 GiB used and 88 GiB available. Dashboard usage was 2% CPU, 16% memory, and 8 GB of 100 GB disk.
- Hermes container 008d77b9fd0a (hermes-agent-wpwm-hermes-agent-1) was running for three days. At inspection it used 1.45% CPU and 835 MiB RAM, with 70 processes. Docker reports no memory, CPU, or process-count limit. It runs as container root and mounts /docker/hermes-agent-wpwm/data read/write at /opt/data.
- hermes profile list showed the default profile plus the six existing internal iAcquire profiles. Named profile directories are under /opt/data/profiles; no client profiles were created or changed. hermes profile create --help confirms native creation support and exposes cloning flags; the provisioner must continue using only blank-profile options.
- The installed gateway source includes the reviewed v0.21.5 complete-catalog overlay. The pinned v0.22.3 source used for acceptance creates profiles under `profiles/<name>`, publishes each profile atomically, then requests a control-socket rescan; its supported multiplexed gateway also rescans profiles every 30 seconds and reloads changed `config.yaml`/`.env` files. The provisioner has a separate Hermes home, so its create notification cannot reach the client gateway. It waits up to 90 seconds for the profile-scoped API route and up to 90 seconds for each effective tool-policy change. A named-profile s6 slot is for an independently started gateway; the dedicated client multiplexer serves profiles through its own reconciler. This lifecycle was inspected in the pinned `hermes_cli/profiles.py`, `gateway/run_profile_reconcile.py`, and `gateway/platforms/api_server.py` sources. No production profile was created.
- No-token requests to the live API paths returned HTTP 302. No bearer credential was used, so this is not an authenticated route or readiness pass.

These are point-in-time idle measurements, not a load test. The proposed client runtime is capped at 2 GiB and 1 CPU, the worker at 512 MiB and 0.5 CPU, and the client gateway allows one concurrent run. Memory headroom makes a capped isolated test plausible on this VPS, but production capacity is not established: the existing internal Hermes container is uncapped and can compete for both CPUs and available RAM. Keep production provisioning disabled until isolated load tests confirm resource reserve and concurrency behavior; if the reserve cannot be demonstrated without changing the internal runtime, use a separate VPS or upgrade after approval.

## Startup inventory gate

Before writing worker heartbeat/audit state or claiming a job, startup performs two authenticated reads of the default profile's complete catalog. The native contract, complete=true, explicit safe allowlist, exact toolsets, tool provenance and names, challenge echo, optional HMAC, and stable digest are required. Each read has a distinct challenge, a cache-busting query value, and no-store headers. An absent or unadvertised route, missing metadata, unsafe tools, invalid HMAC, or changing catalog exits before any job is claimed. Each new or synchronized client profile is checked again with its own key before a success callback.

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
2. For fictional-tenant acceptance only, build the pinned v0.22.3 candidate in an isolated Linux environment with no production data. Run the overlay source verifier and the worker's real HTTP contract verifier, then review profile creation, storage, multiplexing, API authentication, and reload behavior before runtime acceptance. Do not use the currently running v0.21.5 production runtime as the test target.
3. Create and permission the private files above; check the Compose interpolation with the secret-free env file. Do not include the worker Compose profile yet.
4. Build and start only `hermes-client` in an isolated acceptance project. Verify the mounted `client_profiles` volume is separate and empty, no host port is published, an external probe cannot reach the API directly, and the private tunnel route authenticates through Cloudflare Access. The tunnel connector must join `hermes_private` and route the approved hostname to `http://hermes-client:8642`; do not publish or firewall-open port 8642.
5. In an isolated non-production iAcquireOS database, set up the approved gateway and test token; set the worker gateway ID, but keep the production provisioner switch off. Start the worker profile only for a fictional two-tenant test after isolated acceptance is explicitly authorized.
6. Verify both tenants' six role profiles, API identities and keys; prove cross-tenant access fails; run fresh-session SOUL canaries and a role smoke test; test sync, repeated claims, interrupted creation, audit recovery, and missing/expired integration behavior. Do not send real messages.
7. Reconcile migration 0084 against the live ledger and the release checklist. Apply it only after the separate production approval. Keep the production worker disabled until the final consolidated checkpoint is approved.

## Rollback

Keep the client-only volumes and last known image digest. Stop only the client Hermes and provisioner services; do not stop or recreate the agency Hermes app. Revert the portal application separately, leave the provisioner disabled, and retain the job/audit history. Do not delete `client_profiles` or `worker_home` while any client profile mapping or sync history exists. Restore a prior client-only image by digest only after confirming its on-disk config compatibility. Database rollback is governed by `supabase/rollbacks/0084_restricted_hermes_provisioner.down.sql` and must not discard sync history.

No service has been installed, no named volume has been created, no database has been migrated, and no profile has been created by this package work.
