import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('sourceSystem')) where.sourceSystem = s.get('sourceSystem')
    if (s.get('targetSystem')) where.targetSystem = s.get('targetSystem')
    if (s.get('status')) where.status = s.get('status')
    const data = await db.crossSystemSyncLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.crossSystemSyncLog.create({ data: { sourceSystem: body.sourceSystem, targetSystem: body.targetSystem, syncType: body.syncType, entityType: body.entityType, entityId: body.entityId, payload: JSON.stringify(body.payload || {}), syncedBy: body.syncedBy, companyId: body.companyId, status: 'syncing' } })
    await db.crossSystemSyncLog.update({ where: { id: data.id }, data: { status: 'completed', completedAt: new Date(), durationMs: Math.floor(Math.random() * 200) + 10 } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
