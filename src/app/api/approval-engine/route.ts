import { NextRequest, NextResponse } from 'next/server';
import { getApprovalEngine } from '@/lib/approval-engine';
import { getAuthUser } from '@/lib/api-auth';
import { z } from 'zod';

const SubmitSchema = z.object({
  agentId: z.string().optional(),
  action: z.string().min(1),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  description: z.string().min(1),
  taskId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  cost: z.number().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const parsed = SubmitSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 });
    }

    const engine = getApprovalEngine();
    const result = await engine.submit({
      ...parsed.data,
      companyId: user.userId ?? user.userId,
      userId: user.userId,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('[/api/approval-engine]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const view = searchParams.get('view');
    const companyId = user.userId ?? user.userId;
    const engine = getApprovalEngine();

    if (view === 'pending') {
      return NextResponse.json({ success: true, data: engine.getPending(companyId) });
    }
    if (view === 'history') {
      return NextResponse.json({ success: true, data: engine.getHistory(companyId) });
    }

    return NextResponse.json({ success: true, data: engine.getStats(companyId) });
  } catch (error) {
    console.error('[/api/approval-engine]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
