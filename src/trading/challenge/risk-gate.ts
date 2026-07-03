/**
 * Challenge Risk Gate - every order passes through here before the broker
 *
 * Composes the existing risk stack (SafetyManager, CircuitBreaker, RiskEngine)
 * with challenge-specific rules:
 *  - mandatory stop on every entry, position sized so the stop-distance loss
 *    equals riskPerTradePct of sleeve equity
 *  - per-sleeve caps: concurrent positions, daily trades, exposure %
 *  - concentration cap across the whole bankroll
 *  - daily-loss halt (auto-resumes at UTC midnight) and max-drawdown kill
 *    switch (requires manual rearm), with auto-close of open positions
 *
 * The same gate would front a live ExecutionService after promotion - nothing
 * in here knows fills are simulated.
 */

import { EventEmitter } from 'events';
import { createSafetyManager, type SafetyManager } from '../safety.js';
import { createCircuitBreaker, type CircuitBreaker } from '../../execution/circuit-breaker.js';
import { createRiskEngine, type RiskEngine } from '../../risk/index.js';
import { logger } from '../../utils/logger.js';
import type { Database } from '../../db/index.js';
import type { Signal } from '../bots/index.js';
import { resolveChallengeConfig, type ChallengeConfig, type ChallengeFill, type SleeveId } from './types.js';
import type { PaperBroker } from './paper-broker.js';

/** Below this USD notional an entry is pointless (fees dominate) */
const MIN_TRADE_USD = 5;

export interface GateDecision {
  approved: boolean;
  /** Possibly reduced notional (USD) */
  adjustedSize?: number;
  reason?: string;
  warnings: string[];
}

export interface ChallengeRiskGate extends EventEmitter {
  /** Validate (and size) a signal before execution. Exits are always allowed. */
  check(signal: Signal, sleeve: SleeveId): GateDecision;
  /** Feed a completed fill back into safety/breaker/VaR state. */
  recordResult(fill: ChallengeFill): void;
  /** Record an execution error against a sleeve's breaker. */
  recordError(sleeve: SleeveId, error: Error | string): void;
  /** Push latest total equity into drawdown tracking. */
  onEquity(totalEquity: number): void;
  /** Manual or automatic kill: halts everything and flattens positions. */
  kill(reason: string): Promise<void>;
  /** Manual re-arm after a kill. Acknowledges the kill event. */
  rearm(): boolean;
  /** UTC-midnight reset of daily counters; lifts a daily halt. */
  resetDaily(day: string): void;
  getSafetyManager(): SafetyManager;
  getRiskEngine(): RiskEngine;
  destroy(): void;
}

export interface RiskGateDeps {
  db: Database;
  broker: PaperBroker;
  config?: Partial<ChallengeConfig>;
  /** safety_state namespace (default 2; 1 is the gateway's live manager) */
  safetyStateId?: number;
}

export function createChallengeRiskGate(deps: RiskGateDeps): ChallengeRiskGate {
  const emitter = new EventEmitter() as ChallengeRiskGate;
  const cfg: ChallengeConfig = resolveChallengeConfig(deps.config);
  const { broker } = deps;

  const dailyLossUsd = (cfg.bankroll * cfg.dailyLossCapPct) / 100;

  // safety_state_2: never collides with the gateway's live SafetyManager (id 1)
  const safety = createSafetyManager(deps.db, {
    stateId: deps.safetyStateId ?? 2,
    initialValue: cfg.bankroll,
    dailyLossLimit: dailyLossUsd,
    dailyLossLimitPct: undefined, // absolute cap only; pct-of-current-value double-counts on a small bankroll
    maxDrawdownPct: cfg.maxDrawdownPct,
    maxConcentrationPct: cfg.maxConcentrationPct,
    cooldownMs: cfg.breakerCooldownMs,
    autoCloseOnBreaker: true,
  });

  // Sleeve breakers own consecutive-losses / error-rate / trade-count;
  // loss caps live in the SafetyManager (maxLoss here is a wipeout backstop
  // only, so the two systems can't trip on the same event with different
  // cooldown semantics).
  const breakers: Record<SleeveId, CircuitBreaker> = {
    crypto: createCircuitBreaker(
      {
        maxLossUsd: cfg.bankroll,
        maxLossPct: 100,
        maxConsecutiveLosses: cfg.maxConsecutiveLosses,
        maxErrorRate: 0.3,
        minTradesForErrorRate: 10,
        cooldownMs: cfg.breakerCooldownMs,
        maxPositionSize: cfg.sleeves.crypto.maxPositionSize,
        maxDailyTrades: cfg.sleeves.crypto.maxDailyTrades,
      },
      cfg.sleeves.crypto.allocation
    ),
    prediction: createCircuitBreaker(
      {
        maxLossUsd: cfg.bankroll,
        maxLossPct: 100,
        maxConsecutiveLosses: cfg.maxConsecutiveLosses,
        maxErrorRate: 0.3,
        minTradesForErrorRate: 10,
        cooldownMs: cfg.breakerCooldownMs,
        maxPositionSize: cfg.sleeves.prediction.maxPositionSize,
        maxDailyTrades: cfg.sleeves.prediction.maxDailyTrades,
      },
      cfg.sleeves.prediction.allocation
    ),
  };

  const riskEngine = createRiskEngine(
    {
      initialBankroll: cfg.bankroll,
      varLimit: cfg.bankroll * 0.1,
    },
    {
      riskContext: {
        tradingContext: null,
        db: {
          getUser: () => undefined,
          getPositions: () => [],
        },
      },
      getPositionValues: () => broker.getOpenPositions().map((p) => p.qty * p.currentPrice),
    }
  );

  let killing = false;

  async function doKill(reason: string): Promise<void> {
    if (killing) return;
    killing = true;
    try {
      const state = broker.getState();
      if (state.status !== 'killed') {
        state.status = 'killed';
        state.statusReason = reason;
        state.unacknowledgedKills += 1;
        broker.persistState();
      }
      safety.killSwitch(reason);
      await broker.closeAll('kill_switch');
      emitter.emit('kill', { reason });
      logger.error({ reason }, 'challenge: KILL SWITCH - all positions flattened, manual rearm required');
    } finally {
      killing = false;
    }
  }

  function doDailyHalt(reason: string): void {
    const state = broker.getState();
    if (state.status === 'running') {
      state.status = 'halted_daily';
      state.statusReason = reason;
      broker.persistState();
      emitter.emit('halt', { reason });
      logger.warn({ reason }, 'challenge: daily loss cap hit - halted until next UTC day');
    }
  }

  safety.on('breakerTripped', ({ category, reason }: { category: string; reason: string }) => {
    if (category === 'drawdown') {
      void doKill(reason);
    } else if (category === 'daily_loss') {
      doDailyHalt(reason);
    }
  });

  emitter.check = (signal, sleeve) => {
    const warnings: string[] = [];

    // Exits are never blocked - reducing risk is always allowed
    if (signal.type !== 'buy') return { approved: true, warnings };

    const state = broker.getState();
    if (state.status !== 'running') {
      return { approved: false, reason: `challenge status: ${state.status}${state.statusReason ? ` (${state.statusReason})` : ''}`, warnings };
    }
    if (!safety.canTrade()) {
      return { approved: false, reason: safety.getState().disabledReason ?? 'safety system disabled trading', warnings };
    }
    const breaker = breakers[sleeve];
    if (!breaker.canTrade()) {
      return { approved: false, reason: `${sleeve} circuit breaker open`, warnings };
    }

    const sleeveCfg = cfg.sleeves[sleeve];
    const sleeveState = broker.getSleeveState(sleeve);

    if (sleeveState.dailyTrades >= sleeveCfg.maxDailyTrades) {
      return { approved: false, reason: `daily trade cap (${sleeveCfg.maxDailyTrades}) reached for ${sleeve}`, warnings };
    }

    const existing = broker
      .getOpenPositions(sleeve)
      .find((p) => p.platform === signal.platform && p.marketId === signal.marketId && p.outcome === signal.outcome);
    if (!existing && sleeveState.openPositions >= sleeveCfg.maxConcurrentPositions) {
      return { approved: false, reason: `max concurrent positions (${sleeveCfg.maxConcurrentPositions}) reached for ${sleeve}`, warnings };
    }

    const price = signal.price;
    if (!price || price <= 0) {
      return { approved: false, reason: 'entry signal must carry a price for risk sizing', warnings };
    }
    const meta = (signal.meta ?? {}) as Record<string, unknown>;
    const stopPrice = typeof meta.stopPrice === 'number' ? meta.stopPrice : undefined;
    if (stopPrice == null || stopPrice <= 0 || stopPrice >= price) {
      return { approved: false, reason: 'entry rejected: valid stopPrice below entry is mandatory', warnings };
    }

    // Size so that the stop-distance loss equals riskPerTradePct of sleeve equity
    const riskPct = Math.min(cfg.riskPerTradePct, cfg.maxRiskPerTradePct);
    const riskFraction = (price - stopPrice) / price;
    const maxRiskUsd = (sleeveState.equity * riskPct) / 100;
    const notionalByRisk = maxRiskUsd / riskFraction;

    const currentExposure = sleeveState.equity - sleeveState.balance;
    const exposureHeadroom = (sleeveState.equity * sleeveCfg.maxExposurePct) / 100 - currentExposure;

    const totalEquity = broker.totalEquity();
    const existingMarketValue = existing ? existing.qty * existing.currentPrice : 0;
    const concentrationHeadroom = (totalEquity * cfg.maxConcentrationPct) / 100 - existingMarketValue;

    const requested = signal.size ?? notionalByRisk;
    let adjusted = Math.min(
      requested,
      notionalByRisk,
      sleeveCfg.maxPositionSize,
      exposureHeadroom,
      concentrationHeadroom,
      sleeveState.balance
    );

    if (!Number.isFinite(adjusted) || adjusted < MIN_TRADE_USD) {
      return { approved: false, reason: `position sized below minimum ($${MIN_TRADE_USD}): risk/exposure/concentration caps leave no room`, warnings };
    }
    if (adjusted < requested) {
      warnings.push(`size reduced ${requested.toFixed(2)} -> ${adjusted.toFixed(2)} by risk caps`);
    }

    // Full 10-check engine pass (VaR, volatility regime, Kelly)
    const decision = riskEngine.validateTrade({
      userId: 'challenge',
      platform: signal.platform,
      marketId: signal.marketId,
      outcome: signal.outcome,
      side: 'buy',
      size: adjusted,
      price,
      confidence: signal.confidence,
    });
    if (!decision.approved) {
      return { approved: false, reason: `risk engine: ${decision.reason ?? 'rejected'}`, warnings };
    }
    if (decision.adjustedSize != null && decision.adjustedSize > 0 && decision.adjustedSize < adjusted) {
      warnings.push(`risk engine reduced size ${adjusted.toFixed(2)} -> ${decision.adjustedSize.toFixed(2)}`);
      adjusted = decision.adjustedSize;
      if (adjusted < MIN_TRADE_USD) {
        return { approved: false, reason: 'risk engine sized position below minimum', warnings };
      }
    }
    warnings.push(...decision.warnings);

    return { approved: true, adjustedSize: adjusted, warnings };
  };

  emitter.recordResult = (fill) => {
    safety.recordTrade({
      id: fill.id,
      platform: fill.platform,
      marketId: fill.marketId,
      outcome: fill.outcome,
      side: fill.side,
      orderType: 'market',
      price: fill.price,
      size: fill.qty,
      filled: fill.qty,
      cost: fill.qty * fill.price,
      fees: fill.fee,
      status: 'filled',
      strategyId: fill.strategyId,
      realizedPnL: fill.realizedPnL,
      createdAt: new Date(fill.ts),
    });

    if (fill.side === 'sell' && fill.realizedPnL !== undefined) {
      breakers[fill.sleeve].recordTrade({
        pnlUsd: fill.realizedPnL,
        success: fill.realizedPnL >= 0,
        sizeUsd: fill.qty * fill.price,
      });
      const sleeveEquity = broker.getSleeveState(fill.sleeve).equity;
      riskEngine.recordPnL({
        pnlUsd: fill.realizedPnL,
        pnlPct: sleeveEquity > 0 ? (fill.realizedPnL / sleeveEquity) * 100 : 0,
        positionId: `${fill.platform}:${fill.marketId}`,
        timestamp: new Date(fill.ts),
      });
    }
  };

  emitter.recordError = (sleeve, error) => {
    breakers[sleeve].recordError(error);
  };

  emitter.onEquity = (totalEquity) => {
    safety.updatePortfolioValue(totalEquity);
  };

  emitter.kill = (reason) => doKill(reason);

  emitter.rearm = () => {
    const state = broker.getState();
    if (state.status !== 'killed') return false;
    safety.resumeTrading();
    breakers.crypto.reset();
    breakers.prediction.reset();
    state.status = 'running';
    state.statusReason = undefined;
    state.unacknowledgedKills = 0; // rearm = explicit acknowledgement
    broker.persistState();
    emitter.emit('rearm', {});
    logger.warn('challenge: re-armed after kill switch');
    return true;
  };

  emitter.resetDaily = (day) => {
    const wasDailyHalt = broker.getState().status === 'halted_daily';
    safety.resetDaily();
    // Lift the safety-side daily-loss trip; a kill (manual/drawdown) stays down
    if (wasDailyHalt) safety.resumeTrading();
    // Fresh day, fresh sleeve breakers (only if not killed)
    if (broker.getState().status !== 'killed') {
      breakers.crypto.reset();
      breakers.prediction.reset();
    }
    broker.resetDaily(day);
    logger.info({ day }, 'challenge: daily counters reset');
  };

  emitter.getSafetyManager = () => safety;
  emitter.getRiskEngine = () => riskEngine;

  emitter.destroy = () => {
    safety.destroy();
    breakers.crypto.stop();
    breakers.prediction.stop();
  };

  return emitter;
}
