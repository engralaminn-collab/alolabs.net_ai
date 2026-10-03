import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function GET() {
  try {
    await requireAuth();
    const events = await db.securityEvent.findMany({ select: { details: true } });
    const actions = events.map((event) => {
      try { return (JSON.parse(event.details || '{}') as { action?: string }).action; } catch { return undefined; }
    });
    const blocked = actions.filter((action) => action === 'blocked').length;
    const flagged = actions.filter((action) => action === 'flagged').length;
    const passed = actions.filter((action) => action === 'passed').length;
    return NextResponse.json({ data: { total: events.length, blocked, flagged, passed, blockRate: events.length ? ((blocked / events.length) * 100).toFixed(1) : '0' }, success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unauthorized')) return NextResponse.json({ error: 'Unauthorized', success: false }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error', success: false }, { status: 500 });
  }
}
