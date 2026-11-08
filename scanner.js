const fs = require('node:fs');
const { chromium } = require('playwright');

const DATA_URL = 'https://cryptobubbles.net/backend/data/bubbles1000.usd.json';
const STATE_PATH = 'data/previous-scan.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_LIMIT = 4096;
const VIEWPORT = { width: 1440, height: 900 };

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

async function captureVisibleBubbleSymbols() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    await page.addInitScript(() => {
      const ids = new WeakMap();
      let nextId = 1;
      const idFor = canvas => {
        if (!ids.has(canvas)) ids.set(canvas, nextId++);
        return ids.get(canvas);
      };
      const originalText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
        try {
          const canvas = this.canvas;
          window.__bubbleCanvasText = window.__bubbleCanvasText || [];
          window.__bubbleCanvasText.push({
            canvasId: idFor(canvas),
            text: String(text).trim(),
            font: this.font,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height
          });
        } catch (_) {}
        return originalText.call(this, text, x, y, ...rest);
      };
      const originalImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
        try {
          if (source instanceof HTMLCanvasElement) {
            let dx, dy, dw, dh;
            if (args.length === 2) {
              [dx, dy] = args; dw = source.width; dh = source.height;
            } else if (args.length === 4) {
              [dx, dy, dw, dh] = args;
            } else if (args.length === 8) {
              [,,,, dx, dy, dw, dh] = args;
            }
            window.__bubbleDrawImages = window.__bubbleDrawImages || [];
            window.__bubbleDrawImages.push({
              sourceCanvasId: idFor(source),
              targetCanvasId: idFor(this.canvas),
              dx, dy, dw, dh,
              targetWidth: this.canvas.width,
              targetHeight: this.canvas.height
            });
          }
        } catch (_) {}
        return originalImage.call(this, source, ...args);
      };
    });

    await page.goto('https://cryptobubbles.net/en', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(20000);

    const editChart = page.locator('button[title="Edit chart"]').first();
    if (!(await editChart.count())) throw new Error('Crypto Bubbles Edit chart control was not found.');
    await editChart.click();
    await page.waitForTimeout(1200);

    const periodSelector = page.locator('button.configuration-select').first();
    if (!(await periodSelector.count())) throw new Error('Period selection control was not found.');
    await periodSelector.click({ force: true });
    await page.waitForTimeout(500);

    const fiveMin = page.getByRole('button', { name: '5 Min', exact: true });
    if (!(await fiveMin.count()) || !(await fiveMin.first().isVisible())) {
      throw new Error('5 Min option was not visible in the Period selection menu.');
    }
    await fiveMin.first().click();
    await page.waitForTimeout(1800);

    const activeOptions = await page.locator('button.select-option.active').allInnerTexts();
    if (!activeOptions.some(t => t.trim() === '5 Min')) {
      throw new Error('Could not verify that Period selection is set to 5 Min.');
    }

    await page.waitForTimeout(2500);
    await page.locator('button[title="Close window"]').click().catch(() => {});
    await page.waitForTimeout(7000);

    const selectedTopTab = await page.locator('button[role="tab"].selected').allInnerTexts().catch(() => []);
    if (selectedTopTab.length && !selectedTopTab.some(t => /^5m$/i.test(t.trim()))) {
      throw new Error(`Website top timeframe is not 5m: ${selectedTopTab.join(', ')}`);
    }

    const captured = await page.evaluate(() => {
      const text = window.__bubbleCanvasText || [];
      const draws = window.__bubbleDrawImages || [];
      const canvas = [...document.querySelectorAll('canvas')]
        .find(c => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      if (!canvas) throw new Error('Visible heatmap canvas was not found.');

      const rect = canvas.getBoundingClientRect();
      const targetCounts = new Map();
      for (const d of draws) {
        targetCounts.set(d.targetCanvasId, (targetCounts.get(d.targetCanvasId) || 0) + 1);
      }
      const targetCanvasId = [...targetCounts.entries()].sort((a,b) => b[1]-a[1])[0]?.[0];
      if (targetCanvasId === undefined) throw new Error('No bubble canvas draw operations were captured.');

      const targetDraws = draws.filter(d => d.targetCanvasId === targetCanvasId);
      const latestBySource = new Map();
      for (const d of targetDraws) latestBySource.set(d.sourceCanvasId, d);

      const labels = new Map();
      for (const t of text) {
        if (!labels.has(t.canvasId)) labels.set(t.canvasId, []);
        labels.get(t.canvasId).push(t.text);
      }

      const scaleX = rect.width / canvas.width;
      const scaleY = rect.height / canvas.height;
      const viewportLeft = Math.max(0, -rect.left) / scaleX;
      const viewportTop = Math.max(0, -rect.top) / scaleY;
      const viewportRight = Math.min(innerWidth, rect.right) - rect.left;
      const viewportBottom = Math.min(innerHeight, rect.bottom) - rect.top;
      const clipRight = viewportRight / scaleX;
      const clipBottom = viewportBottom / scaleY;

      const visible = [];
      for (const [sourceCanvasId, d] of latestBySource.entries()) {
        const words = labels.get(sourceCanvasId) || [];
        const symbol = words.find(w => /^[A-Z0-9]{1,12}$/.test(w));
        if (!symbol || !Number.isFinite(d.dx) || !Number.isFinite(d.dy) ||
            !Number.isFinite(d.dw) || !Number.isFinite(d.dh)) continue;

        // Tiny canvas stamps are logos/ads, not readable heatmap bubbles.
        if (d.dw < 28 || d.dh < 28) continue;
        const left = d.dx;
        const top = d.dy;
        const right = left + d.dw;
        const bottom = top + d.dh;
        const visibleWidth = Math.max(0, Math.min(clipRight, right) - Math.max(viewportLeft, left));
        const visibleHeight = Math.max(0, Math.min(clipBottom, bottom) - Math.max(viewportTop, top));
        const visibleFraction = (visibleWidth * visibleHeight) / (d.dw * d.dh);
        if (visibleFraction < 0.5) continue;

        visible.push({ symbol, sourceCanvasId, visibleFraction });
      }
      return {
        visible,
        canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        targetCanvasId,
        drawCount: targetDraws.length
      };
    });

    const unique = new Map();
    for (const item of captured.visible) unique.set(item.symbol, item);
    const symbols = [...unique.keys()];
    if (!symbols.length) throw new Error('No readable visible bubble symbols were captured from the heatmap viewport.');

    console.log('Verified 5m heatmap. Visible bubble symbols:', symbols.join(', '));
    console.log(`Visible symbols: ${symbols.length}; draw operations: ${captured.drawCount}; canvas: ${JSON.stringify(captured.canvasRect)}`);
    return symbols;
  } finally {
    await browser.close();
  }
}

async function main() {
  const visibleSymbols = await captureVisibleBubbleSymbols();

  const response = await fetch(DATA_URL, {
    headers: { 'user-agent': 'CryptoBubblesTelegramScanner/1.0' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Crypto Bubbles data request failed: HTTP ${response.status}`);

  const allCoins = await response.json();
  if (!Array.isArray(allCoins) || allCoins.length === 0) {
    throw new Error('Crypto Bubbles returned an empty or invalid coin list.');
  }

  const bySymbol = new Map();
  for (const coin of allCoins) {
    const symbol = String(coin.symbol || '').toUpperCase();
    if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, coin);
  }

  const missing = visibleSymbols.filter(symbol => !bySymbol.has(symbol));
  if (missing.length) {
    console.warn('Visible bubble symbols missing from live data:', missing.join(', '));
  }

  const visibleCoins = visibleSymbols
    .map(symbol => bySymbol.get(symbol))
    .filter(coin => coin && pct(coin.performance?.min5) !== null)
    .map(coin => ({
      name: String(coin.name || coin.symbol),
      symbol: String(coin.symbol).toUpperCase(),
      min5: pct(coin.performance.min5)
    }));

  if (!visibleCoins.length) {
    throw new Error('None of the captured visible bubbles matched live performance.min5 data. No Telegram message sent.');
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
    const old = previous[coin.symbol];
    const risingStreak = coin.min5 > 0 && old &&
      Number.isFinite(old.min5) && coin.min5 > old.min5
      ? (old.risingStreak || 0) + 1
      : 0;
    nextState[coin.symbol] = { min5: coin.min5, risingStreak };
    return { ...coin, risingStreak, improving: risingStreak >= 2 };
  });

  const green = rows.filter(c => c.min5 > 0).sort((a,b) => b.min5-a.min5);
  const red = rows.filter(c => c.min5 < 0).sort((a,b) => a.min5-b.min5);
  const flat = rows.filter(c => c.min5 === 0);
  const improving = rows.filter(c => c.improving).sort((a,b) => b.min5-a.min5);

  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false
  }).format(new Date());

  const section = (title, list) => [
    title,
    list.length ? list.map(c => `${c.symbol} ${signed(c.min5)}${c.improving ? ' 📈' : ''}`).join('  |  ') : 'None'
  ].join('\n');

  const lines = [
    '🫧 CRYPTO BUBBLES — 5m SCAN',
    `🕒 ${stamp} (Sri Lanka time)`,
    `👀 Visible heatmap bubbles only: ${rows.length}`,
    `🟢 ${green.length} UP  |  🔴 ${red.length} DOWN  |  ⚪ ${flat.length} FLAT`,
    '',
    section('🟢 GREEN / UP', green),
    '',
    section('🔴 RED / DOWN', red),
    '',
    section('⚪ NEUTRAL', flat),
    '',
    section('📈 POSITIVE & INCREASING FOR 2+ CONSECUTIVE SCANS', improving)
  ];

  let message = lines.join('\n');
  if (message.length > TELEGRAM_LIMIT) {
    const compact = [
      '🫧 CRYPTO BUBBLES — 5m SCAN',
      `🕒 ${stamp} (Sri Lanka time)`,
      `👀 Visible bubbles: ${rows.length} | 🟢 ${green.length} 🔴 ${red.length} ⚪ ${flat.length}`,
      `🟢 ${green.map(c => `${c.symbol} ${signed(c.min5)}`).join(' | ')}`,
      `🔴 ${red.map(c => `${c.symbol} ${signed(c.min5)}`).join(' | ')}`,
      `⚪ ${flat.map(c => c.symbol).join(' | ') || 'None'}`,
      `📈 Improving: ${improving.map(c => `${c.symbol} ${signed(c.min5)}`).join(' | ') || 'None'}`
    ];
    message = compact.join('\n');
  }
  if (message.length > TELEGRAM_LIMIT) {
    throw new Error(`The one-message report is ${message.length} characters, over Telegram's 4096-character limit. Nothing was sent.`);
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');

  const telegramResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(30000)
  });
  const telegramResult = await telegramResponse.json();
  if (!telegramResponse.ok || !telegramResult.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(telegramResult)}`);
  }

  console.log(`Sent one Telegram text message. Visible bubbles: ${rows.length}; green: ${green.length}; red: ${red.length}; neutral: ${flat.length}; improving: ${improving.length}; chars: ${message.length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
