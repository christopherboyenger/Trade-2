/**
 * Challenge Risk Gate Tests
 *
 * Per-trade risk sizing, mandatory stops, daily loss halt, drawdown kill +
 * manual rearm, consecutive-loss breaker, concurrent-position caps, and
 * sleeve isolation.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempStateDir, type TempState } from '../helpers/state';

function createFakeCryptoFeed(initial: Record<string, number> = {}) {
  const prices = new Map(Object.entries(initial));
  return {
    setPrice(symbol: string, price: number) {
      prices.set(symbol, price);
    },
    getPrice(symbol: string) {
      return prices.get(symbol) ?? null;
    },
    getPriceData(symbol: string) {
      const price = prices.get(symbol);
      if (price == null) return null;
      return { symbol, price, timestamp: new Date(), source: 'binance' as const };
    },
    isConnected: () => true,
  };
}

const buySignal = (over: Record<string, unknown> = {}) => ({
  type: 'buy' as const,
  platform: 'binance' as const,
  marketId: 'BTC',
  outcome: 'long',
  price: 100,
  size: 100,
  meta: { stopPrice: 95 },
  ...over,
});

describe('challenge risk gate', () => {
  let tempState: TempState;
  let previousStateDir: string | undefined;
  let db: any;
  let createPaperBroker: any;
  let createChallengeRiskGate: any;

  before(async () => {
    tempState = createTempStateDir('clodds-challenge-gate-');
    previousStateDir = process.env.CLODDS_STATE_DIR;
    process.env.CLODDS_STATE_DIR = tempState.dir;
    const dbMod = await import('../../src/db/index.js');
    db = dbMod.createDatabase();
    await db.getVersion(); // wait for sql.js WASM init
    ({ createPaperBroker } = await import('../../src/trading/challenge/paper-broker.js'));
    ({ createChallengeRiskGate } = await import('../../src/trading/challenge/risk-gate.js'));
  });

  after(() => {
    db?.close();
    if (previousStateDir === undefined) delete process.env.CLODDS_STATE_DIR;
    else process.env.CLODDS_STATE_DIR = previousStateDir;
    tempState.cleanup();
  });

  let idCounter = 0;
  const gates: any[] = [];
  function makeGate(configOver: Record<string, unknown> = {}, feedPrices: Record<string, number> = { BTC: 100, ETH: 50 }) {
    idCounter += 1;
    const cryptoFeed = createFakeCryptoFeed(feedPrices);
    const config = { id: `gate-test-${idCounter}`, ...configOver };
    const broker = createPaperBroker({
      db,
      cryptoFeed: cryptoFeed as any,
      feeds: { getOrderbook: async () => null },
      config,
    });
    broker.resume();
    // Unique safety-state namespace per test so kill/halt state can't leak
    const gate = createChallengeRiskGate({ db, broker, config, safetyStateId: 100 + idCounter });
    gates.push(gate);
    return { gate, broker, cryptoFeed };
  }

  after(() => {
    for (const g of gates) g.destroy();
  });

  it('sizes entries so stop-distance loss equals 1% of sleeve equity', () => {
    const { gate } = makeGate();
    // 5% stop distance, $500 sleeve, 1% risk => $5 risk / 0.05 = $100 notional
    const decision = gate.check(buySignal({ size: 500 }), 'crypto');
    assert.equal(decision.approved, true);
    assert.ok(Math.abs(decision.adjustedSize - 100) < 1e-6);
  });

  it('rejects entries without a valid stop', () => {
    const { gate } = makeGate();
    assert.equal(gate.check(buySignal({ meta: {} }), 'crypto').approved, false);
    assert.equal(gate.check(buySignal({ meta: { stopPrice: 105 } }), 'crypto').approved, false);
    assert.equal(gate.check(buySignal({ meta: { stopPrice: -1 } }), 'crypto').approved, false);
  });

  it('always allows exits', () => {
    const { gate, broker } = makeGate();
    broker.getState().status = 'halted_daily';
    const decision = gate.check({ ...buySignal(), type: 'close' as const }, 'crypto');
    assert.equal(decision.approved, true);
  });

  it('caps size with a tight stop at maxPositionSize', () => {
    const { gate } = makeGate();
    // 1% stop distance => risk sizing alone would allow $500 notional; cap is $100
    const decision = gate.check(buySignal({ size: 400, meta: { stopPrice: 99 } }), 'crypto');
    assert.equal(decision.approved, true);
    assert.ok(decision.adjustedSize <= 100 + 1e-9);
  });

  it('enforces max concurrent positions per sleeve', async () => {
    const { gate, broker } = makeGate();
    const d1 = gate.check(buySignal(), 'crypto');
    assert.equal(d1.approved, true);
    await broker.execute(buySignal({ size: d1.adjustedSize }), 's', 'crypto');
    const d2 = gate.check(buySignal({ marketId: 'ETH', price: 50, meta: { stopPrice: 47.5 } }), 'crypto');
    assert.equal(d2.approved, true);
    await broker.execute(buySignal({ marketId: 'ETH', price: 50, size: d2.adjustedSize, meta: { stopPrice: 47.5 } }), 's', 'crypto');
    // Third distinct market: over the cap of 2
    const d3 = gate.check(buySignal({ marketId: 'SOL', price: 10, meta: { stopPrice: 9.5 } }), 'crypto');
    assert.equal(d3.approved, false);
    assert.match(d3.reason, /max concurrent/);
  });

  it('halts the day when the daily loss cap is hit, then resets at midnight', async () => {
    const { gate, broker, cryptoFeed } = makeGate();
    // Buy $100, crash it 60% and stop out: loss ~ $60 > $50 cap
    await broker.execute(buySignal({ size: 100, meta: { stopPrice: 40 } }), 's', 'crypto');
    cryptoFeed.setPrice('BTC', 39);
    let halted = false;
    gate.on('halt', () => { halted = true; });
    await broker.markToMarket();
    // Feed realized loss into the gate (manager wiring does this via broker 'close' events)
    const fills = broker.getState();
    assert.equal(fills.status, 'running'); // not yet - gate hasn't seen the loss
    const closeFill = {
      id: 'f1', challengeId: broker.getState().id, sleeve: 'crypto' as const,
      platform: 'binance' as const, marketId: 'BTC', outcome: 'long', side: 'sell' as const,
      qty: 1, price: 39, fee: 0, slippage: 0, realizedPnL: -60, reason: 'stop_loss' as const,
      strategyId: 's', ts: Date.now(),
    };
    gate.recordResult(closeFill);
    assert.equal(halted, true);
    assert.equal(broker.getState().status, 'halted_daily');
    // Entries blocked while halted
    assert.equal(gate.check(buySignal(), 'crypto').approved, false);
    // Midnight reset lifts the halt
    gate.resetDaily('2026-07-04');
    assert.equal(broker.getState().status, 'running');
    assert.equal(gate.check(buySignal(), 'crypto').approved, true);
  });

  it('kills on max drawdown, blocks everything, and requires manual rearm', async () => {
    const { gate, broker } = makeGate();
    let killed = false;
    gate.on('kill', () => { killed = true; });
    // Equity peak 1000 -> 800 = 20% drawdown > 15% limit
    gate.onEquity(1000);
    gate.onEquity(800);
    // doKill runs async (closeAll); give it a tick
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(killed, true);
    assert.equal(broker.getState().status, 'killed');
    assert.equal(broker.getState().unacknowledgedKills, 1);
    assert.equal(gate.check(buySignal(), 'crypto').approved, false);
    // Rearm restores trading and acknowledges the kill
    assert.equal(gate.rearm(), true);
    assert.equal(broker.getState().status, 'running');
    assert.equal(broker.getState().unacknowledgedKills, 0);
    assert.equal(gate.check(buySignal(), 'crypto').approved, true);
  });

  it('trips the sleeve breaker after consecutive losses without touching the other sleeve', () => {
    const { gate, broker } = makeGate();
    const mkFill = (i: number) => ({
      id: `loss-${i}`, challengeId: broker.getState().id, sleeve: 'crypto' as const,
      platform: 'binance' as const, marketId: 'BTC', outcome: 'long', side: 'sell' as const,
      qty: 0.1, price: 95, fee: 0, slippage: 0, realizedPnL: -2, reason: 'stop_loss' as const,
      strategyId: 's', ts: Date.now(),
    });
    for (let i = 0; i < 4; i++) gate.recordResult(mkFill(i));
    const cryptoDecision = gate.check(buySignal(), 'crypto');
    assert.equal(cryptoDecision.approved, false);
    assert.match(cryptoDecision.reason, /circuit breaker/);
    // Prediction sleeve unaffected (needs an orderbook-less price+stop, gets past breaker check)
    const predDecision = gate.check(
      buySignal({ platform: 'polymarket' as const, marketId: 'mkt', outcome: 'yes', price: 0.5, size: 20, meta: { stopPrice: 0.35 } }),
      'prediction'
    );
    assert.ok(!/circuit breaker/.test(predDecision.reason ?? ''), 'prediction sleeve breaker should be unaffected');
  });

  it('blocks entries when sleeve daily trade cap is reached', async () => {
    const { gate, broker } = makeGate({ sleeves: { crypto: { maxDailyTrades: 1 } } });
    await broker.execute(buySignal({ size: 50 }), 's', 'crypto');
    const decision = gate.check(buySignal({ marketId: 'ETH', price: 50, meta: { stopPrice: 47.5 } }), 'crypto');
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /daily trade cap/);
  });
});
