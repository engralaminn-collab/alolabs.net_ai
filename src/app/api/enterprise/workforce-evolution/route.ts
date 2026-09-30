import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/api-auth'
import {
  submitProposal,
  getProposals,
  getEvolutionStats,
} from '@/lib/workforce-evolution'

const proposalSchema = z.object({
  parentAgentId: z.string().min(1),
  parentAgentName: z.string().min(1),
  departmentId: z.string().min(1),
  departmentName: z.string().min(1),
  proposedRole: z.string().min(1),
  proposedName: z.string().min(1),
  proposedPurpose: z.string().min(1),
  proposedSkills: z.array(z.string()).optional(),
  proposedType: z.string().optional(),
  reason: z.string().min(1),
  capabilityGap: z.string().min(1),
  generation: z.number().int().min(0).default(0),
})

export async function GET(request: NextRequest) {
  try {
    await requireAuth()

    const { searchParams } = new URL(request.url)
    const departmentId = searchParams.get('departmentId') || undefined
    const stats = searchParams.get('stats')

    if (stats) {
      const evolutionStats = await getEvolutionStats()
      return NextResponse.json(evolutionStats)
    }

    const proposals = await getProposals(departmentId)
    return NextResponse.json({ proposals })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Workforce evolution GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth()

    const body = await request.json()
    const parsed = proposalSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const data = parsed.data
    const result = await submitProposal({
      parentAgentId: data.parentAgentId,
      parentAgentName: data.parentAgentName,
      departmentId: data.departmentId,
      departmentName: data.departmentName,
      proposedRole: data.proposedRole,
      proposedName: data.proposedName,
      proposedPurpose: data.proposedPurpose,
      proposedSkills: data.proposedSkills || [],
      proposedType: data.proposedType || 'specialist',
      reason: data.reason,
      capabilityGap: data.capabilityGap,
      generation: data.generation,
    })

    return NextResponse.json({
      approved: result.approved,
      reason: result.reason,
      newAgentId: result.newAgentId ?? null,
      userId: user.userId,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Workforce evolution POST error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
