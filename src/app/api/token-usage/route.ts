import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/token-usage — list token usage records
export async function GET(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get('companyId');
    const agentId = searchParams.get('agentId');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const limit = Math.min(200, parseInt(searchParams.get('limit') || '50'));
    const offset = parseInt(searchParams.get('offset') || '0');

    const where: Record<string, unknown> = {};

    if (companyId) where.companyId = companyId;
    if (agentId) where.agentId = agentId;

    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Record<string, unknown>).gte = new Date(from);
      if (to) (where.createdAt as Record<string, unknown>).lte = new Date(to);
    }

    const [records, total] = await Promise.all([
      db.tokenUsage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.tokenUsage.count({ where }),
    ]);

    // Compute aggregates
    const aggResult = await db.tokenUsage.aggregate({
      where,
      _sum: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        costEstimate: true,
      },
      _count: true,
    });

    const data = records.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      agentId: r.agentId,
      taskId: r.taskId,
      model: r.model,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      costEstimate: r.costEstimate,
      createdAt: r.createdAt.toISOString(),
    }));

    return NextResponse.json({
      data,
      total,
      limit,
      offset,
      aggregates: {
        count: aggResult._count,
        totalPromptTokens: aggResult._sum.promptTokens || 0,
        totalCompletionTokens: aggResult._sum.completionTokens || 0,
        totalTokens: aggResult._sum.totalTokens || 0,
        totalCostEstimate: aggResult._sum.costEstimate || 0,
      },
    });
  } catch (error) {
    console.error('GET /api/token-usage error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/token-usage — record token usage (checks budget, returns blocked if over limit)
export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const body = await request.json();
    const { companyId, agentId, taskId, model, promptTokens, completionTokens, totalTokens, costEstimate } = body;

    if (!companyId || typeof companyId !== 'string') {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    const tokens = typeof totalTokens === 'number'
      ? totalTokens
      : (typeof promptTokens === 'number' ? promptTokens : 0) +
        (typeof completionTokens === 'number' ? completionTokens : 0);

    // Check budget before recording
    const budget = await db.tokenBudget.findUnique({ where: { companyId } });
    if (budget) {
      const projectedMonthly = budget.monthlyUsed + tokens;
      const projectedDaily = budget.dailyUsed + tokens;

      const monthlyPercent = budget.monthlyBudget > 0
        ? projectedMonthly / budget.monthlyBudget
        : 0;
      const dailyPercent = budget.dailyBudget > 0
        ? projectedDaily / budget.dailyBudget
        : 0;

      if (monthlyPercent >= budget.blockThreshold || dailyPercent >= budget.blockThreshold) {
        return NextResponse.json(
          {
            blocked: true,
            error: 'Token budget exceeded',
            details: {
              monthlyUsed: budget.monthlyUsed,
              monthlyBudget: budget.monthlyBudget,
              dailyUsed: budget.dailyUsed,
              dailyBudget: budget.dailyBudget,
              requestedTokens: tokens,
            },
          },
          { status: 429 }
        );
      }

      // Update budget usage
      await db.tokenBudget.update({
        where: { companyId },
        data: {
          monthlyUsed: projectedMonthly,
          dailyUsed: projectedDaily,
        },
      });
    }

    // Record usage
    const record = await db.tokenUsage.create({
      data: {
        companyId,
        agentId: agentId || null,
        taskId: taskId || null,
        model: model || 'deepseek-v3',
        promptTokens: typeof promptTokens === 'number' ? promptTokens : 0,
        completionTokens: typeof completionTokens === 'number' ? completionTokens : 0,
        totalTokens: tokens,
        costEstimate: typeof costEstimate === 'number' ? costEstimate : 0,
      },
    });

    return NextResponse.json({
      data: {
        blocked: false,
        ...record,
        createdAt: record.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('POST /api/token-usage error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT /api/token-usage — update a usage record
export async function PUT(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const body = await request.json();
    const { id, promptTokens, completionTokens, totalTokens, costEstimate, model } = body;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const existing = await db.tokenUsage.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'Token usage record not found' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (promptTokens !== undefined) updateData.promptTokens = promptTokens;
    if (completionTokens !== undefined) updateData.completionTokens = completionTokens;
    if (totalTokens !== undefined) updateData.totalTokens = totalTokens;
    if (costEstimate !== undefined) updateData.costEstimate = costEstimate;
    if (model !== undefined) updateData.model = model;

    const updated = await db.tokenUsage.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      data: {
        ...updated,
        createdAt: updated.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('PUT /api/token-usage error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}