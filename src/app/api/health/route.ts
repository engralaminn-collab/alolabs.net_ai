/**
 * GET /api/health
 * Public comprehensive health check — no auth required.
 * Returns per-subsystem status, overall status, uptime, and version.
 */

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isQdrantConnected, getQdrantConfig } from '@/lib/qdrant';
import { getAgentStateManager } from '@/lib/agent-runtime/state';
import { getAgentScheduler } from '@/lib/agent-runtime/scheduler';

const VERSION = '1.0.0';

type CheckStatus = 'healthy' | 'degraded' | 'unhealthy';

interface SubsystemCheck {
  status: CheckStatus;
  latencyMs?: number;
  detail: string;
}

// ─── Individual check helpers ─────────────────────────────────────

async function checkDatabase(): Promise<SubsystemCheck & { latencyMs: number }> {
  try {
    const t0 = Date.now();
    await db.$queryRaw`SELECT 1 as ok`;
    const latencyMs = Date.now() - t0;
    return { status: 'healthy', latencyMs, detail: 'SQLite connected' };
  } catch (err: unknown) {
    return {
      status: 'unhealthy',
      latencyMs: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkMemory(): Promise<SubsystemCheck> {
  try {
    const [stCount, ltCount] = await Promise.all([
      db.memoryShortTerm.count(),
      db.memoryLongTerm.count(),
    ]);
    const total = stCount + ltCount;
    return { status: 'healthy', detail: `${total} entries (short: ${stCount}, long: ${ltCount})` };
  } catch (err: unknown) {
    return {
      status: 'degraded',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkAIRouter(): Promise<SubsystemCheck> {
  try {
    const { getRouter } = await import('@/lib/ai-router');
    const router = getRouter();
    const providers = router.getRegisteredProviders();
    if (providers.length === 0) {
      return { status: 'degraded', detail: '0 providers registered' };
    }
    return { status: 'healthy', detail: `${providers.length} provider(s) ready` };
  } catch (err: unknown) {
    return {
      status: 'unhealthy',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkRAG(): Promise<SubsystemCheck> {
  try {
    const qConfig = getQdrantConfig();
    if (!qConfig) {
      return { status: 'degraded', detail: 'Qdrant not configured — fallback mode' };
    }
    if (isQdrantConnected()) {
      return { status: 'healthy', detail: 'Qdrant connected' };
    }
    return { status: 'degraded', detail: 'Qdrant configured but not connected — fallback mode' };
  } catch (err: unknown) {
    return {
      status: 'degraded',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkScheduler(): SubsystemCheck {
  try {
    const scheduler = getAgentScheduler();
    const schedules = scheduler.getAllSchedules();
    const activeSchedules = schedules.filter(s => s.enabled).length;
    const stateManager = getAgentStateManager();
    const activeTasks = stateManager.getActiveTasks().length;
    return {
      status: 'healthy',
      detail: `${activeTasks} active tasks, ${activeSchedules}/${schedules.length} schedules enabled`,
    };
  } catch (err: unknown) {
    return {
      status: 'degraded',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkAgents(): Promise<SubsystemCheck & { active: number; total: number }> {
  try {
    const [active, total] = await Promise.all([
      db.agent.count({ where: { status: 'active' } }),
      db.agent.count(),
    ]);
    return {
      status: 'healthy',
      active,
      total,
      detail: `${active} active, ${total} total`,
    };
  } catch (err: unknown) {
    return {
      status: 'degraded',
      active: 0,
      total: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Overall status computation ───────────────────────────────────

function computeOverallStatus(
  db: SubsystemCheck,
  memory: SubsystemCheck,
  aiRouter: SubsystemCheck,
  rag: SubsystemCheck,
  scheduler: SubsystemCheck,
  agents: SubsystemCheck,
): CheckStatus {
  const checks = [db, memory, aiRouter, rag, scheduler, agents];

  // Any critical unhealthy → overall unhealthy
  if (db.status === 'unhealthy' || aiRouter.status === 'unhealthy') {
    return 'unhealthy';
  }
  if (checks.some(c => c.status === 'unhealthy')) {
    return 'unhealthy';
  }
  // Any degraded → overall degraded
  if (checks.some(c => c.status === 'degraded')) {
    return 'degraded';
  }
  return 'healthy';
}

// ─── Route handler ────────────────────────────────────────────────

export async function GET() {
  const [dbCheck, memoryCheck, aiRouterCheck, ragCheck, schedulerCheck, agentsCheck] =
    await Promise.all([
      checkDatabase(),
      checkMemory(),
      checkAIRouter(),
      checkRAG(),
      Promise.resolve(checkScheduler()),
      checkAgents(),
    ]);

  const overallStatus = computeOverallStatus(
    dbCheck, memoryCheck, aiRouterCheck, ragCheck, schedulerCheck, agentsCheck,
  );

  return NextResponse.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: VERSION,
    checks: {
      database: dbCheck,
      memory: memoryCheck,
      aiRouter: aiRouterCheck,
      rag: ragCheck,
      scheduler: schedulerCheck,
      agents: {
        status: agentsCheck.status,
        active: agentsCheck.active,
        total: agentsCheck.total,
        detail: agentsCheck.detail,
      },
    },
  });
}
