import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { db } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    await requireAuth();
    const body = await req.json();
    const { agentId, message, conversationId } = body;

    if (!agentId || !message) {
      return NextResponse.json({ error: 'agentId and message required' }, { status: 400 });
    }

    // Find agent with knowledge and evolution
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      include: {
        knowledge: {
          where: { confidence: { gte: 0.4 }, isVerified: true },
          orderBy: { confidence: 'desc' },
          take: 30,
        },
        evolution: true,
        protectiveMode: true,
        department: true,
      },
    });

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Build agent context from knowledge
    const knowledgeContext = agent.knowledge
      .map((k) => '[' + k.category + '] ' + k.content)
      .join('\n');
    const avgConfidence =
      agent.knowledge.length > 0
        ? agent.knowledge.reduce((sum, k) => sum + k.confidence, 0) /
          agent.knowledge.length
        : 0;

    // Build system prompt using agent's own knowledge and profile
    const systemPrompt = `You are ${agent.name}, a ${agent.role} AI agent in the ${agent.department.name} department.

Your purpose: ${agent.purpose}

Your capabilities: ${agent.allowedSkills}

Your evolution level: ${agent.evolution?.levelName || 'Novice'} (Level ${agent.evolution?.level || 1})
Maturity Score: ${agent.evolution?.maturityScore?.toFixed(1) || 0}/100
Model Readiness: ${agent.evolution?.modelReadiness?.toFixed(1) || 0}/100

Your accumulated knowledge (${agent.knowledge.length} entries, ${avgConfidence > 0 ? (avgConfidence * 100).toFixed(0) + '% confidence' : 'no knowledge yet'}):
${knowledgeContext}

Based on your knowledge and expertise, provide a thorough, professional response. If you don't have specific knowledge about something, say so honestly and suggest what you would need to learn. Always be helpful, accurate, and demonstrate your domain expertise.`;

    return NextResponse.json({
      success: true,
      agent: {
        id: agent.id,
        agentId: agent.agentId,
        name: agent.name,
        department: agent.department.name,
        type: agent.type,
        role: agent.role,
        evolution: {
          level: agent.evolution?.level || 1,
          levelName: agent.evolution?.levelName || 'Novice',
          maturityScore: agent.evolution?.maturityScore || 0,
          modelReadiness: agent.evolution?.modelReadiness || 0,
        },
        knowledgeCount: agent.knowledge.length,
        avgConfidence,
      },
      systemPrompt,
      knowledgeEntries: agent.knowledge.length,
      timestamp: new Date().toISOString(),
    });
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
