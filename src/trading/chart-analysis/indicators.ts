/**
 * Pure indicator math for the chart-analysis engine.
 *
 * Kept self-contained (operating on the local `Candle` type) so the OPUS 5
 * pipeline has no dependency on any live feed and stays trivially testable.
 */

import type { Candle } from './types.js';

export function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Simple moving average of the last `period` values. */
export function sma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  return avg(values.slice(-period));
}

/** Exponential moving average (returns the final value). */
export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let result = avg(values.slice(0, period)); // seed with SMA
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

/** Wilder's RSI (returns the final value, 0..100). */
export function rsi(values: number[], period: number): number | null {
  if (values.length < period + 1 || period <= 0) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder's Average True Range (returns the final value). */
export function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1 || period <= 0) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  let result = avg(trs.slice(0, period));
  for (let i = period; i < trs.length; i++) {
    result = (result * (period - 1) + trs[i]) / period;
  }
  return result;
}

export interface Pivot {
  index: number;
  price: number;
}

/**
 * Adjacent bars with equal extremes both satisfy the pivot test but are one
 * physical swing — collapse pivots within `gap` bars of each other, keeping
 * the most extreme price.
 */
function collapsePivots(pivots: Pivot[], gap: number, keepHigher: boolean): Pivot[] {
  const out: Pivot[] = [];
  for (const p of pivots) {
    const last = out[out.length - 1];
    if (last && p.index - last.index <= gap) {
      if (keepHigher ? p.price > last.price : p.price < last.price) {
        last.index = p.index;
        last.price = p.price;
      }
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

/**
 * Swing/pivot highs: a bar whose high is the max of the `strength` bars on
 * each side (ties allowed). The `strength` bars at each edge cannot be pivots.
 */
export function swingHighs(candles: Candle[], strength = 2): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const h = candles[i].high;
    let isPivot = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].high > h) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push({ index: i, price: h });
  }
  return collapsePivots(pivots, strength, true);
}

/** Swing/pivot lows — mirror of {@link swingHighs}. */
export function swingLows(candles: Candle[], strength = 2): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const l = candles[i].low;
    let isPivot = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].low < l) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push({ index: i, price: l });
  }
  return collapsePivots(pivots, strength, false);
}

/**
 * Least-squares slope of `values` against their index, normalized by the mean
 * so the result reads as fractional change per bar (multiply by 100 for %).
 */
export function slopePct(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = avg(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  if (den === 0 || meanY === 0) return 0;
  return num / den / meanY;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
