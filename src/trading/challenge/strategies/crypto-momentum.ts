/**
 * Crypto sleeve: Donchian/EMA trend-following with ATR-based risk
 *
 * Long-only, no leverage, BTC + ETH on 1h candles (self-sourced from the
 * CryptoFeed - BotManager's context carries no market data).
 *
 * Entry:  close breaks the prior 20-bar Donchian high AND EMA20 > EMA50.
 * Stop:   entry - 2 x ATR(14)   (broker-enforced)
 * Trail:  once price >= entry + 1 x ATR, trail at highWater - 2.5 x ATR
 *         (broker-enforced)
 * Exit:   EMA20 < EMA50, or close below the prior 10-bar Donchian low.
 *
 * The strategy suggests a notional sized off riskPerTradePct; the risk gate
 * re-derives and clamps it - the gate's number always wins.
 */

import { logger } from '../../../utils/logger.js';
import type { Signal, Strategy, StrategyConfig } from '../../bots/index.js';
import type { OHLCV } from '../../../feeds/crypto/index.js';
import { atr, donchianHigh, donchianLow, ema } from './indicators.js';

export interface CryptoMomentumParams {
  symbols: string[];
  interval: string;
  emaFastPeriod: number;
  emaSlowPeriod: number;
  donchianEntryPeriod: number;
  donchianExitPeriod: number;
  atrPeriod: number;
  atrStopMult: number;
  atrTrailMult: number;
  atrTrailActivationMult: number;
  riskPerTradePct: number;
}

export const DEFAULT_CRYPTO_MOMENTUM_PARAMS: CryptoMomentumParams = {
  symbols: ['BTC', 'ETH'],
  interval: '1h',
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  donchianEntryPeriod: 20,
  donchianExitPeriod: 10,
  atrPeriod: 14,
  atrStopMult: 2,
  atrTrailMult: 2.5,
  atrTrailActivationMult: 1,
  riskPerTradePct: 1,
};

export interface CryptoMomentumDeps {
  /** Only the OHLCV method is needed - keeps tests trivial */
  getOHLCV(symbol: string, interval: string, limit?: number): Promise<OHLCV[]>;
  params?: Partial<CryptoMomentumParams>;
  config?: Partial<StrategyConfig>;
}

export function createChallengeCryptoStrategy(deps: CryptoMomentumDeps): Strategy {
  const params: CryptoMomentumParams = { ...DEFAULT_CRYPTO_MOMENTUM_PARAMS, ...deps.params };

  const config: StrategyConfig = {
    id: 'challenge-crypto',
    name: 'Challenge: Crypto Trend (Donchian/EMA/ATR)',
    description: 'Long-only BTC/ETH breakout trend-following with ATR stops',
    platforms: ['binance'],
    intervalMs: 5 * 60 * 1000,
    dryRun: false,
    enabled: true,
    ...deps.config,
  };

  return {
    config,

    async evaluate(ctx) {
      const signals: Signal[] = [];
      const minBars = Math.max(params.emaSlowPeriod, params.donchianEntryPeriod, params.atrPeriod) + 2;

      for (const symbol of params.symbols) {
        let bars: OHLCV[];
        try {
          bars = await deps.getOHLCV(symbol, params.interval, 100);
        } catch (err) {
          logger.warn({ err, symbol }, 'challenge-crypto: OHLCV fetch failed');
          continue;
        }
        if (!bars || bars.length < minBars) continue;

        const closes = bars.map((b) => b.close);
        const last = bars[bars.length - 1];
        const emaFast = ema(closes, params.emaFastPeriod);
        const emaSlow = ema(closes, params.emaSlowPeriod);
        const entryHigh = donchianHigh(bars, params.donchianEntryPeriod);
        const exitLow = donchianLow(bars, params.donchianExitPeriod);
        const atrValue = atr(bars, params.atrPeriod);
        if (emaFast == null || emaSlow == null || entryHigh == null || exitLow == null || atrValue == null || atrValue <= 0) {
          continue;
        }

        const positionKey = `binance:${symbol}:long`;
        const hasPosition = ctx.positions.has(positionKey);

        if (!hasPosition) {
          const breakout = last.close > entryHigh;
          const trendUp = emaFast > emaSlow;
          const volumeSane = last.volume > 0;
          if (breakout && trendUp && volumeSane) {
            const stopPrice = last.close - params.atrStopMult * atrValue;
            if (stopPrice <= 0) continue;
            const riskFraction = (last.close - stopPrice) / last.close;
            const notional = (ctx.portfolioValue * params.riskPerTradePct) / 100 / riskFraction;
            signals.push({
              type: 'buy',
              platform: 'binance',
              marketId: symbol,
              outcome: 'long',
              price: last.close,
              size: notional,
              confidence: 0.6,
              reason: `Donchian(${params.donchianEntryPeriod}) breakout ${last.close.toFixed(2)} > ${entryHigh.toFixed(2)}, EMA${params.emaFastPeriod} > EMA${params.emaSlowPeriod}`,
              meta: {
                stopPrice,
                trailDistance: params.atrTrailMult * atrValue,
                trailActivationPrice: last.close + params.atrTrailActivationMult * atrValue,
                atr: atrValue,
              },
            });
          }
        } else {
          const trendBroken = emaFast < emaSlow;
          const rangeBroken = last.close < exitLow;
          if (trendBroken || rangeBroken) {
            signals.push({
              type: 'close',
              platform: 'binance',
              marketId: symbol,
              outcome: 'long',
              price: last.close,
              reason: trendBroken
                ? `EMA${params.emaFastPeriod} crossed below EMA${params.emaSlowPeriod}`
                : `close below Donchian(${params.donchianExitPeriod}) low ${exitLow.toFixed(2)}`,
            });
          }
        }
      }

      return signals;
    },
  };
}
