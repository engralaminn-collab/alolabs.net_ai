import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    await requireAuth();
    const params = new URL(req.url).searchParams;
    const page = parseInt(params.get('page') || '1');
    const limit = parseInt(params.get('limit') || '20');
    const where: { agentId?: string; category?: string } = {};
    if (params.get('agentId')) where.agentId = params.get('agentId')!;
    if (params.get('category')) where.category = params.get('category')!;
    const [data, total] = await Promise.all([
      db.agentMemory.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
        include: { agent: { select: { agentId: true, name: true, departmentName: true } } } }),
      db.agentMemory.count({ where }),
    ]);
    return NextResponse.json({
      data: data.map((item) => ({
        id: item.id, agentId: item.agent.agentId, agentName: item.agent.name,
        department: item.agent.departmentName, category: item.category, content: item.content,
        source: 'agent-memory', confidence: item.useCount > 0 ? item.successCount / item.useCount : null,
        useCount: item.useCount, successCount: item.successCount,
        failCount: Math.max(0, item.useCount - item.successCount), temperature: item.temperature,
        isVerified: item.promotedAt !== null, tags: [], createdAt: item.createdAt,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unauthorized')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requireAuth();
    const { id, action } = await req.json();
    if (!id) return NextResponse.json({ error: 'Knowledge ID required' }, { status: 400 });
    if (action === 'verify') {
      return NextResponse.json({ data: await db.agentMemory.update({ where: { id }, data: { promotedAt: new Date() } }) });
    }
    if (action === 'reject') {
      await db.agentMemory.delete({ where: { id } });
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unauthorized')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAuth();
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Knowledge ID required' }, { status: 400 });
    await db.agentMemory.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Unauthorized')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
