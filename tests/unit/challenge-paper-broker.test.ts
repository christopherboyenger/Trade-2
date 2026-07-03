/**
 * Challenge Paper Broker Tests
 *
 * Fill math (slippage/fees/orderbook walk), position averaging, broker-side
 * stop-loss / take-profit / trailing-stop enforcement, stale-price rejection,
 * sleeve balance isolation, and restart recovery against a real sql.js DB.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempStateDir, type TempState } from '../helpers/state';
import type { Orderbook } from '../../src/types.js';

// ============================================================================
// FAKES
// ============================================================================

function createFakeCryptoFeed(initial: Record<string, number> = {}) {
  const prices = new Map(Object.entries(initial));
  let tickTime = () => new Date();
  return {
    prices,
    setPrice(symbol: string, price: number) {
      prices.set(symbol, price);
    },
    setTickTime(fn: () => Date) {
      tickTime = fn;
    },
    getPrice(symbol: string) {
      return prices.get(symbol) ?? null;
    },
    getPriceData(symbol: string) {
      const price = prices.get(symbol);
      if (price == null) return null;
      return { symbol, price, timestamp: tickTime(), source: 'binance' as const };
    },
    isConnected: () => true,
  };
}

function createFakeFeeds(books: Record<string, Orderbook | null> = {}) {
  return {
    books,
    async getOrderbook(platform: string, marketId: string): Promise<Orderbook | null> {
      return books[`${platform}:${marketId}`] ?? null;
    },
  };
}

function makeBook(partial: Partial<Orderbook> & { marketId: string }): Orderbook {
  return {
    platform: 'polymarket',
    outcomeId: 'yes',
    bids: [[0.4, 1000]],
    asks: [[0.42, 1000]],
    spread: 0.02,
    midPrice: 0.41,
    timestamp: Date.now(),
    ...partial,
  } as Orderbook;
}

const buySignal = (over: Record<string, unknown> = {}) => ({
  type: 'buy' as const,
  platform: 'binance' as const,
  marketId: 'BTC',
  outcome: 'long',
  size: 100,
  ...over,
});

// ============================================================================
// TESTS
// ============================================================================

describe('challenge paper broker', () => {
  let tempState: TempState;
  let previousStateDir: string | undefined;
  let db: any;
  let createPaperBroker: any;

  before(async () => {
    tempState = createTempStateDir('clodds-challenge-broker-');
    previousStateDir = process.env.CLODDS_STATE_DIR;
    process.env.CLODDS_STATE_DIR = tempState.dir;
    const dbMod = await import('../../src/db/index.js');
    db = dbMod.createDatabase();
    ({ createPaperBroker } = await import('../../src/trading/challenge/paper-broker.js'));
  });

  after(() => {
    db?.close();
    if (previousStateDir === undefined) delete process.env.CLODDS_STATE_DIR;
    else process.env.CLODDS_STATE_DIR = previousStateDir;
    tempState.cleanup();
  });

  let idCounter = 0;
  function makeBroker(over: Record<string, unknown> = {}, feedPrices: Record<string, number> = { BTC: 100 }) {
    idCounter += 1;
    const cryptoFeed = createFakeCryptoFeed(feedPrices);
    const feeds = createFakeFeeds();
    const broker = createPaperBroker({
      db,
      cryptoFeed: cryptoFeed as any,
      feeds,
      config: { id: `test-${idCounter}`, ...over },
    });
    broker.resume();
    return { broker, cryptoFeed, feeds };
  }

  it('fills a crypto buy with adverse slippage and fee, debiting the sleeve', async () => {
    const { broker } = makeBroker();
    const trade = await broker.execute(buySignal(), 'strat', 'crypto');
    assert.ok(trade);
    // 5 bps adverse slippage on price 100
    assert.ok(Math.abs(trade.price - 100.05) < 1e-9);
    // $100 notional spent: qty = 100 / 100.05
    assert.ok(Math.abs(trade.size - 100 / 100.05) < 1e-9);
    const sleeve = broker.getSleeveState('crypto');
    // balance = 500 - (cost + fee); fee = 10 bps of notional (~$0.10)
    assert.ok(Math.abs(sleeve.balance - (500 - 100 - 0.1)) < 0.001);
    assert.equal(sleeve.openPositions, 1);
    // prediction sleeve untouched
    assert.equal(broker.getSleeveState('prediction').balance, 500);
  });

  it('averages price when adding to an existing position', async () => {
    const { broker, cryptoFeed } = makeBroker();
    await broker.execute(buySignal({ size: 50 }), 'strat', 'crypto');
    cryptoFeed.setPrice('BTC', 200);
    await broker.execute(buySignal({ size: 50 }), 'strat', 'crypto');
    const [pos] = broker.getOpenPositions('crypto');
    assert.equal(broker.getOpenPositions('crypto').length, 1);
    assert.ok(pos.avgPrice > 100 && pos.avgPrice < 200);
    // qty = 50/100.05 + 50/200.10
    const expectedQty = 50 / 100.05 + 50 / 200.1;
    assert.ok(Math.abs(pos.qty - expectedQty) < 1e-9);
  });

  it('rejects entries when the sleeve balance is insufficient', async () => {
    const { broker } = makeBroker();
    const trade = await broker.execute(buySignal({ size: 600 }), 'strat', 'crypto');
    assert.equal(trade, null);
    assert.equal(broker.getSleeveState('crypto').balance, 500);
  });

  it('rejects entries on stale crypto ticks but still allows exits', async () => {
    const { broker, cryptoFeed } = makeBroker();
    const entry = await broker.execute(buySignal(), 'strat', 'crypto');
    assert.ok(entry);
    // Make the feed stale (tick 10 minutes old)
    cryptoFeed.setTickTime(() => new Date(Date.now() - 10 * 60 * 1000));
    const rejected = await broker.execute(buySignal(), 'strat', 'crypto');
    assert.equal(rejected, null);
    const exit = await broker.execute(
      { ...buySignal(), type: 'close' as const, size: undefined },
      'strat',
      'crypto'
    );
    assert.ok(exit, 'exit should be allowed even when stale');
  });

  it('enforces broker-side stop loss during mark-to-market', async () => {
    const { broker, cryptoFeed } = makeBroker();
    await broker.execute(
      buySignal({ meta: { stopPrice: 95 } }),
      'strat',
      'crypto'
    );
    cryptoFeed.setPrice('BTC', 94);
    let stopped: any = null;
    broker.on('stop_out', (evt: any) => { stopped = evt; });
    await broker.markToMarket();
    assert.ok(stopped, 'stop_out event should fire');
    assert.equal(stopped.reason, 'stop_loss');
    assert.equal(broker.getOpenPositions('crypto').length, 0);
    const sleeve = broker.getSleeveState('crypto');
    assert.ok(sleeve.realizedPnL < 0, 'stop-out should realize a loss');
    assert.ok(sleeve.dailyRealizedPnL < 0);
  });

  it('enforces take profit during mark-to-market', async () => {
    const { broker, cryptoFeed } = makeBroker();
    await broker.execute(buySignal({ meta: { takeProfitPrice: 110 } }), 'strat', 'crypto');
    cryptoFeed.setPrice('BTC', 111);
    await broker.markToMarket();
    assert.equal(broker.getOpenPositions('crypto').length, 0);
    assert.ok(broker.getSleeveState('crypto').realizedPnL > 0);
  });

  it('activates and enforces a trailing stop', async () => {
    const { broker, cryptoFeed } = makeBroker();
    await broker.execute(
      buySignal({ meta: { stopPrice: 90, trailDistance: 5, trailActivationPrice: 105 } }),
      'strat',
      'crypto'
    );
    // Below activation: no trail yet
    cryptoFeed.setPrice('BTC', 103);
    await broker.markToMarket();
    assert.equal(broker.getOpenPositions('crypto').length, 1);
    // Activate and run up: high water 120
    cryptoFeed.setPrice('BTC', 120);
    await broker.markToMarket();
    assert.equal(broker.getOpenPositions('crypto').length, 1);
    // Pull back within trail distance: still open
    cryptoFeed.setPrice('BTC', 116);
    await broker.markToMarket();
    assert.equal(broker.getOpenPositions('crypto').length, 1);
    // Break the trail (120 - 5 = 115)
    cryptoFeed.setPrice('BTC', 114.9);
    await broker.markToMarket();
    assert.equal(broker.getOpenPositions('crypto').length, 0);
    assert.ok(broker.getSleeveState('crypto').realizedPnL > 0, 'trailing exit should lock in profit');
  });

  it('fills prediction orders by walking the orderbook', async () => {
    const { broker, feeds } = makeBroker();
    feeds.books['polymarket:mkt-1'] = makeBook({ marketId: 'mkt-1', asks: [[0.4, 50], [0.45, 1000]] });
    const trade = await broker.execute(
      buySignal({ platform: 'polymarket' as const, marketId: 'mkt-1', outcome: 'yes', size: 40 }),
      'strat',
      'prediction'
    );
    assert.ok(trade);
    // 40 USD at ref 0.40 targets 100 shares: 50 @ 0.40 + 50 @ 0.45 = avg 0.425
    assert.ok(Math.abs(trade.price - 0.425) < 1e-9);
    assert.equal(trade.size, 100);
  });

  it('rejects prediction entries with no orderbook', async () => {
    const { broker } = makeBroker();
    const trade = await broker.execute(
      buySignal({ platform: 'polymarket' as const, marketId: 'missing', outcome: 'yes', size: 40 }),
      'strat',
      'prediction'
    );
    assert.equal(trade, null);
  });

  it('marks prediction longs at best bid and stops out on collapse', async () => {
    const { broker, feeds } = makeBroker();
    feeds.books['polymarket:mkt-2'] = makeBook({ marketId: 'mkt-2', bids: [[0.38, 500]], asks: [[0.4, 500]] });
    await broker.execute(
      buySignal({
        platform: 'polymarket' as const,
        marketId: 'mkt-2',
        outcome: 'yes',
        size: 40,
        meta: { stopPrice: 0.28 },
      }),
      'strat',
      'prediction'
    );
    // Market collapses
    feeds.books['polymarket:mkt-2'] = makeBook({ marketId: 'mkt-2', bids: [[0.2, 500]], asks: [[0.22, 500]], midPrice: 0.21 });
    await broker.markToMarket();
    assert.equal(broker.getOpenPositions('prediction').length, 0);
    assert.ok(broker.getSleeveState('prediction').realizedPnL < 0);
  });

  it('records the equity curve on every mark', async () => {
    const { broker, cryptoFeed } = makeBroker();
    await broker.execute(buySignal(), 'strat', 'crypto');
    cryptoFeed.setPrice('BTC', 105);
    let equityEvent: any = null;
    broker.on('equity', (evt: any) => { equityEvent = evt; });
    await broker.markToMarket();
    assert.ok(equityEvent);
    assert.ok(equityEvent.total > 1000, 'equity should reflect unrealized gain');
    const state = broker.getState();
    assert.ok(state.peakEquity >= equityEvent.total);
  });

  it('survives a restart: state and positions reload from SQLite', async () => {
    const { broker, cryptoFeed } = makeBroker();
    const challengeId = broker.getState().id;
    await broker.execute(buySignal({ meta: { stopPrice: 95 } }), 'strat', 'crypto');
    const balanceBefore = broker.getSleeveState('crypto').balance;

    // New broker instance over the same db + challenge id (fresh feed instance)
    const { createPaperBroker } = await import('../../src/trading/challenge/paper-broker.js');
    const revived = createPaperBroker({
      db,
      cryptoFeed: cryptoFeed as any,
      feeds: createFakeFeeds() as any,
      config: { id: challengeId },
    });
    revived.resume();
    assert.equal(revived.getOpenPositions('crypto').length, 1);
    assert.equal(revived.getOpenPositions('crypto')[0].stopPrice, 95);
    assert.ok(Math.abs(revived.getSleeveState('crypto').balance - balanceBefore) < 1e-9);
  });

  it('closeAll flattens every position', async () => {
    const { broker } = makeBroker({}, { BTC: 100, ETH: 50 });
    await broker.execute(buySignal(), 'strat', 'crypto');
    await broker.execute(buySignal({ marketId: 'ETH', size: 50 }), 'strat', 'crypto');
    assert.equal(broker.getOpenPositions().length, 2);
    await broker.closeAll('kill_switch');
    assert.equal(broker.getOpenPositions().length, 0);
  });
});
