// HungerStation partner portal connector (credential-based, server-side).
// Login observed on partner-app.hungerstation.com: plain HTML form POST to
// /login (application/x-www-form-urlencoded, fields email + password),
// cookie session, no captcha on the login page at inspection time.
// Order/menu JSON endpoints behind the portal are NOT mapped yet - that needs
// one session with a consenting merchant account to observe the API calls.
// Rules kept: credentials only from vault decryptSecret, never logged;
// any captcha/OTP signal stops the flow and marks the account clearly.

const BASE = 'https://partner-app.hungerstation.com';

export function hungerstationPortal() {
    return {
        platform: 'hungerstation',
        note: 'Credential login to partner-app.hungerstation.com; order endpoints pending mapping with a real account.',

        async login(account, { readSecret }) {
            const password = await readSecret(account);
            const body = new URLSearchParams({ email: account.username, password }).toString();
            let res;
            try {
                res = await fetch(`${BASE}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body,
                    redirect: 'manual',
                });
            } catch (e) {
                return { ok: false, reason: 'portal_unreachable', detail: String(e && e.message || e) };
            }
            const setCookie = res.headers.get('set-cookie') || '';
            const location = res.headers.get('location') || '';
            // Success on this portal is a redirect away from /login with a session cookie.
            if ((res.status === 301 || res.status === 302 || res.status === 303) && !/login/i.test(location) && setCookie) {
                const sessionCookie = setCookie.split(',').map((c) => c.split(';')[0]).join('; ');
                return { ok: true, session: { kind: 'hs_cookie', cookie: sessionCookie } };
            }
            if (res.status === 429) return { ok: false, reason: 'rate_limited' };
            // Back to the login page or 4xx = rejected credentials (or an unknown challenge).
            if (res.status === 401 || res.status === 403 || /login/i.test(location) || res.status === 200) {
                let text = '';
                if (res.status === 200) { try { text = (await res.text()).slice(0, 4000); } catch { /* ignore */ } }
                if (/captcha/i.test(text)) return { ok: false, reason: 'needs_captcha_manual' };
                if (/otp|verification code|رمز التحقق/i.test(text)) return { ok: false, reason: 'needs_2fa' };
                return { ok: false, reason: 'invalid_credentials' };
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
