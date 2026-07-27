/**
 * Chart-analysis types — the OPUS 5 pipeline.
 *
 * Mirrors the "connect the model to TradingView" workflow:
 *   1. read the chart      → price action, volume, structure, trend/bias
 *   2. find the key levels  → support, resistance, liquidity, supply & demand
 *   3. build the trade plan → entry, stop, target, risk/reward
 *   4. risk review          → position size, max loss, exposure, confidence
 *
 * Everything here is pure data — the engine that produces it does no I/O, so it
 * is deterministic and unit-testable (see tests/unit/chart-analysis.test.ts).
 */

/** Normalized candle. `time` is a millisecond epoch. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Trend = 'bullish' | 'bearish' | 'neutral';
export type Direction = 'long' | 'short';

/** Market-structure label from swing pivots. */
export type StructureLabel = 'HH-HL' | 'LH-LL' | 'RANGE';

// ── Stage 1: read the chart ─────────────────────────────────────────────────

export interface PriceAction {
  lastClose: number;
  /** Percent change across the read window. */
  changePct: number;
  momentum: 'accelerating' | 'stalling' | 'reversing' | 'steady';
  /** Avg candle body as a fraction of range over the recent window (0..1). */
  bodyStrength: number;
}

export interface VolumeRead {
  last: number;
  average: number;
  /** last / average, as a percentage. */
  strengthPct: number;
  participation: 'high' | 'normal' | 'low';
  /** Is volume expanding into the most recent move? */
  risingIntoMove: boolean;
}

export interface StructureRead {
  label: StructureLabel;
  description: string;
  swingHighs: number[];
  swingLows: number[];
  /** Did the last close break the prior swing high/low (break of structure)? */
  brokeStructure: boolean;
}

export interface TrendRead {
  bias: Trend;
  emaFast: number;
  emaSlow: number;
  /** Regression slope over the window, normalized by price (percent per bar). */
  slopePct: number;
  /** 0..1 conviction. */
  strength: number;
}

export interface ChartRead {
  priceAction: PriceAction;
  volume: VolumeRead;
  structure: StructureRead;
  trend: TrendRead;
}

// ── Stage 2: key levels ─────────────────────────────────────────────────────

export interface Level {
  price: number;
  kind: 'support' | 'resistance';
  /** Number of swing touches that formed the level. */
  touches: number;
  /** 0..1, derived from touch count. */
  strength: number;
}

export interface LiquidityPool {
  price: number;
  /** buy-side = resting stops above highs; sell-side = resting stops below lows. */
  side: 'buy-side' | 'sell-side';
}

export interface Zone {
  low: number;
  high: number;
  kind: 'supply' | 'demand';
}

export interface KeyLevels {
  supports: Level[];
  resistances: Level[];
  nearestSupport: Level | null;
  nearestResistance: Level | null;
  liquidity: LiquidityPool[];
  supplyDemand: Zone[];
  /** Bias implied purely by where price sits in its range. */
  bias: Trend;
}

// ── Stage 3: trade plan ─────────────────────────────────────────────────────

export interface TradePlan {
  hasSetup: boolean;
  direction: Direction | null;
  entry: number;
  stopLoss: number;
  target: number;
  /** reward / risk. */
  riskReward: number;
  /** |entry − stop| per unit. */
  perUnitRisk: number;
  rationale: string;
}

// ── Stage 4: risk review ────────────────────────────────────────────────────

export interface RiskReview {
  /** Position size in base-asset units. */
  positionSize: number;
  /** positionSize × entry. */
  notional: number;
  /** Currency amount risked if the stop is hit. */
  riskAmount: number;
  /** Per-trade risk stays inside the drawdown budget. */
  maxLossOk: boolean;
  /** Total exposure (this trade + open) as a percent of balance. */
  exposurePct: number;
  exposureOk: boolean;
  /** 0..100 setup-quality score. */
  confidence: number;
  approved: boolean;
  notes: string[];
}

// ── Orchestrated result ─────────────────────────────────────────────────────

export interface ChartAnalysis {
  symbol: string;
  interval: string;
  candles: number;
  read: ChartRead;
  levels: KeyLevels;
  plan: TradePlan;
  risk: RiskReview;
  verdict: 'APPROVED' | 'STAND ASIDE';
  summary: string;
}

export interface AnalyzeOptions {
  symbol?: string;
  interval?: string;
  /** Account balance used for position sizing (quote currency). Default 1000. */
  accountBalance?: number;
  /** Percent of balance to risk per trade. Default 1. */
  riskPct?: number;
  /** Max per-trade risk as a percent of balance ("max loss"). Default 20. */
  maxDrawdownPct?: number;
  /** Cap on total exposure as a percent of balance. Default 100. */
  maxExposurePct?: number;
  /** Existing open exposure (notional) to keep total exposure balanced. Default 0. */
  openExposureNotional?: number;
  /** Minimum acceptable reward/risk. Default 1.5. */
  minRiskReward?: number;
  /** Minimum confidence to approve. Default 60. */
  minConfidence?: number;
  emaFastPeriod?: number;
  emaSlowPeriod?: number;
  atrPeriod?: number;
  /** Pivot strength (bars either side) for swing detection. Default 2. */
  swingLookback?: number;
}

export interface ResolvedOptions {
  symbol: string;
  interval: string;
  accountBalance: number;
  riskPct: number;
  maxDrawdownPct: number;
  maxExposurePct: number;
  openExposureNotional: number;
  minRiskReward: number;
  minConfidence: number;
  emaFastPeriod: number;
  emaSlowPeriod: number;
  atrPeriod: number;
  swingLookback: number;
}

export const DEFAULT_OPTIONS: ResolvedOptions = {
  symbol: 'BTC',
  interval: '1h',
  accountBalance: 1000,
  riskPct: 1,
  maxDrawdownPct: 20,
  maxExposurePct: 100,
  openExposureNotional: 0,
  minRiskReward: 1.5,
  minConfidence: 60,
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  atrPeriod: 14,
  swingLookback: 2,
};

export function resolveOptions(opts: AnalyzeOptions = {}): ResolvedOptions {
  return {
    symbol: opts.symbol ?? DEFAULT_OPTIONS.symbol,
    interval: opts.interval ?? DEFAULT_OPTIONS.interval,
    accountBalance: opts.accountBalance ?? DEFAULT_OPTIONS.accountBalance,
    riskPct: opts.riskPct ?? DEFAULT_OPTIONS.riskPct,
    maxDrawdownPct: opts.maxDrawdownPct ?? DEFAULT_OPTIONS.maxDrawdownPct,
    maxExposurePct: opts.maxExposurePct ?? DEFAULT_OPTIONS.maxExposurePct,
    openExposureNotional: opts.openExposureNotional ?? DEFAULT_OPTIONS.openExposureNotional,
    minRiskReward: opts.minRiskReward ?? DEFAULT_OPTIONS.minRiskReward,
    minConfidence: opts.minConfidence ?? DEFAULT_OPTIONS.minConfidence,
    emaFastPeriod: opts.emaFastPeriod ?? DEFAULT_OPTIONS.emaFastPeriod,
    emaSlowPeriod: opts.emaSlowPeriod ?? DEFAULT_OPTIONS.emaSlowPeriod,
    atrPeriod: opts.atrPeriod ?? DEFAULT_OPTIONS.atrPeriod,
    swingLookback: opts.swingLookback ?? DEFAULT_OPTIONS.swingLookback,
  };
}
