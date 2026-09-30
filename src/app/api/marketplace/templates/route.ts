import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = { isActive: true }
    if (s.get('type')) where.type = s.get('type')
    if (s.get('category')) where.category = s.get('category')
    const data = await db.marketplaceTemplate.findMany({ where, orderBy: { installCount: 'desc' }, include: { _count: { select: { installs: true, versions: true } } } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await db.marketplaceTemplate.create({ data: { name: body.name, slug: body.slug, type: body.type, category: body.category, description: body.description || '', configJson: JSON.stringify(body.config || {}), dependencies: JSON.stringify(body.dependencies || []), icon: body.icon || 'Package' } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
