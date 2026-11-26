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
                    const cancelled = i === n - 1 && n >= 3; // one cancelled demo order per platform
                    store.insert('orders', {
                        brand_id: brand.id, platform: p,
                        platform_order_id: `${p}-${Date.now()}-${i}`,
                        status: cancelled ? 'cancelled' : 'completed', gross, commission_rate: 0.18,
                        net: cancelled ? 0 : Math.round(gross * 0.82 * 100) / 100,
                        placed_at: new Date(Date.now() - Math.random() * 86400000).toISOString(),
                        demo: true,
                    });
                }
            }
        }
    }
    for (const b of demoBrands) {
        const brand = store.one('brands', (x) => x.key === b.key);
        if (brand) seedCatalog(store, brand);
    }
    if (!quiet) console.log('[seed] demo brands ready');
    await store.flush();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const store = new Store(process.env.DATA_DIR || new URL('../data', import.meta.url).pathname);
    await store.init();
    await seed(store);
}

// Starter menu + offers for a brand. Used by the demo seed and by merchant
// self-service brand creation so new pages are never empty shells.
export function seedCatalog(store, brand) {
    if (store.find('menu_items', (m) => m.brand_id === brand.id).length === 0) {
        const items = [
            ['وجبة الدجاج المشوي', 32], ['وجبة اللحم', 41], ['صحن مقبلات مشكل', 18],
            ['برجر كلاسيك', 24], ['بطاطس كبيرة', 9], ['مشروب غازي', 6], ['حلا اليوم', 14],
        ];
        for (const [name_ar, price] of items) {
            store.insert('menu_items', { brand_id: brand.id, name_ar, price, available: true, demo: true });
        }
    }
    if (store.find('offers', (o) => o.brand_id === brand.id).length === 0) {
        store.insert('offers', { brand_id: brand.id, title_ar: 'خصم نهاية الأسبوع', discount_pct: 15, active: true, demo: true });
        store.insert('offers', { brand_id: brand.id, title_ar: 'وجبة مجانية مع طلبين', discount_pct: 0, active: false, demo: true });
    }
}
