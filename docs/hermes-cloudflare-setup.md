# Hermes gateway and Cloudflare Access setup

This is an operator runbook for the planned `hermes-api.iacquire.online` endpoint. The hostname is
allowlisted in the portal, but the Cloudflare nameserver cutover, Tunnel, Access application and
Hermes API route have not been verified by this repository change. Do not report the endpoint as
connected until the checks below pass.

## Before making DNS changes

1. Confirm you control the correct Cloudflare account and the `iacquire.online` zone.
2. Export or record the current DNS zone at the registrar/authoritative DNS provider. Compare every
   website, mail, verification and subdomain record with the Cloudflare zone, including MX, SPF,
   DKIM, DMARC, CAA and any proxy settings.
3. Keep the current DNS provider serving the domain while you review the imported records. Use the
   exact nameservers Cloudflare assigns to this zone; they are account-specific. Do not copy sample
   nameservers from another account or remove existing records as part of this application change.
4. Schedule the nameserver cutover only after the record comparison is complete and the owner has
   approved the DNS change. Confirm the current site, mail and critical subdomains resolve after
   delegation. Nameserver activation is a separate infrastructure change from deploying this code.

Cloudflare's locally managed Tunnel setup requires the domain to be on Cloudflare before routing a
public hostname. For a safer controlled rollout, complete the zone review before the registrar
delegation and then add the API route after the tunnel origin is ready.

## Create the service-to-service Access policy

1. In Cloudflare Zero Trust, create a **Self-hosted** Access application for the exact hostname
   `hermes-api.iacquire.online`.
2. Add a **Service Auth** policy. Its Include rule should select only the dedicated service token
   created for the iAcquire Vercel backend. Do not add an `Everyone` or bypass policy.
3. Create a Cloudflare Access service token. Save its Client ID and Client Secret in an approved
   password manager until they are entered in the portal. Cloudflare exposes the secret only when
   it is created or rotated.
4. Set a documented expiry and calendar reminder to rotate the token before it expires. Do not reuse
   a personal token or a token shared with another application.

Cloudflare Access uses the `CF-Access-Client-Id` and `CF-Access-Client-Secret` request headers. The
Hermes profile's `API_SERVER_KEY` is a second, independent credential sent as
`Authorization: Bearer <profile-key>`.

## Route the Tunnel to the existing Hermes listener

1. Inspect the existing Hostinger VPS and Cloudflare Tunnel before installing or restarting anything.
   Confirm which `cloudflared` process/service is already supervised and whether a tunnel already
   exists. Do not start a duplicate process or restart the Hermes gateway as part of this setup.
2. On the VPS, verify the installed Hermes version and the API listener locally. Confirm the API
   responds on loopback at port `8642`; the previously reported `127.0.0.1:8642` address is not
   proof that the listener is currently present. Confirm a real profile's authenticated
   `/p/<profile>/v1/capabilities`, `/p/<profile>/v1/toolsets` and
   `/p/<profile>/v1/tools?platform=api_server` routes work before publishing it. The last route is
   required for the portal's complete-inventory gate and is absent from Hermes 0.21.5.
3. In the existing Tunnel's published application routes, map hostname
   `hermes-api.iacquire.online` to `http://127.0.0.1:8642` only after the listener is confirmed.
   Keep the origin listener bound to loopback/private access; do not open port `8642` directly to
   the public internet. Preserve the tunnel's final catch-all 404 route.
4. Prefer the current tunnel's existing supervisor. If none exists, install one supervised
   `cloudflared` service using Cloudflare's documented Linux service procedure. Store its tunnel
   credential file with restrictive ownership and permissions. Do not copy tunnel tokens into
   this repository, Vercel settings, chat, or logs.
5. Create the hostname route through Cloudflare's Tunnel configuration. Verify Cloudflare created
   the route to that tunnel rather than an unrelated public A/AAAA record.

Cloudflare recommends running `cloudflared` as a service on Linux so it starts at boot. If service
installation requires `sudo`, use the explicit config path when the configuration lives under a
non-root user's home directory.

## Configure the iAcquire deployment

1. Apply `supabase/migrations/0034_hermes_gateways.sql` to the approved Supabase project through the
   normal reviewed migration process. This repository does not apply hosted database migrations.
2. Confirm managed Supabase Vault is available. Configure the deployed backend with
   `SECRET_STORE=vault`; the application cannot save Access or profile keys without a working secret
   store.
3. Keep `ALLOW_INSECURE_HERMES_URLS=false` in production. The built-in exact-host allowlist already
   includes `hermes-api.iacquire.online`. Any additional host must be approved by deployment owners
   in `INTEGRATION_ALLOWED_HOSTS` as an exact host (and port if present), with no scheme or path.
4. In **Admin → Integrations → Add Hermes gateway**, enter the gateway label, environment, exact
   HTTPS URL, and gateway type. Enter both Access service-token values in the secure authentication
   step. They are stored server-side in Vault. A reported gateway ID or Hermes version is only an
   operator note until the endpoint can prove it.
5. In **Admin → AI Workforce**, map each of the six existing iAcquire profiles to its intended role.
   Copy identifiers from the Hermes administrator's profile list; do not guess, recreate, clone or
   rename an existing agency profile. Enter each profile's own API key. The portal stores each key
   separately in Vault.
6. Test the gateway. It remains `Needs attention` until all six agency profiles pass their own
   authenticated read-only identity, capability and tool-safety checks. The gateway API currently
   does not report the installed package version, so a manually entered version remains unverified.

## Verify access without exposing secrets

Use a protected VPS shell or approved secret injection. Do not enable shell tracing (`set -x`), paste
keys into tickets, put credentials in URLs, or include request headers in logs. Supply the profile
key and Cloudflare service token from a secure secret store as environment variables, then check
HTTP status only:

```sh
# No Access service-token headers: expect Cloudflare Access to deny or redirect the request.
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  'https://hermes-api.iacquire.online/p/<PROFILE>/v1/capabilities'

# With both Access headers but no Hermes Authorization header: Access may pass, Hermes must reject.
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  --header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  'https://hermes-api.iacquire.online/p/<PROFILE>/v1/capabilities'

# With both Access headers and that profile's Hermes key: expect HTTP 200 and a valid capabilities body.
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  --header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  --header "Authorization: Bearer $HERMES_PROFILE_API_KEY" \
  'https://hermes-api.iacquire.online/p/<PROFILE>/v1/capabilities'
```

Repeat the authenticated check using each profile's own key and exact profile route. A `200` from
one profile does not prove that another profile exists or that its key is valid. Then use the portal
gateway test and verify all six role rows. The portal test is read-only and does not start an AI run.

## Rollback and recovery

- If website, mail or other DNS records fail after nameserver delegation, restore the registrar's
  previous nameserver values while the DNS owner investigates. Do not delete the old zone until the
  rollback window has passed.
- If Access denies the intended service token, verify the Access application hostname, Service Auth
  policy Include rule, token state and Vercel secret values. Do not disable Access as a workaround.
- If Access succeeds but Hermes rejects the request, check the profile route, API server settings,
  and that profile's own `API_SERVER_KEY`. Rotate only the affected credential through the approved
  process.
- If the origin or tunnel is unhealthy, use the existing service's status/logging process and restore
  its last known-good configuration. Avoid launching a second `cloudflared` process or restarting
  Hermes until the Hostinger operator has confirmed the impact.
- A gateway can be disconnected in **Admin → Integrations** to revoke portal use. This does not
  revoke Cloudflare's service token or Hermes profile keys at their source; revoke those separately.

## Current readiness boundary

The portal now has a multi-gateway registry, separate Cloudflare and profile credentials, six-role
agency mapping, and read-only profile health checks. The live Hostinger and Cloudflare environment
has not been tested by this code change. Automatic six-profile client provisioning is not ready:
the upstream profile-creation flow is documented as a Hermes CLI operation, and this app has no
restricted provisioning service. Client profiles must not be marked Ready or created automatically
until a separately authenticated, idempotent provisioning service and tenant-isolation tests exist.

## Operator references

- [Cloudflare: create a locally managed tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)
- [Cloudflare: Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/)
- [Cloudflare: run Tunnel as a Linux service](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/linux/)
- [Hermes Agent: profile commands](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/profile-commands.md)
- [Hermes Agent: profile management](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md)
