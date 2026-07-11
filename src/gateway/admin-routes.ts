/**
 * Admin HTTP API Routes — user administration for the gateway dashboard.
 *
 * Mounted as an Express Router via httpGateway.setAdminRouter().
 * All endpoints are prefixed with /api/admin by the caller and sit behind
 * the CLODDS_TOKEN auth middleware, so only the admin can reach them.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';
import type { Database } from '../db/index.js';
import type { User } from '../types.js';

export interface AdminRouterDeps {
  db: Database;
}

/** Bounds for a manually entered user handicap. */
export const HANDICAP_MIN = -100;
export const HANDICAP_MAX = 100;

interface AdminUserSummary {
  id: string;
  platform: string;
  platformUserId: string;
  username: string | null;
  handicap: number | null;
  lastActiveAt: string;
}

function toSummary(user: User): AdminUserSummary {
  return {
    id: user.id,
    platform: user.platform,
    platformUserId: user.platformUserId,
    username: user.username ?? null,
    handicap: user.settings.handicap ?? null,
    lastActiveAt: user.lastActiveAt.toISOString(),
  };
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const { db } = deps;

  // ── GET /api/admin/users ──────────────────────────────────────────────────
  // List all known users with their current handicaps.
  router.get('/users', (_req: Request, res: Response) => {
    try {
      const users = db
        .listUsers()
        .map(toSummary)
        .sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
      res.json({ ok: true, data: users });
    } catch (err) {
      logger.warn({ err }, 'Admin API: list users failed');
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  // ── PUT /api/admin/users/:id/handicap ─────────────────────────────────────
  // Manually set (or clear with null) a user's handicap.
  router.put('/users/:id/handicap', (req: Request, res: Response) => {
    try {
      const userId = req.params.id;
      const body = req.body as { handicap?: unknown } | undefined;
      if (!body || !('handicap' in body)) {
        res.status(400).json({ ok: false, error: 'Body must include "handicap" (number, or null to clear)' });
        return;
      }

      const raw = body.handicap;
      let handicap: number | undefined;
      if (raw === null) {
        handicap = undefined; // clear
      } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        if (raw < HANDICAP_MIN || raw > HANDICAP_MAX) {
          res.status(400).json({ ok: false, error: `Handicap must be between ${HANDICAP_MIN} and ${HANDICAP_MAX}` });
          return;
        }
        handicap = raw;
      } else {
        res.status(400).json({ ok: false, error: 'Handicap must be a finite number, or null to clear' });
        return;
      }

      const user = db.getUser(userId);
      if (!user) {
        res.status(404).json({ ok: false, error: 'User not found' });
        return;
      }

      db.updateUserSettings(userId, { handicap });
      const updated = db.getUser(userId);
      logger.info({ userId, handicap: handicap ?? null }, 'Admin API: user handicap updated');
      res.json({ ok: true, data: updated ? toSummary(updated) : { ...toSummary(user), handicap: handicap ?? null } });
    } catch (err) {
      logger.warn({ err }, 'Admin API: set handicap failed');
      res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });

  return router;
}
