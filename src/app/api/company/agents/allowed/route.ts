import { db } from '@/lib/db'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const { searchParams } = new URL(request.url)
    const companyId = searchParams.get('companyId')

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId query parameter is required' },
        { status: 400 }
      )
    }

    // Validate company exists
    const company = await db.company.findUnique({
      where: { id: companyId },
    })

    if (!company) {
      return NextResponse.json(
        { error: 'Company not found' },
        { status: 404 }
      )
    }

    // Query CompanyPermission for this company
    const permissions = await db.companyPermission.findMany({
      where: { companyId },
      include: {
        company: {
          select: { id: true, name: true },
        },
      },
    })

    // Collect unique agent IDs from permissions
    const agentIds = [
      ...new Set(
        permissions
          .map((p) => p.agentId)
          .filter((id): id is string => id !== null)
      ),
    ]

    // Also get allowed department IDs
    const allowedDepartments: string[] = company.allowedDepartments
      ? JSON.parse(company.allowedDepartments)
      : []

    // Fetch agents either explicitly allowed or in allowed departments
    let agents: Array<{ id: string; agentId: string; name: string; departmentId: string; departmentName: string; role: string; status: string; purpose: string }> = []

    if (agentIds.length > 0) {
      const explicitAgents = await db.agent.findMany({
        where: { id: { in: agentIds } },
        select: {
          id: true,
          agentId: true,
          name: true,
          departmentId: true,
          departmentName: true,
          role: true,
          status: true,
          purpose: true,
        },
      })
      agents.push(...explicitAgents)
    }

    if (allowedDepartments.length > 0) {
      const deptAgents = await db.agent.findMany({
        where: { departmentId: { in: allowedDepartments } },
        select: {
          id: true,
          agentId: true,
          name: true,
          departmentId: true,
          departmentName: true,
          role: true,
          status: true,
          purpose: true,
        },
      })
      // Avoid duplicates
      const existingIds = new Set(agents.map((a) => a.id))
      for (const a of deptAgents) {
        if (!existingIds.has(a.id)) {
          agents.push(a)
          existingIds.add(a.id)
        }
      }
    }

    // Build response with access level from permissions
    const agentMap = new Map(permissions.map((p) => [p.agentId, p.accessLevel]))

    const result = agents.map((agent) => ({
      ...agent,
      accessLevel: agentMap.get(agent.id) || 'read',
    }))

    return NextResponse.json({
      companyId: company.id,
      companyName: company.name,
      agents: result,
      total: result.length,
    })
  } catch (error) {
    console.error('[Company Allowed Agents] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch allowed agents' },
      { status: 500 }
    )
  }
}