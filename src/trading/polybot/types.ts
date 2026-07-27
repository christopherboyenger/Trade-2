/**
 * PolyBot types — Polymarket auto-trader that fuses whale-follow and spot
 * momentum signals, gates them by confidence, and records a decision trace
 * for every candidate (signal → gate → exec).
 *
 * The engine is dependency-injected and clock-injected so the whole decision
 * path is unit-testable without any network (see engine.ts).
 */

export type SignalKind = 'whale' | 'momentum';

/** A tradeable side on a Polymarket binary market. */
export type MarketSide = 'YES' | 'NO' | 'UP' | 'DOWN';

export interface CandidateSignal {
  kind: SignalKind;
  marketId: string;
  tokenId: string;
  /** Short human label, e.g. "btc-up-or-do" or "man-city-win". */
  label: string;
  side: MarketSide;
  /** Current price of the side being bought (0..1). */
  price: number;
  /** 0..1 model confidence. */
  confidence: number;
  /** Bid/ask spread in cents, when known. */
  spreadCents?: number;
  /** 15-minute (or other windowed) markets settle at this ms epoch. */
  expiresAt?: number;
  /** Negative-risk market flag (crypto 15-min markets). */
  negRisk?: boolean;
  /** One-line origin description, e.g. "whale $23,000 YES conf 0.56". */
  detail: string;
}

export interface GateResult {
  passed: boolean;
  /** Name of the failing gate when passed=false. */
  gate?: string;
  /** Human reason, e.g. "spread 7c > max 4c". */
  reason?: string;
}

export interface DecisionTrace {
  ts: number;
  label: string;
  kind: SignalKind;
  /** Confidence as 0..100 for display parity with the reel. */
  conf: number;
  outcome: 'placed' | 'skip';
  reason: string;
}

export interface TradeLogLine {
  ts: number;
  /** Source tag: backend | trader | whale | momentum. */
  tag: 'backend' | 'trader' | 'whale' | 'momentum';
  text: string;
}

export interface PolybotPosition {
  id: string;
  marketId: string;
  tokenId: string;
  label: string;
  kind: SignalKind;
  side: MarketSide;
  entryPrice: number;
  shares: number;
  costUsd: number;
  openedAt: number;
  expiresAt?: number;
  /** Latest observed price for mark-to-market. */
  markPrice: number;
}

export interface ClosedTrade {
  id: string;
  label: string;
  kind: SignalKind;
  side: MarketSide;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnlUsd: number;
  openedAt: number;
  closedAt: number;
  exitReason: 'tp' | 'sl' | 'settled' | 'manual' | 'stopped';
}

export interface FillMarker {
  ts: number;
  label: string;
  /** win | loss | pending — rendered as the "last 10 fills" squares. */
  result: 'win' | 'loss' | 'pending';
}

export interface FeedHealthEntry {
  source: string;
  lastBeatMs: number | null;
  live: boolean;
}

export interface DiagnosticCheck {
  label: string;
  ok: boolean;
  note: string;
}

export interface SessionStats {
  startedAt: number;
  startBalanceUsd: number;
  /** Realized + mark-to-market. */
  sessionPnlUsd: number;
  realizedPnlUsd: number;
  dailyPnlUsd: number;
  wins: number;
  losses: number;
  winRate: number;
  openPositions: number;
  signalsPerMin: number;
  tradesPerHr: number;
  marketsScanned: number;
  whalesSeen: number;
  momentumSeen: number;
  /** Equity curve samples: [ts, sessionPnlUsd]. */
  equityCurve: Array<[number, number]>;
}

export interface PolybotConfig {
  /** Master switch — when off, every candidate is gated. */
  masterSwitch: boolean;
  /** Paper trading by default; live requires an ExecutionService. */
  live: boolean;
  startBalanceUsd: number;
  /** $ per trade. */
  tradeSizeUsd: number;
  maxConcurrentPositions: number;
  maxExposureUsd: number;
  maxDailyLossUsd: number;
  /** Confidence floor 0..1. */
  minConfidence: number;
  /** Reject entries when spread exceeds this many cents. */
  maxSpreadCents: number;
  /** Only buy sides priced within this band. */
  minEntryPrice: number;
  maxEntryPrice: number;
  /** Per-market cooldown between entries. */
  cooldownSec: number;
  /** Take-profit / stop-loss in cents of price move. */
  takeProfitCents: number;
  stopLossCents: number;
  /** Spot move (%) over the momentum window that triggers a signal. */
  momentumThresholdPct: number;
  momentumWindowSec: number;
  /** Whale trades below this $ value are ignored. */
  minWhaleUsd: number;
  /** Feeds older than this are reported stale. */
  feedStaleMs: number;
}

export const DEFAULT_POLYBOT_CONFIG: PolybotConfig = {
  masterSwitch: true,
  live: false,
  startBalanceUsd: 1000,
  tradeSizeUsd: 25,
  maxConcurrentPositions: 25,
  maxExposureUsd: 500,
  maxDailyLossUsd: 100,
  minConfidence: 0.6,
  maxSpreadCents: 4,
  minEntryPrice: 0.05,
  maxEntryPrice: 0.85,
  cooldownSec: 30,
  takeProfitCents: 10,
  stopLossCents: 15,
  momentumThresholdPct: 0.12,
  momentumWindowSec: 30,
  minWhaleUsd: 10000,
  feedStaleMs: 60_000,
};
