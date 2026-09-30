/**
 * Multi-Agent Orchestrator
 * Executes multi-step tasks using the existing AgentExecutionEngine.
 * Supports sequential, parallel, conditional, delegation, aggregation, voting, consensus, review.
 */

import { getExecutionEngine } from '@/lib/agent-runtime/execution';
import { db } from '@/lib/db';
import { getEventBus } from '@/lib/event-bus';
import type {
  OrchestrationTask,
  OrchestrationStep,
  OrchestrationResult,
  ParallelExecutionConfig,
} from './types';
import {
  CONCURRENCY_LIMITS,
  ORCHESTRATION_PRIORITY_MAP,
  DEFAULT_PARALLEL_CONFIG,
} from './types';
import type { TaskPriority } from '@/lib/agent-runtime/types';

// ─── In-memory task store ──────────────────────────────────────────

const taskStore = new Map<string, OrchestrationTask>();

// ─── Concurrency tracking ──────────────────────────────────────────

class ConcurrencyTracker {
  private globalActive = 0;
  private deptActive = new Map<string, number>();
  private agentActive = new Map<string, number>();
  private userActive = new Map<string, number>();
  private waiters: Array<() => void> = [];

  async acquire(params: {
    companyId: string;
    departmentId?: string;
    agentId: string;
    userId: string;
  }): Promise<void> {
    // Check limits
    while (true) {
      if (this.globalActive >= CONCURRENCY_LIMITS.global) {
        await this.wait();
        continue;
      }
      if (params.departmentId) {
        const deptCount = this.deptActive.get(params.departmentId) ?? 0;
        if (deptCount >= CONCURRENCY_LIMITS.department) {
          await this.wait();
          continue;
        }
      }
      const agentCount = this.agentActive.get(params.agentId) ?? 0;
      if (agentCount >= CONCURRENCY_LIMITS.agent) {
        await this.wait();
        continue;
      }
      const userCount = this.userActive.get(params.userId) ?? 0;
      if (userCount >= CONCURRENCY_LIMITS.user) {
        await this.wait();
        continue;
      }
      break;
    }

    // Acquire all slots
    this.globalActive++;
    if (params.departmentId) {
      this.deptActive.set(
        params.departmentId,
        (this.deptActive.get(params.departmentId) ?? 0) + 1,
      );
    }
    this.agentActive.set(
      params.agentId,
      (this.agentActive.get(params.agentId) ?? 0) + 1,
    );
    this.userActive.set(
      params.userId,
      (this.userActive.get(params.userId) ?? 0) + 1,
    );
  }

  release(params: {
    departmentId?: string;
    agentId: string;
    userId: string;
  }): void {
    this.globalActive = Math.max(0, this.globalActive - 1);
    if (params.departmentId) {
      const current = this.deptActive.get(params.departmentId) ?? 0;
      this.deptActive.set(params.departmentId, Math.max(0, current - 1));
    }
    const agentCurrent = this.agentActive.get(params.agentId) ?? 0;
    this.agentActive.set(params.agentId, Math.max(0, agentCurrent - 1));
    const userCurrent = this.userActive.get(params.userId) ?? 0;
    this.userActive.set(params.userId, Math.max(0, userCurrent - 1));

    // Wake up one waiter
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  getStatus() {
    return {
      global: { active: this.globalActive, limit: CONCURRENCY_LIMITS.global },
      departments: Object.fromEntries(this.deptActive),
      agents: Object.fromEntries(this.agentActive),
      users: Object.fromEntries(this.userActive),
    };
  }

  private wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────

export class MultiAgentOrchestrator {
  private concurrency = new ConcurrencyTracker();
  private eventBus = getEventBus();
  private engine = getExecutionEngine();

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Execute a multi-agent orchestration task.
   * Builds a dependency graph, executes steps respecting dependencies,
   * and aggregates results.
   */
  async executeTask(params: {
    type: OrchestrationTask['type'];
    steps: OrchestrationStep[];
    input: string;
    companyId: string;
    userId: string;
    departmentId?: string;
    priority?: OrchestrationTask['priority'];
    context?: Record<string, unknown>;
    parallelConfig?: Partial<ParallelExecutionConfig>;
  }): Promise<OrchestrationTask> {
    const taskId = `orch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    // Initialize steps with status
    const initializedSteps: OrchestrationStep[] = params.steps.map((step) => ({
      ...step,
      status: 'pending',
    }));

    const task: OrchestrationTask = {
      id: taskId,
      type: params.type,
      steps: initializedSteps,
      input: params.input,
      context: params.context,
      companyId: params.companyId,
      userId: params.userId,
      departmentId: params.departmentId,
      priority: params.priority ?? 'P3',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    // Store in memory
    taskStore.set(taskId, task);

    // Validate
    const validationError = this.validateTask(task);
    if (validationError) {
      task.status = 'failed';
      task.error = validationError;
      task.updatedAt = new Date();
      return task;
    }

    // Emit start event
    await this.emitEvent(task, 'orchestration.started', {
      taskId,
      type: task.type,
      stepCount: task.steps.length,
    });

    // Execute asynchronously
    this.runOrchestration(task, params.parallelConfig).catch((err) => {
      console.error(`[Orchestrator] Task ${taskId} failed:`, err);
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      task.updatedAt = new Date();
    });

    return task;
  }

  /** Get the current status of an orchestration task */
  getTaskStatus(taskId: string): OrchestrationTask | null {
    return taskStore.get(taskId) ?? null;
  }

  /** Get concurrency tracker status */
  getConcurrencyStatus() {
    return this.concurrency.getStatus();
  }

  // ─── Internal: Main Execution ─────────────────────────────────

  private async runOrchestration(
    task: OrchestrationTask,
    parallelConfig?: Partial<ParallelExecutionConfig>,
  ): Promise<void> {
    const startTime = Date.now();
    task.status = 'running';
    task.updatedAt = new Date();

    try {
      let result: OrchestrationResult;

      switch (task.type) {
        case 'sequential':
          result = await this.executeSequential(task);
          break;
        case 'parallel':
          result = await this.executeParallel(task, parallelConfig);
          break;
        case 'conditional':
          result = await this.executeConditional(task);
          break;
        case 'delegation':
          result = await this.executeDelegation(task);
          break;
        case 'aggregation':
          result = await this.executeAggregation(task, parallelConfig);
          break;
        case 'voting':
          result = await this.executeVoting(task, parallelConfig);
          break;
        case 'consensus':
          result = await this.executeConsensus(task, parallelConfig);
          break;
        case 'review':
          result = await this.executeReview(task);
          break;
        default:
          throw new Error(`Unknown orchestration type: ${task.type}`);
      }

      result.totalLatencyMs = Date.now() - startTime;
      task.result = result;
      task.status = 'completed';
      task.updatedAt = new Date();

      await this.emitEvent(task, 'orchestration.completed', {
        taskId: task.id,
        totalLatencyMs: result.totalLatencyMs,
        totalTokens: result.totalTokens,
        costUsd: result.costUsd,
      });
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date();

      await this.emitEvent(task, 'orchestration.failed', {
        taskId: task.id,
        error: task.error,
      });
    }
  }

  // ─── Sequential Execution ──────────────────────────────────────

  private async executeSequential(task: OrchestrationTask): Promise<OrchestrationResult> {
    let chainInput = task.input;
    let totalTokens = 0;
    let totalCost = 0;
    const modelUsed: string[] = [];

    for (const step of task.steps) {
      step.status = 'running';
      step.startedAt = new Date();

      try {
        const stepInput = this.buildStepInput(step, chainInput, task);
        const execResult = await this.executeStep(step, task, stepInput);

        step.result = execResult.content;
        step.status = 'completed';
        step.completedAt = new Date();
        step.latencyMs = step.completedAt.getTime() - step.startedAt.getTime();
        step.error = undefined;

        chainInput = execResult.content;
        totalTokens += (execResult.metadata?.tokensUsed as number) ?? 0;
        totalCost += (execResult.metadata?.costUsd as number) ?? 0;
        if (execResult.metadata?.model) modelUsed.push(execResult.metadata.model as string);
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
        step.completedAt = new Date();

        // Retry logic: retry step up to 3 times before failing
        const maxRetries = step.retryCount ?? 2;
        let retryAttempt = 0;
        let retrySuccess = false;

        while (retryAttempt < maxRetries && !retrySuccess) {
          retryAttempt++;
          try {
            step.status = 'running';
            step.error = undefined;
            const retryInput = this.buildStepInput(step, chainInput, task);
            const retryResult = await this.executeStepWithFallback(step, task, retryInput, retryAttempt);
            step.result = retryResult.content;
            step.status = 'completed';
            step.completedAt = new Date();
            step.latencyMs = step.completedAt.getTime() - step.startedAt.getTime();
            chainInput = retryResult.content;
            totalTokens += (retryResult.metadata?.tokensUsed as number) ?? 0;
            totalCost += (retryResult.metadata?.costUsd as number) ?? 0;
            if (retryResult.metadata?.model) modelUsed.push(retryResult.metadata.model as string);
            retrySuccess = true;
          } catch (retryError) {
            step.error = retryError instanceof Error ? retryError.message : String(retryError);
          }
        }

        if (!retrySuccess) {
          throw new Error(`Step ${step.id} failed after ${maxRetries} retries: ${step.error}`);
        }
      }
    }

    return {
      finalOutput: chainInput,
      steps: [...task.steps],
      totalLatencyMs: 0, // filled by caller
      totalTokens,
      costUsd: totalCost,
      agentIds: task.steps.map((s) => s.agentId),
      modelUsed,
    };
  }

  // ─── Parallel Execution ────────────────────────────────────────

  private async executeParallel(
    task: OrchestrationTask,
    config?: Partial<ParallelExecutionConfig>,
  ): Promise<OrchestrationResult> {
    const cfg = { ...DEFAULT_PARALLEL_CONFIG, ...config };
    const results = await this.executeWithConcurrency(task, cfg);

    const aggregated = this.aggregateResults(
      results.map((r) => r.content),
      cfg.aggregationStrategy,
    );

    const totalTokens = results.reduce((sum, r) => sum + ((r.metadata?.tokensUsed as number) ?? 0), 0);
    const totalCost = results.reduce((sum, r) => sum + ((r.metadata?.costUsd as number) ?? 0), 0);
    const modelUsed = results
      .map((r) => r.metadata?.model as string)
      .filter(Boolean);

    return {
      finalOutput: aggregated,
      steps: [...task.steps],
      totalLatencyMs: 0,
      totalTokens,
      costUsd: totalCost,
      agentIds: task.steps.map((s) => s.agentId),
      modelUsed: [...new Set(modelUsed)],
    };
  }

  // ─── Conditional Execution ─────────────────────────────────────

  private async executeConditional(task: OrchestrationTask): Promise<OrchestrationResult> {
    let chainInput = task.input;
    let totalTokens = 0;
    let totalCost = 0;
    const modelUsed: string[] = [];

    for (const step of task.steps) {
      // Check condition
      if (step.condition) {
        const shouldRun = this.evaluateCondition(step.condition, chainInput, task.context);
        if (!shouldRun) {
          step.status = 'skipped';
          continue;
        }
      }

      // Check dependencies
      if (step.dependsOn?.length) {
        const allDepsCompleted = step.dependsOn.every((depId) => {
          const dep = task.steps.find((s) => s.id === depId);
          return dep?.status === 'completed';
        });
        if (!allDepsCompleted) {
          step.status = 'skipped';
          continue;
        }
      }

      step.status = 'running';
      step.startedAt = new Date();

      try {
        const stepInput = this.buildStepInput(step, chainInput, task);
        const execResult = await this.executeStep(step, task, stepInput);

        step.result = execResult.content;
        step.status = 'completed';
        step.completedAt = new Date();
        step.latencyMs = step.completedAt.getTime() - step.startedAt.getTime();

        chainInput = execResult.content;
        totalTokens += (execResult.metadata?.tokensUsed as number) ?? 0;
        totalCost += (execResult.metadata?.costUsd as number) ?? 0;
        if (execResult.metadata?.model) modelUsed.push(execResult.metadata.model as string);
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
        step.completedAt = new Date();

        // Retry with fallback for conditional execution
        const maxRetries = step.retryCount ?? 1;
        let retryAttempt = 0;
        let retrySuccess = false;

        while (retryAttempt < maxRetries && !retrySuccess) {
          retryAttempt++;
          try {
            step.status = 'running';
            step.error = undefined;
            const retryInput = this.buildStepInput(step, chainInput, task);
            const retryResult = await this.executeStepWithFallback(step, task, retryInput, retryAttempt);
            step.result = retryResult.content;
            step.status = 'completed';
            step.completedAt = new Date();
            step.latencyMs = step.completedAt.getTime() - step.startedAt.getTime();
            chainInput = retryResult.content;
            totalTokens += (retryResult.metadata?.tokensUsed as number) ?? 0;
            totalCost += (retryResult.metadata?.costUsd as number) ?? 0;
            if (retryResult.metadata?.model) modelUsed.push(retryResult.metadata.model as string);
            retrySuccess = true;
          } catch (retryError) {
            step.error = retryError instanceof Error ? retryError.message : String(retryError);
          }
        }

        if (!retrySuccess) {
          // Conditional: don't fail the whole task, skip remaining
          break;
        }
      }
    }

    return {
      finalOutput: chainInput,
      steps: [...task.steps],
      totalLatencyMs: 0,
      totalTokens,
      costUsd: totalCost,
      agentIds: task.steps.filter((s) => s.status === 'completed').map((s) => s.agentId),
      modelUsed: [...new Set(modelUsed)],
    };
  }

  // ─── Delegation Execution ──────────────────────────────────────

  private async executeDelegation(task: OrchestrationTask): Promise<OrchestrationResult> {
    // Find the best agent within the department for the task
    const targetAgentId = await this.findBestAgent(task);

    const step: OrchestrationStep = {
      id: 'del_step_1',
      agentId: targetAgentId,
      task: task.input,
      status: 'pending',
    };

    step.status = 'running';
    step.startedAt = new Date();

    const execResult = await this.executeStep(step, task, task.input);

    step.result = execResult.content;
    step.status = 'completed';
    step.completedAt = new Date();
    step.latencyMs = step.completedAt.getTime() - step.startedAt.getTime();

    return {
      finalOutput: execResult.content,
      steps: [step],
      totalLatencyMs: 0,
      totalTokens: (execResult.metadata?.tokensUsed as number) ?? 0,
      costUsd: (execResult.metadata?.costUsd as number) ?? 0,
      agentIds: [targetAgentId],
      modelUsed: execResult.metadata?.model ? [execResult.metadata.model as string] : [],
    };
  }

  // ─── Aggregation Execution ─────────────────────────────────────

  private async executeAggregation(
    task: OrchestrationTask,
    config?: Partial<ParallelExecutionConfig>,
  ): Promise<OrchestrationResult> {
    const cfg = { ...DEFAULT_PARALLEL_CONFIG, aggregationStrategy: 'concatenate', ...config };
    const results = await this.executeWithConcurrency(task, cfg);

    const aggregated = this.aggregateResults(
      results.map((r) => r.content),
      cfg.aggregationStrategy,
    );

    const totalTokens = results.reduce((sum, r) => sum + ((r.metadata?.tokensUsed as number) ?? 0), 0);
    const totalCost = results.reduce((sum, r) => sum + ((r.metadata?.costUsd as number) ?? 0), 0);
    const modelUsed = results
      .map((r) => r.metadata?.model as string)
      .filter(Boolean);

    return {
      finalOutput: aggregated,
      steps: [...task.steps],
      totalLatencyMs: 0,
      totalTokens,
      costUsd: totalCost,
      agentIds: task.steps.map((s) => s.agentId),
      modelUsed: [...new Set(modelUsed)],
    };
  }

  // ─── Voting Execution ──────────────────────────────────────────

  private async executeVoting(
    task: OrchestrationTask,
    config?: Partial<ParallelExecutionConfig>,
  ): Promise<OrchestrationResult> {
    const cfg = { ...DEFAULT_PARALLEL_CONFIG, aggregationStrategy: 'voting', ...config };
    const results = await this.executeWithConcurrency(task, cfg);

    const majorityAnswer = this.selectByVoting(results.map((r) => r.content));

    const totalTokens = results.reduce((sum, r) => sum + ((r.metadata?.tokensUsed as number) ?? 0), 0);
    const totalCost = results.reduce((sum, r) => sum + ((r.metadata?.costUsd as number) ?? 0), 0);
    const modelUsed = results
      .map((r) => r.metadata?.model as string)
      .filter(Boolean);

    return {
      finalOutput: majorityAnswer,
      steps: [...task.steps],
      totalLatencyMs: 0,
      totalTokens,
      costUsd: totalCost,
      agentIds: task.steps.map((s) => s.agentId),
      modelUsed: [...new Set(modelUsed)],
    };
  }

  // ─── Consensus Execution ───────────────────────────────────────

  private async executeConsensus(
    task: OrchestrationTask,
    config?: Partial<ParallelExecutionConfig>,
  ): Promise<OrchestrationResult> {
    const cfg = { ...DEFAULT_PARALLEL_CONFIG, aggregationStrategy: 'consensus', ...config };
    const results = await this.executeWithConcurrency(task, cfg);

    const consensusResult = this.buildConsensus(results.map((r) => r.content));

    const totalTokens = results.reduce((sum, r) => sum + ((r.metadata?.tokensUsed as number) ?? 0), 0);
    const totalCost = results.reduce((sum, r) => sum + ((r.metadata?.costUsd as number) ?? 0), 0);
    const modelUsed = results
      .map((r) => r.metadata?.model as string)
      .filter(Boolean);

    return {
      finalOutput: consensusResult,
      steps: [...task.steps],
      totalLatencyMs: 0,
      totalTokens,
      costUsd: totalCost,
      agentIds: task.steps.map((s) => s.agentId),
      modelUsed: [...new Set(modelUsed)],
    };
  }

  // ─── Review Execution ──────────────────────────────────────────

  private async executeReview(task: OrchestrationTask): Promise<OrchestrationResult> {
    // First step produces output, subsequent steps review it
    if (task.steps.length < 2) {
      throw new Error('Review orchestration requires at least 2 steps (producer + reviewer)');
    }

    const producer = task.steps[0];
    const reviewers = task.steps.slice(1);

    // Execute producer
    producer.status = 'running';
    producer.startedAt = new Date();
    const producerResult = await this.executeStep(producer, task, task.input);
    producer.result = producerResult.content;
    producer.status = 'completed';
    producer.completedAt = new Date();
    producer.latencyMs = producer.completedAt.getTime() - producer.startedAt.getTime();

    // Execute reviewers in parallel
    const reviewInput = `Review the following output and provide feedback, corrections, or approval:\n\n${producerResult.content}`;

    const reviewResults: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
    const reviewPromises = reviewers.map(async (reviewer) => {
      reviewer.status = 'running';
      reviewer.startedAt = new Date();
      try {
        const result = await this.executeStep(reviewer, task, reviewInput);
        reviewer.result = result.content;
        reviewer.status = 'completed';
        reviewer.completedAt = new Date();
        reviewer.latencyMs = reviewer.completedAt.getTime() - reviewer.startedAt.getTime();
        return result;
      } catch (error) {
        reviewer.status = 'failed';
        reviewer.error = error instanceof Error ? error.message : String(error);
        reviewer.completedAt = new Date();
        return { content: `Review failed: ${reviewer.error}`, metadata: {} };
      }
    });

    const settled = await Promise.all(reviewPromises);
    reviewResults.push(...settled);

    // Combine producer output with reviews
    const reviewSection = reviewResults
      .map((r, i) => `### Reviewer ${i + 1} (${reviewers[i].agentId})\n${r.content}`)
      .join('\n\n');

    const finalOutput = `## Original Output\n${producerResult.content}\n\n## Reviews\n${reviewSection}`;

    const totalTokens =
      ((producerResult.metadata?.tokensUsed as number) ?? 0) +
      reviewResults.reduce((sum, r) => sum + ((r.metadata?.tokensUsed as number) ?? 0), 0);
    const totalCost =
      ((producerResult.metadata?.costUsd as number) ?? 0) +
      reviewResults.reduce((sum, r) => sum + ((r.metadata?.costUsd as number) ?? 0), 0);

    const modelUsed = [
      producerResult.metadata?.model as string,
      ...reviewResults.map((r) => r.metadata?.model as string),
    ].filter(Boolean);

    return {
      finalOutput,
      steps: [...task.steps],
      totalLatencyMs: 0,
      totalTokens,
      costUsd: totalCost,
      agentIds: task.steps.map((s) => s.agentId),
      modelUsed: [...new Set(modelUsed)],
    };
  }

  // ─── Step Execution ────────────────────────────────────────────

  private async executeStep(
    step: OrchestrationStep,
    task: OrchestrationTask,
    input: string,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const priority = this.mapPriority(task.priority);

    await this.concurrency.acquire({
      companyId: task.companyId,
      departmentId: task.departmentId,
      agentId: step.agentId,
      userId: task.userId,
    });

    try {
      const timeoutMs = step.timeoutMs ?? 60_000;

      // Execute with timeout
      const execPromise = this.engine.execute({
        agentId: step.agentId,
        companyId: task.companyId,
        userId: task.userId,
        task: input,
        priority,
        mode: 'sync',
        maxTokens: step.maxTokens,
        timeoutMs,
        tools: step.tools,
        context: task.context,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Step ${step.id} timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      const resultTask = await Promise.race([execPromise, timeoutPromise]);

      // Record in AgentRun table
      try {
        const agent = await db.agent.findUnique({ where: { agentId: step.agentId } });
        if (agent) {
          await db.agentRun.create({
            data: {
              agentId: agent.id,
              agentName: agent.name,
              input,
              output: resultTask.result?.content ?? '',
              durationMs: (resultTask.result?.metadata?.latencyMs as number) ?? 0,
              model: (resultTask.result?.metadata?.model as string) ?? '',
              tokensUsed: resultTask.tokenUsage?.totalTokens ?? 0,
              companyId: task.companyId,
              latencyMs: resultTask.result?.metadata?.latencyMs as number,
              confidence: resultTask.result?.confidence,
              status: resultTask.status === 'completed' ? 'completed' : 'failed',
            },
          });
        }
      } catch {
        // AgentRun write failure is non-critical
      }

      if (resultTask.error) {
        throw new Error(resultTask.error.message);
      }

      return {
        content: resultTask.result?.content ?? '',
        metadata: {
          model: resultTask.result?.metadata?.model,
          latencyMs: resultTask.result?.metadata?.latencyMs,
          tokensUsed: resultTask.tokenUsage?.totalTokens,
          costUsd: resultTask.tokenUsage?.costUsd,
        },
      };
    } finally {
      this.concurrency.release({
        departmentId: task.departmentId,
        agentId: step.agentId,
        userId: task.userId,
      });
    }
  }

  // ─── Parallel Execution with Concurrency Limit ─────────────────

  private async executeWithConcurrency(
    task: OrchestrationTask,
    config: ParallelExecutionConfig,
  ): Promise<Array<{ content: string; metadata?: Record<string, unknown> }>> {
    // Build dependency graph and topological sort
    const orderedSteps = this.topologicalSort(task.steps);
    const results: Array<{ content: string; metadata?: Record<string, unknown> }> = new Array(
    task.steps.length,
  );
    const completedSteps = new Set<string>();

    // Process in waves based on dependencies
    const waves = this.buildWaves(orderedSteps);

    for (const wave of waves) {
      // Execute wave with concurrency limit
      const waveResults = await this.executeWave(wave, task, config, completedSteps);

      for (let i = 0; i < wave.length; i++) {
        const step = wave[i];
        const stepIdx = task.steps.findIndex((s) => s.id === step.id);
        if (stepIdx >= 0) {
          results[stepIdx] = waveResults[i];
          if (step.status === 'completed') completedSteps.add(step.id);
        }
      }

      // If failFast and any step failed, abort
      if (config.failFast && wave.some((s) => s.status === 'failed')) {
        break;
      }
    }

    return results.filter(Boolean);
  }

  private async executeWave(
    wave: OrchestrationStep[],
    task: OrchestrationTask,
    config: ParallelExecutionConfig,
    _completedSteps: Set<string>,
  ): Promise<Array<{ content: string; metadata?: Record<string, unknown> }>> {
    const semaphore = new Semaphore(config.maxConcurrency);
    const promises = wave.map(async (step) => {
      await semaphore.acquire();
      try {
        step.status = 'running';
        step.startedAt = new Date();

        const stepInput = this.buildStepInput(step, task.input, task);
        const result = await this.executeStep(step, task, stepInput);

        step.result = result.content;
        step.status = 'completed';
        step.completedAt = new Date();
        step.latencyMs = step.completedAt.getTime() - step.startedAt.getTime();
        step.error = undefined;

        return result;
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
        step.completedAt = new Date();
        return { content: '', metadata: {} };
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(promises);
  }

  // ─── Dependency Graph ──────────────────────────────────────────

  private topologicalSort(steps: OrchestrationStep[]): OrchestrationStep[] {
    const visited = new Set<string>();
    const result: OrchestrationStep[] = [];
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const visit = (stepId: string) => {
      if (visited.has(stepId)) return;
      visited.add(stepId);

      const step = stepMap.get(stepId);
      if (!step) return;

      // Visit dependencies first
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          visit(depId);
        }
      }

      result.push(step);
    };

    for (const step of steps) {
      visit(step.id);
    }

    return result;
  }

  private buildWaves(sortedSteps: OrchestrationStep[]): OrchestrationStep[][] {
    const waves: OrchestrationStep[][] = [];
    const assigned = new Set<string>();

    for (const step of sortedSteps) {
      if (assigned.has(step.id)) continue;

      // Find all steps that can run together (dependencies are in assigned)
      const wave: OrchestrationStep[] = [];
      for (const s of sortedSteps) {
        if (assigned.has(s.id)) continue;
        const depsSatisfied =
          !s.dependsOn || s.dependsOn.every((d) => assigned.has(d));
        if (depsSatisfied) {
          wave.push(s);
        }
      }

      for (const s of wave) {
        assigned.add(s.id);
      }
      waves.push(wave);
    }

    return waves;
  }

  // ─── Aggregation Strategies ────────────────────────────────────

  private aggregateResults(
    results: string[],
    strategy: ParallelExecutionConfig['aggregationStrategy'],
  ): string {
    switch (strategy) {
      case 'first':
        return results[0] ?? '';
      case 'last':
        return results[results.length - 1] ?? '';
      case 'concatenate':
        return results
          .filter(Boolean)
          .map((r, i) => `### Result ${i + 1}\n${r}`)
          .join('\n\n');
      case 'voting':
        return this.selectByVoting(results);
      case 'consensus':
        return this.buildConsensus(results);
      case 'all':
        return JSON.stringify(results, null, 2);
      default:
        return results.join('\n\n');
    }
  }

  private selectByVoting(results: string[]): string {
    if (results.length === 0) return '';
    if (results.length === 1) return results[0];

    // Simple majority: group by normalized text, pick most common
    const counts = new Map<string, { text: string; count: number }>();
    for (const r of results) {
      const normalized = r.trim().toLowerCase().slice(0, 200);
      const existing = counts.get(normalized);
      if (existing) {
        existing.count++;
      } else {
        counts.set(normalized, { text: r, count: 1 });
      }
    }

    // Return the most common result
    let best = results[0];
    let bestCount = 0;
    for (const entry of counts.values()) {
      if (entry.count > bestCount) {
        bestCount = entry.count;
        best = entry.text;
      }
    }

    return best;
  }

  private buildConsensus(results: string[]): string {
    if (results.length === 0) return '';
    if (results.length === 1) return results[0];

    // Build a consensus by combining all unique points
    const allLines = results.flatMap((r) => r.split('\n').filter((l) => l.trim()));
    const uniqueLines = [...new Set(allLines.map((l) => l.trim()))];

    return `## Consensus Output\n\n${uniqueLines.join('\n')}`;
  }

  // ─── Delegation: Find Best Agent ────────────────────────────────

  private async findBestAgent(task: OrchestrationTask): Promise<string> {
    // If steps have agentIds, pick the first one
    if (task.steps.length > 0 && task.steps[0].agentId) {
      return task.steps[0].agentId;
    }

    // Otherwise, find an active agent in the department
    const agents = await db.agent.findMany({
      where: {
        departmentId: task.departmentId,
        status: 'active',
      },
      take: 1,
    });

    if (agents.length === 0) {
      // Fallback: any active agent
      const anyAgent = await db.agent.findFirst({
        where: { status: 'active' },
      });
      if (!anyAgent) {
        throw new Error('No active agents available for delegation');
      }
      return anyAgent.agentId;
    }

    return agents[0].agentId;
  }

  // ─── Condition Evaluation ──────────────────────────────────────

  private evaluateCondition(
    condition: string,
    _input: string,
    context?: Record<string, unknown>,
  ): boolean {
    // Simple condition evaluation supporting:
    // - context.field == "value"
    // - context.field != "value"
    // - context.field exists
    // - input.length > N
    try {
      // Check for equality conditions: context.field == "value"
      const eqMatch = condition.match(/^context\.(\w+)\s*==\s*"?([^"]+)"?$/);
      if (eqMatch) {
        const ctxValue = context?.[eqMatch[1]];
        return String(ctxValue) === eqMatch[2];
      }

      // Check for inequality: context.field != "value"
      const neqMatch = condition.match(/^context\.(\w+)\s*!=\s*"?([^"]+)"?$/);
      if (neqMatch) {
        const ctxValue = context?.[neqMatch[1]];
        return String(ctxValue) !== neqMatch[2];
      }

      // Check for existence: context.field exists
      const existsMatch = condition.match(/^context\.(\w+)\s+exists$/);
      if (existsMatch) {
        return context?.[existsMatch[1]] !== undefined;
      }

      // Check for input length: input.length > N
      const lengthMatch = condition.match(/^input\.length\s*(>|<|>=|<=|==)\s*(\d+)$/);
      if (lengthMatch) {
        const op = lengthMatch[1];
        const val = parseInt(lengthMatch[2], 10);
        const len = _input.length;
        switch (op) {
          case '>': return len > val;
          case '<': return len < val;
          case '>=': return len >= val;
          case '<=': return len <= val;
          case '==': return len === val;
          default: return true;
        }
      }

      // Default: treat as truthy JS expression (unsafe — only simple values)
      return Boolean(context?.[condition]);
    } catch {
      // On evaluation error, default to running the step
      return true;
    }
  }

  // ─── Retry with Fallback Agent ────────────────────────────────

  private async executeStepWithFallback(
    step: OrchestrationStep,
    task: OrchestrationTask,
    input: string,
    attempt: number,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    // On first retry, try the same agent. On subsequent retries, try fallback agent.
    if (attempt > 1) {
      const fallbackAgentId = await this.findFallbackAgent(step.agentId, task);
      if (fallbackAgentId) {
        const fallbackStep = { ...step, agentId: fallbackAgentId };
        return this.executeStep(fallbackStep, task, input);
      }
    }
    return this.executeStep(step, task, input);
  }

  private async findFallbackAgent(
    failedAgentId: string,
    task: OrchestrationTask,
  ): Promise<string | null> {
    // Find another active agent in the same department
    const agents = await db.agent.findMany({
      where: {
        departmentId: task.departmentId,
        status: 'active',
        agentId: { not: failedAgentId },
      },
      take: 1,
    });

    if (agents.length > 0) {
      return agents[0].agentId;
    }

    // Fallback: any other active agent
    const anyAgent = await db.agent.findFirst({
      where: {
        status: 'active',
        agentId: { not: failedAgentId },
      },
    });

    return anyAgent?.agentId ?? null;
  }

  // ─── Task Decomposition ─────────────────────────────────────────

  /**
   * Decompose a complex task into subtasks based on the input description.
   * Returns an array of OrchestrationSteps that can be executed.
   */
  async decomposeTask(params: {
    input: string;
    companyId: string;
    userId: string;
    departmentId?: string;
    maxSubtasks?: number;
  }): Promise<OrchestrationStep[]> {
    const maxSubtasks = params.maxSubtasks ?? 5;

    // Find available agents in the department
    const agents = await db.agent.findMany({
      where: {
        departmentId: params.departmentId,
        status: 'active',
      },
      take: maxSubtasks,
    });

    if (agents.length === 0) {
      // Fallback: any active agents
      const anyAgents = await db.agent.findMany({
        where: { status: 'active' },
        take: maxSubtasks,
      });
      if (anyAgents.length === 0) {
        throw new Error('No active agents available for task decomposition');
      }
      agents.push(...anyAgents);
    }

    // Create subtasks by splitting input into chunks
    // Each agent gets a portion of the task
    const subtaskCount = Math.min(agents.length, maxSubtasks);
    const steps: OrchestrationStep[] = [];

    for (let i = 0; i < subtaskCount; i++) {
      steps.push({
        id: `sub_${i + 1}`,
        agentId: agents[i % agents.length].agentId,
        task: params.input,
        dependsOn: i > 0 ? [`sub_${i}`] : [],
        status: 'pending',
        timeoutMs: 60_000,
        retryCount: 2,
      });
    }

    return steps;
  }

  // ─── Agent Selection by Skill ────────────────────────────────────

  /**
   * Find the best agent for a task based on required skills.
   * Scores agents by matching their allowedSkills against the required skills.
   */
  async findBestAgentBySkills(params: {
    requiredSkills: string[];
    departmentId?: string;
    companyId: string;
  }): Promise<string | null> {
    const agents = await db.agent.findMany({
      where: {
        departmentId: params.departmentId,
        status: 'active',
      },
      include: {
        permissions: true,
      },
    });

    if (agents.length === 0) return null;

    // Score each agent by skill match
    let bestAgent: string | null = null;
    let bestScore = -1;

    for (const agent of agents) {
      let skills: string[] = [];
      try {
        skills = JSON.parse(agent.allowedSkills || '[]');
      } catch {
        skills = [];
      }

      const matchCount = params.requiredSkills.filter((s) => skills.includes(s)).length;
      const score = matchCount / Math.max(params.requiredSkills.length, 1);

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent.agentId;
      }
    }

    return bestAgent;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private buildStepInput(
    step: OrchestrationStep,
    chainInput: string,
    task: OrchestrationTask,
  ): string {
    // If step has a specific task, use it; otherwise use the chain input
    if (step.task && step.task !== chainInput) {
      return `${step.task}\n\nContext from previous steps:\n${chainInput}`;
    }
    return chainInput;
  }

  private mapPriority(
    priority?: OrchestrationTask['priority'],
  ): TaskPriority {
    if (!priority) return 'normal';
    return ORCHESTRATION_PRIORITY_MAP[priority] ?? 'normal';
  }

  private validateTask(task: OrchestrationTask): string | null {
    if (!task.steps || task.steps.length === 0) {
      return 'Orchestration task must have at least one step';
    }
    if (!task.companyId) {
      return 'companyId is required';
    }
    if (!task.userId) {
      return 'userId is required';
    }
    if (!task.input) {
      return 'input is required';
    }

    // Validate step dependencies exist
    const stepIds = new Set(task.steps.map((s) => s.id));
    for (const step of task.steps) {
      if (!step.id) {
        return 'Every step must have an id';
      }
      if (!step.agentId) {
        return `Step ${step.id} must have an agentId`;
      }
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!stepIds.has(depId)) {
            return `Step ${step.id} depends on unknown step ${depId}`;
          }
        }
      }
    }

    // Check for circular dependencies
    if (this.hasCircularDependency(task.steps)) {
      return 'Circular dependency detected in steps';
    }

    return null;
  }

  private hasCircularDependency(steps: OrchestrationStep[]): boolean {
    const visited = new Set<string>();
  const recursionStack = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.id, s]));

  const dfs = (stepId: string): boolean => {
    if (recursionStack.has(stepId)) return true;
    if (visited.has(stepId)) return false;

    visited.add(stepId);
    recursionStack.add(stepId);

    const step = stepMap.get(stepId);
    if (step?.dependsOn) {
      for (const depId of step.dependsOn) {
        if (dfs(depId)) return true;
      }
    }

    recursionStack.delete(stepId);
    return false;
  };

  for (const step of steps) {
    if (dfs(step.id)) return true;
  }

  return false;
  }

  private async emitEvent(
    task: OrchestrationTask,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.eventBus.publish({
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: `orchestrator.${eventType}`,
        source: 'multi-agent-orchestrator',
        companyId: task.companyId,
        userId: task.userId,
        data,
        priority: 'normal',
        timestamp: new Date(),
        correlationId: task.id,
      });
    } catch {
      // Event bus failure is non-critical
    }
  }
}

// ─── Semaphore ──────────────────────────────────────────────────────

class Semaphore {
  private current = 0;
  private waiters: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    const waiter = this.waiters.shift();
    if (waiter) {
      this.current++;
      waiter();
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _instance: MultiAgentOrchestrator | null = null;
export function getOrchestrator(): MultiAgentOrchestrator {
  if (!_instance) _instance = new MultiAgentOrchestrator();
  return _instance;
}
