// HungerStation official Partner API v2 connector. UNTESTED: requires approved
// partner access. Grounded in developer.hungerstation.com (26 Nov 2026):
//   - OAuth 2.0 Client Credentials; client_id + client_secret are generated in
//     the Partner Portal (Shop Integrations Plugin section of All Settings) or
//     via the account manager.
//   - access_token is a Bearer token valid for 2 hours; this connector caches
//     it in memory and refreshes at 100 minutes.
//   - Endpoints are scoped by chainID (from the account manager or the Shop
//     Integrations plugin URL). GET retrieves orders from the past 60 days;
//     PUT modifies orders.
// Exact base URL and paths must be confirmed against the downloadable OpenAPI
// spec on developer.hungerstation.com/api-specifications once partner access
// is granted; they are configuration, not assumptions baked into logic.

const HS_API_BASE = process.env.HS_API_BASE || 'https://partner-api.hungerstation.com'; // TODO: confirm from OpenAPI spec
const TOKEN_PATH = process.env.HS_TOKEN_PATH || '/oauth/token';                          // TODO: confirm
const ORDERS_PATH = process.env.HS_ORDERS_PATH || '/v2/chains/{chainId}/orders';         // TODO: confirm

let tokenCache = { token: null, expiresAt: 0 };

async function getToken(clientId, clientSecret) {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
    let res;
    try { res = await fetch(HS_API_BASE + TOKEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
        } catch { return null; }
    if (!res.ok) return null;
    const body = await res.json();
    tokenCache = { token: body.access_token, expiresAt: Date.now() + 100 * 60 * 1000 };
    return tokenCache.token;
}

// account fields: username holds the chainID; vault holds "client_id:client_secret".
export function hungerstationApi() {
    return {
        platform: 'hungerstation',
        async login(account, { readSecret }) {
            const [clientId, clientSecret] = (await readSecret(account)).split(':');
            const token = await getToken(clientId, clientSecret);
            return token ? { ok: true } : { ok: false, reason: 'auth_failed' };
        },
        async fetchOrders(account, { readSecret, since } = {}) {
            const [clientId, clientSecret] = (await readSecret(account)).split(':');
            const token = await getToken(clientId, clientSecret);
            if (!token) return { ok: false, reason: 'auth_failed', orders: [] };
            const path = ORDERS_PATH.replace('{chainId}', encodeURIComponent(account.username));
            const url = new URL(HS_API_BASE + path);
            if (since) url.searchParams.set('from', since);
            let res;
            try { res = await fetch(url, { headers: { authorization: `Bearer ${token}` } }); } catch { return { ok: false, reason: 'network_error', orders: [] }; }
            if (!res.ok) return { ok: false, reason: `http_${res.status}`, orders: [] };
            const body = await res.json();
            // TODO: map the real order payload to the normalized shape after
            // reading the OpenAPI schema with a live sandbox account.
            const orders = (body.orders || body || []).map((o) => ({
                platform_order_id: String(o.id),
                status: o.status || 'unknown',
                gross: Number(o.total ?? o.gross ?? 0),
                commission_rate: null,
                net: null,
                placed_at: o.created_at || o.placed_at || new Date().toISOString(),
            }));
            return { ok: true, orders };
        },
        async fetchMenu() { return { ok: false, reason: 'not_implemented', items: [] }; },
        async pushMenuUpdate() { return { ok: false, reason: 'not_implemented' }; },
        async fetchPayouts() { return { ok: false, reason: 'not_implemented', payouts: [] }; },
        async fetchRatings() { return { ok: false, reason: 'not_implemented' }; },
    };
}
