/**
 * Chart Skill — AI chart analysis (the OPUS 5 pipeline)
 *
 * Commands:
 *   /chart <SYMBOL> [interval] [flags]   Full read → levels → plan → risk review
 *   /chart levels <SYMBOL> [interval]    Key levels only
 *   /chart plan <SYMBOL> [interval]      Trade plan + risk review only
 *
 * Analysis only — never places orders.
 */

import type { CryptoFeed } from '../../../feeds/crypto/index.js';
import type { AnalyzeOptions, Candle, ChartAnalysis } from '../../../trading/chart-analysis/index.js';

const VALID_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M',
]);

let feedInstance: CryptoFeed | null = null;

async function getFeed(): Promise<CryptoFeed | null> {
  if (feedInstance) return feedInstance;
  try {
    const { createCryptoFeed } = await import('../../../feeds/crypto/index.js');
    // getOHLCV is REST-only, so the feed is not start()ed — no sockets opened.
    feedInstance = createCryptoFeed();
    return feedInstance;
  } catch {
    return null;
  }
}

function parseFlags(args: string): AnalyzeOptions {
  const opts: AnalyzeOptions = {};
  const flagMap: Array<[RegExp, keyof AnalyzeOptions]> = [
    [/--balance\s+([\d.]+)/, 'accountBalance'],
    [/--risk\s+([\d.]+)/, 'riskPct'],
    [/--max-loss\s+([\d.]+)/, 'maxDrawdownPct'],
    [/--max-exposure\s+([\d.]+)/, 'maxExposurePct'],
    [/--open\s+([\d.]+)/, 'openExposureNotional'],
    [/--rr\s+([\d.]+)/, 'minRiskReward'],
    [/--confidence\s+([\d.]+)/, 'minConfidence'],
  ];
  for (const [re, key] of flagMap) {
    const m = args.match(re);
    if (m) (opts as Record<string, number>)[key] = parseFloat(m[1]);
  }
  return opts;
}

async function runAnalysis(
  symbol: string,
  interval: string,
  opts: AnalyzeOptions
): Promise<ChartAnalysis | string> {
  const feed = await getFeed();
  if (!feed) return 'Crypto feed not available. Check that Binance REST is reachable.';

  const ohlcv = await feed.getOHLCV(symbol, interval, 200);
  if (ohlcv.length === 0) {
    return `Couldn't fetch candles for ${symbol.toUpperCase()} (${interval}). Unknown symbol or Binance unreachable.`;
  }

  const candles: Candle[] = ohlcv.map((c) => ({
    time: c.timestamp.getTime(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  try {
    const { analyzeChart } = await import('../../../trading/chart-analysis/index.js');
    return analyzeChart(symbol, interval, candles, opts);
  } catch (err) {
    return err instanceof Error ? err.message : 'Analysis failed.';
  }
}

function helpText(): string {
  return [
    '**Chart Analysis — read → levels → plan → risk review**',
    '',
    '**Analyze:**',
    '  `/chart BTC` — full analysis on 1h candles',
    '  `/chart ETH 4h` — pick an interval (1m…1w)',
    '  `/chart SOL 1d --balance 5000 --risk 2`',
    '',
    '**Focused views:**',
    '  `/chart levels BTC [interval]` — key levels only',
    '  `/chart plan BTC [interval]` — trade plan + risk review only',
    '',
    '**Flags:** `--balance N --risk N --max-loss N --max-exposure N --open N --rr N --confidence N`',
    '',
    'Verdict is ✅ TAKE TRADE only for high-probability setups that pass every risk check.',
    'Analysis only — never places orders.',
  ].join('\n');
}

async function execute(args: string): Promise<string> {
  const trimmed = args.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase() || '';

  if (!first || first === 'help') return helpText();

  let view: 'full' | 'levels' | 'plan' = 'full';
  let rest = tokens;
  if (first === 'levels' || first === 'plan') {
    view = first;
    rest = tokens.slice(1);
  }

  const asInterval = (t: string): string | null =>
    VALID_INTERVALS.has(t) ? t : VALID_INTERVALS.has(t.toLowerCase()) ? t.toLowerCase() : null;

  const positional = rest.filter((t) => !t.startsWith('--') && !/^[\d.]+$/.test(t));
  const symbolToken = positional.find((t) => asInterval(t) === null);
  const symbol = symbolToken?.replace(/USDT$/i, '').toUpperCase();
  if (!symbol) return 'Usage: `/chart <SYMBOL> [interval]` — e.g. `/chart BTC 4h`';

  const intervalToken = positional.map(asInterval).find((t) => t !== null);
  const interval = intervalToken ?? '1h';
  const opts = parseFlags(trimmed);

  const result = await runAnalysis(symbol, interval, opts);
  if (typeof result === 'string') return result;

  const { formatAnalysisReport, formatLevelsReport, formatPlanReport } = await import(
    '../../../trading/chart-analysis/index.js'
  );
  if (view === 'levels') return formatLevelsReport(result);
  if (view === 'plan') return formatPlanReport(result);
  return formatAnalysisReport(result);
}

// ── Skill Registration ──────────────────────────────────────────────────────

export default {
  name: 'chart',
  description:
    'AI chart analysis: reads price/volume/structure, finds key levels, builds a trade plan, and risk-reviews it',
  commands: ['/chart', '/opus'],
  handle: execute,
};
