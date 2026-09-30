import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('instanceId')) where.instanceId = s.get('instanceId')
    if (s.get('type')) where.recoveryType = s.get('type')
    const data = await db.recoveryEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.recoveryEvent.create({ data: { instanceId: body.instanceId, agentId: body.agentId, executionId: body.executionId, recoveryType: body.recoveryType, triggerReason: body.triggerReason || 'manual', actionsTaken: JSON.stringify(body.actionsTaken || []), status: body.status || 'success', companyId: body.companyId } })
    if (body.instanceId && body.recoveryType === 'auto_restart') await db.agentInstance.update({ where: { id: body.instanceId }, data: { status: 'active' } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
