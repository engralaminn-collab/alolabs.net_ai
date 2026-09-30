import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { getOrchestrator } from '@/lib/multi-agent-orchestrator';

export async function GET(request: NextRequest) {
  try {
    await requireAuth();

    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');

    if (!taskId) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'taskId query parameter is required',
        },
      }, { status: 400 });
    }

    const orchestrator = getOrchestrator();
    const task = orchestrator.getTaskStatus(taskId);

    if (!task) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Orchestration task ${taskId} not found`,
        },
      }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: {
        taskId: task.id,
        type: task.type,
        status: task.status,
        priority: task.priority,
        input: task.input,
        error: task.error,
        steps: task.steps.map((s) => ({
          id: s.id,
          agentId: s.agentId,
          status: s.status,
          latencyMs: s.latencyMs,
          error: s.error,
          startedAt: s.startedAt?.toISOString() ?? null,
          completedAt: s.completedAt?.toISOString() ?? null,
        })),
        result: task.result
          ? {
              finalOutput: task.result.finalOutput,
              totalLatencyMs: task.result.totalLatencyMs,
              totalTokens: task.result.totalTokens,
              costUsd: task.result.costUsd,
              agentIds: task.result.agentIds,
              modelUsed: task.result.modelUsed,
            }
          : null,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      }, { status: 401 });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Forbidden' },
      }, { status: 403 });
    }
    console.error('[/api/enterprise/orchestrator/status]', error);
    return NextResponse.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Internal server error',
      },
    }, { status: 500 });
  }
}
