import { NextRequest, NextResponse } from 'next/server';
import { getMemoryStore } from '@/lib/memory';
import { getAuthUser } from '@/lib/api-auth';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const store = getMemoryStore();

    const entry = await store.get(id);
    if (!entry) {
      return NextResponse.json({ error: 'Memory entry not found' }, { status: 404 });
    }

    await store.delete(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[/api/memory/[id]] DELETE error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
