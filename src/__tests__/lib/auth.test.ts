import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module before importing auth
vi.mock('@/lib/db', () => ({
  db: {
    settings: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));

import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  deleteSessionToken,
} from '@/lib/auth';
import { db } from '@/lib/db';

const mockedDb = vi.mocked(db);

describe('Auth Library', () => {
  // ─── hashPassword ──────────────────────────────────────────────────

  describe('hashPassword', () => {
    it('should hash a password and return a bcrypt hash starting with $2', async () => {
      const hash = await hashPassword('mySecretPassword123');
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^\$2/);
    });

    it('should not return the plaintext password', async () => {
      const password = 'plaintext123';
      const hash = await hashPassword(password);
      expect(hash).not.toBe(password);
    });

    it('should produce different hashes for the same password (random salt)', async () => {
      const hash1 = await hashPassword('samePassword');
      const hash2 = await hashPassword('samePassword');
      expect(hash1).not.toBe(hash2);
    });

    it('should hash an empty string without throwing', async () => {
      const hash = await hashPassword('');
      expect(hash).toBeDefined();
      expect(hash).toMatch(/^\$2/);
    });

    it('should produce hashes of reasonable length', async () => {
      const hash = await hashPassword('password123');
      expect(hash.length).toBeGreaterThan(20);
    });
  });

  // ─── verifyPassword ────────────────────────────────────────────────

  describe('verifyPassword', () => {
    it('should return true for a correct password', async () => {
      const password = 'correctPassword';
      const hash = await hashPassword(password);
      const result = await verifyPassword(password, hash);
      expect(result).toBe(true);
    });

    it('should return false for an incorrect password', async () => {
      const hash = await hashPassword('correctPassword');
      const result = await verifyPassword('wrongPassword', hash);
      expect(result).toBe(false);
    });

    it('should return false for empty password against a real hash', async () => {
      const hash = await hashPassword('somePassword');
      const result = await verifyPassword('', hash);
      expect(result).toBe(false);
    });

    it('should return false for a password against an invalid hash', async () => {
      const result = await verifyPassword('password', 'not-a-bcrypt-hash');
      expect(result).toBe(false);
    });
  });

  // ─── createSessionToken ────────────────────────────────────────────

  describe('createSessionToken', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return a hex string of expected length (48 bytes = 96 hex chars)', async () => {
      const token = await createSessionToken('user-123');
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBe(96); // 48 bytes * 2 hex chars
      expect(token).toMatch(/^[a-f0-9]+$/);
    });

    it('should upsert a session record into db.settings', async () => {
      await createSessionToken('user-456');
      expect(mockedDb.settings.upsert).toHaveBeenCalledTimes(1);
      const call = mockedDb.settings.upsert.mock.calls[0][0];
      expect(call?.where.key).toMatch(/^session:[a-f0-9]+$/);
    });

    it('should store the userId in the session value', async () => {
      await createSessionToken('user-789');
      const call = mockedDb.settings.upsert.mock.calls[0][0];
      const value = JSON.parse(call!.create.value as string);
      expect(value.userId).toBe('user-789');
    });

    it('should produce unique tokens for different calls', async () => {
      const token1 = await createSessionToken('user-1');
      const token2 = await createSessionToken('user-2');
      expect(token1).not.toBe(token2);
    });
  });

  // ─── verifySessionToken ────────────────────────────────────────────

  describe('verifySessionToken', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return null for an empty/undefined token', async () => {
      const result = await verifySessionToken('');
      expect(result).toBeNull();
    });

    it('should return null when the session is not found in db', async () => {
      mockedDb.settings.findUnique.mockResolvedValue(null);
      const result = await verifySessionToken('nonexistent-token');
      expect(result).toBeNull();
    });

    it('should return { userId } when a valid session exists', async () => {
      mockedDb.settings.findUnique.mockResolvedValue({
        key: 'session:abc123',
        value: JSON.stringify({ userId: 'user-abc' }),
      });
      const result = await verifySessionToken('abc123');
      expect(result).toEqual({ userId: 'user-abc' });
    });

    it('should return null when the stored value has no userId', async () => {
      mockedDb.settings.findUnique.mockResolvedValue({
        key: 'session:bad',
        value: JSON.stringify({ something: 'else' }),
      });
      const result = await verifySessionToken('bad');
      expect(result).toBeNull();
    });

    it('should return null when the stored value is invalid JSON', async () => {
      mockedDb.settings.findUnique.mockResolvedValue({
        key: 'session:corrupt',
        value: 'not-json{{{',
      });
      const result = await verifySessionToken('corrupt');
      expect(result).toBeNull();
    });

    it('should query db with the correct session key', async () => {
      mockedDb.settings.findUnique.mockResolvedValue(null);
      await verifySessionToken('my-token-here');
      expect(mockedDb.settings.findUnique).toHaveBeenCalledWith({
        where: { key: 'session:my-token-here' },
      });
    });
  });

  // ─── deleteSessionToken ────────────────────────────────────────────

  describe('deleteSessionToken', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should call db.settings.delete with the correct key', async () => {
      await deleteSessionToken('token-to-delete');
      expect(mockedDb.settings.delete).toHaveBeenCalledWith({
        where: { key: 'session:token-to-delete' },
      });
    });

    it('should not throw if the session does not exist', async () => {
      mockedDb.settings.delete.mockRejectedValue(new Error('Not found'));
      await expect(deleteSessionToken('nonexistent')).resolves.toBeUndefined();
    });

    it('should resolve successfully for a valid token', async () => {
      mockedDb.settings.delete.mockResolvedValue({});
      await expect(deleteSessionToken('valid-token')).resolves.toBeUndefined();
    });
  });
});
