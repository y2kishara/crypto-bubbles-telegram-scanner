const fs = require('node:fs');

const DATA_URL = 'https://cryptobubbles.net/backend/data/bubbles1000.usd.json';
const STATE_PATH = 'data/previous-scan.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const VISIBLE_RANK_MIN = 1;
const VISIBLE_RANK_MAX = 100;
const TELEGRAM_LIMIT = 4096;

if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID GitHub Secrets.');
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function signed(value) {
  if (value === null) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

async function main() {
  const response = await fetch(DATA_URL, {
    headers: { 'user-agent': 'CryptoBubblesTelegramScanner/1.0' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Crypto Bubbles data request failed: HTTP ${response.status}`);

  const allCoins = await response.json();
  if (!Array.isArray(allCoins) || allCoins.length === 0) {
    throw new Error('Crypto Bubbles returned an empty or invalid coin list.');
  }

  // The site's visible selector defaults to ranks 1–100.
  // Scan only coins in that displayed range, and only those with a 5m value.
  const visibleCoins = allCoins
    .filter(coin => {
      const rank = Number(coin.rank);
      return Number.isFinite(rank) &&
        rank >= VISIBLE_RANK_MIN &&
        rank <= VISIBLE_RANK_MAX &&
        pct(coin.performance?.min5) !== null;
    })
    .sort((a, b) => Number(a.rank) - Number(b.rank));

  if (visibleCoins.length === 0) {
    throw new Error('No coins with 5-minute performance were found in the visible rank range 1–100.');
  }

  let previous = {};
  if (fs.existsSync(STATE_PATH)) {
    try {
      previous = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (error) {
      console.warn('Previous scan state could not be read; starting fresh:', error.message);
    }
  }

  const nextState = {};
  const rows = visibleCoins.map(coin => {
    const symbol = String(coin.symbol || coin.slug || coin.id);
    const current = pct(coin.performance?.min5);
    const old = previous[symbol];
    const risingStreak = current > 0 && old &&
      Number.isFinite(old.min5) && current > old.min5
      ? (old.risingStreak || 0) + 1
      : 0;

    const trend = current > 0 ? 'GREEN' : current < 0 ? 'RED' : 'FLAT';
    nextState[symbol] = { min5: current, risingStreak };

    return {
      rank: Number(coin.rank),
      name: String(coin.name || symbol),
      symbol,
      min5: current,
      trend,
      risingStreak,
      improving: risingStreak >= 2
    };
  });

  const green = rows.filter(c => c.trend === 'GREEN').sort((a, b) => b.min5 - a.min5);
  const red = rows.filter(c => c.trend === 'RED').sort((a, b) => a.min5 - b.min5);
  const flat = rows.filter(c => c.trend === 'FLAT');
  const improving = rows.filter(c => c.improving).sort((a, b) => b.min5 - a.min5);

  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false
  }).format(new Date());

  const section = (title, list) => [
    title,
    list.length
      ? list.map(c => `${c.symbol} ${signed(c.min5)}${c.improving ? ' 📈' : ''}`).join('  |  ')
      : 'None'
  ].join('\n');

  const lines = [
    '🫧 CRYPTO BUBBLES — 5m SCAN',
    `🕒 ${stamp} (Sri Lanka time)`,
    `👀 Website visible range: ranks ${VISIBLE_RANK_MIN}–${VISIBLE_RANK_MAX}`,
    `🪙 Coins scanned: ${rows.length} | 🟢 ${green.length} | 🔴 ${red.length} | ⚪ ${flat.length}`,
    '',
    section('🟢 GREEN / UP', green),
    '',
    section('🔴 RED / DOWN', red),
    '',
    section('⚪ FLAT', flat),
    '',
    section('📈 CONTINUOUSLY IMPROVING (2+ consecutive scans)', improving),
    '',
    '↗️ = positive 5m change increased on each of the last two scan comparisons.'
  ];

  let message = lines.join('\n');
  if (message.length > TELEGRAM_LIMIT) {
    // Keep a single normal text message; trim only lower-priority detail if the
    // Telegram limit is exceeded, never send a document or split into messages.
    const compactLines = [
      '🫧 CRYPTO BUBBLES — 5m SCAN',
      `🕒 ${stamp} (Sri Lanka time)`,
      `👀 Visible ranks ${VISIBLE_RANK_MIN}–${VISIBLE_RANK_MAX}; scanned ${rows.length}`,
      `🟢 ${green.length} | 🔴 ${red.length} | ⚪ ${flat.length}`,
      '',
      `🟢 ${green.map(c => `${c.symbol} ${signed(c.min5)}`).join(' | ')}`,
      '',
      `🔴 ${red.map(c => `${c.symbol} ${signed(c.min5)}`).join(' | ')}`,
      '',
      `⚪ ${flat.map(c => c.symbol).join(' | ') || 'None'}`,
      '',
      `📈 Improving 2+ scans: ${improving.map(c => `${c.symbol} ${signed(c.min5)}`).join(' | ') || 'None'}`
    ];
    message = compactLines.join('\n');
  }

  if (message.length > TELEGRAM_LIMIT) {
    throw new Error(`The visible-coin text report is ${message.length} characters, exceeding Telegram's ${TELEGRAM_LIMIT}-character message limit. No partial message was sent.`);
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');

  const telegramResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(30000)
  });

  const telegramResult = await telegramResponse.json();
  if (!telegramResponse.ok || !telegramResult.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(telegramResult)}`);
  }

  console.log(`Telegram text message sent. Visible coins: ${rows.length}; green: ${green.length}; red: ${red.length}; flat: ${flat.length}; improving: ${improving.length}; characters: ${message.length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
