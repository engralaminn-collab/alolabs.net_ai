import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('status')) where.status = s.get('status')
    if (s.get('level')) where.level = parseInt(s.get('level')!)
    if (s.get('agentId')) where.agentId = s.get('agentId')
    const data = await db.trainingSource.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.trainingSource.create({ data: { name: body.name, type: body.type, sourceUrl: body.sourceUrl, filePath: body.filePath, fileSize: body.fileSize || 0, level: body.level || 1, companyId: body.companyId, departmentId: body.departmentId, agentId: body.agentId, status: 'pending' } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
