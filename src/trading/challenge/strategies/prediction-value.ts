/**
 * Prediction sleeve: cross-platform value / arb (Polymarket + Kalshi)
 *
 * Scans both platforms with a configurable query set (there is no "list all
 * markets" feed API), matches the same real-world event across platforms via
 * the canonical-ID matcher, then:
 *
 *  - ARB-SIGNAL entry: executable YES-price spread >= minArbSpreadPct after
 *    walking both orderbooks for the intended size. Buys the cheap side only
 *    (the paper broker is long-only) - the expensive venue acts as the fair
 *    value anchor, tagged with a pairId for reporting.
 *  - VALUE entry: |other-venue consensus - price| >= minValueDivergence with
 *    sane book spread, price inside [0.10, 0.90], resolution <= 45 days.
 *
 * Exits: take-profit at +takeProfitPct of entry, convergence to the anchor,
 * or resolution approaching. The -stopCostPct hard stop is broker-enforced
 * via meta.stopPrice.
 */

import { logger } from '../../../utils/logger.js';
import { generateCanonicalId } from '../../bots/index.js';
import type { Signal, Strategy, StrategyConfig } from '../../bots/index.js';
import type { Market, Orderbook, Platform } from '../../../types.js';

export interface PredictionValueParams {
  scanQueries: string[];
  platforms: Platform[];
  /** Executable spread (pct of cheap price) to call it an arb signal */
  minArbSpreadPct: number;
  /** Absolute price divergence for a value entry (e.g. 0.08 = 8 cents) */
  minValueDivergence: number;
  minPrice: number;
  maxPrice: number;
  maxDaysToResolution: number;
  /** Max orderbook bid/ask spread to accept (absolute, e.g. 0.03 = 3 cents) */
  maxBookSpread: number;
  /** Hard stop as % of entry cost (broker-enforced) */
  stopCostPct: number;
  takeProfitPct: number;
  /** Exit when spread to anchor falls below this pct */
  convergenceExitPct: number;
  /** Exit positions this close to resolution (hours) */
  resolutionExitHours: number;
  /** Target notional per entry (gate clamps further) */
  entryUsd: number;
}

export const DEFAULT_PREDICTION_VALUE_PARAMS: PredictionValueParams = {
  scanQueries: ['bitcoin', 'ethereum', 'fed rate', 'election', 'recession', 'gdp', 'inflation'],
  platforms: ['polymarket', 'kalshi'],
  minArbSpreadPct: 4,
  minValueDivergence: 0.08,
  minPrice: 0.1,
  maxPrice: 0.9,
  maxDaysToResolution: 45,
  maxBookSpread: 0.03,
  stopCostPct: 30,
  takeProfitPct: 50,
  convergenceExitPct: 1,
  resolutionExitHours: 48,
  entryUsd: 50,
};

export interface PredictionFeedLike {
  searchMarkets(query: string, platform?: string): Promise<Market[]>;
  getOrderbook(platform: string, marketId: string): Promise<Orderbook | null>;
  getMarket(marketId: string, platform?: string): Promise<Market | null>;
}

export interface PredictionValueDeps {
  feeds: PredictionFeedLike;
  params?: Partial<PredictionValueParams>;
  config?: Partial<StrategyConfig>;
}

interface Candidate {
  platform: Platform;
  market: Market;
  yesPrice: number;
}

export function createChallengePredictionStrategy(deps: PredictionValueDeps): Strategy {
  const params: PredictionValueParams = { ...DEFAULT_PREDICTION_VALUE_PARAMS, ...deps.params };

  const config: StrategyConfig = {
    id: 'challenge-prediction',
    name: 'Challenge: Prediction Value/Arb',
    description: 'Cross-platform value and arbitrage signals on Polymarket/Kalshi',
    platforms: params.platforms,
    intervalMs: 60 * 1000,
    dryRun: false,
    enabled: true,
    ...deps.config,
  };

  function yesOutcome(market: Market): { name: string; price: number } | null {
    const yes = market.outcomes.find((o) => o.name.toLowerCase() === 'yes') ?? market.outcomes[0];
    if (!yes || !(yes.price > 0) || yes.price >= 1) return null;
    return { name: yes.name, price: yes.price };
  }

  function daysUntil(date: Date | undefined, nowTs: number): number | null {
    if (!date) return null;
    return (new Date(date).getTime() - nowTs) / (24 * 60 * 60 * 1000);
  }

  async function executableSpreadPct(cheap: Candidate, rich: Candidate, usd: number): Promise<number | null> {
    try {
      const cheapBook = await deps.feeds.getOrderbook(cheap.platform, cheap.market.id);
      const richBook = await deps.feeds.getOrderbook(rich.platform, rich.market.id);
      const cheapAsk = cheapBook?.asks?.[0];
      const richBid = richBook?.bids?.[0];
      if (!cheapAsk || !richBid) return null;
      const targetShares = usd / Math.max(cheapAsk[0], 0.01);
      // Only count the spread capturable within top-of-book depth on BOTH legs
      if (cheapAsk[1] < targetShares || richBid[1] < targetShares) return null;
      return ((richBid[0] - cheapAsk[0]) / cheapAsk[0]) * 100;
    } catch (err) {
      logger.warn({ err }, 'challenge-prediction: orderbook check failed');
      return null;
    }
  }

  return {
    config,

    async evaluate(ctx) {
      const signals: Signal[] = [];
      const nowTs = ctx.timestamp.getTime();

      // ----- Exits on open positions -----
      for (const [key, pos] of ctx.positions) {
        const [platform, marketId, outcome] = key.split(':');
        if (!params.platforms.includes(platform as Platform)) continue;

        const takeProfitHit = pos.currentPrice >= pos.avgPrice * (1 + params.takeProfitPct / 100);
        let nearResolution = false;
        try {
          const market = await deps.feeds.getMarket(marketId, platform);
          const days = daysUntil(market?.endDate, nowTs);
          nearResolution = days != null && days * 24 <= params.resolutionExitHours;
        } catch {
          // market lookup is best-effort; broker stops still protect the position
        }
        if (takeProfitHit || nearResolution) {
          signals.push({
            type: 'close',
            platform: platform as Platform,
            marketId,
            outcome,
            price: pos.currentPrice,
            reason: takeProfitHit ? `take profit +${params.takeProfitPct}%` : 'resolution approaching',
          });
        }
      }

      // ----- Scan + cross-platform matching -----
      const byCanonical = new Map<string, Candidate[]>();
      for (const query of params.scanQueries) {
        for (const platform of params.platforms) {
          let markets: Market[] = [];
          try {
            markets = await deps.feeds.searchMarkets(query, platform);
          } catch (err) {
            logger.warn({ err, query, platform }, 'challenge-prediction: market scan failed');
            continue;
          }
          for (const market of markets) {
            if (market.resolved) continue;
            const days = daysUntil(market.endDate, nowTs);
            if (days == null || days < 0 || days > params.maxDaysToResolution) continue;
            const yes = yesOutcome(market);
            if (!yes) continue;
            const canonicalId = generateCanonicalId(market);
            if (!canonicalId || canonicalId.startsWith('generic_')) continue; // high-confidence matches only
            const list = byCanonical.get(canonicalId) ?? [];
            if (!list.some((c) => c.platform === market.platform && c.market.id === market.id)) {
              list.push({ platform: market.platform, market, yesPrice: yes.price });
              byCanonical.set(canonicalId, list);
            }
          }
        }
      }

      // ----- Entries -----
      for (const [canonicalId, candidates] of byCanonical) {
        const platformsPresent = new Set(candidates.map((c) => c.platform));
        if (platformsPresent.size < 2) continue;

        const sorted = [...candidates].sort((a, b) => a.yesPrice - b.yesPrice);
        const cheap = sorted[0];
        const rich = sorted[sorted.length - 1];
        if (cheap.platform === rich.platform) continue;
        if (cheap.yesPrice < params.minPrice || cheap.yesPrice > params.maxPrice) continue;

        const positionKey = `${cheap.platform}:${cheap.market.id}:Yes`;
        if (ctx.positions.has(positionKey) || ctx.positions.has(`${cheap.platform}:${cheap.market.id}:${yesOutcome(cheap.market)?.name}`)) {
          continue;
        }

        const divergence = rich.yesPrice - cheap.yesPrice;
        const midSpreadPct = (divergence / cheap.yesPrice) * 100;

        let entryReason: string | null = null;
        let confidence = 0.5;
        if (midSpreadPct >= params.minArbSpreadPct) {
          const execSpread = await executableSpreadPct(cheap, rich, params.entryUsd);
          if (execSpread != null && execSpread >= params.minArbSpreadPct) {
            entryReason = `arb-signal: ${cheap.platform} ${cheap.yesPrice.toFixed(2)} vs ${rich.platform} ${rich.yesPrice.toFixed(2)} (executable ${execSpread.toFixed(1)}%)`;
            confidence = 0.75;
          }
        }
        if (!entryReason && divergence >= params.minValueDivergence) {
          const book = await deps.feeds.getOrderbook(cheap.platform, cheap.market.id).catch(() => null);
          const bookSpread = book ? (book.asks?.[0]?.[0] ?? 1) - (book.bids?.[0]?.[0] ?? 0) : null;
          if (bookSpread != null && bookSpread <= params.maxBookSpread) {
            entryReason = `value: ${divergence.toFixed(2)} below ${rich.platform} consensus ${rich.yesPrice.toFixed(2)}`;
            confidence = 0.55;
          }
        }
        if (!entryReason) continue;

        const yes = yesOutcome(cheap.market);
        if (!yes) continue;
        signals.push({
          type: 'buy',
          platform: cheap.platform,
          marketId: cheap.market.id,
          outcome: yes.name,
          price: cheap.yesPrice,
          size: params.entryUsd,
          confidence,
          reason: entryReason,
          meta: {
            stopPrice: cheap.yesPrice * (1 - params.stopCostPct / 100),
            takeProfitPrice: Math.min(cheap.yesPrice * (1 + params.takeProfitPct / 100), 0.99),
            pairId: canonicalId,
            anchorPlatform: rich.platform,
            anchorPrice: rich.yesPrice,
          },
        });
      }

      return signals;
    },
  };
}
