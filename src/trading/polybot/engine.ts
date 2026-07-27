/**
 * PolyBot engine — whale + momentum signal fusion with confidence gating.
 *
 * Data flows IN through plain methods (onWhaleTrade, onSpotTick,
 * setActiveMarkets, updateMarketPrice) so the skill can wire live feeds while
 * tests drive the engine with fixtures and a fake clock. Every candidate
 * passes the same gate chain and lands in the decision trace, placed or not —
 * the reel's "signal → gate → exec" stream.
 *
 * Paper mode simulates fills locally against the tracked balance. Live mode
 * routes through the shared ExecutionService when one is provided.
 */

import type { WhaleTrade } from '../../feeds/polymarket/whale-tracker.js';
import type { ExecutionService } from '../../execution/index.js';
import { logger } from '../../utils/logger.js';
import type {
  CandidateSignal,
  ClosedTrade,
  DecisionTrace,
  DiagnosticCheck,
  FeedHealthEntry,
  FillMarker,
  GateResult,
  MarketSide,
  PolybotConfig,
  PolybotPosition,
  SessionStats,
  SignalKind,
  TradeLogLine,
} from './types.js';
import { DEFAULT_POLYBOT_CONFIG } from './types.js';

const TRACE_LIMIT = 200;
const LOG_LIMIT = 300;
const FILL_LIMIT = 10;
const EQUITY_LIMIT = 500;
const SIGNAL_WINDOW_MS = 60_000;
const TRADE_WINDOW_MS = 3_600_000;

/** A market PolyBot is allowed to trade, provided by the market scanner. */
export interface PolybotMarket {
  marketId: string;
  label: string;
  /** For 15m crypto markets: the underlying asset symbol (BTC, ETH…). */
  asset?: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  expiresAt?: number;
  negRisk?: boolean;
}

export interface PolybotDeps {
  now?: () => number;
  execution?: ExecutionService | null;
}

export interface PolybotEngine {
  start(): void;
  stop(): void;
  isRunning(): boolean;

  // ── data intake (wired to live feeds by the skill, to fixtures by tests) ──
  onWhaleTrade(trade: WhaleTrade): void;
  onSpotTick(asset: string, price: number): void;
  setActiveMarkets(markets: PolybotMarket[]): void;
  updateMarketPrice(marketId: string, yesPrice: number, noPrice: number): void;
  /** Record a data-source heartbeat for feed-health reporting. */
  beat(source: string): void;

  // ── introspection (the dashboard panels) ──
  getConfig(): PolybotConfig;
  updateConfig(patch: Partial<PolybotConfig>): void;
  getStats(): SessionStats;
  getPositions(): PolybotPosition[];
  getClosed(): ClosedTrade[];
  getTrace(limit?: number): DecisionTrace[];
  getLog(limit?: number): TradeLogLine[];
  getFills(): FillMarker[];
  getFeedHealth(): FeedHealthEntry[];
  getDiagnostics(): DiagnosticCheck[];

  /** Exposed for tests: run one candidate through gates + execution. */
  submitCandidate(signal: CandidateSignal): GateResult;
}

/**
 * Gate chain — pure. First failing gate wins; its name/reason land in the
 * decision trace exactly as the reel logs them ("skip: spread 7c > max 4c").
 */
export function evaluateGates(
  signal: CandidateSignal,
  state: {
    openPositions: number;
    openExposureUsd: number;
    dailyPnlUsd: number;
    lastEntryAtByMarket: Map<string, number>;
    hasPositionInMarket: boolean;
    nowMs: number;
  },
  cfg: PolybotConfig
): GateResult {
  if (!cfg.masterSwitch) {
    return { passed: false, gate: 'master', reason: 'master switch is OFF' };
  }
  if (signal.confidence < cfg.minConfidence) {
    return {
      passed: false,
      gate: 'confidence',
      reason: `conf ${signal.confidence.toFixed(2)} < floor ${cfg.minConfidence.toFixed(2)}`,
    };
  }
  if (signal.price > cfg.maxEntryPrice || signal.price < cfg.minEntryPrice) {
    return {
      passed: false,
      gate: 'price-band',
      reason: `price ${(signal.price * 100).toFixed(0)}c outside ${cfg.minEntryPrice * 100}-${cfg.maxEntryPrice * 100}c band`,
    };
  }
  if (signal.spreadCents !== undefined && signal.spreadCents > cfg.maxSpreadCents) {
    return {
      passed: false,
      gate: 'spread',
      reason: `spread ${signal.spreadCents}c > max ${cfg.maxSpreadCents}c`,
    };
  }
  if (signal.expiresAt !== undefined && signal.expiresAt <= state.nowMs) {
    return { passed: false, gate: 'window', reason: 'outside window' };
  }
  if (state.hasPositionInMarket) {
    return { passed: false, gate: 'duplicate', reason: 'already positioned in market' };
  }
  const lastEntry = state.lastEntryAtByMarket.get(signal.marketId);
  if (lastEntry !== undefined && state.nowMs - lastEntry < cfg.cooldownSec * 1000) {
    return { passed: false, gate: 'cooldown', reason: `cooldown ${cfg.cooldownSec}s active` };
  }
  if (state.openPositions >= cfg.maxConcurrentPositions) {
    return {
      passed: false,
      gate: 'positions',
      reason: `open positions at cap ${cfg.maxConcurrentPositions}`,
    };
  }
  if (state.openExposureUsd + cfg.tradeSizeUsd > cfg.maxExposureUsd) {
    return {
      passed: false,
      gate: 'exposure',
      reason: `exposure $${(state.openExposureUsd + cfg.tradeSizeUsd).toFixed(0)} > cap $${cfg.maxExposureUsd}`,
    };
  }
  if (state.dailyPnlUsd <= -cfg.maxDailyLossUsd) {
    return {
      passed: false,
      gate: 'daily-loss',
      reason: `daily loss $${Math.abs(state.dailyPnlUsd).toFixed(0)} hit cap $${cfg.maxDailyLossUsd}`,
    };
  }
  return { passed: true };
}

/** Whale-follow confidence: bigger prints and cheaper entries score higher. */
export function whaleConfidence(usdValue: number, minWhaleUsd: number, price: number): number {
  if (usdValue < minWhaleUsd || minWhaleUsd <= 0) return 0;
  let conf = 0.5 + Math.log10(usdValue / minWhaleUsd) * 0.15;
  if (price < 0.6) conf += 0.05; // room to run
  return Math.min(0.95, Math.max(0, conf));
}

/** Momentum confidence: scaled by how far past the threshold the move is. */
export function momentumConfidence(movePct: number, thresholdPct: number): number {
  const magnitude = Math.abs(movePct);
  if (thresholdPct <= 0 || magnitude < thresholdPct) return 0;
  const conf = 0.55 + (magnitude / thresholdPct - 1) * 0.15;
  return Math.min(0.95, conf);
}

export function createPolybotEngine(
  config: Partial<PolybotConfig> = {},
  deps: PolybotDeps = {}
): PolybotEngine {
  const cfg: PolybotConfig = { ...DEFAULT_POLYBOT_CONFIG, ...config };
  const now = deps.now ?? Date.now;
  const execution = deps.execution ?? null;

  let running = false;
  let startedAt = 0;
  let nextId = 1;

  const positions = new Map<string, PolybotPosition>();
  const closed: ClosedTrade[] = [];
  const trace: DecisionTrace[] = [];
  const log: TradeLogLine[] = [];
  const fills: FillMarker[] = [];
  const equityCurve: Array<[number, number]> = [];
  const signalTimestamps: number[] = [];
  const tradeTimestamps: number[] = [];
  const lastEntryAtByMarket = new Map<string, number>();
  const feedBeats = new Map<string, number>();
  const spotHistory = new Map<string, Array<{ ts: number; price: number }>>();
  const lastMomentumFire = new Map<string, number>();

  let activeMarkets: PolybotMarket[] = [];
  let marketsScannedTotal = 0;
  let whalesSeen = 0;
  let momentumSeen = 0;
  let realizedPnlUsd = 0;

  function pushRing<T>(arr: T[], item: T, limit: number): void {
    arr.push(item);
    if (arr.length > limit) arr.splice(0, arr.length - limit);
  }

  function addLog(tag: TradeLogLine['tag'], text: string): void {
    pushRing(log, { ts: now(), tag, text }, LOG_LIMIT);
  }

  function openExposureUsd(): number {
    let sum = 0;
    for (const p of positions.values()) sum += p.costUsd;
    return sum;
  }

  function markToMarketPnl(): number {
    let sum = 0;
    for (const p of positions.values()) {
      sum += (p.markPrice - p.entryPrice) * p.shares;
    }
    return sum;
  }

  function sessionPnl(): number {
    return realizedPnlUsd + markToMarketPnl();
  }

  function recordEquity(): void {
    pushRing(equityCurve, [now(), sessionPnl()], EQUITY_LIMIT);
  }

  function recordTrace(signal: CandidateSignal, outcome: 'placed' | 'skip', reason: string): void {
    pushRing(
      trace,
      {
        ts: now(),
        label: signal.label,
        kind: signal.kind,
        conf: Math.round(signal.confidence * 100),
        outcome,
        reason,
      },
      TRACE_LIMIT
    );
  }

  function closePosition(p: PolybotPosition, exitPrice: number, exitReason: ClosedTrade['exitReason']): void {
    positions.delete(p.id);
    const pnl = (exitPrice - p.entryPrice) * p.shares;
    realizedPnlUsd += pnl;
    const record: ClosedTrade = {
      id: p.id,
      label: p.label,
      kind: p.kind,
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice,
      shares: p.shares,
      pnlUsd: pnl,
      openedAt: p.openedAt,
      closedAt: now(),
      exitReason,
    };
    closed.push(record);
    pushRing(fills, { ts: now(), label: p.label, result: pnl >= 0 ? 'win' : 'loss' }, FILL_LIMIT);
    addLog('trader', `closed ${p.label} ${p.side} @ ${exitPrice.toFixed(2)} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}) ${exitReason}`);
    recordEquity();
  }

  function place(signal: CandidateSignal): void {
    const shares = cfg.tradeSizeUsd / Math.max(0.01, signal.price);
    const position: PolybotPosition = {
      id: `pb-${nextId++}`,
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      label: signal.label,
      kind: signal.kind,
      side: signal.side,
      entryPrice: signal.price,
      shares,
      costUsd: cfg.tradeSizeUsd,
      openedAt: now(),
      expiresAt: signal.expiresAt,
      markPrice: signal.price,
    };
    positions.set(position.id, position);
    lastEntryAtByMarket.set(signal.marketId, now());
    pushRing(tradeTimestamps, now(), 10_000);
    addLog('trader', `place ${signal.side} ${shares.toFixed(0)}@${signal.price.toFixed(2)} ${signal.label} [${signal.kind}]`);
    recordEquity();

    if (cfg.live && execution) {
      execution
        .marketBuy({
          platform: 'polymarket',
          marketId: signal.marketId,
          tokenId: signal.tokenId,
          size: shares,
          negRisk: signal.negRisk,
        })
        .then((res) => {
          if (!res.success) addLog('trader', `LIVE order failed ${signal.label}: ${res.error ?? 'unknown'}`);
        })
        .catch((err) => {
          logger.error({ err }, 'polybot live order error');
          addLog('trader', `LIVE order error ${signal.label}`);
        });
    }
  }

  function submitCandidate(signal: CandidateSignal): GateResult {
    if (!running) return { passed: false, gate: 'engine', reason: 'engine not running' };
    pushRing(signalTimestamps, now(), 10_000);

    let hasPositionInMarket = false;
    for (const p of positions.values()) {
      if (p.marketId === signal.marketId) {
        hasPositionInMarket = true;
        break;
      }
    }

    const result = evaluateGates(
      signal,
      {
        openPositions: positions.size,
        openExposureUsd: openExposureUsd(),
        dailyPnlUsd: sessionPnl(),
        lastEntryAtByMarket,
        hasPositionInMarket,
        nowMs: now(),
      },
      cfg
    );

    if (result.passed) {
      recordTrace(signal, 'placed', 'placed');
      place(signal);
    } else {
      recordTrace(signal, 'skip', result.reason ?? result.gate ?? 'gated');
      addLog('trader', `skip: ${result.reason} (${signal.label})`);
    }
    return result;
  }

  function checkExits(p: PolybotPosition): void {
    const tp = p.entryPrice + cfg.takeProfitCents / 100;
    const sl = p.entryPrice - cfg.stopLossCents / 100;
    if (p.markPrice >= tp) closePosition(p, p.markPrice, 'tp');
    else if (p.markPrice <= sl) closePosition(p, p.markPrice, 'sl');
    else if (p.expiresAt !== undefined && now() >= p.expiresAt) {
      // Windowed binary settlement: side worth $1 when it finishes in the
      // money, else $0. The final mark is the best local proxy for paper mode.
      closePosition(p, p.markPrice >= 0.5 ? 1 : 0, 'settled');
    }
  }

  function beat(source: string): void {
    feedBeats.set(source, now());
  }

  function start(): void {
    if (running) return;
    running = true;
    startedAt = now();
    addLog('backend', `engine online · ${cfg.live && execution ? 'LIVE' : 'PAPER'} · size $${cfg.tradeSizeUsd}`);
    recordEquity();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    for (const p of [...positions.values()]) closePosition(p, p.markPrice, 'stopped');
    addLog('backend', 'engine stopped');
  }

  function onWhaleTrade(trade: WhaleTrade): void {
    if (!running) return;
    beat('whale.ws');
    if (trade.side !== 'BUY' || trade.usdValue < cfg.minWhaleUsd) return;
    whalesSeen++;

    const label = (trade.marketQuestion ?? trade.marketId)
      .toLowerCase()
      .slice(0, 12)
      .trim()
      .replace(/\s+/g, '-');
    const confidence = whaleConfidence(trade.usdValue, cfg.minWhaleUsd, trade.price);
    addLog(
      'whale',
      `$${trade.usdValue.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${trade.outcome.toUpperCase()} ${label} conf ${confidence.toFixed(2)}`
    );
    submitCandidate({
      kind: 'whale',
      marketId: trade.marketId,
      tokenId: trade.tokenId,
      label,
      side: trade.outcome === 'Yes' ? 'YES' : 'NO',
      price: trade.price,
      confidence,
      detail: `whale $${trade.usdValue.toFixed(0)} ${trade.outcome} @ ${trade.price.toFixed(2)}`,
    });
  }

  function onSpotTick(asset: string, price: number): void {
    if (!running) return;
    beat('crypto.ws');
    const history = spotHistory.get(asset) ?? [];
    history.push({ ts: now(), price });
    const cutoff = now() - cfg.momentumWindowSec * 1000 * 2;
    while (history.length > 0 && history[0].ts < cutoff) history.shift();
    spotHistory.set(asset, history);

    const windowStart = now() - cfg.momentumWindowSec * 1000;
    const past = history.find((h) => h.ts >= windowStart);
    if (!past || past.price <= 0) return;
    const movePct = ((price - past.price) / past.price) * 100;
    const confidence = momentumConfidence(movePct, cfg.momentumThresholdPct);
    if (confidence === 0) return;

    // One momentum candidate per market per window, not per tick.
    const market = activeMarkets.find((m) => m.asset === asset && (m.expiresAt ?? Infinity) > now());
    if (!market) return;
    const lastFire = lastMomentumFire.get(market.marketId);
    if (lastFire !== undefined && now() - lastFire < cfg.momentumWindowSec * 1000) return;
    lastMomentumFire.set(market.marketId, now());
    momentumSeen++;

    const up = movePct > 0;
    addLog(
      'momentum',
      `${asset}-USD ${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}% over ${cfg.momentumWindowSec}s conf ${confidence.toFixed(2)}`
    );
    submitCandidate({
      kind: 'momentum',
      marketId: market.marketId,
      tokenId: up ? market.yesTokenId : market.noTokenId,
      label: market.label,
      side: up ? 'UP' : 'DOWN',
      price: up ? market.yesPrice : market.noPrice,
      confidence,
      expiresAt: market.expiresAt,
      negRisk: market.negRisk,
      detail: `momentum ${asset} ${movePct.toFixed(2)}%/${cfg.momentumWindowSec}s`,
    });
  }

  function setActiveMarkets(markets: PolybotMarket[]): void {
    activeMarkets = markets;
    marketsScannedTotal += markets.length;
    beat('gamma.rest');
  }

  function updateMarketPrice(marketId: string, yesPrice: number, noPrice: number): void {
    for (const m of activeMarkets) {
      if (m.marketId === marketId) {
        m.yesPrice = yesPrice;
        m.noPrice = noPrice;
      }
    }
    for (const p of [...positions.values()]) {
      if (p.marketId !== marketId) continue;
      p.markPrice = p.side === 'YES' || p.side === 'UP' ? yesPrice : noPrice;
      checkExits(p);
    }
    recordEquity();
  }

  function getStats(): SessionStats {
    const nowMs = now();
    const signalsPerMin = signalTimestamps.filter((t) => nowMs - t <= SIGNAL_WINDOW_MS).length;
    const tradesPerHr = tradeTimestamps.filter((t) => nowMs - t <= TRADE_WINDOW_MS).length;
    const wins = closed.filter((c) => c.pnlUsd >= 0).length;
    const losses = closed.length - wins;
    return {
      startedAt,
      startBalanceUsd: cfg.startBalanceUsd,
      sessionPnlUsd: sessionPnl(),
      realizedPnlUsd,
      dailyPnlUsd: sessionPnl(),
      wins,
      losses,
      winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
      openPositions: positions.size,
      signalsPerMin,
      tradesPerHr,
      marketsScanned: marketsScannedTotal,
      whalesSeen,
      momentumSeen,
      equityCurve: [...equityCurve],
    };
  }

  function getFeedHealth(): FeedHealthEntry[] {
    const sources = ['crypto.ws', 'whale.ws', 'gamma.rest', 'account.snap'];
    const nowMs = now();
    return sources.map((source) => {
      const lastBeatMs = feedBeats.get(source) ?? null;
      return {
        source,
        lastBeatMs,
        live: lastBeatMs !== null && nowMs - lastBeatMs <= cfg.feedStaleMs,
      };
    });
  }

  function getDiagnostics(): DiagnosticCheck[] {
    const stats = getStats();
    const health = getFeedHealth();
    const anyFeedLive = health.some((h) => h.live);
    return [
      { label: 'Engine running', ok: running, note: running ? 'engine online' : 'start with /polybot start' },
      {
        label: 'Master switch',
        ok: cfg.masterSwitch,
        note: cfg.masterSwitch ? 'trading enabled' : 'master switch is OFF — /polybot config --master on',
      },
      {
        label: 'Execution mode',
        ok: true,
        note: cfg.live && execution ? 'LIVE via execution service' : 'paper mode (no real orders)',
      },
      {
        label: 'Daily stop',
        ok: stats.dailyPnlUsd > -cfg.maxDailyLossUsd,
        note:
          stats.dailyPnlUsd > -cfg.maxDailyLossUsd
            ? `$${stats.dailyPnlUsd.toFixed(2)} vs -$${cfg.maxDailyLossUsd} cap`
            : 'daily loss cap hit — trading halted for the session',
      },
      {
        label: 'Position capacity',
        ok: stats.openPositions < cfg.maxConcurrentPositions,
        note: `${stats.openPositions}/${cfg.maxConcurrentPositions} open`,
      },
      {
        label: 'Feeds',
        ok: anyFeedLive,
        note: health.map((h) => `${h.source}:${h.live ? 'LIVE' : 'stale'}`).join(' '),
      },
      {
        label: 'Markets available',
        ok: activeMarkets.length > 0,
        note: `${activeMarkets.length} active markets in rotation`,
      },
    ];
  }

  return {
    start,
    stop,
    isRunning: () => running,
    onWhaleTrade,
    onSpotTick,
    setActiveMarkets,
    updateMarketPrice,
    beat,
    getConfig: () => ({ ...cfg }),
    updateConfig(patch: Partial<PolybotConfig>) {
      Object.assign(cfg, patch);
      addLog('backend', `config updated: ${Object.keys(patch).join(', ')}`);
    },
    getStats,
    getPositions: () => [...positions.values()],
    getClosed: () => [...closed],
    getTrace: (limit = 20) => trace.slice(-limit),
    getLog: (limit = 30) => log.slice(-limit),
    getFills: () => [...fills],
    getFeedHealth,
    getDiagnostics,
    submitCandidate,
  };
}
