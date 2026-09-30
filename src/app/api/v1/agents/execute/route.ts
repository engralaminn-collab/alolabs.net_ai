import { NextRequest, NextResponse } from 'next/server';
import { getExecutionEngine } from '@/lib/agent-runtime';
import { getAuthUser } from '@/lib/api-auth';
import { db } from '@/lib/db';

/**
 * V1 Agent Execute — now backed by the real Agent Execution Engine.
 * Legacy endpoint, forwards to /api/agent-runtime/execute
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { agentId, message, sessionId } = body;

    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      return NextResponse.json(
        { error: 'agentId is required and must be a non-empty string' },
        { status: 400 },
      );
    }

    const taskInput = typeof message === 'string' ? message : JSON.stringify(message);
    if (!taskInput || taskInput.trim().length === 0) {
      return NextResponse.json(
        { error: 'message is required' },
        { status: 400 },
      );
    }

    // Verify agent exists
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Execute via real engine
    const engine = getExecutionEngine();
    const result = await engine.execute({
      agentId,
      companyId: user.userId,
      userId: user.userId,
      task: taskInput,
      mode: 'async',
      context: sessionId ? { sessionId } : undefined,
    });

    return NextResponse.json({
      success: true,
      data: {
        agentId,
        sessionId: sessionId ?? null,
        taskId: result.id,
        status: result.status,
        message: `Agent "${agentId}" execution ${result.status}.`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[/api/v1/agents/execute]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}