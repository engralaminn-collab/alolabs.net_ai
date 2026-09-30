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

    const tasks = await db.task.findMany({
      where: { userId: companyId },
      include: {
        agent: {
          select: {
            id: true,
            agentId: true,
            name: true,
            role: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    // Also find tasks linked via command usage
    const usageTasks = await db.task.findMany({
      where: {
        commandId: companyId,
      },
      include: {
        agent: {
          select: {
            id: true,
            agentId: true,
            name: true,
            role: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    // Also find tasks from usage logs for this company
    const usageLogTaskIds = await db.usageLog.findMany({
      where: { companyId },
      select: { taskId: true },
      distinct: ['taskId'],
    })
    const taskIds = usageLogTaskIds
      .map((u) => u.taskId)
      .filter((id): id is string => id !== null)

    const companyTasks = taskIds.length > 0
      ? await db.task.findMany({
          where: { id: { in: taskIds } },
          include: {
            agent: {
              select: {
                id: true,
                agentId: true,
                name: true,
                role: true,
                status: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
        })
      : []

    // Merge and deduplicate by id
    const allTasks = new Map<string, (typeof tasks)[0]>()
    for (const t of [...tasks, ...usageTasks, ...companyTasks]) {
      if (!allTasks.has(t.id)) {
        allTasks.set(t.id, t)
      }
    }

    const sorted = Array.from(allTasks.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )

    return NextResponse.json({
      tasks: sorted,
      total: sorted.length,
    })
  } catch (error) {
    console.error('[Company Tasks] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch tasks' },
      { status: 500 }
    )
  }
}