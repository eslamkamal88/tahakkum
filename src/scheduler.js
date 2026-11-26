// Sync scheduler: pulls every active platform account on a fixed cadence and
// records each run in sync_jobs. Connector failures mark the account and stop
// after 3 consecutive failures until a human looks (alert surface for the
// owner dashboard).
import { getConnector } from './connectors/index.js';
import { decryptSecret } from './vault.js';
import { generateWeeklyReport, previousWeekRange } from './report.js';

const ORDERS_INTERVAL_MS = 10 * 60 * 1000;   // orders every 10 minutes
const MAX_CONSECUTIVE_FAILURES = 3;

export function startScheduler(store, log = console.log) {
    async function syncAccount(acc) {
        const connector = await getConnector(acc.platform);
        const readSecret = async (a) => decryptSecret(a.vault_ref);
        const job = store.insert('sync_jobs', {
            brand_id: acc.brand_id, platform_account_id: acc.id,
            kind: 'orders', started_at: new Date().toISOString(), status: 'running',
        });
        const result = await connector.fetchOrders(acc, { readSecret });
        if (!result.ok && /_not_mapped$/.test(result.reason || '')) {
            // Endpoint not mapped yet for this connector: not an account failure.
            store.update('sync_jobs', job.id, { status: 'skipped', error: result.reason, finished_at: new Date().toISOString() });
            await store.flush();
            return;
        }
        if (result.ok) {
            if (result.orders.length) {
                store.remove('orders', (o) => o.brand_id === acc.brand_id && o.platform === acc.platform && o.demo);
            }
            for (const o of result.orders) {
                if (store.find('orders', (x) => x.brand_id === acc.brand_id && x.platform === acc.platform && x.platform_order_id === o.platform_order_id).length) continue;
                store.insert('orders', { ...o, brand_id: acc.brand_id, platform: acc.platform });
            }
            store.update('platform_accounts', acc.id, { status: 'active', consecutive_failures: 0, last_success_at: new Date().toISOString() });
            store.update('sync_jobs', job.id, { status: 'done', rows_pulled: result.orders.length, finished_at: new Date().toISOString() });
            await store.flush();
        } else {
            const failures = (acc.consecutive_failures || 0) + 1;
            store.update('platform_accounts', acc.id, {
                consecutive_failures: failures,
                status: failures >= MAX_CONSECUTIVE_FAILURES ? 'broken' : acc.status,
            });
            store.update('sync_jobs', job.id, { status: 'failed', error: result.reason, finished_at: new Date().toISOString() });
            await store.flush();
            log(`[sync] ${acc.platform} for account ${acc.id} failed: ${result.reason}`);
        }
    }

    async function tick() {
        const accounts = store.find('platform_accounts', (a) => a.status === 'active' || a.status === 'pending');
        for (const acc of accounts) await syncAccount(acc);
        await weeklyReports();
    }

    // Weekly PDF: once the previous ISO week has a report missing for a brand
    // that had any orders that week, generate it. Idempotent: existing reports
    // are skipped, so this is safe to run on every tick.
    async function weeklyReports() {
        try {
            const range = previousWeekRange();
            for (const brand of store.data.brands) {
                if (store.one('reports', (r) => r.brand_id === brand.id && r.week_start === range.start && r.week_end === range.end)) continue;
                const hasOrders = store.find('orders', (o) => {
                    if (o.brand_id !== brand.id) return false;
                    const d = String(o.placed_at).slice(0, 10);
                    return d >= range.start && d <= range.end;
                }).length > 0;
                if (!hasOrders) continue;
                await generateWeeklyReport(store, brand, range);
                log(`[report] weekly report generated for brand ${brand.id} (${range.start}..${range.end})`);
            }
        } catch (e) {
            log(`[report] weekly report generation failed: ${e.message || e}`);
        }
    }

    const timer = setInterval(tick, ORDERS_INTERVAL_MS);
    timer.unref();
    return { tick, stop: () => clearInterval(timer) };
}
