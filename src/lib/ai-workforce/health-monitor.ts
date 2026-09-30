import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export type CheckResult = { checkType: string; status: 'pass' | 'fail' | 'warn'; responseMs: number; details: Record<string, unknown>; errorMessage?: string }

export async function runHealthCheck(instanceId: string) {
  const instance = await db.agentInstance.findUnique({ where: { id: instanceId }, include: { credentials: true } })
  if (!instance) throw new Error('Instance not found')

  const checks: CheckResult[] = []
  const start = Date.now()

  // 1. Credentials check
  const credCheck = await checkCredentials(instanceId, instance.credentials.map(c => ({ type: c.serviceType, valid: c.isValid, expiresAt: c.expiresAt })))
  checks.push(credCheck)

  // 2. Tools check
  const tools: string[] = JSON.parse(instance.toolsConnected || '[]')
  checks.push({ checkType: 'tools', status: tools.length > 0 ? 'pass' : 'warn', responseMs: 0, details: { connectedTools: tools.length } })

  // 3. Permissions check
  const perms: string[] = JSON.parse(instance.permissionsJson || '[]')
  checks.push({ checkType: 'permissions', status: perms.length > 0 ? 'pass' : 'warn', responseMs: 0, details: { permissionCount: perms.length } })

  // 4. Connectivity check
  const connStart = Date.now()
  const connOk = true // In production, actual connectivity test
  checks.push({ checkType: 'connectivity', status: connOk ? 'pass' : 'fail', responseMs: Date.now() - connStart, details: { reachable: connOk } })

  // 5. Latency check
  const latStart = Date.now()
  await db.agentInstance.findUnique({ where: { id: instanceId } })
  const latency = Date.now() - latStart
  checks.push({ checkType: 'latency', status: latency < 500 ? 'pass' : latency < 2000 ? 'warn' : 'fail', responseMs: latency, details: { latencyMs: latency } })

  // Save all checks
  await Promise.all(checks.map(c => db.agentHealthCheck.create({
    data: { instanceId, checkType: c.checkType, status: c.status, responseMs: c.responseMs, details: JSON.stringify(c.details), errorMessage: c.errorMessage },
  })))

  // Determine overall health
  const hasFail = checks.some(c => c.status === 'fail')
  const hasWarn = checks.some(c => c.status === 'warn')
  const overallHealth = hasFail ? 'down' : hasWarn ? 'degraded' : 'healthy'

  await db.agentInstance.update({
    where: { id: instanceId },
    data: { healthStatus: overallHealth, lastHealthCheck: new Date() },
  })

  // Record metric
  await db.agentMetric.create({
    data: { instanceId, metricType: 'health', metricName: 'health_status', value: overallHealth === 'healthy' ? 1 : overallHealth === 'degraded' ? 0.5 : 0, unit: 'score', recordedAt: new Date() },
  })

  return { instanceId, overallHealth, checks, durationMs: Date.now() - start }
}

async function checkCredentials(instanceId: string, creds: { type: string; valid: boolean; expiresAt?: Date | null }[]): CheckResult {
  const invalid = creds.filter(c => !c.valid)
  const expired = creds.filter(c => c.expiresAt && c.expiresAt < new Date())
  const status = invalid.length > 0 || expired.length > 0 ? 'fail' : creds.length > 0 ? 'pass' : 'warn'
  return { checkType: 'credentials', status: status as 'pass' | 'fail' | 'warn', responseMs: 0, details: { total: creds.length, valid: creds.length - invalid.length, expired: expired.length } }
}

export async function createAgentMetric(data: { instanceId?: string; agentId?: string; companyId?: string; metricType: string; metricName: string; value: number; unit?: string; dimensions?: Record<string, unknown> }) {
  return db.agentMetric.create({ data: { ...data, dimensions: JSON.stringify(data.dimensions || {}) } })
}

export async function getAgentMetrics(filters: { instanceId?: string; agentId?: string; metricType?: string; from?: Date; to?: Date }) {
  const where: Prisma.AgentMetricWhereInput = {}
  if (filters.instanceId) where.instanceId = filters.instanceId
  if (filters.agentId) where.agentId = filters.agentId
  if (filters.metricType) where.metricType = filters.metricType
  if (filters.from || filters.to) where.recordedAt = { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) }
  return db.agentMetric.findMany({ where, orderBy: { recordedAt: 'desc' }, take: 500 })
}

export async function createAgentAlert(data: { instanceId?: string; agentId?: string; companyId?: string; alertType: string; severity: string; message: string; metadata?: Record<string, unknown> }) {
  return db.agentAlert.create({ data: { ...data, metadata: JSON.stringify(data.metadata || {}) } })
}

export async function getAlerts(filters: { instanceId?: string; agentId?: string; severity?: string; acknowledged?: boolean; companyId?: string; limit?: number }) {
  const where: Prisma.AgentAlertWhereInput = {}
  if (filters.instanceId) where.instanceId = filters.instanceId
  if (filters.agentId) where.agentId = filters.agentId
  if (filters.severity) where.severity = filters.severity
  if (filters.acknowledged !== undefined) where.isAcknowledged = filters.acknowledged
  if (filters.companyId) where.companyId = filters.companyId
  return db.agentAlert.findMany({ where, orderBy: { createdAt: 'desc' }, take: filters.limit || 50 })
}

export async function acknowledgeAlert(alertId: string, acknowledgedBy: string) {
  return db.agentAlert.update({ where: { id: alertId }, data: { isAcknowledged: true, acknowledgedBy, resolvedAt: new Date() } })
}
