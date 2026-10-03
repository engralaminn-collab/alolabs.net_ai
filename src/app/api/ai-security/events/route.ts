import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    await requireAuth();
    const params = req.nextUrl.searchParams;
    const where: { type?: string; severity?: string; agentId?: string } = {};
    if (params.get('type')) where.type = params.get('type')!;
    if (params.get('severity')) where.severity = params.get('severity')!;
    if (params.get('agentId')) where.agentId = params.get('agentId')!;
    return NextResponse.json({ data: await db.securityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }), success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unauthorized')) return NextResponse.json({ error: 'Unauthorized', success: false }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error', success: false }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth();
    const body = await req.json();
    if (!body.type) return NextResponse.json({ error: 'type required', success: false }, { status: 400 });
    const details = JSON.stringify({ executionId: body.executionId, userId: body.userId, input: body.input, output: body.output, riskScore: body.riskScore ?? 0, action: body.action ?? 'flagged', details: body.details ?? {} });
    const data = await db.securityEvent.create({ data: { type: body.type, severity: body.severity || 'medium', agentId: body.agentId, companyId: body.companyId, source: 'ai-security', details } });
    return NextResponse.json({ data, success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unauthorized')) return NextResponse.json({ error: 'Unauthorized', success: false }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error', success: false }, { status: 500 });
  }
}
