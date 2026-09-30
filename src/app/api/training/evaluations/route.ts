import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('agentId')) where.agentId = s.get('agentId')
    if (s.get('sourceId')) where.sourceId = s.get('sourceId')
    const data = await db.trainingEvaluation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
