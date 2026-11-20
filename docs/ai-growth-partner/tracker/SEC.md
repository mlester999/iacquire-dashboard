# SEC — Security and data privacy

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

**Detailed findings for this domain are withheld from this public repository.** This repository is public, and unresolved security findings are kept in a private report until they are fixed. The table below carries only identifiers, titles, status and priority.

| ID | Item | Status | Priority |
| --- | --- | --- | --- |
| GP-SEC-01 | Tenant isolation: database layer (RLS, grants, composite tenant FKs) for the Growth Partner tables | IMPLEMENTED — NOT YET VERIFIED | P0 |
| GP-SEC-02 | Tenant isolation: application layer relies on 1,967 RLS-bypassing withSystem call sites (High, systemic) | PARTIAL | P1 |
| GP-SEC-03 | Tenant isolation: Growth Partner memory retrieval, goals, legacy knowledge, shared thread, schedules, tools and notifications | IMPLEMENTED — NOT YET VERIFIED | P0 |
| GP-SEC-04 | Server-side authorization of high-impact Growth Partner actions (chat proposals, CRM changes, approvals) | IMPLEMENTED — NOT YET VERIFIED | P0 |
| GP-SEC-05 | OAuth tokens and secrets: storage, leakage scan of tracked files, client-bundle and error-serializer safety | IMPLEMENTED — NOT YET VERIFIED | P0 |
| GP-SEC-06 | Prompt-injection resistance: untrusted web pages, prospect and customer text, retrieved documents, saved memory | PARTIAL | P1 |
| GP-SEC-07 | Web read plus private-data read in the same Growth Partner runtime has no egress or exfiltration control (High) | PARTIAL | P1 |
| GP-SEC-08 | Idempotency: retries cannot duplicate CRM records, bookings, payments, approvals or outreach | PARTIAL | P1 |
| GP-SEC-09 | Audit trail: meaningful actions and denials recorded without sensitive content | IMPLEMENTED — NOT YET VERIFIED | P1 |
| GP-SEC-10 | Unauthorized outreach safeguards: consent, suppression, human takeover, and no-contact status of researched leads | IMPLEMENTED — NOT YET VERIFIED | P0 |
| GP-SEC-11 | Data privacy baseline: consent capture, retention rules and what exists versus what is missing | PARTIAL | P1 |
| GP-SEC-12 | Data export omits the Growth Partner tables (Medium) | NOT STARTED | P1 |
| GP-SEC-13 | Per-contact erasure does not reach Growth Partner surfaces (Medium) | PARTIAL | P1 |
| GP-SEC-14 | Privacy and breach-response artifacts that engineering can draft now: breach runbook, data map, sub-processor inventory, notices | NOT STARTED | P0 |
| GP-SEC-15 | Legal sign-off and registrations: counsel review, NPC/DPO position, signed processor agreements per market | EXTERNALLY BLOCKED | P0 |
| GP-SEC-16 | Rate limiting: auth, expensive AI endpoints, discovery, public links, automation execution | IMPLEMENTED — NOT YET VERIFIED | P1 |
| GP-SEC-17 | Client address for rate limits and audit hashes is derived in about 15 places from the first X-Forwarded-For entry (Low) | PARTIAL | P2 |
| GP-SEC-18 | No multi-factor authentication for Super Admin, agency staff or client owners in application code (High) | NOT STARTED | P1 |
| GP-SEC-19 | Operational safeguards: monitoring, structured errors, controlled retries, recovery | PARTIAL | P1 |
| GP-SEC-20 | Public repository discloses infrastructure details and an host-exposure finding (High) | NOT STARTED | P0 |
| GP-SEC-21 | Hermes gateway host hardening (network exposure, remote-access and profile-mount hardening) | EXTERNALLY BLOCKED | P0 |
| GP-SEC-22 | GitHub Actions and repository governance: workflows are well pinned; scanning, dependency updates and PR CI are missing | PARTIAL | P2 |
| GP-SEC-23 | Dependency vulnerabilities: two moderate transitive advisories (hono, @hono/node-server via the MCP SDK) | PARTIAL | P2 |
| GP-SEC-24 | Shared permanent Partner thread: every working-role member reads it, and it is excluded from chat retention (Low/Medium privacy) | PARTIAL | P2 |
| GP-SEC-25 | Independent security verification of the Growth Partner build: no review since 2026-10-26, hosted RLS check and penetration test not done | NOT STARTED | P1 |
| GP-SEC-26 | Transport and browser hardening: CSP with nonces, framing, cookies (confirm HSTS at the host) | IMPLEMENTED — NOT YET VERIFIED | P2 |
