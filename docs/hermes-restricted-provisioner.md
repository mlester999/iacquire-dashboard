# Restricted Hermes client-profile provisioner design

Status: design and contract only. **No host service, provisioner claim endpoint or result callback is installed or enabled.** The current portal queue remains an operator workflow. The installed Hermes image, runtime UID, container mounts, profile directory, gateway supervision and reload behavior still require read-only inspection on the Hostinger VPS. Do not substitute assumptions from current upstream docs for that inspection.

## Trust boundary

The web portal may request a client employee profile, but its Hermes run API cannot create one or read the effective SOUL. The provisioner is a separate host-side service. It is the only component allowed to write **new client profile directories**. It has no root, unrestricted SSH, Docker socket, agency/default profile volume, Supabase service role key, outbound customer messaging credential or ability to run arbitrary commands from a job payload.

Run it as a dedicated unprivileged account/container with a read-only application image and a narrow writable mount for client profiles. Its filesystem view must exclude existing agency/default profiles. The gateway may need a broader read mount; the provisioner must not inherit it. Confirm the actual host volume layout before deciding whether a safe separate mount is possible. If the current layout cannot provide that separation, stop and create the boundary first rather than granting write access to the whole Hermes home.

## Job contract

The portal owns the queue, eligibility checks, audit and bounded leases. A dedicated provisioner identity obtains one leased job at a time over a private authenticated channel. Prefer service-to-service mTLS or a separate Cloudflare Access service token bound to an exact endpoint and audience; never reuse the gateway run key. The portal checks the job's tenant, verified owner, non-demo status, requested role, profile-name uniqueness and current configuration. The signed manifest contains only `jobId`, `leaseToken`, `orgId`, `agentId`, `role`, stable profile name, policy/template versions, expected SOUL and config digests, and an expiry. It contains no client-supplied shell command or file path.

The provisioner validates every identifier and digest against a fixed schema, accepts only the six known roles and the `c-` profile namespace, rejects stale leases and replayed manifests, and records a durable idempotency marker inside its own client-profile ledger. A retry with the same manifest returns the prior verified result. A conflicting existing directory or marker is a hard failure requiring human review; it is never overwritten or adopted silently. Per-profile API keys come from a CSPRNG or an approved secret manager and are unique. The key crosses back to the portal once over the authenticated channel, is saved immediately into the existing encrypted credential store, and is never written to the queue, audit text or logs. A recovery procedure rotates an orphaned key instead of exposing it.

## Provisioning transaction

1. Preflight: verify installed Hermes version, supported `profile create` flags and the actual container profile layout. Reject an unsupported image. Check sufficient space and profile-name absence. Acquire a per-profile lock.
2. Create a blank profile with the installed CLI's supported flags, with **no clone, alias or bundled skills**. In the currently documented CLI this is `hermes profile create <name> --no-alias --no-skills`; the deployed CLI must prove support first. Current upstream documentation says cloning copies SOUL and memory, and Docker profile creation may register a supervised gateway slot automatically. This side effect must be accounted for before enabling the worker.
3. Write only approved role template, restricted tool configuration and per-profile credentials to a staging directory under the client-only volume. Use UTF-8, exclusive creation, `0600` files, `0700` directories, safe path traversal checks, and atomic rename. Never merge with an old SOUL, read another tenant's directory, or accept a path from the manifest. Do not enable shell/file/MCP/plugin tools through inherited defaults.
4. Read the files back and compare exact SHA-256 digests with the signed manifest. Reload or register **only this profile** through a narrow, reviewed mechanism once the host inspection identifies it. No general `docker restart`, gateway restart or Docker socket in the provisioner.
5. Authenticate against the exact `/p/<profile>/` route using that profile's key; verify the primary profile identity, capability contract, server-enforced tool allowlist and complete effective inventory. Run a bounded, non-mutating role/business canary after approval to test loaded behavior. File hash plus post-reload role behavior are both required; neither alone proves the other. Record observed version, digests, inventory digest, timestamps and result reference without secrets.
6. Report success/failure with the original lease token. The portal maps the profile and credential through its existing guarded path, then runs its independent health/readiness gate. Failed jobs stay unavailable. A claimed job that expires can be retried at most three times with backoff; a conflicting profile or digest requires explicit agency investigation.

## Required proof before enabling automatic production use

- Read-only host inventory of container image digest, Hermes version, runtime UID, profile storage mounts, gateway supervision and currently deployed SOUL hashes. Do not print `.env`, keys or SOUL text.
- An isolated test container with a separate client-only volume and two fictional tenant profiles. Prove no access to agency/default profiles, unique keys, non-copying SOUL, exact readback hashes, safe replays, interrupted writes, lease expiry and conflicting-directory refusal.
- Independent API identity, capability and full tool-inventory checks for each test profile, plus a post-reload role/tenant canary and cross-tenant refusal.
- Review of service authentication, secret storage, narrow profile activation mechanism, operational logs and rollback. Apply migration 0081 then 0082 and deploy portal code only at an authorized production checkpoint. No live customer profiles are created during the proof.

## Read-only Hostinger terminal inventory

Open the VPS overview for ID `2039372` in the authenticated hPanel and launch its browser terminal. These commands identify the host and discover the running Hermes container without printing environment variables or file contents:

```sh
hostname
id -un
docker ps --format '{{.ID}}  {{.Names}}  {{.Image}}  {{.Status}}'
```

Select the Hermes container ID from that output, then run the following commands after replacing `<hermes-container-id>` with that exact ID. Share only non-secret output. The inspection must confirm that this container actually serves the portal's Hermes endpoint before it is treated as the correct VPS.

```sh
docker inspect --format 'image={{.Image}} user={{.Config.User}} mounts={{json .Mounts}}' <hermes-container-id>
docker exec <hermes-container-id> sh -lc 'id; command -v hermes; hermes --version; hermes profile create --help; hermes profile list; ls -ld "$HOME/.hermes" "$HOME/.hermes/profiles" 2>/dev/null'
```

Do not run `profile create`, edit files, restart anything, or print environment variables, API keys, SOUL contents, or credential files during this inventory. If the container has no shell, use equivalent read-only host-side image and volume inspection; record that limitation rather than changing the container.

## Source basis and unverified assumptions

Current upstream [Hermes profile commands](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/profile-commands.md) document blank creation, `--no-skills`, and clone behavior. The [profile guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md) documents independent profile homes and Docker gateway supervision. These describe upstream `main`, **not** the installed Hostinger version. Host inspection is required before implementation of the service's file and reload adapters.
