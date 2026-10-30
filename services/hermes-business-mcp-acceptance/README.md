# Business MCP compatibility harness (C6)

Proves, against a **real, pinned Hermes 0.21.5**, that the gateway and its MCP client accept the business MCP server configuration, authenticate with the signed credential, discover the approved tools,
report them in the complete tool inventory the application verifies, and fail closed when anything is wrong. Results and what they do and do not prove: `docs/hermes-d3-c6-results-2026-10-30.md`.

Nothing here touches a live gateway, profile, credential, customer record or non-loopback address. No model is called and no provider key exists in the runtime's environment.

## Pieces

| File | What it is |
| --- | --- |
| `prepare-runtime.mjs` | Builds the pinned runtime in a new directory: upstream Hermes commit `f97608f` (v2026.9.24 = 0.21.5), dependencies installed exactly as upstream's own container build does (`uv sync --frozen` against its `uv.lock`, extras `mcp` and `messaging`, Python 3.13), this repository's catalog overlay (`../hermes-provisioner/catalog-overlay`) verified against its `SHA256SUMS` and applied to a copy. The pristine checkout is kept as the "no overlay" control. Writes `runtime.json` (versions and hashes). |
| `mcp_client_probe.py` | Runs **inside** the runtime. Uses Hermes' own MCP client and tool registry against one disposable profile: discovers the tools, optionally calls one. Prints one JSON object with names, counts and booleans only. |
| `../../tests/hermes-business-mcp-pinned-runtime.test.ts` | The proof. Serves the real `handleHermesBusinessMcp` on loopback over a seeded in-memory database, creates a disposable Hermes home with the six internal profiles, starts the real gateway, and checks everything. |
| `../../tests/support/c6-runtime.ts` | Test support: clean environment for the runtime (no developer shell variables, no provider keys), home and gateway lifecycle, the non-blocking probe runner, the loopback HTTP bridge. |
| `../../.github/workflows/hermes-business-mcp-compat.yml` | Runs the above on Linux CI (branch-scoped, like the other Hermes workflows). |

## Run it

```bash
node services/hermes-business-mcp-acceptance/prepare-runtime.mjs --out <new empty directory>
```

On Windows keep `--out` short (for example `S:\c6`, a `subst` drive, or `C:\h`): upstream's source tree is deep and Windows limits paths to 260 characters unless long paths are enabled.
Then, with the three variables the script prints:

```bash
IACQUIRE_REQUIRE_C6_RUNTIME=1 \
IACQUIRE_C6_PYTHON=<out>/venv/bin/python \
IACQUIRE_C6_HERMES_SOURCE=<out>/hermes-overlay \
IACQUIRE_C6_BASELINE_SOURCE=<out>/upstream \
IACQUIRE_C6_EVIDENCE=<out>/evidence.json \
npx vitest run tests/hermes-business-mcp-pinned-runtime.test.ts --reporter=verbose
```

Without `IACQUIRE_C6_PYTHON` and `IACQUIRE_C6_HERMES_SOURCE` the file is **skipped** (and says so); with `IACQUIRE_REQUIRE_C6_RUNTIME=1` a missing runtime **fails**, so CI can never pass by skipping.
`IACQUIRE_C6_BASELINE_SOURCE` is optional and enables the control test (the same gateway without the overlay has no complete-inventory route). A full run takes about five minutes.

## Things to know

- **One gateway per host.** Hermes takes a host-wide lock, so a second gateway on the same machine exits at once. The test starts the main gateway first and stops it before each fault-injection gateway.
- **The probe and the in-process server share a process.** The probe runner is asynchronous on purpose; a blocking wait would starve the loopback server the probe is connecting to.
- **Windows.** The runtime works on Windows, but it is not Linux: CI is the Linux evidence.
- **Not the production container.** It is the same Hermes source and the same locked dependencies as upstream's official image, plus the repository's overlay; it is not the host's packaged image. See the results document for what remains to confirm on the real gateway.
