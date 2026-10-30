# A4 blockers: the hosting account, O1 (public gateway port) and O2 (whole-profile mounts)

**Status (2026-10-30): a draft proposal for your decision. Nothing in it has been done.** No production, VPS, Cloudflare, hosting-account or profile setting was changed or probed to write it; it uses only what this repository and the earlier approved read-only checks recorded. The repository is public, so this file names no address, identifier or credential and gives no event timeline.

Date: 2026-10-30. Decision owner: the founder. Context: section 8 of `hermes-d3-c6-results-2026-10-30.md` lists these three as the infrastructure items to settle before business tools (A4). W2, O3, the egress proxy image and inference latency are not blockers (section 8 here).

## 1. Recommendation in one paragraph

**Settle them in this order, each starting with a read-only look and each change approved on its own: the hosting account, then O1, then O2.** For the account: review tokens, sessions, members, deploy hooks and integrations first; unless the actor turns out to be something you can identify and stop, revoke every token and session and re-create only the one this work needs, then wait one quiet day before the signing secret goes in (as a sensitive variable). For O1: find out what the published port serves and whether it is reachable from outside before changing anything; if it is reachable, close it with the VPS provider's firewall (outside the VM, reversible in seconds, no gateway restart) and remove the port publication the next time the gateway is restarted anyway. For O2: move the six workers onto worker-only copies of the three files they need (`SOUL.md`, `config.yaml` and a DeepSeek-only `.env`): no code or image change, no change to the live profiles, and the A4 credential, the conversation history and the other tokens stay out of the workers' reach. A4a is requested only when all three are settled.

## 2. Why these three, and how much they matter

A4a puts one signed credential in each employee's profile `.env` on the gateway host, and the signing secret in the application's hosting account. That sharpens three questions: who can change that account, who can reach the gateway host's profile files from outside (O1), and who can read them from inside (O2, the workers).

Keep the credential's own reach in view: it opens one read-only endpoint, only during that employee's live Chat turn run by a Super Admin; it expires (90 days by default) and can be revoked by id; the employee, workspace and run are checked against the database on every call (`hermes-business-mcp-credentials.md`). I have found no way to exploit any of the three. They matter because one mistake or one compromised component would cost more once the credential exists. That is a reason to close them first, not a sign that anything is being exploited.

## 3. The hosting account

### 3.1 What is known

- On 2026-10-30 (UTC), during A3, production-setting changes appeared that this work had not made (a diagnostic flag was added and removed several times, each followed by a production redeploy; at least one briefly put an older build live, which was restored). The hosting provider's records attribute them to your user. The timeline, the evidence and the attribution work that followed are kept in the private security report, not in this public repository.
- **Not known to this document:** which token, session or device made them, and whether any secret value was read. See the private report for the current classification.

### 3.2 Hypotheses, and how to tell them apart

| # | Hypothesis | What fits | How to tell (read-only) |
| --- | --- | --- | --- |
| H1 | Another AI assistant, script or editor on a machine signed in as you, following the documented procedure | the step-for-step match; two kinds of client | each token's name, creation and last-used dates against the event times; which machines and tools have the command line signed in; whether any other assistant was given production tasks |
| H2 | A leaked or shared token, or a session used by a person | nothing specific | the same last-used dates; sign-in and device records; unknown team members or pending invites |
| H3 | An integration or deploy hook | a hook redeploys an old commit | the project's deploy hooks and installed integrations. A hook cannot add or remove a variable, so it does not explain the whole pattern |
| H4 | Your own other browser or an extension acting as you | one cycle used the dashboard | the sessions list; ask |

### 3.3 The review (all read-only; nothing is changed)

1. **Me, through the command line:** re-read the account's recent events (actions, entities, times, any client fields), and list the project's variables by **name and type** (sensitive or not), never values.
2. **You, in the dashboard, signed in:** note the names, creation and last-used dates of every token; the active sessions and devices; the members and pending invites; the project's deploy hooks; the installed integrations and the Git connection's scope; and whether two-factor sign-in is on. Tell me counts and anything unfamiliar. Do not send me a token.
3. **Match** the unfamiliar tokens' last-used times against the event times. That usually names the actor.

### 3.4 Response options

| Option | What it does | Cost | When |
| --- | --- | --- | --- |
| R1. Identify and stop it | find the actor, confirm it is benign (for example another assistant of yours), stop it, and rule that no other agent touches production without approval | cheapest | only if the actor is found and you are sure |
| **R2. Rotate access (recommended)** | revoke every token, sign out every session, re-create only what this work needs (one named token for this machine's command line), turn on the strongest two-factor sign-in the account offers, remove unknown members, hooks and integrations | about half an hour of your time; the command line here signs out and you sign it in again when needed; any other agent loses access too | unless R1's condition is met |
| R3. R2 plus rotating secrets | rotate the secrets the actor could have read | large | only if the review shows read access, or the variable-type listing shows secrets stored as readable (not sensitive) |

On R3: a principal with deploy access can read every variable that is not stored as sensitive (a sensitive variable cannot be read back). That is why step 1 lists types. The observed actions touched only the diagnostic flag, which is consistent with someone following the documented recipe rather than looking for secrets, but it proves nothing about what else was possible.

### 3.5 The gate for A4a

The signing secret goes into the account only after R2 (or R1 with the actor confirmed), after a quiet day (24 hours with no event I did not cause), and as a **sensitive** variable. Until then A4a does not start. I will re-read the events at the start and end of every later stage.

## 4. O1: the published gateway port

### 4.1 What is known and not known

- **Recorded by A1 (read-only):** the gateway container publishes one of its ports on a host port on all interfaces, and `ufw` is inactive. Traefik is also running on the host. The application does not use that port: the tunnel route reaches the gateway over the internal Docker network (`http://hermes-agent:8642`).
- **Not known:** what listens on 4860 (a dashboard, the API or something else), whether it demands a key, whether the VPS provider's firewall (separate from `ufw`, in the panel's Security section) filters it, whether IPv6 is filtered, and whether Traefik also publishes the gateway under a hostname.
- **General Docker behaviour, not tested on this host:** a port published by Docker bypasses `ufw`, because Docker inserts its own rules ahead of `ufw`'s. So "`ufw` inactive" is not by itself the exposure, and switching `ufw` on would not close the port.

### 4.2 Read-only discovery (nothing is changed or sent; no credential is used)

| # | Check | Where | What it tells us |
| --- | --- | --- | --- |
| 1 | `docker port <gateway container>` | VPS console | which container ports are published, on which addresses |
| 2 | headers only for `/` and `/v1/models` from the VPS itself: `curl -s -o /dev/null -D - -m 5 http://127.0.0.1:<host port>/` | VPS console | what the port serves, and whether it demands a key (401 or 403) or answers openly; no body is read |
| 3 | the gateway's Traefik router rules only: `docker inspect -f '{{json .Config.Labels}}' <gateway container> \| grep -o 'traefik[^,]*rule[^,]*'` | VPS console | whether the gateway is also published under a hostname (the pattern cannot match an auth label) |
| 4 | `ufw status verbose`, `iptables -S DOCKER-USER`, `iptables -t nat -S DOCKER` | VPS console | whether anything on the host filters the published port |
| 5 | one TCP connect and one HTTP request to `<public address>:<host port>`, over IPv4 and IPv6, from a machine outside the VPS | my PC (with your approval) or yours | **whether the port is reachable at all**; the deciding fact, since a provider firewall may already block it. Needs the public address from the panel, which is deliberately not in this repository |
| 6 | the panel's firewall page, view only | you, in the panel | whether a provider firewall exists, is attached, and what it allows |

### 4.3 Options after the discovery

| Option | What changes | For | Against |
| --- | --- | --- | --- |
| A. Show harmless | nothing | no change | valid only if check 5 shows the port unreachable from outside, or reachable only to an authenticated refusal, and nothing behind it can read a profile directory |
| **B. Provider firewall** | add rules in the panel that allow only the ports in use (SSH, and 80 and 443 if Traefik serves anything) and drop the rest | outside the VM, not bypassed by Docker, reversible by detaching it, no gateway restart; the tunnel only makes outbound connections, so it is unaffected | the allow-list must be right; IPv6 handling and the panel's default action must be checked first; keep a console session open while applying, and confirm the panel console does not depend on the firewall before relying on it |
| C. Host rules | a `DOCKER-USER` rule dropping outside traffic to the port, made persistent | no dependence on the panel | easy to get wrong, needs persistence, and is invisible to the next person |
| D. Unpublish or bind to loopback | edit the gateway's compose file and recreate the container | fixes the cause | restarts the gateway (all six employees' chat is briefly interrupted), edits a provider-managed deployment that a template update may overwrite; needs a window and a rollback copy of the file |

**Recommendation:** run the discovery. If check 5 shows the port is not reachable from outside, record that and treat O1 as shown harmless. If it is reachable, apply B now, and do D at the next time the gateway is restarted anyway (A4a may need a reload, section 8), so the gateway is interrupted once rather than twice. Rollback for B is detaching the firewall configuration in the panel.

## 5. O2: what the workers can see

### 5.1 Facts

- Each of the six workers mounts its employee's **whole** live profile directory, read-only (`services/hermes-inference-worker/compose.internal.yaml`). Besides `SOUL.md`, `config.yaml` and `.env`, A1 recorded `state.db`, `sessions`, `memories` and `.env.backup-*` files there. I have not read their contents; they may hold conversation text. The `.env` holds the profile's gateway key, the provider key and other integration credentials, and after A4a the business credential.
- The worker's code reads only three files from it: `SOUL.md` (at most 16,384 bytes), `config.yaml` (at most 65,536 bytes) and, for inference, `.env`, of which it keeps only the DeepSeek names (`_provider_dotenv`). It copies them into a throwaway home per request.
- What already limits a compromised worker: no tools (`enabled_toolsets=[]`), no MCP, no network except the allow-listed proxy, read-only root, a non-root user, all capabilities dropped, no published ports, `/tmp` mounted `noexec`. A compromise would need code execution inside the worker first. That is why this is defence in depth, not an open door.
- A1 offered the alternative (decision (d)) and you chose the full mount. The facts have changed: A4a would put a credential in that `.env`, so I am asking you to revisit it.

### 5.2 Options

| Option | What changes | For | Against |
| --- | --- | --- | --- |
| A. Keep the full read-only mounts (today) | nothing | no work | a compromised worker could read the whole profile, including the A4 credential and any history |
| **B. Worker-only copies (recommended)** | six directories on the VPS hold copies of `SOUL.md`, `config.yaml` and a `.env` with only the DeepSeek lines; the workers mount those; the existing `HERMES_PROFILE_BASE` variable points the unchanged compose file at them | hides everything else; no code, image or live-profile change; mounts stay read-only; rollback is one variable | the DeepSeek key exists in a second place on the same host; the copies must be re-synced when a live `SOUL.md`, `config.yaml` or key changes (a check makes drift visible) |
| C. Two single-file mounts plus a key file | mount only `SOUL.md` and `config.yaml` from the live profile; give the workers the DeepSeek key as a Docker secret file | no copies of the two files | needs a worker code change, a new image and a rollout; a single-file mount keeps serving the old file if something replaces it by renaming; the key still lives in a second place |
| D. Different user for workers, tighter modes on live files | the live `.env` becomes unreadable to the worker | no copies | changes ownership or modes on the live profiles, and the workers still need the DeepSeek key from that file: not recommended |

### 5.3 Option B in detail (nothing below is done)

- **Layout:** one directory per employee under a new worker-profile base, with the same six names the compose file already uses (`iacquire-operations-manager`, `iacquire-lead-hunter`, `iacquire-appointment-setter`, `iacquire-sales-assistant`, `iacquire-crm-manager`, `iacquire-analyst`), each holding `SOUL.md`, `config.yaml` and `.env`; owner 10000:10000, files mode 0400, directories 0500.
- **Script** (new, built on the review branch if you approve, `scripts/hermes-worker-profile-view.sh`, modes `sync` and `check`, tested on synthetic profiles with planted secrets as the A1 preflight was): refuses symlinks and missing or oversized files (the worker's own limits), copies the two files, writes `.env` with only the `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` lines that pass the worker's own token check (so the copy is what the worker would keep anyway), writes atomically, and prints only names, sizes, short hashes and presence booleans. `check` compares hashes against the live files and exits non-zero on drift.
- **Steps on the VPS, each approved:** create the base; run `sync`, then `check`; export `HERMES_PROFILE_BASE` to the new base; dry-run `docker compose ... up -d --no-build --no-deps` for the six worker services (it must show only those six recreating); apply it; verify one read-only mount each and that the mount lists only three files.
- **Effect:** none for users (inference is off; the six workers recreate briefly). The live profiles, the gateway, the proxy, Cloudflare and Vercel are not touched.
- **Rollback:** re-export the previous `HERMES_PROFILE_BASE`, recreate the six workers, delete the copies.
- **Drift:** a stale key makes inference fail visibly (and fail safe); a stale `SOUL.md` makes a canary use the old persona text. Run `check` before every later stage.

### 5.4 One related check before A4a (worker side)

A4a adds an `mcp_servers` entry to each live `config.yaml`. The worker copies that file into its throwaway Hermes home, so the worker's Hermes (0.22.5) will see the entry. I expect no effect: the runner enables no toolsets, and in the 0.21.5 source the overlay carries, MCP discovery is run by the gateway and CLI start-up code and no longer at import. But I have not run the worker against such a config, and the pinned 0.22.5 may differ. Before A4a I would add one CI check (pinned 0.22.5, network off): a profile config containing a business `mcp_servers` entry still gives the normal result within the time budget, with no connection attempt. If it does not, strip `mcp_servers` from the copied config in `build_runtime_home` (a small, unit-tested change). Both stay on the review branch until you approve a rollout.

## 6. Order and gates

| # | Step | Kind | Production effect | Approval |
| --- | --- | --- | --- | --- |
| 1 | Account: read-only review (3.3) | read-only | none | yes |
| 2 | Account: response (R2 recommended) | change, account | the command line here signs out; any other agent loses access | yes, separately |
| 3 | O1: read-only discovery (4.2) | read-only | none | yes |
| 4 | O1: mitigation (B, later D) | change, provider firewall | inbound filtering | yes, separately, with the exact rules |
| 5 | O2: script, tests and the CI check (5.3, 5.4) | review branch and CI only | none | pushing needs your sign-in |
| 6 | O2: switch the six workers to copies | change, VPS | six workers recreate; inference off | yes, separately |
| 7 | A4a request | | | when 1 to 2, 3 to 4 and 5 to 6 are settled |

"Settled" means: the account gate in 3.5 is met; O1 is mitigated or shown harmless; the workers run on copies, or you have accepted the exposure in writing.

## 7. What I need from you

1. **The account:** approve the read-only review in 3.3 (my part through the command line, yours in the dashboard), and say which response you prefer (R2 recommended).
2. **O1:** approve the read-only discovery in 4.2 (checks 1 to 4 in the console; check 5 from outside, which needs the public address from the panel; check 6 is your view of the panel's firewall page).
3. **O2:** Option B (recommended), C or A. If B or C, may I prepare the script, tests and CI check on the review branch (no production effect; pushing still needs your sign-in).
4. Whether to add the v0.21.6 assessment (section 8).

## 8. Not blockers, and not covered

- **W2** (the Access service token never expires): not an A4 blocker; a rotation policy is a separate item.
- **O3** (a writable anonymous `/opt/data` volume in each worker): low; the tmpfs mask proposal exists and is not applied.
- **The egress proxy on the older image:** no effect on A4. **Inference latency of 17 to 23 s:** not an MCP matter (`tool_timeout` is 12 s per call).
- **Upstream v0.21.6 security fixes are unassessed.** The overlay README says the 0.21.5 candidate is not approved for production for that reason; it is written about the client image, but the gateway is the same 0.21.5 base. A read-only assessment (read the upstream release notes and list the fixes that touch the API server and the MCP client) needs no production access. I can do it if you want it.
- **Unknown, for A4a itself:** whether a running 0.21.5 gateway picks up a new `mcp_servers` entry and `.env` line without a restart. The C6 proof restarted a gateway per configuration. If a restart is needed, it is a separate approval, and the best moment to also do O1 option D.
- **Not covered here:** the Cloudflare tunnel and Access setup, the DeepSeek account, and the A4a procedure itself (`hermes-business-mcp-credentials.md`, with the profile-file hashes and restore copies the release package requires).
