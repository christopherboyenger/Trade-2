/**
 * PolyBot engine tests
 *
 * The engine is clock- and dependency-injected, so the whole decision path
 * (signal → gate → exec → settle) runs on fixtures with a fake clock.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WhaleTrade } from '../../src/feeds/polymarket/whale-tracker.js';
import type { CandidateSignal, PolybotConfig } from '../../src/trading/polybot/types.js';
import { DEFAULT_POLYBOT_CONFIG } from '../../src/trading/polybot/types.js';
import {
  createPolybotEngine,
  evaluateGates,
  momentumConfidence,
  whaleConfidence,
  type PolybotMarket,
} from '../../src/trading/polybot/engine.js';

// ============================================================================
// FIXTURES
// ============================================================================

const T0 = 1_750_000_000_000;

function makeClock(start = T0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function signal(over: Partial<CandidateSignal> = {}): CandidateSignal {
  return {
    kind: 'whale',
    marketId: 'mkt-1',
    tokenId: 'tok-1',
    label: 'btc-up-or-do',
    side: 'YES',
    price: 0.5,
    confidence: 0.8,
    detail: 'test',
    ...over,
  };
}

function gateState(over: Record<string, unknown> = {}) {
  return {
    openPositions: 0,
    openExposureUsd: 0,
    dailyPnlUsd: 0,
    lastEntryAtByMarket: new Map<string, number>(),
    hasPositionInMarket: false,
    nowMs: T0,
    ...over,
  };
}

function whaleTrade(over: Partial<WhaleTrade> = {}): WhaleTrade {
  return {
    id: 'wt-1',
    timestamp: new Date(T0),
    marketId: 'mkt-whale',
    marketQuestion: 'Man City win the league?',
    tokenId: 'tok-yes',
    outcome: 'Yes',
    side: 'BUY',
    price: 0.55,
    size: 40000,
    usdValue: 22000,
    maker: '0xmaker',
    taker: '0xtaker',
    ...over,
  };
}

function market(over: Partial<PolybotMarket> = {}): PolybotMarket {
  return {
    marketId: 'mkt-btc-15m',
    label: 'btc-up-or-down',
    asset: 'BTC',
    yesTokenId: 'tok-up',
    noTokenId: 'tok-down',
    yesPrice: 0.5,
    noPrice: 0.5,
    expiresAt: T0 + 15 * 60_000,
    negRisk: true,
    ...over,
  };
}

const CFG: PolybotConfig = { ...DEFAULT_POLYBOT_CONFIG };

// ============================================================================
// CONFIDENCE MODELS
// ============================================================================

describe('confidence models', () => {
  it('whale confidence grows with print size and caps at 0.95', () => {
    assert.equal(whaleConfidence(5000, 10000, 0.5), 0); // below min
    const atMin = whaleConfidence(10000, 10000, 0.7);
    assert.ok(Math.abs(atMin - 0.5) < 1e-9); // log10(1) = 0, no cheap-entry bonus
    const big = whaleConfidence(100000, 10000, 0.7); // 10x → +0.15
    assert.ok(Math.abs(big - 0.65) < 1e-9);
    assert.equal(whaleConfidence(10_000_000_000, 10000, 0.5), 0.95); // capped
  });

  it('whale confidence adds a bonus for cheap entries', () => {
    const cheap = whaleConfidence(10000, 10000, 0.4);
    const rich = whaleConfidence(10000, 10000, 0.7);
    assert.ok(Math.abs(cheap - rich - 0.05) < 1e-9);
  });

  it('momentum confidence is zero below threshold and scales past it', () => {
    assert.equal(momentumConfidence(0.05, 0.12), 0);
    assert.ok(Math.abs(momentumConfidence(0.12, 0.12) - 0.55) < 1e-9);
    assert.ok(momentumConfidence(0.24, 0.12) > momentumConfidence(0.12, 0.12));
    assert.equal(momentumConfidence(10, 0.12), 0.95); // capped
    assert.equal(momentumConfidence(-0.24, 0.12), momentumConfidence(0.24, 0.12)); // sign-agnostic
  });
});

// ============================================================================
// GATE CHAIN
// ============================================================================

describe('evaluateGates', () => {
  it('passes a clean candidate', () => {
    assert.deepEqual(evaluateGates(signal(), gateState(), CFG), { passed: true });
  });

  it('master switch off blocks everything first', () => {
    const res = evaluateGates(signal(), gateState(), { ...CFG, masterSwitch: false });
    assert.equal(res.gate, 'master');
  });

  it('rejects below the confidence floor with the reel-style reason', () => {
    const res = evaluateGates(signal({ confidence: 0.4 }), gateState(), CFG);
    assert.equal(res.gate, 'confidence');
    assert.match(res.reason ?? '', /conf 0\.40 < floor 0\.60/);
  });

  it('rejects entries outside the price band', () => {
    assert.equal(evaluateGates(signal({ price: 0.9 }), gateState(), CFG).gate, 'price-band');
    assert.equal(evaluateGates(signal({ price: 0.02 }), gateState(), CFG).gate, 'price-band');
  });

  it('rejects wide spreads ("spread 7c > max 4c")', () => {
    const res = evaluateGates(signal({ spreadCents: 7 }), gateState(), CFG);
    assert.equal(res.gate, 'spread');
    assert.equal(res.reason, 'spread 7c > max 4c');
  });

  it('rejects expired windows', () => {
    const res = evaluateGates(signal({ expiresAt: T0 - 1 }), gateState(), CFG);
    assert.equal(res.reason, 'outside window');
  });

  it('rejects duplicates, cooldowns, position caps, exposure and daily loss', () => {
    assert.equal(evaluateGates(signal(), gateState({ hasPositionInMarket: true }), CFG).gate, 'duplicate');

    const cooldownMap = new Map([['mkt-1', T0 - 10_000]]);
    assert.equal(
      evaluateGates(signal(), gateState({ lastEntryAtByMarket: cooldownMap }), CFG).gate,
      'cooldown'
    );

    assert.equal(
      evaluateGates(signal(), gateState({ openPositions: CFG.maxConcurrentPositions }), CFG).gate,
      'positions'
    );

    assert.equal(
      evaluateGates(signal(), gateState({ openExposureUsd: CFG.maxExposureUsd }), CFG).gate,
      'exposure'
    );

    assert.equal(
      evaluateGates(signal(), gateState({ dailyPnlUsd: -CFG.maxDailyLossUsd }), CFG).gate,
      'daily-loss'
    );
  });
});

// ============================================================================
// ENGINE: WHALE PATH
// ============================================================================

describe('engine whale path', () => {
  it('places a paper position on a qualifying whale print and traces it', () => {
    const clock = makeClock();
    const engine = createPolybotEngine({}, { now: clock.now });
    engine.start();

    engine.onWhaleTrade(whaleTrade());

    const positions = engine.getPositions();
    assert.equal(positions.length, 1);
    assert.equal(positions[0].side, 'YES');
    assert.equal(positions[0].entryPrice, 0.55);
    assert.ok(Math.abs(positions[0].shares - DEFAULT_POLYBOT_CONFIG.tradeSizeUsd / 0.55) < 1e-9);

    const trace = engine.getTrace();
    assert.equal(trace.length, 1);
    assert.equal(trace[0].kind, 'whale');
    assert.equal(trace[0].outcome, 'placed');

    const stats = engine.getStats();
    assert.equal(stats.whalesSeen, 1);
    assert.equal(stats.openPositions, 1);
  });

  it('ignores SELL prints and prints below the whale minimum', () => {
    const engine = createPolybotEngine({}, { now: makeClock().now });
    engine.start();

    engine.onWhaleTrade(whaleTrade({ side: 'SELL' }));
    engine.onWhaleTrade(whaleTrade({ usdValue: 500 }));

    assert.equal(engine.getPositions().length, 0);
    assert.equal(engine.getStats().whalesSeen, 0);
  });

  it('skips (and traces) whale candidates priced above the entry band', () => {
    const engine = createPolybotEngine({}, { now: makeClock().now });
    engine.start();

    // usdValue high enough that confidence passes and the price gate decides
    engine.onWhaleTrade(whaleTrade({ price: 0.92, usdValue: 100000 }));

    assert.equal(engine.getPositions().length, 0);
    const trace = engine.getTrace();
    assert.equal(trace.length, 1);
    assert.equal(trace[0].outcome, 'skip');
    assert.match(trace[0].reason, /price/);
  });
});

// ============================================================================
// ENGINE: MOMENTUM PATH
// ============================================================================

describe('engine momentum path', () => {
  it('fires an UP candidate when spot moves past the threshold', () => {
    const clock = makeClock();
    const engine = createPolybotEngine({}, { now: clock.now });
    engine.start();
    engine.setActiveMarkets([market()]);

    engine.onSpotTick('BTC', 100000);
    clock.advance(10_000);
    engine.onSpotTick('BTC', 100200); // +0.2% over 10s > 0.12% threshold

    const positions = engine.getPositions();
    assert.equal(positions.length, 1);
    assert.equal(positions[0].side, 'UP');
    assert.equal(positions[0].label, 'btc-up-or-down');
    assert.equal(engine.getStats().momentumSeen, 1);
  });

  it('fires at most one momentum candidate per market per window', () => {
    const clock = makeClock();
    const engine = createPolybotEngine({}, { now: clock.now });
    engine.start();
    engine.setActiveMarkets([market()]);

    engine.onSpotTick('BTC', 100000);
    clock.advance(5_000);
    engine.onSpotTick('BTC', 100300);
    clock.advance(1_000);
    engine.onSpotTick('BTC', 100600); // second trigger inside the same window

    assert.equal(engine.getStats().momentumSeen, 1);
  });

  it('does nothing without an active market for the asset', () => {
    const clock = makeClock();
    const engine = createPolybotEngine({}, { now: clock.now });
    engine.start();

    engine.onSpotTick('BTC', 100000);
    clock.advance(10_000);
    engine.onSpotTick('BTC', 100500);

    assert.equal(engine.getPositions().length, 0);
  });
});

// ============================================================================
// ENGINE: EXITS, SETTLEMENT, STATS
// ============================================================================

describe('engine exits and stats', () => {
  it('takes profit, records a win, and updates realized P&L', () => {
    const clock = makeClock();
    const engine = createPolybotEngine({}, { now: clock.now });
    engine.start();

    engine.onWhaleTrade(whaleTrade({ marketId: 'mkt-a', price: 0.5 }));
    engine.updateMarketPrice('mkt-a', 0.62, 0.38); // +12c ≥ +10c TP

    assert.equal(engine.getPositions().length, 0);
    const closed = engine.getClosed();
    assert.equal(closed.length, 1);
    assert.equal(closed[0].exitReason, 'tp');
    const expectedPnl = (0.62 - 0.5) * (DEFAULT_POLYBOT_CONFIG.tradeSizeUsd / 0.5);
    assert.ok(Math.abs(closed[0].pnlUsd - expectedPnl) < 1e-9);

    const stats = engine.getStats();
    assert.equal(stats.wins, 1);
    assert.equal(stats.winRate, 100);
    assert.ok(Math.abs(stats.realizedPnlUsd - expectedPnl) < 1e-9);
    assert.equal(engine.getFills()[0].result, 'win');
  });

  it('stops out losers and settles expired windowed positions at 0 or 1', () => {
    const clock = makeClock();
    const engine = createPolybotEngine({}, { now: clock.now });
    engine.start();
    const m = market();
    engine.setActiveMarkets([m]);

    // Open an UP position via momentum
    engine.onSpotTick('BTC', 100000);
    clock.advance(10_000);
    engine.onSpotTick('BTC', 100200);
    assert.equal(engine.getPositions().length, 1);

    // Price collapses → stop-loss
    engine.updateMarketPrice(m.marketId, 0.3, 0.7);
    assert.equal(engine.getClosed().length, 1);
    assert.equal(engine.getClosed()[0].exitReason, 'sl');

    // New window, new position; expiry settles in the money at $1
    clock.advance(31_000); // past cooldown
    const m2 = market({ marketId: 'mkt-2', expiresAt: clock.now() + 60_000 });
    engine.setActiveMarkets([m2]);
    engine.onSpotTick('BTC', 100000);
    clock.advance(10_000);
    engine.onSpotTick('BTC', 100200);
    assert.equal(engine.getPositions().length, 1);

    engine.updateMarketPrice('mkt-2', 0.55, 0.45); // ITM but under TP
    clock.advance(60_000); // expire
    engine.updateMarketPrice('mkt-2', 0.55, 0.45);
    const settled = engine.getClosed()[1];
    assert.equal(settled.exitReason, 'settled');
    assert.equal(settled.exitPrice, 1);
  });

  it('halts trading after the daily loss cap and reports it in diagnostics', () => {
    const clock = makeClock();
    const engine = createPolybotEngine(
      { maxDailyLossUsd: 5, stopLossCents: 20, tradeSizeUsd: 25 },
      { now: clock.now }
    );
    engine.start();

    engine.onWhaleTrade(whaleTrade({ marketId: 'mkt-a', price: 0.5 }));
    engine.updateMarketPrice('mkt-a', 0.2, 0.8); // breaches the 20c stop → -$15 realized

    clock.advance(31_000);
    engine.onWhaleTrade(whaleTrade({ id: 'wt-2', marketId: 'mkt-b' }));
    assert.equal(engine.getPositions().length, 0);
    const lastTrace = engine.getTrace().at(-1);
    assert.equal(lastTrace?.outcome, 'skip');
    assert.match(lastTrace?.reason ?? '', /daily loss/);

    const daily = engine.getDiagnostics().find((c) => c.label === 'Daily stop');
    assert.equal(daily?.ok, false);
  });

  it('closes everything on stop and marks fills', () => {
    const clock = makeClock();
    const engine = createPolybotEngine({}, { now: clock.now });
    engine.start();
    engine.onWhaleTrade(whaleTrade());
    engine.stop();

    assert.equal(engine.getPositions().length, 0);
    assert.equal(engine.getClosed()[0].exitReason, 'stopped');
    assert.equal(engine.isRunning(), false);
  });
});

// ============================================================================
// FEED HEALTH & DIAGNOSTICS
// ============================================================================

describe('feed health and diagnostics', () => {
  it('reports live vs stale feeds against the clock', () => {
    const clock = makeClock();
    const engine = createPolybotEngine({}, { now: clock.now });
    engine.start();
    engine.beat('crypto.ws');

    let health = engine.getFeedHealth();
    assert.equal(health.find((h) => h.source === 'crypto.ws')?.live, true);
    assert.equal(health.find((h) => h.source === 'whale.ws')?.live, false);

    clock.advance(DEFAULT_POLYBOT_CONFIG.feedStaleMs + 1);
    health = engine.getFeedHealth();
    assert.equal(health.find((h) => h.source === 'crypto.ws')?.live, false);
  });

  it('diagnostics call out the master switch and missing markets', () => {
    const engine = createPolybotEngine({ masterSwitch: false }, { now: makeClock().now });
    engine.start();

    const checks = engine.getDiagnostics();
    const master = checks.find((c) => c.label === 'Master switch');
    assert.equal(master?.ok, false);
    assert.match(master?.note ?? '', /master switch is OFF/);
    assert.equal(checks.find((c) => c.label === 'Markets available')?.ok, false);
    assert.equal(checks.find((c) => c.label === 'Engine running')?.ok, true);

    // Gated by master switch → skip trace with the reel's wording
    engine.onWhaleTrade(whaleTrade());
    assert.match(engine.getTrace().at(-1)?.reason ?? '', /master switch is OFF/);
  });
});
