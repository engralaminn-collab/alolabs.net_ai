import { db } from '@/lib/db'

const INJECTION_PATTERNS = [/ignore previous instructions/i, /ignore all above/i, /you are now/i, /forget your rules/i, /system prompt/i, /pretend you are/i, /act as if/i, /jailbreak/i, /bypass safety/i, /override instructions/i]
const LEAKAGE_PATTERNS = [/\b\d{16}\b/, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, /\b\d{3}-\d{2}-\d{4}\b/, /sk-[a-zA-Z0-9]{20,}/, /api[_-]?key/i]
const FORBIDDEN_ACTIONS = ['grant permissions', 'disable security', 'delete logs', 'change billing', 'escalate privileges', 'modify roles', 'drop database', 'delete all']

export async function validateInput(input: Record<string, unknown>): Promise<{ valid: boolean; flags: string[]; riskScore: number; sanitized: Record<string, unknown> }> {
  const flags: string[] = []
  let riskScore = 0
  const inputStr = JSON.stringify(input)

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(inputStr)) { flags.push('prompt_injection'); riskScore += 0.25; break }
  }

  for (const pattern of LEAKAGE_PATTERNS) {
    if (pattern.test(inputStr)) { flags.push('potential_data_in_input'); riskScore += 0.1 }
  }

  const lowerInput = inputStr.toLowerCase()
  for (const action of FORBIDDEN_ACTIONS) {
    if (lowerInput.includes(action)) { flags.push('forbidden_action_requested'); riskScore += 0.4 }
  }

  if (inputStr.length > 50000) { flags.push('oversized_input'); riskScore += 0.1 }

  const valid = riskScore < 0.7
  await logSecurityEvent('prompt_injection_check', flags.length > 0 ? (riskScore >= 0.7 ? 'medium' : 'low') : 'low', inputStr, undefined, riskScore, valid ? 'passed' : flags.length > 0 ? 'flagged' : 'passed', flags)
  return { valid, flags, riskScore: Math.min(riskScore, 1), sanitized: input }
}

export async function validateOutput(output: string, agentId?: string): Promise<{ valid: boolean; flags: string[]; riskScore: number }> {
  const flags: string[] = []
  let riskScore = 0

  for (const pattern of LEAKAGE_PATTERNS) {
    if (pattern.test(output)) { flags.push('data_leakage_risk'); riskScore += 0.3 }
  }

  if (output.includes('password') || output.includes('secret_key') || output.includes('private_key')) {
    flags.push('sensitive_data_in_output'); riskScore += 0.5
  }

  const valid = riskScore < 0.5
  await logSecurityEvent('output_validation', flags.length > 0 ? 'high' : 'low', undefined, output, riskScore, valid ? 'passed' : 'blocked', flags, agentId)
  return { valid, flags, riskScore: Math.min(riskScore, 1) }
}

export async function calculateRiskScore(input: string, output?: string): Promise<number> {
  let score = 0
  for (const p of INJECTION_PATTERNS) { if (p.test(input)) score += 0.3 }
  if (output) {
    for (const p of LEAKAGE_PATTERNS) { if (p.test(output)) score += 0.2 }
  }
  for (const a of FORBIDDEN_ACTIONS) { if (input.toLowerCase().includes(a)) score += 0.4 }
  return Math.min(score, 1)
}

export async function checkToolAbuse(toolName: string, config: Record<string, unknown>, agentId?: string): Promise<{ allowed: boolean; reason?: string }> {
  const dangerousTools = ['shell_execute', 'database_drop', 'user_delete', 'role_modify', 'permission_grant', 'log_delete', 'billing_modify']
  if (dangerousTools.includes(toolName)) {
    await logSecurityEvent('tool_abuse', 'high', JSON.stringify({ toolName, config }), undefined, 0.9, 'blocked', ['dangerous_tool'], agentId)
    return { allowed: false, reason: `Tool '${toolName}' requires explicit human approval` }
  }
  return { allowed: true }
}

export async function getSecurityRules(companyId?: string) {
  return db.securityRule.findMany({ where: { isActive: true, ...(companyId ? { companyId } : {}) } })
}

export async function createSecurityRule(data: { name: string; type: string; pattern?: string; config?: Record<string, unknown>; action?: string; severity?: string; companyId?: string }) {
  return db.securityRule.create({ data: { ...data, config: JSON.stringify(data.config || {}), action: data.action || 'block', severity: data.severity || 'high' } })
}

export async function getSecurityEvents(filters?: { type?: string; severity?: string; agentId?: string; companyId?: string; limit?: number }) {
  const where: any = {}
  if (filters?.type) where.type = filters.type
  if (filters?.severity) where.severity = filters.severity
  if (filters?.agentId) where.agentId = filters.agentId
  if (filters?.companyId) where.companyId = filters.companyId
  return db.aiSecurityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: filters?.limit || 100 })
}

export async function getSecurityStats(companyId?: string) {
  const where: any = companyId ? { companyId } : {}
  const [total, blocked, flagged, passed] = await Promise.all([
    db.aiSecurityEvent.count({ where }),
    db.aiSecurityEvent.count({ where: { ...where, action: 'blocked' } }),
    db.aiSecurityEvent.count({ where: { ...where, action: 'flagged' } }),
    db.aiSecurityEvent.count({ where: { ...where, action: 'passed' } }),
  ])
  return { total, blocked, flagged, passed, blockRate: total > 0 ? (blocked / total * 100).toFixed(1) : '0' }
}

async function logSecurityEvent(type: string, severity: string, input?: string, output?: string, riskScore: number, action: string, flags: string[], agentId?: string) {
  await db.aiSecurityEvent.create({ data: { type, severity, input: input?.slice(0, 10000), output: output?.slice(0, 10000), riskScore, action, details: JSON.stringify({ flags, timestamp: new Date().toISOString() }), agentId } })
}
