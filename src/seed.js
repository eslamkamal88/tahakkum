// Seed: creates the owner account and demo brands with sample figures.
// Run once: MASTER_KEY=... node src/seed.js
// Owner credentials come from env OWNER_EMAIL / OWNER_PASSWORD, or are
// generated once and printed (store them safely, they print only once).
import { Store } from './store.js';
import { hashPassword, randomToken } from './vault.js';

const PLATFORMS = ['hungerstation', 'jahez', 'toyou', 'keeta', 'ninja', 'chefz'];

export async function seed(store, { quiet } = {}) {
    const email = process.env.OWNER_EMAIL || 'owner@tahakkum.app';
    let password = process.env.OWNER_PASSWORD;
    const existing = store.one('users', (u) => u.email === email);
    if (!existing) {
        if (!password) password = randomToken().slice(0, 14);
        store.insert('users', { email, password_hash: hashPassword(password), role: 'owner', name: 'Owner' });
        if (!quiet) console.log(`[seed] owner created: ${email} / ${password}`);
    }
    const owner = store.one('users', (u) => u.email === email);
    const demoBrands = [
        { key: 'bunjab', name_ar: 'مطعم بنجاب', name_en: 'Bunjab Restaurant', factor: 0.8 },
        { key: 'burger', name_ar: 'برجر فاكتوري', name_en: 'Burger Factory', factor: 1 },
        { key: 'zaman', name_ar: 'شاورما زمان', name_en: 'Shawarma Zaman', factor: 0.55 },
    ];
    for (const b of demoBrands) {
        let brand = store.one('brands', (x) => x.key === b.key);
        if (!brand) brand = store.insert('brands', { ...b, tenant_id: owner.id });
        if (store.find('orders', (o) => o.brand_id === brand.id).length === 0) {
            for (const p of PLATFORMS) {
                const n = Math.max(1, Math.round((5 + Math.random() * 10) * b.factor));
                for (let i = 0; i < n; i++) {
                    const gross = Math.round((30 + Math.random() * 120) * 100) / 100;
                    store.insert('orders', {
                        brand_id: brand.id, platform: p,
                        platform_order_id: `${p}-${Date.now()}-${i}`,
                        status: 'completed', gross, commission_rate: 0.18,
                        net: Math.round(gross * 0.82 * 100) / 100,
                        placed_at: new Date(Date.now() - Math.random() * 86400000).toISOString(),
                    });
                }
            }
        }
    }
    if (!quiet) console.log('[seed] demo brands ready');
    await store.flush();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const store = new Store(process.env.DATA_DIR || new URL('../data', import.meta.url).pathname);
    await store.init();
    await seed(store);
}
