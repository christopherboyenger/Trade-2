/**
 * Challenge config resolver - bankroll scaling and goal defaults.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChallengeConfig, DEFAULT_CHALLENGE_CONFIG } from '../../src/trading/challenge/types.js';

describe('resolveChallengeConfig', () => {
  it('returns defaults untouched with no overrides', () => {
    const cfg = resolveChallengeConfig();
    assert.equal(cfg.bankroll, 1000);
    assert.equal(cfg.goal, 10_000);
    assert.equal(cfg.sleeves.crypto.allocation, 500);
    assert.equal(cfg.sleeves.crypto.maxPositionSize, 100);
    assert.equal(cfg.sleeves.prediction.maxPositionSize, 50);
  });

  it('scales sleeves and position caps with the bankroll', () => {
    const cfg = resolveChallengeConfig({ bankroll: 5000 });
    assert.equal(cfg.bankroll, 5000);
    assert.equal(cfg.goal, 50_000, 'goal defaults to 10x bankroll');
    assert.equal(cfg.sleeves.crypto.allocation, 2500);
    assert.equal(cfg.sleeves.prediction.allocation, 2500);
    assert.equal(cfg.sleeves.crypto.maxPositionSize, 500);
    assert.equal(cfg.sleeves.prediction.maxPositionSize, 250);
    // Percent-based limits stay put
    assert.equal(cfg.riskPerTradePct, 1);
    assert.equal(cfg.maxDrawdownPct, 15);
  });

  it('respects an explicit goal', () => {
    const cfg = resolveChallengeConfig({ bankroll: 2000, goal: 6000 });
    assert.equal(cfg.goal, 6000);
  });

  it('explicit sleeve overrides win over scaling', () => {
    const cfg = resolveChallengeConfig({ bankroll: 2000, sleeves: { crypto: { maxPositionSize: 75 } } as any });
    assert.equal(cfg.sleeves.crypto.allocation, 1000, 'unpinned fields still scale');
    assert.equal(cfg.sleeves.crypto.maxPositionSize, 75, 'pinned field wins');
  });

  it('ignores nonsensical values', () => {
    const cfg = resolveChallengeConfig({ bankroll: -50, goal: 0 });
    assert.equal(cfg.bankroll, DEFAULT_CHALLENGE_CONFIG.bankroll);
    assert.equal(cfg.goal, 10_000);
  });
});
