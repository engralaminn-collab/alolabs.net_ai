/**
 * Agent Health Monitor
 * Tracks execution metrics and computes health scores for each agent.
 * Uses hybrid in-memory cache + DB persistence for crash recovery.
 */

import { db } from '@/lib/db';
import type { AgentHealthSnapshot } from './types';

interface HealthRecord {
  agentId: string;
  successCount: number;
  failCount: number;
  totalLatencyMs: number;
  recentLatencies: number[];  // last 100
  recentResults: boolean[];   // last 100: true=success
  lastExecutionAt: Date | null;
  lastErrorAt: Date | null;
  consecutiveFailures: number;
  lastError?: string;
}

class HealthStore {
  private records = new Map<string, HealthRecord>();
  private maxHistory = 100;
  private dbLoaded = new Set<string>(); // track which agents have been loaded from DB

  get(agentId: string): HealthRecord | undefined {
    return this.records.get(agentId);
  }

  getOrCreate(agentId: string): HealthRecord {
    let rec = this.records.get(agentId);
    if (!rec) {
      rec = {
        agentId,
        successCount: 0, failCount: 0, totalLatencyMs: 0,
        recentLatencies: [], recentResults: [],
        lastExecutionAt: null, lastErrorAt: null,
        consecutiveFailures: 0,
      };
      this.records.set(agentId, rec);
    }
    return rec;
  }

  set(agentId: string, rec: HealthRecord): void {
    this.records.set(agentId, rec);
    this.dbLoaded.add(agentId);
  }

  markLoaded(agentId: string): void {
    this.dbLoaded.add(agentId);
  }

  isLoaded(agentId: string): boolean {
    return this.dbLoaded.has(agentId);
  }

  recordSuccess(agentId: string, latencyMs: number): void {
    const rec = this.getOrCreate(agentId);
    rec.successCount++;
    rec.totalLatencyMs += latencyMs;
    rec.recentLatencies.push(latencyMs);
    if (rec.recentLatencies.length > this.maxHistory) rec.recentLatencies.shift();
    rec.recentResults.push(true);
    if (rec.recentResults.length > this.maxHistory) rec.recentResults.shift();
    rec.lastExecutionAt = new Date();
    rec.consecutiveFailures = 0;
  }

  recordFailure(agentId: string, latencyMs: number, error?: string): void {
    const rec = this.getOrCreate(agentId);
    rec.failCount++;
    rec.totalLatencyMs += latencyMs;
    rec.recentLatencies.push(latencyMs);
    if (rec.recentLatencies.length > this.maxHistory) rec.recentLatencies.shift();
    rec.recentResults.push(false);
    if (rec.recentResults.length > this.maxHistory) rec.recentResults.shift();
    rec.lastExecutionAt = new Date();
    rec.lastErrorAt = new Date();
    rec.consecutiveFailures++;
    if (error) rec.lastError = error;
  }

  all(): HealthRecord[] {
    return Array.from(this.records.values());
  }

  clear(agentId: string): void {
    this.records.delete(agentId);
    this.dbLoaded.delete(agentId);
  }
}

export class AgentHealthMonitor {
  private store = new HealthStore();
  private initialized = false;

  /** Record a successful execution */
  recordSuccess(agentId: string, latencyMs: number): void {
    this.store.recordSuccess(agentId, latencyMs);
    this.upsertAgentHealthDB(agentId);
  }

  /** Record a failed execution */
  recordFailure(agentId: string, latencyMs: number, error?: string): void {
    this.store.recordFailure(agentId, latencyMs, error);
    this.upsertAgentHealthDB(agentId);
  }

  /** Get health snapshot for a specific agent */
  getHealth(agentId: string): AgentHealthSnapshot {
    const rec = this.store.get(agentId);
    if (!rec) {
      // Not in memory — try computing from AgentRun table (lazy DB load)
      if (!this.store.isLoaded(agentId)) {
        this.loadHealthFromDB(agentId);
        const loaded = this.store.get(agentId);
        if (loaded) return this.computeSnapshot(loaded);
      }
      return {
        agentId, status: 'ready', healthScore: 100,
        successRate: 1, avgLatencyMs: 0, errorRate: 0,
        totalExecutions: 0, consecutiveFailures: 0, isDegraded: false,
      };
    }
    return this.computeSnapshot(rec);
  }

  /** Get health for all agents */
  getAllHealth(): AgentHealthSnapshot[] {
    // Ensure all DB-known agents are loaded
    if (!this.initialized) {
      this.load();
    }
    const knownIds = new Set<string>();
    for (const rec of this.store.all()) knownIds.add(rec.agentId);
    return Array.from(knownIds).map(id => this.getHealth(id));
  }

  /** Get only degraded or failing agents */
  getUnhealthyAgents(): AgentHealthSnapshot[] {
    return this.getAllHealth().filter(h => h.isDegraded || h.consecutiveFailures >= 3);
  }

  /** Reset health data for an agent */
  resetHealth(agentId: string): void {
    this.store.clear(agentId);
  }

  // ─── Persistence Methods ──────────────────────────────────────

  /**
   * Load all health records from DB into memory.
   * Called on startup for crash recovery.
   */
  async load(): Promise<void> {
    try {
      // Load from AgentHealth table for consecutiveFailures and status
      const healthRows = await db.agentHealth.findMany({
        orderBy: { checkedAt: 'desc' },
      });

      // Deduplicate by agentId (keep latest per agent)
      const byAgent = new Map<string, typeof healthRows[0]>();
      for (const row of healthRows) {
        if (!byAgent.has(row.agentId)) {
          byAgent.set(row.agentId, row);
        }
      }

      // For each agent with an AgentHealth record, supplement with AgentRun data
      for (const [agentId, healthRow] of byAgent) {
        await this.loadHealthFromDB(agentId, healthRow);
      }

      // Also load agents that have AgentRun records but no AgentHealth row
      const agentsWithRuns = await db.agentRun.groupBy({
        by: ['agentId'],
      });
      for (const { agentId } of agentsWithRuns) {
        if (!byAgent.has(agentId)) {
          await this.loadHealthFromDB(agentId);
        }
      }

      this.initialized = true;
    } catch (err) {
      // DB may not be available on very first startup; degrade gracefully
      console.warn('[HealthMonitor] Failed to load from DB:', err);
      this.initialized = true;
    }
  }

  /**
   * Persist ALL in-memory records to DB.
   * For periodic saving (e.g., every 30s).
   */
  async persist(): Promise<void> {
    try {
      const allRecords = this.store.all();
      await Promise.all(
        allRecords.map(rec => this.upsertAgentHealthDB(rec.agentId)),
      );
    } catch (err) {
      console.warn('[HealthMonitor] Failed to persist to DB:', err);
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private computeSnapshot(rec: HealthRecord): AgentHealthSnapshot {
    const total = rec.successCount + rec.failCount;
    const successRate = total > 0 ? rec.successCount / total : 1;
    const avgLatency = rec.recentLatencies.length > 0
      ? rec.recentLatencies.reduce((a, b) => a + b, 0) / rec.recentLatencies.length
      : 0;
    const errorRate = rec.recentResults.length > 0
      ? rec.recentResults.filter(r => !r).length / rec.recentResults.length
      : 0;

    // Health score: 0-100 based on success rate, latency, and failures
    const score = Math.round(
      (successRate * 50) +
      (Math.max(0, 1 - avgLatency / 30_000) * 30) +
      (Math.max(0, 1 - rec.consecutiveFailures / 5) * 20)
    );

    return {
      agentId: rec.agentId,
      status: rec.consecutiveFailures >= 5 ? 'failed' : rec.consecutiveFailures >= 3 ? 'degraded' : 'ready',
      healthScore: score,
      successRate: Math.round(successRate * 1000) / 1000,
      avgLatencyMs: Math.round(avgLatency),
      errorRate: Math.round(errorRate * 1000) / 1000,
      totalExecutions: total,
      lastExecutionAt: rec.lastExecutionAt ?? undefined,
      lastErrorAt: rec.lastErrorAt ?? undefined,
      consecutiveFailures: rec.consecutiveFailures,
      isDegraded: score < 50,
    };
  }

  /**
   * Load health data for a single agent from DB (AgentRun records).
   * Optionally accepts a pre-fetched AgentHealth row for consecutiveFailures.
   */
  private async loadHealthFromDB(
    agentId: string,
    healthRow?: { consecutiveFailures: number; status: string; lastHeartbeat: Date } | null,
  ): Promise<void> {
    try {
      // Fetch the last 100 completed runs for this agent to reconstruct metrics
      const runs = await db.agentRun.findMany({
        where: {
          agentId,
          status: { in: ['completed', 'failed', 'timed_out'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      if (runs.length === 0 && !healthRow) {
        this.store.markLoaded(agentId);
        return;
      }

      // If no runs but we have a healthRow, still create a minimal record
      if (runs.length === 0 && healthRow) {
        const rec: HealthRecord = {
          agentId,
          successCount: 0,
          failCount: 0,
          totalLatencyMs: 0,
          recentLatencies: [],
          recentResults: [],
          lastExecutionAt: healthRow.lastHeartbeat ?? null,
          lastErrorAt: null,
          consecutiveFailures: healthRow.consecutiveFailures,
        };
        this.store.set(agentId, rec);
        return;
      }

      // Reverse to chronological order, then take last 100
      const chronological = [...runs].reverse().slice(-100);

      let successCount = 0;
      let failCount = 0;
      let totalLatencyMs = 0;
      const recentLatencies: number[] = [];
      const recentResults: boolean[] = [];
      let lastExecutionAt: Date | null = null;
      let lastErrorAt: Date | null = null;
      let consecutiveFailures = 0;

      for (const run of chronological) {
        const isFailure = run.status === 'failed' || run.status === 'timed_out';
        const latency = run.latencyMs ?? run.durationMs ?? 0;

        if (isFailure) {
          failCount++;
          consecutiveFailures++;
          lastErrorAt = run.completedAt ?? run.createdAt;
        } else {
          successCount++;
          consecutiveFailures = 0;
        }

        totalLatencyMs += latency;
        recentLatencies.push(latency);
        recentResults.push(!isFailure);

        const execTime = run.completedAt ?? run.createdAt;
        if (!lastExecutionAt || execTime > lastExecutionAt) {
          lastExecutionAt = execTime;
        }
      }

      // Use DB-stored consecutiveFailures if available and more recent
      if (healthRow && healthRow.consecutiveFailures > consecutiveFailures) {
        consecutiveFailures = healthRow.consecutiveFailures;
      }

      const rec: HealthRecord = {
        agentId,
        successCount,
        failCount,
        totalLatencyMs,
        recentLatencies,
        recentResults,
        lastExecutionAt,
        lastErrorAt,
        consecutiveFailures,
      };
      this.store.set(agentId, rec);
    } catch (err) {
      console.warn(`[HealthMonitor] Failed to load health for agent ${agentId}:`, err);
      this.store.markLoaded(agentId);
    }
  }

  /**
   * Upsert the AgentHealth DB row for an agent.
   * This is fire-and-forget (errors logged, not thrown).
   */
  private upsertAgentHealthDB(agentId: string): void {
    const rec = this.store.get(agentId);
    if (!rec) return;

    const status = rec.consecutiveFailures >= 5
      ? 'failed'
      : rec.consecutiveFailures >= 3
        ? 'degraded'
        : 'healthy';

    // Fire-and-forget — don't block the caller
    db.agentHealth.upsert({
      where: { id: `health-${agentId}` },
      update: {
        status,
        consecutiveFailures: rec.consecutiveFailures,
        lastHeartbeat: rec.lastExecutionAt ?? new Date(),
        checkedAt: new Date(),
      },
      create: {
        id: `health-${agentId}`,
        agentId,
        status,
        consecutiveFailures: rec.consecutiveFailures,
        lastHeartbeat: rec.lastExecutionAt ?? new Date(),
        checkedAt: new Date(),
      },
    }).catch((err: unknown) => {
      console.warn(`[HealthMonitor] Failed to upsert AgentHealth for ${agentId}:`, err);
    });
  }
}

// Singleton
let _instance: AgentHealthMonitor | null = null;
export function getAgentHealthMonitor(): AgentHealthMonitor {
  if (!_instance) _instance = new AgentHealthMonitor();
  return _instance;
}