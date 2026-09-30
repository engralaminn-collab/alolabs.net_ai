import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { EvolutionTracker } from '@/lib/agent-learning';
import { EVOLUTION_LEVELS } from '@/lib/agent-learning';

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const tracker = new EvolutionTracker();
  const globalStats = await tracker.getGlobalStats();

  // Top evolving agents
  const topAgents = await db.agentEvolution.findMany({
    orderBy: [{ maturityScore: 'desc' }],
    take: 10,
    include: {
      agent: {
        select: { agentId: true, name: true, departmentName: true, role: true, type: true },
      },
    },
  });

  // Recent learning sessions
  const recentSessions = await db.agentLearningSession.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      agent: { select: { agentId: true, name: true, departmentName: true } },
    },
  });

  // Knowledge distribution by category
  const knowledgeByCategory = await db.agentKnowledge.groupBy({
    by: ['category'],
    _count: true,
    _avg: { confidence: true },
  });

  // Learning activity timeline (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentSessionsList = await db.agentLearningSession.findMany({
    where: { createdAt: { gte: sevenDaysAgo } },
    select: { createdAt: true },
  });

  // Group by date
  const dailyMap = new Map<string, number>();
  for (const s of recentSessionsList) {
    const day = s.createdAt.toISOString().slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
  }
  const dailyLearningRate = Array.from(dailyMap.entries())
    .map(([date, count]) => ({ date, sessions: count }))
    .sort((a, b) => b.date.localeCompare(a.date));

  // Evolution level distribution with full info
  const levelDetails = EVOLUTION_LEVELS.map(lvl => {
    const dist = globalStats.levelDistribution.find(d => d.level === lvl.level);
    return {
      level: lvl.level,
      name: lvl.name,
      count: dist?.count || 0,
      minMaturity: lvl.minMaturity,
      minKnowledge: lvl.minKnowledge,
    };
  });

  return NextResponse.json({
    global: globalStats,
    topAgents: topAgents.map(e => ({
      agentId: e.agent.agentId,
      name: e.agent.name,
      department: e.agent.departmentName,
      role: e.agent.role,
      type: e.agent.type,
      level: e.level,
      levelName: e.levelName,
      maturityScore: e.maturityScore,
      modelReadiness: e.modelReadiness,
      totalKnowledge: e.totalKnowledge,
      avgConfidence: e.avgConfidence,
      evolutionPath: e.evolutionPath,
      achievements: JSON.parse(e.achievements || '[]'),
    })),
    recentSessions: recentSessions.map(s => ({
      id: s.id,
      agentId: s.agent?.agentId,
      agentName: s.agent?.name,
      department: s.agent?.departmentName,
      triggerType: s.triggerType,
      knowledgeGained: s.knowledgeAfter - s.knowledgeBefore,
      insights: JSON.parse(s.insights || '[]'),
      corrections: JSON.parse(s.corrections || '[]'),
      durationMs: s.durationMs,
      status: s.status,
      createdAt: s.createdAt,
    })),
    knowledgeByCategory: knowledgeByCategory.map(c => ({
      category: c.category,
      count: c._count,
      avgConfidence: Math.round((c._avg.confidence || 0) * 100),
    })),
    dailyLearningRate,
    levelDetails,
  });
}
