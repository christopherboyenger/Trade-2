/**
 * $1,000 -> $10,000 Challenge - Types
 *
 * A fully risk-managed, paper-trading-first autonomous trading challenge.
 * Two isolated sleeves (crypto momentum + prediction-market value/arb) run
 * against live market data with simulated fills. Real-money promotion is a
 * report, never an action.
 */

import type { Platform } from '../../types.js';

export type SleeveId = 'crypto' | 'prediction';

export interface SleeveConfig {
  /** Starting allocation in USD */
  allocation: number;
  /** Max USD notional for a single position */
  maxPositionSize: number;
  /** Max simultaneous open positions */
  maxConcurrentPositions: number;
  /** Max total exposure as % of sleeve equity */
  maxExposurePct: number;
  /** Max entries per UTC day */
  maxDailyTrades: number;
}

export type RiskLevel = 1 | 2 | 3 | 4 | 5;

export interface RiskPreset {
  level: RiskLevel;
  name: string;
  description: string;
  /** % of sleeve equity risked per trade */
  riskPerTradePct: number;
  /** Per-position cap as a fraction of sleeve allocation */
  positionCapFrac: number;
  /** Donchian entry channel (bars) — shorter fires more often */
  donchianEntryPeriod: number;
  /** Donchian exit channel (bars) */
  donchianExitPeriod: number;
}

/**
 * The risk dial. It scales EXPOSURE (size + trade frequency), never the
 * safety rails: the 5% daily halt, 15% drawdown kill switch, mandatory
 * stops and breakers are identical at every level.
 */
export const RISK_PRESETS: Record<RiskLevel, RiskPreset> = {
  1: { level: 1, name: 'Cautious',   description: 'Smallest positions, only the strongest breakouts. Slow and steady.', riskPerTradePct: 0.5,  positionCapFrac: 0.15, donchianEntryPeriod: 30, donchianExitPeriod: 15 },
  2: { level: 2, name: 'Careful',    description: 'Small positions, selective entries.',                                riskPerTradePct: 0.75, positionCapFrac: 0.2,  donchianEntryPeriod: 25, donchianExitPeriod: 12 },
  3: { level: 3, name: 'Standard',   description: 'The default challenge profile.',                                     riskPerTradePct: 1,    positionCapFrac: 0.2,  donchianEntryPeriod: 20, donchianExitPeriod: 10 },
  4: { level: 4, name: 'Aggressive', description: 'Bigger positions, quicker triggers. Expect deeper swings.',          riskPerTradePct: 1.5,  positionCapFrac: 0.3,  donchianEntryPeriod: 14, donchianExitPeriod: 7 },
  5: { level: 5, name: 'Max risk',   description: 'Largest positions, most trades. Highest potential return and the fastest path to the kill switch.', riskPerTradePct: 2.5, positionCapFrac: 0.4, donchianEntryPeriod: 10, donchianExitPeriod: 5 },
};

export interface ChallengeConfig {
  /** Challenge identifier (allows multiple runs) */
  id: string;
  /** Total starting bankroll (USD, paper) */
  bankroll: number;
  /** Equity target the challenge is chasing (USD). Defaults to 10x bankroll. */
  goal: number;
  /** Risk dial 1 (cautious) .. 5 (max). Scales exposure, never the safety rails. */
  riskLevel: RiskLevel;
  sleeves: Record<SleeveId, SleeveConfig>;
  /** Risk per trade as % of sleeve equity (position sized so stop-distance loss = this) */
  riskPerTradePct: number;
  /** Hard ceiling on risk per trade % */
  maxRiskPerTradePct: number;
  /** Daily realized-loss cap as % of bankroll; trips a halt until next UTC day */
  dailyLossCapPct: number;
  /** Max drawdown from peak equity %; trips the kill switch (manual re-arm) */
  maxDrawdownPct: number;
  /** Consecutive losses in a sleeve before its breaker trips */
  maxConsecutiveLosses: number;
  /** Breaker cooldown (ms) */
  breakerCooldownMs: number;
  /** Max % of total equity in a single market */
  maxConcentrationPct: number;
  /** Crypto fill slippage (basis points, adverse) */
  cryptoSlippageBps: number;
  /** Crypto taker fee (basis points) */
  cryptoFeeBps: number;
  /** Penalty slippage when no orderbook is available (bps) */
  fallbackSlippageBps: number;
  /** Reject prediction fills when no orderbook available */
  strictFills: boolean;
  /** Max age of a crypto tick before entries are blocked (ms) */
  staleTickMs: number;
  /** Max age of a prediction orderbook before entries are blocked (ms) */
  staleBookMs: number;
  /** Mark-to-market / stop-check interval (ms) */
  markIntervalMs: number;
  /** Alert delivery (optional) */
  alertChannel?: string;
  alertChatId?: string;
}

export const DEFAULT_CHALLENGE_CONFIG: ChallengeConfig = {
  id: 'default',
  bankroll: 1000,
  goal: 10_000,
  riskLevel: 3,
  sleeves: {
    crypto: {
      allocation: 500,
      maxPositionSize: 100,
      maxConcurrentPositions: 2,
      maxExposurePct: 60,
      maxDailyTrades: 10,
    },
    prediction: {
      allocation: 500,
      maxPositionSize: 50,
      maxConcurrentPositions: 2,
      maxExposurePct: 60,
      maxDailyTrades: 10,
    },
  },
  riskPerTradePct: 1,
  maxRiskPerTradePct: 2,
  dailyLossCapPct: 5,
  maxDrawdownPct: 15,
  maxConsecutiveLosses: 4,
  breakerCooldownMs: 4 * 60 * 60 * 1000,
  maxConcentrationPct: 25,
  cryptoSlippageBps: 5,
  cryptoFeeBps: 10,
  fallbackSlippageBps: 50,
  strictFills: false,
  staleTickMs: 60_000,
  staleBookMs: 120_000,
  markIntervalMs: 30_000,
};

/**
 * Merge a partial config over the defaults.
 *
 * When `bankroll` changes and sleeves are not explicitly pinned, sleeve
 * allocations and per-position caps scale proportionally (a $5,000 bankroll
 * gets $2,500 sleeves with $500/$250 position caps). `goal` defaults to
 * 10x bankroll so "the challenge" keeps its meaning at any size.
 */
export function resolveChallengeConfig(partial?: Partial<ChallengeConfig>): ChallengeConfig {
  const base = DEFAULT_CHALLENGE_CONFIG;
  const bankroll = partial?.bankroll && partial.bankroll > 0 ? partial.bankroll : base.bankroll;
  const scale = bankroll / base.bankroll;
  const riskLevel = (partial?.riskLevel && RISK_PRESETS[partial.riskLevel] ? partial.riskLevel : base.riskLevel) as RiskLevel;
  const preset = RISK_PRESETS[riskLevel];
  // Position cap = preset fraction of the (scaled) sleeve allocation.
  // The prediction sleeve keeps its historical 2:1 ratio vs crypto.
  const scaled = (s: SleeveConfig, capFrac: number): SleeveConfig => ({
    ...s,
    allocation: s.allocation * scale,
    maxPositionSize: s.allocation * scale * capFrac,
  });
  return {
    ...base,
    ...partial,
    bankroll,
    goal: partial?.goal && partial.goal > 0 ? partial.goal : bankroll * 10,
    riskLevel,
    riskPerTradePct: partial?.riskPerTradePct ?? preset.riskPerTradePct,
    // The ceiling rises only far enough to admit the chosen preset (level 5
    // needs 2.5%); non-dial configs keep the historical 2% clamp. Every other
    // rail (daily cap, drawdown kill, breakers) comes from base/partial as-is.
    maxRiskPerTradePct: partial?.maxRiskPerTradePct ?? Math.max(base.maxRiskPerTradePct, preset.riskPerTradePct),
    sleeves: {
      crypto: { ...scaled(base.sleeves.crypto, preset.positionCapFrac), ...partial?.sleeves?.crypto },
      prediction: { ...scaled(base.sleeves.prediction, preset.positionCapFrac / 2), ...partial?.sleeves?.prediction },
    },
  };
}

export type ChallengeRunStatus =
  | 'running'
  | 'halted_daily'
  | 'killed'
  | 'stopped';

export type CloseReason =
  | 'signal_exit'
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'kill_switch'
  | 'manual';

export interface ChallengePosition {
  id: string;
  challengeId: string;
  sleeve: SleeveId;
  platform: Platform;
  marketId: string;
  outcome: string;
  qty: number;
  avgPrice: number;
  /** Total USD paid including fees */
  costBasis: number;
  currentPrice: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  /** Absolute price distance for the trailing stop (e.g. 2.5 x ATR) */
  trailDistance?: number;
  /** Price at which trailing activates (e.g. entry + 1 x ATR) */
  trailActivationPrice?: number;
  /** High-water mark once trailing is active */
  trailHighWater?: number;
  /** Group id linking hedged arb legs */
  pairId?: string;
  strategyId: string;
  openedAt: number;
  meta?: Record<string, unknown>;
}

export interface ChallengeFill {
  id: string;
  challengeId: string;
  sleeve: SleeveId;
  platform: Platform;
  marketId: string;
  outcome: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  slippage: number;
  realizedPnL?: number;
  reason: 'entry' | CloseReason;
  strategyId: string;
  ts: number;
}

export interface SleeveState {
  balance: number;
  equity: number;
  peakEquity: number;
  realizedPnL: number;
  dailyRealizedPnL: number;
  dailyTrades: number;
  openPositions: number;
}

export interface ChallengeState {
  id: string;
  status: ChallengeRunStatus;
  statusReason?: string;
  bankroll: number;
  sleeves: Record<SleeveId, { balance: number; realizedPnL: number; dailyRealizedPnL: number; dailyTrades: number }>;
  peakEquity: number;
  startedAt: number;
  lastMarkAt?: number;
  lastDailyResetDay?: string;
  /** Kill events that have not been acknowledged via rearm */
  unacknowledgedKills: number;
  promotedEligible: boolean;
}

export interface EquityPoint {
  ts: number;
  sleeve: SleeveId | 'total';
  equity: number;
  drawdownPct: number;
}

export interface PromotionGateResult {
  gate: string;
  passed: boolean;
  value: string;
  required: string;
}

export interface PromotionReport {
  eligible: boolean;
  gates: PromotionGateResult[];
  closedTrades: number;
  daysElapsed: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  asOf: string;
}

export interface ChallengeStatusView {
  id: string;
  status: ChallengeRunStatus;
  statusReason?: string;
  equity: number;
  bankroll: number;
  peakEquity: number;
  drawdownPct: number;
  goal: number;
  progressPct: number;
  sleeves: Record<SleeveId, SleeveState>;
  openPositions: ChallengePosition[];
  startedAt: number;
  lastMarkAt?: number;
}
