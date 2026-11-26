# Tahakkum architecture (MVP skeleton v0.1)

## Components
- `src/server.js` - Node stdlib HTTP server: JSON API, session cookies, static hosting for the dashboard build. No npm install required for the skeleton.
- `src/store.js` - libsql (SQLite) persistence behind a synchronous in-memory API; local file DB by default, Turso cloud SQLite when TURSO_URL/TURSO_TOKEN are set (cardless free tier, host-independent). One dependency: @libsql/client. - JSON-file store (`data/tahakkum.json`). Collections: users, brands, platform_accounts, orders, order_items, menu_items, payouts, ratings, sessions, sync_jobs, audit_log. Migration path: PostgreSQL, one table per collection, `tenant_id`/`brand_id` scoping preserved.
- `src/vault.js` - AES-256-GCM credential encryption; master key from `MASTER_KEY` env only. Passwords hashed with scrypt. Credentials are write-only through the API and never read back or logged.
- `src/seed.js` - owner account + demo brands/orders so a fresh server is demoable immediately.
- `src/connectors/index.js` - one interface per platform (`login / fetchOrders / fetchMenu / pushMenuUpdate / fetchPayouts / fetchRatings`). Five platforms return `connector_not_implemented` stubs; HungerStation can switch to the official API connector with HS_OFFICIAL=1.
- `src/connectors/hungerstation-api.js` - official HungerStation Partner API v2 connector: OAuth2 Client Credentials, Bearer token cached in memory for 100 minutes, chainID-scoped orders GET (60-day window). UNTESTED against the live API: requires approved partner access (client_id/secret from the Partner Portal Shop Integrations plugin). Base URL and paths are env-configurable (HS_API_BASE, HS_TOKEN_PATH, HS_ORDERS_PATH) pending confirmation from the OpenAPI spec at developer.hungerstation.com.
- `src/connectors/toyou-api.js` - official ToYou Public API connector: merchant login/password exchanged for a Bearer token (POST /catalog/v1/merchantuser/authtoken on app.toyou.delivery), orders via GET /publicorders/v1/orders. Enabled with TY_OFFICIAL=1. UNTESTED: grounded in ToYou's official sample client (archived 2021), so field mapping needs verification against a live, consenting merchant account.
- `src/connectors/portal.js` - Playwright login skeleton for portal automation. UNTESTED; selectors must be mapped with a real merchant account per portal.

Version 0.6.0 swaps JSON-file persistence for libsql/Turso (enables free no-card hosting without a persistent disk). Version 0.5.0 added the ToYou official connector behind TY_OFFICIAL=1. Version 0.4.0 added the HungerStation official connector behind HS_OFFICIAL=1 and passes a readSecret callback into connectors so vault decryption stays inside the app.
- `src/scheduler.js` - pulls active accounts every 10 minutes, records sync_jobs, marks an account `broken` after 3 consecutive failures.

## Data flow (target)
merchant enters portal credentials -> API encrypts into vault (audit logged) -> scheduler runs the platform connector -> normalized rows in orders/menu/payouts -> dashboard API aggregates per brand -> Tahakkum front-end renders.

## What works today (tested locally, 26 Nov 2026)
- login/logout with scrypt-hashed owner password, HttpOnly session cookie
- per-brand dashboard aggregation from stored orders
- storing a platform credential: encrypted at rest, masked in every API response, audit log entry written
- unauthenticated API access blocked
- scheduler runs and records stub failures without crashing

## What is NOT built or NOT tested
- every connector: no real portal or official API has been called; needs real merchant credentials and, for official APIs, approved partner access
- merchant role isolation: `tenant_id` scoping on users exists but the UI and role tests are not done
- menu sync, payouts, ratings endpoints
- HTTPS (terminates at Caddy in the deployment guide), rate limiting, TOTP for users, 2FA/captcha flows for portals
- the front-end: `public/index.html` is a placeholder; the demo dashboard gets ported to call these APIs
- scale: JSON store is single-writer; move to PostgreSQL before multiple staff use it

## Security notes
- `MASTER_KEY` lives only in the server environment (`/etc/tahakkum.env`, chmod 600). Losing it makes stored credentials unrecoverable; leaking it exposes them. Back it up offline.
- The JSON data file contains ciphertext, not plaintext credentials.
- Never run the API on plain HTTP outside localhost.

## v0.3 (26 Nov): merchant permissions
- POST /api/admin/merchants (owner only) creates a merchant login plus their brand in one call.
- Merchants see only their own brands; dashboard and platform-accounts of other tenants return 403.
- Demo brands stay under the owner account.
