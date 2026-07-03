/**
 * Promotion Gate Tests - boundary cases on every gate.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempStateDir, type TempState } from '../helpers/state';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

describe('challenge promotion gates', () => {
  let tempState: TempState;
  let previousStateDir: string | undefined;
  let db: any;
  let createChallengePersistence: any;
  let evaluatePromotionGates: any;
  let maxDrawdownPct: any;

  before(async () => {
    tempState = createTempStateDir('clodds-challenge-promo-');
    previousStateDir = process.env.CLODDS_STATE_DIR;
    process.env.CLODDS_STATE_DIR = tempState.dir;
    const dbMod = await import('../../src/db/index.js');
    db = dbMod.createDatabase();
    ({ createChallengePersistence } = await import('../../src/trading/challenge/persistence.js'));
    ({ evaluatePromotionGates, maxDrawdownPct } = await import('../../src/trading/challenge/promotion.js'));
  });

  after(() => {
    db?.close();
    if (previousStateDir === undefined) delete process.env.CLODDS_STATE_DIR;
    else process.env.CLODDS_STATE_DIR = previousStateDir;
    tempState.cleanup();
  });

  let seq = 0;
  function seed(opts: {
    pnls: number[];
    daysElapsed: number;
    equity?: number[];
    unacknowledgedKills?: number;
  }) {
    seq += 1;
    const id = `promo-${seq}`;
    const persistence = createChallengePersistence(db);
    persistence.saveState({
      id,
      status: 'running',
      bankroll: 1000,
      sleeves: {
        crypto: { balance: 500, realizedPnL: 0, dailyRealizedPnL: 0, dailyTrades: 0 },
        prediction: { balance: 500, realizedPnL: 0, dailyRealizedPnL: 0, dailyTrades: 0 },
      },
      peakEquity: 1000,
      startedAt: T0,
      unacknowledgedKills: opts.unacknowledgedKills ?? 0,
      promotedEligible: false,
    });
    opts.pnls.forEach((pnl, i) => {
      persistence.insertFill({
        id: `${id}-fill-${i}`,
        challengeId: id,
        sleeve: i % 2 === 0 ? 'crypto' : 'prediction',
        platform: 'binance',
        marketId: 'BTC',
        outcome: 'long',
        side: 'sell',
        qty: 1,
        price: 100,
        fee: 0.1,
        slippage: 0.05,
        realizedPnL: pnl,
        reason: 'signal_exit',
        strategyId: 's',
        ts: T0 + i * DAY,
      });
    });
    const equity = opts.equity ?? [1000, 1010, 1020];
    equity.forEach((eq, i) => {
      persistence.insertEquityPoint(id, { ts: T0 + i * DAY, sleeve: 'total', equity: eq, drawdownPct: 0 });
      persistence.insertEquityPoint(id, { ts: T0 + i * DAY, sleeve: 'crypto', equity: eq / 2, drawdownPct: 0 });
      persistence.insertEquityPoint(id, { ts: T0 + i * DAY, sleeve: 'prediction', equity: eq / 2, drawdownPct: 0 });
    });
    return { id, persistence, nowTs: T0 + opts.daysElapsed * DAY };
  }

  /** 30 trades: 20 wins of +6, 10 losses of -6 -> PF 2.0, expectancy +2 */
  const goodPnls = (n = 30) =>
    Array.from({ length: n }, (_, i) => (i % 3 === 2 ? -6 : 6));

  it('passes all gates with a healthy 30-trade, 60-day sample', () => {
    const { id, persistence, nowTs } = seed({ pnls: goodPnls(30), daysElapsed: 61 });
    const report = evaluatePromotionGates(persistence, id, {}, nowTs);
    assert.equal(report.eligible, true, JSON.stringify(report.gates, null, 2));
    assert.equal(report.closedTrades, 30);
  });

  it('fails sample-size gate at 29 trades', () => {
    const { id, persistence, nowTs } = seed({ pnls: goodPnls(29), daysElapsed: 61 });
    const report = evaluatePromotionGates(persistence, id, {}, nowTs);
    assert.equal(report.eligible, false);
    assert.equal(report.gates.find((g: any) => g.gate === 'sample size').passed, false);
  });

  it('fails sample-size gate at 30 trades but only 59 days', () => {
    const { id, persistence, nowTs } = seed({ pnls: goodPnls(30), daysElapsed: 59 });
    const report = evaluatePromotionGates(persistence, id, {}, nowTs);
    assert.equal(report.gates.find((g: any) => g.gate === 'sample size').passed, false);
  });

  it('accepts the alternative path: 50+ significant trades before 60 days', () => {
    // 50 trades, mostly winners: strongly significant
    const { id, persistence, nowTs } = seed({ pnls: goodPnls(51), daysElapsed: 30 });
    const report = evaluatePromotionGates(persistence, id, {}, nowTs);
    assert.equal(report.gates.find((g: any) => g.gate === 'sample size').passed, true);
  });

  it('fails profit-factor gate at PF ~1.29 and passes at ~1.31', () => {
    // 15 wins +12.9, 15 losses -10 -> PF 1.29
    const borderlineFail = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 12.9 : -10));
    const f = seed({ pnls: borderlineFail, daysElapsed: 61 });
    const failReport = evaluatePromotionGates(f.persistence, f.id, {}, f.nowTs);
    assert.equal(failReport.gates.find((g: any) => g.gate === 'profit factor').passed, false);

    const borderlinePass = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 13.1 : -10));
    const p = seed({ pnls: borderlinePass, daysElapsed: 61 });
    const passReport = evaluatePromotionGates(p.persistence, p.id, {}, p.nowTs);
    assert.equal(passReport.gates.find((g: any) => g.gate === 'profit factor').passed, true);
  });

  it('fails drawdown gate at 15.1% and passes at 14.9%', () => {
    const dd = (peak: number, trough: number) => [1000, peak, trough, peak];
    const f = seed({ pnls: goodPnls(30), daysElapsed: 61, equity: dd(1200, 1200 * (1 - 0.151)) });
    const failReport = evaluatePromotionGates(f.persistence, f.id, {}, f.nowTs);
    assert.equal(failReport.gates.find((g: any) => g.gate === 'max drawdown').passed, false);

    const p = seed({ pnls: goodPnls(30), daysElapsed: 61, equity: dd(1200, 1200 * (1 - 0.149)) });
    const passReport = evaluatePromotionGates(p.persistence, p.id, {}, p.nowTs);
    assert.equal(passReport.gates.find((g: any) => g.gate === 'max drawdown').passed, true);
  });

  it('fails on unacknowledged kill events', () => {
    const { id, persistence, nowTs } = seed({ pnls: goodPnls(30), daysElapsed: 61, unacknowledgedKills: 1 });
    const report = evaluatePromotionGates(persistence, id, {}, nowTs);
    assert.equal(report.eligible, false);
    assert.equal(report.gates.find((g: any) => g.gate === 'kill events acknowledged').passed, false);
  });

  it('fails expectancy gate when mean trade is negative', () => {
    const pnls = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 5 : -6));
    const { id, persistence, nowTs } = seed({ pnls, daysElapsed: 61 });
    const report = evaluatePromotionGates(persistence, id, {}, nowTs);
    assert.equal(report.gates.find((g: any) => g.gate === 'positive expectancy').passed, false);
  });

  it('computes max drawdown correctly', () => {
    const pts = (eqs: number[]) => eqs.map((equity, i) => ({ ts: i, sleeve: 'total' as const, equity, drawdownPct: 0 }));
    assert.equal(maxDrawdownPct(pts([100, 120, 90, 130])), 25);
    assert.equal(maxDrawdownPct(pts([100, 110, 120])), 0);
    assert.equal(maxDrawdownPct([]), 0);
  });
});
