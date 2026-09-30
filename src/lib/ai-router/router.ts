/**
 * AI Router
 * ALO Labs AIOS — Intelligent request routing, load balancing, and failover
 * across multiple AI providers with circuit-breaker protection.
 */

import type {
  AIProvider,
  AIModel,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  AIProviderHealth,
  AITokenUsageRecord,
  AIRouteDecision,
  AILoadBalanceConfig,
  AICapability,
} from './types';
import {
  AIRouterError,
  AICircuitOpenError,
  AIProviderUnavailableError,
  AIModelNotFoundError,
} from './types';
import { BaseAIProvider } from './provider-base';

// ─── Constants ──────────────────────────────────────────────────────

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

// ─── Internal State ─────────────────────────────────────────────────

interface ProviderEntry {
  provider: BaseAIProvider;
  health: AIProviderHealth;
  /** Rolling window of request latencies (last 20) */
  latencies: number[];
  /** Rolling window of error booleans (last 20) */
  errors: boolean[];
  /** Current position for round-robin */
  rrIndex: number;
  /** Weight assigned to this provider for weighted strategy */
  weight: number;
}

interface UsageRecordInternal {
  provider: AIProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  companyId: string | undefined;
  agentId: string | undefined;
  timestamp: Date;
}

// ─── Router ─────────────────────────────────────────────────────────

export class AIRouter {
  private providers = new Map<AIProvider, ProviderEntry>();
  private usageHistory: UsageRecordInternal[] = [];
  private loadBalanceConfig: AILoadBalanceConfig = {
    strategy: 'round-robin',
  };
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private _destroyed = false;

  // ─── Provider Management ────────────────────────────────────────

  registerProvider(provider: BaseAIProvider, weight?: number): void {
    if (this.providers.has(provider.name)) {
      throw new AIRouterError(
        `Provider "${provider.name}" is already registered.`,
        provider.name,
      );
    }

    this.providers.set(provider.name, {
      provider,
      health: {
        provider: provider.name,
        isHealthy: true, // assumed healthy until first check
        latencyMs: 0,
        errorRate: 0,
        lastCheck: new Date(),
        consecutiveFailures: 0,
        circuitOpen: false,
      },
      latencies: [],
      errors: [],
      rrIndex: 0,
      weight: weight ?? 1,
    });
  }

  removeProvider(name: AIProvider): void {
    const entry = this.providers.get(name);
    if (!entry) return;
    entry.provider.disconnect().catch(() => { /* best-effort */ });
    this.providers.delete(name);
  }

  getProvider(name: AIProvider): BaseAIProvider | undefined {
    return this.providers.get(name)?.provider;
  }

  getRegisteredProviders(): AIProvider[] {
    return Array.from(this.providers.keys());
  }

  // ─── Load Balance Config ────────────────────────────────────────

  setLoadBalanceConfig(config: AILoadBalanceConfig): void {
    this.loadBalanceConfig = config;
    // Sync weights from config to entries
    if (config.weights) {
      config.weights.forEach((weight, provider) => {
        const entry = this.providers.get(provider);
        if (entry) entry.weight = weight;
      });
    }
  }

  getLoadBalanceConfig(): AILoadBalanceConfig {
    return { ...this.loadBalanceConfig };
  }

  // ─── Routing Decision ───────────────────────────────────────────

  /**
   * Pick the best provider and model for a given request.
   * Considers: explicit model → capability matching → strategy → cost.
   */
  route(request: AIRequest): AIRouteDecision {
    const available = this.getAvailableProviders();

    if (available.length === 0) {
      throw new AIProviderUnavailableError(
        'ollama',
        'No providers are available. All circuits are open or no providers registered.',
      );
    }

    // If a specific model is requested, find the provider that has it
    if (request.model) {
      const direct = this.findProviderForModel(request.model, available);
      if (direct) {
        return { provider: direct.provider.name, model: request.model, reason: 'quality' };
      }
    }

    // Filter providers by capability matching (e.g., streaming, function-calling)
    const capable = this.filterByCapabilities(available, request);
    const candidates = capable.length > 0 ? capable : available;

    // Apply load-balance strategy
    const selected = this.selectProviderByStrategy(candidates);

    // Pick the best model from the selected provider
    const model = this.selectBestModel(selected.provider, request);

    // Determine route reason based on strategy
    let reason: AIRouteDecision['reason'] = 'quality';
    if (this.loadBalanceConfig.strategy === 'least-connections') reason = 'speed';
    if (model.costPerMillionTokens !== undefined) reason = 'cost';

    return {
      provider: selected.provider.name,
      model: model.id,
      reason,
    };
  }

  // ─── Chat Completion ────────────────────────────────────────────

  async chat(request: AIRequest, companyId?: string, agentId?: string): Promise<AIResponse> {
    // Auto-initialize any registered but uninitialized providers
    await this.ensureProvidersInitialized();

    const decision = this.route(request);
    const entry = this.providers.get(decision.provider);

    if (!entry) {
      throw new AIProviderUnavailableError(decision.provider, 'Provider was removed during routing.');
    }

    // Circuit breaker check
    if (entry.health.circuitOpen) {
      throw new AICircuitOpenError(decision.provider, entry.health.circuitOpenUntil!);
    }

    const startTime = Date.now();

    try {
      // Build request with the routed model
      const routedRequest: AIRequest = { ...request, model: decision.model };

      const response = await entry.provider.chatCompletion(routedRequest);

      // Record success
      this.recordLatency(entry, Date.now() - startTime);
      this.recordSuccess(entry);
      this.recordUsage({
        provider: decision.provider,
        model: response.model,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        companyId,
        agentId,
        timestamp: new Date(),
      });

      return { ...response, model: response.model || decision.model };
    } catch (err) {
      this.recordFailure(entry);
      this.handleCircuitBreaker(entry);

      // Attempt failover on circuit-open, provider-unavailable, or retryable errors
      const isRetryable = err instanceof AIRouterError && err.retryable;
      if (err instanceof AICircuitOpenError || err instanceof AIProviderUnavailableError || isRetryable) {
        const fallback = await this.attemptFailover(request, decision.provider, companyId, agentId);
        if (fallback) return fallback;
      }

      // If error is from a different provider (e.g. AIModelNotFoundError), rethrow
      if (err instanceof AIModelNotFoundError) throw err;
      if (err instanceof AIRouterError) throw err;

      throw new AIRouterError(
        `All providers failed for model "${request.model}". Last error: ${err instanceof Error ? err.message : String(err)}`,
        decision.provider,
        undefined,
        false,
      );
    }
  }

  // ─── Streaming Chat Completion ──────────────────────────────────

  async *streamChat(request: AIRequest, companyId?: string, agentId?: string): AsyncGenerator<AIStreamChunk> {
    // Auto-initialize any registered but uninitialized providers
    await this.ensureProvidersInitialized();

    const decision = this.route(request);
    const entry = this.providers.get(decision.provider);

    if (!entry) {
      throw new AIProviderUnavailableError(decision.provider);
    }

    if (entry.health.circuitOpen) {
      throw new AICircuitOpenError(decision.provider, entry.health.circuitOpenUntil!);
    }

    let promptTokens = this.estimatePromptTokens(request);

    try {
      const routedRequest: AIRequest = { ...request, model: decision.model };
      const startTime = Date.now();
      let completionTokens = 0;

      for await (const chunk of entry.provider.streamChatCompletion(routedRequest)) {
        if (chunk.content) {
          completionTokens += Math.ceil(chunk.content.length / 4);
        }
        yield chunk;

        if (chunk.finishReason) {
          this.recordUsage({
            provider: decision.provider,
            model: chunk.model || decision.model,
            promptTokens,
            completionTokens,
            companyId,
            agentId,
            timestamp: new Date(),
          });
        }
      }

      this.recordLatency(entry, Date.now() - startTime);
      this.recordSuccess(entry);
    } catch (err) {
      this.recordFailure(entry);
      this.handleCircuitBreaker(entry);

      // Attempt failover streaming
      if (err instanceof AICircuitOpenError || err instanceof AIProviderUnavailableError) {
        const fallbackStream = this.attemptStreamFailover(request, decision.provider, companyId, agentId);
        if (fallbackStream) {
          yield* fallbackStream;
          return;
        }
      }

      throw err;
    }
  }

  // ─── Health Status ──────────────────────────────────────────────

  async getHealthStatus(): Promise<Map<AIProvider, AIProviderHealth>> {
    const status = new Map<AIProvider, AIProviderHealth>();

    const checks = Array.from(this.providers.entries()).map(async ([name, entry]) => {
      try {
        const health = await entry.provider.healthCheck();
        // Merge with our internal circuit-breaker state
        health.circuitOpen = entry.health.circuitOpen;
        health.circuitOpenUntil = entry.health.circuitOpenUntil;
        health.consecutiveFailures = entry.health.consecutiveFailures;
        entry.health = health;
        status.set(name, health);
      } catch {
        status.set(name, entry.health);
      }
    });

    await Promise.all(checks);
    return status;
  }

  // ─── Usage Stats ────────────────────────────────────────────────

  getUsageStats(period: { start: Date; end: Date }): AITokenUsageRecord[] {
    return this.usageHistory
      .filter((r) => r.timestamp >= period.start && r.timestamp <= period.end)
      .map((r) => ({ ...r }));
  }

  // ─── Rebalance ──────────────────────────────────────────────────

  rebalance(): void {
    this.providers.forEach((entry) => {
      if (entry.health.circuitOpen) {
        // Check if cooldown has elapsed
        if (
          entry.health.circuitOpenUntil &&
          Date.now() >= entry.health.circuitOpenUntil.getTime()
        ) {
          entry.health.circuitOpen = false;
          entry.health.consecutiveFailures = 0;
          entry.health.circuitOpenUntil = undefined;
        }
      }
    });
  }

  // ─── Background Health Checks ───────────────────────────────────

  startHealthChecks(intervalMs: number = HEALTH_CHECK_INTERVAL_MS): void {
    this.stopHealthChecks();
    this.healthCheckTimer = setInterval(async () => {
      if (this._destroyed) return;
      this.rebalance();
      await this.getHealthStatus();
    }, intervalMs);
  }

  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    this._destroyed = true;
    this.stopHealthChecks();
    const disconnects = Array.from(this.providers.values()).map((e) =>
      e.provider.disconnect().catch(() => {}),
    );
    await Promise.all(disconnects);
    this.providers.clear();
    this.usageHistory = [];
  }

  // ─── Private: Strategy Selection ────────────────────────────────

  private selectProviderByStrategy(available: ProviderEntry[]): ProviderEntry {
    switch (this.loadBalanceConfig.strategy) {
      case 'least-connections': {
        return available.reduce((best, curr) =>
          curr.provider.activeConnections < best.provider.activeConnections ? curr : best,
        );
      }

      case 'weighted': {
        const totalWeight = available.reduce((sum, e) => sum + e.weight, 0);
        let random = Math.random() * totalWeight;
        for (const entry of available) {
          random -= entry.weight;
          if (random <= 0) return entry;
        }
        return available[available.length - 1];
      }

      case 'random': {
        return available[Math.floor(Math.random() * available.length)];
      }

      case 'round-robin':
      default: {
        // Find the entry with the lowest rrIndex, then increment it
        const sorted = [...available].sort((a, b) => a.rrIndex - b.rrIndex);
        const selected = sorted[0];
        selected.rrIndex++;
        return selected;
      }
    }
  }

  private selectBestModel(provider: BaseAIProvider, request: AIRequest): AIModel {
    const models = provider.supportedModels;
    if (models.length === 0) {
      throw new AIModelNotFoundError('any', provider.name);
    }

    // Prefer models that fit in context
    const fitting = models.filter((m) => provider.fitsInContext(request, m));
    const candidates = fitting.length > 0 ? fitting : models;

    // Sort by: most capabilities first (quality), then lowest cost (cost-aware)
    const sorted = [...candidates].sort((a, b) => {
      // Prefer more capabilities
      const capDiff = b.capabilities.length - a.capabilities.length;
      if (capDiff !== 0) return capDiff;
      // Then prefer lower cost
      const aCost = a.costPerMillionTokens ?? Infinity;
      const bCost = b.costPerMillionTokens ?? Infinity;
      return aCost - bCost;
    });
    return sorted[0];
  }

  // ─── Private: Failover ──────────────────────────────────────────

  private async attemptFailover(
    request: AIRequest,
    failedProvider: AIProvider,
    companyId?: string,
    agentId?: string,
  ): Promise<AIResponse | null> {
    const available = this.getAvailableProviders().filter(
      (e) => e.provider.name !== failedProvider,
    );

    for (const entry of available) {
      try {
        const routedRequest: AIRequest = { ...request, model: entry.provider.supportedModels[0]?.id ?? request.model };
        const response = await entry.provider.chatCompletion(routedRequest);

        this.recordUsage({
          provider: entry.provider.name,
          model: response.model,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          companyId,
          agentId,
          timestamp: new Date(),
        });

        return {
          ...response,
          model: response.model,
        };
      } catch {
        this.recordFailure(entry);
        this.handleCircuitBreaker(entry);
        continue;
      }
    }

    return null;
  }

  private attemptStreamFailover(
    request: AIRequest,
    failedProvider: AIProvider,
    companyId?: string,
    agentId?: string,
  ): AsyncGenerator<AIStreamChunk> | null {
    const available = this.getAvailableProviders().filter(
      (e) => e.provider.name !== failedProvider,
    );

    if (available.length === 0) return null;

    // Return the first available provider's stream generator
    const entry = available[0];
    const modelId = entry.provider.supportedModels[0]?.id ?? request.model;
    // We need to return an async generator, so we create a wrapper
    // Using arrow function to preserve `this` context
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const router = this;
    const generate = async function* (this: void): AsyncGenerator<AIStreamChunk> {
      const routedRequest: AIRequest = { ...request, model: modelId };
      let completionTokens = 0;
      const promptTokens = router.estimatePromptTokens(request);

      try {
        for await (const chunk of entry.provider.streamChatCompletion(routedRequest)) {
          if (chunk.content) {
            completionTokens += Math.ceil(chunk.content.length / 4);
          }
          yield chunk;

          if (chunk.finishReason) {
            router.recordUsage({
              provider: entry.provider.name,
              model: chunk.model || modelId,
              promptTokens,
              completionTokens,
              companyId,
              agentId,
              timestamp: new Date(),
            });
          }
        }
        router.recordSuccess(entry);
      } catch {
        router.recordFailure(entry);
        router.handleCircuitBreaker(entry);
      }
    };

    return generate();
  }

  // ─── Private: Provider Helpers ──────────────────────────────────

  /**
   * Ensure all registered providers are initialized.
   * Called automatically before each chat/stream request.
   */
  private async ensureProvidersInitialized(): Promise<void> {
    const uninitialized = Array.from(this.providers.values()).filter(
      (e) => !e.provider.initialized,
    );
    await Promise.allSettled(
      uninitialized.map(async (e) => {
        try {
          await e.provider.initialize();
        } catch (err) {
          console.warn(`[AI Router] Failed to initialize provider ${e.provider.name}:`, err instanceof Error ? err.message : String(err));
        }
      }),
    );
  }

  private getAvailableProviders(): ProviderEntry[] {
    return Array.from(this.providers.values()).filter(
      (e) => !e.health.circuitOpen && e.provider.initialized,
    );
  }

  private findProviderForModel(
    modelId: string,
    available: ProviderEntry[],
  ): ProviderEntry | undefined {
    return available.find((e) =>
      e.provider.supportedModels.some((m) => m.id === modelId),
    );
  }

  /**
   * Filter providers that support the capabilities implied by the request.
   * E.g., if the request asks for streaming, prefer providers with streaming capability.
   */
  private filterByCapabilities(
    available: ProviderEntry[],
    request: AIRequest,
  ): ProviderEntry[] {
    const requiredCapabilities: AICapability[] = ['chat'];
    if (request.stream) requiredCapabilities.push('streaming');
    if (request.tools && request.tools.length > 0) requiredCapabilities.push('function-calling');

    return available.filter((e) =>
      requiredCapabilities.every((cap) =>
        e.provider.supportedModels.some((m) => m.capabilities.includes(cap)),
      ),
    );
  }

  // ─── Private: Circuit Breaker ───────────────────────────────────

  private handleCircuitBreaker(entry: ProviderEntry): void {
    entry.health.consecutiveFailures++;

    if (entry.health.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      entry.health.circuitOpen = true;
      entry.health.circuitOpenUntil = new Date(Date.now() + CIRCUIT_COOLDOWN_MS);
    }
  }

  // ─── Private: Metrics ───────────────────────────────────────────

  private recordLatency(entry: ProviderEntry, latencyMs: number): void {
    entry.latencies.push(latencyMs);
    if (entry.latencies.length > 20) entry.latencies.shift();
    entry.health.latencyMs =
      entry.latencies.reduce((a, b) => a + b, 0) / entry.latencies.length;
  }

  private recordSuccess(entry: ProviderEntry): void {
    entry.errors.push(false);
    if (entry.errors.length > 20) entry.errors.shift();
    entry.health.errorRate =
      entry.errors.filter(Boolean).length / entry.errors.length;
    entry.health.consecutiveFailures = 0;
  }

  private recordFailure(entry: ProviderEntry): void {
    entry.errors.push(true);
    if (entry.errors.length > 20) entry.errors.shift();
    entry.health.errorRate =
      entry.errors.filter(Boolean).length / entry.errors.length;
  }

  private recordUsage(record: UsageRecordInternal): void {
    this.usageHistory.push(record);
    // Keep last 10,000 records in memory
    if (this.usageHistory.length > 10_000) {
      this.usageHistory = this.usageHistory.slice(-5_000);
    }
  }

  private estimatePromptTokens(request: AIRequest): number {
    // Re-use the base provider estimation logic
    const provider = this.providers.values().next().value?.provider;
    if (provider) return provider.estimateRequestTokens(request) - (request.maxTokens ?? 1024);
    return 0;
  }
}