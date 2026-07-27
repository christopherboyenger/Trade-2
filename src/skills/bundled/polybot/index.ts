/**
 * PolyBot Skill — chat surface for the Polymarket auto-trader
 *
 * Commands:
 *   /pb start [--live] [--size N] [--conf N] [--assets BTC,ETH]
 *   /pb stop | status | positions | trace | log | why | config [...]
 *
 * Wires live feeds (whale tracker, crypto spot, 15m market rotator) into the
 * dependency-injected engine. Paper mode unless --live with POLY credentials.
 */

import type { CryptoFeed } from '../../../feeds/crypto/index.js';
import type { WhaleTracker, WhaleTrade } from '../../../feeds/polymarket/whale-tracker.js';
import type { ExecutionService } from '../../../execution/index.js';
import type { PolybotEngine, PolybotMarket } from '../../../trading/polybot/index.js';

let engine: PolybotEngine | null = null;
let cryptoFeed: CryptoFeed | null = null;
let whaleTracker: WhaleTracker | null = null;
let rotatorTimer: NodeJS.Timeout | null = null;
const unsubscribers: Array<() => void> = [];

async function getExecution(): Promise<ExecutionService | null> {
  try {
    const privateKey = process.env.POLY_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!privateKey) return null;
    const { createExecutionService } = await import('../../../execution/index.js');
    return createExecutionService({
      polymarket: {
        privateKey,
        address: process.env.POLY_FUNDER_ADDRESS ?? '',
        funderAddress: process.env.POLY_FUNDER_ADDRESS,
        apiKey: process.env.POLY_API_KEY ?? '',
        apiSecret: process.env.POLY_API_SECRET ?? '',
        apiPassphrase: process.env.POLY_API_PASSPHRASE ?? '',
      },
      dryRun: false,
    });
  } catch {
    return null;
  }
}

async function startFeeds(assets: string[]): Promise<void> {
  if (!engine) return;
  const bot = engine;

  // Spot momentum via Binance WebSocket
  try {
    const { createCryptoFeed } = await import('../../../feeds/crypto/index.js');
    cryptoFeed = createCryptoFeed();
    cryptoFeed.start();
    for (const asset of assets) {
      const unsub = cryptoFeed.subscribeSymbol(asset, (update) => {
        bot.onSpotTick(asset, update.price);
      });
      unsubscribers.push(unsub);
    }
  } catch {
    cryptoFeed = null;
  }

  // Whale prints via Polymarket trade stream
  try {
    const { createWhaleTracker } = await import('../../../feeds/polymarket/whale-tracker.js');
    whaleTracker = createWhaleTracker({ minTradeSize: bot.getConfig().minWhaleUsd });
    whaleTracker.on('trade', (trade: WhaleTrade) => bot.onWhaleTrade(trade));
    await whaleTracker.start();
  } catch {
    whaleTracker = null;
  }

  // 15-minute crypto markets via the Gamma rotator (reused from /div)
  const refreshMarkets = async () => {
    try {
      const { createMarketRotator } = await import('../../../strategies/hft-divergence/market-rotator.js');
      const cfg = {
        assets,
        marketDurationSec: 900,
        windows: [], thresholdBuckets: [], minSpotMovePct: 0.08,
        maxPolyFreshnessSec: 5, maxPolyMidForEntry: 0.85,
        defaultSizeUsd: 20, maxPositionSizeUsd: 100, maxConcurrentPositions: 3,
        preferMaker: true, makerTimeoutMs: 15000, takerBufferCents: 0.01, negRisk: true,
        takeProfitPct: 15, stopLossPct: 25, trailingStopPct: 8, trailingActivationPct: 10,
        forceExitSec: 30, timeExitSec: 120, maxDailyLossUsd: 200,
        cooldownAfterLossSec: 30, cooldownAfterExitSec: 15, dryRun: true,
      };
      const rotator = createMarketRotator(() => cfg);
      const markets = await rotator.refresh();
      const mapped: PolybotMarket[] = markets.map((m) => ({
        marketId: m.conditionId,
        label: m.asset.toLowerCase() + '-up-or-down',
        asset: m.asset,
        yesTokenId: m.upTokenId,
        noTokenId: m.downTokenId,
        yesPrice: m.upPrice,
        noPrice: m.downPrice,
        expiresAt: m.expiresAt,
        negRisk: m.negRisk,
      }));
      bot.setActiveMarkets(mapped);
      for (const m of mapped) bot.updateMarketPrice(m.marketId, m.yesPrice, m.noPrice);
    } catch {
      // Gamma unreachable — diagnostics will show markets=0 / gamma.rest stale
    }
  };
  await refreshMarkets();
  rotatorTimer = setInterval(refreshMarkets, 60_000);
}

function stopFeeds(): void {
  for (const unsub of unsubscribers.splice(0)) {
    try { unsub(); } catch { /* already gone */ }
  }
  if (rotatorTimer) { clearInterval(rotatorTimer); rotatorTimer = null; }
  try { cryptoFeed?.stop(); } catch { /* */ }
  cryptoFeed = null;
  try { whaleTracker?.stop(); } catch { /* */ }
  whaleTracker = null;
}

// ── Formatters ──────────────────────────────────────────────────────────────

function usd(n: number): string { return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`; }

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

function fillSquares(fills: Array<{ result: string }>): string {
  if (fills.length === 0) return '(none yet)';
  return fills.map((f) => (f.result === 'win' ? '🟩' : f.result === 'loss' ? '🟥' : '🟨')).join('');
}

// ── Command handler ─────────────────────────────────────────────────────────

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0]?.toLowerCase() || 'help';

  switch (cmd) {
    case 'start': {
      if (engine?.isRunning()) return 'Already running. `/pb stop` first.';

      const live = args.includes('--live');
      const sizeMatch = args.match(/--size\s+([\d.]+)/);
      const confMatch = args.match(/--conf\s+([\d.]+)/);
      const assetsMatch = args.match(/--assets\s+([A-Za-z,]+)/);
      const assets = assetsMatch ? assetsMatch[1].toUpperCase().split(',') : ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

      const execution = live ? await getExecution() : null;
      if (live && !execution) {
        return 'LIVE mode needs POLY_PRIVATE_KEY (+ API creds). Starting refused — run without `--live` for paper trading.';
      }

      const { createPolybotEngine } = await import('../../../trading/polybot/index.js');
      engine = createPolybotEngine(
        {
          live: live && !!execution,
          ...(sizeMatch ? { tradeSizeUsd: parseFloat(sizeMatch[1]) } : {}),
          ...(confMatch ? { minConfidence: parseFloat(confMatch[1]) } : {}),
        },
        { execution }
      );
      engine.start();
      await startFeeds(assets);

      const cfg = engine.getConfig();
      return [
        `**PolyBot Started [${cfg.live ? 'LIVE' : 'PAPER'}]**`,
        `Signals: whale (≥$${cfg.minWhaleUsd.toLocaleString('en-US')}) + momentum (${cfg.momentumThresholdPct}%/${cfg.momentumWindowSec}s on ${assets.join(', ')})`,
        `Size: $${cfg.tradeSizeUsd}/trade | Conf floor: ${cfg.minConfidence} | Spread cap: ${cfg.maxSpreadCents}c`,
        `Caps: ${cfg.maxConcurrentPositions} positions, $${cfg.maxExposureUsd} exposure, $${cfg.maxDailyLossUsd} daily loss`,
        '',
        '`/pb status` for the dashboard, `/pb why` if it seems quiet.',
      ].join('\n');
    }

    case 'stop': {
      if (!engine) return 'Not running.';
      const stats = engine.getStats();
      engine.stop();
      stopFeeds();
      engine = null;
      return `Stopped. ${stats.wins + stats.losses} closed trades, ${usd(stats.realizedPnlUsd)} realized, ${stats.winRate.toFixed(0)}% WR`;
    }

    case 'status': {
      if (!engine) return 'Not running. `/pb start`';
      const s = engine.getStats();
      const health = engine.getFeedHealth();
      const out = [
        `**PolyBot ${engine.getConfig().live ? 'LIVE' : 'PAPER'} — Session**`,
        `P&L: ${usd(s.sessionPnlUsd)} (realized ${usd(s.realizedPnlUsd)}) | Balance: $${(s.startBalanceUsd + s.sessionPnlUsd).toFixed(2)}`,
        `Win rate: ${s.winRate.toFixed(1)}% (${s.wins}W/${s.losses}L) | Open: ${s.openPositions}/${engine.getConfig().maxConcurrentPositions}`,
        `Signals/min: ${s.signalsPerMin} | Trades/hr: ${s.tradesPerHr} | Whales seen: ${s.whalesSeen} | Momentum: ${s.momentumSeen}`,
        `Markets scanned: ${s.marketsScanned.toLocaleString('en-US')}`,
        `Last 10 fills: ${fillSquares(engine.getFills())}`,
        '',
        '**Feed health:**',
        ...health.map((h) => `  ${h.source} ${h.live ? 'LIVE' : 'stale'}`),
      ];
      return out.join('\n');
    }

    case 'positions': {
      if (!engine) return 'Not running.';
      const open = engine.getPositions();
      const recent = engine.getClosed().slice(-10);
      let out = `**Open positions (${open.length}):**\n`;
      if (open.length === 0) out += '  none\n';
      for (const p of open) {
        const pnl = (p.markPrice - p.entryPrice) * p.shares;
        out += `  ${p.label} ${p.side} @ ${(p.entryPrice * 100).toFixed(0)}c → ${(p.markPrice * 100).toFixed(0)}c (${usd(pnl)}) [${p.kind}]\n`;
      }
      if (recent.length > 0) {
        out += `\n**Last ${recent.length} closed:**\n`;
        for (const c of [...recent].reverse()) {
          out += `  ${c.label} ${c.side} ${usd(c.pnlUsd)} ${c.exitReason}\n`;
        }
      }
      return out;
    }

    case 'trace': {
      if (!engine) return 'Not running.';
      const traces = engine.getTrace(15);
      if (traces.length === 0) return 'No decisions yet.';
      let out = '**Decision trace — signal → gate → exec:**\n';
      for (const t of [...traces].reverse()) {
        out += `  ${t.label} → ${t.kind} → conf ${t.conf} → ${t.outcome === 'placed' ? '**placed**' : `skip (${t.reason})`}\n`;
      }
      return out;
    }

    case 'log': {
      if (!engine) return 'Not running.';
      const lines = engine.getLog(25);
      if (lines.length === 0) return 'Log is empty.';
      return '**Trade log — live stream:**\n' + lines.map((l) => `  ${fmtTs(l.ts)} [${l.tag}] ${l.text}`).join('\n');
    }

    case 'why': {
      if (!engine) {
        return '**Why isn\'t it trading?**\n  ❌ Engine not running — `/pb start`';
      }
      const checks = engine.getDiagnostics();
      return (
        '**Why isn\'t it trading?**\n' +
        checks.map((c) => `  ${c.ok ? '✅' : '❌'} ${c.label} — ${c.note}`).join('\n')
      );
    }

    case 'config': {
      if (!engine) return 'Not running.';
      const patch: Record<string, number | boolean> = {};
      const numFlags: Array<[RegExp, string]> = [
        [/--conf\s+([\d.]+)/, 'minConfidence'],
        [/--size\s+([\d.]+)/, 'tradeSizeUsd'],
        [/--spread\s+([\d.]+)/, 'maxSpreadCents'],
        [/--max-pos\s+([\d.]+)/, 'maxConcurrentPositions'],
        [/--daily-loss\s+([\d.]+)/, 'maxDailyLossUsd'],
        [/--whale-min\s+([\d.]+)/, 'minWhaleUsd'],
      ];
      for (const [re, key] of numFlags) {
        const m = args.match(re);
        if (m) patch[key] = parseFloat(m[1]);
      }
      const masterMatch = args.match(/--master\s+(on|off)/);
      if (masterMatch) patch.masterSwitch = masterMatch[1] === 'on';

      if (Object.keys(patch).length === 0) {
        const c = engine.getConfig();
        return [
          '**PolyBot config:**',
          `  mode: ${c.live ? 'LIVE' : 'PAPER'} | master: ${c.masterSwitch ? 'ON' : 'OFF'}`,
          `  size: $${c.tradeSizeUsd} | conf floor: ${c.minConfidence} | spread cap: ${c.maxSpreadCents}c`,
          `  entry band: ${c.minEntryPrice * 100}-${c.maxEntryPrice * 100}c | cooldown: ${c.cooldownSec}s`,
          `  caps: ${c.maxConcurrentPositions} pos, $${c.maxExposureUsd} exposure, $${c.maxDailyLossUsd}/day`,
          `  whale min: $${c.minWhaleUsd.toLocaleString('en-US')} | momentum: ${c.momentumThresholdPct}%/${c.momentumWindowSec}s`,
          `  tp/sl: +${c.takeProfitCents}c / -${c.stopLossCents}c`,
        ].join('\n');
      }
      engine.updateConfig(patch);
      return `Updated: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    }

    default:
      return [
        '**PolyBot — Polymarket auto-trader (whale + momentum)**',
        '',
        '  `/pb start [--live] [--size 25] [--conf 0.6] [--assets BTC,ETH]`',
        '  `/pb stop`',
        '',
        '  `/pb status` — session P&L, win rate, fills, feed health',
        '  `/pb positions` — open + recent closed',
        '  `/pb trace` — decision trace: signal → gate → exec',
        '  `/pb log` — live trade log',
        '  `/pb why` — "why isn\'t it trading?" checklist',
        '  `/pb config [--conf N] [--size N] [--spread N] [--master on|off]`',
        '',
        'Paper mode by default — `--live` requires Polymarket credentials.',
      ].join('\n');
  }
}

// ── Skill Registration ──────────────────────────────────────────────────────

export default {
  name: 'polybot',
  description:
    'Polymarket auto-trader fusing whale-follow and spot-momentum signals with confidence gating and decision traces',
  commands: ['/polybot', '/pb'],
  handle: execute,
};
