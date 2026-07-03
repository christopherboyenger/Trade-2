/**
 * Challenge Persistence - SQLite storage for the paper-trading challenge
 *
 * Self-creates tables on init (same pattern as dca-persistence.ts), but
 * instance-based so tests can pass a mock db. Deliberately separate from the
 * manual `paper_*` tables owned by the agent paper-trading handlers.
 */

import type { Database } from '../../db/index.js';
import type {
  ChallengeFill,
  ChallengePosition,
  ChallengeState,
  EquityPoint,
  SleeveId,
} from './types.js';

export interface ChallengePersistence {
  loadState(id: string): ChallengeState | null;
  saveState(state: ChallengeState): void;
  insertPosition(pos: ChallengePosition): void;
  updatePosition(pos: ChallengePosition): void;
  deletePosition(id: string): void;
  listPositions(challengeId: string): ChallengePosition[];
  insertFill(fill: ChallengeFill): void;
  listFills(challengeId: string, limit?: number): ChallengeFill[];
  insertEquityPoint(challengeId: string, point: EquityPoint): void;
  listEquity(challengeId: string, sleeve?: SleeveId | 'total', limit?: number): EquityPoint[];
}

export function createChallengePersistence(db: Database): ChallengePersistence {
  db.run(`
    CREATE TABLE IF NOT EXISTS challenge_state (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      status_reason TEXT,
      bankroll REAL NOT NULL,
      sleeves_json TEXT NOT NULL,
      peak_equity REAL NOT NULL,
      started_at INTEGER NOT NULL,
      last_mark_at INTEGER,
      last_daily_reset_day TEXT,
      unacknowledged_kills INTEGER NOT NULL DEFAULT 0,
      promoted_eligible INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS challenge_positions (
      id TEXT PRIMARY KEY,
      challenge_id TEXT NOT NULL,
      sleeve TEXT NOT NULL,
      platform TEXT NOT NULL,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      qty REAL NOT NULL,
      avg_price REAL NOT NULL,
      cost_basis REAL NOT NULL,
      current_price REAL NOT NULL,
      stop_price REAL,
      take_profit_price REAL,
      trail_distance REAL,
      trail_activation_price REAL,
      trail_high_water REAL,
      pair_id TEXT,
      strategy_id TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      meta_json TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS challenge_trades (
      id TEXT PRIMARY KEY,
      challenge_id TEXT NOT NULL,
      sleeve TEXT NOT NULL,
      platform TEXT NOT NULL,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      price REAL NOT NULL,
      fee REAL NOT NULL DEFAULT 0,
      slippage REAL NOT NULL DEFAULT 0,
      realized_pnl REAL,
      reason TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS challenge_equity (
      challenge_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      sleeve TEXT NOT NULL,
      equity REAL NOT NULL,
      drawdown_pct REAL NOT NULL DEFAULT 0
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_challenge_equity ON challenge_equity (challenge_id, sleeve, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_challenge_trades ON challenge_trades (challenge_id, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_challenge_positions ON challenge_positions (challenge_id)`);

  function rowToPosition(row: any): ChallengePosition {
    return {
      id: row.id,
      challengeId: row.challenge_id,
      sleeve: row.sleeve as SleeveId,
      platform: row.platform,
      marketId: row.market_id,
      outcome: row.outcome,
      qty: row.qty,
      avgPrice: row.avg_price,
      costBasis: row.cost_basis,
      currentPrice: row.current_price,
      stopPrice: row.stop_price ?? undefined,
      takeProfitPrice: row.take_profit_price ?? undefined,
      trailDistance: row.trail_distance ?? undefined,
      trailActivationPrice: row.trail_activation_price ?? undefined,
      trailHighWater: row.trail_high_water ?? undefined,
      pairId: row.pair_id ?? undefined,
      strategyId: row.strategy_id,
      openedAt: row.opened_at,
      meta: row.meta_json ? JSON.parse(row.meta_json) : undefined,
    };
  }

  return {
    loadState(id: string): ChallengeState | null {
      const rows = db.query<any>(`SELECT * FROM challenge_state WHERE id = ?`, [id]);
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        status: row.status,
        statusReason: row.status_reason ?? undefined,
        bankroll: row.bankroll,
        sleeves: JSON.parse(row.sleeves_json),
        peakEquity: row.peak_equity,
        startedAt: row.started_at,
        lastMarkAt: row.last_mark_at ?? undefined,
        lastDailyResetDay: row.last_daily_reset_day ?? undefined,
        unacknowledgedKills: row.unacknowledged_kills ?? 0,
        promotedEligible: row.promoted_eligible === 1,
      };
    },

    saveState(state: ChallengeState): void {
      db.run(
        `INSERT INTO challenge_state (
          id, status, status_reason, bankroll, sleeves_json, peak_equity,
          started_at, last_mark_at, last_daily_reset_day, unacknowledged_kills, promoted_eligible
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          status_reason = excluded.status_reason,
          bankroll = excluded.bankroll,
          sleeves_json = excluded.sleeves_json,
          peak_equity = excluded.peak_equity,
          last_mark_at = excluded.last_mark_at,
          last_daily_reset_day = excluded.last_daily_reset_day,
          unacknowledged_kills = excluded.unacknowledged_kills,
          promoted_eligible = excluded.promoted_eligible`,
        [
          state.id,
          state.status,
          state.statusReason ?? null,
          state.bankroll,
          JSON.stringify(state.sleeves),
          state.peakEquity,
          state.startedAt,
          state.lastMarkAt ?? null,
          state.lastDailyResetDay ?? null,
          state.unacknowledgedKills,
          state.promotedEligible ? 1 : 0,
        ]
      );
    },

    insertPosition(pos: ChallengePosition): void {
      db.run(
        `INSERT INTO challenge_positions (
          id, challenge_id, sleeve, platform, market_id, outcome, qty, avg_price,
          cost_basis, current_price, stop_price, take_profit_price, trail_distance,
          trail_activation_price, trail_high_water, pair_id, strategy_id, opened_at, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pos.id, pos.challengeId, pos.sleeve, pos.platform, pos.marketId, pos.outcome,
          pos.qty, pos.avgPrice, pos.costBasis, pos.currentPrice,
          pos.stopPrice ?? null, pos.takeProfitPrice ?? null, pos.trailDistance ?? null,
          pos.trailActivationPrice ?? null, pos.trailHighWater ?? null, pos.pairId ?? null,
          pos.strategyId, pos.openedAt, pos.meta ? JSON.stringify(pos.meta) : null,
        ]
      );
    },

    updatePosition(pos: ChallengePosition): void {
      db.run(
        `UPDATE challenge_positions SET
          qty = ?, avg_price = ?, cost_basis = ?, current_price = ?,
          stop_price = ?, take_profit_price = ?, trail_distance = ?,
          trail_activation_price = ?, trail_high_water = ?, meta_json = ?
         WHERE id = ?`,
        [
          pos.qty, pos.avgPrice, pos.costBasis, pos.currentPrice,
          pos.stopPrice ?? null, pos.takeProfitPrice ?? null, pos.trailDistance ?? null,
          pos.trailActivationPrice ?? null, pos.trailHighWater ?? null,
          pos.meta ? JSON.stringify(pos.meta) : null,
          pos.id,
        ]
      );
    },

    deletePosition(id: string): void {
      db.run(`DELETE FROM challenge_positions WHERE id = ?`, [id]);
    },

    listPositions(challengeId: string): ChallengePosition[] {
      return db
        .query<any>(`SELECT * FROM challenge_positions WHERE challenge_id = ? ORDER BY opened_at`, [challengeId])
        .map(rowToPosition);
    },

    insertFill(fill: ChallengeFill): void {
      db.run(
        `INSERT INTO challenge_trades (
          id, challenge_id, sleeve, platform, market_id, outcome, side, qty, price,
          fee, slippage, realized_pnl, reason, strategy_id, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fill.id, fill.challengeId, fill.sleeve, fill.platform, fill.marketId, fill.outcome,
          fill.side, fill.qty, fill.price, fill.fee, fill.slippage,
          fill.realizedPnL ?? null, fill.reason, fill.strategyId, fill.ts,
        ]
      );
    },

    listFills(challengeId: string, limit = 500): ChallengeFill[] {
      return db
        .query<any>(
          `SELECT * FROM challenge_trades WHERE challenge_id = ? ORDER BY ts DESC LIMIT ?`,
          [challengeId, limit]
        )
        .map((row) => ({
          id: row.id,
          challengeId: row.challenge_id,
          sleeve: row.sleeve as SleeveId,
          platform: row.platform,
          marketId: row.market_id,
          outcome: row.outcome,
          side: row.side,
          qty: row.qty,
          price: row.price,
          fee: row.fee,
          slippage: row.slippage,
          realizedPnL: row.realized_pnl ?? undefined,
          reason: row.reason,
          strategyId: row.strategy_id,
          ts: row.ts,
        }));
    },

    insertEquityPoint(challengeId: string, point: EquityPoint): void {
      db.run(
        `INSERT INTO challenge_equity (challenge_id, ts, sleeve, equity, drawdown_pct) VALUES (?, ?, ?, ?, ?)`,
        [challengeId, point.ts, point.sleeve, point.equity, point.drawdownPct]
      );
    },

    listEquity(challengeId: string, sleeve: SleeveId | 'total' = 'total', limit = 5000): EquityPoint[] {
      return db
        .query<any>(
          `SELECT ts, sleeve, equity, drawdown_pct FROM challenge_equity
           WHERE challenge_id = ? AND sleeve = ? ORDER BY ts DESC LIMIT ?`,
          [challengeId, sleeve, limit]
        )
        .map((row) => ({
          ts: row.ts,
          sleeve: row.sleeve,
          equity: row.equity,
          drawdownPct: row.drawdown_pct,
        }))
        .reverse();
    },
  };
}
