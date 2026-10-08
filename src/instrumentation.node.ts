/**
 * ALO Labs AgentOS — Server instrumentation (worker bootstrap)
 *
 * Next.js calls `register()` once when the server process starts. We use it
 * to run the durable AgentOS job worker inside the standalone server:
 *
 *  - polls the Prisma-backed `agentos` queue and dispatches jobs
 *    (agentos.run → Master Orchestrator pipeline,
 *     agentos.workflow → Workflow Engine,
 *     agentos.command → command run)
 *  - recovers stale `processing` queue items on boot, so a server restart
 *    never destroys a running workflow (jobs are re-queued, not lost)
 *
 * The queue itself is durable (JobQueue/QueueItem tables); this worker is
 * just the executor. Multiple replicas each poll — queue items are claimed
 * by status transition, and `processQueue` is concurrency-limited.
 *
 * IMPORTANT: this file is bundled for BOTH the nodejs and edge runtimes.
 * All Node-only imports (Prisma, the run pipeline) are therefore loaded
 * lazily inside the worker, never at module top level.
 */

const POLL_INTERVAL_MS = 3000;
const STALE_PROCESSING_MS = 10 * 60 * 1000; // 10 minutes

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

type DbClient = typeof import('@/lib/db')['db'];
type ExecuteRunFn = typeof import('@/lib/runs')['executeRun'];
type ExecuteWorkflowRunFn = typeof import('@/lib/workflow-engine')['executeWorkflowRun'];
type PlanResultT = import('@/lib/runs/planner').PlanResult;

async function recoverStaleJobs(db: DbClient): Promise<void> {
  try {
    // Make sure the durable queue row exists (idempotent).
    await db.jobQueue.upsert({
      where: { name: 'agentos' },
      update: { isActive: true },
      create: { id: 'agentos-queue', name: 'agentos', isActive: true, maxRetries: 3 },
    });
  } catch { /* queue bootstrap is best-effort */ }

  try {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const result = await db.queueItem.updateMany({
      where: {
        status: 'processing',
        startedAt: { lt: staleBefore },
      },
      data: { status: 'queued', startedAt: null },
    });
    if (result.count > 0) {
      console.log(`[AgentOS worker] recovered ${result.count} stale queue item(s)`);
    }
  } catch (error) {
    console.error('[AgentOS worker] stale job recovery failed:', error);
  }
}

async function handleJob(
  job: import('@/lib/job-queue').QueueItemData,
  deps: {
    db: DbClient;
    executeRun: ExecuteRunFn;
    executeWorkflowRun: ExecuteWorkflowRunFn;
  },
): Promise<unknown> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(job.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  switch (job.jobType) {
    case 'agentos.run': {
      const runId = typeof payload.runId === 'string' ? payload.runId : null;
      if (!runId) throw new Error('agentos.run job missing runId');
      await deps.executeRun(runId);
      return { runId };
    }
    case 'agentos.workflow': {
      const runId = typeof payload.runId === 'string' ? payload.runId : null;
      const workflowRunId = typeof payload.workflowRunId === 'string' ? payload.workflowRunId : null;
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
      if (!runId || !workflowRunId) throw new Error('agentos.workflow job missing runId/workflowRunId');
      // Load the persisted plan from the run record.
      const run = await deps.db.agentOSRun.findUnique({ where: { id: runId }, select: { plan: true } });
      let plan: PlanResultT = { steps: [], strategy: 'heuristic', reasoning: 'empty' };
      try {
        const parsed = JSON.parse(run?.plan ?? '{}') as Partial<PlanResultT>;
        if (Array.isArray(parsed.steps)) {
          plan = { steps: parsed.steps, strategy: parsed.strategy ?? 'heuristic', reasoning: parsed.reasoning ?? '' };
        }
      } catch { /* keep default empty plan */ }
      await deps.executeWorkflowRun(runId, workflowRunId, plan, taskId ?? undefined);
      return { runId, workflowRunId };
    }
    case 'agentos.command': {
      const runId = typeof payload.runId === 'string' ? payload.runId : null;
      if (!runId) throw new Error('agentos.command job missing runId');
      await deps.executeRun(runId);
      return { runId };
    }
    default:
      throw new Error(`Unknown job type: ${job.jobType}`);
  }
}

function startWorker(): void {
  if (started) return;
  started = true;

  console.log('[AgentOS worker] starting durable queue worker');

  // Lazy Node-only imports — this module is also bundled for the edge
  // runtime, where Prisma/node:crypto must never be loaded.
  void (async () => {
    const [{ db }, { processQueue }, { RUN_QUEUE, executeRun }, { executeWorkflowRun }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/job-queue'),
      import('@/lib/runs'),
      import('@/lib/workflow-engine'),
    ]);

    await recoverStaleJobs(db);

    let polling = false;
    const pollOnce = async (): Promise<void> => {
      if (polling) return; // do not overlap long-running batches
      polling = true;
      try {
        await processQueue(RUN_QUEUE, (job) => handleJob(job, { db, executeRun, executeWorkflowRun }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('not found')) {
          console.error('[AgentOS worker] queue processing error:', error);
        }
      } finally {
        polling = false;
      }
    };

    void pollOnce();
    timer = setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);
    // Do not keep the process alive solely for the poller.
    if (typeof timer.unref === 'function') timer.unref();
  })().catch((error) => {
    console.error('[AgentOS worker] failed to start:', error);
  });
}

export async function registerNodeWorker(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // In Next.js dev, register() runs per server start — guard with globalThis.
  const globalForWorker = globalThis as unknown as { __agentosWorkerStarted?: boolean };
  if (globalForWorker.__agentosWorkerStarted) return;
  globalForWorker.__agentosWorkerStarted = true;
  startWorker();
}
