# Upstream Hermes security changes since v0.21.5: assessment (2026-10-31)

**A read-only review of upstream's public release notes. Nothing was installed, upgraded, restarted or probed.** The production gateway is Hermes v0.21.5 (the version the C6 compatibility proof pins). The overlay README in this repository records that upstream's later security fixes "have not been assessed"; this is that assessment, with its limits.

**Sources:** the GitHub release notes of `NousResearch/hermes-agent` for v0.21.6 (2026-10-08), v0.21.7 (2026-10-12), v0.22.0 to v0.22.5 (2026-10-14 to 2026-10-23), read on 2026-10-31. **Not reviewed:** the individual commits (upstream reports about 8,900 commits between v0.21.5 and v0.21.6 alone), the code of any of these versions beyond what C6 and the worker already pin, and any private advisory. The notes list selected fixes; a fix that is not listed there is not ruled out.

## 1. What upstream lists

| Version | Fix (as upstream describes it) | Surface | Relevant to the business-tool path (A4a)? |
| --- | --- | --- | --- |
| v0.21.6 | Dashboard sign-in: a spoofed `X-Forwarded-For` could reset the password-login rate limit and get around the per-IP cap | the Hermes **web dashboard** login | **Only if the dashboard can be reached by an untrusted network.** No effect on the API server or MCP client |
| v0.21.6 | Dashboard sign-in: unauthenticated login requests could write unbounded values to the auth audit log | the dashboard | same |
| v0.21.6 | The public `/auth/` routes had no request-body size limit | the dashboard | same |
| v0.21.6 | Native sign-in could send login codes to a non-loopback redirect, allowing session takeover | the dashboard | same |
| v0.21.6 | Automatic git calls (workspace snapshots, subagent worktrees, kanban, `hermes -w`) could run `clean`/`smudge`/`process` filter programs defined by a repository | the agent's git use | No: the employees use no repository tool and no terminal toolset (C6 check 9: the only built-ins are `memory`, `session_search`, `todo`, `web`) |
| v0.21.6 | Email gateway: a quoted display name in `From` could pass the sender allowlist | the email adapter | No: no email adapter is configured |
| v0.22.0 | "Secrets stay put": child processes do not inherit adapter or dashboard secrets; profile exports skip credential stores; keys do not reach foreign hosts on refresh or fallback; file reads and terminal output mask `.env` and config secrets; credentials, `state.db` and snapshots are written owner-only whatever the umask | secret handling inside the host | **Partly**: it narrows where a profile's credential (the D3 credential included) can leak from, which is the exposure O2 addresses from the outside. Its absence on v0.21.5 is a reason to keep the profiles' directories out of every other container (O2), not an exploit |
| v0.22.0 | The MCP OAuth callback stops reflecting HTML; webhook, SMS and WhatsApp Cloud inbound reject blank signing secrets | MCP OAuth, messaging adapters | No: no MCP OAuth (the business server uses a bearer header) and no messaging adapter is exposed |
| v0.22.0 | Wider SSRF guard, approval for cloud-metadata fetches and pipe-to-shell commands | tool execution | No: no terminal or fetch tool beyond `web_*` (a read-only toolset) |
| v0.22.1 | "Refuse unauthenticated credential launch over ordinary daemon websocket" | the desktop daemon | No: the gateway is headless |

## 2. Does this make anything an immediate A4a blocker?

- **The API server and the MCP client** (the two things A4a uses): upstream lists no fix for either in these notes. The C6 proof exercised both on v0.21.5 and found no security defect in them (it did find the compatibility gaps recorded in the results report, which were in this repository's verifier, not in Hermes).
- **The dashboard authentication fixes** matter if, and only if, the gateway's dashboard is reachable from outside the network that is meant to use it. Closing that exposure at the network level is the correct fix and does not need an upgrade. That is tracked under O1 and is a precondition for A4a for its own reasons.
- **Nothing here requires upgrading the gateway before A4a.** Upgrading is a separate project with its own risk: the catalog overlay and the C6 proof are pinned to v0.21.5 (an overlay for v0.22.5 exists in `services/hermes-provisioner/catalog-overlay-v0225` and has not been run against the business MCP contract), six live profiles would be migrated, and the worker image already runs v0.22.5 for a different job.

## 3. Recommendation

1. **Not an A4a blocker; schedule as a separate item after A4a.** Re-run C6 against v0.22.5 with the v0.22.5 overlay (the harness takes a version and a commit; the worker image already pins that commit), compare the inventory contract, and decide upgrade versus stay on v0.21.5 with the network exposure closed.
2. **Until then:** keep every Hermes dashboard and API port off the public network, keep profile directories out of every container that does not need them, and keep `HERMES_BUSINESS_MCP_ENABLED` off outside a supervised window.
3. **Re-check this page's sources before the upgrade decision.** Upstream ships often, and "curated notes ship with the next minor" means this list can grow.
