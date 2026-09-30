/**
 * AI Router — Public API
 * ALO Labs AIOS
 *
 * Re-exports all types, base classes, providers, and the singleton router.
 */

// ─── Types ──────────────────────────────────────────────────────────
export type {
  AIProvider,
  AIModel,
  AIModelFamily,
  AIModelParameters,
  AICapability,
  AIMessage,
  AITool,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  AITokenUsage,
  AITokenUsageRecord,
  AIRouteDecision,
  AIRouteReason,
  AILoadBalanceStrategy,
  AILoadBalanceConfig,
  AIProviderHealth,
} from './types';

export {
  AIRouterError,
  AIProviderUnavailableError,
  AIModelNotFoundError,
  AICircuitOpenError,
} from './types';

// ─── Base ───────────────────────────────────────────────────────────
export { BaseAIProvider } from './provider-base';

// ─── Providers ──────────────────────────────────────────────────────
export { OllamaProvider } from './ollama-provider';
export { OpenRouterProvider } from './openrouter-provider';
export { ZAIProvider } from './zai-provider';
export { GroqProvider } from './groq-provider';
export { DeepSeekProvider } from './deepseek-provider';
export { MistralProvider } from './mistral-provider';
export { QwenProvider } from './qwen-provider';
export { LlamaProvider } from './llama-provider';
export { PhiProvider } from './phi-provider';
export { GemmaProvider } from './gemma-provider';

// ─── Router ─────────────────────────────────────────────────────────
export { AIRouter } from './router';

// ─── Singleton ──────────────────────────────────────────────────────
import { AIRouter } from './router';
import { ZAIProvider } from './zai-provider';

export const aiRouter = new AIRouter();

/**
 * Lazy singleton accessor for the AI Router.
 * Registers the ZAI SDK provider on first use if none are registered.
 * Providers are auto-initialized before each request by the router.
 */
export function getRouter(): AIRouter {
  if (aiRouter.getRegisteredProviders().length === 0) {
    try {
      aiRouter.registerProvider(new ZAIProvider());
    } catch {
      // If ZAI provider fails to construct, leave the router empty.
    }
  }
  return aiRouter;
}
