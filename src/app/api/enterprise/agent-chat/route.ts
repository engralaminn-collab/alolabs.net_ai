import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { getExecutionEngine, loadConversationHistory, persistConversationMessages } from '@/lib/agent-runtime';
import { buildConversationMessages } from '@/lib/agent-runtime/pipeline';
import { db } from '@/lib/db';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const AgentChatSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  message: z.string().min(1, 'message is required'),
  conversationId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth();

    const body = await request.json();
    const parsed = AgentChatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const { agentId, message, conversationId } = parsed.data;
    const convId = conversationId || randomUUID();
    const startTime = Date.now();

    // Load agent record for department info
    const agent = await db.agent.findUnique({
      where: { agentId },
      select: { id: true, name: true, departmentId: true, role: true, type: true },
    });

    if (!agent) {
      return NextResponse.json(
        { error: `Agent ${agentId} not found` },
        { status: 404 },
      );
    }

    // Load conversation history for multi-turn support
    const history = await loadConversationHistory(convId, 10);
    const historyMessages = buildConversationMessages(history);

    // Execute via the unified Agent Runtime pipeline
    const engine = getExecutionEngine();
    const taskResult = await engine.execute({
      agentId,
      companyId: 'default-company',
      userId: user.userId,
      task: message,
      mode: 'sync',
      context: historyMessages.length > 0 ? { conversationHistory: historyMessages } : undefined,
    });

    const latencyMs = Date.now() - startTime;

    if (!taskResult.result) {
      return NextResponse.json(
        { error: taskResult.error?.message || 'Agent execution returned no result' },
        { status: 502 },
      );
    }

    const result = taskResult.result;
    const metadata = result.metadata as Record<string, unknown> | undefined;
    const model = (metadata?.model as string) || 'unknown';
    const contextTokens = (metadata?.contextTokens as number) || 0;
    const contextSources = (metadata?.contextSources as string) || '';
    const taskClassification = (metadata?.taskClassification as string) || 'balanced';
    const validationScore = (metadata?.validationScore as number) || 0;
    const validationPassed = (metadata?.validationPassed as boolean) ?? true;
    const ragResults = (metadata?.ragResults as number) || 0;

    // Persist conversation for multi-turn support
    await persistConversationMessages({
      conversationId: convId,
      userId: user.userId,
      agentId,
      departmentId: agent.departmentId,
      userMessage: message,
      agentResponse: result.content,
      model,
      latencyMs,
      contextSources,
      contextTokens,
      confidence: result.confidence,
    }).catch(() => { /* best-effort persistence */ });

    return NextResponse.json({
      success: true,
      data: {
        content: result.content,
        confidence: result.confidence,
        model,
        latencyMs,
        contextTokens,
        contextSources,
        conversationId: convId,
        pipeline: {
          taskClassification,
          validationScore,
          validationPassed,
          ragResults,
        },
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    console.error('[/api/enterprise/agent-chat]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
