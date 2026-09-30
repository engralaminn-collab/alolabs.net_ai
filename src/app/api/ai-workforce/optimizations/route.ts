import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('agentId')) where.agentId = s.get('agentId')
    if (s.get('type')) where.type = s.get('type')
    if (s.get('status')) where.status = s.get('status')
    const data = await db.optimizationRecord.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.optimizationRecord.create({ data: { agentId: body.agentId, type: body.type, originalValue: JSON.stringify(body.originalValue || {}), optimizedValue: JSON.stringify(body.optimizedValue || {}), improvementPct: body.improvementPct || 0, status: 'proposed', companyId: body.companyId } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
