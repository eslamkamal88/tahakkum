// Weekly PDF report, generated server-side. pdfkit/fontkit (HarfBuzz)
// shapes each Arabic run correctly but does not reverse the run order for
// RTL paragraphs, so we segment the line into Arabic and non-Arabic runs
// and reverse the run sequence ourselves before handing it over.
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';

// The Amiri TTF ships in the repo under fonts/. If it is missing (the binary
// could not be uploaded through the GitHub web editor), fetch it once from
// the upstream project and cache it in the data dir.
const REPO_FONT = new URL('../fonts/Amiri-Regular.ttf', import.meta.url).pathname;
const DATA_DIR = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const CACHED_FONT = path.join(DATA_DIR, 'Amiri-Regular.ttf');
const FONT_URLS = [
    'https://raw.githubusercontent.com/aliftype/amiri/main/fonts/Amiri-Regular.ttf',
    'https://cdn.jsdelivr.net/gh/aliftype/amiri@main/fonts/Amiri-Regular.ttf',
];

async function ensureFont() {
    if (fs.existsSync(REPO_FONT)) return REPO_FONT;
    if (fs.existsSync(CACHED_FONT) && fs.statSync(CACHED_FONT).size > 100000) return CACHED_FONT;
    for (const url of FONT_URLS) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 100000 || buf.readUInt32BE(0) !== 0x00010000) continue;
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(CACHED_FONT, buf);
            return CACHED_FONT;
        } catch { /* try the next mirror */ }
    }
    throw new Error('amiri_font_unavailable');
}

const PLATFORM_AR = { hungerstation: 'هنقرستيشن', jahez: 'جاهز', toyou: 'تويو', keeta: 'كيتا', ninja: 'نينجا', chefz: 'ذا شيفز' };

function isArabic(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x0600 && c <= 0x06ff) || (c >= 0xfb50 && c <= 0xfeff);
}

function ar(t) {
    const s = String(t);
    const runs = [];
    let cur = '', curAr = null;
    for (const ch of s) {
        const a = isArabic(ch);
        if (curAr === null || a === curAr) { cur += ch; curAr = a; }
        else { runs.push(cur); cur = ch; curAr = a; }
    }
    if (cur) runs.push(cur);
    return runs.reverse().join('');
}

function fmt(n) {
    return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function day(iso) {
    return String(iso || '').slice(0, 10);
}

// Previous full ISO week (Monday..Sunday) relative to `now`, as UTC dates.
export function previousWeekRange(now = new Date()) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const thisMonday = new Date(d);
    thisMonday.setUTCDate(d.getUTCDate() - dow);
    const start = new Date(thisMonday);
    start.setUTCDate(thisMonday.getUTCDate() - 7);
    const end = new Date(thisMonday);
    end.setUTCDate(thisMonday.getUTCDate() - 1);
    return { start: day(start.toISOString()), end: day(end.toISOString()) };
}

export function weekSummary(store, brandId, range) {
    const orders = store.find('orders', (o) => {
        if (o.brand_id !== brandId) return false;
        const d = day(o.placed_at);
        return d >= range.start && d <= range.end;
    });
    const byPlatform = {};
    for (const o of orders) {
        const p = o.platform;
        if (!byPlatform[p]) byPlatform[p] = { orders: 0, gross: 0, net: 0, cancelled: 0, cancelled_gross: 0, demo: true };
        const slot = byPlatform[p];
        if (o.demo !== true) slot.demo = false;
        if (o.status === 'cancelled') {
            slot.cancelled += 1;
            slot.cancelled_gross += o.gross || 0;
        } else {
            slot.orders += 1;
            slot.gross += o.gross || 0;
            slot.net += o.net ?? (o.gross || 0) * 0.82;
        }
    }
    for (const slot of Object.values(byPlatform)) {
        slot.gross = Math.round(slot.gross * 100) / 100;
        slot.net = Math.round(slot.net * 100) / 100;
        slot.cancelled_gross = Math.round(slot.cancelled_gross * 100) / 100;
    }
    const totals = {
        orders: orders.filter((o) => o.status !== 'cancelled').length,
        gross: Math.round(orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + (o.gross || 0), 0) * 100) / 100,
        net: Math.round(orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + (o.net ?? (o.gross || 0) * 0.82), 0) * 100) / 100,
        cancelled: orders.filter((o) => o.status === 'cancelled').length,
        cancelled_gross: Math.round(orders.filter((o) => o.status === 'cancelled').reduce((s, o) => s + (o.gross || 0), 0) * 100) / 100,
    };
    const cancelledRecent = orders
        .filter((o) => o.status === 'cancelled')
        .sort((a, b) => String(b.placed_at).localeCompare(String(a.placed_at)))
        .slice(0, 10)
        .map((o) => ({ id: o.platform_order_id, platform: o.platform, gross: o.gross, date: day(o.placed_at) }));
    return { range, by_platform: byPlatform, totals, cancelled_recent: cancelledRecent };
}

async function buildPdf(brand, summary) {
    const fontPath = await ensureFont();
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.registerFont('amiri', fontPath);

        const PAGE_W = 595.28;
        const RIGHT = PAGE_W - 50; // right margin x
        const LEFT = 50;

        // pdfkit's LineWrapper shapes each space-separated word with HarfBuzz
        // (correct Arabic joining within the word) but lays words out in
        // string order, with no bidi run reordering. So we hand it words in
        // visual order: reverse the word sequence, keeping the internal order
        // of consecutive Latin-letter words (e.g. "Bunjab Restaurant").
        // Numbers, dates and punctuation tokens reverse freely, which matches
        // UBA run reversal for our report strings. A trailing space is kept
        // because pdfkit drops the space before the last word of a line.
        function toVisual(text) {
            const words = String(text).split(' ');
            const hasArabic = (w) => /[\u0600-\u06FF]/.test(w);
            const hasLatin = (w) => /[A-Za-z]/.test(w);
            const groups = [];
            for (const w of words) {
                if (hasLatin(w) && !hasArabic(w) && groups.length && groups[groups.length - 1].latin) {
                    groups[groups.length - 1].words.push(w);
                } else {
                    groups.push({ latin: hasLatin(w) && !hasArabic(w), words: [w] });
                }
            }
            groups.reverse();
            // Double spaces: pdfkit drops some single spaces around
            // Latin/digit tokens; doubles survive and look uniform.
            return groups.map((g) => g.words.join(' ')).join('  ') + ' ';
        }

        function line(text, { size = 11, color = '#000000', y } = {}) {
            doc.font('amiri').fontSize(size);
            const opts = { align: 'right', width: RIGHT - LEFT, lineGap: 4 };
            if (y !== undefined) return doc.fillColor(color).text(toVisual(text), LEFT, y, opts);
            doc.fillColor(color).text(toVisual(text), opts);
        }

        // Table row: cells laid out right-to-left by fixed column widths.
        function tableRow(cells, y, { size = 10, color = '#000000', header = false } = {}) {
            let x = RIGHT;
            for (const c of cells) {
                x -= c.w;
                doc.font('amiri').fontSize(size);
                const text = c.ar ? toVisual(c.text) : String(c.text);
                doc.fillColor(color).text(text, x, y, { width: c.w - 6, align: 'right' });
            }
            if (header) {
                doc.save().moveTo(LEFT, y + 18).lineTo(RIGHT, y + 18).lineWidth(0.7).strokeColor('#0f766e').stroke().restore();
            }
        }

        // Title block
        line('تحكم: التقرير الأسبوعي', { size: 22, color: '#06302b' });
        doc.moveDown(0.2);
        line(String(brand.name_ar || brand.name_en || ''), { size: 13, color: '#0a423b' });
        line(`الأسبوع من ${summary.range.start} إلى ${summary.range.end}`, { size: 12, color: '#0a423b' });
        line(`أنشئ آليا في ${day(new Date().toISOString())}`, { size: 10, color: '#666666' });
        doc.moveDown(1);

        // Sales table
        line('ملخص المبيعات حسب التطبيق', { size: 15, color: '#06302b' });
        doc.moveDown(0.4);
        const COLS = [
            { title: 'التطبيق', w: 130 },
            { title: 'الطلبات', w: 70 },
            { title: 'المبيعات ر.س', w: 100 },
            { title: 'بعد النسبة ر.س', w: 100 },
            { title: 'ملغي', w: 95 },
        ];
        let y = doc.y + 4;
        tableRow(COLS.map((c) => ({ text: c.title, w: c.w, ar: true })), y, { size: 10, color: '#06302b', header: true });
        y += 26;
        const platforms = Object.entries(summary.by_platform);
        if (!platforms.length) {
            line('لا توجد طلبات مسجلة هذا الأسبوع.', { size: 11 });
            y = doc.y + 6;
        }
        for (const [p, s] of platforms) {
            const name = (PLATFORM_AR[p] || p) + (s.demo ? ' (تجريبي)' : '');
            tableRow([
                { text: name, w: COLS[0].w, ar: true },
                { text: s.orders, w: COLS[1].w },
                { text: fmt(s.gross), w: COLS[2].w },
                { text: fmt(s.net), w: COLS[3].w },
                { text: `${s.cancelled} (${fmt(s.cancelled_gross)})`, w: COLS[4].w },
            ], y, { size: 10 });
            y += 22;
        }
        const t = summary.totals;
        doc.save().moveTo(LEFT, y + 2).lineTo(RIGHT, y + 2).lineWidth(0.4).strokeColor('#999').stroke().restore();
        y += 8;
        tableRow([
            { text: 'الإجمالي', w: COLS[0].w, ar: true },
            { text: t.orders, w: COLS[1].w },
            { text: fmt(t.gross), w: COLS[2].w },
            { text: fmt(t.net), w: COLS[3].w },
            { text: `${t.cancelled} (${fmt(t.cancelled_gross)})`, w: COLS[4].w },
        ], y, { size: 10, color: '#06302b' });
        doc.y = y + 30;

        if (summary.cancelled_recent.length) {
            doc.moveDown(0.6);
            line('تفاصيل الطلبات الملغاة', { size: 15, color: '#06302b' });
            doc.moveDown(0.3);
            for (const c of summary.cancelled_recent) {
                line(`${c.date} · ${PLATFORM_AR[c.platform] || c.platform} · طلب ${c.id} · ${fmt(c.gross)} ر.س`, { size: 9 });
            }
        }

        doc.moveDown(1);
        line('تحكم: بوابة إدارة تطبيقات التوصيل. تقرير آلي للتاجر.', { size: 9, color: '#666666' });
        doc.end();
    });
}

// Generate (or regenerate) the report for a brand + week range, store the PDF
// in the reports collection, and return the stored row.
export async function generateWeeklyReport(store, brand, range) {
    const summary = weekSummary(store, brand.id, range);
    const pdf = await buildPdf(brand, summary);
    const existing = store.one('reports', (r) => r.brand_id === brand.id && r.week_start === range.start && r.week_end === range.end);
    const row = {
        brand_id: brand.id,
        week_start: range.start,
        week_end: range.end,
        created_at: new Date().toISOString(),
        summary,
        pdf_base64: pdf.toString('base64'),
    };
    if (existing) {
        store.update('reports', existing.id, row);
        await store.flush();
        return store.one('reports', (r) => r.id === existing.id);
    }
    const inserted = store.insert('reports', row);
    await store.flush();
    return inserted;
}
