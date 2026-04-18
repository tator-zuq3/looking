const TelegramBot = require('node-telegram-bot-api');

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is required');
    process.exit(1);
}

// ===================== LOAD WALLETS =====================
function loadWallets() {
    let raw = [];
    let custom = [];

    // WALLETS_RAW: JSON array of [address, label] pairs
    // Supports splitting: WALLETS_RAW, WALLETS_RAW_2, WALLETS_RAW_3, ...
    try {
        const parts = [];
        if (process.env.WALLETS_RAW) parts.push(process.env.WALLETS_RAW);
        for (let i = 2; i <= 10; i++) {
            const key = `WALLETS_RAW_${i}`;
            if (process.env[key]) parts.push(process.env[key]);
        }
        if (parts.length > 0) {
            // Each part is a JSON array string, merge them
            for (const part of parts) {
                const parsed = JSON.parse(part);
                if (Array.isArray(parsed)) raw.push(...parsed);
            }
        }
    } catch (e) {
        console.error('⚠️ Error parsing WALLETS_RAW:', e.message);
    }

    // WALLETS_CUSTOM: JSON array of [address, label] pairs
    try {
        if (process.env.WALLETS_CUSTOM) {
            const parsed = JSON.parse(process.env.WALLETS_CUSTOM);
            if (Array.isArray(parsed)) custom = parsed;
        }
    } catch (e) {
        console.error('⚠️ Error parsing WALLETS_CUSTOM:', e.message);
    }

    console.log(`📦 Loaded ${raw.length} raw + ${custom.length} custom = ${raw.length + custom.length} wallets`);
    return { raw, custom };
}

const { raw: rawWallets, custom: customWallets } = loadWallets();

// Merged list: custom first (higher priority), then raw
const ALL_WALLETS = [...customWallets, ...rawWallets];

// ===================== HELPERS =====================
function isEvm(addr) {
    return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function isSol(addr) {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ===================== SEARCH =====================
const MAX_RESULTS = 30;

function searchWallets(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const results = [];
    const seen = new Set();

    for (const [addr, label] of ALL_WALLETS) {
        if (results.length >= MAX_RESULTS) break;

        const addrLow = String(addr).toLowerCase();
        const labelLow = String(label).toLowerCase();

        // Deduplicate by address
        if (seen.has(addrLow)) continue;

        // Match: address contains query OR label contains query
        if (addrLow.includes(q) || labelLow.includes(q)) {
            seen.add(addrLow);
            results.push({ address: String(addr), label: String(label) });
        }
    }

    return results;
}

// Exact address lookup (prioritize exact match)
function lookupAddress(addr) {
    const q = addr.trim().toLowerCase();
    for (const [a, label] of ALL_WALLETS) {
        if (String(a).toLowerCase() === q) {
            return { address: String(a), label: String(label) };
        }
    }
    return null;
}

// ===================== FORMAT =====================
function formatResults(query, results) {
    if (results.length === 0) {
        return `🔍 "<b>${escapeHtml(query)}</b>" — không tìm thấy kết quả nào.`;
    }

    const header = `🔍 "<b>${escapeHtml(query)}</b>" — ${results.length}${results.length >= MAX_RESULTS ? '+' : ''} kết quả:\n`;

    const lines = results.map((r, i) => {
        const tag = isEvm(r.address) ? '🔵' : isSol(r.address) ? '🟣' : '⚪';
        return `\n${tag} <b>${escapeHtml(r.label)}</b>\n<code>${escapeHtml(r.address)}</code>`;
    });

    return header + lines.join('\n');
}

function formatExactMatch(result) {
    const tag = isEvm(result.address) ? '🔵 EVM' : isSol(result.address) ? '🟣 SOL' : '⚪';
    return `✅ ${tag}\n\n<b>${escapeHtml(result.label)}</b>\n<code>${escapeHtml(result.address)}</code>`;
}

// ===================== TELEGRAM BOT =====================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Auth check
function isAllowed(msg) {
    if (ALLOWED_USERS.length === 0) return true; // no restriction
    const userId = String(msg.from?.id || '');
    const username = String(msg.from?.username || '').toLowerCase();
    return ALLOWED_USERS.includes(userId) || ALLOWED_USERS.includes(username);
}

function unauthorized(msg) {
    bot.sendMessage(msg.chat.id, '🚫 Unauthorized.');
}

// /start
bot.onText(/\/start/, (msg) => {
    if (!isAllowed(msg)) return unauthorized(msg);

    const text = [
        '👛 <b>Wallet Lookup Bot</b>',
        '',
        '📌 Cách dùng:',
        '• Paste <b>address</b> → tra label',
        '• Gõ <b>text</b> → search wallets có label chứa text đó',
        '',
        '📋 Commands:',
        '/search &lt;query&gt; — tìm kiếm',
        '/stats — thống kê số wallets',
        '',
        `📦 Loaded: <b>${ALL_WALLETS.length}</b> wallets`,
    ].join('\n');

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /stats
bot.onText(/\/stats/, (msg) => {
    if (!isAllowed(msg)) return unauthorized(msg);

    const evmCount = ALL_WALLETS.filter(([a]) => isEvm(a)).length;
    const solCount = ALL_WALLETS.filter(([a]) => isSol(a)).length;
    const otherCount = ALL_WALLETS.length - evmCount - solCount;

    // Count unique addresses
    const unique = new Set(ALL_WALLETS.map(([a]) => String(a).toLowerCase()));

    const text = [
        '📊 <b>Wallet Stats</b>',
        '',
        `Total entries: <b>${ALL_WALLETS.length}</b>`,
        `Unique addresses: <b>${unique.size}</b>`,
        `├ 🔵 EVM: <b>${evmCount}</b>`,
        `├ 🟣 SOL: <b>${solCount}</b>`,
        `└ ⚪ Other: <b>${otherCount}</b>`,
        '',
        `Raw: <b>${rawWallets.length}</b>`,
        `Custom: <b>${customWallets.length}</b>`,
    ].join('\n');

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /search <query>
bot.onText(/\/search\s+(.+)/, (msg, match) => {
    if (!isAllowed(msg)) return unauthorized(msg);

    const query = match[1].trim();
    const results = searchWallets(query);
    const text = formatResults(query, results);

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// Any text message → auto-detect address lookup or label search
bot.on('message', (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return; // skip commands
    if (!isAllowed(msg)) return unauthorized(msg);

    const text = msg.text.trim();
    if (!text) return;

    // Try exact address lookup first
    if (isEvm(text) || isSol(text)) {
        const exact = lookupAddress(text);
        if (exact) {
            bot.sendMessage(msg.chat.id, formatExactMatch(exact), { parse_mode: 'HTML' });
            return;
        }
        // Address format but not found
        bot.sendMessage(msg.chat.id, `❌ Address không có trong danh sách.\n\n<code>${escapeHtml(text)}</code>`, { parse_mode: 'HTML' });
        return;
    }

    // Otherwise: search by label or partial address
    const results = searchWallets(text);
    const output = formatResults(text, results);
    bot.sendMessage(msg.chat.id, output, { parse_mode: 'HTML' });
});

// Error handling
bot.on('polling_error', (err) => {
    console.error('Polling error:', err.code, err.message);
});

console.log('🤖 Wallet Lookup Bot is running...');
