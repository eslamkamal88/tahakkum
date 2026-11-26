// ToYou official Public (Integration) API connector. UNTESTED: requires a real
// merchant account whose owner gave written consent. Grounded in ToYou's
// official sample client (github.com/AramMeem-ToYou-Back/merchant-public-api-client,
// archived Nov 2021, so paths may have changed; verify before production use):
//   - Host: https://app.toyou.delivery
//   - Auth: POST /catalog/v1/merchantuser/authtoken with {login, password}
//     returns authToken ("Bearer ..."), refreshToken and expiration fields.
//   - Orders: GET /publicorders/v1/orders (optional fromDateTime/toDateTime),
//     GET /publicorders/v1/orders/{order-id}, POST .../failed to report failure.
//   - A websocket order-notification channel exists; not implemented here.

const TY_API_BASE = process.env.TY_API_BASE || 'https://app.toyou.delivery';

let tokenCache = { token: null, expiresAt: 0 };

async function getToken(login, password) {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
    let res;
    try {
        res = await fetch(TY_API_BASE + '/catalog/v1/merchantuser/authtoken', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ login, password }),
        });
    } catch { return null; }
    if (!res.ok) return null;
    const body = await res.json();
    const raw = body.authToken || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    // Refresh one minute early; fall back to 55 minutes when no expiry is given.
    const ms = body.authExpirationDate
        ? new Date(body.authExpirationDate).getTime() - Date.now() - 60000
        : 55 * 60 * 1000;
    tokenCache = { token, expiresAt: Date.now() + Math.max(ms, 60000) };
    return token;
}

// account fields: username holds the merchant login; vault holds the password.
export function toyouApi() {
    return {
        platform: 'toyou',
        async login(account, { readSecret }) {
            const token = await getToken(account.username, await readSecret(account));
            return token ? { ok: true } : { ok: false, reason: 'auth_failed' };
        },
        async fetchOrders(account, { readSecret, since } = {}) {
            const token = await getToken(account.username, await readSecret(account));
            if (!token) return { ok: false, reason: 'auth_failed', orders: [] };
            const url = new URL(TY_API_BASE + '/publicorders/v1/orders');
            if (since) url.searchParams.set('fromDateTime', since);
            let res;
            try { res = await fetch(url, { headers: { authorization: `Bearer ${token}` } }); }
            catch { return { ok: false, reason: 'network_error', orders: [] }; }
            if (!res.ok) return { ok: false, reason: `http_${res.status}`, orders: [] };
            const body = await res.json();
            // TODO: confirm OrderChangeData/OrderData field names against a live
            // account; the sample client is from 2021 and the schema may differ.
            const list = Array.isArray(body) ? body : body.orders || [];
            const orders = list.map((o) => ({
                platform_order_id: String(o.orderId || o.id),
                status: o.status || o.state || 'unknown',
                gross: Number(o.total ?? o.grandTotal ?? o.gross ?? 0),
                commission_rate: null,
                net: null,
                placed_at: o.createdAt || o.placedAt || new Date().toISOString(),
            }));
            return { ok: true, orders };
        },
        async fetchMenu() { return { ok: false, reason: 'not_implemented', items: [] }; },
        async pushMenuUpdate() { return { ok: false, reason: 'not_implemented' }; },
        async fetchPayouts() { return { ok: false, reason: 'not_implemented', payouts: [] }; },
        async fetchRatings() { return { ok: false, reason: 'not_implemented' }; },
    };
}
