import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET() {
  try {
    const [total, blocked, flagged, passed] = await Promise.all([
      db.aiSecurityEvent.count(),
      db.aiSecurityEvent.count({ where: { action: 'blocked' } }),
      db.aiSecurityEvent.count({ where: { action: 'flagged' } }),
      db.aiSecurityEvent.count({ where: { action: 'passed' } }),
    ])
    return NextResponse.json({ data: { total, blocked, flagged, passed, blockRate: total > 0 ? (blocked / total * 100).toFixed(1) : '0' }, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
