# Notion and Airtable workspace imports

Workspace owners and admins with knowledge access manage the connection from **Settings → Integrations**. Each provider holds one authorization and one selected source per iAcquire workspace. The grant dialog is where the owner selects a Notion workspace and pages or shares Airtable bases.

## Provider registration

Use the canonical TLS portal origin in APP_URL. Each provider shows **Requires setup** until both of its server-only registration settings are present. Registration, environment changes, and live tests require the owner's approval.

- **Notion** uses a public connection and redirect URI <APP_URL>/api/integrations/workspace-oauth/notion/callback. Enable **Read content** and select **No user information**. Use NOTION_WORKSPACE_OAUTH_CLIENT_ID and NOTION_WORKSPACE_OAUTH_CLIENT_SECRET. [Notion authorization](https://developers.notion.com/guides/authorization/overview) · [Notion capabilities](https://developers.notion.com/reference/capabilities)
- **Airtable** uses an OAuth integration with a client secret and redirect URI <APP_URL>/api/integrations/workspace-oauth/airtable/callback. Register schema.bases:read and data.records:read. Use AIRTABLE_WORKSPACE_OAUTH_CLIENT_ID and AIRTABLE_WORKSPACE_OAUTH_CLIENT_SECRET. Existing metadata-only grants can still be verified. Reconnect to grant record reads. [Airtable OAuth reference](https://airtable.com/developers/web/api/oauth-reference) · [List bases](https://airtable.com/developers/web/api/list-bases)

Keep the same iAcquire workspace and signed-in browser session throughout authorization. The link expires after ten minutes. Configure infrastructure access logs to omit the callback query string. Set the provider's required distribution details before requesting a test authorization.

## Import and review

1. Find shared Notion pages or data sources by title. In Airtable, choose a shared base, table, and up to eight supported fields. Field IDs keep the selection intact when names change. The next sync reports removed or unsupported mapped fields.
2. Select **Import for review**. The workspace keeps the time, provider resource selection, record IDs, and version fingerprint. Sync reads up to 100 records and accepts up to 12,000 characters. Notion page imports use accessible Markdown text and refuse incomplete responses. Notion data sources use title and rich-text properties. Files, attachments, linked records, and transcripts are excluded.
3. Open **Review snapshot** and approve or reject the saved text. Potentially unsafe instructions prevent approval. An approved snapshot can supply source-labeled reference material to internal Growth Partner runs within their existing context budget. Confirmed Business Brain facts and customer-facing replies retain their existing rules and approved data.
4. Select **Sync now** to check for changes. All sources are fetched within the import limits. Only a changed normalized snapshot creates a new version. Airtable and Notion data-source imports reconcile complete bounded listings. Changing the selected source withdraws the prior reference. Newly changed content goes back through review. A successful sync that identifies a deleted row, an unavailable source, or an invalid field mapping withdraws affected approved content from retrieval. A failed partial read does not classify individual records as deleted. Notion pages reported as incomplete are withdrawn from retrieval pending a complete sync and fresh approval.

Sync runs on demand. Last successful sync and provider errors are reported on the card. Rate-limited requests follow the provider's retry window. Connection management and imports share a tenant-scoped lease so that they cannot race token rotation.

## Connection recovery and data handling

**Verify connection** checks provider authorization on demand. Provider tokens are encrypted and scoped to a workspace and provider. An inconclusive refresh asks for a new authorization because the provider may already have rotated the token. Audit records store the actor and outcome without credentials or imported text.

**Disconnect** clears the portal's credentials, removes pending authorization, and withdraws its reference from Growth Partner use. Notion can confirm access-token revocation. Airtable grant revocation is available in Airtable under **Integrations → Third-party integrations**. Reconnection requires another review of the retained source before it can be used again. [Notion token revocation](https://developers.notion.com/reference/revoke-token) · [Manage Airtable OAuth grants](https://support.airtable.com/articles/6811769763-Third-party-integrations-via-OAuth-overview)

Migrations 0143_workspace_oauth_connections and 0146_workspace_knowledge_sources use tenant-bound private tables. Their rollback scripts preserve durable connection and review history by refusing to drop populated tables.

## Provider acceptance

**EXTERNALLY BLOCKED.** The production-bound implementation has local mocked-provider coverage. For live acceptance, obtain approval for app registrations, both test credentials, and disposable grants from one empty provider workspace per integration. Seed only fictional content. Request no more than 24 HTTP calls per provider for a run covering authorization, refresh, discovery, initial import, approval, update, deletion, and disconnect. Accept requests only to api.notion.com, airtable.com, and api.airtable.com as appropriate for each provider. The owner can inspect the consent scopes before enabling the test grants. Record provider results and revoke the disposable grants after the run.
