import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('status')) where.status = s.get('status')
    if (s.get('companyId')) where.companyId = s.get('companyId')
    const data = await db.agentInstance.findMany({ where, orderBy: { installedAt: 'desc' }, include: { catalog: true, credentials: true, _count: { select: { executions: true, healthChecks: true } } } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.agentInstance.create({ data: { agentId: body.agentId, catalogId: body.catalogId, companyId: body.companyId, config: JSON.stringify(body.config || {}), status: body.status || 'installing' } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
