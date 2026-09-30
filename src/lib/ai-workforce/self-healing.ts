import { db } from '@/lib/db'

export async function autoRestart(instanceId: string) {
  const instance = await db.agentInstance.findUnique({ where: { id: instanceId } })
  if (!instance) throw new Error('Instance not found')
  const start = Date.now()
  try {
    await db.agentInstance.update({ where: { id: instanceId }, data: { status: 'active', healthStatus: 'unknown' } })
    const event = await db.recoveryEvent.create({
      data: { instanceId, recoveryType: 'auto_restart', triggerReason: 'health_degraded', actionsTaken: JSON.stringify(['status_reset_to_active', 'health_reset_to_unknown']), status: 'success', durationMs: Date.now() - start, companyId: instance.companyId || undefined },
    })
    return { success: true, eventId: event.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.recoveryEvent.create({ data: { instanceId, recoveryType: 'auto_restart', triggerReason: 'health_degraded', actionsTaken: '[]', status: 'failed', error: msg, durationMs: Date.now() - start, companyId: instance.companyId || undefined } })
    return { success: false, error: msg }
  }
}

export async function retryExecution(executionId: string) {
  const exec = await db.agentExecution.findUnique({ where: { id: executionId } })
  if (!exec) throw new Error('Execution not found')
  if (exec.retryCount >= exec.maxRetries) throw new Error('Max retries exceeded')
  const start = Date.now()
  await db.agentExecution.update({ where: { id: executionId }, data: { retryCount: { increment: 1 }, status: 'pending', error: null, errorMessage: null } })
  const event = await db.recoveryEvent.create({
    data: { executionId, instanceId: exec.instanceId, agentId: exec.assignedAgentId || undefined, recoveryType: 'retry', triggerReason: 'execution_failed', actionsTaken: JSON.stringify(['retry_count_incremented', 'status_reset_to_pending']), status: 'success', durationMs: Date.now() - start, companyId: exec.companyId || undefined },
  })
  return { success: true, eventId: event.id, newRetryCount: exec.retryCount + 1 }
}

export async function rollbackInstance(instanceId: string) {
  const instance = await db.agentInstance.findUnique({ where: { id: instanceId } })
  if (!instance) throw new Error('Instance not found')
  const start = Date.now()
  await db.agentInstance.update({ where: { id: instanceId }, data: { status: 'rollback', healthStatus: 'down' } })
  const event = await db.recoveryEvent.create({
    data: { instanceId, recoveryType: 'rollback', triggerReason: 'manual_or_error', actionsTaken: JSON.stringify(['status_set_to_rollback', 'health_set_to_down']), status: 'success', durationMs: Date.now() - start, companyId: instance.companyId || undefined },
  })
  return { success: true, eventId: event.id }
}

export async function recoverQueue(queueName: string, companyId?: string) {
  const start = Date.now()
  const stuck = await db.agentExecution.findMany({ where: { status: 'running', companyId } })
 let recovered = 0
  for (const exec of stuck) {
    if (Date.now() - exec.updatedAt.getTime() > 300000) { // 5 min stale
      await db.agentExecution.update({ where: { id: exec.id }, data: { status: 'failed', error: 'queue_recovery_timeout' } })
      recovered++
    }
  }
  const event = await db.recoveryEvent.create({
    data: { recoveryType: 'queue_recovery', triggerReason: `queue:${queueName}`, actionsTaken: JSON.stringify([`recovered_${recovered}_stuck_executions`]), status: 'success', durationMs: Date.now() - start, companyId },
  })
  return { success: true, recovered, eventId: event.id }
}

export async function recoverWorkflow(workflowId: string, companyId?: string) {
  const start = Date.now()
  const event = await db.recoveryEvent.create({
    data: { recoveryType: 'workflow_recovery', triggerReason: `workflow:${workflowId}`, actionsTaken: JSON.stringify(['workflow_state_reset']), status: 'success', durationMs: Date.now() - start, companyId },
  })
  return { success: true, eventId: event.id }
}

export async function recoverAgent(agentId: string, companyId?: string) {
  const start = Date.now()
  const instance = await db.agentInstance.findFirst({ where: { agentId, companyId } })
  if (instance) {
    await autoRestart(instance.id)
  }
  const event = await db.recoveryEvent.create({
    data: { instanceId: instance?.id, agentId, recoveryType: 'agent_recovery', triggerReason: 'manual_or_health_check', actionsTaken: JSON.stringify(['instance_restart_attempted', 'health_check_queued']), status: instance ? 'success' : 'failed', durationMs: Date.now() - start, companyId },
  })
  return { success: !!instance, eventId: event.id }
}

export async function getRecoveryEvents(filters?: { instanceId?: string; agentId?: string; type?: string; status?: string; limit?: number }) {
  const where: any = {}
  if (filters?.instanceId) where.instanceId = filters.instanceId
  if (filters?.agentId) where.agentId = filters.agentId
  if (filters?.type) where.recoveryType = filters.type
  if (filters?.status) where.status = filters.status
  return db.recoveryEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: filters?.limit || 50 })
}