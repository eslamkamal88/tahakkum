// Connector registry. One connector per delivery platform, one shared interface.
// Status today:
//   - All six are STUBS: they validate the account shape and return a clear
//     not_implemented result. Nothing here has been run against a real portal.
//   - portal.js holds the Playwright-based skeleton for credential login;
//     it needs `npm i playwright && npx playwright install chromium` and real
//     selector work per portal with a real merchant account (UNTESTED).
//   - Official APIs (preferred path): HungerStation Partner API
//     (developer.hungerstation.com), Keeta open platform (api-docs.mykeeta.com),
//     Jahez integration portal (integration-portal.jahez.net), ToYou merchant
//     API (github.com/AramMeem-ToYou-Back/merchant-public-api-client).
//     Each needs an approved partner application before any code can be tested.

const NOTES = {
    hungerstation: 'Prefer official Partner API (catalog, orders, promotions). Portal fallback: partner-app.hungerstation.com.',
    jahez: 'Partner registration at integration-portal.jahez.net. Portal fallback: portal.jahez.net.',
    toyou: 'Merchant public API, official sample client on GitHub. Portal fallback: merchant.toyou.io.',
    keeta: 'Open platform with merchant access tokens (api-docs.mykeeta.com). Portal fallback: merchant.mykeeta.com.',
    ninja: 'No public partner docs found. Seller portal: ninjasellers.com.',
    chefz: 'No public partner docs found. Merchant portal: thechefz.co.',
};

function stub(platform) {
    return {
        platform,
        note: NOTES[platform],
        // Every method returns a structured result; real implementations must
        // keep this shape so the scheduler and API never change.
        async login() {
            return { ok: false, reason: 'connector_not_implemented', note: NOTES[platform] };
        },
        async fetchOrders() {
            return { ok: false, reason: 'connector_not_implemented', orders: [] };
        },
        async fetchMenu() {
            return { ok: false, reason: 'connector_not_implemented', items: [] };
        },
        async pushMenuUpdate() {
            return { ok: false, reason: 'connector_not_implemented' };
        },
        async fetchPayouts() {
            return { ok: false, reason: 'connector_not_implemented', payouts: [] };
        },
        async fetchRatings() {
            return { ok: false, reason: 'connector_not_implemented' };
        },
    };
}

export const PLATFORMS = Object.keys(NOTES);
export async function getConnector(platform) {
    if (!PLATFORMS.includes(platform)) return null;
    // Official API path is enabled per platform by env flag once partner access
    // is approved and base URLs confirmed (HS_OFFICIAL=1 for HungerStation).
    if (platform === 'hungerstation' && process.env.HS_OFFICIAL === '1') {
        const { hungerstationApi } = await import('./hungerstation-api.js');
        return hungerstationApi();
    }
    if (platform === 'toyou' && process.env.TY_OFFICIAL === '1') {
        const { toyouApi } = await import('./toyou-api.js');
        return toyouApi();
    }
    // Credential-based portal pull (default for ToYou and HungerStation).
    // Set TY_PORTAL=0 / HS_PORTAL=0 to fall back to the stub.
    if (platform === 'toyou' && process.env.TY_PORTAL !== '0') {
        const { toyouPortal } = await import('./toyou-portal.js');
        return toyouPortal();
    }
    if (platform === 'hungerstation' && process.env.HS_PORTAL !== '0') {
        const { hungerstationPortal } = await import('./hs-portal.js');
        return hungerstationPortal();
    }
    return stub(platform);
}
