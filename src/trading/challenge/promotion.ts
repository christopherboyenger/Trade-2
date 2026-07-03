/**
 * Promotion Gates - statistical proof required before live money is discussed
 *
 * Pure read over challenge_trades + challenge_equity. Nothing here (or
 * anywhere else in the challenge) places live orders: a passing report only
 * flips `promoted_eligible` and alerts the owner.
 */

import type { ChallengePersistence } from './persistence.js';
import type { EquityPoint, PromotionGateResult, PromotionReport } from './types.js';

export interface PromotionGateConfig {
  minTrades: number;
  minDays: number;
  /** Alternative path: more trades + statistical significance */
  altMinTrades: number;
  altPValue: number;
  minProfitFactor: number;
  maxDrawdownPct: number;
  maxSleeveDrawdownPct: number;
}

export const DEFAULT_PROMOTION_GATES: PromotionGateConfig = {
  minTrades: 30,
  minDays: 60,
  altMinTrades: 50,
  altPValue: 0.05,
  minProfitFactor: 1.3,
  maxDrawdownPct: 15,
  maxSleeveDrawdownPct: 25,
};

/** Max peak-to-trough drawdown (%) of an equity curve. */
export function maxDrawdownPct(points: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) {
      maxDd = Math.max(maxDd, ((peak - p.equity) / peak) * 100);
    }
  }
  return maxDd;
}

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** One-sided p-value for mean(returns) > 0 (normal approximation, n >= 30). */
export function oneSidedPValue(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 1;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return mean > 0 ? 0 : 1;
  const t = mean / (sd / Math.sqrt(n));
  return 1 - normalCdf(t);
}

export function evaluatePromotionGates(
  persistence: ChallengePersistence,
  challengeId: string,
  config: Partial<PromotionGateConfig> = {},
  nowTs: number = Date.now()
): PromotionReport {
  const cfg = { ...DEFAULT_PROMOTION_GATES, ...config };
  const state = persistence.loadState(challengeId);
  const fills = persistence.listFills(challengeId, 100_000);
  const closed = fills.filter((f) => f.side === 'sell' && f.realizedPnL !== undefined);
  const pnls = closed.map((f) => f.realizedPnL as number);

  const daysElapsed = state ? (nowTs - state.startedAt) / (24 * 60 * 60 * 1000) : 0;

  const grossWins = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
  const expectancy = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;

  const totalCurve = persistence.listEquity(challengeId, 'total', 100_000);
  const ddPct = maxDrawdownPct(totalCurve);
  const cryptoDd = maxDrawdownPct(persistence.listEquity(challengeId, 'crypto', 100_000));
  const predictionDd = maxDrawdownPct(persistence.listEquity(challengeId, 'prediction', 100_000));

  const pValue = oneSidedPValue(pnls);
  const samplePrimary = closed.length >= cfg.minTrades && daysElapsed >= cfg.minDays;
  const sampleAlt = closed.length >= cfg.altMinTrades && pValue < cfg.altPValue;

  const gates: PromotionGateResult[] = [
    {
      gate: 'sample size',
      passed: samplePrimary || sampleAlt,
      value: `${closed.length} trades / ${daysElapsed.toFixed(0)} days (p=${pValue.toFixed(3)})`,
      required: `>=${cfg.minTrades} trades AND >=${cfg.minDays} days, OR >=${cfg.altMinTrades} trades with p<${cfg.altPValue}`,
    },
    {
      gate: 'profit factor',
      passed: profitFactor > cfg.minProfitFactor,
      value: Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : 'inf',
      required: `>${cfg.minProfitFactor}`,
    },
    {
      gate: 'max drawdown',
      passed: totalCurve.length > 0 && ddPct < cfg.maxDrawdownPct,
      value: `${ddPct.toFixed(1)}%`,
      required: `<${cfg.maxDrawdownPct}%`,
    },
    {
      gate: 'positive expectancy',
      passed: pnls.length > 0 && expectancy > 0,
      value: `$${expectancy.toFixed(2)}/trade`,
      required: '>$0 after fees/slippage',
    },
    {
      gate: 'kill events acknowledged',
      passed: (state?.unacknowledgedKills ?? 0) === 0,
      value: `${state?.unacknowledgedKills ?? 0} unacknowledged`,
      required: '0',
    },
    {
      gate: 'sleeve drawdowns',
      passed: cryptoDd <= cfg.maxSleeveDrawdownPct && predictionDd <= cfg.maxSleeveDrawdownPct,
      value: `crypto ${cryptoDd.toFixed(1)}%, prediction ${predictionDd.toFixed(1)}%`,
      required: `each <=${cfg.maxSleeveDrawdownPct}%`,
    },
  ];

  return {
    eligible: gates.every((g) => g.passed),
    gates,
    closedTrades: closed.length,
    daysElapsed,
    profitFactor,
    expectancy,
    maxDrawdownPct: ddPct,
    asOf: new Date(nowTs).toISOString(),
  };
}
