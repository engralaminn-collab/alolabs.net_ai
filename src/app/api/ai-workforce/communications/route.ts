import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('agentId')) where.OR = [{ fromAgentId: s.get('agentId') }, { toAgentId: s.get('agentId') }]
    if (s.get('type')) where.type = s.get('type')
    if (s.get('status')) where.status = s.get('status')
    const data = await db.agentCommunication.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.agentCommunication.create({ data: { fromAgentId: body.fromAgentId, toAgentId: body.toAgentId, type: body.type, subject: body.subject, payload: JSON.stringify(body.payload || {}), companyId: body.companyId } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
