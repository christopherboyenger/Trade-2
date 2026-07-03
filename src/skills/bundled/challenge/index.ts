/**
 * Challenge CLI Skill
 *
 * /challenge status | gates | positions | trades | kill | rearm | reset
 *
 * Live controls (kill/rearm/reset) need the running gateway instance via
 * getChallengeManager(); read-only views fall back to the database so they
 * work even when the challenge is not currently running.
 */

function helpText(): string {
  return `**$1k -> $10k Challenge Commands**

  /challenge status          - Equity, drawdown, sleeves, open positions
  /challenge gates           - Promotion gate report (paper -> live readiness)
  /challenge positions       - Open paper positions with stops
  /challenge trades [n]      - Recent fills with PnL
  /challenge kill [reason]   - Kill switch: flatten + halt (manual rearm)
  /challenge rearm           - Resume after kill (acknowledges the event)
  /challenge reset           - Restart from the configured bankroll

Paper trading only - live promotion requires every gate green, then a human.`;
}

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

async function execute(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || 'help';

  try {
    const challengeMod = await import('../../../trading/challenge/index');
    const manager = challengeMod.getChallengeManager();

    switch (cmd) {
      case 'status': {
        if (!manager) return notRunning();
        const s = manager.status();
        const lines = [
          `🎯 **Challenge status: ${s.status}**${s.statusReason ? ` (${s.statusReason})` : ''}`,
          `Equity: ${money(s.equity)} / goal $10,000 (${s.progressPct.toFixed(1)}%)`,
          `Peak: ${money(s.peakEquity)} | drawdown ${s.drawdownPct.toFixed(1)}%`,
          ``,
          `**Crypto sleeve**: ${money(s.sleeves.crypto.equity)} (balance ${money(s.sleeves.crypto.balance)}, day ${money(s.sleeves.crypto.dailyRealizedPnL)}, ${s.sleeves.crypto.openPositions} open)`,
          `**Prediction sleeve**: ${money(s.sleeves.prediction.equity)} (balance ${money(s.sleeves.prediction.balance)}, day ${money(s.sleeves.prediction.dailyRealizedPnL)}, ${s.sleeves.prediction.openPositions} open)`,
        ];
        if (s.openPositions.length > 0) {
          lines.push('', '**Open positions:**');
          for (const p of s.openPositions) {
            lines.push(
              `- ${p.platform}:${p.marketId} ${p.qty.toFixed(4)} @ ${p.avgPrice.toFixed(4)} ` +
              `(now ${p.currentPrice.toFixed(4)}${p.stopPrice != null ? `, stop ${p.stopPrice.toFixed(4)}` : ''})`
            );
          }
        }
        return lines.join('\n');
      }

      case 'gates': {
        if (!manager) return notRunning();
        const r = manager.promotionReport();
        const lines = [
          `🏁 **Promotion gates** (as of ${r.asOf})`,
          r.eligible
            ? '✅ ALL GATES GREEN - paper phase statistically complete. Review before any live-money discussion.'
            : '⏳ Not yet eligible for live-money discussion.',
          '',
        ];
        for (const g of r.gates) {
          lines.push(`${g.passed ? '🟢' : '🔴'} ${g.gate}: ${g.value} (required: ${g.required})`);
        }
        return lines.join('\n');
      }

      case 'positions': {
        if (!manager) return notRunning();
        const positions = manager.getBroker().getOpenPositions();
        if (positions.length === 0) return 'No open paper positions.';
        return positions
          .map(
            (p) =>
              `${p.sleeve} | ${p.platform}:${p.marketId}:${p.outcome} ${p.qty.toFixed(4)} @ ${p.avgPrice.toFixed(4)} ` +
              `now ${p.currentPrice.toFixed(4)}${p.stopPrice != null ? ` stop ${p.stopPrice.toFixed(4)}` : ''}` +
              `${p.takeProfitPrice != null ? ` tp ${p.takeProfitPrice.toFixed(4)}` : ''} (${p.strategyId})`
          )
          .join('\n');
      }

      case 'trades': {
        const limit = Math.min(parseInt(parts[1] || '15', 10) || 15, 100);
        const dbMod = await import('../../../db/index');
        const persistenceMod = await import('../../../trading/challenge/persistence');
        const db = dbMod.createDatabase();
        const persistence = persistenceMod.createChallengePersistence(db);
        const challengeId = manager ? manager.status().id : 'default';
        const fills = persistence.listFills(challengeId, limit);
        if (fills.length === 0) return 'No challenge trades yet.';
        return fills
          .map((f) => {
            const pnl = f.realizedPnL !== undefined ? ` pnl ${money(f.realizedPnL)}` : '';
            return `${new Date(f.ts).toISOString().slice(0, 16)} ${f.side} ${f.platform}:${f.marketId} ` +
              `${f.qty.toFixed(4)} @ ${f.price.toFixed(4)} [${f.reason}]${pnl}`;
          })
          .join('\n');
      }

      case 'kill': {
        if (!manager) return notRunning();
        const reason = parts.slice(1).join(' ') || 'manual kill via /challenge';
        await manager.kill(reason);
        return `🚨 Kill switch activated: ${reason}\nAll paper positions flattened. Use /challenge rearm to resume.`;
      }

      case 'rearm': {
        if (!manager) return notRunning();
        return manager.rearm()
          ? '✅ Challenge re-armed. Trading resumed; kill event acknowledged.'
          : 'Challenge is not in a killed state - nothing to rearm.';
      }

      case 'reset': {
        if (!manager) return notRunning();
        await manager.reset();
        return '♻️ Challenge reset to the configured bankroll. Equity history and trade log are preserved for the record.';
      }

      default:
        return helpText();
    }
  } catch (err) {
    return `Challenge command failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function notRunning(): string {
  return 'Challenge is not running. Enable it with config `trading.challenge.enabled = true` and restart the gateway.';
}

export default {
  name: 'challenge',
  description: '$1k->$10k risk-managed paper-trading challenge',
  commands: ['/challenge'],
  handle: execute,
};
