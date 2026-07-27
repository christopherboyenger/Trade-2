/**
 * Chart-analysis engine — the OPUS 5 pipeline, as pure functions.
 *
 *   readChart      → price action, volume, market structure, trend/bias
 *   findKeyLevels  → support, resistance, liquidity pools, supply & demand
 *   buildTradePlan → entry, stop loss, target, risk/reward
 *   reviewRisk     → position size, max loss, exposure, confidence, approval
 *
 * No I/O anywhere in this file: callers hand in candles (the skill fetches
 * them from the live feed), so every stage is deterministic and testable.
 */

import {
  atr,
  avg,
  clamp,
  ema,
  rsi,
  slopePct,
  swingHighs,
  swingLows,
} from './indicators.js';
import type {
  AnalyzeOptions,
  Candle,
  ChartAnalysis,
  ChartRead,
  Direction,
  KeyLevels,
  Level,
  LiquidityPool,
  PriceAction,
  ResolvedOptions,
  RiskReview,
  StructureRead,
  TradePlan,
  Trend,
  TrendRead,
  VolumeRead,
  Zone,
} from './types.js';
import { resolveOptions } from './types.js';

export const MIN_CANDLES = 60;

// ── Stage 1: read the chart ─────────────────────────────────────────────────

function readPriceAction(candles: Candle[]): PriceAction {
  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];
  const firstClose = closes[0];
  const changePct = firstClose !== 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;

  const recent = closes.slice(-10);
  const prior = closes.slice(-20, -10);
  const recentSlope = slopePct(recent);
  const priorSlope = slopePct(prior);
  const rsiValue = rsi(closes, 14) ?? 50;

  let momentum: PriceAction['momentum'] = 'steady';
  if (recentSlope * priorSlope < 0 && Math.abs(recentSlope) > Math.abs(priorSlope) * 0.5) {
    momentum = 'reversing';
  } else if (Math.abs(recentSlope) > Math.abs(priorSlope) * 1.2 && Math.abs(rsiValue - 50) > 5) {
    momentum = 'accelerating';
  } else if (Math.abs(recentSlope) < Math.abs(priorSlope) * 0.5) {
    momentum = 'stalling';
  }

  const window = candles.slice(-20);
  const ratios = window.map((c) => {
    const range = c.high - c.low;
    return range > 0 ? Math.abs(c.close - c.open) / range : 0;
  });

  return { lastClose, changePct, momentum, bodyStrength: avg(ratios) };
}

function readVolume(candles: Candle[]): VolumeRead {
  const vols = candles.map((c) => c.volume);
  const last = vols[vols.length - 1];
  const baseline = vols.slice(-21, -1);
  const average = baseline.length > 0 ? avg(baseline) : last;
  const strengthPct = average > 0 ? (last / average) * 100 : 100;

  const participation: VolumeRead['participation'] =
    strengthPct >= 150 ? 'high' : strengthPct <= 50 ? 'low' : 'normal';

  const recentAvg = avg(vols.slice(-3));
  const priorAvg = avg(vols.slice(-13, -3));
  const risingIntoMove = priorAvg > 0 && recentAvg > priorAvg;

  return { last, average, strengthPct, participation, risingIntoMove };
}

function readStructure(candles: Candle[], swingLookback: number): StructureRead {
  const highs = swingHighs(candles, swingLookback);
  const lows = swingLows(candles, swingLookback);
  const lastClose = candles[candles.length - 1].close;

  const swingHighPrices = highs.map((p) => p.price);
  const swingLowPrices = lows.map((p) => p.price);

  if (highs.length < 2 || lows.length < 2) {
    return {
      label: 'RANGE',
      description: 'Not enough swings to define structure.',
      swingHighs: swingHighPrices,
      swingLows: swingLowPrices,
      brokeStructure: false,
    };
  }

  const [prevHigh, lastHigh] = swingHighPrices.slice(-2);
  const [prevLow, lastLow] = swingLowPrices.slice(-2);

  let label: StructureRead['label'] = 'RANGE';
  let description = 'Sideways structure — no clean sequence of highs and lows.';
  if (lastHigh > prevHigh && lastLow > prevLow) {
    label = 'HH-HL';
    description = 'Higher highs and higher lows.';
  } else if (lastHigh < prevHigh && lastLow < prevLow) {
    label = 'LH-LL';
    description = 'Lower highs and lower lows.';
  }

  const brokeStructure = lastClose > lastHigh || lastClose < lastLow;

  return {
    label,
    description,
    swingHighs: swingHighPrices,
    swingLows: swingLowPrices,
    brokeStructure,
  };
}

function readTrend(candles: Candle[], opts: ResolvedOptions): TrendRead {
  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, opts.emaFastPeriod) ?? closes[closes.length - 1];
  const emaSlow = ema(closes, opts.emaSlowPeriod) ?? emaFast;
  const slope = slopePct(closes.slice(-20)) * 100;

  // Dead-zone on slope so microscopic drift in a flat market doesn't set a bias.
  const SLOPE_MIN = 0.02; // percent per bar
  let bias: Trend = 'neutral';
  if (emaFast > emaSlow && slope > SLOPE_MIN) bias = 'bullish';
  else if (emaFast < emaSlow && slope < -SLOPE_MIN) bias = 'bearish';

  const separationPct = emaSlow !== 0 ? (Math.abs(emaFast - emaSlow) / emaSlow) * 100 : 0;
  let strength = clamp(separationPct / 3, 0, 1) * 0.6 + clamp(Math.abs(slope) / 0.3, 0, 1) * 0.4;
  if (bias === 'neutral') strength *= 0.4;

  return { bias, emaFast, emaSlow, slopePct: slope, strength: clamp(strength, 0, 1) };
}

export function readChart(candles: Candle[], opts: ResolvedOptions): ChartRead {
  return {
    priceAction: readPriceAction(candles),
    volume: readVolume(candles),
    structure: readStructure(candles, opts.swingLookback),
    trend: readTrend(candles, opts),
  };
}

// ── Stage 2: key levels ─────────────────────────────────────────────────────

interface PivotCluster {
  price: number;
  touches: number;
  min: number;
  max: number;
  fromHighs: number;
  fromLows: number;
}

function clusterPivots(
  highPrices: number[],
  lowPrices: number[],
  tolerance: number
): PivotCluster[] {
  const tagged = [
    ...highPrices.map((price) => ({ price, isHigh: true })),
    ...lowPrices.map((price) => ({ price, isHigh: false })),
  ].sort((a, b) => a.price - b.price);

  const clusters: PivotCluster[] = [];
  for (const pivot of tagged) {
    const current = clusters[clusters.length - 1];
    if (current && pivot.price - current.max <= tolerance) {
      current.touches += 1;
      current.max = pivot.price;
      current.price = (current.price * (current.touches - 1) + pivot.price) / current.touches;
      if (pivot.isHigh) current.fromHighs += 1;
      else current.fromLows += 1;
    } else {
      clusters.push({
        price: pivot.price,
        touches: 1,
        min: pivot.price,
        max: pivot.price,
        fromHighs: pivot.isHigh ? 1 : 0,
        fromLows: pivot.isHigh ? 0 : 1,
      });
    }
  }
  return clusters;
}

export function findKeyLevels(
  candles: Candle[],
  lastClose: number,
  opts: ResolvedOptions
): KeyLevels {
  const atrValue = atr(candles, opts.atrPeriod);
  const tolerance = atrValue !== null ? atrValue * 0.25 : lastClose * 0.003;

  const highPivots = swingHighs(candles, opts.swingLookback).map((p) => p.price);
  const lowPivots = swingLows(candles, opts.swingLookback).map((p) => p.price);
  const clusters = clusterPivots(highPivots, lowPivots, tolerance);

  const toLevel = (c: PivotCluster): Level => ({
    price: c.price,
    kind: c.price >= lastClose ? 'resistance' : 'support',
    touches: c.touches,
    strength: clamp(c.touches / 4, 0.25, 1),
  });

  const supports = clusters
    .filter((c) => c.price < lastClose)
    .map(toLevel)
    .sort((a, b) => b.price - a.price);
  const resistances = clusters
    .filter((c) => c.price >= lastClose)
    .map(toLevel)
    .sort((a, b) => a.price - b.price);

  // Equal highs above price attract buy-side stops; equal lows below, sell-side.
  const liquidity: LiquidityPool[] = [];
  for (const c of clusters) {
    if (c.fromHighs >= 2 && c.price >= lastClose) {
      liquidity.push({ price: c.max, side: 'buy-side' });
    } else if (c.fromLows >= 2 && c.price < lastClose) {
      liquidity.push({ price: c.min, side: 'sell-side' });
    }
  }

  const zoneHalfWidth = atrValue !== null ? atrValue * 0.25 : lastClose * 0.003;
  const supplyDemand: Zone[] = [];
  const strongestResistance = [...resistances].sort((a, b) => b.touches - a.touches)[0];
  const strongestSupport = [...supports].sort((a, b) => b.touches - a.touches)[0];
  if (strongestResistance) {
    supplyDemand.push({
      low: strongestResistance.price - zoneHalfWidth,
      high: strongestResistance.price + zoneHalfWidth,
      kind: 'supply',
    });
  }
  if (strongestSupport) {
    supplyDemand.push({
      low: strongestSupport.price - zoneHalfWidth,
      high: strongestSupport.price + zoneHalfWidth,
      kind: 'demand',
    });
  }

  const maxHigh = Math.max(...candles.map((c) => c.high));
  const minLow = Math.min(...candles.map((c) => c.low));
  const rangePos = maxHigh > minLow ? (lastClose - minLow) / (maxHigh - minLow) : 0.5;
  const bias: Trend = rangePos > 0.66 ? 'bullish' : rangePos < 0.33 ? 'bearish' : 'neutral';

  return {
    supports,
    resistances,
    nearestSupport: supports[0] ?? null,
    nearestResistance: resistances[0] ?? null,
    liquidity,
    supplyDemand,
    bias,
  };
}

// ── Stage 3: trade plan ─────────────────────────────────────────────────────

function noSetup(rationale: string): TradePlan {
  return {
    hasSetup: false,
    direction: null,
    entry: 0,
    stopLoss: 0,
    target: 0,
    riskReward: 0,
    perUnitRisk: 0,
    rationale,
  };
}

export function buildTradePlan(
  read: ChartRead,
  levels: KeyLevels,
  atrValue: number,
  opts: ResolvedOptions
): TradePlan {
  const entry = read.priceAction.lastClose;
  const { structure, trend } = read;

  let direction: Direction | null = null;
  if (trend.bias === 'bullish' || (structure.label === 'HH-HL' && trend.bias !== 'bearish')) {
    direction = 'long';
  } else if (trend.bias === 'bearish' || structure.label === 'LH-LL') {
    // 'bullish' bias is already excluded by the branch above.
    direction = 'short';
  }

  if (!direction) {
    return noSetup('No directional edge — trend is neutral and structure is ranging.');
  }
  if (atrValue <= 0) {
    return noSetup('Volatility read failed — cannot anchor stop distance.');
  }

  let stopLoss: number;
  let target: number;
  let stopAnchor: string;
  let targetAnchor: string;

  if (direction === 'long') {
    if (levels.nearestSupport) {
      stopLoss = Math.min(levels.nearestSupport.price - atrValue * 0.25, entry - atrValue * 0.5);
      stopAnchor = `below support ${levels.nearestSupport.price.toFixed(2)}`;
    } else {
      stopLoss = entry - atrValue * 2;
      stopAnchor = '2×ATR below entry (no support in range)';
    }
    const perUnitRisk = entry - stopLoss;
    const candidates = levels.resistances.filter((r) => r.price > entry);
    const reachable = candidates.find(
      (r) => (r.price - entry) / perUnitRisk >= opts.minRiskReward
    );
    if (reachable) {
      target = reachable.price;
      targetAnchor = `resistance ${reachable.price.toFixed(2)}`;
    } else if (candidates.length > 0) {
      target = candidates[candidates.length - 1].price;
      targetAnchor = `resistance ${target.toFixed(2)} (capped by overhead levels)`;
    } else {
      target = entry + Math.max(atrValue * 2, opts.minRiskReward * perUnitRisk);
      targetAnchor = 'R-multiple projection (no resistance overhead)';
    }
  } else {
    if (levels.nearestResistance) {
      stopLoss = Math.max(
        levels.nearestResistance.price + atrValue * 0.25,
        entry + atrValue * 0.5
      );
      stopAnchor = `above resistance ${levels.nearestResistance.price.toFixed(2)}`;
    } else {
      stopLoss = entry + atrValue * 2;
      stopAnchor = '2×ATR above entry (no resistance in range)';
    }
    const perUnitRisk = stopLoss - entry;
    const candidates = [...levels.supports].filter((s) => s.price < entry);
    const reachable = candidates.find(
      (s) => (entry - s.price) / perUnitRisk >= opts.minRiskReward
    );
    if (reachable) {
      target = reachable.price;
      targetAnchor = `support ${reachable.price.toFixed(2)}`;
    } else if (candidates.length > 0) {
      target = candidates[candidates.length - 1].price;
      targetAnchor = `support ${target.toFixed(2)} (capped by underlying levels)`;
    } else {
      target = entry - Math.max(atrValue * 2, opts.minRiskReward * perUnitRisk);
      targetAnchor = 'R-multiple projection (no support below)';
    }
  }

  const perUnitRisk = Math.abs(entry - stopLoss);
  const reward = direction === 'long' ? target - entry : entry - target;
  const riskReward = perUnitRisk > 0 ? reward / perUnitRisk : 0;

  if (riskReward < opts.minRiskReward) {
    return {
      hasSetup: false,
      direction,
      entry,
      stopLoss,
      target,
      riskReward,
      perUnitRisk,
      rationale: `Reward:risk ${riskReward.toFixed(2)} is below the ${opts.minRiskReward.toFixed(
        1
      )} minimum — nearest ${direction === 'long' ? 'resistance' : 'support'} leaves too little room.`,
    };
  }

  return {
    hasSetup: true,
    direction,
    entry,
    stopLoss,
    target,
    riskReward,
    perUnitRisk,
    rationale: `${direction === 'long' ? 'Long' : 'Short'} at ${entry.toFixed(
      2
    )}: stop ${stopAnchor}, target at ${targetAnchor}.`,
  };
}

// ── Stage 4: risk review ────────────────────────────────────────────────────

function scoreConfidence(read: ChartRead, plan: TradePlan): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;

  score += read.trend.strength * 30;
  if (read.trend.strength < 0.4) notes.push('Trend conviction is weak.');

  const structureAligned =
    (plan.direction === 'long' && read.structure.label === 'HH-HL') ||
    (plan.direction === 'short' && read.structure.label === 'LH-LL');
  if (structureAligned) {
    score += 20;
    if (read.structure.brokeStructure) score += 5;
  } else if (read.structure.label === 'RANGE') {
    score += 8;
    notes.push('Structure is ranging, not trending.');
  } else {
    notes.push('Market structure opposes the trade direction.');
  }

  if (read.volume.participation === 'high') score += 15;
  else if (read.volume.participation === 'normal') score += 10;
  else {
    score += 4;
    notes.push('Volume participation is low.');
  }
  if (read.volume.risingIntoMove) score += 5;

  score += clamp((plan.riskReward - 1) / 2, 0, 1) * 20;

  const momentumScores = { accelerating: 10, steady: 7, stalling: 4, reversing: 0 } as const;
  score += momentumScores[read.priceAction.momentum];
  if (read.priceAction.momentum === 'reversing') {
    notes.push('Momentum is reversing against the recent move.');
  }

  return { score: Math.round(clamp(score, 0, 100)), notes };
}

export function reviewRisk(
  plan: TradePlan,
  read: ChartRead,
  opts: ResolvedOptions
): RiskReview {
  const { score: confidence, notes } = scoreConfidence(read, plan);

  if (!plan.hasSetup || plan.perUnitRisk <= 0) {
    return {
      positionSize: 0,
      notional: 0,
      riskAmount: 0,
      maxLossOk: true,
      exposurePct: (opts.openExposureNotional / opts.accountBalance) * 100,
      exposureOk: true,
      confidence,
      approved: false,
      notes: [plan.rationale, ...notes],
    };
  }

  let riskAmount = opts.accountBalance * (opts.riskPct / 100);
  let positionSize = riskAmount / plan.perUnitRisk;
  let notional = positionSize * plan.entry;

  const exposureBudget =
    opts.accountBalance * (opts.maxExposurePct / 100) - opts.openExposureNotional;
  let exposureOk = true;
  if (exposureBudget <= 0) {
    exposureOk = false;
    positionSize = 0;
    notional = 0;
    riskAmount = 0;
    notes.push('No exposure budget left — open positions already at the cap.');
  } else if (notional > exposureBudget) {
    positionSize = exposureBudget / plan.entry;
    notional = exposureBudget;
    riskAmount = positionSize * plan.perUnitRisk;
    notes.push('Size reduced to keep total exposure balanced across positions.');
  }

  const exposurePct =
    ((notional + opts.openExposureNotional) / opts.accountBalance) * 100;

  const maxLossBudget = opts.accountBalance * (opts.maxDrawdownPct / 100);
  const maxLossOk = riskAmount <= maxLossBudget + 1e-9;
  if (!maxLossOk) {
    notes.push(
      `Risk $${riskAmount.toFixed(2)} exceeds the max-loss budget of $${maxLossBudget.toFixed(2)}.`
    );
  }

  if (confidence < opts.minConfidence) {
    notes.push(`Confidence ${confidence} is below the ${opts.minConfidence} approval floor.`);
  }

  const approved =
    plan.hasSetup && maxLossOk && exposureOk && positionSize > 0 && confidence >= opts.minConfidence;

  return {
    positionSize,
    notional,
    riskAmount,
    maxLossOk,
    exposurePct,
    exposureOk,
    confidence,
    approved,
    notes,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

function buildSummary(plan: TradePlan, risk: RiskReview, read: ChartRead): string {
  if (!plan.hasSetup) return plan.rationale;
  if (!risk.approved) {
    return `Setup found but not approved — ${risk.notes[risk.notes.length - 1] ?? 'risk checks failed'}`;
  }
  const parts = [
    `${risk.confidence >= 75 ? 'High' : 'Moderate'} probability ${plan.direction} setup.`,
  ];
  if (read.trend.bias !== 'neutral') parts.push('Trend aligned.');
  if (read.structure.label !== 'RANGE') parts.push('Strong structure.');
  return parts.join(' ');
}

export function analyzeChart(
  symbol: string,
  interval: string,
  candles: Candle[],
  options: AnalyzeOptions = {}
): ChartAnalysis {
  if (candles.length < MIN_CANDLES) {
    throw new Error(
      `Chart analysis needs at least ${MIN_CANDLES} candles, got ${candles.length}. ` +
        'Try a shorter interval or a more liquid symbol.'
    );
  }

  const opts = resolveOptions({ ...options, symbol, interval });
  const read = readChart(candles, opts);
  const levels = findKeyLevels(candles, read.priceAction.lastClose, opts);
  const atrValue = atr(candles, opts.atrPeriod) ?? 0;
  const plan = buildTradePlan(read, levels, atrValue, opts);
  const risk = reviewRisk(plan, read, opts);

  return {
    symbol: opts.symbol.toUpperCase(),
    interval: opts.interval,
    candles: candles.length,
    read,
    levels,
    plan,
    risk,
    verdict: risk.approved ? 'APPROVED' : 'STAND ASIDE',
    summary: buildSummary(plan, risk, read),
  };
}
