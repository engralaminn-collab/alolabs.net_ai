/**
 * Job Queue Manager — P8
 * ALO Labs AISMH
 *
 * In-process job queue backed by Prisma (JobQueue + QueueItem models).
 * No external dependencies (Bull/BullMQ).
 */

import { db } from '@/lib/db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EnqueueOptions {
  priority?: number;
  delayMs?: number;
  maxRetries?: number;
}

export interface JobResult {
  id: string;
  status: string;
  result?: string;
  error?: string;
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

export type JobHandler = (job: QueueItemData) => Promise<unknown>;

export interface QueueItemData {
  id: string;
  queueId: string;
  jobId: string | null;
  jobType: string;
  priority: number;
  payload: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  scheduledAt: Date | null;
  createdAt: Date;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toQueueItemData(item: {
  id: string;
  queueId: string;
  jobId: string | null;
  jobType: string;
  priority: number;
  payload: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  scheduledAt: Date | null;
  createdAt: Date;
}): QueueItemData {
  return item as unknown as QueueItemData;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure a JobQueue row exists for the given queueName.
 * If it doesn't exist yet, creates it.
 */
async function ensureQueue(queueName: string, maxRetries?: number): Promise<string> {
  let queue = await db.jobQueue.findUnique({ where: { name: queueName } });
  if (!queue) {
    queue = await db.jobQueue.create({
      data: {
        name: queueName,
        maxRetries: maxRetries ?? 3,
      },
    });
  }
  return queue.id;
}

/**
 * Add a job to a queue.
 */
export async function enqueue(
  queueName: string,
  jobType: string,
  payload: Record<string, unknown> | unknown[] | string | number | boolean | null,
  options?: EnqueueOptions,
): Promise<QueueItemData> {
  const queueId = await ensureQueue(queueName, options?.maxRetries);

  const scheduledAt = options?.delayMs
    ? new Date(Date.now() + options.delayMs)
    : null;

  const item = await db.queueItem.create({
    data: {
      queueId,
      jobType,
      priority: options?.priority ?? 0,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      maxAttempts: options?.maxRetries ?? 3,
      scheduledAt,
      status: 'queued',
    },
  });

  return toQueueItemData(item);
}

/**
 * Get the next available job from a queue (by priority desc, then FIFO).
 * Returns null if no jobs are available.
 */
export async function dequeue(queueName: string): Promise<QueueItemData | null> {
  const queue = await db.jobQueue.findUnique({ where: { name: queueName } });
  if (!queue) return null;

  const now = new Date();
  const item = await db.queueItem.findFirst({
    where: {
      queueId: queue.id,
      status: 'queued',
      OR: [
        { scheduledAt: null },
        { scheduledAt: { lte: now } },
      ],
    },
    orderBy: [
      { priority: 'desc' },
      { createdAt: 'asc' },
    ],
  });

  if (!item) return null;

  // Claim atomically: another replica may have selected the same row.
  const claim = await db.queueItem.updateMany({
    where: { id: item.id, status: 'queued' },
    data: { status: 'processing', startedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count === 0) return null;
  const updated = await db.queueItem.findUnique({ where: { id: item.id } });
  return updated ? toQueueItemData(updated) : null;
}

/**
 * Mark a job as completed.
 */
export async function completeJob(
  jobId: string,
  result?: Record<string, unknown> | string | number | boolean | null,
): Promise<QueueItemData> {
  const updateData: Record<string, unknown> = {
    status: 'completed',
    completedAt: new Date(),
    error: null,
  };

  if (result !== undefined) {
    updateData.payload = typeof result === 'string' ? result : JSON.stringify(result);
  }

  const item = await db.queueItem.update({
    where: { id: jobId },
    data: updateData,
  });

  return toQueueItemData(item);
}

/**
 * Mark a job as failed. Increments retry count; moves to DLQ (status='failed')
 * if max retries exceeded.
 */
export async function failJob(
  jobId: string,
  error: string,
): Promise<QueueItemData> {
  const existing = await db.queueItem.findUnique({ where: { id: jobId } });
  if (!existing) {
    throw new Error(`QueueItem ${jobId} not found`);
  }

  const isExhausted = existing.attempts + 1 >= existing.maxAttempts;

  const item = await db.queueItem.update({
    where: { id: jobId },
    data: {
      status: isExhausted ? 'failed' : 'queued',
      attempts: { increment: 1 },
      error,
      startedAt: isExhausted ? existing.startedAt : null,
      completedAt: isExhausted ? new Date() : null,
    },
  });

  return toQueueItemData(item);
}

/**
 * Get the current status of a job.
 */
export async function getJobStatus(jobId: string): Promise<QueueItemData | null> {
  const item = await db.queueItem.findUnique({ where: { id: jobId } });
  return item ? toQueueItemData(item) : null;
}

/**
 * Process all pending jobs in a queue using the provided handler.
 * Respects the queue's concurrency setting.
 */
export async function processQueue(
  queueName: string,
  handler: JobHandler,
): Promise<JobResult[]> {
  const queue = await db.jobQueue.findUnique({ where: { name: queueName } });
  if (!queue) throw new Error(`Queue '${queueName}' not found`);
  if (!queue.isActive) throw new Error(`Queue '${queueName}' is not active`);

  const results: JobResult[] = [];
  const concurrency = queue.concurrency;

  // Fetch up to `concurrency` jobs at a time
  const jobs = await db.queueItem.findMany({
    where: {
      queueId: queue.id,
      status: 'queued',
      OR: [
        { scheduledAt: null },
        { scheduledAt: { lte: new Date() } },
      ],
    },
    orderBy: [
      { priority: 'desc' },
      { createdAt: 'asc' },
    ],
    take: concurrency,
  });

  // Process jobs with limited concurrency
  const batches: QueueItemData[][] = [];
  for (let i = 0; i < jobs.length; i += concurrency) {
    batches.push(jobs.slice(i, i + concurrency).map(toQueueItemData));
  }

  for (const batch of batches) {
    const batchPromises = batch.map(async (job) => {
      // Atomic compare-and-set prevents two workers/replicas (or overlapping
      // polls) from executing the same job concurrently.
      const claim = await db.queueItem.updateMany({
        where: { id: job.id, status: 'queued' },
        data: {
          status: 'processing',
          startedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
      if (claim.count === 0) {
        return { id: job.id, status: 'skipped', error: 'Job already claimed by another worker' };
      }

      try {
        const result = await handler({ ...job, status: 'processing', startedAt: new Date() });
        const completed = await db.queueItem.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            error: null,
          },
        });
        results.push({
          id: completed.id,
          status: 'completed',
          result: result !== undefined ? JSON.stringify(result) : undefined,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const existing = await db.queueItem.findUnique({ where: { id: job.id } });
        const isExhausted = (existing?.attempts ?? 0) >= (existing?.maxAttempts ?? 3);

        const updated = await db.queueItem.update({
          where: { id: job.id },
          data: {
            status: isExhausted ? 'failed' : 'queued',
            error: errorMsg,
            startedAt: isExhausted ? job.startedAt : null,
            completedAt: isExhausted ? new Date() : null,
          },
        });
        results.push({
          id: updated.id,
          status: isExhausted ? 'failed' : 'queued',
          error: errorMsg,
        });
      }
    });

    await Promise.all(batchPromises);
  }

  return results;
}

/**
 * List all failed (dead letter) jobs for a queue.
 */
export async function getDeadLetterQueue(queueName: string): Promise<QueueItemData[]> {
  const queue = await db.jobQueue.findUnique({ where: { name: queueName } });
  if (!queue) return [];

  const items = await db.queueItem.findMany({
    where: {
      queueId: queue.id,
      status: 'failed',
    },
    orderBy: { completedAt: 'desc' },
  });

  return items.map(toQueueItemData);
}

/**
 * Re-enqueue a dead letter (failed) job for retry.
 */
export async function retryDeadLetterJob(jobId: string): Promise<QueueItemData> {
  const item = await db.queueItem.findUnique({ where: { id: jobId } });
  if (!item) throw new Error(`QueueItem ${jobId} not found`);
  if (item.status !== 'failed') {
    throw new Error(`Job ${jobId} is not in the dead letter queue (status: ${item.status})`);
  }

  const updated = await db.queueItem.update({
    where: { id: jobId },
    data: {
      status: 'queued',
      attempts: 0,
      error: null,
      startedAt: null,
      completedAt: null,
      scheduledAt: null,
    },
  });

  return toQueueItemData(updated);
}

/**
 * Get queue statistics: pending/completed/failed/cancelled counts.
 */
export async function getQueueStats(queueName: string): Promise<QueueStats> {
  const queue = await db.jobQueue.findUnique({ where: { name: queueName } });
  if (!queue) {
    return { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
  }

  const counts = await db.queueItem.groupBy({
    by: ['status'],
    where: { queueId: queue.id },
    _count: true,
  });

  const countMap: Record<string, number> = {};
  for (const c of counts) {
    countMap[c.status] = c._count;
  }

  const pending = countMap['queued'] ?? 0;
  const processing = countMap['processing'] ?? 0;
  const completed = countMap['completed'] ?? 0;
  const failed = countMap['failed'] ?? 0;
  const cancelled = countMap['cancelled'] ?? 0;
  const total = pending + processing + completed + failed + cancelled;

  return { pending, processing, completed, failed, cancelled, total };
}
