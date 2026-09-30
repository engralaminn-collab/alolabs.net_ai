import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('agentId')) where.agentId = s.get('agentId')
    if (s.get('severity')) where.severity = s.get('severity')
    if (s.get('acknowledged') !== null) where.isAcknowledged = s.get('acknowledged') === 'true'
    const data = await db.agentAlert.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.agentAlert.create({ data: { instanceId: body.instanceId, agentId: body.agentId, companyId: body.companyId, alertType: body.alertType, severity: body.severity || 'warning', message: body.message, metadata: JSON.stringify(body.metadata || {}) } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function PUT(req: NextRequest) {
  try {
    const { id, acknowledgedBy } = await req.json()
    const data = await db.agentAlert.update({ where: { id }, data: { isAcknowledged: true, acknowledgedBy, resolvedAt: new Date() } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
