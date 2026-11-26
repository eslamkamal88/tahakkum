// Sync scheduler: pulls every active platform account on a fixed cadence and
// records each run in sync_jobs. Connector failures mark the account and stop
// after 3 consecutive failures until a human looks (alert surface for the
// owner dashboard).
import { getConnector } from './connectors/index.js';
import { decryptSecret } from './vault.js';

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
                store.data.orders = store.data.orders.filter((o) => !(o.brand_id === acc.brand_id && o.platform === acc.platform && o.demo));
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
    }

    const timer = setInterval(tick, ORDERS_INTERVAL_MS);
    timer.unref();
    return { tick, stop: () => clearInterval(timer) };
}
