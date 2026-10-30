# Business MCP credentials (D3)

The first-party business MCP endpoint (`/api/internal/hermes-business/mcp`) lets the six internal iAcquire AI employees read business information during their own Chat turn. This page is the
authentication and authorization design for it, and the operator procedure for its credentials. The endpoint is off (`HERMES_BUSINESS_MCP_ENABLED=false`) and nothing here changes that.

## What changed, and why

Before, the endpoint accepted the employee's Hermes **profile API key** as its bearer. That key is also the credential for the Hermes gateway, so one leaked string opened both. Now the endpoint
accepts only a **signed, profile-bound business MCP credential**, minted from a dedicated server-only secret. The profile API key no longer opens the endpoint, and the credential opens nothing
but the endpoint.

| | Hermes profile API key | Business MCP credential |
| --- | --- | --- |
| Purpose | The portal calls Hermes (Chat, health, inventory) | A Hermes profile calls the portal's business endpoint |
| Held by | Supabase Vault (portal), the profile `.env` (Hermes host) | The profile `.env` only. **Never stored by the application** |
| Opens the gateway | Yes | **No** (the gateway compares the profile key; a credential is a different value) |
| Opens the business endpoint | **No** (refused) | Yes, for one employee, with a live Chat turn |
| Rotated by | Replacing the saved profile key | Rotating `HERMES_BUSINESS_MCP_SECRET`, or ending one credential by id |

## The credential

```
iamcp1.<role>.<employee id>.<workspace id>.<issued at>.<expires at>.<credential id>.<signature>
```

- `role` is one of the six roles; the profile (`iacquire-operations-manager`, `iacquire-lead-hunter`, `iacquire-appointment-setter`, `iacquire-sales-assistant`, `iacquire-crm-manager`,
  `iacquire-analyst`) is derived from it and signed too.
- `signature` is HMAC-SHA256 over the version, profile, role, employee id, workspace id, both times and the credential id, joined by newlines. The key is **derived** from the secret with HKDF-SHA256
  (salt `iacquire-os/hermes-business-mcp`, info `credential-signing/v1`), so the secret is never a MAC key itself and no signature made for another purpose can verify here.
- Fields are read **after** the signature verifies, and each is strictly shaped (lowercase UUIDs, 10-digit times, 16-hex id, 43-character base64url signature). Unknown, extra or missing parts are refused.
  The signature is compared as its canonical text with `timingSafeEqual`, against every configured secret, so a wrong credential costs the same work whatever is wrong with it.
- A credential lasts **90 days** by default and never more than 400. It is unrelated to the profile API key: nothing derives one from the other.

A known-answer test (`tests/hermes-business-mcp-credential.test.ts`) pins the format to an independent computation, so it cannot change without the test saying so.

## What the endpoint checks, in order

1. **Switch.** `HERMES_BUSINESS_MCP_ENABLED` off: a plain 404 before anything is read.
2. **Signature, shape, expiry, lifetime, clock, revocation list.** Pure computation, no database. Failure: 401 (or 429, below). A value nobody can attribute is only counted, never logged.
3. **The application's own records.** The employee row named in the credential must still match every claim: same workspace, same role, same profile, enabled, the workspace active and the
   internal agency workspace, and its saved Hermes credential and reference not revoked. A credential this server signed but cannot honour (expired, ended by id, employee no longer active) writes
   one `hermes.business_mcp.auth_denied` audit entry to the employee's workspace: reason, role and the credential's **id** only.
4. **Rate limit.** Failures count against the client address (30 per 10 minutes, then 429 with `Retry-After`); a valid credential is never counted against an address that is failing. Calls count per employee (60 a minute).
5. **The employee's own live Chat turn.** Exactly one running Chat turn for that employee, started under 20 minutes ago, on its active configuration, with a passing connection check, an unrevoked
   Hermes credential and a current tool-inventory proof. **Holding a valid credential alone reads nothing.** The turn, and so the person, is chosen by the server, never by the caller.
6. **The people boundary.** The person whose turn it is must still be an active member of the workspace with `agents.use`, and an iAcquire **Super Admin**. The same guard (`assertWorkforceWorkspaceAccess`) applies
   to the context tool and, since this change, to every CRM tool: before, only the context tool checked it.
7. **Tool permissions.** The role's allowlist, intersected with the person's own permissions, intersected with the employee's configuration. Tools outside the role do not exist for that employee.
8. **Operating mode.** CRM tools go through the automation gate (an employee in `paused` mode, an agency pause or an inactive workspace refuses them). The context snapshot follows the Chat rule: private Chat
   stays available to a paused employee (`src/server/automation/gate.ts`).
9. **A one-minute tool token** (the existing `crm_agent_tokens`) carries each CRM call and is revoked in `finally`; writes are not offered at all while `HERMES_BUSINESS_MCP_WRITES_ENABLED` is off, and
   with it on they can only create approval requests.
10. **Audit.** Every read or refusal writes `tool_executions` and `hermes.business_mcp.*` entries carrying the credential id (`jti`), never the credential.

Nothing in this design is new infrastructure: it reuses the Hermes credential rows, the run gate (`runtimeReadySql`), the tool tokens, the automation gate, the audit log and the rate limiter.

## Revocation and rotation

| Lever | Scope | Takes effect |
| --- | --- | --- |
| `HERMES_BUSINESS_MCP_ENABLED=false` | the whole endpoint | next deployment (404) |
| Change `HERMES_BUSINESS_MCP_SECRET` | every credential it signed | next deployment |
| Add the id to `HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS` | one credential | next deployment |
| Disable the employee, suspend the workspace, revoke its saved Hermes credential, change its profile mapping | one employee | **immediately** (read from the database on every request) |
| End or pause the Chat turn; 20-minute turn limit; expired inventory proof | one turn / one employee | **immediately** |
| Credential expiry | one credential | at its end time |

**Rotating the secret without downtime:** set `HERMES_BUSINESS_MCP_SECRET_PREVIOUS` to the old value and `HERMES_BUSINESS_MCP_SECRET` to the new one (deploy; both verify); issue new credentials
and install them; remove `HERMES_BUSINESS_MCP_SECRET_PREVIOUS` (deploy; the old ones now fail). To end everything at once, change the secret without a previous one.

The environment checks (`src/server/env.ts`) refuse to start when the endpoint is on without a secret, when the secret is shorter than 32 characters or contains whitespace, when it equals any other secret
in the deployment (the message names the other variable, never a value), when the previous secret equals the current one, or when the revoked-id list is malformed.

## Replay and what is left

A bearer credential is, by nature, replayable by anyone who holds it. What bounds that here: TLS only; the credential opens one endpoint; it expires; a single one can be ended by id; the endpoint
will not answer without that employee's own live Chat turn run by a Super Admin, so a stolen credential used at any other time reads nothing; the server, not the caller, picks the turn; every
refusal of a signed credential is audited; failures from one address are limited. What a thief could do **during a live turn** is ask for the same read-only business information that turn's person is
entitled to. Source-address pinning (the gateway's address) would narrow that further and is a recommended hardening once the gateway's egress address is confirmed; it is not implemented because the
address is not recorded in the repository.

## Issuing, installing and checking credentials (operator procedure; needs the founder's approval)

Nothing below is run by the application, and none of it has been run against production.

1. Generate the secret on a trusted machine (`openssl rand -base64 48`) and set it as `HERMES_BUSINESS_MCP_SECRET` in the server environment **before** `HERMES_BUSINESS_MCP_ENABLED` is switched on.
2. Issue credentials to a private directory, with the secret read from a file so it is not in a shell history:
   ```bash
   npm run hermes:business-mcp-token -- issue --all --out <private directory> --secret-file <file holding the secret>
   ```
   The script writes one file per employee (`iacquire-<role>.env`, one line, `IACQUIRE_BUSINESS_MCP_TOKEN=<credential>`) with mode 0600, never overwrites a file, and prints only the role, the credential id,
   the expiry and the file name. Windows ignores file modes, so on Windows choose a directory only you can read. `--all` reads the six employees from the database in `DATABASE_URL` (a read-only query); the single-employee form (`--role --agent --org`) needs no database.
3. Move each file to its profile's own `.env` through the approved host procedure and delete it here. Add the `mcp_servers` entry to the profile configuration only in the A4 stage (the provisioning
   preview shows the entry with `Authorization: "Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}"`; it never contains a value).
4. Check a file offline at any time: `npm run hermes:business-mcp-token -- verify --file <file> --secret-file <file>` (prints validity, role and expiry; never the credential).

## Tests

- `tests/hermes-business-mcp-credential.test.ts`: format, known answer, tamper matrix, malformed matrix, domain separation, expiry, lifetime, clock, revocation, rotation, environment contract, and guards
  that the secret is read only by the environment schema and the credential module and never appears in browser-facing code, prompts, the handler or the script's output.
- `tests/hermes-business-mcp-auth.test.ts`: against a seeded database and the real handler: valid and invalid credentials, the old profile key refused, wrong role/employee/workspace, altered, expired,
  revoked and rotated credentials, disabled and suspended employees and workspaces, revoked Hermes credential, a re-mapped profile, no turn, another employee's turn, wrong kind of turn, stale, doubled and
  out-of-date turns, expired inventory proof, a non-Super-Admin and a removed member (context tool and CRM tool), replay after the turn ends, tool lists per role, unauthorized and write tools, operating
  mode and agency pause, the failure limit, the credential not opening the tool API or the gateway, and nothing credential-shaped in any table or log. Every refusal also asserts **no side effects**.
- Mutation checks (removing each protection in turn) were run once to confirm these tests fail without it; two database predicates are redundant with other layers and cannot be isolated (a client's
  employee cannot carry an internal profile name, `reserved_hermes_profile`, and only one agency workspace can exist, `organizations_single_agency`).

No database migration is required. If per-credential issue records or one-click revocation in the admin screens are wanted later, a small `hermes_business_mcp_credentials` table (credential id, employee,
issued/expires/revoked times, no secret) would add them; it is **not** proposed for this phase, and would have to be rehearsed on a disposable database and left unapplied until separately approved.
