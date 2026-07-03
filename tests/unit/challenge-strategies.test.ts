/**
 * Challenge Strategy Tests
 *
 * Deterministic fixtures: OHLCV series for the crypto trend strategy,
 * market/orderbook fixtures for the prediction value/arb strategy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OHLCV } from '../../src/feeds/crypto/index.js';
import type { Market, Orderbook } from '../../src/types.js';
import { createChallengeCryptoStrategy } from '../../src/trading/challenge/strategies/crypto-momentum.js';
import { createChallengePredictionStrategy } from '../../src/trading/challenge/strategies/prediction-value.js';
import { atr, donchianHigh, donchianLow, ema } from '../../src/trading/challenge/strategies/indicators.js';

// ============================================================================
// FIXTURES
// ============================================================================

function makeBars(opts: { count: number; start?: number; step?: number; lastClose?: number }): OHLCV[] {
  const { count, start = 100, step = 0.5 } = opts;
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const close = start + i * step;
    bars.push({
      timestamp: new Date(1700000000000 + i * 3600_000),
      open: close - step,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    });
  }
  if (opts.lastClose != null) {
    const last = bars[bars.length - 1];
    last.close = opts.lastClose;
    last.high = Math.max(last.high, opts.lastClose + 0.5);
  }
  return bars;
}

function baseContext(over: Record<string, unknown> = {}) {
  return {
    portfolioValue: 500,
    availableBalance: 500,
    positions: new Map(),
    recentTrades: [],
    markets: new Map(),
    priceHistory: new Map(),
    timestamp: new Date('2026-07-03T12:00:00Z'),
    isBacktest: true,
    ...over,
  } as any;
}

function makeMarket(over: Partial<Market>): Market {
  return {
    id: 'mkt',
    platform: 'polymarket',
    slug: 'mkt',
    question: 'Will Bitcoin reach $100k by 2026?',
    outcomes: [{ id: 'yes', name: 'Yes', price: 0.4, volume24h: 1000 }],
    volume24h: 10000,
    liquidity: 5000,
    endDate: new Date('2026-07-13T00:00:00Z'),
    resolved: false,
    tags: [],
    url: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Market;
}

function makeBook(over: Partial<Orderbook> & { marketId: string; platform: Market['platform'] }): Orderbook {
  return {
    outcomeId: 'yes',
    bids: [[0.39, 500]],
    asks: [[0.41, 500]],
    spread: 0.02,
    midPrice: 0.4,
    timestamp: Date.now(),
    ...over,
  } as Orderbook;
}

// ============================================================================
// INDICATORS
// ============================================================================

describe('challenge indicators', () => {
  it('computes EMA, Donchian channels and ATR on a known series', () => {
    const bars = makeBars({ count: 60 });
    const closes = bars.map((b) => b.close);
    const emaFast = ema(closes, 20);
    const emaSlow = ema(closes, 50);
    assert.ok(emaFast != null && emaSlow != null);
    assert.ok(emaFast > emaSlow, 'rising series: fast EMA above slow');
    // Prior-20-bar high excludes the last bar: second-to-last close + 1
    assert.equal(donchianHigh(bars, 20), bars[bars.length - 2].close + 1);
    assert.equal(donchianLow(bars, 10), bars[bars.length - 11].close - 1);
    const a = atr(bars, 14);
    // TR is high-low = 2 with 0.5 drift; ATR settles near 2.5
    assert.ok(a != null && a > 1.5 && a < 3);
  });

  it('returns null on insufficient data', () => {
    const bars = makeBars({ count: 10 });
    assert.equal(ema(bars.map((b) => b.close), 20), null);
    assert.equal(donchianHigh(bars, 20), null);
    assert.equal(atr(bars, 14), null);
  });
});

// ============================================================================
// CRYPTO MOMENTUM
// ============================================================================

describe('challenge crypto momentum strategy', () => {
  it('emits a sized, stop-carrying buy on a Donchian breakout in an uptrend', async () => {
    const bars = makeBars({ count: 80, lastClose: 100 + 79 * 0.5 + 5 }); // breakout above prior high
    const strategy = createChallengeCryptoStrategy({
      getOHLCV: async (symbol) => (symbol === 'BTC' ? bars : []),
      params: { symbols: ['BTC'] },
    });
    const signals = await strategy.evaluate(baseContext());
    assert.equal(signals.length, 1);
    const sig = signals[0];
    assert.equal(sig.type, 'buy');
    assert.equal(sig.platform, 'binance');
    assert.equal(sig.marketId, 'BTC');
    const meta = sig.meta as any;
    assert.ok(meta.stopPrice < sig.price!, 'stop below entry');
    assert.ok(meta.trailDistance > 0);
    assert.ok(meta.trailActivationPrice > sig.price!);
    // Sized so stop-distance loss = 1% of portfolio
    const riskFraction = (sig.price! - meta.stopPrice) / sig.price!;
    assert.ok(Math.abs(sig.size! * riskFraction - 5) < 0.01, '1% of $500 = $5 at risk');
  });

  it('stays flat without a breakout', async () => {
    const bars = makeBars({ count: 80, lastClose: 100 + 78 * 0.5 }); // inside the prior range
    const strategy = createChallengeCryptoStrategy({
      getOHLCV: async () => bars,
      params: { symbols: ['BTC'] },
    });
    const signals = await strategy.evaluate(baseContext());
    assert.equal(signals.length, 0);
  });

  it('does not re-enter while holding, and exits on a Donchian-low break', async () => {
    const holding = baseContext({
      positions: new Map([['binance:BTC:long', { shares: 1, avgPrice: 130, currentPrice: 130 }]]),
    });
    // Crash: last close below the prior 10-bar low
    const crashed = makeBars({ count: 80 });
    crashed[crashed.length - 1].close = crashed[crashed.length - 12].low - 5;
    const strategy = createChallengeCryptoStrategy({
      getOHLCV: async () => crashed,
      params: { symbols: ['BTC'] },
    });
    const signals = await strategy.evaluate(holding);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'close');
    assert.match(signals[0].reason!, /Donchian/);
  });

  it('skips symbols with failing or short data', async () => {
    const strategy = createChallengeCryptoStrategy({
      getOHLCV: async (symbol) => {
        if (symbol === 'BTC') throw new Error('feed down');
        return makeBars({ count: 5 });
      },
      params: { symbols: ['BTC', 'ETH'] },
    });
    const signals = await strategy.evaluate(baseContext());
    assert.equal(signals.length, 0);
  });
});

// ============================================================================
// PREDICTION VALUE / ARB
// ============================================================================

describe('challenge prediction value/arb strategy', () => {
  function makeFeeds(opts: {
    polyPrice?: number;
    kalshiPrice?: number;
    polyBook?: Orderbook | null;
    kalshiBook?: Orderbook | null;
  }) {
    const poly = makeMarket({ id: 'poly-btc', platform: 'polymarket', outcomes: [{ id: 'yes', name: 'Yes', price: opts.polyPrice ?? 0.4, volume24h: 1000 }] });
    const kalshi = makeMarket({ id: 'kalshi-btc', platform: 'kalshi', outcomes: [{ id: 'yes', name: 'Yes', price: opts.kalshiPrice ?? 0.5, volume24h: 1000 }] });
    return {
      async searchMarkets(query: string, platform?: string) {
        if (!query.includes('bitcoin')) return [];
        if (platform === 'polymarket') return [poly];
        if (platform === 'kalshi') return [kalshi];
        return [poly, kalshi];
      },
      async getOrderbook(platform: string, marketId: string) {
        if (platform === 'polymarket' && marketId === 'poly-btc') {
          return opts.polyBook === undefined ? makeBook({ marketId, platform: 'polymarket' }) : opts.polyBook;
        }
        if (platform === 'kalshi' && marketId === 'kalshi-btc') {
          return opts.kalshiBook === undefined
            ? makeBook({ marketId, platform: 'kalshi', bids: [[0.49, 500]], asks: [[0.51, 500]], midPrice: 0.5 })
            : opts.kalshiBook;
        }
        return null;
      },
      async getMarket(marketId: string) {
        if (marketId === 'poly-btc') return poly;
        if (marketId === 'kalshi-btc') return kalshi;
        return null;
      },
    };
  }

  it('emits an arb-signal buy on the cheap side when the spread is executable', async () => {
    const strategy = createChallengePredictionStrategy({ feeds: makeFeeds({}) });
    const signals = await strategy.evaluate(baseContext());
    assert.equal(signals.length, 1);
    const sig = signals[0];
    assert.equal(sig.type, 'buy');
    assert.equal(sig.platform, 'polymarket'); // cheap side
    assert.equal(sig.marketId, 'poly-btc');
    assert.match(sig.reason!, /arb-signal/);
    const meta = sig.meta as any;
    assert.ok(Math.abs(meta.stopPrice - 0.4 * 0.7) < 1e-9, 'stop at -30% of entry');
    assert.equal(meta.anchorPlatform, 'kalshi');
  });

  it('falls back to a value entry when book depth cannot carry the arb', async () => {
    // Rich side has 1 share of depth: arb not executable, divergence still 0.10
    const strategy = createChallengePredictionStrategy({
      feeds: makeFeeds({
        kalshiBook: makeBook({ marketId: 'kalshi-btc', platform: 'kalshi', bids: [[0.49, 1]], asks: [[0.51, 1]], midPrice: 0.5 }),
      }),
    });
    const signals = await strategy.evaluate(baseContext());
    assert.equal(signals.length, 1);
    assert.match(signals[0].reason!, /value/);
  });

  it('skips when divergence is below threshold', async () => {
    const strategy = createChallengePredictionStrategy({
      feeds: makeFeeds({ polyPrice: 0.47, kalshiPrice: 0.5, kalshiBook: makeBook({ marketId: 'kalshi-btc', platform: 'kalshi', bids: [[0.49, 1]], asks: [[0.51, 1]] }) }),
    });
    const signals = await strategy.evaluate(baseContext());
    assert.equal(signals.length, 0);
  });

  it('does not re-enter a market it already holds', async () => {
    const strategy = createChallengePredictionStrategy({ feeds: makeFeeds({}) });
    const ctx = baseContext({
      positions: new Map([['polymarket:poly-btc:Yes', { shares: 100, avgPrice: 0.4, currentPrice: 0.42 }]]),
    });
    const signals = await strategy.evaluate(ctx);
    assert.equal(signals.filter((s: any) => s.type === 'buy').length, 0);
  });

  it('exits at take profit', async () => {
    const strategy = createChallengePredictionStrategy({ feeds: makeFeeds({}) });
    const ctx = baseContext({
      positions: new Map([['polymarket:poly-btc:Yes', { shares: 100, avgPrice: 0.4, currentPrice: 0.62 }]]),
    });
    const signals = await strategy.evaluate(ctx);
    const exit = signals.find((s: any) => s.type === 'close');
    assert.ok(exit, 'take-profit close expected');
    assert.match(exit!.reason!, /take profit/);
  });

  it('exits when resolution is approaching', async () => {
    const feeds = makeFeeds({});
    const strategy = createChallengePredictionStrategy({ feeds });
    const ctx = baseContext({
      timestamp: new Date('2026-07-12T12:00:00Z'), // 12h before the fixture endDate
      positions: new Map([['polymarket:poly-btc:Yes', { shares: 100, avgPrice: 0.4, currentPrice: 0.41 }]]),
    });
    const signals = await strategy.evaluate(ctx);
    const exit = signals.find((s: any) => s.type === 'close');
    assert.ok(exit);
    assert.match(exit!.reason!, /resolution/);
  });
});
