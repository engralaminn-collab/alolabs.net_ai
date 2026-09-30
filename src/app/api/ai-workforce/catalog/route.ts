import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = { isActive: true }
    if (s.get('category')) where.category = s.get('category')
    const data = await db.agentCatalogItem.findMany({ where, orderBy: { installCount: 'desc' }, include: { _count: { select: { reviews: true, installs: true } } } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.agentCatalogItem.create({ data: { name: body.name, slug: body.slug, category: body.category, subcategory: body.subcategory, description: body.description || '', capabilities: JSON.stringify(body.capabilities || []), requiredTools: JSON.stringify(body.requiredTools || []), systemPrompt: body.systemPrompt || '', configTemplate: JSON.stringify(body.configTemplate || {}), icon: body.icon || 'Bot', color: body.color || '#003ABC' } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
