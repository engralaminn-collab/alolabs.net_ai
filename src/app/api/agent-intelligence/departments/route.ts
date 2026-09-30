import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    await requireAuth();

    const departments = await db.department.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        _count: { select: { agents: true } },
        agents: {
          select: {
            id: true,
            name: true,
            type: true,
            role: true,
            evolution: {
              select: {
                level: true,
                levelName: true,
                maturityScore: true,
                modelReadiness: true,
              },
            },
            _count: { select: { knowledge: true, learningSessions: true } },
          },
        },
      },
    });

    const result = departments.map((dept) => {
      const agents = dept.agents;
      const totalKnowledge = agents.reduce(
        (sum, a) => sum + a._count.knowledge,
        0
      );
      const avgMaturity =
        agents.reduce(
          (sum, a) => sum + (a.evolution?.maturityScore || 0),
          0
        ) / (agents.length || 1);
      const avgReadiness =
        agents.reduce(
          (sum, a) => sum + (a.evolution?.modelReadiness || 0),
          0
        ) / (agents.length || 1);

      // Level distribution
      const levelDist: Record<string, number> = {};
      agents.forEach((a) => {
        const lvl = a.evolution?.levelName || 'Novice';
        levelDist[lvl] = (levelDist[lvl] || 0) + 1;
      });

      // Type distribution
      const typeDist: Record<string, number> = {};
      agents.forEach((a) => {
        typeDist[a.type] = (typeDist[a.type] || 0) + 1;
      });

      return {
        id: dept.id,
        name: dept.name,
        slug: dept.slug,
        description: dept.description,
        agentCount: agents.length,
        totalKnowledge,
        avgMaturity: Math.round(avgMaturity * 10) / 10,
        avgModelReadiness: Math.round(avgReadiness * 10) / 10,
        levelDistribution: levelDist,
        typeDistribution: typeDist,
        topAgents: agents
          .sort(
            (a, b) =>
              (b.evolution?.maturityScore || 0) -
              (a.evolution?.maturityScore || 0)
          )
          .slice(0, 5)
          .map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            role: a.role,
            evolution: a.evolution,
            knowledgeCount: a._count.knowledge,
          })),
      };
    });

    // Global stats
    const allStats = {
      totalDepartments: result.length,
      totalAgents: result.reduce((s, d) => s + d.agentCount, 0),
      totalKnowledge: result.reduce((s, d) => s + d.totalKnowledge, 0),
      avgMaturity:
        Math.round(
          result.reduce((s, d) => s + d.avgMaturity, 0) /
            (result.length || 1) *
            10
        ) / 10,
      avgModelReadiness:
        Math.round(
          result.reduce((s, d) => s + d.avgModelReadiness, 0) /
            (result.length || 1) *
            10
        ) / 10,
    };

    return NextResponse.json({ data: result, global: allStats });
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
