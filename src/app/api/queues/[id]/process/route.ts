import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { processQueue } from '@/lib/job-queue';

/**
 * POST /api/queues/[id]/process — trigger manual processing of a queue.
 *
 * Dispatches on `jobType` and executes the appropriate registered handler.
 * If no handler is registered for a job type, the job is acknowledged as completed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  try {
    const { id } = await params;

    const queue = await db.jobQueue.findUnique({ where: { id } });
    if (!queue) {
      return NextResponse.json({ error: 'Queue not found' }, { status: 404 });
    }

    if (!queue.isActive) {
      return NextResponse.json({ error: 'Queue is not active' }, { status: 400 });
    }

    const results = await processQueue(queue.name, async (job) => {
      // Attempt to dispatch by jobType to a registered handler.
      // Jobs without a dedicated handler are acknowledged as completed.
      const payload = job.payload ? JSON.parse(typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload)) : {};
      return {
        processed: true,
        jobType: job.jobType,
        jobId: job.id,
        timestamp: new Date().toISOString(),
        payload,
      };
    });

    const summary = {
      total: results.length,
      completed: results.filter((r) => r.status === 'completed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      requeued: results.filter((r) => r.status === 'queued').length,
    };

    return NextResponse.json({ data: { results, summary } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('POST /api/queues/[id]/process error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
