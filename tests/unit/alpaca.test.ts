import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrderPayload,
  normalizeSymbol,
  placeOrder,
  closePosition,
  type AlpacaConfig,
} from '../../src/exchanges/alpaca';

const DRY_CONFIG: AlpacaConfig = {
  keyId: 'test-key',
  secretKey: 'test-secret',
  paper: true,
  dryRun: true,
};

test('normalizeSymbol uppercases and validates', () => {
  assert.equal(normalizeSymbol('aapl'), 'AAPL');
  assert.equal(normalizeSymbol(' brk.b '), 'BRK.B');
  assert.throws(() => normalizeSymbol(''), /Invalid stock symbol/);
  assert.throws(() => normalizeSymbol('not a symbol'), /Invalid stock symbol/);
  assert.throws(() => normalizeSymbol('WAYTOOLONGSYMBOL'), /Invalid stock symbol/);
});

test('buildOrderPayload builds a market qty order', () => {
  const payload = buildOrderPayload({ symbol: 'aapl', side: 'buy', qty: 10 });
  assert.deepEqual(payload, {
    symbol: 'AAPL',
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
    qty: '10',
  });
});

test('buildOrderPayload builds a limit order', () => {
  const payload = buildOrderPayload({ symbol: 'NVDA', side: 'sell', qty: 2, limitPrice: 185.5 });
  assert.equal(payload.type, 'limit');
  assert.equal(payload.limit_price, '185.5');
});

test('buildOrderPayload builds a notional market order', () => {
  const payload = buildOrderPayload({ symbol: 'SPY', side: 'buy', notional: 500 });
  assert.equal(payload.notional, '500');
  assert.equal(payload.qty, undefined);
  assert.equal(payload.type, 'market');
});

test('buildOrderPayload rejects qty+notional together and neither', () => {
  assert.throws(
    () => buildOrderPayload({ symbol: 'SPY', side: 'buy', qty: 1, notional: 100 }),
    /exactly one of qty or notional/,
  );
  assert.throws(
    () => buildOrderPayload({ symbol: 'SPY', side: 'buy' }),
    /exactly one of qty or notional/,
  );
});

test('buildOrderPayload rejects notional limit orders', () => {
  assert.throws(
    () => buildOrderPayload({ symbol: 'SPY', side: 'buy', notional: 500, limitPrice: 100 }),
    /must be market orders/,
  );
});

test('buildOrderPayload rejects non-positive sizes and prices', () => {
  assert.throws(() => buildOrderPayload({ symbol: 'SPY', side: 'buy', qty: 0 }), /Invalid qty/);
  assert.throws(() => buildOrderPayload({ symbol: 'SPY', side: 'buy', qty: -1 }), /Invalid qty/);
  assert.throws(() => buildOrderPayload({ symbol: 'SPY', side: 'buy', notional: 0 }), /Invalid notional/);
  assert.throws(
    () => buildOrderPayload({ symbol: 'SPY', side: 'buy', qty: 1, limitPrice: 0 }),
    /Invalid limit price/,
  );
});

test('placeOrder dry-run short-circuits without network', async () => {
  const order = await placeOrder(DRY_CONFIG, { symbol: 'AAPL', side: 'buy', qty: 10 });
  assert.match(order.id, /^dry_/);
  assert.equal(order.symbol, 'AAPL');
  assert.equal(order.side, 'buy');
  assert.equal(order.qty, 10);
  assert.equal(order.status, 'accepted (dry run)');
});

test('placeOrder dry-run still validates the order', async () => {
  await assert.rejects(
    placeOrder(DRY_CONFIG, { symbol: 'AAPL', side: 'buy' }),
    /exactly one of qty or notional/,
  );
});

test('closePosition dry-run short-circuits without network', async () => {
  const order = await closePosition(DRY_CONFIG, 'aapl');
  assert.ok(order);
  assert.match(order.id, /^dry_/);
  assert.equal(order.symbol, 'AAPL');
});
