/**
 * Challenge Manager - composes the $1k -> $10k paper-trading challenge
 *
 * Own BotManager instances (one per sleeve) with executeOrder = risk gate ->
 * paper broker. Never touches the gateway's live executionService; runs with
 * zero exchange credentials.
 *
 * Lifecycle: mark-to-market timer, stale-feed watchdog, UTC-midnight daily
 * reset (lifts daily halts, resets counters, sends the daily summary and
 * evaluates promotion gates).
 */

import { logger } from '../../utils/logger.js';
import { createBotManager, type BotManager, type Signal } from '../bots/index.js';
import type { Database } from '../../db/index.js';
import type { Trade } from '../logger.js';
import { createCryptoFeed, type CryptoFeed } from '../../feeds/crypto/index.js';
import { createPaperBroker, type PaperBroker, type OrderbookProvider } from './paper-broker.js';
import { createChallengeRiskGate, type ChallengeRiskGate } from './risk-gate.js';
import { createChallengePersistence } from './persistence.js';
import { createChallengeReporter, type ChallengeReporter, type NotifyFn } from './reporter.js';
import { evaluatePromotionGates } from './promotion.js';
import { createChallengeCryptoStrategy } from './strategies/crypto-momentum.js';
import { createChallengePredictionStrategy, type PredictionFeedLike } from './strategies/prediction-value.js';
import {
  resolveChallengeConfig,
  RISK_PRESETS,
  type ChallengeConfig,
  type ChallengeStatusView,
  type PromotionReport,
  type SleeveId,
} from './types.js';

export interface ChallengeManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ChallengeStatusView;
  promotionReport(): PromotionReport;
  kill(reason: string): Promise<void>;
  rearm(): boolean;
  reset(): Promise<void>;
  getBroker(): PaperBroker;
  getGate(): ChallengeRiskGate;
}

export interface ChallengeManagerDeps {
  db: Database;
  /** FeedManager (or compatible) for prediction-market data; optional */
  feeds?: (PredictionFeedLike & OrderbookProvider) | null;
  config?: Partial<ChallengeConfig>;
  notify?: NotifyFn;
  /** Injectable for tests */
  cryptoFeed?: CryptoFeed;
  /** Disable interval timers (tests drive ticks manually) */
  timersEnabled?: boolean;
}

// Module-level registry so bundled skills can reach the running instance
let activeManager: ChallengeManager | null = null;
export function getChallengeManager(): ChallengeManager | null {
  return activeManager;
}

const STALE_ALERT_MS = 5 * 60 * 1000;

export function createChallengeManager(deps: ChallengeManagerDeps): ChallengeManager {
  const cfg: ChallengeConfig = resolveChallengeConfig(deps.config);
  const timersEnabled = deps.timersEnabled ?? true;
  const notify: NotifyFn = deps.notify ?? (async (text) => logger.info({ text }, 'challenge notification'));

  const cryptoFeed = deps.cryptoFeed ?? createCryptoFeed();
  const ownsCryptoFeed = !deps.cryptoFeed;

  const emptyBooks: OrderbookProvider = { getOrderbook: async () => null };
  const broker = createPaperBroker({
    db: deps.db,
    cryptoFeed,
    feeds: deps.feeds ?? emptyBooks,
    config: cfg,
  });
  const gate = createChallengeRiskGate({ db: deps.db, broker, config: cfg });
  const persistence = createChallengePersistence(deps.db);
  const reporter: ChallengeReporter = createChallengeReporter(notify);
  reporter.attach(broker, gate);

  // Broker results feed safety/breaker/VaR state
  broker.on('fill', (fill) => gate.recordResult(fill));
  broker.on('equity', ({ total }: { total: number }) => gate.onEquity(total));

  function gatedExecute(sleeve: SleeveId) {
    return async (signal: Signal, strategyId: string): Promise<Trade | null> => {
      const decision = gate.check(signal, sleeve);
      if (!decision.approved) {
        logger.info({ strategyId, sleeve, reason: decision.reason, signal: { type: signal.type, marketId: signal.marketId } }, 'challenge: signal rejected by risk gate');
        return null;
      }
      if (decision.adjustedSize != null) signal.size = decision.adjustedSize;
      try {
        return await broker.execute(signal, strategyId, sleeve);
      } catch (err) {
        gate.recordError(sleeve, err instanceof Error ? err : String(err));
        throw err;
      }
    };
  }

  // One BotManager per sleeve so getPortfolio/executeOrder are sleeve-scoped
  const cryptoBots: BotManager = createBotManager(deps.db, {
    executeOrder: gatedExecute('crypto'),
    getPortfolio: () => broker.getPortfolio('crypto'),
  });
  const predictionBots: BotManager = createBotManager(deps.db, {
    executeOrder: gatedExecute('prediction'),
    getPortfolio: () => broker.getPortfolio('prediction'),
  });

  const riskPreset = RISK_PRESETS[cfg.riskLevel];
  const cryptoStrategy = createChallengeCryptoStrategy({
    getOHLCV: (symbol, interval, limit) => cryptoFeed.getOHLCV(symbol, interval, limit),
    params: {
      riskPerTradePct: cfg.riskPerTradePct,
      donchianEntryPeriod: riskPreset.donchianEntryPeriod,
      donchianExitPeriod: riskPreset.donchianExitPeriod,
      symbols: riskPreset.symbols,
    },
  });
  cryptoBots.registerStrategy(cryptoStrategy);

  if (deps.feeds) {
    const predictionStrategy = createChallengePredictionStrategy({
      feeds: deps.feeds,
      params: { entryUsd: cfg.sleeves.prediction.maxPositionSize },
    });
    predictionBots.registerStrategy(predictionStrategy);
  } else {
    logger.warn('challenge: no feeds manager available - prediction sleeve disabled');
  }

  let markTimer: NodeJS.Timeout | null = null;
  let dailyTimer: NodeJS.Timeout | null = null;
  let staleSince: number | null = null;
  let staleAlerted = false;
  let running = false;

  function utcDay(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  async function markCycle(): Promise<void> {
    try {
      await broker.markToMarket();
    } catch (err) {
      logger.error({ err }, 'challenge: mark-to-market failed');
    }
    // Stale-feed watchdog
    const connected = cryptoFeed.isConnected();
    if (!connected) {
      staleSince = staleSince ?? Date.now();
      if (!staleAlerted && Date.now() - staleSince > STALE_ALERT_MS) {
        staleAlerted = true;
        await reporter.notifyStaleFeed('crypto feed disconnected for over 5 minutes');
      }
    } else {
      staleSince = null;
      staleAlerted = false;
    }
  }

  async function dailyTick(): Promise<void> {
    const state = broker.getState();
    const today = utcDay(Date.now());
    if (state.lastDailyResetDay === today) return;

    // New UTC day: summary for the day that ended, then reset
    try {
      const report = evaluatePromotionGates(persistence, cfg.id);
      await reporter.sendDailySummary(statusView(), report);
      if (report.eligible && !state.promotedEligible) {
        state.promotedEligible = true;
        broker.persistState();
        await reporter.notifyPromotionEligible(report);
      }
    } catch (err) {
      logger.error({ err }, 'challenge: daily summary failed');
    }
    gate.resetDaily(today);
  }

  function statusView(): ChallengeStatusView {
    const state = broker.getState();
    const equity = broker.totalEquity();
    const drawdownPct = state.peakEquity > 0 ? ((state.peakEquity - equity) / state.peakEquity) * 100 : 0;
    return {
      id: state.id,
      status: state.status,
      statusReason: state.statusReason,
      equity,
      bankroll: cfg.bankroll,
      peakEquity: state.peakEquity,
      drawdownPct,
      goal: cfg.goal,
      progressPct: (equity / cfg.goal) * 100,
      sleeves: {
        crypto: broker.getSleeveState('crypto'),
        prediction: broker.getSleeveState('prediction'),
      },
      openPositions: broker.getOpenPositions(),
      startedAt: state.startedAt,
      lastMarkAt: state.lastMarkAt,
    };
  }

  const manager: ChallengeManager = {
    async start() {
      if (running) return;
      running = true;
      broker.resume();
      if (ownsCryptoFeed) cryptoFeed.start();

      // Seed the daily-reset day on the very first run
      const state = broker.getState();
      if (!state.lastDailyResetDay) {
        state.lastDailyResetDay = utcDay(Date.now());
        broker.persistState();
      }

      await cryptoBots.startBot(cryptoStrategy.config.id);
      if (deps.feeds) await predictionBots.startBot('challenge-prediction');

      if (timersEnabled) {
        markTimer = setInterval(() => void markCycle(), cfg.markIntervalMs);
        dailyTimer = setInterval(() => void dailyTick(), 60_000);
        markTimer.unref?.();
        dailyTimer.unref?.();
      }
      activeManager = manager;
      logger.info(
        { challengeId: cfg.id, status: broker.getState().status, equity: broker.totalEquity() },
        'challenge: started (paper trading, zero credentials)'
      );
    },

    async stop() {
      if (markTimer) clearInterval(markTimer);
      if (dailyTimer) clearInterval(dailyTimer);
      markTimer = null;
      dailyTimer = null;
      if (running) {
        running = false;
        try {
          await cryptoBots.stopBot(cryptoStrategy.config.id);
        } catch { /* not running */ }
        try {
          if (deps.feeds) await predictionBots.stopBot('challenge-prediction');
        } catch { /* not running */ }
      }
      // Always release timers held by the risk stack, even if never started
      gate.destroy();
      if (ownsCryptoFeed) cryptoFeed.stop();
      if (activeManager === manager) activeManager = null;
      logger.info('challenge: stopped');
    },

    status: statusView,

    promotionReport() {
      return evaluatePromotionGates(persistence, cfg.id);
    },

    kill(reason) {
      return gate.kill(reason);
    },

    rearm() {
      return gate.rearm();
    },

    async reset() {
      await broker.closeAll('manual');
      broker.reset();
      logger.warn({ challengeId: cfg.id }, 'challenge: reset to fresh bankroll');
    },

    getBroker: () => broker,
    getGate: () => gate,
  };

  // Exposed for tests that drive the clock manually
  (manager as any)._markCycle = markCycle;
  (manager as any)._dailyTick = dailyTick;
  (manager as any)._evaluateOnce = async (sleeve: SleeveId) => {
    const bots = sleeve === 'crypto' ? cryptoBots : predictionBots;
    const id = sleeve === 'crypto' ? cryptoStrategy.config.id : 'challenge-prediction';
    const signals = await bots.evaluateNow(id);
    const results: Array<Trade | null> = [];
    for (const signal of signals) {
      if (signal.type === 'hold') continue;
      results.push(await gatedExecute(sleeve)(signal, id));
    }
    return results;
  };

  return manager;
}
