// Tahakkum store: libsql (SQLite) persistence.
// Local development uses a file DB (file:...). Hosted deployments use Turso
// (set TURSO_URL and TURSO_TOKEN), which is free, cardless and persistent.
// The class keeps a synchronous in-memory API so the rest of the app does not
// change; mutations are persisted in order on a write queue, and callers that
// need durability before responding await store.flush().
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const COLLECTIONS = ['users', 'brands', 'platform_accounts', 'orders', 'order_items', 'menu_items', 'offers', 'payouts', 'ratings', 'sessions', 'sync_jobs', 'audit_log'];

export class Store {
    constructor(dir) {
        this.dir = dir;
        this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
        fs.mkdirSync(dir, { recursive: true });
        const url = process.env.TURSO_URL || `file:${path.join(dir, 'tahakkum.db')}`;
        this.db = createClient({ url, authToken: process.env.TURSO_TOKEN });
        this.queue = Promise.resolve();
    }

    async init() {
        fs.mkdirSync(this.dir, { recursive: true });
        await this.db.execute('CREATE TABLE IF NOT EXISTS entities (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id))');
        const rs = await this.db.execute('SELECT collection, data FROM entities');
        for (const row of rs.rows) {
            if (this.data[row.collection]) this.data[row.collection].push(JSON.parse(row.data));
        }
    }

    _enqueue(fn) {
        this.queue = this.queue.then(fn).catch((e) => console.error('[store] persist error:', e.message || e));
    }
    async flush() { await this.queue; }
    _persist(col, id, row) {
        this._enqueue(() => this.db.execute({
            sql: 'INSERT INTO entities (collection, id, data) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data',
            args: [col, id, JSON.stringify(row)],
        }));
    }
    _persistDelete(col, id) {
        this._enqueue(() => this.db.execute({ sql: 'DELETE FROM entities WHERE collection = ? AND id = ?', args: [col, id] }));
    }

    insert(col, row) {
        row.id = row.id || (col.slice(0, 3) + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        row.created_at = row.created_at || new Date().toISOString();
        this.data[col].push(row);
        this._persist(col, row.id, row);
        return row;
    }
    update(col, id, patch) {
        const r = this.data[col].find((x) => x.id === id);
        if (r) { Object.assign(r, patch); this._persist(col, id, r); }
        return r;
    }
    find(col, pred) { return this.data[col].filter(pred); }
    one(col, pred) { return this.data[col].find(pred) || null; }
    remove(col, pred) {
        const removed = this.data[col].filter(pred);
        if (removed.length) {
            this.data[col] = this.data[col].filter((x) => !pred(x));
            for (const r of removed) this._persistDelete(col, r.id);
        }
    }
}
