/**
 * Challenge HTTP API Routes — status/controls for the $1k->$10k paper challenge.
 *
 * Mounted as an Express Router via httpGateway.setChallengeRouter().
 * All endpoints are prefixed with /api/challenge by the caller.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';
import type { ChallengeManager } from '../trading/challenge/index.js';

export interface ChallengeRouterDeps {
  manager: ChallengeManager;
}

export function createChallengeRouter(deps: ChallengeRouterDeps): Router {
  const router = Router();
  const { manager } = deps;

  // ── GET /api/challenge/status ─────────────────────────────────────────────
  router.get('/status', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, data: manager.status() });
    } catch (err) {
      logger.warn({ err }, 'Challenge API: status failed');
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  // ── GET /api/challenge/gates ──────────────────────────────────────────────
  router.get('/gates', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, data: manager.promotionReport() });
    } catch (err) {
      logger.warn({ err }, 'Challenge API: gates failed');
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  // ── GET /api/challenge/positions ──────────────────────────────────────────
  router.get('/positions', (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, data: manager.getBroker().getOpenPositions() });
    } catch (err) {
      logger.warn({ err }, 'Challenge API: positions failed');
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  // ── POST /api/challenge/kill ──────────────────────────────────────────────
  router.post('/kill', async (req: Request, res: Response) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual kill via API';
      await manager.kill(reason);
      res.json({ ok: true, data: manager.status() });
    } catch (err) {
      logger.warn({ err }, 'Challenge API: kill failed');
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  // ── POST /api/challenge/rearm ─────────────────────────────────────────────
  router.post('/rearm', (_req: Request, res: Response) => {
    try {
      const rearmed = manager.rearm();
      res.json({ ok: rearmed, data: manager.status(), error: rearmed ? undefined : 'not in killed state' });
    } catch (err) {
      logger.warn({ err }, 'Challenge API: rearm failed');
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  return router;
}
