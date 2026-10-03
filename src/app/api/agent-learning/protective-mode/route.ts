import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  await requireAuth();

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId');

  if (agentId) {
    const config = await db.agentProtectiveMode.findUnique({
      where: { agentId },
      include: { agent: { select: { agentId: true, name: true, departmentName: true } } },
    });
    if (!config) {
      return NextResponse.json({
        data: {
          agentId,
          enabled: true,
          safetyLevel: 'standard',
          blockedPatterns: '[]',
          allowedDomains: '[]',
          maxKnowledgePerDay: 50,
          maxConfidence: 0.95,
          requireVerification: true,
          autoFilterToxic: true,
          learningScope: 'task_domain',
          dataRetentionDays: 90,
          violationCount: 0,
        },
      });
    }
    return NextResponse.json({
      data: {
        ...config,
        blockedPatterns: config.blockedPatterns,
        allowedDomains: config.allowedDomains,
      },
    });
  }

  // Get all protective mode configs with stats
  const [configs, total] = await Promise.all([
    db.agentProtectiveMode.findMany({
      include: { agent: { select: { agentId: true, name: true, departmentName: true } } },
      orderBy: { violationCount: 'desc' },
      take: 50,
    }),
    db.agentProtectiveMode.count(),
  ]);

  const disabledCount = await db.agent.count({ where: { status: 'active' } }) - total;
  const highViolationCount = await db.agentProtectiveMode.count({ where: { violationCount: { gte: 5 } } });

  return NextResponse.json({
    data: configs,
    stats: {
      total: configs.length,
      disabledAgents: disabledCount,
      highViolationCount,
      avgViolationCount: configs.length > 0
        ? Math.round(configs.reduce((s, c) => s + c.violationCount, 0) / configs.length * 10) / 10
        : 0,
    },
  });
}

export async function PUT(req: NextRequest) {
  await requireAuth();

  const body = await req.json();
  const { agentId, enabled, safetyLevel, blockedPatterns, allowedDomains, maxKnowledgePerDay, maxConfidence, requireVerification, autoFilterToxic, learningScope, dataRetentionDays } = body;

  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }

  const config = await db.agentProtectiveMode.upsert({
    where: { agentId },
    create: {
      agentId,
      enabled: enabled ?? true,
      safetyLevel: safetyLevel ?? 'standard',
      blockedPatterns: JSON.stringify(blockedPatterns || []),
      allowedDomains: JSON.stringify(allowedDomains || []),
      maxKnowledgePerDay: maxKnowledgePerDay ?? 50,
      maxConfidence: maxConfidence ?? 0.95,
      requireVerification: requireVerification ?? true,
      autoFilterToxic: autoFilterToxic ?? true,
      learningScope: learningScope ?? 'task_domain',
      dataRetentionDays: dataRetentionDays ?? 90,
    },
    update: {
      ...(enabled !== undefined && { enabled }),
      ...(safetyLevel && { safetyLevel }),
      ...(blockedPatterns && { blockedPatterns: JSON.stringify(blockedPatterns) }),
      ...(allowedDomains && { allowedDomains: JSON.stringify(allowedDomains) }),
      ...(maxKnowledgePerDay && { maxKnowledgePerDay }),
      ...(maxConfidence && { maxConfidence }),
      ...(requireVerification !== undefined && { requireVerification }),
      ...(autoFilterToxic !== undefined && { autoFilterToxic }),
      ...(learningScope && { learningScope }),
      ...(dataRetentionDays && { dataRetentionDays }),
      updatedAt: new Date(),
    },
  });

  return NextResponse.json({ data: config });
}
