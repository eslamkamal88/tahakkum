// HungerStation partner portal connector (credential-based, server-side).
// Login observed live on partner-app.hungerstation.com (2026-11-26):
//   POST https://partner-auth.eu.prd.portal.restaurant/auth/v5/login-two-step
//   body {"username": email, "password": password, "type": "password"}
// Wrong credentials render "Please check your email and password.".
// The portal sits behind bot protection, so datacenter IPs may be blocked.
// The endpoint name (two-step) means some accounts may get a second
// verification step; any such signal stops the flow, we never guess codes.
// Order/menu JSON endpoints behind the portal are NOT mapped yet - that needs
// one session with a consenting merchant account to observe the API calls.
// Rules kept: credentials only from vault decryptSecret, never logged.

const AUTH_URL = 'https://partner-auth.eu.prd.portal.restaurant/auth/v5/login-two-step';

export function hungerstationPortal() {
    return {
        platform: 'hungerstation',
        note: 'Credential login to partner-app.hungerstation.com; order endpoints pending mapping with a real account.',

        async login(account, { readSecret }) {
            const password = await readSecret(account);
            let res;
            try {
                res = await fetch(AUTH_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ username: account.username, password, type: 'password' }),
                });
            } catch (e) {
                return { ok: false, reason: 'portal_unreachable', detail: String(e && e.message || e) };
            }
            let data = null;
            try { data = await res.json(); } catch { /* non-JSON */ }
            if (res.status === 429) return { ok: false, reason: 'rate_limited' };
            if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422) {
                return { ok: false, reason: 'invalid_credentials' };
            }
            const d = data || {};
            const token = d.access_token || d.accessToken || d.token || (d.auth && (d.auth.access_token || d.auth.token));
            if (res.ok && token) {
                return { ok: true, session: { kind: 'hs_bearer', authToken: String(token).replace(/^Bearer\s+/i, '') } };
            }
            if (res.ok) {
                // 2xx without a token: a second step (OTP/device check) is likely.
                return { ok: false, reason: 'needs_2fa' };
            }
            return { ok: false, reason: 'portal_unexpected_response', detail: `status ${res.status}` };
        },

        // Orders/menu JSON endpoints are not mapped yet: return a clear reason
        // instead of failing, so the scheduler logs it without breaking the account.
        async fetchOrders() { return { ok: false, reason: 'orders_endpoint_not_mapped', orders: [] }; },
        async fetchMenu() { return { ok: false, reason: 'menu_endpoint_not_mapped', items: [] }; },
        async pushMenuUpdate() { return { ok: false, reason: 'menu_endpoint_not_mapped' }; },
        async fetchPayouts() { return { ok: false, reason: 'not_implemented', payouts: [] }; },
        async fetchRatings() { return { ok: false, reason: 'not_implemented' }; },
    };
}
