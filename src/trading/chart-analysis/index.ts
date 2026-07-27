/**
 * Chart analysis — the OPUS 5 pipeline.
 *
 * read the chart → find key levels → build the trade plan → risk review.
 * See engine.ts for the stages, report.ts for the analyst-style rendering.
 */

export * from './types.js';
export {
  analyzeChart,
  buildTradePlan,
  findKeyLevels,
  readChart,
  reviewRisk,
  MIN_CANDLES,
} from './engine.js';
export { formatAnalysisReport, formatLevelsReport, formatPlanReport } from './report.js';
export {
  atr,
  avg,
  clamp,
  ema,
  rsi,
  sma,
  slopePct,
  swingHighs,
  swingLows,
} from './indicators.js';
