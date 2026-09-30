import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    await requireAuth();
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 });
    }

    const agent = await db.agent.findUnique({
      where: { id },
      include: {
        department: { select: { name: true, slug: true } },
        evolution: true,
        protectiveMode: true,
        knowledge: {
          orderBy: { confidence: 'desc' },
          take: 50,
          select: {
            id: true,
            category: true,
            content: true,
            source: true,
            confidence: true,
            useCount: true,
            successCount: true,
            temperature: true,
            isVerified: true,
            tags: true,
            createdAt: true,
          },
        },
        learningSessions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            triggerType: true,
            knowledgeBefore: true,
            knowledgeAfter: true,
            insights: true,
            status: true,
            createdAt: true,
          },
        },
        _count: {
          select: { knowledge: true, learningSessions: true, tasks: true },
        },
      },
    });

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Knowledge grouped by category with stats
    const allKnowledge = await db.agentKnowledge.groupBy({
      by: ['category'],
      where: { agentId: id },
      _count: true,
      _avg: { confidence: true },
    });

    return NextResponse.json({
      data: agent,
      knowledgeByCategory: allKnowledge,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message?.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
