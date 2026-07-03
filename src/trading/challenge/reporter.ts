/**
 * Challenge Reporter - alerts + daily summary via the gateway's channels
 *
 * Notification failures are never allowed to affect trading state.
 */

import { logger } from '../../utils/logger.js';
import type { PaperBroker } from './paper-broker.js';
import type { ChallengeRiskGate } from './risk-gate.js';
import type { ChallengeStatusView, PromotionReport } from './types.js';

export type NotifyFn = (text: string) => Promise<void>;

export interface ChallengeReporter {
  attach(broker: PaperBroker, gate: ChallengeRiskGate): void;
  sendDailySummary(status: ChallengeStatusView, report: PromotionReport): Promise<void>;
  notifyStaleFeed(details: string): Promise<void>;
  notifyPromotionEligible(report: PromotionReport): Promise<void>;
}

export function createChallengeReporter(notify: NotifyFn): ChallengeReporter {
  async function send(text: string): Promise<void> {
    try {
      await notify(text);
    } catch (err) {
      logger.warn({ err }, 'challenge: alert delivery failed');
    }
  }

  const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

  return {
    attach(broker, gate) {
      broker.on('close', ({ position, reason, realizedPnL }: any) => {
        void send(
          `📊 Challenge: closed ${position.platform}:${position.marketId} (${reason}) ` +
          `PnL ${money(realizedPnL)} | equity ${money(broker.totalEquity())}`
        );
      });
      gate.on('halt', ({ reason }: any) => {
        void send(`⛔ Challenge HALTED for the day: ${reason}. Resumes at UTC midnight.`);
      });
      gate.on('kill', ({ reason }: any) => {
        void send(`🚨 Challenge KILL SWITCH: ${reason}. All positions flattened. Manual /challenge rearm required.`);
      });
      gate.on('rearm', () => {
        void send('✅ Challenge re-armed. Trading resumed.');
      });
    },

    async sendDailySummary(status, report) {
      const lines = [
        `📈 Challenge daily summary (${status.status})`,
        `Equity: ${money(status.equity)} / goal ${money(status.goal)} (${status.progressPct.toFixed(1)}%)`,
        `Drawdown from peak: ${status.drawdownPct.toFixed(1)}%`,
        `Crypto sleeve: ${money(status.sleeves.crypto.equity)} (day ${money(status.sleeves.crypto.dailyRealizedPnL)})`,
        `Prediction sleeve: ${money(status.sleeves.prediction.equity)} (day ${money(status.sleeves.prediction.dailyRealizedPnL)})`,
        `Open positions: ${status.openPositions.length}`,
        `Promotion gates: ${report.gates.filter((g) => g.passed).length}/${report.gates.length} green ` +
          `(${report.closedTrades} trades, PF ${Number.isFinite(report.profitFactor) ? report.profitFactor.toFixed(2) : 'inf'})`,
      ];
      await send(lines.join('\n'));
    },

    async notifyStaleFeed(details) {
      await send(`⚠️ Challenge: market data degraded - ${details}. Entries are blocked until feeds recover.`);
    },

    async notifyPromotionEligible(report) {
      await send(
        `🏁 Challenge: ALL promotion gates green as of ${report.asOf}. ` +
        `${report.closedTrades} trades, PF ${report.profitFactor.toFixed(2)}, max DD ${report.maxDrawdownPct.toFixed(1)}%. ` +
        `Paper phase complete - review before any live-money discussion.`
      );
    },
  };
}
