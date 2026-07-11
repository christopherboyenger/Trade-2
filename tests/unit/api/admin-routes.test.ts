/**
 * Admin Routes Tests
 *
 * Unit tests for the /api/admin router: listing users and manually
 * setting a user's handicap from the admin dashboard.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { createAdminRouter } from '../../../src/gateway/admin-routes';
import type { Database } from '../../../src/db/index';
import type { User, UserSettings } from '../../../src/types';

// =============================================================================
// TEST UTILITIES
// =============================================================================

interface TestResponse {
  status: number;
  body: any;
}

async function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: data ? JSON.parse(data) : {} });
          } catch {
            resolve({ status: res.statusCode || 500, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function defaultSettings(): UserSettings {
  return {
    alertsEnabled: true,
    digestEnabled: false,
    defaultPlatforms: [],
    notifyOnEdge: false,
    edgeThreshold: 0.05,
  };
}

function makeUser(id: string, username: string, settings: Partial<UserSettings> = {}): User {
  return {
    id,
    platform: 'telegram',
    platformUserId: id.split(':').pop() || id,
    username,
    settings: { ...defaultSettings(), ...settings },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: new Date('2026-01-02T00:00:00Z'),
  };
}

/** In-memory stand-in for the Database user methods the router uses. */
function createMockDb(users: User[]) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const db = {
    listUsers: () => [...byId.values()],
    getUser: (id: string) => byId.get(id),
    updateUserSettings: (id: string, settings: Partial<UserSettings>) => {
      const user = byId.get(id);
      if (!user) return false;
      // Mirrors src/db/index.ts: merge then round-trip through JSON, which
      // drops keys explicitly set to undefined (that is how a clear works).
      const next = JSON.parse(JSON.stringify({ ...user.settings, ...settings }));
      byId.set(id, { ...user, settings: next });
      return true;
    },
  };
  return db as unknown as Database;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Admin API — user handicaps', () => {
  let server: http.Server;
  let port: number;
  let mockDb: Database;

  const app = express();
  app.use(express.json());
  app.use('/api/admin', (req, res, next) => app.locals.router(req, res, next));

  beforeEach(() => {
    mockDb = createMockDb([
      makeUser('telegram:1001', 'alice', { handicap: 12.5 }),
      makeUser('telegram:1002', 'bob'),
    ]);
    // Swap the router on the running app between tests
    app.locals.router = createAdminRouter({ db: mockDb });
  });

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('lists users with their handicaps', async () => {
    const res = await makeRequest(port, 'GET', '/api/admin/users');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.data.length, 2);
    const alice = res.body.data.find((u: any) => u.username === 'alice');
    const bob = res.body.data.find((u: any) => u.username === 'bob');
    assert.strictEqual(alice.handicap, 12.5);
    assert.strictEqual(bob.handicap, null, 'users without a handicap report null');
    assert.ok(alice.id && alice.platform && alice.lastActiveAt);
  });

  it('sets a handicap manually', async () => {
    const res = await makeRequest(port, 'PUT', '/api/admin/users/telegram:1002/handicap', { handicap: -7.5 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.data.handicap, -7.5);
    assert.strictEqual(mockDb.getUser('telegram:1002')?.settings.handicap, -7.5, 'persisted to user settings');
  });

  it('overwrites an existing handicap', async () => {
    const res = await makeRequest(port, 'PUT', '/api/admin/users/telegram:1001/handicap', { handicap: 3 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.handicap, 3);
    assert.strictEqual(mockDb.getUser('telegram:1001')?.settings.handicap, 3);
  });

  it('clears a handicap with null', async () => {
    const res = await makeRequest(port, 'PUT', '/api/admin/users/telegram:1001/handicap', { handicap: null });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.handicap, null);
    assert.strictEqual(mockDb.getUser('telegram:1001')?.settings.handicap, undefined, 'cleared from settings');
  });

  it('rejects a missing handicap field', async () => {
    const res = await makeRequest(port, 'PUT', '/api/admin/users/telegram:1001/handicap', {});
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
  });

  it('rejects non-numeric handicaps', async () => {
    for (const bad of ['12', true, {}]) {
      const res = await makeRequest(port, 'PUT', '/api/admin/users/telegram:1001/handicap', { handicap: bad });
      assert.strictEqual(res.status, 400, `rejects ${JSON.stringify(bad)}`);
    }
  });

  it('rejects out-of-range handicaps', async () => {
    for (const bad of [-101, 101, 1e6]) {
      const res = await makeRequest(port, 'PUT', '/api/admin/users/telegram:1001/handicap', { handicap: bad });
      assert.strictEqual(res.status, 400, `rejects ${bad}`);
    }
    // Preserves the original value
    assert.strictEqual(mockDb.getUser('telegram:1001')?.settings.handicap, 12.5);
  });

  it('accepts boundary values', async () => {
    for (const ok of [-100, 100, 0]) {
      const res = await makeRequest(port, 'PUT', '/api/admin/users/telegram:1001/handicap', { handicap: ok });
      assert.strictEqual(res.status, 200, `accepts ${ok}`);
      assert.strictEqual(res.body.data.handicap, ok);
    }
  });

  it('returns 404 for unknown users', async () => {
    const res = await makeRequest(port, 'PUT', '/api/admin/users/telegram:9999/handicap', { handicap: 5 });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.ok, false);
  });

  it('does not disturb other user settings when setting a handicap', async () => {
    await makeRequest(port, 'PUT', '/api/admin/users/telegram:1002/handicap', { handicap: 9 });
    const user = mockDb.getUser('telegram:1002');
    assert.strictEqual(user?.settings.alertsEnabled, true);
    assert.strictEqual(user?.settings.edgeThreshold, 0.05);
  });
});
