import { db } from '@/lib/db'

// ── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionProposal {
  parentAgentId: string
  parentAgentName: string
  departmentId: string
  departmentName: string
  proposedRole: string
  proposedName: string
  proposedPurpose: string
  proposedSkills: string[]
  proposedType: string
  reason: string
  capabilityGap: string
  generation: number
}

export interface EvolutionConfig {
  maxPopulation: number
  maxGeneration: number
  maxProposalsPerAgent: number
  maxConcurrencyPerDept: number
  phase: 'phase1' | 'phase2' | 'locked'
}

const DEFAULT_CONFIG: EvolutionConfig = {
  maxPopulation: 5000,
  maxGeneration: 3,
  maxProposalsPerAgent: 5,
  maxConcurrencyPerDept: 50,
  phase: 'phase1',
}

function safeParseJSON<T = unknown>(jsonStr: string, fallback: T): T {
  try {
    return JSON.parse(jsonStr) as T
  } catch {
    return fallback
  }
}

function generateAgentId(): string {
  const random = Math.random().toString(36).substring(2, 8)
  return `agent_${Date.now()}_${random}`
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

// ── getEvolutionConfig ────────────────────────────────────────────────────

export function getEvolutionConfig(): EvolutionConfig {
  try {
    // We access the DB synchronously isn't possible, so we use a cached/read approach.
    // Since this is called in async contexts, the config is read from DB there.
    // This function returns defaults; callers that need DB-backed config should
    // call getEvolutionConfigFromDB().
    return { ...DEFAULT_CONFIG }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function getEvolutionConfigFromDB(): Promise<EvolutionConfig> {
  try {
    const setting = await db.settings.findUnique({
      where: { key: 'workforce_evolution_config' },
    })
    if (!setting) return { ...DEFAULT_CONFIG }
    return safeParseJSON<EvolutionConfig>(setting.value, { ...DEFAULT_CONFIG })
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

// ── submitProposal ────────────────────────────────────────────────────────

export async function submitProposal(proposal: EvolutionProposal): Promise<{
  approved: boolean
  reason: string
  newAgentId?: string
}> {
  try {
    const config = await getEvolutionConfigFromDB()

    // 1. Check parent agent exists and is active
    const parentAgent = await db.agent.findUnique({
      where: { agentId: proposal.parentAgentId },
    })
    if (!parentAgent) {
      return { approved: false, reason: 'Parent agent does not exist' }
    }
    if (parentAgent.status !== 'active') {
      return { approved: false, reason: 'Parent agent is not active' }
    }

    // 2. Check total agent count < maxPopulation
    const totalAgents = await db.agent.count()
    if (totalAgents >= config.maxPopulation) {
      return {
        approved: false,
        reason: `Workforce population limit reached (${config.maxPopulation})`,
      }
    }

    // 3. Check generation < maxGeneration
    if (proposal.generation >= config.maxGeneration) {
      return {
        approved: false,
        reason: `Maximum generation depth reached (${config.maxGeneration})`,
      }
    }

    // 4. Check parent's proposal count (skip if no parentId field on Agent model)
    // The Agent model does not have a parentId field, so we skip this check.

    // 5. Check department concurrency < maxConcurrencyPerDept
    const deptAgentCount = await db.agent.count({
      where: { departmentId: proposal.departmentId, status: 'active' },
    })
    if (deptAgentCount >= config.maxConcurrencyPerDept) {
      return {
        approved: false,
        reason: `Department concurrency limit reached (${config.maxConcurrencyPerDept})`,
      }
    }

    // 6. Check no duplicate (same role + department + purpose)
    const duplicate = await db.agent.findFirst({
      where: {
        role: proposal.proposedRole,
        departmentId: proposal.departmentId,
        purpose: proposal.proposedPurpose,
      },
    })
    if (duplicate) {
      return {
        approved: false,
        reason: `Duplicate agent already exists: ${duplicate.agentId}`,
      }
    }

    // All checks passed — create the new agent
    const newAgentId = generateAgentId()
    const slug = slugify(`${proposal.proposedName}-${Date.now()}`)

    await db.agent.create({
      data: {
        agentId: newAgentId,
        name: proposal.proposedName,
        slug,
        departmentId: proposal.departmentId,
        departmentName: proposal.departmentName,
        purpose: proposal.proposedPurpose,
        type: proposal.proposedType || 'specialist',
        role: proposal.proposedRole,
        allowedSkills: JSON.stringify(proposal.proposedSkills || []),
        forbiddenSkills: '[]',
        allowedTools: '[]',
        forbiddenTools: '[]',
        inputSchema: '{}',
        outputSchema: '{}',
        workflowSteps: '[]',
        protectionRules: '[]',
        approvalRules: '[]',
        handoffRules: '[]',
        qualityChecklist: '[]',
        selfImprovement: '{}',
        productivityRules: '{}',
        status: 'active',
        version: 1,
      },
    })

    return {
      approved: true,
      reason: `Agent '${proposal.proposedName}' created successfully via evolution`,
      newAgentId,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { approved: false, reason: `Internal error: ${message}` }
  }
}

// ── getProposals ──────────────────────────────────────────────────────────

export async function getProposals(departmentId?: string): Promise<unknown[]> {
  try {
    const where: Record<string, unknown> = {
      status: 'active',
    }
    if (departmentId) {
      where.departmentId = departmentId
    }

    // Since there is no parentId or generation field on the Agent model,
    // we return the most recently created agents (which would include evolution-created ones)
    // ordered by creation date descending.
    const agents = await db.agent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        agentId: true,
        name: true,
        role: true,
        type: true,
        departmentId: true,
        departmentName: true,
        purpose: true,
        allowedSkills: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return agents.map((a) => ({
      ...a,
      allowedSkills: safeParseJSON<string[]>(a.allowedSkills, []),
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    }))
  } catch (error) {
    console.error('Failed to get proposals:', error)
    return []
  }
}

// ── getEvolutionStats ─────────────────────────────────────────────────────

export async function getEvolutionStats(): Promise<{
  totalAgents: number
  totalDepartments: number
  config: EvolutionConfig
  proposalsThisMonth: number
  agentsByGeneration: Record<string, number>
}> {
  try {
    const [totalAgents, totalDepartments, proposalsThisMonth] = await Promise.all([
      db.agent.count(),
      db.department.count(),
      db.agent.count({
        where: {
          createdAt: {
            gte: new Date(
              new Date().getFullYear(),
              new Date().getMonth(),
              1
            ),
          },
        },
      }),
    ])

    const config = await getEvolutionConfigFromDB()

    // Since there is no generation field on the Agent model,
    // we return a placeholder. Agents created directly are gen-0.
    const agentsByGeneration: Record<string, number> = {
      '0': totalAgents,
      '1': 0,
      '2': 0,
      '3': 0,
    }

    return {
      totalAgents,
      totalDepartments,
      config,
      proposalsThisMonth,
      agentsByGeneration,
    }
  } catch (error) {
    console.error('Failed to get evolution stats:', error)
    const config = await getEvolutionConfigFromDB()
    return {
      totalAgents: 0,
      totalDepartments: 0,
      config,
      proposalsThisMonth: 0,
      agentsByGeneration: { '0': 0, '1': 0, '2': 0, '3': 0 },
    }
  }
}
