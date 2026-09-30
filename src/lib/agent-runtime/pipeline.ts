/**
 * AI-EOS Unified Execution Pipeline
 * Connects: Task Classification → Model Routing → RAG → Execution → Validation → Memory → Audit
 * Every AI employee runs through this pipeline.
 */

import { db } from '@/lib/db';
import { hybridSearch } from '@/lib/rag-engine';
import { buildAgentContext } from '@/lib/context-engine';

// ─── Task Classification ──────────────────────────────────────────

export type TaskComplexity = 'simple' | 'normal' | 'complex' | 'reasoning' | 'coding' | 'vision' | 'embedding';

export interface TaskClassification {
  complexity: TaskComplexity;
  reasoning: boolean;
  suggestedModelTier: 'fast' | 'balanced' | 'reasoning' | 'coding' | 'vision' | 'embedding';
  confidence: number;
  signals: string[];
}

/**
 * Classifies the task to determine which model tier to use.
 * Simple → fast, Normal → balanced, Complex/Reasoning → reasoning,
 * Code → coding, Vision → vision, Embedding/RAG → embedding
 */
export function classifyTask(task: string, agentRole: string, agentType: string): TaskClassification {
  const lower = task.toLowerCase();
  const signals: string[] = [];
  let reasoning = false;
  let complexity: TaskComplexity = 'normal';
  let confidence = 0.7;

  // Vision signals
  const visionKeywords = ['image', 'photo', 'picture', 'screenshot', 'diagram', 'chart', 'graph', 'visual', 'draw', 'ocr', 'handwriting', 'face', 'logo'];
  const hasVision = visionKeywords.some(k => lower.includes(k));
  if (hasVision) {
    return { complexity: 'vision', reasoning: false, suggestedModelTier: 'vision', confidence: 0.9, signals: ['vision_keywords'] };
  }

  // Code signals
  const codeKeywords = ['code', 'function', 'implement', 'debug', 'fix bug', 'programming', 'api endpoint', 'database query', 'sql', 'javascript', 'typescript', 'python', 'react', 'component', 'refactor', 'compile', 'deploy', 'script'];
  const codePatterns = [/```\w+/, /function\s+\w+/, /const\s+\w+\s*=\s*\(/, /import\s+.*from/];
  const hasCode = codeKeywords.some(k => lower.includes(k)) || codePatterns.some(p => p.test(task));
  if (hasCode) {
    return { complexity: 'coding', reasoning: true, suggestedModelTier: 'coding', confidence: 0.85, signals: ['code_keywords_or_patterns'] };
  }

  // Embedding/RAG signals
  const embeddingKeywords = ['search', 'find similar', 'embedding', 'vector', 'rag', 'retrieve', 'semantically', 'cluster'];
  if (embeddingKeywords.some(k => lower.includes(k))) {
    return { complexity: 'embedding', reasoning: false, suggestedModelTier: 'embedding', confidence: 0.8, signals: ['embedding_keywords'] };
  }

  // Reasoning signals
  const reasoningKeywords = ['analyze', 'evaluate', 'compare', 'strategy', 'architect', 'design system', 'optimize', 'trade-off', 'complex', 'multi-step', 'chain of thought', 'think step by step', 'reason', 'derive', 'calculate', 'solve', 'investigate', 'diagnose', 'root cause', 'audit', 'compliance'];
  const hasReasoning = reasoningKeywords.some(k => lower.includes(k));
  const isLongTask = task.length > 500;
  const hasMultipleQuestions = (task.match(/\?/g) || []).length >= 2;

  if (hasReasoning || isLongTask || hasMultipleQuestions) {
    reasoning = true;
    complexity = 'complex';
    confidence = 0.8;
    signals.push('reasoning_keywords');
    if (isLongTask) signals.push('long_task');
    if (hasMultipleQuestions) signals.push('multiple_questions');
    return { complexity, reasoning, suggestedModelTier: 'reasoning', confidence, signals };
  }

  // Simple signals
  const simpleKeywords = ['hello', 'hi', 'thanks', 'status', 'list', 'count', 'what is', 'who is', 'summarize briefly', 'quick', 'yes', 'no', 'ok'];
  const isSimple = simpleKeywords.some(k => lower === k || lower.startsWith(k + ' ')) || task.length < 50;
  if (isSimple) {
    return { complexity: 'simple', reasoning: false, suggestedModelTier: 'fast', confidence: 0.75, signals: ['simple_keyword_or_short'] };
  }

  // Agent role-based adjustment
  if (['manager', 'architect', 'strategist', 'director'].includes(agentRole)) {
    confidence = 0.6;
    complexity = 'complex';
    return { complexity, reasoning: true, suggestedModelTier: 'reasoning', confidence, signals: ['managerial_role'] };
  }

  return { complexity: 'normal', reasoning: false, suggestedModelTier: 'balanced', confidence, signals: ['default'] };
}

// ─── Model Routing ──────────────────────────────────────────────

/**
 * Maps a task classification to a specific model identifier.
 * The AI Router's `route()` method accepts a `model` field and
 * finds the provider that supports it.
 */
export function selectModelForTask(classification: TaskClassification): string {
  switch (classification.suggestedModelTier) {
    case 'fast':
      return 'fast';
    case 'reasoning':
      return 'reasoning';
    case 'coding':
      return 'coding';
    case 'vision':
      return 'vision';
    case 'embedding':
      return 'embedding';
    case 'balanced':
    default:
      return 'balanced';
  }
}

// ─── RAG Retrieval ───────────────────────────────────────────────

export interface RAGContext {
  query: string;
  results: Array<{ content: string; score: number; source: string }>;
  totalFound: number;
  durationMs: number;
}

/**
 * Retrieves task-relevant knowledge via RAG hybrid search.
 * Falls back to keyword search on KnowledgeNode if no RAG collections exist.
 */
export async function retrieveRelevantKnowledge(
  task: string,
  departmentId: string,
  maxResults = 3,
): Promise<RAGContext> {
  const startTime = Date.now();

  try {
    // Try RAG hybrid search first
    const ragResult = await hybridSearch(task, {
      limit: maxResults,
      vectorWeight: 0.7,
      keywordWeight: 0.3,
    });

    if (ragResult.results.length > 0) {
      return {
        query: task,
        results: ragResult.results.map(r => ({
          content: r.content,
          score: r.score,
          source: r.source || 'rag',
        })),
        totalFound: ragResult.totalFound,
        durationMs: Date.now() - startTime,
      };
    }
  } catch {
    // RAG search failed, fall back to KnowledgeNode keyword search
  }

  // Fallback: keyword search on KnowledgeNode
  const keywords = task.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
  let knowledgeNodes: Array<{ title: string; content: string; confidence: number }> = [];

  if (keywords.length > 0) {
    const orConditions = keywords.map(kw => ({
      OR: [
        { title: { contains: kw } },
        { content: { contains: kw } },
      ],
    }));
    knowledgeNodes = await db.knowledgeNode.findMany({
      where: {
        OR: [
          { departmentId: null },
          { departmentId },
        ],
        ...orConditions[0],
      },
      orderBy: { confidence: 'desc' },
      take: maxResults,
    });
  } else {
    knowledgeNodes = await db.knowledgeNode.findMany({
      where: {
        OR: [
          { departmentId: null },
          { departmentId },
        ],
      },
      orderBy: { confidence: 'desc' },
      take: maxResults,
    });
  }

  return {
    query: task,
    results: knowledgeNodes.map(k => ({
      content: `## ${k.title}\n${k.content}`,
      score: k.confidence,
      source: 'knowledge-graph',
    })),
    totalFound: knowledgeNodes.length,
    durationMs: Date.now() - startTime,
  };
}

// ─── Post-Execution Validation ──────────────────────────────────

export interface ValidationResult {
  passed: boolean;
  score: number; // 0-1
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

/**
 * Validates agent execution result against quality criteria.
 */
export function validateExecution(result: string, task: string, _agentRole: string): ValidationResult {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  // Check 1: Non-empty response
  const isNonEmpty = result.trim().length > 10;
  checks.push({ name: 'non_empty', passed: isNonEmpty, detail: isNonEmpty ? 'Response has content' : 'Response is empty or too short' });

  // Check 2: Task relevance (keyword overlap)
  const taskWords = new Set(task.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const resultWords = new Set(result.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  let overlapCount = 0;
  for (const tw of taskWords) {
    for (const rw of resultWords) {
      if (tw === rw || rw.includes(tw) || tw.includes(rw)) {
        overlapCount++;
        break;
      }
    }
  }
  const relevanceScore = taskWords.size > 0 ? overlapCount / taskWords.size : 0.5;
  const isRelevant = relevanceScore >= 0.1;
  checks.push({ name: 'task_relevance', passed: isRelevant, detail: `Keyword overlap: ${Math.round(relevanceScore * 100)}%` });

  // Check 3: Minimum length for substantive response
  const isSubstantive = result.length >= 50;
  checks.push({ name: 'substantive', passed: isSubstantive, detail: `Response length: ${result.length} chars` });

  // Check 4: No error patterns in output
  const errorPatterns = ['error:', 'failed to', 'exception', 'i cannot', 'not able to', 'as an ai', 'i\'m just an ai'];
  const hasErrorPattern = errorPatterns.some(p => result.toLowerCase().includes(p));
  checks.push({ name: 'no_error_pattern', passed: !hasErrorPattern, detail: hasErrorPattern ? 'Response contains error/refusal patterns' : 'No error patterns detected' });

  // Check 5: Structured response (has some structure)
  const hasStructure = result.includes('\n') || result.includes('.') || result.includes('-') || result.includes('1.') || result.includes('**');
  checks.push({ name: 'structured', passed: hasStructure, detail: hasStructure ? 'Response has structure' : 'Response lacks structure' });

  const passedCount = checks.filter(c => c.passed).length;
  const score = passedCount / checks.length;
  const passed = score >= 0.6; // At least 60% of checks must pass

  return { passed, score, checks };
}

// ─── Memory Write-Back ──────────────────────────────────────────

/**
 * Stores execution outcome as agent memory for future learning.
 * Creates a learning record and updates hot/warm/cold memory.
 */
export async function storeExecutionMemory(params: {
  agentDbId: string;
  agentId: string;
  task: string;
  result: string;
  model: string;
  latencyMs: number;
  confidence: number;
  validation: ValidationResult;
  contextSources: string;
}): Promise<void> {
  const { agentDbId, agentId, task, result, model, latencyMs, confidence, validation, contextSources } = params;

  // Determine memory category based on validation
  const category = validation.passed ? 'learning' : 'correction';

  // Create a concise memory entry (truncated to prevent bloat)
  const maxMemoryLength = 500;
  const memoryContent = result.length > maxMemoryLength
    ? result.substring(0, maxMemoryLength) + '...'
    : result;

  const memoryEntry = `Task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''} | Model: ${model} | Confidence: ${(confidence * 100).toFixed(0)}% | Validation: ${(validation.score * 100).toFixed(0)}% | Latency: ${latencyMs}ms | ${memoryEntry}`;

  // Store as agent memory
  await db.agentMemory.create({
    data: {
      agentId: agentDbId,
      category,
      content: memoryEntry,
      temperature: validation.passed ? 'warm' : 'hot', // Hot = recent failure, needs attention
      useCount: 1,
      successCount: validation.passed ? 1 : 0,
    },
  }).catch(() => { /* best-effort */ });

  // If validation failed, create a correction memory for faster retrieval
  if (!validation.passed) {
    const failedChecks = validation.checks.filter(c => !c.passed).map(c => c.name).join(', ');
    await db.agentMemory.create({
      data: {
        agentId: agentDbId,
        category: 'correction',
        content: `Failed validation on: ${failedChecks}. Task was: ${task.substring(0, 80)}. Improve: provide substantive, relevant, structured responses without error patterns.`,
        temperature: 'hot',
        useCount: 0,
        successCount: 0,
      },
    }).catch(() => { /* best-effort */ });
  }

  // Create a learning report for analytics
  await db.learningReport.create({
    data: {
      agentId,
      whatWorked: validation.passed ? [`${model} model, ${(confidence * 100).toFixed(0)}% confidence, ${latencyMs}ms latency`] : [],
      whatFailed: validation.passed ? [] : validation.checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`),
      corrections: validation.passed ? [] : ['Improve response quality and relevance'],
      pattern: validation.score >= 0.8 ? 'high_quality' : validation.score >= 0.6 ? 'acceptable' : 'needs_improvement',
      suggestion: validation.score < 0.8 ? 'Consider using a more capable model or providing richer context' : null,
    },
  }).catch(() => { /* best-effort */ });
}

// ─── Conversation History ───────────────────────────────────────

export interface ConversationMessage {
  role: 'system' | 'user' | 'agent';
  content: string;
  timestamp: string;
  model?: string;
  confidence?: number;
}

/**
 * Loads conversation history for multi-turn support.
 */
export async function loadConversationHistory(
  conversationId: string,
  maxMessages = 10,
): Promise<ConversationMessage[]> {
  const messages = await db.conversationMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: maxMessages,
  });

  return messages.map(m => ({
    role: (m.role as 'system' | 'user' | 'agent') || 'user',
    content: m.content,
    timestamp: m.createdAt.toISOString(),
  }));
}

/**
 * Persists a conversation message to the database.
 */
export async function persistConversationMessages(params: {
  conversationId: string;
  userId: string;
  agentId: string;
  departmentId: string;
  userMessage: string;
  agentResponse: string;
  model: string;
  latencyMs: number;
  contextSources: string;
  contextTokens: number;
  confidence: number;
}): Promise<void> {
  const { conversationId, userId, agentId, departmentId, userMessage, agentResponse, model, latencyMs, contextSources, contextTokens, confidence } = params;

  // Ensure conversation exists
  await db.conversation.upsert({
    where: { id: conversationId },
    update: { updatedAt: new Date(), status: 'active' },
    create: {
      id: conversationId,
      userId,
      agentId,
      departmentId,
      companyId: 'default-company',
      title: userMessage.substring(0, 100),
      status: 'active',
    },
  }).catch(() => { /* best-effort */ });

  // Store user message
  await db.conversationMessage.create({
    data: { conversationId, role: 'user', content: userMessage },
  }).catch(() => { /* best-effort */ });

  // Store agent response
  await db.conversationMessage.create({
    data: { conversationId, role: 'agent', content: agentResponse },
  }).catch(() => { /* best-effort */ });
}

// ─── Agent Delegation Detection ──────────────────────────────────

export interface DelegationDecision {
  shouldDelegate: boolean;
  targetDepartment?: string;
  targetRole?: string;
  reason: string;
}

/**
 * Determines if a task should be delegated to another agent.
 * Simple heuristics: if the task mentions another department or
 * requires capabilities outside the agent's role, suggest delegation.
 */
export function detectDelegationNeed(
  task: string,
  agentDepartmentName: string,
  agentRole: string,
  allDepartments: string[],
): DelegationDecision {
  const lower = task.toLowerCase();

  // Check if task mentions another department
  for (const dept of allDepartments) {
    if (dept.toLowerCase() !== agentDepartmentName.toLowerCase() &&
        lower.includes(dept.toLowerCase())) {
      return {
        shouldDelegate: true,
        targetDepartment: dept,
        reason: `Task explicitly mentions ${dept} department`,
      };
    }
  }

  // Check if task requires capabilities outside agent's role
  const roleCapabilities: Record<string, string[]> = {
    specialist: ['analyze', 'execute', 'process', 'handle', 'manage'],
    manager: ['coordinate', 'delegate', 'review', 'approve', 'oversee'],
    qa: ['test', 'verify', 'validate', 'check', 'audit'],
    report: ['generate', 'create report', 'summarize', 'compile'],
  };

  const agentCapabilities = roleCapabilities[agentRole] || roleCapabilities['specialist'] || [];
  const needsCapability = ['code', 'legal', 'financial', 'security audit', 'compliance check', 'payment', 'deploy', 'database'];
  for (const cap of needsCapability) {
    if (lower.includes(cap) && !agentCapabilities.some(ac => lower.includes(ac))) {
      return {
        shouldDelegate: true,
        targetRole: cap.includes('code') ? 'specialist' : cap.includes('security') ? 'specialist' : 'specialist',
        reason: `Task requires '${cap}' capability which may be outside this agent's specialization`,
      };
    }
  }

  return { shouldDelegate: false, reason: 'Task is within agent capabilities' };
}

// ─── RAG Context Injection ──────────────────────────────────────

/**
 * Injects RAG results into the system prompt as a knowledge section.
 */
export function buildRAGContextSection(ragContext: RAGContext): string {
  if (ragContext.results.length === 0) return '';

  const parts: string[] = [];
  parts.push('# RETRIEVED KNOWLEDGE (RAG)');
  parts.push('');
  parts.push(`Retrieved ${ragContext.totalFound} relevant documents for this task:`);
  parts.push('');

  for (let i = 0; i < ragContext.results.length; i++) {
    const r = ragContext.results[i];
    parts.push(`### Source ${i + 1} (${r.source}, relevance: ${(r.score * 100).toFixed(0)}%)`);
    parts.push(r.content);
    parts.push('');
  }

  parts.push('Use the above retrieved knowledge to inform your response. Cite sources when applicable.');

  return parts.join('\n');
}

// ─── Conversation History Injection ──────────────────────────────

/**
 * Formats conversation history for inclusion in the messages array.
 */
export function buildConversationMessages(
  history: ConversationMessage[],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return history.map(m => ({
    role: m.role === 'agent' ? 'assistant' : m.role,
    content: m.content,
  }));
}
