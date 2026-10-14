/**
 * Enterprise Session Manager — P5
 * ALO Labs AISMH
 *
 * Enhanced session management with TTL, sliding expiry, token rotation,
 * multi-device tracking, and cleanup. Stores sessions in db.settings
 * with the same key pattern as the existing auth system.
 */

import crypto from 'crypto';
import { db } from '@/lib/db';
import {
  SESSION_KEY_PREFIX,
  hashSessionToken,
  sessionKey,
  legacySessionKey,
  candidateKeysForIndexEntry,
} from '@/lib/session-token';

// ─── Configuration ──────────────────────────────────────────────────

const TOKEN_LENGTH = 48;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const REMEMBER_ME_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const USER_SESSIONS_KEY_PREFIX = 'user:sessions:';

// NOTE: `sessionKey` / `SESSION_KEY_PREFIX` are imported from
// @/lib/session-token, NOT redefined here. This module and src/lib/auth.ts
// share one `session:` keyspace — auth.ts mints the tokens on login, this
// module verifies and revokes them. A private sessionKey() in each file is how
// logout silently broke: hashing was added to auth.ts alone, so revokeSession()
// looked up the unhashed key, missed the row, and left the bearer token valid
// after sign-out. Deriving the key in one place makes that drift impossible.

// ─── Types ──────────────────────────────────────────────────────────

export interface SessionData {
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  deviceInfo?: string;
  ipAddress?: string;
  isRefreshToken?: boolean;
}

export interface SessionInfo {
  token: string;
  session: SessionData;
}

export interface CreateSessionOptions {
  rememberMe?: boolean;
  deviceInfo?: string;
  ipAddress?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function generateToken(): string {
  return crypto.randomBytes(TOKEN_LENGTH).toString('hex');
}

function now(): string {
  return new Date().toISOString();
}

function ttlMs(rememberMe?: boolean): number {
  return rememberMe ? REMEMBER_ME_TTL_MS : DEFAULT_TTL_MS;
}

function expiresAt(rememberMe?: boolean): string {
  return new Date(Date.now() + ttlMs(rememberMe)).toISOString();
}

function isExpired(session: SessionData): boolean {
  return new Date(session.expiresAt) < new Date();
}

function userSessionsKey(userId: string): string {
  return `${USER_SESSIONS_KEY_PREFIX}${userId}`;
}

/**
 * Locate a session row by token, trying the hashed key first and then the
 * pre-hashing legacy key. Returns the key that actually matched so callers can
 * update or delete the right row.
 */
async function resolveSessionRow(
  token: string,
): Promise<{ key: string; value: string } | null> {
  for (const key of [sessionKey(token), legacySessionKey(token)]) {
    const record = await db.settings.findUnique({ where: { key } });
    if (record) return { key, value: record.value };
  }
  return null;
}

async function addUserSessionToken(userId: string, token: string): Promise<void> {
  const key = userSessionsKey(userId);
  const existing = await db.settings.findUnique({ where: { key } });
  let entries: string[] = [];
  if (existing) {
    try {
      entries = JSON.parse(existing.value) as string[];
    } catch {
      entries = [];
    }
  }
  // Index the DIGEST, never the raw token. This array is a second copy of every
  // live credential, so storing plaintext here would undo the hashing of the
  // session rows themselves — reading one Settings row would still yield a
  // replayable token for each of the user's devices.
  const entry = hashSessionToken(token);
  if (!entries.includes(entry)) {
    entries.push(entry);
  }
  await db.settings.upsert({
    where: { key },
    update: { value: JSON.stringify(entries), updatedAt: new Date() },
    create: { key, value: JSON.stringify(entries), type: 'json' },
  });
}

/**
 * Remove one entry from a user's session index by EXACT match.
 *
 * Callers that already hold a stored index entry (a digest, or a legacy
 * plaintext token read back out of a row key) must use this. Passing such a
 * value to `removeUserSessionToken` would hash it a second time and match
 * nothing, leaving the index permanently stale.
 */
async function removeUserSessionEntry(userId: string, entry: string): Promise<void> {
  await filterUserSessionIndex(userId, (t) => t !== entry);
}

async function removeUserSessionToken(userId: string, token: string): Promise<void> {
  // Drop the digest, and any legacy plaintext entry for the same token, so an
  // index written before hashing is cleaned up on first revoke.
  const digest = hashSessionToken(token);
  await filterUserSessionIndex(userId, (t) => t !== digest && t !== token);
}

async function filterUserSessionIndex(
  userId: string,
  keep: (entry: string) => boolean,
): Promise<void> {
  const key = userSessionsKey(userId);
  const existing = await db.settings.findUnique({ where: { key } });
  if (!existing) return;
  let entries: string[] = [];
  try {
    entries = JSON.parse(existing.value) as string[];
  } catch {
    return;
  }
  const filtered = entries.filter(keep);
  if (filtered.length === entries.length) return; // nothing to do
  if (filtered.length === 0) {
    await db.settings.delete({ where: { key } }).catch(() => {});
  } else {
    await db.settings.update({
      where: { key },
      data: { value: JSON.stringify(filtered), updatedAt: new Date() },
    });
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Create a new session with configurable TTL.
 * Default: 1 hour. With rememberMe: 30 days.
 */
export async function createSession(
  userId: string,
  options?: CreateSessionOptions,
): Promise<string> {
  const token = generateToken();
  const createdAt = now();
  const expAt = expiresAt(options?.rememberMe);

  const sessionData: SessionData = {
    userId,
    createdAt,
    expiresAt: expAt,
    lastUsedAt: createdAt,
    deviceInfo: options?.deviceInfo,
    ipAddress: options?.ipAddress,
    isRefreshToken: false,
  };

  await db.settings.upsert({
    where: { key: sessionKey(token) },
    update: { value: JSON.stringify(sessionData), updatedAt: new Date() },
    create: { key: sessionKey(token), value: JSON.stringify(sessionData), type: 'json' },
  });

  await addUserSessionToken(userId, token);

  return token;
}

/**
 * Verify a session token. Implements sliding expiry — extends TTL on each use.
 * Returns session data if valid, null if invalid/expired.
 */
export async function verifySession(
  token: string,
): Promise<SessionData | null> {
  if (!token) return null;

  const resolved = await resolveSessionRow(token);
  if (!resolved) return null;

  let session: SessionData;
  try {
    session = JSON.parse(resolved.value) as SessionData;
  } catch {
    return null;
  }

  if (isExpired(session)) {
    await revokeSession(token);
    return null;
  }

  // Sliding expiry: extend expiresAt from now
  const newExpiresAt = new Date(
    Date.now() + ttlMs(session.isRefreshToken ? true : false),
  ).toISOString();
  session.lastUsedAt = now();
  session.expiresAt = newExpiresAt;

  // Write back to the key that actually matched, which may be a legacy row.
  await db.settings.update({
    where: { key: resolved.key },
    data: { value: JSON.stringify(session), updatedAt: new Date() },
  });

  return session;
}

/**
 * Revoke a single session by token.
 */
export async function revokeSession(token: string): Promise<boolean> {
  const resolved = await resolveSessionRow(token);
  if (!resolved) return false;

  let userId = '';
  try {
    const data = JSON.parse(resolved.value) as SessionData;
    userId = data.userId;
  } catch {
    // continue cleanup
  }

  // Delete BOTH the matched row and its counterpart key. Revocation must never
  // leave a usable credential behind: if a legacy plaintext row and a hashed
  // row somehow both exist for one token, removing only one would keep the
  // session alive after logout.
  for (const key of [sessionKey(token), legacySessionKey(token)]) {
    await db.settings.delete({ where: { key } }).catch(() => {});
  }

  if (userId) {
    await removeUserSessionToken(userId, token);
  }

  return true;
}

/**
 * Revoke all sessions for a user.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const record = await db.settings.findUnique({
    where: { key: userSessionsKey(userId) },
  });
  if (!record) return 0;

  let tokens: string[] = [];
  try {
    tokens = JSON.parse(record.value) as string[];
  } catch {
    return 0;
  }

  if (tokens.length === 0) return 0;

  // Delete all session records. Index entries are digests, not raw tokens, so
  // they must NOT be passed through sessionKey() (that would hash twice and
  // match nothing). candidateKeysForIndexEntry also covers legacy plaintext
  // entries written before hashing.
  await db.settings.deleteMany({
    where: {
      key: { in: tokens.flatMap((t) => candidateKeysForIndexEntry(t)) },
    },
  });

  // Delete the user sessions index
  await db.settings
    .delete({ where: { key: userSessionsKey(userId) } })
    .catch(() => {});

  return tokens.length;
}

/**
 * List all active (non-expired) sessions for a user.
 * Tokens are truncated for safety — never expose raw tokens in listings.
 */
export async function listActiveSessions(
  userId: string,
): Promise<SessionInfo[]> {
  const record = await db.settings.findUnique({
    where: { key: userSessionsKey(userId) },
  });
  if (!record) return [];

  let tokens: string[] = [];
  try {
    tokens = JSON.parse(record.value) as string[];
  } catch {
    return [];
  }

  const results: SessionInfo[] = [];

  for (const entry of tokens) {
    // Index entries are digests (or legacy plaintext), not raw tokens, so they
    // must not go through sessionKey() — that would hash a second time and
    // match nothing, silently reporting the user as having no sessions.
    let sessionRecord: { value: string } | null = null;
    for (const key of candidateKeysForIndexEntry(entry)) {
      sessionRecord = await db.settings.findUnique({ where: { key } });
      if (sessionRecord) break;
    }
    if (!sessionRecord) continue;

    try {
      const session = JSON.parse(sessionRecord.value) as SessionData;
      if (!isExpired(session)) {
        results.push({
          // A short, non-replayable label. The entry is already a digest, so
          // this leaks nothing usable.
          token: entry.slice(0, 8) + '...',
          session,
        });
      }
    } catch {
      // Skip corrupted records
    }
  }

  return results;
}

/**
 * Clean up all expired sessions across all users.
 * Returns the count of cleaned sessions.
 * Designed to be called from a cron job or API endpoint.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  // Find all session keys
  const allSessions = await db.settings.findMany({
    where: {
      key: { startsWith: SESSION_KEY_PREFIX },
    },
  });

  const expiredKeys: string[] = [];
  const expiredUserEntries: Map<string, string[]> = new Map();

  for (const record of allSessions) {
    try {
      const session = JSON.parse(record.value) as SessionData;
      if (isExpired(session)) {
        // The suffix after `session:` is the stored identifier — a digest for
        // current rows, a raw token for pre-hashing legacy rows. It is NOT a
        // raw token in general, so it must be removed from the per-user index
        // by exact match (removeUserSessionEntry), never re-hashed.
        const entry = record.key.slice(SESSION_KEY_PREFIX.length);
        expiredKeys.push(record.key);

        // Track for user session list cleanup
        const userTokens = expiredUserEntries.get(session.userId) || [];
        userTokens.push(entry);
        expiredUserEntries.set(session.userId, userTokens);
      }
    } catch {
      // Also clean up corrupted session records
      expiredKeys.push(record.key);
    }
  }

  if (expiredKeys.length === 0) return 0;

  // Batch delete expired sessions
  await db.settings.deleteMany({
    where: { key: { in: expiredKeys } },
  });

  // Update user session lists to remove expired entries. These are key
  // suffixes (digests or legacy plaintext), so remove by exact match rather
  // than via removeUserSessionToken(), which would hash them a second time.
  for (const [userId, entries] of expiredUserEntries) {
    for (const entry of entries) {
      await removeUserSessionEntry(userId, entry);
    }
  }

  return expiredKeys.length;
}

/**
 * Refresh a session token (JWT rotation). Issues a new token,
 * copies all session metadata, and invalidates the old one.
 */
export async function refreshSession(
  token: string,
): Promise<string | null> {
  // Verify current session first
  const session = await verifySession(token);
  if (!session) return null;

  // Create new session with same metadata, mark as refresh
  const newToken = await createSession(session.userId, {
    rememberMe: session.isRefreshToken || false,
    deviceInfo: session.deviceInfo,
    ipAddress: session.ipAddress,
  });

  // Mark new session as a refresh token
  const newKey = sessionKey(newToken);
  const newRecord = await db.settings.findUnique({ where: { key: newKey } });
  if (newRecord) {
    try {
      const newData = JSON.parse(newRecord.value) as SessionData;
      newData.isRefreshToken = true;
      await db.settings.update({
        where: { key: newKey },
        data: { value: JSON.stringify(newData), updatedAt: new Date() },
      });
    } catch {
      // continue
    }
  }

  // Invalidate old token
  await revokeSession(token);

  return newToken;
}
