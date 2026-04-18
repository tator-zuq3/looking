const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const http = require('http');

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL; // Published Google Sheet CSV URL
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required'); process.exit(1); }
if (!SHEET_CSV_URL) { console.error('❌ SHEET_CSV_URL is required'); process.exit(1); }

// ===================== CSV FETCH & PARSE =====================
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { headers: { 'User-Agent': 'WalletBot/1.0' } }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function parseCSV(csv) {
    const wallets = [];
    const lines = csv.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Parse CSV line (handles quoted fields)
        const fields = [];
        let current = '';
        let inQuotes = false;

        for (let j = 0; j < line.length; j++) {
            const ch = line[j];
            if (ch === '"') {
                if (inQuotes && line[j + 1] === '"') {
                    current += '"';
                    j++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                fields.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        fields.push(current.trim());

        if (fields.length < 2) continue;

        const address = fields[0].trim();
        const label = fields[1].trim();

        // Skip header row
        if (i === 0 && (address.toLowerCase() === 'address' || address.toLowerCase() === 'wallet')) continue;

        // Skip empty or invalid
        if (!address || !label) continue;

        wallets.push([address, label]);
    }

    return wallets;
}

// ===================== WALLET STORE =====================
let ALL_WALLETS = [];
let lastLoadTime = null;

function cleanAddress(addr) {
    // Strip quotes, whitespace, BOM, zero-width chars that Google Sheets may add
    return String(addr)
        .replace(/^[\s'""\u200B\uFEFF]+/, '')
        .replace(/[\s'""\u200B\uFEFF]+$/, '')
        .trim();
}

async function loadWallets() {
    try {
        console.log('📥 Fetching wallets from Google Sheet...');
        const csv = await fetchUrl(SHEET_CSV_URL);
        const rawWallets = parseCSV(csv);
        
        // Clean addresses
        const wallets = rawWallets.map(([addr, label]) => [cleanAddress(addr), label]);
        
        ALL_WALLETS = wallets;
        lastLoadTime = new Date();
        
        // Debug: log first 3 entries
        const evmCount = wallets.filter(([a]) => isEvm(a)).length;
        const solCount = wallets.filter(([a]) => isSol(a)).length;
        console.log(`✅ Loaded ${wallets.length} wallets (EVM: ${evmCount}, SOL: ${solCount}) at ${lastLoadTime.toISOString()}`);
        if (wallets.length > 0) {
            console.log('📋 Sample entries:');
            wallets.slice(0, 3).forEach(([a, l]) => console.log(`   [${a.length}] "${a}" → "${l}" (EVM: ${isEvm(a)}, SOL: ${isSol(a)})`));
        }
        
        return wallets.length;
    } catch (e) {
        console.error('❌ Failed to load wallets:', e.message);
        throw e;
    }
}

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

        if (seen.has(addrLow)) continue;

        if (addrLow.includes(q) || labelLow.includes(q)) {
            seen.add(addrLow);
            results.push({ address: String(addr), label: String(label) });
        }
    }

    return results;
}

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
        return `🔍 "<b>${escapeHtml(query)}</b>" — không tìm thấy.`;
    }

    const header = `🔍 "<b>${escapeHtml(query)}</b>" — ${results.length}${results.length >= MAX_RESULTS ? '+' : ''} kết quả:\n`;

    const lines = results.map((r) => {
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

function isAllowed(msg) {
    if (ALLOWED_USERS.length === 0) return true;
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
        '• Gõ <b>text</b> → search label',
        '',
        '📋 Commands:',
        '/search &lt;query&gt; — tìm kiếm',
        '/stats — thống kê',
        '/reload — refresh data từ Google Sheet',
        '',
        `📦 Loaded: <b>${ALL_WALLETS.length}</b> wallets`,
        lastLoadTime ? `🕐 Last load: ${lastLoadTime.toLocaleString('vi-VN')}` : '',
    ].filter(Boolean).join('\n');

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /stats
bot.onText(/\/stats/, (msg) => {
    if (!isAllowed(msg)) return unauthorized(msg);

    const evmCount = ALL_WALLETS.filter(([a]) => isEvm(a)).length;
    const solCount = ALL_WALLETS.filter(([a]) => isSol(a)).length;
    const otherCount = ALL_WALLETS.length - evmCount - solCount;
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
        lastLoadTime ? `🕐 Last load: ${lastLoadTime.toLocaleString('vi-VN')}` : '',
    ].filter(Boolean).join('\n');

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /reload
bot.onText(/\/reload/, async (msg) => {
    if (!isAllowed(msg)) return unauthorized(msg);

    const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ Đang reload data từ Google Sheet...');

    try {
        const count = await loadWallets();
        bot.editMessageText(`✅ Reload thành công! <b>${count}</b> wallets loaded.`, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
            parse_mode: 'HTML'
        });
    } catch (e) {
        bot.editMessageText(`❌ Reload thất bại: ${escapeHtml(e.message)}`, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
            parse_mode: 'HTML'
        });
    }
});

// /search <query>
bot.onText(/\/search\s+(.+)/, (msg, match) => {
    if (!isAllowed(msg)) return unauthorized(msg);

    const query = match[1].trim();
    const results = searchWallets(query);
    bot.sendMessage(msg.chat.id, formatResults(query, results), { parse_mode: 'HTML' });
});

// Any text → auto-detect address or search
bot.on('message', (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;
    if (!isAllowed(msg)) return unauthorized(msg);

    const text = msg.text.trim();
    if (!text) return;

    // Exact address lookup
    if (isEvm(text) || isSol(text)) {
        const exact = lookupAddress(text);
        if (exact) {
            bot.sendMessage(msg.chat.id, formatExactMatch(exact), { parse_mode: 'HTML' });
        } else {
            bot.sendMessage(msg.chat.id, `❌ Không tìm thấy.\n\n<code>${escapeHtml(text)}</code>`, { parse_mode: 'HTML' });
        }
        return;
    }

    // Search by label or partial address
    const results = searchWallets(text);
    bot.sendMessage(msg.chat.id, formatResults(text, results), { parse_mode: 'HTML' });
});

bot.on('polling_error', (err) => {
    console.error('Polling error:', err.code, err.message);
});

// ===================== STARTUP =====================
(async () => {
    try {
        await loadWallets();
        console.log('🤖 Wallet Lookup Bot is running...');
    } catch (e) {
        console.error('⚠️ Bot started but wallet data failed to load. Use /reload to retry.');
        console.log('🤖 Wallet Lookup Bot is running (no data)...');
    }
})();
