import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { EvolutionTracker, EVOLUTION_LEVELS } from '@/lib/agent-learning';

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId');
  const level = searchParams.get('level');
  const path = searchParams.get('path');
  const minMaturity = parseFloat(searchParams.get('minMaturity') || '0');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');

  const where: Record<string, unknown> = {};
  if (agentId) where.agentId = agentId;
  if (level) where.level = parseInt(level);
  if (path) where.evolutionPath = path;
  if (minMaturity > 0) where.maturityScore = { gte: minMaturity };

  const [data, total] = await Promise.all([
    db.agentEvolution.findMany({
      where,
      orderBy: [{ maturityScore: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        agent: { select: { agentId: true, name: true, departmentName: true, role: true, type: true, status: true } },
      },
    }),
    db.agentEvolution.count({ where }),
  ]);

  return NextResponse.json({
    data: data.map(e => ({
      id: e.id,
      agentId: e.agent.agentId,
      agentName: e.agent.name,
      department: e.agent.departmentName,
      role: e.agent.role,
      type: e.agent.type,
      level: e.level,
      levelName: e.levelName,
      totalKnowledge: e.totalKnowledge,
      totalSessions: e.totalSessions,
      totalCorrections: e.totalCorrections,
      avgConfidence: e.avgConfidence,
      maturityScore: e.maturityScore,
      knowledgeDensity: e.knowledgeDensity,
      protectiveScore: e.protectiveScore,
      modelReadiness: e.modelReadiness,
      domainCoverage: JSON.parse(e.domainCoverage || '[]'),
      strengthAreas: JSON.parse(e.strengthAreas || '[]'),
      weakAreas: JSON.parse(e.weakAreas || '[]'),
      evolutionPath: e.evolutionPath,
      lastEvolvedAt: e.lastEvolvedAt,
      nextEvolutionAt: e.nextEvolutionAt,
      achievements: JSON.parse(e.achievements || '[]'),
      createdAt: e.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    levels: EVOLUTION_LEVELS,
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const body = await req.json();
  const { agentId, evolutionPath } = body;

  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {};
  if (evolutionPath) updateData.evolutionPath = evolutionPath;

  const evolution = await db.agentEvolution.upsert({
    where: { agentId },
    create: { agentId, ...updateData },
    update: updateData,
  });

  return NextResponse.json({ data: evolution });
}
