import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from './db';

const SALT_ROUNDS = 12;
const TOKEN_LENGTH = 48;
const JWT_SECRET = process.env.JWT_SECRET || 'alo-labs-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '24h';

// ─── JWT Functions ─────────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  role?: string;
}

export function signToken(payload: JwtPayload, expiresIn: number | string = JWT_EXPIRES_IN): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

// ─── Password Functions ────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** @deprecated Use comparePassword instead */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─── Session Token Functions (DB-backed) ───────────────────────────

export async function createSessionToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(TOKEN_LENGTH).toString('hex');
  await db.settings.upsert({
    where: { key: `session:${token}` },
    update: { value: JSON.stringify({ userId }), updatedAt: new Date() },
    create: { key: `session:${token}`, value: JSON.stringify({ userId }), type: 'json' },
  });
  return token;
}

export async function verifySessionToken(token: string): Promise<{ userId: string } | null> {
  if (!token) return null;
  const session = await db.settings.findUnique({
    where: { key: `session:${token}` },
  });
  if (!session) return null;
  try {
    const data = JSON.parse(session.value);
    return data.userId ? { userId: data.userId } : null;
  } catch {
    return null;
  }
}

export async function deleteSessionToken(token: string): Promise<void> {
  try {
    await db.settings.delete({
      where: { key: `session:${token}` },
    });
  } catch {
    // Session may already be deleted
  }
}
