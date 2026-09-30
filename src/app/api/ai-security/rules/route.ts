import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET() {
  try {
    const data = await db.securityRule.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.securityRule.create({ data: { name: body.name, type: body.type, pattern: body.pattern, config: JSON.stringify(body.config || {}), action: body.action || 'block', severity: body.severity || 'high', companyId: body.companyId } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
