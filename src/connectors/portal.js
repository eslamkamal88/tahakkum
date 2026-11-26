// UNTESTED SKELETON - Playwright portal connector.
// This is the reference shape for credential-based portal login. It has never
// run against a real portal: selectors are placeholders and must be built with
// a real merchant account, one platform at a time.
//
// Setup on the server:  npm i playwright && npx playwright install --with-deps chromium
//
// Rules this code must keep:
//   - credentials come only from vault.decryptSecret, never from logs;
//   - on captcha or unexpected page: STOP, mark the account needs_attention,
//     never try to bypass;
//   - one login, then persist storageState (session) encrypted in the vault;
//   - human-like pacing: small delays, no parallel logins on one account.

export function makePortalConnector({ platform, loginUrl, selectors }) {
    return {
        platform,
        async login({ username, password, storageState }) {
            const { chromium } = await import('playwright');
            const browser = await chromium.launch({ headless: true });
            const ctx = await browser.newContext(storageState ? { storageState } : {});
            const page = await ctx.newPage();
            try {
                await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
                if (await page.$(selectors.user)) {
                    await page.fill(selectors.user, username);
                    await page.fill(selectors.pass, password);
                    await page.click(selectors.submit);
                }
                // 2FA: surface to the operator, never guess.
                if (selectors.otp && (await page.$(selectors.otp))) {
                    return { ok: false, reason: 'needs_2fa' };
                }
                if (selectors.captcha && (await page.$(selectors.captcha))) {
                    return { ok: false, reason: 'needs_captcha_manual' };
                }
                await page.waitForSelector(selectors.loggedIn, { timeout: 15000 });
                const state = await ctx.storageState();
                return { ok: true, storageState: state };
            } finally {
                await browser.close();
            }
        },
    };
}

// Example registration once selectors are mapped with a real account:
// export const hungerstationPortal = makePortalConnector({
//     platform: 'hungerstation',
//     loginUrl: 'https://partner-app.hungerstation.com/login',
//     selectors: { user: 'TODO', pass: 'TODO', submit: 'TODO', otp: 'TODO', captcha: 'TODO', loggedIn: 'TODO' },
// });
