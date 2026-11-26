// ToYou merchant portal connector (credential-based, server-side).
// Flow reverse-engineered from the public merchant portal SPA and ToYou's
// official sample client (github.com/AramMeem-ToYou-Back/merchant-public-api-client):
//   login:  POST https://app.toyou.delivery/catalog/v1/merchantuser/authtoken
//           body {email, password} -> {authToken:"Bearer ...", refreshToken, ...}
//   orders: GET  https://app.toyou.delivery/publicorders/v1/orders
//           header Authorization: Bearer <authToken>
// No captcha was observed on this API path. Some merchant accounts have 2FA;
// the API signals it and we stop instead of guessing codes.
// Rules kept: credentials come only from vault decryptSecret, are never logged,
// and any 2FA/captcha signal stops the flow and marks the account clearly.

const HOST = 'https://app.toyou.delivery';

async function postJson(url, body, headers = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        redirect: 'manual',
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data, headers: res.headers };
}

export function toyouPortal() {
    return {
        platform: 'toyou',
        note: 'Credential pull from merchant.toyou.io backend API (official sample client flow).',

        async login(account, { readSecret }) {
            const password = await readSecret(account);
            let r;
            try {
                r = await postJson(`${HOST}/catalog/v1/merchantuser/authtoken`, {
                    email: account.username,
                    password,
                });
            } catch (e) {
                return { ok: false, reason: 'portal_unreachable', detail: String(e && e.message || e) };
            }
            if (r.status === 401 || r.status === 400 || r.status === 403) {
                return { ok: false, reason: 'invalid_credentials' };
            }
            if (r.status === 429) return { ok: false, reason: 'rate_limited' };
            const d = r.data || {};
            if (d.is2faRequired || d.authRequestId) {
                return { ok: false, reason: 'needs_2fa' };
            }
            const raw = d.authToken || (d.authTokens && d.authTokens.authToken) || d.auth_token;
            if (r.status === 200 && raw) {
                const token = String(raw).replace(/^Bearer\s+/i, '');
                return {
                    ok: true,
                    session: {
                        kind: 'toyou_bearer',
                        authToken: token,
                        refreshToken: d.refreshToken || (d.authTokens && d.authTokens.refreshToken) || null,
                        expiresAt: d.authExpirationDate || null,
                    },
                };
            }
            return { ok: false, reason: 'portal_unexpected_response', detail: `status ${r.status}` };
        },

        async fetchOrders(account, { session, readSecret } = {}) {
            // Stateless: mint a fresh token from the stored credentials when no
            // session was handed in (this is how the scheduler calls us).
            if ((!session || !session.authToken) && readSecret) {
                const r = await this.login(account, { readSecret });
                if (!r.ok) return { ok: false, reason: r.reason, orders: [] };
                session = r.session;
            }
            if (!session || !session.authToken) return { ok: false, reason: 'no_session', orders: [] };
            // The merchant portal's own endpoints (from its JS bundle): orders
            // live under /delivery/v1/merchant/orders. The public integration
            // path /publicorders/v1/orders is kept as a fallback.
            let res = null, used = '';
            for (const u of [`${HOST}/delivery/v1/merchant/orders`, `${HOST}/publicorders/v1/orders`]) {
                try {
                    res = await fetch(u, { headers: { Accept: 'application/json', Authorization: `Bearer ${session.authToken}` } });
                    used = u;
                } catch (e) {
                    return { ok: false, reason: 'portal_unreachable', orders: [] };
                }
                if (res.ok) break;
            }
            if (res.status === 401) return { ok: false, reason: 'session_expired', orders: [] };
            if (!res.ok) return { ok: false, reason: `orders_http_${res.status}`, orders: [] };
            let data;
            try { data = await res.json(); } catch { return { ok: false, reason: 'orders_bad_json', orders: [] }; }
            const list = Array.isArray(data) ? data : (data.orders || data.content || data.items || data.data || data.records || []);
            const orders = list.map((o) => {
                const gross = Number(o.totalPrice ?? o.total ?? o.totalAmount ?? o.amount ?? o.price
                    ?? o.orderPrice ?? o.finalPrice ?? (o.payment && (o.payment.total ?? o.payment.amount)) ?? 0) || 0;
                return {
                    platform_order_id: String(o.id || o.orderId || o.order_id || o.orderNumber || o.code || ''),
                    status: String(o.merchantOrderStatus || o.status || 'unknown').toLowerCase(),
                    gross,
                    commission_rate: 0.18,
                    net: gross * 0.82,
                    placed_at: o.createdAt || o.createdDate || o.created_at || o.placedAt || o.date || o.requiredDeliveryDate || new Date().toISOString(),
                    demo: false,
                };
            }).filter((o) => o.platform_order_id);
            return { ok: true, orders };
        },

        async fetchMenu() { return { ok: false, reason: 'menu_endpoint_not_mapped', items: [] }; },
        async pushMenuUpdate() { return { ok: false, reason: 'menu_endpoint_not_mapped' }; },
        async fetchPayouts() { return { ok: false, reason: 'not_implemented', payouts: [] }; },
        async fetchRatings() { return { ok: false, reason: 'not_implemented' }; },
    };
}
