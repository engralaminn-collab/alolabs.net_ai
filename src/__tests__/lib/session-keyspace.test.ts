import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

/**
 * Cross-module session keyspace tests.
 *
 * `src/lib/auth.ts` mints session tokens on login; `src/lib/session-manager.ts`
 * verifies, lists and revokes them. Both read and write ONE `session:` keyspace
 * in the Settings table, so they must derive keys identically.
 *
 * This is a regression suite for a real break: hashing was initially added to
 * auth.ts alone, so `revokeSession()` looked up the unhashed key, missed the
 * row, returned false, and **logout left the bearer token valid**. Unit tests
 * with a per-module mocked db could not catch it, because each module looked
 * internally consistent. These tests share one in-memory store between both
 * modules so the interop is actually exercised.
 */

const { store } = vi.hoisted(() => {
  const store = new Map<string, { id: string; key: string; value: string; type?: string }>();
  return { store };
});

vi.mock('@/lib/db', () => {
  let seq = 0;
  const notFound = (key: string) =>
    Promise.reject(Object.assign(new Error(`No Settings found for key: ${key}`), { code: 'P2025' }));

  return {
    db: {
      settings: {
        findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
          const row = store.get(where.key);
          return row ? { ...row } : null;
        }),
        findMany: vi.fn(async ({ where }: { where: { key?: { startsWith?: string; in?: string[] } } }) => {
          const rows = [...store.values()];
          if (where?.key?.startsWith) return rows.filter((r) => r.key.startsWith(where.key!.startsWith!));
          if (where?.key?.in) return rows.filter((r) => where.key!.in!.includes(r.key));
          return rows;
        }),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const existing = store.get(where.key);
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          const row = { id: `id-${++seq}`, ...create };
          store.set(where.key, row);
          return { ...row };
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = store.get(where.key);
          if (!row) return notFound(where.key);
          Object.assign(row, data);
          return { ...row };
        }),
        delete: vi.fn(async ({ where }: { where: { key: string } }) => {
          const row = store.get(where.key);
          if (!row) return notFound(where.key);
          store.delete(where.key);
          return { ...row };
        }),
        deleteMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) => {
          let count = 0;
          for (const key of where.key.in) if (store.delete(key)) count++;
          return { count };
        }),
      },
    },
  };
});

import { createSessionToken, verifySessionToken } from '@/lib/auth';
import { verifySession, revokeSession, listActiveSessions } from '@/lib/session-manager';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('shared session keyspace (auth.ts <-> session-manager.ts)', () => {
  it('revokes a login session across modules, so logout actually invalidates it', async () => {
    // Regression: this returned false and left the token valid when the two
    // modules derived keys differently.
    const token = await createSessionToken('user-1', { method: 'password' });
    expect(await verifySessionToken(token)).not.toBeNull();

    const revoked = await revokeSession(token);
    expect(revoked).toBe(true);

    // The credential must be dead in BOTH modules.
    expect(await verifySessionToken(token)).toBeNull();
    expect(await verifySession(token)).toBeNull();
  });

  it('removes the session row entirely on revoke', async () => {
    const token = await createSessionToken('user-2');
    expect(store.has(`session:${sha256(token)}`)).toBe(true);

    await revokeSession(token);
    expect(store.has(`session:${sha256(token)}`)).toBe(false);
  });

  it('never persists the raw bearer token anywhere in the Settings table', async () => {
    const token = await createSessionToken('user-3');
    // Both keys and values are scanned: a plaintext token in either is a
    // replayable credential for anyone who can read the table.
    for (const row of store.values()) {
      expect(row.key).not.toContain(token);
      expect(row.value).not.toContain(token);
    }
    expect(store.has(`session:${token}`)).toBe(false);
    expect(store.has(`session:${sha256(token)}`)).toBe(true);
  });

  it('lets session-manager verify a session minted by auth.ts', async () => {
    const token = await createSessionToken('user-4');
    const session = await verifySession(token);
    expect(session?.userId).toBe('user-4');
  });

  it('still honours and migrates a pre-hashing legacy row', async () => {
    const legacyToken = 'legacy-raw-token-value';
    const now = Date.now();
    store.set(`session:${legacyToken}`, {
      id: 'legacy-1',
      key: `session:${legacyToken}`,
      value: JSON.stringify({
        userId: 'user-legacy',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3600_000).toISOString(),
        lastUsedAt: new Date(now).toISOString(),
      }),
      type: 'json',
    });

    // Verifying must succeed (no mass logout) ...
    const result = await verifySessionToken(legacyToken);
    expect(result?.userId).toBe('user-legacy');

    // ... and the plaintext row must be gone, replaced by the hashed one.
    expect(store.has(`session:${legacyToken}`)).toBe(false);
    expect(store.has(`session:${sha256(legacyToken)}`)).toBe(true);
  });

  it('does not resurrect a revoked legacy session', async () => {
    const legacyToken = 'legacy-revoked-token';
    const now = Date.now();
    store.set(`session:${legacyToken}`, {
      id: 'legacy-2',
      key: `session:${legacyToken}`,
      value: JSON.stringify({
        userId: 'user-5',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3600_000).toISOString(),
        lastUsedAt: new Date(now).toISOString(),
      }),
      type: 'json',
    });

    expect(await revokeSession(legacyToken)).toBe(true);
    expect(await verifySessionToken(legacyToken)).toBeNull();
    expect(await verifySession(legacyToken)).toBeNull();
  });

  it('reports no active sessions for login-minted tokens (known pre-existing gap)', async () => {
    // DOCUMENTED GAP, asserted so it cannot silently change: auth.ts does not
    // populate the `user:sessions:<userId>` index that listActiveSessions reads,
    // so the account "active devices" list is always empty for real logins.
    // Fixing it is a separate functional change, not part of this security fix.
    await createSessionToken('user-6');
    expect(await listActiveSessions('user-6')).toEqual([]);
  });
});
