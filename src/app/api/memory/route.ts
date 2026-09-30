import { NextRequest, NextResponse } from 'next/server';
import { getMemoryStore } from '@/lib/memory';
import { getAuthUser } from '@/lib/api-auth';

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { type, key, content, agentId, scope, rank } = body;

    if (!type || !key || !content) {
      return NextResponse.json({ error: 'type, key, and content are required' }, { status: 400 });
    }

    const store = getMemoryStore();
    const companyId = user.userId;

    let entry;
    switch (type) {
      case 'short_term':
        entry = await store.addShortTerm({ agentId: agentId ?? '', companyId, userId: user.userId, key, content });
        break;
      case 'long_term':
        entry = await store.addLongTerm({ agentId, companyId, userId: user.userId, key, content, scope, rank });
        break;
      case 'episodic':
        entry = await store.addEpisodic({ agentId: agentId ?? '', companyId, userId: user.userId, content, metadata: body.metadata });
        break;
      default:
        return NextResponse.json({ error: `Unknown memory type: ${type}` }, { status: 400 });
    }

    return NextResponse.json({ success: true, data: entry });
  } catch (error) {
    console.error('[/api/memory]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 });
    }

    const store = getMemoryStore();
    const entry = await store.get(id);
    if (!entry) {
      return NextResponse.json({ error: 'Memory entry not found' }, { status: 404 });
    }

    await store.delete(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[/api/memory] DELETE error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');
    const agentId = searchParams.get('agentId');
    const type = searchParams.get('type') as 'short_term' | 'long_term' | 'episodic' | undefined;
    const companyId = user.userId;

    const store = getMemoryStore();

    if (query) {
      const results = await store.search({ text: query, agentId: agentId ?? undefined, companyId, type, limit: 50 });
      return NextResponse.json({ success: true, data: results, total: results.length });
    }

    if (agentId) {
      const memories = await store.getByAgent(agentId, type);
      return NextResponse.json({ success: true, data: memories, total: memories.length });
    }

    // Stats
    const stats = await store.getStats();
    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    console.error('[/api/memory]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
