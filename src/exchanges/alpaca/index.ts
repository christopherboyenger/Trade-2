/**
 * Alpaca Integration — US stocks & ETFs
 *
 * Paper and live trading share the same REST shape; `config.paper` selects
 * the base URL and must match the key pair in use (paper keys only work
 * against the paper endpoint and vice versa).
 * Docs: https://docs.alpaca.markets/reference
 */

import { logger } from '../../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  /** Paper trading (default true). Live requires live keys. */
  paper?: boolean;
  dryRun?: boolean;
}

export interface Account {
  equity: number;
  cash: number;
  buyingPower: number;
  portfolioValue: number;
  currency: string;
  status: string;
  patternDayTrader: boolean;
  daytradeCount: number;
}

export interface Position {
  symbol: string;
  qty: number;
  side: 'long' | 'short';
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  changeTodayPct: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  qty: number | null;
  notional: number | null;
  limitPrice: number | null;
  filledQty: number;
  filledAvgPrice: number | null;
  timeInForce: string;
  status: string;
  submittedAt: string;
}

export interface Quote {
  symbol: string;
  lastPrice: number | null;
  bidPrice: number | null;
  bidSize: number | null;
  askPrice: number | null;
  askSize: number | null;
}

export interface MarketClock {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
}

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  /** Number of shares (fractional allowed for market orders). */
  qty?: number;
  /** Dollar amount (market orders only). Exactly one of qty/notional. */
  notional?: number;
  limitPrice?: number;
  timeInForce?: 'day' | 'gtc';
  extendedHours?: boolean;
}

// =============================================================================
// HTTP
// =============================================================================

const PAPER_BASE = 'https://paper-api.alpaca.markets';
const LIVE_BASE = 'https://api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function tradingBase(config: AlpacaConfig): string {
  return config.paper === false ? LIVE_BASE : PAPER_BASE;
}

function authHeaders(config: AlpacaConfig): Record<string, string> {
  return {
    'APCA-API-KEY-ID': config.keyId,
    'APCA-API-SECRET-KEY': config.secretKey,
    'Content-Type': 'application/json',
  };
}

async function request<T>(
  config: AlpacaConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { base?: string; body?: unknown } = {},
): Promise<T> {
  const url = `${opts.base ?? tradingBase(config)}${path}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(config),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Alpaca ${res.status}: ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

function num(v: unknown): number {
  const n = parseFloat(String(v ?? ''));
  return Number.isNaN(n) ? 0 : n;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
}

export function normalizeSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw new Error(`Invalid stock symbol: ${symbol}`);
  return s;
}

function mapOrder(o: Record<string, unknown>): Order {
  return {
    id: String(o.id ?? ''),
    symbol: String(o.symbol ?? ''),
    side: o.side === 'sell' ? 'sell' : 'buy',
    type: String(o.type ?? o.order_type ?? ''),
    qty: numOrNull(o.qty),
    notional: numOrNull(o.notional),
    limitPrice: numOrNull(o.limit_price),
    filledQty: num(o.filled_qty),
    filledAvgPrice: numOrNull(o.filled_avg_price),
    timeInForce: String(o.time_in_force ?? ''),
    status: String(o.status ?? ''),
    submittedAt: String(o.submitted_at ?? ''),
  };
}

// =============================================================================
// ORDER VALIDATION (exported for tests)
// =============================================================================

export function buildOrderPayload(req: OrderRequest): Record<string, unknown> {
  const symbol = normalizeSymbol(req.symbol);

  const hasQty = req.qty !== undefined;
  const hasNotional = req.notional !== undefined;
  if (hasQty === hasNotional) {
    throw new Error('Specify exactly one of qty or notional');
  }
  if (hasQty && (!Number.isFinite(req.qty!) || req.qty! <= 0)) {
    throw new Error(`Invalid qty: ${req.qty}`);
  }
  if (hasNotional && (!Number.isFinite(req.notional!) || req.notional! <= 0)) {
    throw new Error(`Invalid notional: ${req.notional}`);
  }

  const isLimit = req.limitPrice !== undefined;
  if (isLimit && (!Number.isFinite(req.limitPrice!) || req.limitPrice! <= 0)) {
    throw new Error(`Invalid limit price: ${req.limitPrice}`);
  }
  if (isLimit && hasNotional) {
    throw new Error('Notional ($ amount) orders must be market orders');
  }

  const payload: Record<string, unknown> = {
    symbol,
    side: req.side,
    type: isLimit ? 'limit' : 'market',
    time_in_force: req.timeInForce ?? 'day',
  };
  if (hasQty) payload.qty = String(req.qty);
  if (hasNotional) payload.notional = String(req.notional);
  if (isLimit) payload.limit_price = String(req.limitPrice);
  if (req.extendedHours) payload.extended_hours = true;
  return payload;
}

// =============================================================================
// ACCOUNT & MARKET DATA
// =============================================================================

export async function getAccount(config: AlpacaConfig): Promise<Account> {
  const a = await request<Record<string, unknown>>(config, 'GET', '/v2/account');
  return {
    equity: num(a.equity),
    cash: num(a.cash),
    buyingPower: num(a.buying_power),
    portfolioValue: num(a.portfolio_value),
    currency: String(a.currency ?? 'USD'),
    status: String(a.status ?? ''),
    patternDayTrader: a.pattern_day_trader === true,
    daytradeCount: num(a.daytrade_count),
  };
}

export async function getPositions(config: AlpacaConfig): Promise<Position[]> {
  const positions = await request<Array<Record<string, unknown>>>(config, 'GET', '/v2/positions');
  return positions.map((p) => ({
    symbol: String(p.symbol ?? ''),
    qty: num(p.qty),
    side: p.side === 'short' ? 'short' : 'long',
    avgEntryPrice: num(p.avg_entry_price),
    currentPrice: num(p.current_price),
    marketValue: num(p.market_value),
    unrealizedPnl: num(p.unrealized_pl),
    unrealizedPnlPct: num(p.unrealized_plpc) * 100,
    changeTodayPct: num(p.change_today) * 100,
  }));
}

export async function getOpenOrders(config: AlpacaConfig): Promise<Order[]> {
  const orders = await request<Array<Record<string, unknown>>>(
    config,
    'GET',
    '/v2/orders?status=open&limit=100',
  );
  return orders.map(mapOrder);
}

export async function getQuote(config: AlpacaConfig, symbol: string): Promise<Quote> {
  const sym = normalizeSymbol(symbol);
  const [tradeRes, quoteRes] = await Promise.allSettled([
    request<{ trade?: { p?: number } }>(config, 'GET', `/v2/stocks/${sym}/trades/latest`, { base: DATA_BASE }),
    request<{ quote?: { bp?: number; bs?: number; ap?: number; as?: number } }>(
      config,
      'GET',
      `/v2/stocks/${sym}/quotes/latest`,
      { base: DATA_BASE },
    ),
  ]);

  const trade = tradeRes.status === 'fulfilled' ? tradeRes.value.trade : undefined;
  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value.quote : undefined;
  if (!trade && !quote) {
    const reason = tradeRes.status === 'rejected' ? tradeRes.reason : (quoteRes as PromiseRejectedResult).reason;
    throw new Error(`No data for ${sym}: ${reason instanceof Error ? reason.message : String(reason)}`);
  }

  return {
    symbol: sym,
    lastPrice: numOrNull(trade?.p),
    bidPrice: numOrNull(quote?.bp),
    bidSize: numOrNull(quote?.bs),
    askPrice: numOrNull(quote?.ap),
    askSize: numOrNull(quote?.as),
  };
}

export async function getClock(config: AlpacaConfig): Promise<MarketClock> {
  const c = await request<Record<string, unknown>>(config, 'GET', '/v2/clock');
  return {
    isOpen: c.is_open === true,
    nextOpen: String(c.next_open ?? ''),
    nextClose: String(c.next_close ?? ''),
  };
}

// =============================================================================
// TRADING
// =============================================================================

function createDryRunOrder(payload: Record<string, unknown>): Order {
  return {
    id: `dry_${Date.now()}`,
    symbol: String(payload.symbol),
    side: payload.side === 'sell' ? 'sell' : 'buy',
    type: String(payload.type),
    qty: numOrNull(payload.qty),
    notional: numOrNull(payload.notional),
    limitPrice: numOrNull(payload.limit_price),
    filledQty: 0,
    filledAvgPrice: null,
    timeInForce: String(payload.time_in_force),
    status: 'accepted (dry run)',
    submittedAt: new Date().toISOString(),
  };
}

export async function placeOrder(config: AlpacaConfig, req: OrderRequest): Promise<Order> {
  const payload = buildOrderPayload(req);

  if (config.dryRun) {
    logger.info({ payload }, '[DRY RUN] Alpaca order');
    return createDryRunOrder(payload);
  }

  const o = await request<Record<string, unknown>>(config, 'POST', '/v2/orders', { body: payload });
  return mapOrder(o);
}

export async function cancelOrder(config: AlpacaConfig, orderId: string): Promise<void> {
  if (config.dryRun) {
    logger.info({ orderId }, '[DRY RUN] Alpaca cancel order');
    return;
  }
  await request<void>(config, 'DELETE', `/v2/orders/${encodeURIComponent(orderId)}`);
}

export async function cancelAllOrders(config: AlpacaConfig): Promise<number> {
  if (config.dryRun) {
    logger.info('[DRY RUN] Alpaca cancel all orders');
    return 0;
  }
  const results = await request<Array<Record<string, unknown>>>(config, 'DELETE', '/v2/orders');
  return Array.isArray(results) ? results.length : 0;
}

export async function closePosition(config: AlpacaConfig, symbol: string): Promise<Order | null> {
  const sym = normalizeSymbol(symbol);
  if (config.dryRun) {
    logger.info({ symbol: sym }, '[DRY RUN] Alpaca close position');
    return createDryRunOrder({ symbol: sym, side: 'sell', type: 'market', time_in_force: 'day' });
  }
  try {
    const o = await request<Record<string, unknown>>(config, 'DELETE', `/v2/positions/${sym}`);
    return mapOrder(o);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Alpaca 404')) return null;
    throw error;
  }
}

export async function closeAllPositions(config: AlpacaConfig): Promise<Order[]> {
  if (config.dryRun) {
    logger.info('[DRY RUN] Alpaca close all positions');
    return [];
  }
  const results = await request<Array<{ body?: Record<string, unknown> }>>(
    config,
    'DELETE',
    '/v2/positions',
  );
  if (!Array.isArray(results)) return [];
  return results.filter((r) => r.body).map((r) => mapOrder(r.body!));
}
