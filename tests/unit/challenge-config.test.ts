/**
 * Challenge config resolver - bankroll scaling and goal defaults.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChallengeConfig, DEFAULT_CHALLENGE_CONFIG, RISK_PRESETS } from '../../src/trading/challenge/types.js';

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

  it('defaults to risk level 3 and reproduces the historical caps', () => {
    const cfg = resolveChallengeConfig();
    assert.equal(cfg.riskLevel, 3);
    assert.equal(cfg.riskPerTradePct, 1);
    assert.equal(cfg.maxRiskPerTradePct, 2, 'non-dial configs keep the historical 2% ceiling');
    assert.equal(cfg.sleeves.crypto.maxPositionSize, 100);   // 20% of $500
    assert.equal(cfg.sleeves.prediction.maxPositionSize, 50); // 10% of $500
  });

  it('raises the per-trade ceiling only for the preset that needs it', () => {
    assert.equal(resolveChallengeConfig({ riskLevel: 4 }).maxRiskPerTradePct, 2, 'levels 1-4 keep the 2% ceiling');
    assert.equal(resolveChallengeConfig({ riskLevel: 5 }).maxRiskPerTradePct, 2.5, 'level 5 admits its own 2.5%');
    assert.equal(resolveChallengeConfig({ riskLevel: 5, maxRiskPerTradePct: 2 }).maxRiskPerTradePct, 2, 'explicit ceiling always wins');
  });

  it('risk level scales exposure but never the safety rails', () => {
    const low = resolveChallengeConfig({ riskLevel: 1 });
    const max = resolveChallengeConfig({ riskLevel: 5 });
    assert.equal(low.riskPerTradePct, 0.5);
    assert.equal(max.riskPerTradePct, 2.5);
    assert.ok(max.riskPerTradePct <= max.maxRiskPerTradePct, 'top preset must not be clamped by the ceiling');
    assert.equal(low.sleeves.crypto.maxPositionSize, 75);   // 15% of $500
    assert.equal(max.sleeves.crypto.maxPositionSize, 200);  // 40% of $500
    // Rails identical at both extremes
    for (const key of ['dailyLossCapPct', 'maxDrawdownPct', 'maxConsecutiveLosses', 'maxConcentrationPct'] as const) {
      assert.equal(low[key], max[key], `${key} must not vary with risk level`);
    }
  });

  it('risk level composes with bankroll scaling', () => {
    const cfg = resolveChallengeConfig({ bankroll: 2000, riskLevel: 5 });
    assert.equal(cfg.sleeves.crypto.allocation, 1000);
    assert.equal(cfg.sleeves.crypto.maxPositionSize, 400); // 40% of $1,000
    assert.equal(cfg.goal, 20_000);
  });

  it('rejects invalid risk levels', () => {
    const cfg = resolveChallengeConfig({ riskLevel: 9 as any });
    assert.equal(cfg.riskLevel, 3);
  });

  it('presets are monotonic: more risk, more size, quicker triggers', () => {
    for (let l = 2 as 2|3|4|5; l <= 5; l++) {
      const prev = RISK_PRESETS[(l - 1) as 1|2|3|4], cur = RISK_PRESETS[l];
      assert.ok(cur.riskPerTradePct > prev.riskPerTradePct);
      assert.ok(cur.positionCapFrac >= prev.positionCapFrac);
      assert.ok(cur.donchianEntryPeriod < prev.donchianEntryPeriod);
    }
  });
});
