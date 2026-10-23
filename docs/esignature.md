# Electronic signatures for proposals (Phase 5B)

Status: **built and verified locally** (embedded Postgres, an in-process stand-in signing service, and a replaced HTTP layer for PandaDoc). Nothing has run against a real signing service, nothing is applied to a hosted database, and no workspace has it switched on. Migration `0092_esign.sql` (rollback in `supabase/rollbacks/`) depends on `0091_proposals.sql`.

## What it is

A business that sends a proposal asking for a signature can ask the customer to sign it through **the business's own signing account** (PandaDoc is the first and only adapter). The signing service emails the signer; iAcquire does not. A signature is believed only when the service says so: a webhook signed with that connection's own key, or a status read with the same key. Only then does the proposal become accepted, and the decision is recorded with the method `provider_signature`, the request it came from and the fingerprint of the exact version that was signed.

It is not a signing product of iAcquire's. iAcquire never signs for anyone, never holds the signature, and never describes a typed name, a checkbox or an emailed code as an electronic signature. The wording a counsel must approve before any real use is the business's own terms and the acknowledgement text (`src/lib/proposals/ack.ts`); this module adds none.

## Where things are

| Area | Files |
| --- | --- |
| Tables, permission, rollback | `supabase/migrations/0092_esign.sql`, `supabase/rollbacks/0092_esign.down.sql` |
| Pure rules (states, when a signature is applied, why a request is blocked, errors, history wording, PandaDoc wire format, multipart) | `src/lib/esign/*` |
| Provider seam, stand-in service, PandaDoc adapter, HTTP helper for bytes | `src/server/esign/providers/*`, `src/server/esign/http.ts` |
| Connection (sealed keys), requests, worker, applying a fact, maintenance, notice route | `src/server/esign/{connections,requests,worker,apply,lifecycle,maintenance,webhook,webhook-token}.ts`, `src/app/api/webhooks/esign/[connectionToken]/route.ts` |
| Screens | the Signature tab (`src/components/proposals/signature-panel.tsx`), the connection card on `/proposals/settings` (`signing-connection-card.tsx`), mentions on the Delivery tab and in the actions |
| Scheduler | job `esignSync` (`docs/production-scheduler.md`) |
| Tests | `tests/esign-*.test.ts(x)` and the shared fixtures in `tests/support/proposals.ts`, `tests/support/esign-screens.ts` |

## The rules it keeps

- **Dormant until switched on.** A Super Admin turns on `proposals` and `esign` (`org_features`, `setOrgFeature`) per workspace. Nothing is read or written for a workspace that has not.
- **Two switches before a real service is written to.** The workspace's `esign` feature and the environment's `ESIGN_WRITES_ENABLED` (off by default). The stand-in needs neither, reaches nothing, and is refused in production.
- **The client's account, the client's keys.** Only the owner or a manager (`proposals.connect`) connects it; the agency never does. The API key and the shared webhook key are checked with the service, sealed (AES-GCM) in a column the application role cannot read, and never returned to a browser, a server-action result, an audit row, a notification, an export or a log. The webhook address carries a secret path token derived from a server key (so it can be shown again) and stored only as a hash.
- **Nothing is signed on a guess.** A request is made for one *sent* version, locked to its content fingerprint and the SHA-256 of its stored PDF. The worker checks the PDF against that hash before anything leaves. A signature is applied only if the proposal is still sent, on that very version, unanswered, in date and intact; otherwise the service's fact is kept and set aside with a plain reason (superseded, withdrawn, expired, already answered, proposal closed, integrity) and the team is told.
- **Never twice.** One live request per version (a database index), leases, an idempotency key, the intent written before any call that could make a document, and a lost answer is *checked* with the service, never repeated. A notice is applied once however often it is delivered.
- **Every way a proposal ends ends the ask:** a revision (the request becomes "replaced"), a withdrawal, a person recording the answer, the valid-until date passing, the customer declining on the page, a privacy request, disconnecting, closing the workspace.
- **Honest states.** "Simulated" is said wherever the stand-in is involved; "Sandbox" for a test account; a real connection whose sending is off here says so; a signed copy that could not be fetched says where to get it.
- **Consent.** The service writes to the signer on the business's behalf, so the opt-outs and revoked email consent the message chain honours are honoured before a request is made.

## Switching it on (needs the founder's approval at each step)

1. Apply `0091_proposals` and `0092_esign` to the hosted database one at a time, with a backup and a dry run (`scripts/rehearse-combined-migrations.mjs` is the rehearsal; nothing was applied by this work).
2. Create a PandaDoc **sandbox** account and a test API key; add the notice address (shown on `/proposals/settings` after connecting) and note the shared key PandaDoc shows.
3. Re-read PandaDoc's current API reference against `src/lib/esign/pandadoc.ts` and `src/server/esign/providers/pandadoc.ts` (the list below).
4. In a staging or local environment only: `ESIGN_WRITES_ENABLED=true`, connect the sandbox key, ask for a signature on a test proposal, sign it in PandaDoc, and watch the notice arrive (a public tunnel URL is needed for the notice; without one the safety-net read applies it within about fifteen minutes).
5. Only then consider a live account for a real client, with counsel's wording approved and the entitlement placement decided.

## PandaDoc: what was written from memory and must be re-read before any use

Everything below is what the audit and the author remember of PandaDoc's public API reference; **none of it has been tried against PandaDoc**. The adapter is labelled unexercised in its code and in `tests/esign-pandadoc.test.ts`.

- The key goes in an `Authorization: API-Key <key>` header; the origin is `https://api.pandadoc.com`.
- A PDF is uploaded as multipart (`file` and a JSON `data` part naming the recipient, the metadata and the fields) to `POST /public/v1/documents`; the document is made asynchronously (`document.uploaded`, then `document.draft`); `POST /public/v1/documents/{id}/send` asks the recipient to sign (a `409` is read as "not ready yet"); `GET /public/v1/documents/{id}` reads the status; `GET /public/v1/documents/{id}/download` returns the PDF.
- The shape of the signature field (`signatureFields` in the adapter) is a guess and is the least certain part: its page, coordinate origin and size.
- Statuses: `document.sent`, `.viewed`, `.completed`, `.declined`, `.expired`, `.voided`. PandaDoc's own approval and payment statuses are deliberately not read as signature facts.
- A notice is remembered as a JSON array of `{ event, data: { id, status, date_modified } }` signed with HMAC-SHA256 under the shared key, the hex digest in a `signature` query parameter of the notice address; only `document_state_changed` makes a statement about the document. The notice carries no event id of its own, so one is made from what it says.
- There is no call iAcquire can make to withdraw a document (the only one remembered deletes it), so withdrawing a request asks the business to withdraw it in PandaDoc, and a signature that arrives for it is not applied.
- The completion certificate is not downloaded (its address was not remembered with confidence); the signed copy is.
- Plan and pricing requirements for API use are unknown here; the account and its cost are the client's.

## Trying it in a browser (local QA)

`node scripts/run-inbox-qa-seed.mjs`, then `node scripts/run-proposals-qa-seed.mjs` (QA server stopped). The seed connects the stand-in service and makes three signing stories (P-0016 signed end to end, P-0017 sent and not yet asked, P-0018 asked and waiting). On a proposal's **Signature** tab the stand-in's controls hand a request over and play the signer; what comes back goes through the same signed notice route a real service would use. The stand-in forgets its documents when the server restarts. An existing QA database seeded before this existed gets only the three signing stories added, once.

## What is not verified

- Anything against a real PandaDoc (the list above), including that its sandbox accepts the upload, places the field where intended and delivers the notice the way `parseWebhookBody` reads it.
- The Next build of the new pages and route, the screens in a browser (375 and 1280 pixels, light and dark, focus, axe), and the clipboard copy of the notice address.
- Behaviour under real database contention and on a hosted Postgres (the combined rehearsal is embedded Postgres).
- That the scheduler's tick has the time for a pass on the hosting plan (a pass is capped at 25 seconds).

## Founder decisions this needs

Whether e-signature sits in the implementation, behind the US$299 plan, or per workspace; counsel-approved acknowledgement and terms wording and what may be said about enforceability; the retention and erasure policy for signed records (today: a privacy request ends open requests and keeps signed records and the signing history, and says how many it kept); whether each client connects its own account (built) or iAcquire runs one master account (not built); a PandaDoc sandbox account and key, and either a public tunnel for notices or polling-only testing.
