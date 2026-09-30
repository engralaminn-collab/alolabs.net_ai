import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('instanceId')) where.instanceId = s.get('instanceId')
    if (s.get('agentId')) where.agentId = s.get('agentId')
    if (s.get('metricType')) where.metricType = s.get('metricType')
    const data = await db.agentMetric.findMany({ where, orderBy: { recordedAt: 'desc' }, take: 500 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.agentMetric.create({ data: { instanceId: body.instanceId, agentId: body.agentId, companyId: body.companyId, metricType: body.metricType, metricName: body.metricName, value: body.value, unit: body.unit || 'count', dimensions: JSON.stringify(body.dimensions || {}) } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
