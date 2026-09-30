/**
 * Agent Execution Engine
 * The CORE of the agent runtime. Connects AI router to real agent execution.
 * Enhanced with: Event Bus integration, self-healing model fallback, approval checks.
 */

import type {
  AgentTask, ExecutionResult, ExecutionError, TokenUsage,
  TaskPriority, DelegationResult,
} from './types';
import { DEFAULT_TIMEOUT_MS, MAX_DELEGATION_DEPTH, PRIORITY_WEIGHTS } from './types';
import { getAgentStateManager } from './state';
import { getAgentHealthMonitor } from './health';
import { db } from '@/lib/db';
import { getRouter } from '@/lib/ai-router';
import { buildAgentContext } from '@/lib/context-engine';
import {
  classifyTask, selectModelForTask, retrieveRelevantKnowledge,
  validateExecution, storeExecutionMemory, buildRAGContextSection,
} from './pipeline';
import { getEventBus } from '@/lib/event-bus';
import { getApprovalEngine } from '@/lib/approval-engine';

// ─── Model Fallback Constants ────────────────────────────────────────

/** Error codes eligible for model fallback self-healing */
export const FALLBACK_RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  'CIRCUIT_OPEN',
  'TIMEOUT',
  'RATE_LIMITED',
]);

/** Model fallback chain: reasoning → balanced → fast → coding */
export const MODEL_FALLBACK_CHAIN: Readonly<Record<string, string>> = {
  'reasoning': 'balanced',
  'balanced': 'fast',
  'fast': 'coding',
};

// ─── Execution Queue (priority-sorted) ─────────────────────────────

class PriorityQueue {
  private queue: AgentTask[] = [];

  enqueue(task: AgentTask): void {
    const weight = PRIORITY_WEIGHTS[task.priority] ?? 10;
    // Insert sorted by priority (highest first)
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      const existingWeight = PRIORITY_WEIGHTS[this.queue[i].priority] ?? 10;
      if (weight > existingWeight) {
        this.queue.splice(i, 0, task);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.queue.push(task);
  }

  dequeue(): AgentTask | undefined {
    return this.queue.shift();
  }

  remove(taskId: string): void {
    this.queue = this.queue.filter(t => t.id !== taskId);
  }

  peek(): AgentTask | undefined {
    return this.queue[0];
  }

  get size(): number {
    return this.queue.length;
  }

  all(): AgentTask[] {
    return [...this.queue];
  }
}

// ─── Execution Engine ──────────────────────────────────────────────

export class AgentExecutionEngine {
  private stateManager: ReturnType<typeof getAgentStateManager>;
  private healthMonitor: ReturnType<typeof getAgentHealthMonitor>;
  private queue = new PriorityQueue();
  private processing = false;
  private delegationDepth = new Map<string, number>(); // taskId -> depth
  private abortControllers = new Map<string, AbortController>();
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.stateManager = getAgentStateManager();
    this.healthMonitor = getAgentHealthMonitor();
    this.startDispatcher();
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Submit a task for execution.
   * If async, queues and returns immediately.
   * If sync, blocks until completion.
   */
  async execute(params: {
    agentId: string;
    companyId: string;
    userId: string;
    task: string;
    priority?: TaskPriority;
    systemPrompt?: string;
    context?: Record<string, unknown>;
    tools?: string[];
    maxTokens?: number;
    timeoutMs?: number;
    mode?: 'sync' | 'async';
    parentTaskId?: string;
    delegationDepth?: number;
  }): Promise<AgentTask> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mode = params.mode ?? 'async';

    const agentTask: AgentTask = {
      id: taskId,
      agentId: params.agentId,
      companyId: params.companyId,
      userId: params.userId,
      parentTaskId: params.parentTaskId,
      tier: 'worker',
      priority: params.priority ?? 'normal',
      riskLevel: 'low',
      status: 'created',
      mode: mode === 'sync' ? 'sync' : 'async',
      input: params.task,
      context: params.context,
      systemPrompt: params.systemPrompt,
      tools: params.tools,
      maxTokens: params.maxTokens,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.stateManager.createTask(agentTask);

    if (mode === 'sync') {
      return this.runTask(taskId);
    }

    // Async: enqueue
    this.stateManager.transition(taskId, 'ready', 'Queued for execution');
    this.queue.enqueue(this.stateManager.getTask(taskId)!);

    return this.stateManager.getTask(taskId)!;
  }

  /** Cancel a running task */
  cancel(taskId: string): boolean {
    const task = this.stateManager.getTask(taskId);
    if (!task) return false;
    if (task.status !== 'running' && task.status !== 'ready') return false;

    this.queue.remove(taskId);
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(taskId);
    }

    try {
      this.stateManager.transition(taskId, 'failed', 'Cancelled by user');
    } catch { /* already in terminal state */ }
    return true;
  }

  /** Delegate a task to another agent */
  async delegate(params: {
    sourceTaskId: string;
    targetAgentId: string;
    task: string;
    context?: Record<string, unknown>;
  }): Promise<ExecutionResult> {
    const sourceTask = this.stateManager.getTask(params.sourceTaskId);
    if (!sourceTask) throw new Error(`Source task ${params.sourceTaskId} not found`);

    const currentDepth = this.delegationDepth.get(params.sourceTaskId) ?? 0;
    if (currentDepth >= MAX_DELEGATION_DEPTH) {
      throw new Error(`Max delegation depth (${MAX_DELEGATION_DEPTH}) exceeded`);
    }

    const result = await this.execute({
      agentId: params.targetAgentId,
      companyId: sourceTask.companyId,
      userId: sourceTask.userId,
      task: params.task,
      context: { ...params.context, delegatedFrom: params.sourceTaskId },
      mode: 'sync',
      parentTaskId: params.sourceTaskId,
      delegationDepth: currentDepth + 1,
    });

    return result.result!;
  }

  /** Get current queue status */
  getStatus() {
    return {
      queueDepth: this.queue.size,
      activeTasks: this.stateManager.getActiveTasks().length,
      processing: this.processing,
    };
  }

  /** Get all queued tasks */
  getQueue(): AgentTask[] {
    return this.queue.all();
  }

  destroy(): void {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.stateManager.destroy();
  }

  // ─── Internal: Task Runner ─────────────────────────────────────

  private async runTask(taskId: string): Promise<AgentTask> {
    const task = this.stateManager.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const startTime = Date.now();
    const abortController = new AbortController();
    this.abortControllers.set(taskId, abortController);

    try {
      // 1. Transition to running
      if (!this.stateManager.canExecute(task.agentId, task.companyId)) {
        // Queue if at capacity
        if (task.status === 'created') {
          this.stateManager.transition(taskId, 'ready', 'At capacity, requeued');
          this.queue.enqueue(this.stateManager.getTask(taskId)!);
          return this.stateManager.getTask(taskId)!;
        }
      }

      this.stateManager.acquireSlot(task.agentId, task.companyId);
      this.stateManager.transition(taskId, 'running', 'Execution started');

      // 2. Load agent config from DB
      const agent = await db.agent.findUnique({ where: { agentId: task.agentId } });
      if (!agent) {
        throw new Error(`Agent ${task.agentId} not found in database`);
      }

      // 3. Classify task for intelligent model routing
      const taskClassification = classifyTask(task.input, agent.role, agent.type);
      const selectedModel = selectModelForTask(taskClassification);

      // ── Event: agent.task.started ─────────────────────────────
      try {
        getEventBus().publish({
          id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'agent.task.started',
          source: task.agentId,
          companyId: task.companyId,
          userId: task.userId,
          data: {
            taskId,
            agentId: task.agentId,
            companyId: task.companyId,
            userId: task.userId,
            input: task.input,
            priority: task.priority,
            modelTier: taskClassification.suggestedModelTier,
          },
          priority: task.priority,
          timestamp: new Date(),
          correlationId: taskId,
        }).catch(() => {});
      } catch { /* event bus failure must not break execution */ }

      // ── Approval Check for High-Risk Tasks ─────────────────────
      try {
        const needsApproval =
          task.priority === 'critical' || task.priority === 'high' ||
          task.riskLevel === 'high' || task.riskLevel === 'critical';

        if (needsApproval) {
          const approvalEngine = getApprovalEngine();
          const decision = await approvalEngine.submit({
            agentId: task.agentId,
            companyId: task.companyId,
            userId: task.userId,
            taskId,
            action: 'agent_execution',
            riskLevel: task.riskLevel,
            description: task.input.slice(0, 200),
          });

          if (!decision.approved) {
            const blockMessage = `Task blocked: Approval required for ${task.riskLevel}-risk action`;
            try {
              this.stateManager.transition(taskId, 'waiting_approval', blockMessage);
            } catch { /* transition may fail */ }

            task.error = {
              code: 'APPROVAL_REQUIRED',
              message: blockMessage,
              retryable: false,
              attempts: 1,
              maxRetries: 0,
              lastAttemptAt: new Date(),
            };

            return this.stateManager.getTask(taskId)!;
          }
        }
      } catch { /* approval engine failure must not break normal execution */ }

      // 4. Retrieve task-relevant knowledge via RAG
      let ragContext;
      let ragSection = '';
      try {
        ragContext = await retrieveRelevantKnowledge(task.input, agent.departmentId, 3);
        if (ragContext.results.length > 0) {
          ragSection = buildRAGContextSection(ragContext);
        }
      } catch (ragError) {
        console.warn(`[AgentRuntime] RAG retrieval failed for ${task.agentId}:`, ragError);
      }

      // 5. Build system prompt via Context Engine (agent-specific identity, rules, skills, SOPs, knowledge, memory)
      let systemPrompt: string;
      let contextTokens = 0;
      try {
        const builtContext = await buildAgentContext({
          agentId: task.agentId,
          task: task.input,
        });
        systemPrompt = builtContext.systemPrompt;
        // Inject RAG results if available
        if (ragSection) {
          systemPrompt = systemPrompt + '\n\n' + ragSection;
        }
        contextTokens = builtContext.contextTokens + (ragContext ? Math.ceil(ragSection.length / 4) : 0);
      } catch (ctxError) {
        console.warn(`[AgentRuntime] Context engine failed for ${task.agentId}, using fallback:`, ctxError);
        const agentName = agent.name || task.agentId;
        const deptName = agent.departmentName || 'Unknown';
        systemPrompt = `You are ${agentName}, a ${agent.role || 'specialist'} AI employee in the ${deptName} department at ALO Labs. You have access to your department's knowledge, skills, and standard operating procedures. Respond accurately and professionally.`;
        if (ragSection) systemPrompt += '\n\n' + ragSection;
      }

      // 6. Build messages
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: task.input },
      ];

      // 5. Add context as additional user message if provided
      if (task.context && Object.keys(task.context).length > 0) {
        messages.splice(1, 0, {
          role: 'user' as const,
          content: `Additional context:\n${JSON.stringify(task.context, null, 2)}`,
        });
      }

      // 8. Call AI Router with intelligent model routing + self-healing fallback
      const router = getRouter();
      const originalModel = selectedModel;
      const routerRequest = {
        model: selectedModel,
        messages,
        maxTokens: task.maxTokens ?? 4096,
        temperature: taskClassification.complexity === 'simple' ? 0.3 : 0.7,
      };

      let aiResponse;
      let modelFallback = false;
      let fallbackTriggerError: string | undefined;

      try {
        aiResponse = await router.chat(
          routerRequest,
          task.companyId,
          task.agentId,
        );
      } catch (routerError) {
        const routerErrorCode = this.classifyError(routerError);

        if (FALLBACK_RETRYABLE_ERRORS.has(routerErrorCode)) {
          const fallbackModel = MODEL_FALLBACK_CHAIN[originalModel];
          if (fallbackModel) {
            try {
              aiResponse = await router.chat(
                { ...routerRequest, model: fallbackModel },
                task.companyId,
                task.agentId,
              );
              modelFallback = true;
              fallbackTriggerError = routerErrorCode;
            } catch {
              // Fallback also failed — re-throw original error
              throw routerError;
            }
          } else {
            throw routerError;
          }
        } else {
          throw routerError;
        }
      }

      // ── Event: agent.task.self_healed (on successful fallback) ─
      if (modelFallback) {
        try {
          getEventBus().publish({
            id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'agent.task.self_healed',
            source: task.agentId,
            companyId: task.companyId,
            userId: task.userId,
            data: {
              taskId,
              agentId: task.agentId,
              originalModel,
              fallbackModel: aiResponse.model,
              triggerErrorCode: fallbackTriggerError,
              latencyMs: Date.now() - startTime,
            },
            priority: 'high',
            timestamp: new Date(),
            correlationId: taskId,
          }).catch(() => {});
        } catch { /* event bus failure must not break execution */ }
      }

      // 7. Record token usage
      this.stateManager.recordTokens(task.companyId, aiResponse.usage.totalTokens);

      const tokenUsage: TokenUsage = {
        promptTokens: aiResponse.usage.promptTokens,
        completionTokens: aiResponse.usage.completionTokens,
        totalTokens: aiResponse.usage.totalTokens,
        costUsd: this.estimateCost(aiResponse.usage.totalTokens, aiResponse.model),
      };

      // 9. Validate execution result
      const validation = validateExecution(aiResponse.content, task.input, agent.role);

      // 10. Build result
      const result: ExecutionResult = {
        content: aiResponse.content,
        confidence: this.estimateConfidence(aiResponse) * validation.score,
        metadata: {
          model: aiResponse.model,
          finishReason: aiResponse.finishReason,
          latencyMs: aiResponse.latencyMs,
          contextTokens,
          contextSources: ragContext?.results.length ? 'constitution,skills,prompts,sops,knowledge,memory,rag' : 'constitution,skills,prompts,sops,knowledge,memory',
          taskClassification: taskClassification.suggestedModelTier,
          validationScore: validation.score,
          validationPassed: validation.passed,
          ragResults: ragContext?.results.length || 0,
          ...(modelFallback ? { modelFallback: true, originalModel } : {}),
        },
      };

      // 11. Update task
      task.result = result;
      task.tokenUsage = tokenUsage;
      this.stateManager.transition(taskId, 'completed', 'Execution succeeded');

      // ── Event: agent.task.completed ────────────────────────────
      try {
        getEventBus().publish({
          id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'agent.task.completed',
          source: task.agentId,
          companyId: task.companyId,
          userId: task.userId,
          data: {
            taskId,
            agentId: task.agentId,
            model: aiResponse.model,
            latencyMs: Date.now() - startTime,
            confidence: result.confidence,
            contextTokens,
            contextSources: result.metadata?.contextSources,
            validationScore: validation.score,
          },
          priority: task.priority,
          timestamp: new Date(),
          correlationId: taskId,
        }).catch(() => {});
      } catch { /* event bus failure must not break execution */ }

      // 12. Store execution in AgentRun (with full pipeline metadata)
      try {
        await db.agentRun.create({
          data: {
            agentId: agent.id,
            agentName: agent.name,
            input: task.input,
            output: aiResponse.content,
            durationMs: Date.now() - startTime,
            model: aiResponse.model,
            tokensUsed: aiResponse.usage.totalTokens,
            companyId: task.companyId,
            latencyMs: aiResponse.latencyMs,
            confidence: result.confidence,
            contextSources: result.metadata?.contextSources as string || '',
            status: 'completed',
          },
        });
      } catch { /* AgentRun write may fail — continue */ }

      // 13. Memory write-back and learning
      storeExecutionMemory({
        agentDbId: agent.id,
        agentId: task.agentId,
        task: task.input,
        result: aiResponse.content,
        model: aiResponse.model,
        latencyMs: Date.now() - startTime,
        confidence: result.confidence,
        validation,
        contextSources: result.metadata?.contextSources as string || '',
      }).catch(() => { /* best-effort learning */ });

      // 14. Record health
      this.healthMonitor.recordSuccess(task.agentId, Date.now() - startTime);

      // 15. Audit log
      await this.createAuditLog(task, 'success', aiResponse.latencyMs);

      // 16. Store in DB if AuditLog model exists (userId FK validated first)
      try {
        // Only set userId if it references a valid User record
        const auditData: Record<string, unknown> = {
          action: 'agent_execution',
          resource: task.agentId,
          details: JSON.stringify({
            taskId, agentId: task.agentId, companyId: task.companyId,
            tokens: tokenUsage.totalTokens,
            latencyMs: Date.now() - startTime,
          }),
        };
        // Validate userId FK exists before writing
        if (task.userId && task.userId !== 'anonymous') {
          const userExists = await db.user.findUnique({ where: { id: task.userId }, select: { id: true } });
          if (userExists) auditData.userId = task.userId;
        }
        await db.auditLog.create({ data: auditData as never });
      } catch { /* audit log write failed — non-critical */ }

      return this.stateManager.getTask(taskId)!;
    } catch (error) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const retryable = this.isRetryable(error);
      const errorCode = this.classifyError(error);

      // ── Event: agent.task.failed ──────────────────────────────
      try {
        getEventBus().publish({
          id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'agent.task.failed',
          source: task.agentId,
          companyId: task.companyId,
          userId: task.userId,
          data: {
            taskId,
            agentId: task.agentId,
            errorCode,
            errorMessage,
            latencyMs: latency,
          },
          priority: task.priority,
          timestamp: new Date(),
          correlationId: taskId,
        }).catch(() => {});
      } catch { /* event bus failure must not break execution */ }

      task.error = {
        code: errorCode,
        message: errorMessage,
        retryable,
        attempts: (task.error?.attempts ?? 0) + 1,
        maxRetries: 3,
        lastAttemptAt: new Date(),
      };

      try {
        this.stateManager.transition(taskId, 'failed', `Execution failed: ${errorMessage}`);
      } catch { /* already in terminal state */ }

      this.healthMonitor.recordFailure(task.agentId, latency, errorMessage);

      await this.createAuditLog(task, 'failure', latency).catch(() => {});

      return this.stateManager.getTask(taskId)!;
    } finally {
      this.abortControllers.delete(taskId);
      this.stateManager.releaseSlot(task.companyId);
    }
  }

  // ─── Internal: Dispatcher ──────────────────────────────────────

  private startDispatcher(): void {
    // Process queue every 500ms
    this.dispatchTimer = setInterval(() => {
      this.processQueue();
    }, 500);
  }

  private processQueue(): void {
    if (this.processing) return;
    if (this.queue.size === 0) return;

    const task = this.queue.dequeue();
    if (!task) return;

    // Skip if no longer in ready state
    if (task.status !== 'ready') return;

    this.processing = true;
    this.runTask(task.id)
      .catch((err) => console.error(`[AgentRuntime] Task ${task.id} error:`, err))
      .finally(() => { this.processing = false; });
  }

  // ─── Internal: Helpers ─────────────────────────────────────────

  private estimateConfidence(aiResponse: { finishReason: string; model: string }): number {
    if (aiResponse.finishReason === 'stop') return 0.9
    if (aiResponse.finishReason === 'length') return 0.5
    return 0.7
  }

  private estimateCost(totalTokens: number, model: string): number {
    // Rough cost estimation (per 1M tokens)
 const costPerMillion: Record<string, number> = {
      'claude-3.5-sonnet': 3, 'gpt-4o': 2.5, 'gpt-4o-mini': 0.15,
      'llama3': 0, 'mistral': 0.4, 'deepseek': 0.14,
    };
    const rate = Object.entries(costPerMillion).find(([k]) => model.includes(k))?.[1] ?? 2;
    return (totalTokens / 1_000_000) * rate;
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes('timeout') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('503') ||
        msg.includes('429') ||
        msg.includes('circuit')
      );
    }
    return false;
  }

  private classifyError(error: unknown): string {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout')) return 'TIMEOUT';
      if (msg.includes('rate limit') || msg.includes('429')) return 'RATE_LIMITED';
      if (msg.includes('circuit')) return 'CIRCUIT_OPEN';
      if (msg.includes('not found')) return 'NOT_FOUND';
      if (msg.includes('auth') || msg.includes('unauthorized')) return 'AUTH_ERROR';
      if (msg.includes('budget') || msg.includes('token')) return 'BUDGET_EXCEEDED';
    }
    return 'UNKNOWN_ERROR';
  }

  private async createAuditLog(
    task: AgentTask,
    _status: string,
    _latency: number,
  ): Promise<void> {
    // Audit logging is done in the runTask success/failure paths
    // This method is a hook point for extensibility
  }
}

// Singleton
let _instance: AgentExecutionEngine | null = null;
export function getExecutionEngine(): AgentExecutionEngine {
  if (!_instance) _instance = new AgentExecutionEngine();
  return _instance;
}
