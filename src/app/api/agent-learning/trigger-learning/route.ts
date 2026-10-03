import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { LearningEngine } from '@/lib/agent-learning';
import { db } from '@/lib/db';

export async function POST(req: Request) {
  await requireAuth();

  const body = await req.json();
  const { agentId, triggerType, triggerDetail, taskOutput, taskInput, wasSuccess, error, corrections, insights } = body;

  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }

  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  const engine = new LearningEngine();
  const result = await engine.learn({
    agentId,
    triggerType: triggerType || 'manual',
    triggerDetail,
    taskOutput,
    taskInput,
    wasSuccess,
    error,
    corrections,
    insights,
  });

  return NextResponse.json({ data: result });
}

/**
 * Trigger learning for multiple agents at once (e.g., department-wide training)
 */
export async function PUT(req: Request) {
  await requireAuth();

  const body = await req.json();
  const { agentIds, triggerType, insights } = body;

  if (!agentIds || !Array.isArray(agentIds)) {
    return NextResponse.json({ error: 'agentIds array required' }, { status: 400 });
  }

  const engine = new LearningEngine();
  const inputs = agentIds.map((id: string) => ({
    agentId: id,
    triggerType: triggerType || 'manual',
    insights: insights || [],
  }));

  const results = await engine.batchLearn(inputs);

  return NextResponse.json({
    data: Object.fromEntries(results),
    totalAgents: inputs.length,
    successful: results.size,
  });
}
