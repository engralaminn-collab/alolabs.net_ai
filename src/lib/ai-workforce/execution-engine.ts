import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

const STEPS = ['request','validation','planning','tool_selection','execution','review','logging','delivery'] as const
type PipelineStep = typeof STEPS[number]
const RISK_THRESHOLD = 0.7

export async function executeAgentPipeline(
  instanceId: string,
  input: Record<string, unknown>,
  context?: { companyId?: string; userId?: string; priority?: string }
) {
  const instance = await db.agentInstance.findUnique({ where: { id: instanceId } })
  if (!instance) throw new Error('AgentInstance not found')
  if (instance.status !== 'active') throw new Error(`Agent instance is ${instance.status}`)

  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const execution = await db.agentExecution.create({
    data: {
      instanceId,
      requestId,
      companyId: context?.companyId,
      userId: context?.userId,
      priority: context?.priority || 'normal',
      input: JSON.stringify(input),
      step: 'request',
      stepNumber: 1,
      status: 'running',
      startedAt: new Date(),
    },
  })

  try {
    await addMessage(execution.id, 'system', `Pipeline started for agent ${instance.agentId}. Request: ${requestId}`)

    // Step 1: Validation
    await updateStep(execution.id, 'validation', 2)
    const validation = await validateRequest(execution, input)
    if (!validation.valid) {
      await db.agentExecution.update({ where: { id: execution.id }, data: { status: 'blocked', error: 'validation_failed', errorMessage: validation.reason } })
      return { success: false, error: validation.reason, executionId: execution.id }
    }
    await db.agentExecution.update({ where: { id: execution.id }, data: { validatedInput: JSON.stringify(validation.sanitized), securityFlags: JSON.stringify(validation.flags) } })

    // Check risk - human oversight
    if (validation.riskScore >= RISK_THRESHOLD) {
      const approval = await db.oversightApprovalRequest.create({
        data: {
          executionId: execution.id,
          title: `High-risk execution: ${instance.agentId}`,
          description: `Risk score: ${validation.riskScore}`,
          requestType: 'agent_action',
          riskLevel: validation.riskScore >= 0.9 ? 'high' : 'medium',
          requestJson: JSON.stringify({ input, riskScore: validation.riskScore }),
          requestedBy: context?.userId,
          companyId: context?.companyId,
        },
      })
      await db.agentExecution.update({ where: { id: execution.id }, data: { status: 'approval_required', approvalId: approval.id, riskScore: validation.riskScore } })
      return { success: false, needsApproval: true, approvalId: approval.id, executionId: execution.id }
    }

    // Step 2: Planning
    await updateStep(execution.id, 'planning', 3)
    const plan = await planExecution(execution, validation.sanitized, instance)
    await db.agentExecution.update({ where: { id: execution.id }, data: { executionPlan: JSON.stringify(plan) } })

    // Step 3: Tool Selection
    await updateStep(execution.id, 'tool_selection', 4)
    const tools = await selectTools(execution, plan, instance)
    await db.agentExecution.update({ where: { id: execution.id }, data: { selectedTools: JSON.stringify(tools) } })

    // Step 4: Execution
    await updateStep(execution.id, 'execution', 5)
    const output = await executeStep(execution, plan, tools, instance)
    await db.agentExecution.update({ where: { id: execution.id }, data: { executionOutput: JSON.stringify(output) } })

    // Step 5: Review
    await updateStep(execution.id, 'review', 6)
    const review = await reviewOutput(execution, output, instance)
    await db.agentExecution.update({ where: { id: execution.id }, data: { reviewResult: JSON.stringify(review) } })

    // Step 6: Logging
    await updateStep(execution.id, 'logging', 7)
    const logIds = await logExecution(execution)
    await db.agentExecution.update({ where: { id: execution.id }, data: { logIds: JSON.stringify(logIds) } })

    // Step 7: Delivery
    await updateStep(execution.id, 'delivery', 8)
    const delivery = await deliverResult(execution, output, review, context)
    await db.agentExecution.update({ where: { id: execution.id }, data: { deliveryResult: JSON.stringify(delivery), status: 'completed', completedAt: new Date(), durationMs: Date.now() - execution.createdAt.getTime() } })

    return { success: true, output, review, delivery, executionId: execution.id }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    const shouldRetry = (await db.agentExecution.findUnique({ where: { id: execution.id } }))?.retryCount ?? 0 < 3
    if (shouldRetry) {
      await db.agentExecution.update({ where: { id: execution.id }, data: { retryCount: { increment: 1 }, status: 'pending' } })
    } else {
      await db.agentExecution.update({ where: { id: execution.id }, data: { status: 'failed', error: 'execution_error', errorMessage: errorMsg, completedAt: new Date() } })
    }
    return { success: false, error: errorMsg, executionId: execution.id }
  }
}

async function updateStep(executionId: string, step: PipelineStep, stepNumber: number) {
  await db.agentExecution.update({ where: { id: executionId }, data: { step, stepNumber } })
  await addMessage(executionId, 'system', `Step ${stepNumber}/8: ${step}`)
}

async function addMessage(executionId: string, role: string, content: string, toolCalls?: unknown[]) {
  return db.agentMessage.create({
    data: { executionId, role, content, toolCalls: JSON.stringify(toolCalls || []) },
  })
}

async function validateRequest(execution: { id: string }, input: Record<string, unknown>) {
  // Input validation
  const flags: string[] = []
  let riskScore = 0
  if (!input || typeof input !== 'object') return { valid: false, reason: 'Invalid input format', sanitized: input, flags, riskScore: 1 }

  // Check for injection patterns
  const inputStr = JSON.stringify(input).toLowerCase()
  const injectionPatterns = ['ignore previous instructions', 'system prompt', 'you are now', 'forget your rules']
  for (const p of injectionPatterns) {
    if (inputStr.includes(p)) { flags.push('prompt_injection'); riskScore += 0.3; break }
  }

  // Check input schema size
  if (inputStr.length > 100000) { flags.push('oversized_input'); riskScore += 0.2 }

  return { valid: flags.filter(f => f === 'prompt_injection').length === 0, reason: flags.length ? `Security flags: ${flags.join(', ')}` : undefined, sanitized: input, flags, riskScore: Math.min(riskScore, 1) }
}

async function planExecution(execution: { id: string }, input: Record<string, unknown>, instance: { agentId?: string }) {
  await addMessage(execution.id, 'assistant', `Planning execution for request. Input keys: ${Object.keys(input).join(', ')}`)
  return { steps: ['analyze_input', 'process', 'generate_output'], strategy: 'sequential', estimatedSteps: 3 }
}

async function selectTools(execution: { id: string }, plan: Record<string, unknown>, instance: { toolsConnected?: string }) {
  const connected: string[] = JSON.parse(instance.toolsConnected || '[]')
  await addMessage(execution.id, 'assistant', `Selected tools: ${connected.join(', ') || 'none (using built-in capabilities)'}`)
  return connected.map(t => ({ name: t, status: 'ready' }))
}

async function executeStep(execution: { id: string }, plan: Record<string, unknown>, tools: { name: string }[], instance: { config?: string; agentId?: string }) {
  const config = JSON.parse(instance.config || '{}')
  await addMessage(execution.id, 'assistant', `Executing with ${tools.length} tools. Strategy: ${plan.strategy}`)
  const startTime = Date.now()
  // Simulate processing - in production, this would call actual AI/LLM
  const result = { processed: true, output: `Execution result for ${instance.agentId}`, timestamp: new Date().toISOString(), duration: Date.now() - startTime }
  await addMessage(execution.id, 'assistant', JSON.stringify(result))
  return result
}

async function reviewOutput(execution: { id: string }, output: Record<string, unknown>, instance: { agentId?: string }) {
  await addMessage(execution.id, 'reviewer', `Reviewing output for ${instance.agentId}`)
  return { passed: true, qualityScore: 0.85, issues: [], reviewedAt: new Date().toISOString() }
}

async function logExecution(execution: { id: string; instanceId: string; companyId?: string | null; userId?: string | null }) {
  const logIds: string[] = []
  const log = await db.auditLog.create({
    data: { action: 'agent_execution', resource: 'AgentExecution', details: JSON.stringify({ executionId: execution.id, instanceId: execution.instanceId }), userId: execution.userId },
  })
  logIds.push(log.id)
  return logIds
}

async function deliverResult(execution: { id: string }, output: Record<string, unknown>, review: Record<string, unknown>, context?: { companyId?: string }) {
  await addMessage(execution.id, 'system', 'Delivery complete.')
  return { delivered: true, deliveredAt: new Date().toISOString(), channels: ['api_response'] }
}

// Query functions
export async function getExecutions(filters?: { instanceId?: string; companyId?: string; status?: string; limit?: number; offset?: number }) {
  const where: Prisma.AgentExecutionWhereInput = {}
  if (filters?.instanceId) where.instanceId = filters.instanceId
  if (filters?.companyId) where.companyId = filters.companyId
  if (filters?.status) where.status = filters.status
  return db.agentExecution.findMany({ where, orderBy: { createdAt: 'desc' }, take: filters?.limit || 50, skip: filters?.offset || 0, include: { messages: { orderBy: { createdAt: 'asc' } } } })
}

export async function getExecution(id: string) {
  return db.agentExecution.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } }, instance: true } })
}

export async function approveExecution(executionId: string, approvedBy: string) {
  const exec = await db.agentExecution.findUnique({ where: { id: executionId } })
  if (!exec) throw new Error('Execution not found')
  if (exec.approvalId) {
    await db.oversightApprovalRequest.update({ where: { id: exec.approvalId }, data: { status: 'approved', reviewedBy, reviewedAt: new Date() } })
  }
  await db.agentExecution.update({ where: { id: executionId }, data: { status: 'pending', riskScore: 0 } })
  const input = JSON.parse(exec.input || '{}')
  return executeAgentPipeline(exec.instanceId, input, { companyId: exec.companyId || undefined, userId: exec.userId || undefined })
}

export async function rejectExecution(executionId: string, rejectedBy: string, note: string) {
  const exec = await db.agentExecution.findUnique({ where: { id: executionId } })
  if (!exec) throw new Error('Execution not found')
  if (exec.approvalId) {
    await db.oversightApprovalRequest.update({ where: { id: exec.approvalId }, data: { status: 'rejected', reviewedBy: rejectedBy, reviewNote: note, reviewedAt: new Date() } })
  }
  return db.agentExecution.update({ where: { id: executionId }, data: { status: 'failed', error: 'rejected', errorMessage: note, completedAt: new Date() } })
}
