import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('type')) where.type = s.get('type')
    if (s.get('severity')) where.severity = s.get('severity')
    if (s.get('agentId')) where.agentId = s.get('agentId')
    const data = await db.aiSecurityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.aiSecurityEvent.create({ data: { type: body.type, severity: body.severity || 'medium', executionId: body.executionId, agentId: body.agentId, userId: body.userId, companyId: body.companyId, input: body.input, output: body.output, riskScore: body.riskScore || 0, action: body.action || 'flagged', details: JSON.stringify(body.details || {}) } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
