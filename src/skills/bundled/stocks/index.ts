/**
 * Stocks Skill — US stocks & ETFs via Alpaca
 *
 * Paper trading by default; live requires ALPACA_LIVE_TRADING=true and
 * live API keys. DRY_RUN=true simulates orders without hitting the API.
 */

import * as alpaca from '../../../exchanges/alpaca';
import { logger } from '../../../utils/logger';

// =============================================================================
// HELPERS
// =============================================================================

function formatMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function getConfig(): alpaca.AlpacaConfig | null {
  const keyId = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_API_SECRET;
  if (!keyId || !secretKey) return null;
  return {
    keyId,
    secretKey,
    paper: process.env.ALPACA_LIVE_TRADING !== 'true',
    dryRun: process.env.DRY_RUN === 'true',
  };
}

function modeTag(config: alpaca.AlpacaConfig): string {
  const mode = config.paper === false ? 'LIVE' : 'PAPER';
  return config.dryRun ? `[${mode}, DRY RUN]` : `[${mode}]`;
}

const NEED_KEYS = 'Set ALPACA_API_KEY and ALPACA_API_SECRET (paper keys from https://app.alpaca.markets)';

/** Parse "<qty>" or "$<notional>" into an order sizing. */
function parseSize(sizeStr: string): { qty?: number; notional?: number } | null {
  if (sizeStr.startsWith('$')) {
    const notional = parseFloat(sizeStr.slice(1).replace(/,/g, ''));
    if (isNaN(notional) || notional <= 0) return null;
    return { notional };
  }
  const qty = parseFloat(sizeStr);
  if (isNaN(qty) || qty <= 0) return null;
  return { qty };
}

// =============================================================================
// ACCOUNT HANDLERS
// =============================================================================

async function handleAccount(): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;

  const a = await alpaca.getAccount(config);
  const lines = [
    `**Alpaca Account** ${modeTag(config)}`,
    '',
    `  Equity: ${formatMoney(a.equity)} | Cash: ${formatMoney(a.cash)}`,
    `  Buying Power: ${formatMoney(a.buyingPower)} | Portfolio: ${formatMoney(a.portfolioValue)}`,
    `  Status: ${a.status}`,
  ];
  if (a.patternDayTrader) lines.push(`  ⚠️ Pattern day trader (day trades: ${a.daytradeCount})`);
  return lines.join('\n');
}

async function handlePositions(): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;

  const positions = await alpaca.getPositions(config);
  if (positions.length === 0) return 'No open stock positions';

  const lines = [`**Stock Positions** ${modeTag(config)}`, ''];
  let totalPnl = 0;
  for (const p of positions) {
    const side = p.side === 'long' ? '🟢 LONG' : '🔴 SHORT';
    totalPnl += p.unrealizedPnl;
    lines.push(`  ${side} ${p.symbol} | ${p.qty} @ ${formatMoney(p.avgEntryPrice)} | now ${formatMoney(p.currentPrice)}`);
    lines.push(`       Value: ${formatMoney(p.marketValue)} | PnL: ${formatMoney(p.unrealizedPnl)} (${formatPct(p.unrealizedPnlPct)}) | Today: ${formatPct(p.changeTodayPct)}`);
  }
  lines.push('', `  Total unrealized PnL: ${formatMoney(totalPnl)}`);
  return lines.join('\n');
}

async function handleOrders(): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;

  const orders = await alpaca.getOpenOrders(config);
  if (orders.length === 0) return 'No open stock orders';

  const lines = [`**Open Stock Orders** ${modeTag(config)}`, ''];
  for (const o of orders) {
    const size = o.qty !== null ? `${o.qty}` : `$${o.notional}`;
    const price = o.limitPrice !== null ? ` @ ${formatMoney(o.limitPrice)}` : ' @ market';
    lines.push(`  [${o.id}] ${o.side.toUpperCase()} ${size} ${o.symbol}${price} | ${o.type}/${o.timeInForce} | ${o.status}`);
  }
  return lines.join('\n');
}

// =============================================================================
// MARKET DATA HANDLERS
// =============================================================================

async function handleQuote(symbol?: string): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;
  if (!symbol) return 'Usage: /stocks quote <symbol>\nExample: /stocks quote AAPL';

  const q = await alpaca.getQuote(config, symbol);
  const lines = [`**${q.symbol}**`];
  if (q.lastPrice !== null) lines.push(`  Last: ${formatMoney(q.lastPrice)}`);
  if (q.bidPrice !== null && q.askPrice !== null) {
    lines.push(`  Bid: ${formatMoney(q.bidPrice)} x${q.bidSize ?? 0} | Ask: ${formatMoney(q.askPrice)} x${q.askSize ?? 0}`);
  }
  return lines.join('\n');
}

async function handleClock(): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;

  const c = await alpaca.getClock(config);
  return [
    `**US Stock Market**: ${c.isOpen ? '🟢 OPEN' : '🔴 CLOSED'}`,
    `  Next open: ${c.nextOpen}`,
    `  Next close: ${c.nextClose}`,
  ].join('\n');
}

// =============================================================================
// TRADING HANDLERS
// =============================================================================

async function handleTrade(
  side: 'buy' | 'sell',
  symbol?: string,
  sizeStr?: string,
  limitStr?: string,
): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;
  if (!symbol || !sizeStr) {
    return [
      `Usage: /stocks ${side} <symbol> <qty|$amount> [limitPrice]`,
      `Examples:`,
      `  /stocks ${side} AAPL 10          # market order, 10 shares`,
      `  /stocks ${side} AAPL $500        # market order, $500 notional`,
      `  /stocks ${side} AAPL 10 185.50   # limit order at $185.50`,
    ].join('\n');
  }

  const size = parseSize(sizeStr);
  if (!size) return `Invalid size: ${sizeStr}`;

  let limitPrice: number | undefined;
  if (limitStr) {
    limitPrice = parseFloat(limitStr.replace(/^\$/, ''));
    if (isNaN(limitPrice) || limitPrice <= 0) return `Invalid limit price: ${limitStr}`;
  }

  const order = await alpaca.placeOrder(config, { symbol, side, ...size, limitPrice });

  const emoji = side === 'buy' ? '🟢' : '🔴';
  const sizeLabel = order.qty !== null ? `${order.qty} shares` : `$${order.notional}`;
  const priceLabel = order.limitPrice !== null ? ` @ ${formatMoney(order.limitPrice)}` : ' @ market';
  return `${emoji} ${side.toUpperCase()} ${sizeLabel} ${order.symbol}${priceLabel} ${modeTag(config)} | ${order.status} | Order: ${order.id}`;
}

async function handleClose(symbol?: string): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;
  if (!symbol) return 'Usage: /stocks close <symbol>';

  const order = await alpaca.closePosition(config, symbol);
  if (!order) return `No open position for ${symbol.toUpperCase()}`;
  return `Closed ${order.symbol} ${modeTag(config)} | ${order.status} | Order: ${order.id}`;
}

async function handleCloseAll(): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;

  const orders = await alpaca.closeAllPositions(config);
  if (orders.length === 0) return `No positions to close ${modeTag(config)}`;

  const lines = [`**Closing all positions** ${modeTag(config)}`];
  for (const o of orders) lines.push(`  ${o.symbol}: ${o.status}`);
  return lines.join('\n');
}

async function handleCancel(orderId?: string): Promise<string> {
  const config = getConfig();
  if (!config) return NEED_KEYS;
  if (!orderId) return 'Usage: /stocks cancel <orderId|all>';

  if (orderId.toLowerCase() === 'all') {
    const count = await alpaca.cancelAllOrders(config);
    return `Cancelled ${count} order(s) ${modeTag(config)}`;
  }
  await alpaca.cancelOrder(config, orderId);
  return `Cancelled order ${orderId} ${modeTag(config)}`;
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

const skill = {
  name: 'stocks',
  description: 'US stocks & ETFs trading via Alpaca (paper-first)',
  commands: ['/stocks'],
  requires: { env: ['ALPACA_API_KEY', 'ALPACA_API_SECRET'] },

  async handle(args: string): Promise<string> {
    const parts = args.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    try {
      switch (cmd) {
        case 'account': case 'balance': case 'bal': return handleAccount();
        case 'positions': case 'pos': return handlePositions();
        case 'orders': return handleOrders();
        case 'quote': case 'q': case 'price': case 'p': return handleQuote(parts[1]);
        case 'buy': case 'b': return handleTrade('buy', parts[1], parts[2], parts[3]);
        case 'sell': case 's': return handleTrade('sell', parts[1], parts[2], parts[3]);
        case 'close': return handleClose(parts[1]);
        case 'closeall': return handleCloseAll();
        case 'cancel': return handleCancel(parts[1]);
        case 'clock': case 'market': case 'hours': return handleClock();
        default:
          return [
            '**Stocks Commands** (/stocks) — US stocks & ETFs via Alpaca',
            '',
            '**Account:** account, positions, orders',
            '**Trading:** buy/sell <sym> <qty|$amt> [limit], close <sym>, closeall, cancel <id|all>',
            '**Market:** quote <sym>, clock',
            '',
            'Paper trading by default. Set ALPACA_LIVE_TRADING=true for live (with live keys).',
          ].join('\n');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message, args }, 'Stocks command failed');
      return `Error: ${message}`;
    }
  },
};

export default skill;
