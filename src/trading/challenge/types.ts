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

export interface ChallengeConfig {
  /** Challenge identifier (allows multiple runs) */
  id: string;
  /** Total starting bankroll (USD, paper) */
  bankroll: number;
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
