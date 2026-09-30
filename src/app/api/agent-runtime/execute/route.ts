import { NextRequest, NextResponse } from 'next/server';
import { getExecutionEngine } from '@/lib/agent-runtime';
import { getAuthUser } from '@/lib/api-auth';
import { db } from '@/lib/db';
import { z } from 'zod';

const ExecuteSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  task: z.string().min(1, 'task is required'),
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
  systemPrompt: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(z.string()).optional(),
  maxTokens: z.number().int().positive().max(128000).optional(),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  mode: z.enum(['sync', 'async']).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const parsed = ExecuteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const { agentId, task, priority, systemPrompt, context, tools, maxTokens, timeoutMs, mode } = parsed.data;

    // Verify agent exists
    const agent = await db.agent.findUnique({ where: { agentId: agentId } });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const engine = getExecutionEngine();
    const result = await engine.execute({
      agentId,
      companyId: 'default-company',
      userId: user.userId,
      task,
      priority,
      systemPrompt,
      context,
      tools,
      maxTokens,
      timeoutMs,
      mode,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('[/api/agent-runtime/execute]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    if (!taskId) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    }

    const engine = getExecutionEngine();
    const cancelled = engine.cancel(taskId);

    return NextResponse.json({ success: true, cancelled });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
