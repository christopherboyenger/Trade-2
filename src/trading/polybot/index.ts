/**
 * PolyBot — Polymarket auto-trader (whale + momentum signals, confidence
 * gating, decision traces, paper mode by default).
 */

export * from './types.js';
export {
  createPolybotEngine,
  evaluateGates,
  momentumConfidence,
  whaleConfidence,
} from './engine.js';
export type { PolybotDeps, PolybotEngine, PolybotMarket } from './engine.js';
