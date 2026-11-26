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
        doc.font('amiri');

        doc.fontSize(22).fillColor('#06302b').text(ar('تحكم: التقرير الأسبوعي'), { align: 'right' });
        doc.moveDown(0.3);
        doc.fontSize(13).fillColor('#0a423b')
            .text(ar(`${brand.name_ar || brand.name_en || ''}`), { align: 'right' })
            .text(ar(`الأسبوع من ${summary.range.start} إلى ${summary.range.end} · 7 أيام`), { align: 'right' })
            .text(ar(`أنشئ آليا في ${day(new Date().toISOString())} · تحكم`), { align: 'right' });
        doc.moveDown();

        doc.fontSize(15).fillColor('#06302b').text(ar('ملخص المبيعات حسب التطبيق'), { align: 'right' });
        doc.moveDown(0.4);
        doc.fontSize(11).fillColor('#000');
        const platforms = Object.entries(summary.by_platform);
        if (!platforms.length) {
            doc.text(ar('لا توجد طلبات مسجلة هذا الأسبوع.'), { align: 'right' });
        }
        for (const [p, s] of platforms) {
            const name = PLATFORM_AR[p] || p;
            doc.text(ar(`${name}: ${s.orders} طلب، مبيعات ${fmt(s.gross)} ر.س، صافي ${fmt(s.net)} ر.س، ملغي ${s.cancelled} (${fmt(s.cancelled_gross)} ر.س)`), { align: 'right' });
            doc.moveDown(0.2);
        }
        doc.moveDown();

        doc.fontSize(15).fillColor('#06302b').text(ar('الإجمالي'), { align: 'right' });
        doc.moveDown(0.4);
        doc.fontSize(11).fillColor('#000');
        const t = summary.totals;
        doc.text(ar(`الطلبات: ${t.orders} · المبيعات: ${fmt(t.gross)} ر.س · الصافي: ${fmt(t.net)} ر.س`), { align: 'right' });
        doc.text(ar(`الطلبات الملغاة: ${t.cancelled} · قيمتها: ${fmt(t.cancelled_gross)} ر.س`), { align: 'right' });
        doc.moveDown();

        if (summary.cancelled_recent.length) {
            doc.fontSize(15).fillColor('#06302b').text(ar('تفاصيل الطلبات الملغاة'), { align: 'right' });
            doc.moveDown(0.4);
            doc.fontSize(10).fillColor('#000');
            for (const c of summary.cancelled_recent) {
                doc.text(ar(`${c.date} · ${PLATFORM_AR[c.platform] || c.platform} · طلب ${c.id} · ${fmt(c.gross)} ر.س`), { align: 'right' });
                doc.moveDown(0.15);
            }
            doc.moveDown();
        }

        doc.fontSize(9).fillColor('#666').text(ar('تحكم: بوابة إدارة تطبيقات التوصيل. تقرير آلي للتاجر.'), { align: 'right' });
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
