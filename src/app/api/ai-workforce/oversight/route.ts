import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('status')) where.status = s.get('status')
    if (s.get('riskLevel')) where.riskLevel = s.get('riskLevel')
    const data = await db.oversightApprovalRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.oversightApprovalRequest.create({ data: { executionId: body.executionId, title: body.title, description: body.description, requestType: body.requestType, riskLevel: body.riskLevel || 'medium', requestJson: JSON.stringify(body.requestJson || {}), requestedBy: body.requestedBy, companyId: body.companyId } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
