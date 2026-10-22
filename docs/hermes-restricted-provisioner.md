# Restricted Hermes client profile provisioner

Status: implementation and isolated local verification are prepared on branch codex/client-ai-onboarding. The service is not installed, enabled, migrated, or used to create a production profile. The Hostinger mixed-use Hermes container was inspected read-only.

## Verified Hostinger runtime

The authenticated hPanel session identified VPS srv2039372.hstgr.cloud, VPS ID 2039372. Its App terminal attached to container 008d77b9fd0a, hermes-agent-wpwm-hermes-agent-1. The container reports Hermes Agent v0.21.5 (2026.9.24), Hermes CLI at /usr/local/bin/hermes, and install directory /opt/hermes. Its persistent bind mount is /docker/hermes-agent-wpwm/data to /opt/data, which is the Hermes home.

That home contains default and six iAcquire internal profiles. It is therefore not a valid client provisioning target. The container process starts as root; profile data is owned by hermes. Existing profile directories are under /opt/data/profiles/<profile>, with SOUL.md, config.yaml and profile-specific .env files. The profiles directory and profile directories are owned by hermes; inspected SOUL.md permissions are 0600. No SOUL text, .env values, or credentials were read.

The installed v0.21.5 source confirms:

- Blank profile creation supports --description, --no-alias and --no-skills. The worker uses those options and never uses clone flags.
- Creation builds a hidden sibling directory and publishes it with one rename. It registers a supervised profile gateway slot with start_now=false, then notifies the running profile multiplexer. The source also documents a periodic profile rescan. Existing profile-specific s6 slots were down while the default-profile multiplexer served named profiles.
- The runtime reads SOUL.md from the profile home when building a fresh agent. A cached conversation may retain its existing system prompt; the worker therefore verifies a fresh, unique run and does not claim an in-place refresh for old sessions.
- A new profile can be discovered through the multiplexer without restarting the container or starting its per-profile service.
- Blank creation seeds a model configuration block from the Hermes home base config. This is why automated creation must use a separate client-only Hermes home with a reviewed, secret-free model configuration. The mixed agency home is explicitly rejected by the worker if iAcquire profile directories are present.

The current v0.21.5 runtime does not expose the complete GET /v1/tools?platform=api_server inventory required by iAcquireOS. Its live endpoint returned 404 in the existing release audit. The portal correctly refuses to mark profiles ready without that complete inventory.

## Trust boundary and deployment shape

The public application never receives Docker access, host root, unrestricted SSH, or a filesystem path. It serves two authenticated internal endpoints:

- POST /api/internal/hermes-provisioner/claim leases one eligible job for a single server-pinned gateway.
- POST /api/internal/hermes-provisioner/complete accepts only the matching leased result, then saves a new profile key through the existing Vault-backed credential path.

The worker polls outbound over HTTPS using a dedicated service token. The portal pins that token to one gateway ID. Claiming is disabled unless the gateway is connected, multiplexed, marked restricted-service-verified, has a separate isolation-verification timestamp, and has no mapped iAcquire agency profiles. The isolation timestamp is a privileged operator attestation; no public UI can set it.

The worker must run as the unprivileged hermes account inside a dedicated client-only Hermes runtime. Its HERMES_HOME and volume must contain no iAcquire internal profiles or other agency data. Do not mount the existing /docker/hermes-agent-wpwm/data volume. Do not give the worker a Docker socket, host root, public listener, Supabase key, or customer messaging credentials. It can write only its own client-only profile home and communicate outbound with iAcquireOS and the local loopback Hermes API.

The current mixed-use container cannot host this worker. A distinct client-only runtime, its service authentication, a compatible Hermes build and an isolated acceptance run are prerequisites. No host installation or profile creation was performed.

## Worker transaction

1. Validate the HTTPS portal origin, dedicated service token, pinned gateway ID, non-root UID, Hermes CLI and its installed profile-create flags. Reject an unsafe Hermes home, agency profile namespace, symlink, stale lease, invalid role, path-like profile name or unknown manifest field.
2. Accept only the six known roles and the stable c- tenant namespace. The server derives the profile name from the tenant slug digest and role. The manifest contains an applied configuration version, approved compiled instructions, fixed tool policy, SOUL/config digests, tenant/agent IDs and lease expiry; it contains no shell command or filesystem path.
3. For a new profile, call Hermes CLI with a fixed argv: profile create, --description, --no-alias and --no-skills. A durable intent record is written first. The per-profile API key is generated by a CSPRNG, written once to that profile's .env with mode 0600 and never written to the job marker, callback detail or audit.
4. Merge only the model block from the client-only Hermes home's blank profile. Reject secret-looking fields. Apply the server-generated client tool policy, disabled toolsets and containerized terminal settings. Write SOUL.md and config.yaml by atomic replacement with fsync and safe path checks.
5. Before publishing the result, temporarily disable API tools and run a one-use canary with a random marker embedded only in the SOUL. The worker authenticates the profile route, verifies its primary model identity, confirms no canary tool event occurred and requires the exact marker output. A new session avoids reusing an older cached prompt. It then writes the final reviewed tool policy and verifies the profile's full challenged runtime tool inventory.
6. Return only hashes, profile identity, inventory evidence and the newly created API key. The application compares the lease and stored manifest digests, writes the credential to Vault, maps the client employee to the pinned gateway and marks the job awaiting portal health verification. The independent portal health check must still pass before the employee can run.

Configuration sync jobs are created only for profiles bearing a successful restricted-provisioner ownership record. Each sync names the originating provision job and applied config version. The worker refuses a missing or mismatched ownership marker, does not replace the key and atomically applies the newly approved SOUL and tool policy. The agent's recorded host config version must equal its active iAcquireOS config version before health or run gates can open.

Retries are idempotent. A local intent journal lets the worker resume its own interrupted blank creation. A pre-existing unmarked profile, conflicting tenant marker, malformed key or symlink is a hard failure and is never adopted. Expired leases can be reclaimed up to three attempts with backoff. Replays after a committed callback verify the existing credential fingerprint and result reference instead of creating another Vault entry. Recovery never prints or copies a key into logs.

Audit records include tenant/agent/job IDs, profile name, Hermes version, config version, hashes, inventory digest and outcome. They exclude the API key, SOUL text, manifest body and client business content. The job table stores only hashes and source references.

## Local verification

The Python worker is in services/hermes-provisioner/worker.py; its eight unit cases use temporary fictional profiles and a fake Hermes API. They cover no-clone creation, mode and hash checks, idempotent key recovery, interruption recovery, conflict refusal, sync ownership, manifest/tool-policy validation, strict HTTPS-origin validation and inherited-secret removal. No test used the Hostinger container.

The application integration requires migration 0083_restricted_hermes_provisioner.sql after migrations 0081 and 0082. Migration 0083 adds sync jobs, expected manifest hashes, profile config version tracking and the isolation-verification timestamp. Its rollback refuses while any sync-job history exists.

The portal's effective-SOUL canary result is accepted only from the authenticated pinned worker; it is recorded separately from the portal's health check. The current iAcquireOS health check independently verifies authenticated profile identity, API capabilities, restricted toolsets and complete stable tool inventory. A host callback by itself never makes an employee Ready.

## Production gate and release checkpoint

The production host and database remain unchanged. The existing Hostinger container still contains the six iAcquire profiles and runs as root; no new profile or service was created, no gateway or container was restarted, and no migrations were applied.

The last authoritative database check, dated 2026-10-21, reported migrations 0081 and 0082 pending. Migration 0083 is new in this branch. Before deployment, check and resolve duplicate open provisioning jobs, apply 0081, 0082 and 0083 in order, then deploy the app with the provisioner disabled.

Before enabling the worker, build a separate client-only Hermes runtime using a Hermes version that supports the complete tool catalog. Run two fictional tenant profiles in an isolated acceptance environment and prove cross-tenant refusal, profile/API identity, role canary, config synchronization, no tool calls in the canary, inventory completeness, retries, interrupted writes and Vault callback idempotency. Only after that review should a privileged operator set the isolation-verification timestamp and configure the pinned gateway token. Production enablement and any Hostinger deployment require explicit approval.

The current real end-to-end production result is therefore: zero profiles provisioned; zero production changes. Local worker and portal tests are the only completed provisioning evidence. The release is implementation-ready for isolated runtime acceptance, not production-ready or deployed.
