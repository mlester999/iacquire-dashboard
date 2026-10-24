# Hermes complete tool catalog overlay

This runtime-only overlay backports the iAcquireOS complete catalog contract to Hermes `0.21.5`.
It is based on upstream Hermes source commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`
(`v2026.9.24`) and reviewed backport revision `f6a6230` for upstream PR #92729.

The overlay adds the authenticated `GET /v1/tools?platform=api_server` route with a complete flag,
profile-specific tool provenance, a challenge echo, and expiry metadata. It resolves the same
effective allowlist used when Hermes constructs an API-server agent. It does not include profiles,
SOUL files, credentials, configuration, memory, sessions, or any client or agency data.

`SHA256SUMS` pins the eight runtime source files. The client Docker build checks those hashes,
requires Hermes `0.21.5`, compiles the patched modules, and checks that the catalog handler and
read-only resolver hook import successfully. The upstream backport's dedicated suite passed
23 tests in the isolated source checkout on 2026-10-22. The client image itself has not been built
in this workspace because Docker is unavailable.

The overlay is separate from the internal Hermes container. `../client.env.example` pins the
official v2026.9.24 multi-platform OCI index for isolated-build review. This Hermes 0.21.5
candidate is not approved for production: v0.21.6 later listed security fixes that have not been
assessed or ported. Resolve the base-version/security gate in `../DEPLOYMENT.md`, build only in an
approved isolated environment, and complete runtime acceptance before any deployment.
