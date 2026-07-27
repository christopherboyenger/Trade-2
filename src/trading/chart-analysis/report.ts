/**
 * Analyst-style report rendering for a ChartAnalysis — the chat-facing half
 * of the OPUS 5 pipeline ("it explains the entire setup like a professional
 * analyst"). Pure string building; markdown targets the chat channels.
 */

import type { ChartAnalysis, KeyLevels } from './types.js';

function fmt(n: number): string {
  if (Math.abs(n) >= 1000) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

function confidenceBar(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function touches(n: number): string {
  return `${n} touch${n === 1 ? '' : 'es'}`;
}

function levelsBlock(levels: KeyLevels): string[] {
  const lines: string[] = ['**Key Levels**'];
  if (levels.nearestResistance) {
    lines.push(
      `  Resistance: ${fmt(levels.nearestResistance.price)} (${touches(levels.nearestResistance.touches)})`
    );
  }
  if (levels.nearestSupport) {
    lines.push(
      `  Support: ${fmt(levels.nearestSupport.price)} (${touches(levels.nearestSupport.touches)})`
    );
  }
  if (!levels.nearestResistance && !levels.nearestSupport) {
    lines.push('  No significant levels in range.');
  }
  if (levels.liquidity.length > 0) {
    const pools = levels.liquidity
      .map((p) => `${p.side} @ ${fmt(p.price)}`)
      .join(', ');
    lines.push(`  Liquidity: ${pools}`);
  }
  for (const zone of levels.supplyDemand) {
    lines.push(`  ${zone.kind === 'supply' ? 'Supply' : 'Demand'} zone: ${fmt(zone.low)}–${fmt(zone.high)}`);
  }
  return lines;
}

export function formatLevelsReport(a: ChartAnalysis): string {
  return [
    `**${a.symbol} · ${a.interval} — Key Levels** (${a.candles} candles)`,
    `Last: ${fmt(a.read.priceAction.lastClose)} | Range bias: ${a.levels.bias}`,
    '',
    ...levelsBlock(a.levels),
  ].join('\n');
}

export function formatPlanReport(a: ChartAnalysis): string {
  const lines = [`**${a.symbol} · ${a.interval} — Trade Plan**`, ''];
  lines.push(...planBlock(a), '', ...riskBlock(a), '', verdictLine(a));
  return lines.join('\n');
}

function planBlock(a: ChartAnalysis): string[] {
  const { plan } = a;
  if (!plan.hasSetup && plan.direction === null) {
    return ['**Trade Plan**', `  No setup: ${plan.rationale}`];
  }
  const lines = [
    '**Trade Plan**' + (plan.hasSetup ? '' : ' (not tradeable)'),
    `  Direction: ${plan.direction?.toUpperCase()}`,
    `  Entry: ${fmt(plan.entry)}`,
    `  Stop Loss: ${fmt(plan.stopLoss)}`,
    `  Target: ${fmt(plan.target)}`,
    `  Risk/Reward: 1 : ${plan.riskReward.toFixed(1)}`,
  ];
  if (!plan.hasSetup) lines.push(`  Why not: ${plan.rationale}`);
  return lines;
}

function riskBlock(a: ChartAnalysis): string[] {
  const { risk } = a;
  const lines = [
    '**Risk Review**',
    `  Position size: ${risk.positionSize.toFixed(6)} (~$${fmt(risk.notional)})`,
    `  Risk amount: $${fmt(risk.riskAmount)} | Max loss: ${risk.maxLossOk ? 'OK' : 'EXCEEDED'}`,
    `  Exposure: ${risk.exposurePct.toFixed(1)}% ${risk.exposureOk ? '(balanced)' : '(over cap)'}`,
    `  Confidence: ${risk.confidence}/100 ${confidenceBar(risk.confidence)}`,
  ];
  return lines;
}

function bullBearBlock(a: ChartAnalysis): string[] {
  const r = a.levels.nearestResistance;
  const s = a.levels.nearestSupport;
  const bull = r
    ? `Break above ${fmt(r.price)} could trigger continuation toward new highs.`
    : 'No overhead resistance in range — continuation has open air above.';
  const bear = s
    ? `Rejection${r ? ` at ${fmt(r.price)}` : ''} could lead to a pullback toward ${fmt(s.price)}.`
    : 'No support in range below — pullbacks have little to catch them.';
  return ['**Bull Case**', `  ${bull}`, '**Bear Case**', `  ${bear}`];
}

function verdictLine(a: ChartAnalysis): string {
  if (a.verdict === 'APPROVED') {
    return `✅ **TAKE TRADE** — ${a.summary} Risk is defined. Plan is valid.`;
  }
  const reasons = a.risk.notes.length > 0 ? ` ${a.risk.notes.join(' ')}` : '';
  return `⛔ **STAND ASIDE** —${reasons}`;
}

export function formatAnalysisReport(a: ChartAnalysis): string {
  const { read } = a;
  const trendTag = read.trend.bias.toUpperCase();
  const lines = [
    `**${a.symbol} · ${a.interval} — Chart Analysis** (${a.candles} candles)`,
    '',
    '**Chart Read**',
    `  Trend: ${trendTag} — ${read.structure.description}`,
    `  Structure: ${read.structure.label}${read.structure.brokeStructure ? ' (structure break)' : ''}`,
    `  Momentum: ${read.priceAction.momentum} | Change: ${read.priceAction.changePct >= 0 ? '+' : ''}${read.priceAction.changePct.toFixed(1)}%`,
    `  Volume: ${read.volume.participation} participation (${read.volume.strengthPct.toFixed(0)}% of average)${read.volume.risingIntoMove ? ', rising into the move' : ''}`,
    '',
    ...levelsBlock(a.levels),
    '',
    ...planBlock(a),
    '',
    ...riskBlock(a),
    '',
    ...bullBearBlock(a),
    '',
    verdictLine(a),
  ];
  return lines.join('\n');
}
