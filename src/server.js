// Tahakkum API + static host. Node stdlib only (no npm install needed for the skeleton).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { encryptSecret, decryptSecret, hashPassword, verifyPassword, randomToken } from './vault.js';
import { seed, seedCatalog } from './seed.js';
import { startScheduler } from './scheduler.js';
import { PLATFORMS, getConnector } from './connectors/index.js';
import { generateWeeklyReport, previousWeekRange } from './report.js';

const DATA_DIR = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

const store = new Store(DATA_DIR);
await store.init();
await seed(store, { quiet: true });
const scheduler = startScheduler(store);

function parseCookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }));
}

function currentUser(req) {
    const token = parseCookies(req).th_session;
    if (!token) return null;
    const session = store.one('sessions', (s) => s.token === token && new Date(s.expires_at) > new Date());
    if (!session) return null;
    return store.one('users', (u) => u.id === session.user_id);
}

function send(res, code, body, headers = {}) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
    res.end(payload);
}

async function readBody(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (raw.length > 1e6) throw new Error('body too large');
    return raw ? JSON.parse(raw) : {};
}

function brandDashboard(brandId) {
    const orders = store.find('orders', (o) => o.brand_id === brandId);
    const today = orders.filter((o) => Date.now() - new Date(o.placed_at) < 86400000);
    const byPlatform = {};
    for (const p of PLATFORMS) {
        const po = today.filter((o) => o.platform === p && o.status !== 'cancelled');
        const week = orders.filter((o) => o.platform === p && o.status !== 'cancelled' && Date.now() - new Date(o.placed_at) < 7 * 86400000);
        // Daily series for the last 7 days (oldest first) for the per-app chart.
        const series = [];
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); dayStart.setDate(dayStart.getDate() - i);
            const dayEnd = new Date(dayStart.getTime() + 86400000);
            const thatDay = week.filter((o) => { const t = new Date(o.placed_at); return t >= dayStart && t < dayEnd; });
            series.push({ day: dayStart.toISOString().slice(5, 10), orders: thatDay.length, gross: Math.round(thatDay.reduce((s, o) => s + o.gross, 0) * 100) / 100 });
        }
        const cancelled = orders.filter((o) => o.platform === p && o.status === 'cancelled' && Date.now() - new Date(o.placed_at) < 90 * 86400000);
        cancelled.sort((a, b) => String(b.placed_at).localeCompare(String(a.placed_at)));
        byPlatform[p] = {
            orders: po.length,
            gross: Math.round(po.reduce((s, o) => s + o.gross, 0) * 100) / 100,
            demo: po.length > 0 && po.every((o) => o.demo === true),
            week_orders: week.length,
            week_gross: Math.round(week.reduce((s, o) => s + o.gross, 0) * 100) / 100,
            series,
            cancelled: {
                count: cancelled.length,
                gross: Math.round(cancelled.reduce((s, o) => s + o.gross, 0) * 100) / 100,
                demo: cancelled.length > 0 && cancelled.every((o) => o.demo === true),
                recent: cancelled.slice(0, 5).map((o) => ({ id: o.platform_order_id, gross: o.gross, date: String(o.placed_at).slice(0, 10) })),
            },
        };
    }
    const brand = store.one('brands', (b) => b.id === brandId) || {};
    return {
        commission_rates: brand.commission_rates || {},
        today_orders: today.filter((o) => o.status !== 'cancelled').length,
        today_gross: Math.round(today.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.gross, 0) * 100) / 100,
        today_net: Math.round(today.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.net, 0) * 100) / 100,
        today_cancelled: today.filter((o) => o.status === 'cancelled').length,
        by_platform: byPlatform,
        menu: store.find('menu_items', (m) => m.brand_id === brandId),
        offers: store.find('offers', (o) => o.brand_id === brandId),
        demo: today.some((o) => o.demo === true),
    };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const user = currentUser(req);
    try {
        if (url.pathname === '/api/login' && req.method === 'POST') {
            const { email, password } = await readBody(req);
            const u = store.one('users', (x) => x.email === String(email || '').toLowerCase());
            if (!u || !verifyPassword(password || '', u.password_hash)) return send(res, 401, { error: 'invalid_credentials' });
            const token = randomToken();
            store.insert('sessions', { token, user_id: u.id, expires_at: new Date(Date.now() + 30 * 86400000).toISOString() });
            await store.flush();
            return send(res, 200, { ok: true, role: u.role }, { 'set-cookie': `th_session=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax` });
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') {
            const token = parseCookies(req).th_session;
            if (token) { store.remove('sessions', (s) => s.token === token); await store.flush(); }
            return send(res, 200, { ok: true }, { 'set-cookie': 'th_session=; HttpOnly; Path=/; Max-Age=0' });
        }
        if (!url.pathname.startsWith('/api/')) {
            const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
            if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                return send(res, 200, fs.readFileSync(file, 'utf8'), { 'content-type': 'text/html; charset=utf-8' });
            }
            return send(res, 404, { error: 'not_found' });
        }
        if (!user) return send(res, 401, { error: 'auth_required' });

        if (url.pathname === '/api/me') return send(res, 200, { email: user.email, role: user.role, name: user.name });

        if (url.pathname === '/api/brands' && req.method === 'GET') {
            const brands = user.role === 'owner' ? store.data.brands : store.find('brands', (b) => b.tenant_id === user.id);
            return send(res, 200, { brands });
        }

        // Merchant onboarding: owner creates a merchant login tied to a new brand.
        if (url.pathname === '/api/admin/merchants' && req.method === 'POST' && user.role === 'owner') {
            const { email, password, name, brand_ar, brand_en } = await readBody(req);
            if (!email || !password || String(password).length < 8) return send(res, 400, { error: 'email_and_password_min8_required' });
            if (store.one('users', (u) => u.email === String(email).toLowerCase())) return send(res, 409, { error: 'email_exists' });
            const merchant = store.insert('users', { email: String(email).toLowerCase(), password_hash: hashPassword(password), role: 'merchant', name: name || '' });
            const brand = store.insert('brands', { key: 'brand_' + merchant.id.slice(-6), name_ar: brand_ar || (name || 'براند'), name_en: brand_en || (name || 'Brand'), factor: 1, tenant_id: merchant.id });
            store.insert('audit_log', { actor: user.email, action: 'merchant_created', merchant: merchant.email, brand_id: brand.id });
            await store.flush();
            return send(res, 200, { merchant: { id: merchant.id, email: merchant.email, role: 'merchant' }, brand });
        }

        // Self-service: any signed-in user adds a brand to their own account.
        if (url.pathname === '/api/brands' && req.method === 'POST') {
            const { name_ar, name_en } = await readBody(req);
            if (!name_ar && !name_en) return send(res, 400, { error: 'name_required' });
            const brand = store.insert('brands', {
                key: 'brand_' + randomToken().slice(0, 8),
                name_ar: name_ar || name_en, name_en: name_en || name_ar,
                factor: 1, tenant_id: user.id,
            });
            seedCatalog(store, brand);
            store.insert('audit_log', { actor: user.email, action: 'brand_created', brand_id: brand.id });
            await store.flush();
            return send(res, 200, { brand });
        }

        const canAccess = (brandId) => {
            const b = store.one('brands', (x) => x.id === brandId);
            return b && (user.role === 'owner' || b.tenant_id === user.id) ? b : null;
        };

        const dashMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/dashboard$/);
        if (dashMatch) {
            if (!canAccess(dashMatch[1])) return send(res, 403, { error: 'forbidden' });
            return send(res, 200, brandDashboard(dashMatch[1]));
        }

        // Weekly reports: list, generate on demand, download.
        const reportsMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/reports$/);
        if (reportsMatch && req.method === 'GET') {
            if (!canAccess(reportsMatch[1])) return send(res, 403, { error: 'forbidden' });
            const reports = store.find('reports', (r) => r.brand_id === reportsMatch[1])
                .sort((a, b) => String(b.week_start).localeCompare(String(a.week_start)))
                .map(({ pdf_base64, ...meta }) => meta);
            return send(res, 200, { reports });
        }
        if (reportsMatch && req.method === 'POST') {
            const brand = canAccess(reportsMatch[1]);
            if (!brand) return send(res, 403, { error: 'forbidden' });
            const report = await generateWeeklyReport(store, brand, previousWeekRange());
            const { pdf_base64, ...meta } = report;
            return send(res, 200, { report: meta });
        }
        const reportDlMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/reports\/([^/]+)\/download$/);
        if (reportDlMatch && req.method === 'GET') {
            if (!canAccess(reportDlMatch[1])) return send(res, 403, { error: 'forbidden' });
            const report = store.one('reports', (r) => r.id === reportDlMatch[2] && r.brand_id === reportDlMatch[1]);
            if (!report) return send(res, 404, { error: 'not_found' });
            const pdf = Buffer.from(report.pdf_base64, 'base64');
            res.writeHead(200, {
                'content-type': 'application/pdf',
                'content-length': pdf.length,
                'content-disposition': `attachment; filename="tahakkum-${report.week_start}.pdf"`,
            });
            return res.end(pdf);
        }

        const commMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/commission$/);
        if (commMatch && req.method === 'PATCH') {
            if (!canAccess(commMatch[1])) return send(res, 403, { error: 'forbidden' });
            const { platform, rate } = await readBody(req);
            if (!PLATFORMS.includes(platform)) return send(res, 400, { error: 'bad_platform' });
            const brand = store.one('brands', (b) => b.id === commMatch[1]);
            const rates = { ...(brand.commission_rates || {}) };
            if (rate === null || rate === '') delete rates[platform];
            else {
                const n = Number(rate);
                if (!Number.isFinite(n) || n < 0 || n > 100) return send(res, 400, { error: 'bad_rate' });
                rates[platform] = n;
            }
            store.update('brands', brand.id, { commission_rates: rates });
            await store.flush();
            return send(res, 200, { commission_rates: rates });
        }

        const menuAddMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/menu$/);
        if (menuAddMatch && req.method === 'POST') {
            if (!canAccess(menuAddMatch[1])) return send(res, 403, { error: 'forbidden' });
            const { name_ar, price, platform } = await readBody(req);
            if (!name_ar || !PLATFORMS.includes(platform)) return send(res, 400, { error: 'name_and_platform_required', platforms: PLATFORMS });
            const item = store.insert('menu_items', {
                brand_id: menuAddMatch[1], platform,
                name_ar: String(name_ar), price: Number(price) || 0,
                available: true, demo: true,
            });
            await store.flush();
            return send(res, 200, { item });
        }

        const menuMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/menu\/([^/]+)$/);
        if (menuMatch && req.method === 'PATCH') {
            if (!canAccess(menuMatch[1])) return send(res, 403, { error: 'forbidden' });
            const { available } = await readBody(req);
            const item = store.one('menu_items', (m) => m.id === menuMatch[2] && m.brand_id === menuMatch[1]);
            if (!item) return send(res, 404, { error: 'not_found' });
            store.update('menu_items', item.id, { available: !!available });
            await store.flush();
            return send(res, 200, { item: store.one('menu_items', (m) => m.id === item.id) });
        }

        const offersMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/offers$/);
        if (offersMatch && !canAccess(offersMatch[1])) return send(res, 403, { error: 'forbidden' });
        if (offersMatch && req.method === 'POST') {
            const { title_ar, discount_pct } = await readBody(req);
            if (!title_ar) return send(res, 400, { error: 'title_required' });
            const offer = store.insert('offers', { brand_id: offersMatch[1], title_ar, discount_pct: Number(discount_pct) || 0, active: true, demo: true });
            await store.flush();
            return send(res, 200, { offer });
        }
        const offerMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/offers\/([^/]+)$/);
        if (offerMatch && req.method === 'PATCH') {
            if (!canAccess(offerMatch[1])) return send(res, 403, { error: 'forbidden' });
            const { active } = await readBody(req);
            const offer = store.one('offers', (o) => o.id === offerMatch[2] && o.brand_id === offerMatch[1]);
            if (!offer) return send(res, 404, { error: 'not_found' });
            store.update('offers', offer.id, { active: !!active });
            await store.flush();
            return send(res, 200, { offer: store.one('offers', (o) => o.id === offer.id) });
        }

        const accMatch = url.pathname.match(/^\/api\/brands\/([^/]+)\/platform-accounts$/);
        if (accMatch && !canAccess(accMatch[1])) return send(res, 403, { error: 'forbidden' });
        if (accMatch && req.method === 'GET') {
            const accounts = store.find('platform_accounts', (a) => a.brand_id === accMatch[1])
                .map(({ vault_ref, ...safe }) => ({ ...safe, password: '••••••••' }));
            return send(res, 200, { accounts });
        }
        if (accMatch && req.method === 'POST') {
            const { platform, username, password } = await readBody(req);
            if (!PLATFORMS.includes(platform) || !username || !password) return send(res, 400, { error: 'bad_request', platforms: PLATFORMS });
            const acc = store.insert('platform_accounts', {
                brand_id: accMatch[1], platform, username: String(username),
                vault_ref: encryptSecret(password), status: 'pending', consecutive_failures: 0,
            });
            store.insert('audit_log', { actor: user.email, action: 'credential_stored', platform, account_id: acc.id });
            // Real pull first: try the platform connector (portal login with the
            // merchant's own credentials). On success, store the real orders.
            const readSecret = async (a) => decryptSecret(a.vault_ref);
            let result = { ok: false, reason: 'connector_not_implemented' };
            let pulled = 0;
            try {
                const connector = await getConnector(platform);
                if (connector && connector.login) {
                    result = await connector.login(acc, { readSecret });
                    if (result.ok && result.session && connector.fetchOrders) {
                        const fo = await connector.fetchOrders(acc, { readSecret, session: result.session });
                        if (fo.ok && fo.orders && fo.orders.length) {
                            for (const o of fo.orders) {
                                if (store.find('orders', (x) => x.brand_id === accMatch[1] && x.platform === platform && x.platform_order_id === o.platform_order_id).length) continue;
                                store.insert('orders', {
                                    brand_id: accMatch[1], platform,
                                    platform_order_id: o.platform_order_id,
                                    status: o.status || 'completed', gross: o.gross || 0,
                                    commission_rate: o.commission_rate ?? 0.18, net: o.net ?? (o.gross || 0) * 0.82,
                                    placed_at: o.placed_at || new Date().toISOString(), demo: false,
                                });
                                pulled++;
                            }
                            // Real data wins: drop the demo orders for this platform.
                            store.remove('orders', (o) => o.brand_id === accMatch[1] && o.platform === platform && o.demo);
                            store.insert('sync_jobs', { brand_id: accMatch[1], platform, type: 'real_sync', orders: pulled, at: new Date().toISOString() });
                        }
                    }
                }
            } catch (e) {
                result = { ok: false, reason: 'portal_error' };
            }
            // Instant reflect: when the real pull could not add orders (connector
            // not implemented, invalid credentials, 2FA...), we still generate
            // clearly-marked demo orders for this platform the first time
            // credentials are saved, so the dashboard shows its shape.
            if (pulled === 0 && store.find('orders', (o) => o.brand_id === accMatch[1] && o.platform === platform).length === 0) {
                const started = Date.now();
                const n = 3 + Math.floor(Math.random() * 6);
                for (let i = 0; i < n; i++) {
                    const gross = Math.round((30 + Math.random() * 120) * 100) / 100;
                    const cancelled = i === n - 1 && n >= 3; // one cancelled demo order per platform
                    store.insert('orders', {
                        brand_id: accMatch[1], platform,
                        platform_order_id: `${platform}-${Date.now()}-${i}`,
                        status: cancelled ? 'cancelled' : 'completed', gross, commission_rate: 0.18,
                        net: cancelled ? 0 : Math.round(gross * 0.82 * 100) / 100,
                        placed_at: new Date(Date.now() - Math.random() * 43200000).toISOString(),
                        demo: true,
                    });
                }
                store.insert('sync_jobs', { brand_id: accMatch[1], platform, type: 'demo_sync', orders: n, at: new Date().toISOString(), duration_ms: Date.now() - started });
            }
            const status = result.ok ? 'active'
                : result.reason === 'invalid_credentials' ? 'invalid_credentials'
                : result.reason === 'needs_2fa' ? 'needs_2fa'
                : 'needs_setup';
            store.update('platform_accounts', acc.id, { status, last_error: result.ok ? null : result.reason });
            await store.flush();
            const { vault_ref, ...safe } = store.one('platform_accounts', (a) => a.id === acc.id);
            return send(res, 200, { account: safe, verify: result });
        }

        if (url.pathname === '/api/admin/sync-jobs' && user.role === 'owner') {
            return send(res, 200, { jobs: store.data.sync_jobs.slice(-50).reverse() });
        }

        return send(res, 404, { error: 'not_found' });
    } catch (e) {
        return send(res, 500, { error: 'server_error', detail: String(e.message || e) });
    }
});

server.listen(PORT, () => console.log(`[tahakkum] listening on :${PORT}, data dir ${DATA_DIR}`));
process.on('SIGTERM', () => { scheduler.stop(); server.close(); });
