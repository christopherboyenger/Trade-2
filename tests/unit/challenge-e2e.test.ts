/**
 * Challenge end-to-end test - no network.
 *
 * Wires the full challenge manager (strategies -> risk gate -> paper broker
 * -> persistence) with a scripted BTC price path:
 *   breakout -> entry sized off the gate -> trend up (trail arms)
 *   -> crash -> broker-side exit -> promotion report reflects the trade.
 * Also: kill/rearm via the manager surface and restart recovery.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempStateDir, type TempState } from '../helpers/state';
import type { OHLCV } from '../../src/feeds/crypto/index.js';

function makeBars(count: number, step = 0.5, start = 100): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const close = start + i * step;
    bars.push({
      timestamp: new Date(1700000000000 + i * 3600_000),
      open: close - step,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    });
  }
  return bars;
}

/** Scriptable crypto feed: OHLCV for the strategy, spot price for the broker */
function createScriptedFeed() {
  let bars = makeBars(80);
  let spot = bars[bars.length - 1].close;
  return {
    setBars(next: OHLCV[]) {
      bars = next;
      spot = next[next.length - 1].close;
    },
    setSpot(price: number) {
      spot = price;
    },
    async getOHLCV(symbol: string) {
      // Only BTC gets data; ETH is skipped by the strategy (short series)
      return symbol === 'BTC' ? bars : [];
    },
    getPrice() {
      return spot;
    },
    getPriceData() {
      return { symbol: 'BTC', price: spot, timestamp: new Date(), source: 'binance' as const };
    },
    isConnected: () => true,
    start() {},
    stop() {},
  };
}

describe('challenge end-to-end (scripted price path)', () => {
  let tempState: TempState;
  let previousStateDir: string | undefined;
  let db: any;
  let createChallengeManager: any;

  before(async () => {
    tempState = createTempStateDir('clodds-challenge-e2e-');
    previousStateDir = process.env.CLODDS_STATE_DIR;
    process.env.CLODDS_STATE_DIR = tempState.dir;
    const dbMod = await import('../../src/db/index.js');
    db = dbMod.createDatabase();
    await db.getVersion(); // wait for sql.js WASM init
    ({ createChallengeManager } = await import('../../src/trading/challenge/index.js'));
  });

  after(() => {
    db?.close();
    if (previousStateDir === undefined) delete process.env.CLODDS_STATE_DIR;
    else process.env.CLODDS_STATE_DIR = previousStateDir;
    tempState.cleanup();
  });

  it('runs entry -> trail -> crash exit -> kill -> rearm -> restart recovery', async () => {
    const feed = createScriptedFeed();
    const notifications: string[] = [];
    const manager = createChallengeManager({
      db,
      feeds: null,
      config: { id: 'e2e-1', sleeves: { crypto: { maxDailyTrades: 10 } } },
      notify: async (text: string) => { notifications.push(text); },
      cryptoFeed: feed as any,
      timersEnabled: false,
    });

    // ----- Phase 1: no breakout, no trade -----
    try {
    await manager.start();
    // start() ran an initial evaluation on a non-breakout series
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(manager.getBroker().getOpenPositions().length, 0);

    // ----- Phase 2: breakout bar -> entry -----
    const breakout = makeBars(80);
    const last = breakout[breakout.length - 1];
    last.close += 6; // clear the prior 20-bar high
    last.high = last.close + 0.5;
    feed.setBars(breakout);
    await (manager as any)._evaluateOnce('crypto');
    const positions = manager.getBroker().getOpenPositions('crypto');
    assert.equal(positions.length, 1, 'breakout should open a position');
    const pos = positions[0];
    assert.ok(pos.stopPrice != null && pos.stopPrice < pos.avgPrice, 'stop registered below entry');
    assert.ok(pos.trailDistance != null, 'trailing stop registered');
    // Gate sizing: stop-distance loss ~1% of $500 sleeve
    const riskUsd = ((pos.avgPrice - pos.stopPrice!) / pos.avgPrice) * pos.qty * pos.avgPrice;
    assert.ok(riskUsd < 5.5, `risk per trade bounded (~$5), got ${riskUsd.toFixed(2)}`);

    // ----- Phase 3: trend up arms the trail, crash exits broker-side -----
    feed.setSpot(pos.avgPrice + (pos.trailActivationPrice! - pos.avgPrice) + 10); // well past activation
    await (manager as any)._markCycle();
    assert.equal(manager.getBroker().getOpenPositions().length, 1, 'still holding on the way up');
    feed.setSpot(pos.avgPrice - 50); // crash through every stop
    await (manager as any)._markCycle();
    assert.equal(manager.getBroker().getOpenPositions().length, 0, 'crash must flatten the position');
    const closeNote = notifications.find((n) => n.includes('closed binance:BTC'));
    assert.ok(closeNote, 'close alert sent');

    // ----- Phase 4: kill switch + rearm -----
    await manager.kill('e2e test kill');
    assert.equal(manager.status().status, 'killed');
    assert.equal(manager.getBroker().getState().unacknowledgedKills, 1);
    assert.ok(notifications.some((n) => n.includes('KILL SWITCH')), 'kill alert sent');
    assert.equal(manager.rearm(), true);
    assert.equal(manager.status().status, 'running');

    // ----- Phase 5: promotion report sees the closed trade -----
    const report = manager.promotionReport();
    assert.ok(report.closedTrades >= 1);
    assert.equal(report.eligible, false, 'one trade cannot pass the gates');
    const sample = report.gates.find((g: any) => g.gate === 'sample size');
    assert.equal(sample.passed, false);

    } finally {
      await manager.stop();
    }

    // ----- Phase 6: restart recovery -----
    const equityBefore = manager.getBroker().totalEquity();
    const revived = createChallengeManager({
      db,
      feeds: null,
      config: { id: 'e2e-1' },
      cryptoFeed: feed as any,
      timersEnabled: false,
    });
    revived.getBroker().resume();
    assert.ok(Math.abs(revived.getBroker().totalEquity() - equityBefore) < 1e-6, 'equity survives restart');
    assert.equal(revived.getBroker().getState().status, 'running');
    await revived.stop();
  });

  it('daily tick sends a summary and resets counters on UTC day change', async () => {
    const feed = createScriptedFeed();
    const notifications: string[] = [];
    const manager = createChallengeManager({
      db,
      feeds: null,
      config: { id: 'e2e-2' },
      notify: async (text: string) => { notifications.push(text); },
      cryptoFeed: feed as any,
      timersEnabled: false,
    });
    await manager.start();
    // Force yesterday as the last reset day
    manager.getBroker().getState().lastDailyResetDay = '2020-01-01';
    await (manager as any)._dailyTick();
    assert.ok(notifications.some((n) => n.includes('daily summary')), 'daily summary sent');
    assert.equal(manager.getBroker().getState().lastDailyResetDay, new Date().toISOString().slice(0, 10));
    await manager.stop();
  });
});
