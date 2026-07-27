/**
 * Chart-analysis (OPUS 5 pipeline) tests
 *
 * Deterministic fixtures: triangle-wave OHLCV series with configurable drift
 * so uptrend / downtrend / range charts all form clean swing pivots.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle, ChartRead, TradePlan } from '../../src/trading/chart-analysis/types.js';
import { resolveOptions } from '../../src/trading/chart-analysis/types.js';
import {
  analyzeChart,
  findKeyLevels,
  readChart,
  reviewRisk,
} from '../../src/trading/chart-analysis/engine.js';
import {
  atr,
  ema,
  rsi,
  slopePct,
  sma,
  swingHighs,
  swingLows,
} from '../../src/trading/chart-analysis/indicators.js';
import { formatAnalysisReport } from '../../src/trading/chart-analysis/report.js';

// ============================================================================
// FIXTURES
// ============================================================================

/** Triangle wave (period 8): peaks at phase 3, troughs at phase 7. */
const TRI = [0, 1, 2, 3, 2, 1, 0, -1];

/**
 * OHLCV series with linear drift plus a triangle wave, so swing pivots form
 * every 8 bars. driftPerBar > 0 → HH-HL uptrend; < 0 → LH-LL downtrend;
 * 0 → repeated equal highs/lows (a range with liquidity clusters).
 */
function makeSeries(opts: {
  count: number;
  start?: number;
  driftPerBar?: number;
  waveAmp?: number;
  volumeRising?: boolean;
}): Candle[] {
  const { count, start = 100, driftPerBar = 0, waveAmp = 1.5, volumeRising = false } = opts;
  const candles: Candle[] = [];
  let prevClose = start;
  for (let i = 0; i < count; i++) {
    const close = start + i * driftPerBar + TRI[i % 8] * waveAmp;
    candles.push({
      time: 1700000000000 + i * 3600_000,
      open: prevClose,
      high: Math.max(prevClose, close) + 0.6,
      low: Math.min(prevClose, close) - 0.6,
      close,
      volume: volumeRising ? 10 + i * 0.1 : 10,
    });
    prevClose = close;
  }
  return candles;
}

/** Uptrend that ends on a fresh breakout peak (last bar is the highest close). */
function uptrend(): Candle[] {
  return makeSeries({ count: 116, driftPerBar: 0.8, volumeRising: true });
}

/** Downtrend ending on a fresh breakdown trough. */
function downtrend(): Candle[] {
  return makeSeries({ count: 120, start: 300, driftPerBar: -0.8, volumeRising: true });
}

/** Driftless range with repeated equal highs and lows. */
function range(): Candle[] {
  return makeSeries({ count: 121, driftPerBar: 0, waveAmp: 3 });
}

function fabricatedRead(): ChartRead {
  return {
    priceAction: { lastClose: 100, changePct: 10, momentum: 'steady', bodyStrength: 0.6 },
    volume: { last: 100, average: 80, strengthPct: 125, participation: 'normal', risingIntoMove: true },
    structure: {
      label: 'HH-HL',
      description: 'Higher highs and higher lows.',
      swingHighs: [],
      swingLows: [],
      brokeStructure: false,
    },
    trend: { bias: 'bullish', emaFast: 101, emaSlow: 99, slopePct: 0.4, strength: 1 },
  };
}

function fabricatedPlan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    hasSetup: true,
    direction: 'long',
    entry: 100,
    stopLoss: 95,
    target: 115,
    riskReward: 3,
    perUnitRisk: 5,
    rationale: 'Long at 100.',
    ...over,
  };
}

// ============================================================================
// INDICATORS
// ============================================================================

describe('chart-analysis indicators', () => {
  it('sma computes the mean of the trailing window', () => {
    assert.equal(sma([1, 2, 3, 4], 2), 3.5);
    assert.equal(sma([1, 2], 3), null);
  });

  it('ema of a constant series is the constant', () => {
    assert.equal(ema(Array(30).fill(42), 10), 42);
  });

  it('ema seeds with SMA when the series is exactly one period long', () => {
    assert.equal(ema([1, 2, 3, 4, 5], 5), 3);
  });

  it('rsi is 100 for a strictly rising series and null when short', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    assert.equal(rsi(rising, 14), 100);
    assert.equal(rsi([1, 2, 3], 14), null);
  });

  it('atr equals the constant bar range when there are no gaps', () => {
    const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: i,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    }));
    const value = atr(candles, 14);
    assert.ok(value !== null);
    assert.ok(Math.abs(value - 2) < 1e-9);
  });

  it('finds swing pivots on a hand-built zigzag', () => {
    const highs = [1, 2, 3, 2, 1, 2, 3, 2, 1];
    const candles: Candle[] = highs.map((h, i) => ({
      time: i,
      open: h - 0.5,
      high: h,
      low: h - 1,
      close: h - 0.25,
      volume: 1,
    }));
    const pivotsHigh = swingHighs(candles, 2);
    assert.deepEqual(
      pivotsHigh.map((p) => p.index),
      [2, 6]
    );
    const pivotsLow = swingLows(candles, 2);
    assert.deepEqual(
      pivotsLow.map((p) => p.index),
      [4]
    );
  });

  it('slopePct signs match direction', () => {
    assert.ok(slopePct([1, 2, 3, 4, 5]) > 0);
    assert.ok(slopePct([5, 4, 3, 2, 1]) < 0);
    assert.equal(slopePct([3, 3, 3]), 0);
  });
});

// ============================================================================
// STAGE 1: READ THE CHART
// ============================================================================

describe('readChart', () => {
  const opts = resolveOptions();

  it('reads an uptrend as bullish with HH-HL structure', () => {
    const read = readChart(uptrend(), opts);
    assert.equal(read.trend.bias, 'bullish');
    assert.equal(read.structure.label, 'HH-HL');
    assert.ok(read.trend.strength > 0.5);
    assert.ok(read.priceAction.changePct > 0);
    assert.ok(read.volume.risingIntoMove);
  });

  it('reads a downtrend as bearish with LH-LL structure', () => {
    const read = readChart(downtrend(), opts);
    assert.equal(read.trend.bias, 'bearish');
    assert.equal(read.structure.label, 'LH-LL');
    assert.ok(read.priceAction.changePct < 0);
  });

  it('reads a driftless range as neutral RANGE', () => {
    const read = readChart(range(), opts);
    assert.equal(read.trend.bias, 'neutral');
    assert.equal(read.structure.label, 'RANGE');
  });
});

// ============================================================================
// STAGE 2: KEY LEVELS
// ============================================================================

describe('findKeyLevels', () => {
  const opts = resolveOptions();

  it('brackets price with support below and resistance above in a range', () => {
    const candles = range();
    const lastClose = candles[candles.length - 1].close;
    const levels = findKeyLevels(candles, lastClose, opts);

    assert.ok(levels.nearestSupport, 'expected a support level');
    assert.ok(levels.nearestResistance, 'expected a resistance level');
    assert.ok(levels.nearestSupport.price < lastClose);
    assert.ok(levels.nearestResistance.price >= lastClose);
    // Equal highs/lows repeat every 8 bars, so clusters have many touches.
    assert.ok(levels.nearestSupport.touches >= 2);
    assert.ok(levels.nearestResistance.touches >= 2);
  });

  it('marks equal highs/lows as liquidity pools on both sides', () => {
    const candles = range();
    const lastClose = candles[candles.length - 1].close;
    const levels = findKeyLevels(candles, lastClose, opts);

    const sides = new Set(levels.liquidity.map((p) => p.side));
    assert.ok(sides.has('buy-side'), 'expected buy-side liquidity above equal highs');
    assert.ok(sides.has('sell-side'), 'expected sell-side liquidity below equal lows');
  });

  it('builds supply and demand zones around the strongest levels', () => {
    const candles = range();
    const lastClose = candles[candles.length - 1].close;
    const levels = findKeyLevels(candles, lastClose, opts);

    const kinds = new Set(levels.supplyDemand.map((z) => z.kind));
    assert.ok(kinds.has('supply'));
    assert.ok(kinds.has('demand'));
    for (const zone of levels.supplyDemand) {
      assert.ok(zone.low < zone.high);
    }
  });
});

// ============================================================================
// STAGES 3+4 VIA THE ORCHESTRATOR
// ============================================================================

describe('analyzeChart end-to-end', () => {
  it('approves a long on a clean uptrend breakout', () => {
    const a = analyzeChart('BTC', '1h', uptrend());
    assert.equal(a.plan.hasSetup, true);
    assert.equal(a.plan.direction, 'long');
    assert.ok(a.plan.stopLoss < a.plan.entry);
    assert.ok(a.plan.target > a.plan.entry);
    assert.ok(a.plan.riskReward >= 1.5);
    assert.equal(a.risk.approved, true);
    assert.equal(a.verdict, 'APPROVED');
    assert.ok(a.risk.positionSize > 0);
  });

  it('finds a short on a clean downtrend breakdown', () => {
    const a = analyzeChart('ETH', '1h', downtrend());
    assert.equal(a.plan.hasSetup, true);
    assert.equal(a.plan.direction, 'short');
    assert.ok(a.plan.stopLoss > a.plan.entry);
    assert.ok(a.plan.target < a.plan.entry);
    assert.ok(a.plan.riskReward >= 1.5);
  });

  it('stands aside in a driftless range', () => {
    const a = analyzeChart('SOL', '1h', range());
    assert.equal(a.plan.hasSetup, false);
    assert.equal(a.plan.direction, null);
    assert.equal(a.verdict, 'STAND ASIDE');
    assert.equal(a.risk.approved, false);
    assert.equal(a.risk.positionSize, 0);
  });

  it('rejects charts with too few candles', () => {
    assert.throws(
      () => analyzeChart('BTC', '1h', makeSeries({ count: 30 })),
      /at least 60 candles/
    );
  });
});

// ============================================================================
// STAGE 4: RISK REVIEW MATH
// ============================================================================

describe('reviewRisk', () => {
  it('sizes the position as (balance × risk%) / per-unit risk', () => {
    const opts = resolveOptions({ accountBalance: 10000, riskPct: 1 });
    const risk = reviewRisk(fabricatedPlan(), fabricatedRead(), opts);

    assert.equal(risk.riskAmount, 100); // 10000 × 1%
    assert.equal(risk.positionSize, 20); // 100 / 5
    assert.equal(risk.notional, 2000); // 20 × 100
    assert.equal(risk.exposurePct, 20);
    assert.equal(risk.maxLossOk, true);
    assert.equal(risk.exposureOk, true);
    assert.equal(risk.approved, true);
    assert.ok(risk.confidence >= 60);
  });

  it('fails the max-loss check when per-trade risk exceeds the drawdown budget', () => {
    const opts = resolveOptions({ accountBalance: 10000, riskPct: 30, maxDrawdownPct: 20 });
    const plan = fabricatedPlan({ stopLoss: 50, perUnitRisk: 50, target: 250 });
    const risk = reviewRisk(plan, fabricatedRead(), opts);

    assert.equal(risk.riskAmount, 3000); // 10000 × 30% — over the $2000 budget
    assert.equal(risk.maxLossOk, false);
    assert.equal(risk.approved, false);
  });

  it('clamps size to keep total exposure balanced across positions', () => {
    const opts = resolveOptions({
      accountBalance: 10000,
      riskPct: 1,
      maxExposurePct: 50,
      openExposureNotional: 4000,
    });
    const risk = reviewRisk(fabricatedPlan(), fabricatedRead(), opts);

    // Budget: 10000×50% − 4000 = $1000 → 10 units at $100.
    assert.equal(risk.positionSize, 10);
    assert.equal(risk.notional, 1000);
    assert.equal(risk.riskAmount, 50);
    assert.equal(risk.exposurePct, 50);
    assert.equal(risk.exposureOk, true);
    assert.ok(risk.notes.some((n) => n.includes('Size reduced')));
  });

  it('refuses to size when the exposure budget is exhausted', () => {
    const opts = resolveOptions({
      accountBalance: 10000,
      maxExposurePct: 50,
      openExposureNotional: 5000,
    });
    const risk = reviewRisk(fabricatedPlan(), fabricatedRead(), opts);

    assert.equal(risk.positionSize, 0);
    assert.equal(risk.exposureOk, false);
    assert.equal(risk.approved, false);
  });

  it('rejects setups below the confidence floor', () => {
    const opts = resolveOptions({ accountBalance: 10000, minConfidence: 95 });
    const risk = reviewRisk(fabricatedPlan(), fabricatedRead(), opts);

    assert.ok(risk.confidence < 95);
    assert.equal(risk.approved, false);
    assert.ok(risk.notes.some((n) => n.includes('approval floor')));
  });
});

// ============================================================================
// REPORT
// ============================================================================

describe('formatAnalysisReport', () => {
  it('renders every pipeline stage for an approved setup', () => {
    const report = formatAnalysisReport(analyzeChart('BTC', '1h', uptrend()));
    for (const section of [
      'Chart Read',
      'Key Levels',
      'Trade Plan',
      'Risk Review',
      'Bull Case',
      'Bear Case',
      'TAKE TRADE',
    ]) {
      assert.ok(report.includes(section), `missing section: ${section}`);
    }
  });

  it('renders STAND ASIDE with reasons for a rangebound chart', () => {
    const report = formatAnalysisReport(analyzeChart('SOL', '1h', range()));
    assert.ok(report.includes('STAND ASIDE'));
    assert.ok(report.includes('No directional edge'));
  });
});
