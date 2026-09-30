/**
 * ALO Labs AI-EOS — Conversations API
 * GET  /           — List conversations for current user
 * GET  /[id]       — Get conversation with messages
 * DELETE /[id]     — Archive a conversation
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api-auth';
import { getOrchestrator } from '@/lib/orchestrator';
import { db } from '@/lib/db';

// ─── GET: List conversations ──────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser() || { userId: 'anonymous', role: 'viewer' };
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('id');

    if (conversationId) {
      // Get single conversation with messages
      const orchestrator = getOrchestrator();
      const conversation = await orchestrator.getConversation(conversationId);

      if (!conversation) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      return NextResponse.json({ success: true, data: conversation });
    }

    // List conversations
    const orchestrator = getOrchestrator();
    const conversations = await orchestrator.listConversations(user.userId);

    return NextResponse.json({
      success: true,
      data: conversations.map(c => ({
        id: c.id,
        title: c.title,
        agentId: c.agentId,
        status: c.status,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        lastMessage: c.messages[0] || null,
        messageCount: undefined,
      })),
    });
  } catch (error) {
    console.error('[/api/enterprise/conversations]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

// ─── DELETE: Archive a conversation ───────────────────────────────
export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthUser() || { userId: 'anonymous', role: 'viewer' };
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('id');

    if (!conversationId) {
      return NextResponse.json({ error: 'Conversation ID required' }, { status: 400 });
    }

    await db.conversation.update({
      where: { id: conversationId },
      data: { status: 'archived' },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[/api/enterprise/conversations DELETE]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
