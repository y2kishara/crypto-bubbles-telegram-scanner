const fs = require('node:fs');

const DATA_URL = 'https://cryptobubbles.net/backend/data/bubbles1000.usd.json';
const STATE_PATH = 'data/previous-scan.json';
const REPORT_PATH = 'latest-scan.txt';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

function price(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) :
    n.toLocaleString('en-US', { maximumSignificantDigits: 6 });
}

async function main() {
  const response = await fetch(DATA_URL, {
    headers: { 'user-agent': 'CryptoBubblesTelegramScanner/1.0' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Crypto Bubbles data request failed: HTTP ${response.status}`);

  const coins = await response.json();
  if (!Array.isArray(coins) || coins.length === 0) {
    throw new Error('Crypto Bubbles returned an empty or invalid coin list.');
  }

  let previous = {};
  if (fs.existsSync(STATE_PATH)) {
    try {
      previous = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (error) {
      console.warn('Previous state could not be read; treating this as the first scan:', error.message);
    }
  }

  const nextState = {};
  const rows = coins.map(coin => {
    const symbol = String(coin.symbol || coin.slug || coin.id);
    const current = pct(coin.performance?.min5);
    const old = previous[symbol];
    let risingStreak = 0;

    if (current !== null && old && Number.isFinite(old.min5) && current > 0 && current > old.min5) {
      risingStreak = (old.risingStreak || 0) + 1;
    }

    const trend = current === null ? 'NO DATA' :
      current > 0 ? 'GREEN' : current < 0 ? 'RED' : 'FLAT';

    const row = {
      rank: Number(coin.rank) || 999999,
      name: String(coin.name || symbol),
      symbol,
      price: Number(coin.price),
      marketcap: Number(coin.marketcap),
      volume: Number(coin.volume),
      min5: current,
      day: pct(coin.performance?.day),
      trend,
      risingStreak,
      improving: risingStreak >= 2
    };

    nextState[symbol] = { min5: current, risingStreak };
    return row;
  });

  const green = rows.filter(c => c.trend === 'GREEN');
  const red = rows.filter(c => c.trend === 'RED');
  const flat = rows.filter(c => c.trend === 'FLAT');
  const missing = rows.filter(c => c.trend === 'NO DATA');
  const improving = rows.filter(c => c.improving).sort((a, b) => b.min5 - a.min5);
  const strongest = [...green].sort((a, b) => b.min5 - a.min5).slice(0, 5);
  const weakest = [...red].sort((a, b) => a.min5 - b.min5).slice(0, 5);

  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const lines = [
    'CRYPTO BUBBLES — 5 MINUTE MARKET SCAN',
    `Scan time: ${stamp}`,
    `Coins scanned: ${rows.length} | Green: ${green.length} | Red: ${red.length} | Flat: ${flat.length} | Missing: ${missing.length}`,
    '',
    'CONTINUOUSLY IMPROVING',
    'Definition: positive 5-minute performance that increased on at least two consecutive scan-to-scan comparisons.',
    improving.length ? improving.map(c => `${c.symbol} (${c.name}) ${signed(c.min5)} | improving comparisons: ${c.risingStreak}`).join('\n') : 'No coins met the consecutive-improvement rule this scan.',
    '',
    'STRONGEST 5-MINUTE MOVERS',
    strongest.length ? strongest.map(c => `${c.symbol} ${signed(c.min5)}`).join(' | ') : 'None',
    '',
    'WEAKEST 5-MINUTE MOVERS',
    weakest.length ? weakest.map(c => `${c.symbol} ${signed(c.min5)}`).join(' | ') : 'None',
    '',
    'ALL COINS (sorted by 5-minute performance)',
    'Rank | Symbol | Name | Price USD | 5m % | 24h % | Trend | Rising comparisons'
  ];

  rows.sort((a, b) => {
    const av = a.min5 === null ? -Infinity : a.min5;
    const bv = b.min5 === null ? -Infinity : b.min5;
    return bv - av;
  });

  for (const c of rows) {
    lines.push([
      c.rank,
      c.symbol,
      c.name.replace(/[|\r\n]/g, ' '),
      price(c.price),
      signed(c.min5),
      signed(c.day),
      c.trend,
      c.risingStreak
    ].join(' | '));
  }

  const report = lines.join('\n') + '\n';
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');
  fs.writeFileSync(REPORT_PATH, report);

  const topUp = strongest.map(c => `${c.symbol} ${signed(c.min5)}`).join(', ') || 'None';
  const topDown = weakest.map(c => `${c.symbol} ${signed(c.min5)}`).join(', ') || 'None';
  const caption = [
    '🫧 CRYPTO BUBBLES — 5m SCAN',
    `🕒 ${stamp}`,
    `🪙 Scanned: ${rows.length} | 🟢 ${green.length} | 🔴 ${red.length} | ⚪ ${flat.length}`,
    `📈 Improving for 2+ consecutive comparisons: ${improving.length}`,
    `🚀 Top: ${topUp}`,
    `🔻 Bottom: ${topDown}`,
    'Full coin-by-coin report is attached.'
  ].join('\n');

  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption.slice(0, 1000));
  form.append('document', new Blob([report], { type: 'text/plain' }), 'crypto-bubbles-5m-report.txt');

  const telegramResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30000)
  });
  const telegramResult = await telegramResponse.json();
  if (!telegramResponse.ok || !telegramResult.ok) {
    throw new Error(`Telegram sendDocument failed: ${JSON.stringify(telegramResult)}`);
  }

  console.log(`Telegram report sent. Coins: ${rows.length}; green: ${green.length}; red: ${red.length}; flat: ${flat.length}; improving: ${improving.length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
