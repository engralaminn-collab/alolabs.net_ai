import { headers } from 'next/headers';
import { db } from './db';

export async function getAuthUser() {
  const headersList = await headers();
  const authHeader = headersList.get('authorization');
  
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  
  if (!token) return null;

  // Verify token against database
  const session = await db.settings.findUnique({
    where: { key: `session:${token}` },
  });

  if (!session) return null;

  try {
    const data = JSON.parse(session.value);
    const userId = data.userId || data.id;
    if (!userId) return null;

    // Get user info
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) return null;
    return { userId: user.id, role: user.role, email: user.email, name: user.name };
  } catch {
    return null;
  }
}

export async function requireAuth() {
  const user = await getAuthUser();
  if (!user) throw new Error('Unauthorized');
  return user;
}

export async function requireRole(...roles: string[]) {
  const user = await requireAuth();
  if (!roles.includes(user.role)) throw new Error('Forbidden');
  return user;
}