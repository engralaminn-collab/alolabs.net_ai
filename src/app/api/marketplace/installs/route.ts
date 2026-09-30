import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
export async function GET(req: NextRequest) {
  try {
    const s = req.nextUrl.searchParams
    const where: any = {}
    if (s.get('companyId')) where.companyId = s.get('companyId')
    if (s.get('status')) where.status = s.get('status')
    const data = await db.templateInstall.findMany({ where, orderBy: { installedAt: 'desc' }, include: { template: true } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const template = await db.marketplaceTemplate.findUnique({ where: { id: body.templateId } })
    if (!template) return NextResponse.json({ error: 'Template not found', success: false }, { status: 404 })
    await db.templateVersion.create({ data: { templateId: body.templateId, version: template.version, configJson: template.configJson, changeLog: 'Initial install', isCurrent: true } })
    const data = await db.templateInstall.create({ data: { templateId: body.templateId, companyId: body.companyId, userId: body.userId, version: template.version, status: 'installed', configJson: JSON.stringify(body.config || {}) } })
    await db.marketplaceTemplate.update({ where: { id: body.templateId }, data: { installCount: { increment: 1 } } })
    return NextResponse.json({ data, success: true })
  } catch (e: any) { return NextResponse.json({ error: e.message, success: false }, { status: 500 }) }
}
