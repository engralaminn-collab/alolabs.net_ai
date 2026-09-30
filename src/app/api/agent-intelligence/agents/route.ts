import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    await requireAuth();
    const url = new URL(req.url);
    const departmentId = url.searchParams.get('departmentId');
    const search = url.searchParams.get('search') || '';
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const sortBy = url.searchParams.get('sortBy') || 'maturity';

    const where: Record<string, unknown> = { status: 'active' };
    if (departmentId) where.departmentId = departmentId;
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { purpose: { contains: search } },
        { departmentName: { contains: search } },
      ];
    }

    const orderBy: Record<string, string> = {};
    if (sortBy === 'maturity') orderBy.id = 'asc';
    if (sortBy === 'name') orderBy.name = 'asc';
    if (sortBy === 'knowledge') orderBy.id = 'asc';

    const [agents, total] = await Promise.all([
      db.agent.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          evolution: {
            select: {
              level: true,
              levelName: true,
              maturityScore: true,
              modelReadiness: true,
              totalKnowledge: true,
              evolutionPath: true,
            },
          },
          protectiveMode: {
            select: { enabled: true, safetyLevel: true },
          },
          _count: { select: { knowledge: true, learningSessions: true } },
        },
      }),
      db.agent.count({ where }),
    ]);

    return NextResponse.json({
      data: agents.map((a) => ({
        id: a.id,
        agentId: a.agentId,
        name: a.name,
        slug: a.slug,
        type: a.type,
        role: a.role,
        purpose: a.purpose,
        departmentId: a.departmentId,
        departmentName: a.departmentName,
        evolution: a.evolution,
        protectiveMode: a.protectiveMode,
        knowledgeCount: a._count.knowledge,
        sessionCount: a._count.learningSessions,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
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
