import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId');
  const category = searchParams.get('category');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const minConfidence = parseFloat(searchParams.get('minConfidence') || '0');

  const where: Record<string, unknown> = {};
  if (agentId) where.agentId = agentId;
  if (category) where.category = category;
  if (minConfidence > 0) where.confidence = { gte: minConfidence };

  const [data, total] = await Promise.all([
    db.agentKnowledge.findMany({
      where,
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        agent: { select: { agentId: true, name: true, departmentName: true } },
      },
    }),
    db.agentKnowledge.count({ where }),
  ]);

  return NextResponse.json({
    data: data.map(k => ({
      id: k.id,
      agentId: k.agent.agentId,
      agentName: k.agent.name,
      department: k.agent.departmentName,
      category: k.category,
      content: k.content,
      source: k.source,
      confidence: k.confidence,
      useCount: k.useCount,
      successCount: k.successCount,
      failCount: k.failCount,
      temperature: k.temperature,
      isVerified: k.isVerified,
      tags: JSON.parse(k.tags || '[]'),
      createdAt: k.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const body = await req.json();
  const { id, action } = body;

  if (!id) {
    return NextResponse.json({ error: 'Knowledge ID required' }, { status: 400 });
  }

  if (action === 'verify') {
    const knowledge = await db.agentKnowledge.update({
      where: { id },
      data: { isVerified: true, verifiedBy: auth.user?.id, confidence: Math.min(0.95, 0.8) },
    });
    return NextResponse.json({ data: knowledge });
  }

  if (action === 'reject') {
    await db.agentKnowledge.delete({ where: { id } });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Knowledge ID required' }, { status: 400 });
  }

  await db.agentKnowledge.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
