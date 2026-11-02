# Client business tools: how a client employee gets its credential (Wave 9, built and tested only)

Everything here is code and tests on synthetic clients and a synthetic gateway. No worker image has been built from it, nothing has been rolled out, and nothing runs on the client runtime. With the tier off (the default) every manifest, completion and worker behaviour is exactly what it was before.

## 1. The design in one paragraph

A client employee's profile gets one reviewed MCP server (`iacquire_business`) and one credential of its own. The portal allocates the credential's **id** (no secret) when it hands the restricted worker a **synchronization**. The worker generates the **secret on its own host**, writes `IACQUIRE_BUSINESS_MCP_TOKEN=iamcpc1.<id>.<secret>` into the profile's private environment file (atomic, mode 0600), proves the profile shows exactly the role's reviewed tools, and reports only the **sha256 of the secret**. The portal completes the id it allocated from that hash alone. The secret never reaches the portal, a log, an audit row, the marker or a result.

## 2. The contract

- **Manifest.** Two optional keys, only on a synchronization and only together: `businessCredentialId` (a uuid) and `businessTools` (the role's reviewed runtime tool names, sorted). Without them the manifest is the 17-key manifest it always was. A first provision never carries them: an id belongs to an employee's existing profile, so the tier reaches a new workspace's employees by a synchronization.
- **Policy.** The configuration may add `mcp_servers` with EXACTLY one server, `iacquire_business`, whose URL equals the one the worker pinned itself (the portal origin it already trusts plus the fixed path; never read from a manifest), with the one literal header `Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}` and a 12-second tool timeout. The toolset list then names `mcp-iacquire_business` in place of `no_mcp`. A worker started without a pinned URL refuses the tier (`business_tools_not_enabled`). Any other server, URL, header or tool set is refused (`invalid_policy_config`), and a policy and manifest that disagree are refused (`invalid_manifest`). Everything is refused before anything is written.
- **Credential.** Kept as it is when the id is the same (a retry never rotates), made new when the id differs (a rotation), removed when a later synchronization switches the tier off. Containment (Wave 8) rewrites the environment file with the API key only, so a contained profile holds no business credential.
- **Verification.** The profile's tool catalog must show the business tools as `mcp` provenance from `iacquire_business` in `mcp-iacquire_business`, exactly equal to the manifest's names (none missing, none extra), beside the role's ordinary reviewed tools. The toolset listing must carry the same names.
- **Completion.** Optional `businessCredentialSha256` (64 hex characters). The portal finds the waiting id for this employee's own profile, refuses the job (`stale_configuration`) if none is still waiting, and registers the credential from the hash; the employee's earlier credential moves aside for the 48-hour overlap. A first provision that reports a hash is refused. A replay is accepted only with the same hash.

## 3. How the tools reach a workspace

Switching a workspace's business tools on (runtime controls, Super Admin) opens one synchronization per provisioned employee; each employee reads as not online until its profile has been synchronized and checked. A workspace that was already in the tier when its employees were first provisioned has none until a synchronization runs: press **Synchronize** in the runtime controls.

## 4. Proven, and not proven

Proven by tests (synthetic): the manifest's keys equal the worker's (the test reads the worker's own key sets), the allocated id is the same on a re-claim, a first provision never carries the tier, the credential is generated and written once, a retry keeps it and a new id replaces it, switching off removes it, every refusal writes nothing, the secret appears nowhere but the profile's environment file, an extra or a missing tool is refused, the completion registers from the hash alone, refuses a stale id, and accepts a replay only with the same hash. Python: `BusinessToolDeliveryTests` in `services/hermes-provisioner/test_worker.py` (6) and the whole provisioner suite (151 tests); portal: `tests/hermes-client-business-mcp-delivery.test.ts` (10).

**Observed, for the agency tier, on the pinned runtime:** a running Hermes 0.21.5 gateway does **not** pick up an `mcp_servers` entry, toolset and credential written into a live profile; it needs a restart (`tests/hermes-business-mcp-hot-reload.test.ts`, section 3 item 5 of `hermes-a4a-acceptance-plan-2026-10-31.md`; the test runs only in the pinned-runtime CI job). The client tier writes the same kind of entry into the same kind of profile on the same image, so **assume the same**: a synchronization that installs the tier ends `runtime_tool_policy_unverified` after its three attempts until the client gateway is restarted, then **Synchronize** completes it. The credential the worker already wrote is kept (a retry with the same id never rotates it), and the portal accepts no call from it until the completion registers its hash. The restart interrupts every tenant's chat on that gateway, so it is its own approval.

**NOT proven, and each is a rollout gate:**
1. That the client tier behaves like the agency tier on restart (it has no test of its own), and whether a profile's **replaced key and tools-off policy** (containment) are applied without a restart: the worker waits for them, reports `revoke_not_applied` if they are not applied in time, and the portal changes nothing until the worker proves it.
2. That the tool names the real gateway reports on `/v1/tools` and `/v1/toolsets` are the runtime names the portal computes (the tests use the portal's own names on a fake gateway).
3. That two client profiles multiplexed in one gateway each send only their own credential, and that tenant A can never read B's records through it. The pinned-runtime test for this (two tenants, two roles, modelled on `tests/hermes-business-mcp-pinned-runtime.test.ts`, required in CI with `IACQUIRE_REQUIRE_C6_RUNTIME=1`) is **not written**: it needs the real Hermes source and can only be iterated in the pinned-runtime workflow.

## 5. Rollout order (each its own approval)

1. Build a worker image that contains this code and roll it out with the tier switch off (nothing changes).
2. Write and pass the pinned-runtime test above (client route, two tenants, and a restart so the entry loads); record here whether containment's key replacement also needs one.
3. Turn on `HERMES_CLIENT_BUSINESS_MCP_ENABLED` for the deployment (and, only later, the proposals phase).
4. Switch one synthetic workspace into the tier (runtime controls), watch its synchronization fail closed as expected, restart the client gateway in an approved window, press **Synchronize**, watch it complete and its health check pass, then the supervised pilot client.
