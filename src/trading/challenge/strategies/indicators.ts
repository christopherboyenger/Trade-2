/**
 * Pure indicator math for the challenge strategies (testable in isolation).
 */

import type { OHLCV } from '../../../feeds/crypto/index.js';

/** Exponential moving average of the last value in the series. */
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

/** Highest high of the `period` bars BEFORE the last bar (breakout reference). */
export function donchianHigh(bars: OHLCV[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const window = bars.slice(-(period + 1), -1);
  return Math.max(...window.map((b) => b.high));
}

/** Lowest low of the `period` bars BEFORE the last bar. */
export function donchianLow(bars: OHLCV[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const window = bars.slice(-(period + 1), -1);
  return Math.min(...window.map((b) => b.low));
}

/** Wilder's Average True Range. */
export function atr(bars: OHLCV[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  let result = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    result = (result * (period - 1) + trs[i]) / period;
  }
  return result;
}
