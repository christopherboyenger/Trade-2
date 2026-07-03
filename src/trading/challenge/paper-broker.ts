/**
 * Paper Broker - simulates order execution against live market data
 *
 * Fills crypto orders at the live feed price plus adverse slippage and taker
 * fees; fills prediction-market orders by walking the real orderbook. Holds
 * stop-loss / take-profit / trailing-stop enforcement broker-side in the
 * mark-to-market cycle so exits fire even if a strategy is wedged.
 *
 * Never touches live execution paths: everything settles into the
 * challenge_* tables via ChallengePersistence.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { calculateFillFromOrderbook } from '../../execution/index.js';
import { logger } from '../../utils/logger.js';
import type { Database } from '../../db/index.js';
import type { Orderbook, Platform } from '../../types.js';
import type { CryptoFeed } from '../../feeds/crypto/index.js';
import type { Signal } from '../bots/index.js';
import type { Trade } from '../logger.js';
import { createChallengePersistence, type ChallengePersistence } from './persistence.js';
import {
  DEFAULT_CHALLENGE_CONFIG,
  type ChallengeConfig,
  type ChallengeFill,
  type ChallengePosition,
  type ChallengeState,
  type CloseReason,
  type SleeveId,
  type SleeveState,
} from './types.js';

export interface OrderbookProvider {
  getOrderbook(platform: string, marketId: string): Promise<Orderbook | null>;
}

export interface PaperBrokerDeps {
  db: Database;
  cryptoFeed: CryptoFeed;
  feeds: OrderbookProvider;
  config?: Partial<ChallengeConfig>;
  /** Clock override for tests */
  now?: () => number;
}

export interface PaperBroker extends EventEmitter {
  /** Execute a strategy signal as a simulated fill. Returns null if rejected. */
  execute(signal: Signal, strategyId: string, sleeve: SleeveId): Promise<Trade | null>;
  /** Reprice open positions, enforce stops, record the equity curve. */
  markToMarket(): Promise<void>;
  /** Close a single position at current market price. */
  closePosition(positionId: string, reason: CloseReason): Promise<Trade | null>;
  /** Close everything (kill switch / shutdown). */
  closeAll(reason: CloseReason): Promise<void>;
  /** Portfolio snapshot for BotManager's StrategyContext. */
  getPortfolio(sleeve: SleeveId): Promise<{
    value: number;
    balance: number;
    positions: Array<{ platform: Platform; marketId: string; outcome: string; shares: number; avgPrice: number; currentPrice: number; [key: string]: unknown }>;
  }>;
  getState(): ChallengeState;
  getSleeveState(sleeve: SleeveId): SleeveState;
  getOpenPositions(sleeve?: SleeveId): ChallengePosition[];
  totalEquity(): number;
  /** Reload state + positions from SQLite (restart recovery). */
  resume(): void;
  /** Reset daily counters (UTC midnight). */
  resetDaily(day: string): void;
  /** Wipe and restart the challenge from the configured bankroll. */
  reset(): void;
  persistState(): void;
}

interface FillComputation {
  price: number;
  slippage: number;
  fee: number;
  qty: number;
  stale: boolean;
}

export function createPaperBroker(deps: PaperBrokerDeps): PaperBroker {
  const emitter = new EventEmitter() as PaperBroker;
  const cfg: ChallengeConfig = {
    ...DEFAULT_CHALLENGE_CONFIG,
    ...deps.config,
    sleeves: {
      crypto: { ...DEFAULT_CHALLENGE_CONFIG.sleeves.crypto, ...deps.config?.sleeves?.crypto },
      prediction: { ...DEFAULT_CHALLENGE_CONFIG.sleeves.prediction, ...deps.config?.sleeves?.prediction },
    },
  };
  const now = deps.now ?? (() => Date.now());
  const persistence: ChallengePersistence = createChallengePersistence(deps.db);

  let state: ChallengeState = freshState();
  let positions: ChallengePosition[] = [];

  function freshState(): ChallengeState {
    return {
      id: cfg.id,
      status: 'running',
      bankroll: cfg.bankroll,
      sleeves: {
        crypto: { balance: cfg.sleeves.crypto.allocation, realizedPnL: 0, dailyRealizedPnL: 0, dailyTrades: 0 },
        prediction: { balance: cfg.sleeves.prediction.allocation, realizedPnL: 0, dailyRealizedPnL: 0, dailyTrades: 0 },
      },
      peakEquity: cfg.bankroll,
      startedAt: now(),
      unacknowledgedKills: 0,
      promotedEligible: false,
    };
  }

  function isCrypto(platform: Platform): boolean {
    return platform === 'binance';
  }

  function positionKey(platform: Platform, marketId: string, outcome: string): string {
    return `${platform}:${marketId}:${outcome}`;
  }

  function findPosition(platform: Platform, marketId: string, outcome: string): ChallengePosition | undefined {
    return positions.find(
      (p) => positionKey(p.platform, p.marketId, p.outcome) === positionKey(platform, marketId, outcome)
    );
  }

  // ---------------------------------------------------------------------------
  // Pricing
  // ---------------------------------------------------------------------------

  function cryptoMarkPrice(symbol: string): { price: number | null; stale: boolean } {
    const data = deps.cryptoFeed.getPriceData(symbol);
    if (data) {
      const age = now() - data.timestamp.getTime();
      return { price: data.price, stale: age > cfg.staleTickMs };
    }
    const price = deps.cryptoFeed.getPrice(symbol);
    // No timestamp available: usable for marking, too risky for entries
    return { price, stale: true };
  }

  async function predictionBook(platform: Platform, marketId: string): Promise<{ book: Orderbook | null; stale: boolean }> {
    try {
      const book = await deps.feeds.getOrderbook(platform, marketId);
      if (!book) return { book: null, stale: true };
      const age = now() - book.timestamp;
      return { book, stale: age > cfg.staleBookMs };
    } catch (err) {
      logger.warn({ err, platform, marketId }, 'challenge: orderbook fetch failed');
      return { book: null, stale: true };
    }
  }

  function kalshiFee(price: number, qty: number): number {
    // Kalshi trading fee: ceil-free approximation of 0.07 * C * P * (1-P)
    return 0.07 * qty * price * (1 - price);
  }

  async function computeFill(
    signal: Signal,
    side: 'buy' | 'sell',
    usdSize: number,
    existingQty?: number
  ): Promise<FillComputation | { rejected: string }> {
    const platform = signal.platform;

    if (isCrypto(platform)) {
      const { price, stale } = cryptoMarkPrice(signal.marketId);
      if (price == null || price <= 0) return { rejected: 'no price available' };
      if (stale && side === 'buy') return { rejected: 'stale crypto price' };
      const slipMult = side === 'buy' ? 1 + cfg.cryptoSlippageBps / 10_000 : 1 - cfg.cryptoSlippageBps / 10_000;
      const fillPrice = price * slipMult;
      const qty = side === 'buy' ? usdSize / fillPrice : (existingQty ?? 0);
      const notional = qty * fillPrice;
      return {
        price: fillPrice,
        slippage: Math.abs(fillPrice - price) * qty,
        fee: notional * (cfg.cryptoFeeBps / 10_000),
        qty,
        stale,
      };
    }

    // Prediction market: walk the live orderbook
    const { book, stale } = await predictionBook(platform, signal.marketId);
    if (book && !(stale && side === 'buy')) {
      const levels = side === 'buy' ? book.asks : book.bids;
      const reference = side === 'buy' ? (book.asks[0]?.[0] ?? book.midPrice) : (book.bids[0]?.[0] ?? book.midPrice);
      const targetQty = side === 'buy'
        ? usdSize / Math.max(reference, 0.01)
        : (existingQty ?? 0);
      const { avgFillPrice, totalFilled } = calculateFillFromOrderbook(levels, targetQty, side);
      if (totalFilled <= 0) return { rejected: 'no orderbook liquidity' };
      const fee = platform === 'kalshi' ? kalshiFee(avgFillPrice, totalFilled) : 0;
      return {
        price: avgFillPrice,
        slippage: Math.abs(avgFillPrice - book.midPrice) * totalFilled,
        fee,
        qty: totalFilled,
        stale,
      };
    }

    // No (fresh) book
    if (side === 'buy') {
      return { rejected: stale ? 'stale/missing orderbook' : 'no orderbook' };
    }
    // Exits are always allowed: last known price with penalty slippage
    if (cfg.strictFills) return { rejected: 'no orderbook (strict fills)' };
    const lastKnown = signal.price ?? findPosition(platform, signal.marketId, signal.outcome)?.currentPrice;
    if (!lastKnown || lastKnown <= 0) return { rejected: 'no reference price for exit' };
    const fillPrice = lastKnown * (1 - cfg.fallbackSlippageBps / 10_000);
    const qty = existingQty ?? 0;
    return {
      price: fillPrice,
      slippage: Math.abs(fillPrice - lastKnown) * qty,
      fee: platform === 'kalshi' ? kalshiFee(fillPrice, qty) : 0,
      qty,
      stale: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Fills
  // ---------------------------------------------------------------------------

  function recordFill(fill: ChallengeFill): void {
    persistence.insertFill(fill);
    emitter.emit('fill', fill);
  }

  function toTrade(fill: ChallengeFill, question?: string): Trade {
    return {
      id: fill.id,
      platform: fill.platform,
      marketId: fill.marketId,
      marketQuestion: question,
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
      filledAt: new Date(fill.ts),
      meta: { paper: true, challengeId: cfg.id, sleeve: fill.sleeve, reason: fill.reason },
    };
  }

  async function openOrAdd(signal: Signal, strategyId: string, sleeve: SleeveId): Promise<Trade | null> {
    const sleeveState = state.sleeves[sleeve];
    const usdSize = signal.size ?? 0;
    if (usdSize <= 0) {
      logger.warn({ strategyId, signal }, 'challenge: buy signal without size rejected');
      return null;
    }

    const fill = await computeFill(signal, 'buy', usdSize);
    if ('rejected' in fill) {
      logger.warn({ strategyId, signal, reason: fill.rejected }, 'challenge: entry rejected by broker');
      emitter.emit('reject', { signal, strategyId, sleeve, reason: fill.rejected });
      return null;
    }

    const cost = fill.qty * fill.price;
    const totalCost = cost + fill.fee;
    if (totalCost > sleeveState.balance) {
      logger.warn({ strategyId, cost: totalCost, balance: sleeveState.balance }, 'challenge: insufficient sleeve balance');
      emitter.emit('reject', { signal, strategyId, sleeve, reason: 'insufficient balance' });
      return null;
    }

    sleeveState.balance -= totalCost;
    sleeveState.dailyTrades += 1;

    const meta = (signal.meta ?? {}) as Record<string, unknown>;
    const existing = findPosition(signal.platform, signal.marketId, signal.outcome);
    if (existing) {
      const newQty = existing.qty + fill.qty;
      existing.avgPrice = (existing.avgPrice * existing.qty + fill.price * fill.qty) / newQty;
      existing.qty = newQty;
      existing.costBasis += totalCost;
      existing.currentPrice = fill.price;
      if (typeof meta.stopPrice === 'number') existing.stopPrice = meta.stopPrice;
      if (typeof meta.takeProfitPrice === 'number') existing.takeProfitPrice = meta.takeProfitPrice;
      persistence.updatePosition(existing);
    } else {
      const pos: ChallengePosition = {
        id: randomUUID(),
        challengeId: cfg.id,
        sleeve,
        platform: signal.platform,
        marketId: signal.marketId,
        outcome: signal.outcome,
        qty: fill.qty,
        avgPrice: fill.price,
        costBasis: totalCost,
        currentPrice: fill.price,
        stopPrice: typeof meta.stopPrice === 'number' ? meta.stopPrice : undefined,
        takeProfitPrice: typeof meta.takeProfitPrice === 'number' ? meta.takeProfitPrice : undefined,
        trailDistance: typeof meta.trailDistance === 'number' ? meta.trailDistance : undefined,
        trailActivationPrice: typeof meta.trailActivationPrice === 'number' ? meta.trailActivationPrice : undefined,
        pairId: typeof meta.pairId === 'string' ? meta.pairId : undefined,
        strategyId,
        openedAt: now(),
        meta: signal.reason ? { reason: signal.reason } : undefined,
      };
      positions.push(pos);
      persistence.insertPosition(pos);
    }

    const record: ChallengeFill = {
      id: randomUUID(),
      challengeId: cfg.id,
      sleeve,
      platform: signal.platform,
      marketId: signal.marketId,
      outcome: signal.outcome,
      side: 'buy',
      qty: fill.qty,
      price: fill.price,
      fee: fill.fee,
      slippage: fill.slippage,
      reason: 'entry',
      strategyId,
      ts: now(),
    };
    recordFill(record);
    persistState();
    return toTrade(record);
  }

  async function closeInternal(pos: ChallengePosition, reason: CloseReason): Promise<Trade | null> {
    const signal: Signal = {
      type: 'close',
      platform: pos.platform,
      marketId: pos.marketId,
      outcome: pos.outcome,
      price: pos.currentPrice,
    };
    const fill = await computeFill(signal, 'sell', 0, pos.qty);
    if ('rejected' in fill) {
      logger.error({ positionId: pos.id, reason: fill.rejected }, 'challenge: CLOSE REJECTED - position stuck');
      emitter.emit('reject', { signal, strategyId: pos.strategyId, sleeve: pos.sleeve, reason: fill.rejected });
      return null;
    }

    const proceeds = fill.qty * fill.price - fill.fee;
    const realizedPnL = proceeds - pos.costBasis;
    const sleeveState = state.sleeves[pos.sleeve];
    sleeveState.balance += proceeds;
    sleeveState.realizedPnL += realizedPnL;
    sleeveState.dailyRealizedPnL += realizedPnL;

    positions = positions.filter((p) => p.id !== pos.id);
    persistence.deletePosition(pos.id);

    const record: ChallengeFill = {
      id: randomUUID(),
      challengeId: cfg.id,
      sleeve: pos.sleeve,
      platform: pos.platform,
      marketId: pos.marketId,
      outcome: pos.outcome,
      side: 'sell',
      qty: fill.qty,
      price: fill.price,
      fee: fill.fee,
      slippage: fill.slippage,
      realizedPnL,
      reason,
      strategyId: pos.strategyId,
      ts: now(),
    };
    recordFill(record);
    persistState();

    const trade = toTrade(record);
    emitter.emit('close', { position: pos, trade, reason, realizedPnL });
    if (reason === 'stop_loss' || reason === 'trailing_stop') {
      emitter.emit('stop_out', { position: pos, trade, reason, realizedPnL });
    }
    return trade;
  }

  // ---------------------------------------------------------------------------
  // Mark to market + stops
  // ---------------------------------------------------------------------------

  async function markPosition(pos: ChallengePosition): Promise<number> {
    if (isCrypto(pos.platform)) {
      const { price } = cryptoMarkPrice(pos.marketId);
      if (price != null && price > 0) pos.currentPrice = price;
    } else {
      const { book } = await predictionBook(pos.platform, pos.marketId);
      // Mark longs conservatively at best bid
      const bid = book?.bids?.[0]?.[0];
      if (bid != null && bid > 0) pos.currentPrice = bid;
    }
    return pos.currentPrice;
  }

  function stopTriggered(pos: ChallengePosition): CloseReason | null {
    const price = pos.currentPrice;
    if (pos.stopPrice != null && price <= pos.stopPrice) return 'stop_loss';
    if (pos.takeProfitPrice != null && price >= pos.takeProfitPrice) return 'take_profit';
    if (pos.trailDistance != null) {
      const activated = pos.trailHighWater != null
        || pos.trailActivationPrice == null
        || price >= pos.trailActivationPrice;
      if (activated) {
        pos.trailHighWater = Math.max(pos.trailHighWater ?? price, price);
        if (price <= pos.trailHighWater - pos.trailDistance) return 'trailing_stop';
      }
    }
    return null;
  }

  function sleeveEquity(sleeve: SleeveId): number {
    const positionsValue = positions
      .filter((p) => p.sleeve === sleeve)
      .reduce((sum, p) => sum + p.qty * p.currentPrice, 0);
    return state.sleeves[sleeve].balance + positionsValue;
  }

  emitter.markToMarket = async () => {
    const ts = now();
    for (const pos of [...positions]) {
      await markPosition(pos);
      const trigger = stopTriggered(pos);
      if (trigger) {
        await closeInternal(pos, trigger);
      } else {
        persistence.updatePosition(pos);
      }
    }

    const crypto = sleeveEquity('crypto');
    const prediction = sleeveEquity('prediction');
    const total = crypto + prediction;
    state.peakEquity = Math.max(state.peakEquity, total);
    const drawdownPct = state.peakEquity > 0 ? ((state.peakEquity - total) / state.peakEquity) * 100 : 0;

    persistence.insertEquityPoint(cfg.id, { ts, sleeve: 'crypto', equity: crypto, drawdownPct: 0 });
    persistence.insertEquityPoint(cfg.id, { ts, sleeve: 'prediction', equity: prediction, drawdownPct: 0 });
    persistence.insertEquityPoint(cfg.id, { ts, sleeve: 'total', equity: total, drawdownPct });

    state.lastMarkAt = ts;
    persistState();
    emitter.emit('equity', { ts, crypto, prediction, total, drawdownPct });
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  emitter.execute = async (signal, strategyId, sleeve) => {
    if (signal.type === 'hold') return null;
    if (signal.type === 'buy') return openOrAdd(signal, strategyId, sleeve);
    // 'sell' / 'close': close the whole matching position
    const pos = findPosition(signal.platform, signal.marketId, signal.outcome);
    if (!pos) {
      logger.warn({ strategyId, signal }, 'challenge: exit signal with no open position');
      return null;
    }
    return closeInternal(pos, 'signal_exit');
  };

  emitter.closePosition = async (positionId, reason) => {
    const pos = positions.find((p) => p.id === positionId);
    if (!pos) return null;
    await markPosition(pos);
    return closeInternal(pos, reason);
  };

  emitter.closeAll = async (reason) => {
    for (const pos of [...positions]) {
      await markPosition(pos);
      await closeInternal(pos, reason);
    }
  };

  emitter.getPortfolio = async (sleeve) => {
    const equity = sleeveEquity(sleeve);
    return {
      value: equity,
      balance: state.sleeves[sleeve].balance,
      positions: positions
        .filter((p) => p.sleeve === sleeve)
        .map((p) => ({
          platform: p.platform,
          marketId: p.marketId,
          outcome: p.outcome,
          shares: p.qty,
          avgPrice: p.avgPrice,
          currentPrice: p.currentPrice,
          stopPrice: p.stopPrice,
          pairId: p.pairId,
          openedAt: p.openedAt,
        })),
    };
  };

  emitter.getState = () => state;

  emitter.getSleeveState = (sleeve) => {
    const s = state.sleeves[sleeve];
    const equity = sleeveEquity(sleeve);
    return {
      balance: s.balance,
      equity,
      peakEquity: Math.max(equity, cfg.sleeves[sleeve].allocation),
      realizedPnL: s.realizedPnL,
      dailyRealizedPnL: s.dailyRealizedPnL,
      dailyTrades: s.dailyTrades,
      openPositions: positions.filter((p) => p.sleeve === sleeve).length,
    };
  };

  emitter.getOpenPositions = (sleeve) =>
    sleeve ? positions.filter((p) => p.sleeve === sleeve) : [...positions];

  emitter.totalEquity = () => sleeveEquity('crypto') + sleeveEquity('prediction');

  emitter.resume = () => {
    const loaded = persistence.loadState(cfg.id);
    if (loaded) {
      state = loaded;
      positions = persistence.listPositions(cfg.id);
      logger.info(
        { challengeId: cfg.id, status: state.status, positions: positions.length },
        'challenge: resumed from persistence'
      );
    } else {
      state = freshState();
      positions = [];
      persistState();
      logger.info({ challengeId: cfg.id, bankroll: cfg.bankroll }, 'challenge: fresh start');
    }
  };

  emitter.resetDaily = (day) => {
    state.sleeves.crypto.dailyRealizedPnL = 0;
    state.sleeves.crypto.dailyTrades = 0;
    state.sleeves.prediction.dailyRealizedPnL = 0;
    state.sleeves.prediction.dailyTrades = 0;
    state.lastDailyResetDay = day;
    if (state.status === 'halted_daily') {
      state.status = 'running';
      state.statusReason = undefined;
    }
    persistState();
  };

  emitter.reset = () => {
    for (const pos of positions) persistence.deletePosition(pos.id);
    positions = [];
    state = freshState();
    persistState();
  };

  function persistState(): void {
    persistence.saveState(state);
  }
  emitter.persistState = persistState;

  return emitter;
}
